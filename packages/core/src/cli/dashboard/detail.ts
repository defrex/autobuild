import type { AbEvent } from '../../events/catalog'
import type { StreamRecord } from '../../store/types'

export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  turns: number
}

export interface DashboardSession {
  id: string
  role: string
  phase: string
  round?: number
  runtime: string
  model?: string
  startedSeq: number
  status: 'open' | 'ended' | 'reclaimed'
  usage?: SessionUsage
  transcript?: { kind: string; rev: number }
  reclaimedBy?: { instance: string; resumedFromSeq: number }
  /** Live-view stream id (SPEC §9); absent on sessions that never streamed. */
  stream?: string
  /** Open until the session's `session.ended` lands; the store's records
   * refine this to the stream's authoritative status when available. */
  streamStatus: 'open' | 'closed'
}

/**
 * Display-only chronological session history. The lifecycle reducer retains
 * only open sessions; the dashboard needs both halves, so it pairs the raw
 * append-only facts without introducing transition state. `streams` is the
 * optional authoritative enrichment from `listStreams` on the build scope:
 * records whose label matches `session:<id>` supply each session's stream id
 * and open/closed status.
 */
export function projectSessions(
  events: readonly AbEvent[],
  streams?: readonly StreamRecord[],
): DashboardSession[] {
  const streamsByLabel = new Map<string, StreamRecord>()
  if (streams !== undefined) {
    for (const record of streams) {
      if (record.scope.kind === 'build') streamsByLabel.set(record.label, record)
    }
  }

  const sessions: DashboardSession[] = []
  const open = new Map<string, DashboardSession>()

  for (const event of events) {
    if (event.type === 'session.started') {
      const record = streamsByLabel.get(`session:${event.payload.session}`)
      const session: DashboardSession = {
        id: event.payload.session,
        role: event.payload.role,
        phase: event.payload.phase,
        ...(event.payload.round !== undefined ? { round: event.payload.round } : {}),
        runtime: event.payload.runner,
        ...(event.payload.model !== undefined ? { model: event.payload.model } : {}),
        startedSeq: event.seq,
        status: 'open',
        // The store's records are authoritative when available; without them
        // the pairing degrades gracefully (open until `session.ended`).
        ...(record !== undefined
          ? { stream: record.id, streamStatus: record.status }
          : {
              ...(event.payload.stream !== undefined ? { stream: event.payload.stream } : {}),
              streamStatus: event.payload.stream !== undefined ? 'open' : 'closed',
            }),
      }
      sessions.push(session)
      open.set(session.id, session)
      continue
    }
    if (event.type !== 'session.ended') continue
    const started = open.get(event.payload.session)
    if (started === undefined) continue
    if ('transcript' in event.payload) {
      started.status = 'ended'
      started.usage = { ...event.payload.usage }
      started.transcript = { ...event.payload.transcript }
    } else {
      started.status = 'reclaimed'
      started.reclaimedBy = { ...event.payload.reclaimedBy }
    }
    // A session bracket has ended: without an authoritative record its
    // stream reads closed.
    const record = streamsByLabel.get(`session:${started.id}`)
    if (record !== undefined) {
      started.stream = record.id
      started.streamStatus = record.status
    } else {
      started.streamStatus = 'closed'
    }
    open.delete(started.id)
  }

  return sessions
}
