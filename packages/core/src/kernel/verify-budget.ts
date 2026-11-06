/**
 * Escalation wording for the build-wide `maxVerifyAttempts` budget. It
 * describes, and never decides: the engine counts distinct failed attempts and
 * hands this module the same failed records it counted, so the attempts listed
 * are exactly the attempts that consumed the budget.
 *
 * The question claims a step failed repeatedly only when that step failed in
 * every counted cycle; otherwise it names the latest failed cycle's steps.
 */
import type { VerifyRecord } from './log-index'

type CountedFailure = Pick<VerifyRecord, 'step' | 'attempt'>

export function verifyBudgetExhaustedQuestion(
  limit: number,
  fails: readonly CountedFailure[],
): string {
  const byAttempt = new Map<number, string[]>()
  for (const fail of fails) {
    const steps = byAttempt.get(fail.attempt) ?? []
    if (!steps.includes(fail.step)) steps.push(fail.step)
    byAttempt.set(fail.attempt, steps)
  }
  const attempts = [...byAttempt.keys()].sort((a, b) => a - b)
  const label = (steps: readonly string[]) => steps.map((step) => `verify:${step}`).join(', ')
  const history = attempts
    .map((attempt) => `attempt ${attempt} (${label(byAttempt.get(attempt)!)})`)
    .join(', ')
  const cycles =
    attempts.length === 1
      ? '1 failed verify cycle counts'
      : `${attempts.length} failed verify cycles count`
  const latest = attempts.at(-1)
  const latestSteps = latest === undefined ? [] : byAttempt.get(latest)!
  const everyCycle = latestSteps.filter((step) =>
    attempts.every((attempt) => byAttempt.get(attempt)!.includes(step)),
  )
  const diagnosis =
    everyCycle.length > 0
      ? `${label(everyCycle)} failed in every counted cycle.`
      : `No single step failed in every counted cycle; the latest failed cycle, attempt ${latest}, failed ${label(latestSteps)}.`
  return `maxVerifyAttempts (${limit}) exhausted: ${cycles} against the build-wide budget: ${history}. ${diagnosis}`
}
