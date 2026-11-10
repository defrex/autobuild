import type { Forge } from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'

/** Thrown in place of an effect that a dispatcher attempted without current
 * repository authority: its repository lease lapsed and has not been
 * reclaimed, or a peer replaced it. The effect was never started. Catch sites
 * treat it as "stop this unit quietly", never as a recorded failure. */
export class RepositoryAuthorityLapsed extends Error {
  constructor(message = 'repository dispatch lease lapsed; effect not started') {
    super(message)
    this.name = 'RepositoryAuthorityLapsed'
  }
}

export function isRepositoryAuthorityLapse(error: unknown): error is RepositoryAuthorityLapsed {
  return error instanceof RepositoryAuthorityLapsed
}

/** First statement of a catch that would otherwise record a failure fact: a
 * lapse is not a failure of the unit, so it escapes unrecorded. */
export function rethrowAuthorityLapse(error: unknown): void {
  if (isRepositoryAuthorityLapse(error)) throw error
}

/** The repository-lease subset of the BuildStore the resolver needs. */
export interface RepoLeaseStore {
  getRepo(repo: string): Promise<{ lease?: { holder: string } | null } | null>
  claimRepoLease(repo: string, holder: string, ttlMs: number): Promise<boolean>
}

/** `held`: the lease names this run again with a fresh expiry. `superseded`:
 * another run holds or held it since. `unknown`: the store could not answer;
 * do no work and ask again later. */
export type LapsedLeaseResolution = 'held' | 'superseded' | 'unknown'

/** Decide whether a holder whose own lease looks lapsed was replaced, and
 * reclaim it when it was not. "My lease expired" alone never means "a peer
 * replaced me": expiry leaves the record naming the old holder in every
 * adapter, and only the holder's own release clears it. So:
 *
 * - a record naming this holder, expired or not, is claimed again. The claim
 *   is atomic in every adapter, so of two runs racing after expiry exactly one
 *   wins; a refused claim means the other one did.
 * - a record naming another holder, expired or not, means a peer took over.
 * - no record means a peer claimed and then released it (run ids are unique).
 *
 * A peer could claim and release between the read and the claim. That window
 * is milliseconds wide and is accepted: the claim would then succeed against
 * an absent record, which is the same outcome as a standby takeover. */
export async function resolveLapsedRepoLease(
  store: RepoLeaseStore,
  repo: string,
  holder: string,
  ttlMs: number,
): Promise<LapsedLeaseResolution> {
  try {
    const record = await store.getRepo(repo)
    if (record?.lease?.holder !== holder) return 'superseded'
    return (await store.claimRepoLease(repo, holder, ttlMs)) ? 'held' : 'superseded'
  } catch {
    return 'unknown'
  }
}

type Guard = () => void

/** Shallow method fences: each listed member is guarded when it is called,
 * after every `await` that preceded the call. Nested objects are fenced by
 * their own method lists. */
export interface EffectFence {
  readonly methods: readonly string[]
  readonly nested?: Readonly<Record<string, EffectFence>>
}

/** A view of `port` whose listed methods call `guard()` before delegating.
 * The guard throws to refuse; a refused call returns a rejected promise and
 * never reaches the port. Unlisted members, reads, and data properties pass
 * through. Methods are applied to the real target, so class `this` and
 * private fields keep working, and the view reports the target's prototype.
 *
 * The proxy wraps an empty facade rather than the port itself. A proxy over
 * the port would have to return a frozen (non-configurable, non-writable)
 * member unchanged, so `Object.freeze` on a plugin would let its effects and
 * nested capabilities escape the fence. The facade has no such invariant.
 *
 * An effect that had already been called before a stall still completes:
 * cancelling it could tear external state. Only effects called afterwards
 * are fenced. */
