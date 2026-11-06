/**
 * `[tickets].readyAssignee` is a ticket-source capability. A source opts in
 * with `readyAssignee = true` on the constructed `TicketSource`; parse time
 * can only check the builtins, because plugins load after config parse, so the
 * registry-aware seams (`createTicketSource` and `LiveConfig` reloads) enforce
 * the declaration for every source. The value forms below are the builtins'
 * own rules; a plugin source enforces its own.
 */
import type { TicketSource } from '../ports/types'
import type { TicketsConfig } from './schema'

export interface ReadyAssigneeForm {
  accepts(value: string): boolean
  message: string
}

/** Linear: `"me"` (the owner of LINEAR_API_KEY) or a user's email. */
export const LINEAR_READY_ASSIGNEE: ReadyAssigneeForm = {
  accepts: (s) => s === 'me' || (s === s.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)),
  message:
    '[tickets].readyAssignee must be "me" (the owner of the API key) or a user email address (e.g. "person@example.com")',
}

/**
 * GitHub: `"me"` (the owner of the GitHub credential) or a login. A personal
 * login is alphanumerics and dashes; an Enterprise Managed User login is the
 * normalized base, `_`, and a 3–8 character alphanumeric shortcode; either is
 * at most 39 characters (docs.github.com, "Username considerations for
 * external authentication"). The base is deliberately permissive about dash
 * placement, since older accounts predate the normalization rules; `ab init
 * --validate` proves the user can actually be assigned.
 */
export const GITHUB_READY_ASSIGNEE: ReadyAssigneeForm = {
  accepts: (s) =>
    s === 'me' || (s.length <= 39 && /^[A-Za-z0-9][A-Za-z0-9-]*(?:_[A-Za-z0-9]{3,8})?$/.test(s)),
  message:
    '[tickets].readyAssignee must be "me" (the owner of the GitHub credential) or a GitHub username (e.g. "octocat", or a managed user\'s "mona_acme") for source = "github"',
}

export function readyAssigneeUnsupported(source: string, plugin?: string): string {
  const from = plugin !== undefined ? ` from plugin "${plugin}"` : ''
  return `[tickets].readyAssignee: ticket source "${source}"${from} cannot filter ready tickets by assignee — remove readyAssignee (selected source: "${source}")`
}

/** Refuse `readyAssignee` for a constructed source that does not declare it. */
export function assertReadyAssigneeSupported(
  tickets: TicketsConfig,
  source: TicketSource,
  plugin?: string,
): void {
  if (tickets.readyAssignee !== undefined && source.readyAssignee !== true)
    throw new Error(readyAssigneeUnsupported(tickets.source, plugin))
}

/**
 * The reload check: synchronous and request-free, because `LiveConfig`
 * refreshes at the head of a dispatcher tick. It decides from what
 * `prepareReadyAssignee` resolved at startup.
 */
export function assertReadyAssigneeAccepted(tickets: TicketsConfig, source: TicketSource): void {
  assertReadyAssigneeSupported(tickets, source)
  if (tickets.readyAssignee === undefined) return
  const refusal = source.readyAssigneeRefusal?.(tickets.readyAssignee)
  if (refusal !== undefined) throw new Error(refusal)
}

/**
 * Dispatcher startup, before the loop: prepare whatever a later `"me"` needs,
 * whether or not `readyAssignee` is set, so no tick ever resolves it. A
 * preparation failure fails startup only when the configuration needs it.
 */
export async function prepareReadyAssigneeForDispatch(
  source: TicketSource,
  tickets: TicketsConfig,
  warn: (message: string) => void,
): Promise<void> {
  try {
    await source.prepareReadyAssignee?.()
  } catch (error) {
    if (tickets.readyAssignee !== undefined) throw error
    warn(
      `ticket source "${source.name}" could not prepare readyAssignee: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  assertReadyAssigneeAccepted(tickets, source)
}
