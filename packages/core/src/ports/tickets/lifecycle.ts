import type { TicketsConfig } from '../../config/schema'

/** Resolve names without changing persisted ticket states or their spelling. */
export function ticketLifecycle(tickets: TicketsConfig, legacyHosted = false) {
  const hosted = tickets.source === 'hosted'
  const old = tickets.source === 'linear' || (hosted && legacyHosted)
  const triage = tickets.triageState ?? (old ? 'Backlog' : hosted ? 'triage' : 'Triage')
  return {
    triage,
    ready: tickets.readyState,
    doing:
      tickets.claimedState ??
      (tickets.source === 'linear' ? 'In Progress' : old ? 'Doing' : 'doing'),
    done: tickets.doneState ?? (old ? 'Done' : hosted ? 'done' : 'Done'),
    create: tickets.createState ?? triage,
    proposal: tickets.proposalState ?? triage,
  }
}
