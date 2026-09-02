import type { AbEvent } from '../../events/catalog'

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
}

/**
 * Display-only chronological session history. The lifecycle reducer retains
 * only open sessions; the dashboard needs both halves, so it pairs the raw
 * append-only facts without introducing transition state.
 */
export function projectSessions(events: readonly AbEvent[]): DashboardSession[] {
  const sessions: DashboardSession[] = []
  const open = new Map<string, DashboardSession>()

  for (const event of events) {
    if (event.type === 'session.started') {
      const session: DashboardSession = {
        id: event.payload.session,
        role: event.payload.role,
        phase: event.payload.phase,
        ...(event.payload.round !== undefined ? { round: event.payload.round } : {}),
        runtime: event.payload.runner,
        ...(event.payload.model !== undefined ? { model: event.payload.model } : {}),
        startedSeq: event.seq,
        status: 'open',
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
    open.delete(started.id)
  }

  return sessions
}
