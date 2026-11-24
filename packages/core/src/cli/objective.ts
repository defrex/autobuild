/** `ab objective`: flag parsing and rendering. The store work is in
 * `operator/optimization.ts`, shared with the `optimization.revise` tool. */
import { formatObjective, type ObjectiveChanges } from '../objective'
import type { ObjectiveView } from '../operator/optimization'
import { stringFlag, type ParsedArgs } from './args'
import { objectiveNumber, pendingCleanupText, unmeasuredMergeText } from './dashboard/objective-row'

export const OBJECTIVE_USAGE =
  'usage: ab objective <node> [--threshold n] [--epsilon n|n%] [--max-attempts n] [--max-hours n] [--plateau n] [--stop-mode abort|drain] [--concurrency n] [--stop [--drain|--abort]] [--settle-unmeasured <proposal|build> --policy release-unmeasured [--note <text>]] [--json] [--store <ref>]'

export const OBJECTIVE_FLAGS = {
  threshold: 'value',
  epsilon: 'value',
  'max-attempts': 'value',
  'max-hours': 'value',
  plateau: 'value',
  'stop-mode': 'value',
  concurrency: 'value',
  stop: 'boolean',
  drain: 'boolean',
  abort: 'boolean',
  'settle-unmeasured': 'value',
  policy: 'value',
  note: 'value',
  json: 'boolean',
  store: 'value',
} as const

function number(flag: string, raw: string): number {
  const value = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(value))
    throw new Error(`--${flag} must be a number — ${OBJECTIVE_USAGE}`)
  return value
}

/** The revision the flags request; empty when none was given. Field rules
 * are validated by the service, which names the failing field. */
export function objectiveChangesFromFlags(parsed: ParsedArgs): Partial<ObjectiveChanges> {
  const changes: Partial<ObjectiveChanges> = {}
  const threshold = stringFlag(parsed, 'threshold')
  if (threshold !== undefined) changes.threshold = number('threshold', threshold)
  const epsilon = stringFlag(parsed, 'epsilon')
  if (epsilon !== undefined)
    changes.epsilon = epsilon.trim().endsWith('%')
      ? { relative: number('epsilon', epsilon.trim().slice(0, -1)) / 100 }
      : { absolute: number('epsilon', epsilon) }
  const maxAttempts = stringFlag(parsed, 'max-attempts')
  if (maxAttempts !== undefined) changes.maxAttempts = number('max-attempts', maxAttempts)
  const maxHours = stringFlag(parsed, 'max-hours')
  if (maxHours !== undefined) changes.maxHours = number('max-hours', maxHours)
  const plateau = stringFlag(parsed, 'plateau')
  if (plateau !== undefined) changes.plateau = number('plateau', plateau)
  const stopMode = stringFlag(parsed, 'stop-mode')
  if (stopMode !== undefined) {
    if (stopMode !== 'abort' && stopMode !== 'drain')
      throw new Error(`--stop-mode must be abort or drain — ${OBJECTIVE_USAGE}`)
    changes.stopMode = stopMode
  }
  const concurrency = stringFlag(parsed, 'concurrency')
  if (concurrency !== undefined) changes.concurrency = number('concurrency', concurrency)
  return changes
}

/** The stop the flags request; undefined without `--stop`. `--drain` or
 * `--abort` overrides the objective's stop mode. A stop is one fact, so it
 * never combines with a revision. */
export function objectiveStopFromFlags(
  parsed: ParsedArgs,
): { mode?: 'abort' | 'drain' } | undefined {
  const stop = parsed.flags.get('stop') === true
  const drain = parsed.flags.get('drain') === true
  const abort = parsed.flags.get('abort') === true
  if (!stop) {
    if (drain || abort)
      throw new Error(`--${drain ? 'drain' : 'abort'} requires --stop — ${OBJECTIVE_USAGE}`)
    return undefined
  }
  if (drain && abort) throw new Error(`--drain and --abort are exclusive — ${OBJECTIVE_USAGE}`)
  if (Object.keys(objectiveChangesFromFlags(parsed)).length > 0)
    throw new Error(`--stop cannot be combined with a revision — ${OBJECTIVE_USAGE}`)
  return drain ? { mode: 'drain' } : abort ? { mode: 'abort' } : {}
}

