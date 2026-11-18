/**
 * One recorded landing measurement as text, shared by `ab watch` and
 * `ab build status` so both say the same thing: a command's medians or a
 * judge panel's win rate, the delta, the noise and the decision.
 */
import type { EventPayload } from '../events/payloads'

export function measurementText(
  measured: Pick<
    EventPayload<'attempt.measured'>,
    'medians' | 'winRate' | 'delta' | 'spread' | 'decision'
  >,
): string {
  const values = measured.medians
    ? `candidate ${measured.medians.candidate} vs baseline ${measured.medians.baseline}`
    : `win rate ${measured.winRate}`
  const noise = measured.spread !== undefined ? ` (noise ±${measured.spread})` : ''
  return `${values}: delta ${measured.delta}${noise} → ${measured.decision}`
}
