import type { Forge } from '../ports/types'
import { isForgeFailure, type ForgeFailure, type ForgeFailureDetails } from '../ports/forge-failure'
import {
  withForgeRequestGate,
  forgeRequestGateActive,
  ForgeRequestDeferred,
  type ForgeExhaustionEvidence,
} from '../ports/forge-request-context'
import type { BuildStore } from '../store/types'
import { readForgeHealth } from '../store/reduced-reads'
import { KERNEL } from '../events/envelope'

type RateLimited = Extract<ForgeFailureDetails, { kind: 'rate-limited' }>

/** Scheduling signal, never a failed attempt. */
export class ForgeCooldown extends ForgeRequestDeferred {}

/** Whose rate limits a guard may record. `'repository'` is the dispatcher's
 * own forge: its classified limits pause forge work repository-wide. A
 * process scope (build runner, phase session) only obeys that cooldown; its
 * own limits, like any unauthenticated limit, stay local to the guard and are
 * reported as attention, because they say nothing about the dispatcher's
 * credential. */
export type ForgeGuardScope = 'repository' | { process: string }

/** Receiver bindings and optional plugin capabilities survive the wrapper.
 * Only trusted kernel composition receives the repository Store authority. */
type GuardDeps = {
  store: BuildStore
  repo: string
  name: string
  now?: () => Date
  wait?: boolean
  scope?: ForgeGuardScope
  /** Test seam for cooldown waits. */
  sleep?: (ms: number) => Promise<void>
}
const guarded = new WeakMap<Forge, { raw: Forge; deps: GuardDeps }>()

/** Per raw forge and `repo\0name\0quota`: the highest adapter evidence `seq`
 * this process has durably recorded as repository degradation (or found
 * already covered by it). Survives re-wraps; never shared across processes,
 * exactly like the adapter's own memory of the evidence. */
const recordedEvidence = new WeakMap<Forge, Map<string, number>>()
/** The evidence a deferred, synthesized limit carries to `recordLimit`. */
const pendingEvidence = new WeakMap<object, ForgeExhaustionEvidence>()

function scopeKey(scope: ForgeGuardScope | undefined): string {
  return scope === undefined || scope === 'repository' ? 'repository' : `process:${scope.process}`
}

