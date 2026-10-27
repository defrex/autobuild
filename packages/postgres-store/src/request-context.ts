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
const hosted = new AsyncLocalStorage<Map<string, string>>()
export function withHostedProjectContext<T>(work: () => T): T {
  return hosted.getStore() ? work() : hosted.run(new Map(), work)
}
export function hostedProjectContext(): Map<string, string> | undefined {
  return hosted.getStore()
}
export function rememberProjectGeneration(repo: string, generation: string): void {
  const context = hosted.getStore()
  if (context && !context.has(repo)) context.set(repo, generation)
}
