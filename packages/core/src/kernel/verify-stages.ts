import { verifyStages, type VerifyConfig } from '../config/schema'
import type { LogIndex, VerifyRecord } from './log-index'
import type { VerifyStageState } from './verify-stage-state'

/** Pure barrier selection shared by leaf and integration verification. */
export function activeVerifyStage(
  config: VerifyConfig,
  results: readonly VerifyRecord[],
  state: VerifyStageState,
  cycle: number,
) {
  const stages = verifyStages(config)
  for (const stage of stages) {
    const outcomes = stage.map((step) =>
      results.find((result) => result.seq > cycle && result.step === step),
    )
    if (outcomes.every((result) => result?.outcome === 'pass' || result?.outcome === 'skipped'))
      continue
    const cancellations = Object.values(state.cancellations).filter(
      (item) => item.seq > cycle && stage.includes(item.step),
    )
    const unfinished = stage.filter(
      (step, index) => !outcomes[index] && !cancellations.some((item) => item.step === step),
    )
    const failures = outcomes.filter((result): result is VerifyRecord => result?.outcome === 'fail')
    const cause = [...failures]
      .filter((result) => config.stepConfigs[result.step]?.failFast === true)
      .sort((a, b) => a.seq - b.seq)[0]
    return {
      stage: [...stage],
      failures,
      cancellations,
      unfinished,
      cause,
      settled: unfinished.length === 0,
    }
  }
  return undefined
}

/** A leaf's verify cycle boundary inputs (§15.6-A): the latest code-review
 * approval, reconcile completion, configuration boundary, or clean
 * wait-resume restack after a verify:* or finalize wait (SPEC §11 "Ticket
 * waits"). Results at or before it describe an older change or base. The
 * engine's stage selection and its `cycleBoundary` both read it; a node's
 * wait-resume input is always 0, since nodes declare no waits. */
export function leafVerifyCycleInputs(
  log: Pick<
    LogIndex,
    'code' | 'lastReconcileCompletedSeq' | 'verifyConfigBoundary' | 'waitResumeVerifyBoundary'
  >,
): number {
  return Math.max(
    log.code.latestApproveSeq,
    log.lastReconcileCompletedSeq,
    log.verifyConfigBoundary,
    log.waitResumeVerifyBoundary,
  )
}