export function fenceEffects<T extends object>(port: T, fence: EffectFence, guard: Guard): T {
  const methods = new Set(fence.methods)
  const nested = new Map<PropertyKey, { raw: object; wrapped: object }>()
  const bound = new WeakMap<object, unknown>()
  return new Proxy(Object.create(null) as T, {
    getPrototypeOf: () => Reflect.getPrototypeOf(port),
    has: (_facade, key) => Reflect.has(port, key),
    ownKeys: () => Reflect.ownKeys(port),
    getOwnPropertyDescriptor: (_facade, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(port, key)
      return descriptor ? { ...descriptor, configurable: true } : undefined
    },
    set: (_facade, key, value) => Reflect.set(port, key, value, port),
    defineProperty: (_facade, key, descriptor) => Reflect.defineProperty(port, key, descriptor),
    deleteProperty: (_facade, key) => Reflect.deleteProperty(port, key),
    get(_facade, key) {
      const value: unknown = Reflect.get(port, key, port)
      const inner = typeof key === 'string' ? fence.nested?.[key] : undefined
      if (inner && value && typeof value === 'object') {
        const cached = nested.get(key)
        if (cached?.raw === value) return cached.wrapped
        const wrapped = fenceEffects(value, inner, guard)
        nested.set(key, { raw: value, wrapped })
        return wrapped
      }
      if (typeof value !== 'function') return value
      const fn = value as (...args: unknown[]) => unknown
      if (typeof key === 'string' && methods.has(key))
        return (...args: unknown[]) => {
          try {
            guard()
          } catch (error) {
            return Promise.reject(error)
          }
          return fn.apply(port, args)
        }
      let cached = bound.get(fn)
      if (!cached) {
        cached = fn.bind(port)
        bound.set(fn, cached)
      }
      return cached
    },
  })
}

/** Forge members that only observe. Every other function member of a fenced
 * forge, at any depth, is an effect and is refused without authority. Each
 * entry is a read per its contract in `ports/types.ts`. */
export const FORGE_READ_ALLOWLIST: readonly string[] = [
  'withReadScope',
  'primeNodeReads',
  'observeRequests',
  'inspectReadiness',
  'inspectMergeFreshness',
  'inspectLandingGate',
  'inspectLandingPr',
  'compareBranches',
  'confirmPublication',
  'snapshotBase',
  'getPrState',
  'readCommitMessage',
  'containsBuild',
  'remoteBranchSha',
  'remoteBranchExists',
  'isCommitAncestor',
  'readFile',
]

const FORGE_CAPABILITIES = ['rewrite', 'kernelRewrite', 'prAttachments']

/** A `git push` anywhere in a command line is a publication. */
function isGitPush(cmd: readonly string[]): boolean {
  return cmd[0] === 'git' && cmd.includes('push')
}

/** Exec that refuses `git push` without authority; every other command runs. */
export function fenceExec(exec: Exec, guard: Guard): Exec {
  return (cmd, opts) => {
    if (isGitPush(cmd)) {
      try {
        guard()
      } catch (error) {
        return Promise.reject(error)
      }
    }
    return exec(cmd, opts)
  }
}

/** Deny-by-default forge fence. Every function member, including every method
 * of the nested `rewrite`, `kernelRewrite` and `prAttachments` capabilities and
 * any plugin-added method, is an effect unless it is on the read allowlist.
 * `kernelExec` is fenced for `git push` only. Non-function properties pass
 * through. Compose it underneath `guardForge`, so the guard's identity memo
 * still recognises the outer object. */
export function fenceForge(forge: Forge, guard: Guard): Forge {
  return fenceForgeObject(forge, guard, new Set(FORGE_READ_ALLOWLIST)) as Forge
}

function fenceForgeObject(target: object, guard: Guard, reads: ReadonlySet<string>): object {
  const nested = new Map<PropertyKey, { raw: object; wrapped: object }>()
  return new Proxy(
    {},
    {
      has: (_facade, key) => key in target,
      ownKeys: () => Reflect.ownKeys(target),
      getOwnPropertyDescriptor: (_facade, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
        return descriptor ? { ...descriptor, configurable: true } : undefined
      },
      get(_facade, key) {
        const value: unknown = Reflect.get(target, key, target)
        const name = String(key)
        if (value && typeof value === 'object' && FORGE_CAPABILITIES.includes(name)) {
          const cached = nested.get(key)
          if (cached?.raw === value) return cached.wrapped
          const wrapped = fenceForgeObject(value, guard, new Set())
          nested.set(key, { raw: value, wrapped })
          return wrapped
        }
        if (typeof value !== 'function') return value
        const fn = value as (...args: unknown[]) => unknown
        if (name === 'kernelExec') return fenceExec(fn.bind(target) as Exec, guard)
        if (reads.has(name)) return fn.bind(target)
        return (...args: unknown[]) => {
          try {
            guard()
          } catch (error) {
            return Promise.reject(error)
          }
          return fn.apply(target, args)
        }
      },
    },
  )
}
