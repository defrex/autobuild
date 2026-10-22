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

/** Receiver bindings and optional plugin capabilities survive the wrapper.
 * Only trusted kernel composition receives the repository Store authority. */
type GuardDeps = { store: BuildStore; repo: string; name: string; now?: () => Date; wait?: boolean }
const guarded = new WeakMap<Forge, { raw: Forge; deps: GuardDeps }>()

export function guardForge(
  forge: Forge,
  deps: {
    store: BuildStore
    repo: string
    name: string
    now?: () => Date
    wait?: boolean
  },
): Forge {
  const previous = guarded.get(forge)
  if (previous) {
    if (
      previous.deps.store === deps.store &&
      previous.deps.repo === deps.repo &&
      previous.deps.name === deps.name &&
      previous.deps.wait === deps.wait &&
      previous.deps.now === deps.now
    )
      return forge
    return guardForge(previous.raw, deps)
  }
  if (deps.name === 'local-git') return forge
  const now = deps.now ?? (() => new Date())
  const health = () => readForgeHealth(deps.store, deps.repo)
  const before = async () => {
    let active = await health()
    while (active && (deps.wait || Date.parse(active.resetAt) > now().getTime())) {
      if (!deps.wait) throw new ForgeCooldown(`Forge cooldown until ${active.resetAt}`)
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(1000, Math.min(30_000, Date.parse(active!.resetAt) - now().getTime())),
        ),
      )
      active = await health()
    }
  }
  const failed = async (error: unknown) => {
    if (!isForgeFailure(error) || error.details.kind !== 'rate-limited') return
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
