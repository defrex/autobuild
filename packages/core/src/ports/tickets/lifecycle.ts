import type { TicketsConfig } from '../../config/schema'

/** Resolve names without changing persisted ticket states or their spelling.
 * `backlog` and `rejected` are optional roles: undefined when unset, with no
 * default, so an unconfigured role never matches a state of the same name. */
export interface TicketLifecycle {
  triage: string
  ready: string
  doing: string
  done: string
  create: string
  proposal: string
  backlog?: string
  rejected?: string
}

export function ticketLifecycle(tickets: TicketsConfig, legacyHosted = false): TicketLifecycle {
  // GitHub states are `autobuild:<state>` labels, so its defaults share the
  // hosted source's lowercase spelling.
  const hosted = tickets.source === 'hosted' || tickets.source === 'github'
  const old = tickets.source === 'linear' || (tickets.source === 'hosted' && legacyHosted)
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
    ...(tickets.backlogState === undefined ? {} : { backlog: tickets.backlogState }),
    ...(tickets.rejectedState === undefined ? {} : { rejected: tickets.rejectedState }),
  }
}

/** Whether a native state is the one a role names. Case-insensitive, as
 * `ab ticket states` and the file source already match state names; false
 * when either side is absent, so an unset role holds nothing. */
export function holdsState(state: string | undefined, name: string | undefined): boolean {
  return (
    state !== undefined &&
    name !== undefined &&
    state.trim().toLowerCase() === name.trim().toLowerCase()
  )
}

/** Roles a ticket can be moved into by role rather than by native name. */
export const TICKET_MOVE_ROLES = ['triage', 'ready', 'backlog', 'rejected'] as const
export type TicketMoveRole = (typeof TICKET_MOVE_ROLES)[number]

/** Every lifecycle role, in import priority: a state holding several roles
 * lands in the destination's state for the first. */
export const LIFECYCLE_ROLES = [
  'done',
  'rejected',
  'claimed',
  'ready',
  'backlog',
  'triage',
  'proposal',
  'create',
] as const
export type LifecycleRole = (typeof LIFECYCLE_ROLES)[number]

/** The native state a role names; `claimed` is the lifecycle's `doing`. */
export function roleState(lifecycle: TicketLifecycle, role: LifecycleRole): string | undefined {
  return role === 'claimed' ? lifecycle.doing : lifecycle[role]
}

/** The roles native state `name` holds, in `LIFECYCLE_ROLES` order. */
export function stateRolesIn(lifecycle: TicketLifecycle, name: string): LifecycleRole[] {
  return LIFECYCLE_ROLES.filter((role) => holdsState(name, roleState(lifecycle, role)))
}
