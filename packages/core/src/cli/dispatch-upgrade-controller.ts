import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { RuntimeIdentity } from '../events/runtime'
import type { RepositoryEventWrite } from '../events/repository'
import { DISPATCHER } from '../events/envelope'
import {
  TARGET_CHECK_INTERVAL_MS,
  TargetResolutionError,
  type UpgradeTarget,
} from './dispatch-upgrade-target'
import type { CachedRuntime } from './dispatch-runtime-cache'
import { releasePreparedRuntime, reservePreparedRuntime } from './dispatch-runtime-use'
import { captureRuntimeIdentity } from '../runtime-identity'
import type { Handoff } from '../kernel/dispatch-upgrade'

export function publicTarget(target: UpgradeTarget) {
  const { mode, key, source, version, base, sha } = target
  return {
    mode,
    key,
    source,
    ...(version ? { version } : {}),
    ...(base ? { base } : {}),
    ...(sha ? { sha } : {}),
  }
}
/** Bun locks may abbreviate commits. Prefer the captured Bun tag over a
 * package's gitHead, which can describe an earlier npm publication. */
function matchesRunningForge(
  target: UpgradeTarget,
  from: RuntimeIdentity,
  bunTag?: string,
): boolean {
  const record = target.record?.[0]
  const locked =
    typeof record === 'string'
      ? /^@defrex\/autobuild@github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([a-f0-9]{7,40})$/i.exec(
          record,
        )
      : null
  if (!locked) return false
  const commit = locked[3]!.toLowerCase()
  if (bunTag !== undefined) {
    const prefix = `${locked[1]}-${locked[2]}-`
    if (!bunTag.startsWith(prefix)) return false
    const running = bunTag.slice(prefix.length).toLowerCase()
    return (
      /^[a-f0-9]{7,40}$/.test(running) && (running.startsWith(commit) || commit.startsWith(running))
    )
  }
  return (
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(from.commit) &&
    from.commit.toLowerCase().startsWith(commit)
  )
}

export interface UpgradeControllerInput {
  run: string
  lineage: string
  from: RuntimeIdentity
  failedKeys: string[]
  currentKey?: string
  storeChangedSinceFailure?(): Promise<boolean>
  runningBunTag?: string
  reservationOwner?: number
  enabled(): boolean
  resolve(signal: AbortSignal): Promise<UpgradeTarget>
  prepare(target: UpgradeTarget, signal: AbortSignal): Promise<CachedRuntime>
  append(event: RepositoryEventWrite): Promise<unknown>
  cutover(handoff: Handoff): Promise<boolean>
  redact?(message: string): string
  intervalMs?: number
}
/** One preparation at a time. Discovery continues after failure; installation does not. */
export class DispatchUpgradeController {
  private readonly abort = new AbortController()
  private timer?: ReturnType<typeof setTimeout>
  private pending?: Promise<void>
  private preparation?: AbortController
  private readonly failed: Set<string>
  constructor(private readonly input: UpgradeControllerInput) {
    this.failed = new Set(input.failedKeys)
  }
  start(): void {
    this.schedule(0)
  }
  changed(): void {
    if (!this.input.enabled()) this.preparation?.abort()
  }
  private schedule(ms: number): void {
    if (this.abort.signal.aborted) return
    this.timer = setTimeout(() => {
      const startedAt = Date.now()
      this.pending = this.check()
        .catch(() => {})
        .finally(() =>
          this.schedule(
            Math.max(
              0,
              (this.input.intervalMs ?? TARGET_CHECK_INTERVAL_MS) - (Date.now() - startedAt),
            ),
          ),
        )
    }, ms)
  }
  async stop(): Promise<void> {
    this.abort.abort()
    this.preparation?.abort()
    clearTimeout(this.timer)
    await this.pending
  }
  async check(): Promise<void> {
    if (this.abort.signal.aborted || this.preparation || !this.input.enabled()) return
    const preparation = new AbortController()
    this.preparation = preparation
    let target: UpgradeTarget | undefined
    let runtime: CachedRuntime | undefined
    const correlation = randomUUID()
    const identity = () => ({
      correlation,
      run: this.input.run,
      lineage: this.input.lineage,
      from: this.input.from,
      target: publicTarget(target!),
    })
    try {
      target = await this.input.resolve(
        AbortSignal.any([preparation.signal, AbortSignal.timeout(30_000)]),
      )
      if (preparation.signal.aborted || !this.input.enabled()) return
      if (this.failed.has(target.key)) {
        if (!(await this.input.storeChangedSinceFailure?.())) return
        this.failed.delete(target.key)
      }
      if (target.key === this.input.currentKey) return
      if (matchesRunningForge(target, this.input.from, this.input.runningBunTag)) return
      if (target.version === this.input.from.version) return
      await this.input.append({
        actor: DISPATCHER,
        type: 'dispatcher.upgrade-detected',
        payload: identity(),
      })
      runtime = await this.input.prepare(target, preparation.signal)
      if (preparation.signal.aborted || !this.input.enabled()) return
      const handoff: Handoff = {
        ...identity(),
        to: captureRuntimeIdentity(runtime.root),
        root: runtime.root,
        cacheId: runtime.id,
      }
      reservePreparedRuntime(
        dirname(dirname(runtime.root)),
        runtime.id,
        this.input.reservationOwner,
      )
      if (await this.input.cutover(handoff)) {
        // Retain the reservation through old-generation exit. The launcher transfers it under the cache lock.
        runtime = undefined
        this.abort.abort()
      }
    } catch (error) {
      if (preparation.signal.aborted || this.abort.signal.aborted) return
      if (error instanceof TargetResolutionError) target = error.target
      if (target && !this.failed.has(target.key)) {
        await this.input.append({
          actor: DISPATCHER,
          type: 'dispatcher.upgrade-failed',
          payload: {
            ...identity(),
            reason:
              this.input.redact?.(
                error instanceof Error ? error.message : 'target preparation failed',
              ) ?? 'target preparation failed',
          },
        })
        this.failed.add(target.key)
      }
    } finally {
      if (runtime) {
        releasePreparedRuntime(runtime.root, this.input.reservationOwner)
        releasePreparedRuntime(runtime.root)
      }
      if (this.preparation === preparation) this.preparation = undefined
    }
  }
}
