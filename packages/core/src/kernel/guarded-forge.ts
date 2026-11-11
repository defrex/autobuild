import type { Forge } from '../ports/types'
import { isForgeFailure } from '../ports/forge-failure'
import {
  withForgeRequestGate,
  forgeRequestGateActive,
  ForgeRequestDeferred,
} from '../ports/forge-request-context'
import type { BuildStore } from '../store/types'
import { readForgeHealth } from '../store/reduced-reads'
import { KERNEL } from '../events/envelope'

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
  }
  const failed = async (error: unknown) => {
    if (!isForgeFailure(error) || error.details.kind !== 'rate-limited') return
    const details = error.details
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
    if (active?.resetAt === error.details.resetAt && active.message === error.message) return
    // Runner/phase credentials cannot administer repositories; their repo
    // already exists. Only the dispatcher may create it.
    if (!deps.wait) await deps.store.ensureRepo(deps.repo)
    await deps.store.appendRepo(deps.repo, {
      actor: KERNEL,
      type: 'dispatcher.forge-degraded',
      payload: {
        forge: deps.name,
        message: error.message,
        resetAt:
          active && Date.parse(active.resetAt) > Date.parse(error.details.resetAt)
            ? active.resetAt
            : error.details.resetAt,
        firstFailureAt: active?.firstFailureAt ?? now().toISOString(),
      },
    })
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
            const gate = {
              before: async () => {
                await before()
                requested = true
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