export function guardForge(forge: Forge, deps: GuardDeps): Forge {
  const previous = guarded.get(forge)
  if (previous) {
    if (
      previous.deps.store === deps.store &&
      previous.deps.repo === deps.repo &&
      previous.deps.name === deps.name &&
      previous.deps.wait === deps.wait &&
      previous.deps.now === deps.now &&
      previous.deps.sleep === deps.sleep &&
      scopeKey(previous.deps.scope) === scopeKey(deps.scope)
    )
      return forge
    return guardForge(previous.raw, deps)
  }
  if (deps.name === 'local-git') return forge
  const now = deps.now ?? (() => new Date())
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const scope = deps.scope ?? 'repository'
  const health = () => readForgeHealth(deps.store, deps.repo)
  const pause = (resetAt: string) =>
    sleep(Math.max(1000, Math.min(30_000, Date.parse(resetAt) - now().getTime())))
  /** This guard's own cooldown from a limit that is not repository-wide, and
   * the latest reset it has already reported (one fact per episode). */
  let local: { resetAt: string } | undefined
  let reported: string | undefined
  const evidenceKey = (quota: string) => `${deps.repo}\0${deps.name}\0${quota}`
  const recordedSeq = (quota: string): number =>
    recordedEvidence.get(forge)?.get(evidenceKey(quota)) ?? 0
  const markRecorded = (evidence: ForgeExhaustionEvidence | undefined): void => {
    if (evidence === undefined || evidence.seq <= recordedSeq(evidence.quota)) return
    let marks = recordedEvidence.get(forge)
    if (marks === undefined) {
      marks = new Map()
      recordedEvidence.set(forge, marks)
    }
    marks.set(evidenceKey(evidence.quota), evidence.seq)
  }
  /** Admits a request and returns the degradation it last read, if any. */
  const before = async () => {
    while (local) {
      if (Date.parse(local.resetAt) <= now().getTime()) {
        local = undefined
        break
      }
      if (!deps.wait) throw new ForgeCooldown(`Forge cooldown until ${local.resetAt}`)
      await pause(local.resetAt)
    }
    let active = await health()
    while (active && (deps.wait || Date.parse(active.resetAt) > now().getTime())) {
      if (!deps.wait) throw new ForgeCooldown(`Forge cooldown until ${active.resetAt}`)
      await pause(active.resetAt)
      active = await health()
    }
    return active
  }
  /** Serializes this guard's post-failure bookkeeping (never the request), so
   * concurrent limited requests cannot both see "no active episode". */
  let chain: Promise<void> = Promise.resolve()
  const serial = (work: () => Promise<void>): Promise<void> => {
    const next = chain.then(work, work)
    chain = next.catch(() => {})
    return next
  }
  const failed = (error: unknown): Promise<void> => {
    if (!isForgeFailure(error) || error.details.kind !== 'rate-limited') return Promise.resolve()
    return serial(() => recordLimit(error, error.details as RateLimited))
  }
  const recordLimit = async (error: Error, details: RateLimited): Promise<void> => {
    if (scope !== 'repository' || details.unauthenticated) {
      // At least one second, so a stale reset cannot spin a waiting retry.
      const until = Math.max(
        Date.parse(details.resetAt),
        local ? Date.parse(local.resetAt) : 0,
        now().getTime() + 1000,
      )
      local = { resetAt: new Date(until).toISOString() }
      if (reported !== undefined && Date.parse(reported) >= Date.parse(details.resetAt)) return
      reported = details.resetAt
      try {
        await deps.store.appendRepo(deps.repo, {
          actor: KERNEL,
          type: 'forge.credential-limited',
          payload: {
            forge: deps.name,
            process: scope === 'repository' ? 'dispatcher' : scope.process,
            credential: details.unauthenticated ? 'unauthenticated' : 'process',
            ...(details.unauthenticated
              ? { missingCredential: details.unauthenticated.slice(0, 1000) }
              : {}),
            message: error.message.slice(0, 2000),
            resetAt: details.resetAt,
          },
        })
      } catch {
        // Attention only: an older server or a missing repository must not
        // turn the limited request into a different failure.
      }
      return
    }
    const active = await health()
    // One episode per cooldown: a limit inside an unexpired degradation only
    // extends it, durably but marked `continued`, so it never wakes a watch.
    const ongoing = active !== undefined && Date.parse(active.resetAt) > now().getTime()
    const evidence = pendingEvidence.get(error)
    if (ongoing && Date.parse(details.resetAt) <= Date.parse(active.resetAt)) {
      markRecorded(evidence)
      return
    }
    // Runner/phase credentials cannot administer repositories; their repo
    // already exists. Only the dispatcher may create it.
    if (!deps.wait) await deps.store.ensureRepo(deps.repo)
    await deps.store.appendRepo(deps.repo, {
      actor: KERNEL,
      type: 'dispatcher.forge-degraded',
      payload: {
        forge: deps.name,
        message: error.message,
        resetAt: details.resetAt,
        firstFailureAt: ongoing ? active.firstFailureAt : now().toISOString(),
        ...(ongoing ? { continued: true as const } : {}),
      },
    })
    // Only once durable: a failed append authorizes no later override.
    markRecorded(evidence)
  }
  function wrap(target: object): object {
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
          const value = Reflect.get(target, key, target)
          if (
            value &&
            typeof value === 'object' &&
            ['rewrite', 'kernelRewrite', 'prAttachments'].includes(String(key))
          )
            return wrap(value)
          if (typeof value !== 'function') return value
          if (key === 'observeRequests' || key === 'withReadScope') return value.bind(target)
          return async function invoke(...args: unknown[]): Promise<unknown> {
            await before()
            let requested = false
            let requestFailed = false
            let admittedHealth: Awaited<ReturnType<typeof before>>
            const gate = {
              before: async () => {
                admittedHealth = await before()
                requested = true
              },
              /** Remembered adapter exhaustion goes out as a probe only after an
               * explicit clear of this exact evidence: the repository recorded
               * it (`seq` covered by the durable mark) and this request was
               * admitted with no unexpired degradation, which before the
               * evidence's reset only a clear explains. Reuses this request's
               * `before()` read; reads nothing. */
              exhausted: async (
                failure: ForgeFailure,
                evidence: ForgeExhaustionEvidence,
              ): Promise<'defer' | 'probe'> => {
                if (
                  scope === 'repository' &&
                  failure.details.kind === 'rate-limited' &&
                  !failure.details.unauthenticated &&
                  evidence.seq <= recordedSeq(evidence.quota) &&
                  (admittedHealth === undefined ||
                    Date.parse(admittedHealth.resetAt) <= now().getTime())
                )
                  return 'probe'
                pendingEvidence.set(failure, evidence)
                return 'defer'
              },
              failed: async (error: unknown) => {
                requestFailed ||= isForgeFailure(error)
                await failed(error)
              },
            }
            const stop = forge.observeRequests?.(() => {
              if (forgeRequestGateActive(gate)) requested = true
            })
            try {
              const result = await withForgeRequestGate(gate, () => value.apply(target, args))
              // Git-only plumbing cannot prove API recovery. Legacy plugins have
              // no wire observer: their successful provider operation is the probe.
              if (
                !requestFailed &&
                (requested || !forge.observeRequests) &&
                ![
                  'pushBranch',
                  'kernelExec',
                  'snapshotBase',
                  'compareLocalBranches',
                  'fastForward',
                  'publish',
                  'snapshot',
                  'archive',
                ].includes(String(key))
              ) {
                const active = await health()
                if (active && !deps.wait && Date.parse(active.resetAt) <= now().getTime())
                  await deps.store.appendRepo(deps.repo, {
                    actor: KERNEL,
                    type: 'dispatcher.forge-recovered',
                    payload: { forge: deps.name },
                  })
              }
              return result
            } catch (error) {
              await failed(error)
              if (deps.wait && isForgeFailure(error) && error.details.kind === 'rate-limited')
                return invoke(...args)
              throw error
            } finally {
              stop?.()
            }
          }
        },
      },
    )
  }
  const result = wrap(forge) as Forge
  guarded.set(result, { raw: forge, deps })
  return result
}
