import type { UpgradeRun } from '../kernel/dispatch-upgrade'
import { readDispatchUpgrade } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'

/** Cadence of the between-tick yield observation. Each step is one canonical
 * reduced read of the repository upgrade value, which reads zero event rows
 * while nothing changed, so the cost per step does not grow with log length,
 * build count or project count. */
export const YIELD_OBSERVATION_INTERVAL_MS = 200

/** Hard step limit of one armed observation: about three minutes at the
 * cadence above, which covers preflight's 120 s readiness deadline plus the
 * launcher's successor spawn. The ordinary tick keeps checking afterwards. */
export const YIELD_OBSERVATION_LIMIT = 900

/** `requested`: durable state holds this run's matching request, or an
 * acceptance not yet adopted. `settled`: nothing more can arrive for this
 * preparation. `waiting`: the preparation is still outstanding. */
export type YieldObservation = 'waiting' | 'requested' | 'settled'

/** Classify one run's durable upgrade state for an armed preparation. The
 * result only decides when to attempt acceptance; the attempt re-reads and
 * validates durable state itself. */
export function classifyYieldObservation(
  run: UpgradeRun | undefined,
  correlation: string,
  lineage: string,
): YieldObservation {
  if (!run || run.prepared?.payload.correlation !== correlation || run.completed) return 'settled'
  if (run.handoff?.payload.correlation === correlation) return 'requested'
  if (run.failure) return 'settled'
  if (!run.request) return 'waiting'
  return run.request.payload.correlation === correlation && run.request.payload.lineage === lineage
    ? 'requested'
    : 'settled'
}

/** One observation step: exactly one reduced read of the upgrade value. */
export async function observeYield(
  store: Pick<BuildStore, 'getReducerValue'>,
  repo: string,
  run: string,
  correlation: string,
  lineage: string,
): Promise<YieldObservation> {
  const state = (await readDispatchUpgrade(store, repo)).value.runs[run]
  return classifyYieldObservation(state, correlation, lineage)
}

/** Watch durable state at a bounded cadence and attempt acceptance at most
 * once. A failed read counts as a step and is retried at the next one. A
 * failed acceptance is left to the ordinary tick, which retries and reports
 * it. `signal` must cover every source that interrupts `sleep`, so an
 * interrupted sleep never turns into a back-to-back read. */
export async function watchForYieldRequest(opts: {
  observe: () => Promise<YieldObservation>
  accept: () => Promise<void>
  sleep: (ms: number) => Promise<void>
  signal: AbortSignal
  intervalMs?: number
  limit?: number
}): Promise<'accepted' | 'settled' | 'exhausted' | 'stopped'> {
  const intervalMs = opts.intervalMs ?? YIELD_OBSERVATION_INTERVAL_MS
  const limit = opts.limit ?? YIELD_OBSERVATION_LIMIT
  for (let step = 0; step < limit; step++) {
    if (opts.signal.aborted) return 'stopped'
    await opts.sleep(intervalMs)
    if (opts.signal.aborted) return 'stopped'
    let observation: YieldObservation
    try {
      observation = await opts.observe()
    } catch {
      continue
    }
    if (observation === 'settled') return 'settled'
    if (observation === 'requested') {
      await opts.accept().catch(() => {})
      return 'accepted'
    }
  }
  return 'exhausted'
}