/** The unmeasured-merge settlement the flags request; undefined without
 * `--settle-unmeasured`. `--policy` is required and names the settlement
 * policy, which the service validates. It is one fact, so it never combines
 * with a stop or a revision. */
export function objectiveSettleFromFlags(
  parsed: ParsedArgs,
): { attempt: string; policy: string; note?: string } | undefined {
  const attempt = stringFlag(parsed, 'settle-unmeasured')
  const policy = stringFlag(parsed, 'policy')
  const note = stringFlag(parsed, 'note')
  if (attempt === undefined) {
    if (policy !== undefined || note !== undefined)
      throw new Error(
        `--${policy !== undefined ? 'policy' : 'note'} requires --settle-unmeasured — ${OBJECTIVE_USAGE}`,
      )
    return undefined
  }
  if (attempt.trim() === '')
    throw new Error(`--settle-unmeasured needs an attempt proposal or build — ${OBJECTIVE_USAGE}`)
  if (policy === undefined)
    throw new Error(
      `--settle-unmeasured requires an explicit --policy (release-unmeasured) — ${OBJECTIVE_USAGE}`,
    )
  if (
    parsed.flags.get('stop') === true ||
    parsed.flags.get('drain') === true ||
    parsed.flags.get('abort') === true
  )
    throw new Error(`--settle-unmeasured cannot be combined with --stop — ${OBJECTIVE_USAGE}`)
  if (Object.keys(objectiveChangesFromFlags(parsed)).length > 0)
    throw new Error(`--settle-unmeasured cannot be combined with a revision — ${OBJECTIVE_USAGE}`)
  return { attempt: attempt.trim(), policy, ...(note !== undefined ? { note } : {}) }
}

const value = (n: number | undefined) => (n === undefined ? 'not measured' : objectiveNumber(n))

export function renderObjective(view: ObjectiveView): string[] {
  const { progress } = view
  const eligible = (['threshold', 'plateau', 'budget'] as const).filter(
    (cause) => progress.eligibility[cause],
  )
  const budgetCause = progress.eligibility.budgetCause
  return [
    `optimization node ${view.slug} — objective revision ${view.revision}`,
    ...formatObjective(view.objective, new Set(view.revisedFields)).map((line) => `  ${line}`),
    'progress:',
    `  starting: ${value(progress.starting)}${progress.spread === undefined ? '' : ` (noise spread ${value(progress.spread)})`}`,
    `  current: ${value(progress.current)}`,
    `  best: ${value(progress.best)}`,
    `  attempts: ${progress.attempts.filed} filed, ${progress.attempts.accepted} accepted, ${progress.attempts.rejected} rejected, ${progress.attempts.running} running${progress.attempts.unmeasured > 0 ? `, ${progress.attempts.unmeasured} merged unmeasured` : ''}`,
    ...progress.unmeasuredMerges.map((merge) => `  ${unmeasuredMergeText(merge)}`),
    ...progress.pendingCleanups.map((cleanup) => `  ${pendingCleanupText(cleanup)}`),
    `  plateau: ${progress.plateau}`,
    `  active: ${progress.elapsedHours.toFixed(1)} hours${progress.settling ? ' (settling: attempt runs before the stop are still being accounted)' : ''}`,
    `  stop eligible: ${
      eligible.length === 0
        ? 'none'
        : eligible
            .map((cause) =>
              cause === 'budget' && budgetCause !== undefined ? `budget (${budgetCause})` : cause,
            )
            .join(', ')
    }`,
    ...(progress.stopped !== undefined
      ? [
          `  stopped: ${progress.stopped.cause} (${progress.stopped.mode}) at ${progress.stopped.at}`,
          `  completion: ${progress.completionBlocker ?? 'ready for node verification'}`,
        ]
      : []),
  ]
}
