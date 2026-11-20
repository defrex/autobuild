import type { BuildState } from '../../kernel/reducer'
import { reopenRoute, reopenUnsettled } from '../../kernel/reopen'

/** A reopened leaf re-running its pipeline (SPEC §15.7): the shared status
 * vocabulary for `ab build status`, `ab builds` and both dashboards. */
export interface ReopenedSummary {
  user: string
  at: string
  route: 'implement' | 'plan'
  feedback?: string
  specRev?: number
}

const FEEDBACK_PREVIEW = 120

/** The reopen while the leaf has not settled again since it, else undefined. */
export function reopenedSummary(state: BuildState): ReopenedSummary | undefined {
  const reopen = state.reopen
  if (reopen === undefined || !reopenUnsettled(state)) return undefined
  return {
    user: reopen.user,
    at: reopen.ts,
    route: reopenRoute(reopen),
    ...(reopen.feedback !== undefined ? { feedback: reopen.feedback } : {}),
    ...(reopen.spec !== undefined ? { specRev: reopen.spec.artifact.rev } : {}),
  }
}

/** One line: who reopened, where it went, and the feedback's first line,
 * truncated. Callers sanitize it for their medium. */
export function reopenedText(reopened: ReopenedSummary): string {
  const spec = reopened.specRev !== undefined ? ` with spec rev ${reopened.specRev}` : ''
  const first = reopened.feedback?.trim().split('\n')[0]?.trim()
  const preview =
    first === undefined || first === ''
      ? ''
      : `: ${first.length > FEEDBACK_PREVIEW ? `${first.slice(0, FEEDBACK_PREVIEW - 1)}…` : first}`
  return `reopened by ${reopened.user} → ${reopened.route}${spec}${preview}`
}
