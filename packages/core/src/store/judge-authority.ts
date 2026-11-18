/**
 * The judge credential's one permitted write (SPEC §13.1.1, §8.1). A judge
 * session may append exactly one `panel.preferred` for its own panel, judge
 * and session, attributed to itself, while its session is open. It reads
 * nothing. The local judge store, the remote CLI wrapper, the hosted request
 * guard and the kernel's outbox commit share this rule; only the parts each
 * can check differ. Holders of the store append through
 * `appendJudgePreference`, which makes the check and the write one atomic
 * step.
 */
import type { EventEnvelope, EventWrite } from '../events/catalog'
import type { BuildDelegationFacts } from '../kernel/service-facts'
import { delegationFactKey } from '../kernel/service-facts'
import type { BuildStore } from './types'

export interface JudgeScope {
  build: string
  panel: string
  judge: number
  session: string
}

/** The fields of an event write this rule inspects; wire bodies are unknown. */
export interface JudgeWriteCandidate {
  type?: unknown
  actor?: unknown
  payload?: unknown
}

/** The write alone: type, actor and payload must match the scope exactly.
 * Returns the refusal reason, or undefined when the write is in scope. */
export function judgeScopeRefusal(
  scope: JudgeScope,
  write: JudgeWriteCandidate,
): string | undefined {
  if (write.type !== 'panel.preferred') return 'a judge may append only panel.preferred'
  const actor = write.actor as { kind?: unknown; role?: unknown; session?: unknown } | null
  if (
    typeof actor !== 'object' ||
    actor === null ||
    actor.kind !== 'agent' ||
    actor.role !== 'judge' ||
    actor.session !== scope.session
  )
    return 'a judge writes only as its own judge session'
  const payload = write.payload as { panel?: unknown; judge?: unknown; session?: unknown } | null
  if (typeof payload !== 'object' || payload === null) return 'panel.preferred needs a payload'
  if (payload.panel !== scope.panel) return 'preference for another panel'
  if (payload.judge !== scope.judge) return 'preference for another judge'
  if (payload.session !== scope.session) return 'preference for another session'
  return undefined
}

/** The lifecycle facts the full rule needs, read by an authority that holds
 * the store: whether this session already preferred, and whether it ended. */
export interface JudgeLifecycleFacts {
  preferred: boolean
  ended: boolean
  /** Whether the session was started on this build at all. */
  started: boolean
}

export function judgeLifecycleFacts(
  facts: Pick<BuildDelegationFacts, 'sessions'> & { preferred?: Record<string, true> },
  session: string,
): JudgeLifecycleFacts {
  const key = delegationFactKey(session)
  const lifecycle = facts.sessions[key]
  return {
    started: (lifecycle?.starts.length ?? 0) > 0,
    ended: (lifecycle?.endings.length ?? 0) > 0,
    preferred: facts.preferred?.[key] === true,
  }
}

/** The full rule: the write's scope plus one open, unanswered session. */
export function judgeWriteRefusal(
  scope: JudgeScope,
  write: JudgeWriteCandidate,
  facts: JudgeLifecycleFacts,
): string | undefined {
  const refusal = judgeScopeRefusal(scope, write)
  if (refusal !== undefined) return refusal
  if (!facts.started) return 'the judge session was never started'
  if (facts.ended) return 'the judge session has ended'
  if (facts.preferred) return 'this judge already recorded its preference'
  return undefined
}

/** Conditional-append attempts before a contended preference gives up. Each
 * attempt is one incremental delegation read and one conditional append. */
export const JUDGE_APPEND_ATTEMPTS = 8

/** Every attempt saw the build advance between its read and its append. */
export class JudgePreferenceContentionError extends Error {
  constructor(readonly attempts: number) {
    super(
      `the build kept advancing while the judge preference was being recorded ` +
        `(${attempts} attempts); retry`,
    )
    this.name = 'JudgePreferenceContentionError'
  }
}

/** The outcome of one atomic preference write. */
export type JudgePreferenceAppend<E> =
  | { kind: 'recorded'; event: E }
  | { kind: 'refused'; reason: string }

/**
 * Append a judge's preference atomically (AUT-1245): read the delegation
 * facts once, apply the full rule, then append only if the build has not
 * advanced since that read. A lost race re-reads, so a concurrent second
 * preference from the same session sees the first and is refused; another
 * session's append only costs a retry. Holders of the store (the hosted
 * server, the kernel committing a local judge's outbox) share this helper.
 */
export async function appendJudgePreference<
  S extends Pick<BuildStore, 'getReducerValue' | 'appendIfCurrent'>,
>(
  store: S,
  scope: JudgeScope,
  write: JudgeWriteCandidate,
  attempts = JUDGE_APPEND_ATTEMPTS,
): Promise<JudgePreferenceAppend<EventEnvelope<'panel.preferred'>>> {
  const refusal = judgeScopeRefusal(scope, write)
  if (refusal !== undefined) return { kind: 'refused', reason: refusal }
  for (let attempt = 0; attempt < attempts; attempt++) {
    const read = await store.getReducerValue(
      { kind: 'build', slug: scope.build },
      { reducer: 'buildDelegation' },
    )
    const facts = read.value as unknown as BuildDelegationFacts
    const lifecycle = judgeWriteRefusal(scope, write, judgeLifecycleFacts(facts, scope.session))
    if (lifecycle !== undefined) return { kind: 'refused', reason: lifecycle }
    const event = await store.appendIfCurrent(
      scope.build,
      read.cursor,
      write as EventWrite<'panel.preferred'>,
    )
    if (event !== null) return { kind: 'recorded', event }
  }
  throw new JudgePreferenceContentionError(attempts)
}
