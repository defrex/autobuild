/**
 * Pure mapping between GitHub issues and Autobuild tickets for the `github`
 * ticket source (SPEC §13). Nothing here performs I/O: the adapter in
 * `github.ts` reads and writes through the transport, and these functions
 * decide what an issue means and what a write must send.
 *
 * Vocabulary on GitHub:
 * - a state is an `autobuild:<state>` label on an open issue; an open issue
 *   with none is in triage; closed as completed (or with no recorded reason)
 *   is done; closed as not planned or duplicate is the rejected role, or the
 *   fixed `not-planned` state when no rejected role is configured;
 * - a link to another forge issue is an `autobuild-link:<intent> #<n>` label;
 * - a creation key is a hidden HTML comment at the end of the body.
 */
import { z } from 'zod'
import type { IssueLink } from '../types'
import { normalizeIssueLinks } from './issue-links'
import { holdsState, type TicketLifecycle } from './lifecycle'
import { validateStateName } from './states'

export const STATE_LABEL_PREFIX = 'autobuild:'
export const LINK_LABEL_PREFIX = 'autobuild-link:'
/** The state of an issue closed as not planned or duplicate when no rejected
 * role is configured. Listed, never ready, never resolves, never a target. */
export const NOT_PLANNED_STATE = 'not-planned'

// ── Wire shapes ──────────────────────────────────────────────────────────────
//
// Only the fields this source relies on are validated; unknown fields pass
// through so an added GitHub field cannot break a tick.

const labelRef = z.union([z.string(), z.object({ name: z.string() }).passthrough()])

