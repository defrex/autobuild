/**
 * The operator-session reducer (SPEC §7.1.1, §15.2): a session's status, open
 * turn, pending approval, wake settings, wake cursors, and turn list are a
 * pure reduction of its event log — never a stored column. The catalog is
 * closed (`events/sessions.ts`), so this function is total over session
 * history; unknown facts cannot exist.
 */
import type { SessionEvent } from '../events/sessions'

export type SessionStatus = 'idle' | 'running' | 'suspended' | 'awaiting-approval' | 'archived'
export type SessionSuspensionCause = 'budget' | 'approval'
export type TurnOutcomeState = 'open' | 'suspended' | 'completed' | 'failed'

export type SessionTurnTrigger =
  | { kind: 'message'; messageSeq: number }
  | { kind: 'wake'; build: string; seq: number; type: string }

export interface SessionTurn {
  turn: string
  stream: string
  startedSeq: number
  trigger: SessionTurnTrigger
  state: TurnOutcomeState
  usage?: { inputTokens: number; outputTokens: number; steps: number; turns?: number }
  error?: string
  /** The typed failure class of a failed turn (provider-unavailable,
   * exhausted, credentials, configuration, or internal). */
  kind?: 'provider-unavailable' | 'exhausted' | 'credentials' | 'configuration' | 'internal'
}

export interface SessionState {
  status: SessionStatus
  /** Present only when status is `suspended`. */
  suspendedCause?: SessionSuspensionCause
  /** The most recent turn that has started and not completed or failed. */
  openTurn?: { turn: string; stream: string; startedSeq: number; trigger: SessionTurnTrigger }
  /** A requested approval with no matching `approval.answered` yet. */
  pendingApproval?: {
    turn: string
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
    requestedSeq: number
  }
  /** Last `session.wake-set` wins; `[]` before the first (message-only). */
  wakeGlobs: string[]
  /** Per build, the highest build event seq a wake trigger has consumed. */
  wakeCursors: Record<string, number>
  /** Every turn in start order, with its stream id and outcome. */
  turns: SessionTurn[]
}

interface TurnEntry extends SessionTurn {
  /** The most recent suspension cause for this turn, if any. */
  suspensionCause?: SessionSuspensionCause
}

const isTerminal = (state: SessionTurn['state']): boolean =>
  state === 'completed' || state === 'failed'

/** Reduce a session's events into its derived state. `session.archived` is
 * terminal: every fact after it is ignored — the archived state is frozen. */
export function reduceSession(events: SessionEvent[]): SessionState {
  const turns: TurnEntry[] = []
  let archived = false
  let pendingApproval: SessionState['pendingApproval']
  let wakeGlobs: string[] = []
  const wakeCursors: Record<string, number> = {}

  const open = (): TurnEntry | undefined => turns.findLast((turn) => !isTerminal(turn.state))

  for (const event of events) {
    if (archived) break
    switch (event.type) {
      case 'session.created':
      case 'message.posted':
        break
      case 'session.wake-set':
        wakeGlobs = [...event.payload.globs]
        break
      case 'turn.started': {
        const entry: TurnEntry = {
          turn: event.payload.turn,
          stream: event.payload.stream,
          startedSeq: event.seq,
          trigger: event.payload.trigger,
          state: 'open',
        }
        turns.push(entry)
        if (event.payload.trigger.kind === 'wake') {
          const build = event.payload.trigger.build
          wakeCursors[build] = Math.max(wakeCursors[build] ?? 0, event.payload.trigger.seq)
        }
        break
      }
      case 'turn.suspended': {
        const entry = turns.findLast((candidate) => candidate.turn === event.payload.turn)
        if (entry && entry.state === 'open') {
          entry.state = 'suspended'
          entry.suspensionCause = event.payload.cause
        }
        break
      }
      case 'turn.resumed': {
        const entry = turns.findLast((candidate) => candidate.turn === event.payload.turn)
        if (entry && entry.state === 'suspended') entry.state = 'open'
        break
      }
      case 'approval.requested':
        pendingApproval = {
          turn: event.payload.turn,
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName,
          input: event.payload.input,
          requestedSeq: event.seq,
        }
        break
      case 'approval.answered': {
        if (
          pendingApproval?.turn === event.payload.turn &&
          pendingApproval.toolCallId === event.payload.toolCallId
        ) {
          pendingApproval = undefined
          // The answer only clears the pending approval — `turn.resumed` is
          // the sole resume fact, recorded by the runner when it actually
          // picks the turn up. Flipping the turn state here (the earlier
          // behavior) made a session look `running` while no runner existed:
          // an answered approval whose resuming invocation died would be
          // unrecoverable. The status sequence after an answer is therefore
          // awaiting-approval → suspended(approval) → running.
        }
        break
      }
      case 'turn.completed': {
        const entry = turns.findLast((candidate) => candidate.turn === event.payload.turn)
        if (entry && !isTerminal(entry.state)) {
          entry.state = 'completed'
          entry.usage = event.payload.usage
        }
        break
      }
      case 'turn.failed': {
        const entry = turns.findLast((candidate) => candidate.turn === event.payload.turn)
        if (entry && !isTerminal(entry.state)) {
          entry.state = 'failed'
          entry.error = event.payload.error
          entry.kind = event.payload.kind
        }
        break
      }
      case 'session.archived':
        archived = true
        break
    }
  }

  const openEntry = open()
  // Status precedence: archived > awaiting-approval > suspended > running >
  // idle. An unanswered approval outranks its turn's suspension; the answer
  // that clears it hands status back to the turn.
  const status: SessionStatus = archived
    ? 'archived'
    : pendingApproval !== undefined
      ? 'awaiting-approval'
      : openEntry === undefined
        ? 'idle'
        : openEntry.state === 'suspended'
          ? 'suspended'
          : 'running'

  return {
    status,
    ...(status === 'suspended' && openEntry?.suspensionCause !== undefined
      ? { suspendedCause: openEntry.suspensionCause }
      : {}),
    ...(openEntry !== undefined
      ? {
          openTurn: {
            turn: openEntry.turn,
            stream: openEntry.stream,
            startedSeq: openEntry.startedSeq,
            trigger: openEntry.trigger,
          },
        }
      : {}),
    ...(pendingApproval !== undefined ? { pendingApproval } : {}),
    wakeGlobs,
    wakeCursors,
    turns: turns.map(({ suspensionCause: _suspensionCause, ...turn }) => turn),
  }
}
