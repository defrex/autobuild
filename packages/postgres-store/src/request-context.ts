import type { SQL } from 'bun'
import type { ProjectAdmission } from './project-lifecycle'
import { AsyncLocalStorage } from 'node:async_hooks'

interface ReadContext {
  records: WeakMap<object, Map<string, Promise<unknown>>>
  existence: WeakMap<object, Map<string, boolean>>
}
const reads = new AsyncLocalStorage<ReadContext>()

/** One HTTP invocation; nested server composition shares only repository reads. */
export function withRepositoryReads<T>(work: () => T): T {
  return reads.getStore()
    ? work()
    : reads.run({ records: new WeakMap(), existence: new WeakMap() }, work)
}

export function hasRepositoryReadContext(): boolean {
  return reads.getStore() !== undefined
}

export function repositoryRead<T>(store: object, repo: string, read: () => Promise<T>): Promise<T> {
  const context = reads.getStore()
  if (!context) return read()
  let entries = context.records.get(store)
  if (!entries) {
    entries = new Map()
    context.records.set(store, entries)
  }
  let result = entries.get(repo)
  if (!result) {
    result = read()
    entries.set(repo, result)
  }
  return result as Promise<T>
}

/** Existence only: a positive event tail proves its foreign-key parent exists.
 * Never use this evidence instead of a mutation lock or an authorization check. */
export function knownRepositoryExists(store: object, repo: string): boolean | undefined {
  return reads.getStore()?.existence.get(store)?.get(repo)
}

export function recordRepositoryExistence(store: object, repo: string, exists: boolean): void {
  const context = reads.getStore()
  if (!context) return
  let entries = context.existence.get(store)
  if (!entries) {
    entries = new Map()
    context.existence.set(store, entries)
  }
  entries.set(repo, exists)
}

/** Hosted composition opts in; a standalone PostgreSQL adapter has no registry
 * requirement. A first admission is immutable for the lifetime of a request. */
interface HostedContext {
  active: boolean
  generations: Map<string, string>
  admissions: Map<string, Promise<ProjectAdmission | null>>
}
const hosted = new AsyncLocalStorage<HostedContext>()
export function withHostedProjectContext<T>(work: () => T): T {
  if (hosted.getStore()?.active) return work()
  const context: HostedContext = { active: true, generations: new Map(), admissions: new Map() }
  return hosted.run(context, () => {
    const close = () => {
      context.active = false
      context.admissions.clear()
    }
    try {
      const result = work()
      if (result && typeof (result as { then?: unknown }).then === 'function')
        return Promise.resolve(result).finally(close) as T
      close()
      return result
    } catch (error) {
      close()
      throw error
    }
  })
}
// Aborted held reads can finish after the HTTP response settles. Retain their
// generation identity to fence any finishing mutation, but never reuse admission.
function currentHostedContext(): HostedContext | undefined {
  return hosted.getStore()
}
export function hostedProjectContext(): Map<string, string> | undefined {
  return currentHostedContext()?.generations
}
export function rememberProjectGeneration(repo: string, generation: string): void {
  const context = hostedProjectContext()
  if (context && !context.has(repo)) context.set(repo, generation)
}

/** Single-flight full admission, independent of manually seeded generations. */
export function projectAdmission(
  repo: string,
  read: () => Promise<ProjectAdmission | null>,
): Promise<ProjectAdmission | null> {
  const context = currentHostedContext()
  if (!context?.active) return read()
  let result = context.admissions.get(repo)
  if (!result) {
    result = Promise.resolve().then(read)
    context.admissions.set(repo, result)
  }
  return result
}

/** Bun may dispatch a new pooled transaction callback from the pool's async
 * resource. Bind the invocation explicitly, including repository-read scope. */
export function projectTransaction<T>(sql: SQL, work: (tx: SQL) => Promise<T>): Promise<T> {
  const bound = AsyncLocalStorage.bind(work)
  return sql.begin((tx) => bound(tx as SQL)) as Promise<T>
}