export const githubIssueSchema = z
  .object({
    id: z.number().int(),
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable().optional(),
    html_url: z.string(),
    state: z.enum(['open', 'closed']),
    state_reason: z.string().nullable().optional(),
    labels: z.array(labelRef),
    pull_request: z.unknown().optional(),
    repository_url: z.string().optional(),
    created_at: z.string().optional(),
    issue_dependencies_summary: z
      .object({
        blocked_by: z.number().int().optional(),
        total_blocked_by: z.number().int().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()
export type GitHubIssue = z.infer<typeof githubIssueSchema>

export const githubLabelSchema = z
  .object({ name: z.string(), description: z.string().nullable().optional() })
  .passthrough()
export type GitHubLabel = z.infer<typeof githubLabelSchema>

export const githubTimelineNodeSchema = z
  .object({
    __typename: z.string(),
    label: z.object({ name: z.string() }).passthrough().nullable().optional(),
  })
  .passthrough()
export type GitHubTimelineNode = z.infer<typeof githubTimelineNodeSchema>

// ── Ids ──────────────────────────────────────────────────────────────────────

/** `123` or `#123` → 123; anything else (UUIDs included) is no such ticket. */
export function parseIssueId(id: string): number | null {
  const match = /^#?([1-9][0-9]*)$/.exec(id.trim())
  if (!match) return null
  const number = Number(match[1])
  return Number.isSafeInteger(number) ? number : null
}

// ── Labels and states ────────────────────────────────────────────────────────

export function labelNames(issue: Pick<GitHubIssue, 'labels'>): string[] {
  return issue.labels.map((label) => (typeof label === 'string' ? label : label.name))
}

function hasPrefix(name: string, prefix: string): boolean {
  return name.toLowerCase().startsWith(prefix)
}

export function isStateLabel(name: string): boolean {
  return hasPrefix(name, STATE_LABEL_PREFIX)
}

export function isLinkLabel(name: string): boolean {
  return hasPrefix(name, LINK_LABEL_PREFIX)
}

export function stateLabel(state: string): string {
  return `${STATE_LABEL_PREFIX}${state}`
}

/** The `autobuild:` labels on an issue, in label case. */
export function stateLabelsOf(issue: Pick<GitHubIssue, 'labels'>): string[] {
  return labelNames(issue).filter(isStateLabel)
}

/** The ticket's own labels: every label except state and link labels. */
export function ticketLabelsOf(issue: Pick<GitHubIssue, 'labels'>): string[] {
  return labelNames(issue).filter((name) => !isStateLabel(name) && !isLinkLabel(name))
}

/** The lifecycle names in workflow order, without duplicates. */
export function lifecycleNames(lifecycle: TicketLifecycle): string[] {
  return [
    ...new Set(
      [
        lifecycle.triage,
        lifecycle.ready,
        lifecycle.doing,
        lifecycle.done,
        lifecycle.create,
        lifecycle.proposal,
        lifecycle.backlog,
        lifecycle.rejected,
      ].filter((name): name is string => name !== undefined),
    ),
  ]
}

/** The state of a closed issue that was not completed. */
export function rejectedStateOf(lifecycle: TicketLifecycle): string {
  return lifecycle.rejected ?? NOT_PLANNED_STATE
}

/** A label suffix spelled as its configured lifecycle name when one matches
 * ignoring case, so `autobuild:Ready` reads as the configured `ready`. */
function canonicalState(name: string, lifecycle: TicketLifecycle): string {
  return lifecycleNames(lifecycle).find((known) => holdsState(known, name)) ?? name
}

export function isClosedCompleted(issue: Pick<GitHubIssue, 'state' | 'state_reason'>): boolean {
  // A null reason is a legacy completion: GitHub recorded no reason before
  // close reasons existed, and treating it as done keeps old blockers resolved.
  return (
    issue.state === 'closed' &&
    (issue.state_reason === 'completed' ||
      issue.state_reason === null ||
      issue.state_reason === undefined)
  )
}

export type IssueStateResult = { state: string } | { malformed: string[] }

/** What an issue's GitHub facts say its state is, before any reopen check. */
export function issueState(
  issue: Pick<GitHubIssue, 'state' | 'state_reason' | 'labels'>,
  lifecycle: TicketLifecycle,
): IssueStateResult {
  if (issue.state === 'closed')
    return { state: isClosedCompleted(issue) ? lifecycle.done : rejectedStateOf(lifecycle) }
  const labels = stateLabelsOf(issue)
  if (labels.length === 0) return { state: lifecycle.triage }
  if (labels.length > 1) return { malformed: labels }
  return { state: canonicalState(labels[0]!.slice(STATE_LABEL_PREFIX.length), lifecycle) }
}

/** Whether a reopened issue's single state label needs the reopen check. */
export function needsReopenCheck(
  issue: Pick<GitHubIssue, 'state' | 'state_reason' | 'labels'>,
): boolean {
  return (
    issue.state === 'open' && issue.state_reason === 'reopened' && stateLabelsOf(issue).length === 1
  )
}

export type ReopenVerdict = 'fresh' | 'stale' | 'undecidable'

/**
 * Walk timeline nodes (oldest first, as GitHub returns them) newest first and
 * stop at the first decisive one: the current state label's `LabeledEvent`
 * means the label was put on after the reopen (fresh), a `ReopenedEvent`
 * means the label predates the reopen (stale). Neither in the window is
 * undecidable, and the caller fails closed.
 */
export function reopenVerdict(
  nodes: ReadonlyArray<GitHubTimelineNode>,
  currentStateLabel: string,
): ReopenVerdict {
  const wanted = currentStateLabel.toLowerCase()
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!
    if (node.__typename === 'ReopenedEvent') return 'stale'
    if (node.__typename === 'LabeledEvent' && node.label?.name.toLowerCase() === wanted)
      return 'fresh'
  }
  return 'undecidable'
}

export interface IssueWrite {
  state: 'open' | 'closed'
  state_reason?: 'completed' | 'not_planned'
  /** The complete label set after the write. */
  labels: string[]
}

/**
 * The issue facts that put a ticket in `state`, keeping every non-state label.
 * Closing always strips state labels, so a reopen in the GitHub UI comes back
 * label-less, which is triage.
 */
export function writeForState(
  state: string,
  lifecycle: TicketLifecycle,
  currentLabels: readonly string[],
): IssueWrite {
  const kept = currentLabels.filter((name) => !isStateLabel(name))
  if (holdsState(state, lifecycle.done))
    return { state: 'closed', state_reason: 'completed', labels: kept }
  if (lifecycle.rejected !== undefined && holdsState(state, lifecycle.rejected))
    return { state: 'closed', state_reason: 'not_planned', labels: kept }
  if (holdsState(state, NOT_PLANNED_STATE))
    throw new Error(
      `github ticket source: "${NOT_PLANNED_STATE}" holds issues closed as not planned and cannot be moved into; configure [tickets].rejectedState to move tickets there`,
    )
  if (holdsState(state, lifecycle.triage)) return { state: 'open', labels: kept }
  return { state: 'open', labels: [...kept, stateLabel(state)] }
}

/** A state name GitHub can hold as an `autobuild:` label: the shared state
 * name rule (lowercase, at most 40 characters), so the label fits GitHub's
 * 50-character limit. */
export function representableState(name: string): boolean {
  try {
    validateStateName(name, 'github ticket source')
    return true
  } catch {
    return false
  }
}

// ── Issue links ──────────────────────────────────────────────────────────────

export function linkLabel(link: IssueLink): string {
  return `${LINK_LABEL_PREFIX}${link.intent} #${link.issue}`
}

/** An `autobuild-link:` label's link; `'invalid'` for a malformed one and
 * `null` for a label without the prefix. */
export function parseLinkLabel(name: string): IssueLink | 'invalid' | null {
  if (!isLinkLabel(name)) return null
  const match = /^(closes|refs) #([1-9][0-9]*)$/i.exec(name.slice(LINK_LABEL_PREFIX.length))
  if (!match) return 'invalid'
  const issue = Number(match[2])
  if (!Number.isSafeInteger(issue)) return 'invalid'
  return { issue, intent: match[1]!.toLowerCase() as IssueLink['intent'] }
}

/** Merge links so one issue appears once; `closes` wins over `refs`. */
export function mergeIssueLinks(links: readonly IssueLink[]): IssueLink[] {
  const merged = new Map<number, IssueLink>()
  for (const link of links) {
    const known = merged.get(link.issue)
    if (known === undefined || (known.intent === 'refs' && link.intent === 'closes'))
      merged.set(link.issue, { ...link })
  }
  return normalizeIssueLinks([...merged.values()])
}

export interface IssueLinksRead {
  /** The issue's own `closes` link plus every valid link label. */
  links: IssueLink[]
  /** Link labels that do not parse. */
  invalid: string[]
}

export function issueLinksOf(issue: Pick<GitHubIssue, 'number' | 'labels'>): IssueLinksRead {
  const links: IssueLink[] = [{ issue: issue.number, intent: 'closes' }]
  const invalid: string[] = []
  for (const name of labelNames(issue)) {
    const link = parseLinkLabel(name)
    if (link === null) continue
    if (link === 'invalid') invalid.push(name)
    else links.push(link)
  }
  return { links: mergeIssueLinks(links), invalid }
}

/** The link labels a ticket's written links are stored as; the own issue's
 * `closes` link is implicit and never a label. */
export function linkLabelsFor(own: number | undefined, links: readonly IssueLink[]): string[] {
  return links.filter((link) => link.issue !== own).map(linkLabel)
}

// ── Creation key marker ──────────────────────────────────────────────────────

const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/
const MARKER_PATTERN =
  /\n<!-- autobuild:creation-key ([A-Za-z0-9._:-]{1,200})(?: pending ([A-Za-z0-9_-]*))? -->$/

/** The follow-up intent a keyed create records atomically with the issue. */
export interface CreationIntent {
  state: string
  issueLinks: IssueLink[]
  blockedBy: string[]
}

const creationIntentSchema = z.object({
  state: z.string(),
  issueLinks: z.array(
    z.object({ issue: z.number().int().positive(), intent: z.enum(['closes', 'refs']) }),
  ),
  blockedBy: z.array(z.string()),
})

export function validCreationKey(key: string): boolean {
  return KEY_PATTERN.test(key)
}

/** The body with a creation-key marker appended: pending (with the intent the
 * retry must finish) or plain (create complete). */
export function encodeCreationMarker(body: string, key: string, intent?: CreationIntent): string {
  if (!validCreationKey(key))
    throw new Error(
      `github create: creation key "${key}" must be 1-200 letters, digits, dots, colons, underscores or hyphens`,
    )
  const pending =
    intent === undefined
      ? ''
      : ` pending ${Buffer.from(JSON.stringify(intent), 'utf8').toString('base64url')}`
  return `${body}\n<!-- autobuild:creation-key ${key}${pending} -->`
}

export interface CreationMarker {
  key: string
  /** Present while the create's follow-ups are unfinished. */
  pending?: CreationIntent
}

/** Split a stored body into the ticket body (byte-exact) and its marker. */
export function splitCreationMarker(stored: string | null | undefined): {
  body: string
  marker?: CreationMarker
} {
  const raw = stored ?? ''
  const match = MARKER_PATTERN.exec(raw)
  if (!match) return { body: raw }
  const body = raw.slice(0, match.index)
  const key = match[1]!
  if (match[2] === undefined) return { body, marker: { key } }
  let pending: CreationIntent = { state: '', issueLinks: [], blockedBy: [] }
  try {
    const parsed = creationIntentSchema.safeParse(
      JSON.parse(Buffer.from(match[2], 'base64url').toString('utf8')),
    )
    if (parsed.success) pending = parsed.data
  } catch {
    // An unreadable intent still marks the create unfinished; the retry then
    // finishes nothing it cannot read and clears the flag.
  }
  return { body, marker: { key, pending } }
}
