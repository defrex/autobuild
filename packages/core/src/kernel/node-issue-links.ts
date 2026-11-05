/**
 * A node's issue-link union (SPEC "Forge issue links"). Each landed child
 * records its contribution once as `node.issue-links-recorded` on the node;
 * the node's reducer folds contributions with `mergeNodeIssueLinks`, so the
 * union is never recomputed from child logs. A node's set is its own
 * effective links merged with that union. A root node's PR into the default
 * branch carries the set; a nested node's PR carries it as refs-only lines.
 * Both are written through `Forge.updatePrIssueLinks` and confirmed by
 * `node.issue-links-published`.
 */
import type { Forge, IssueLink } from '../ports/types'

/** One issue in a node union or a child contribution. `downgraded` is set
 * when some contributing child downgraded the issue before its seal. */
export interface NodeIssueLink {
  issue: number
  intent: 'closes' | 'refs'
  downgraded?: true
}

/** The reduced node fields this module reads. */
export interface NodeIssueLinkState {
  kind?: 'work' | 'node'
  target?: unknown
  pr?: { number: number }
  prState?: string
  issueLinks: ReadonlyArray<IssueLink & { downgrade?: unknown }>
  nodeIssueLinks?: {
    links: readonly NodeIssueLink[]
    published?: { pr: number; issueLinks: readonly IssueLink[] }
  }
}

/**
 * Merge a contribution into a union, per issue: a downgrade by any
 * contributor wins and makes the issue `refs`; otherwise any `closes` makes
 * it `closes`; an issue every contributor only references stays `refs`.
 * Commutative, associative and idempotent; sorted ascending by issue.
 */
export function mergeNodeIssueLinks(
  current: readonly NodeIssueLink[],
  contribution: readonly NodeIssueLink[],
): NodeIssueLink[] {
  const merged = new Map<number, { closes: boolean; downgraded: boolean }>()
  for (const link of [...current, ...contribution]) {
    const entry = merged.get(link.issue) ?? {
      closes: false,
      downgraded: false,
    }
    entry.closes ||= link.intent === 'closes'
    entry.downgraded ||= link.downgraded === true
    merged.set(link.issue, entry)
  }
  return [...merged]
    .sort(([a], [b]) => a - b)
    .map(([issue, { closes, downgraded }]) =>
      downgraded
        ? { issue, intent: 'refs' as const, downgraded: true as const }
        : { issue, intent: closes ? ('closes' as const) : ('refs' as const) },
    )
}

/** A build's own effective links with downgrade provenance, ascending. */
export function ownIssueLinks(state: NodeIssueLinkState): NodeIssueLink[] {
  return [...state.issueLinks]
    .sort((a, b) => a.issue - b.issue)
    .map(({ issue, intent, downgrade }) => ({
      issue,
      intent,
      ...(downgrade !== undefined ? { downgraded: true as const } : {}),
    }))
}

/** A node's set: its own effective links merged with its children's union. */
export function nodeIssueLinkSet(state: NodeIssueLinkState): NodeIssueLink[] {
  return mergeNodeIssueLinks(ownIssueLinks(state), state.nodeIssueLinks?.links ?? [])
}

/** What a landed child records on its target node: a nested node's set (its
 * own links merged with its union), or a leaf's effective links with
 * downgrade provenance. */
export function contributedIssueLinks(state: NodeIssueLinkState): NodeIssueLink[] {
  return state.kind === 'node' ? nodeIssueLinkSet(state) : ownIssueLinks(state)
}

/** The lines a node's PR body carries, when it should: the build is a node,
 * the forge closes issues and can update a PR's keyword lines, and the set is
 * nonempty. A root node's PR into the configured base carries the set as is;
 * a nested node's PR into its parent carries every issue as `refs`, so it
 * shows on the issue without closing anything. */
export function nodeIssueLinksForForge(
  state: NodeIssueLinkState,
  forge: Pick<Forge, 'closesIssues' | 'updatePrIssueLinks'>,
): IssueLink[] | undefined {
  if (
    state.kind !== 'node' ||
    forge.closesIssues !== true ||
    typeof forge.updatePrIssueLinks !== 'function'
  )
    return undefined
  const links = nodeIssueLinkSet(state)
  if (links.length === 0) return undefined
  const nested = state.target !== undefined
  return links.map(({ issue, intent }) => ({ issue, intent: nested ? 'refs' : intent }))
}

function canonical(links: readonly IssueLink[]): string {
  return JSON.stringify(
    [...links].sort((a, b) => a.issue - b.issue).map(({ issue, intent }) => ({ issue, intent })),
  )
}

/** The links to write when the open node PR's last confirmed readback
 * differs from its set. A pure comparison of reduced state: no forge call
 * and no event read while nothing changes. */
export function nodeIssueLinksSyncPending(
  state: NodeIssueLinkState,
  forge: Pick<Forge, 'closesIssues' | 'updatePrIssueLinks'>,
): IssueLink[] | undefined {
  const links = nodeIssueLinksForForge(state, forge)
  if (links === undefined || state.pr === undefined || state.prState !== 'open') return undefined
  const published = state.nodeIssueLinks?.published
  return published === undefined ||
    published.pr !== state.pr.number ||
    canonical(published.issueLinks) !== canonical(links)
    ? links
    : undefined
}

/** True when the last confirmed readback for `pr` already equals `links`. */
export function nodeIssueLinksPublished(
  state: NodeIssueLinkState,
  pr: number,
  links: readonly IssueLink[],
): boolean {
  const published = state.nodeIssueLinks?.published
  return (
    published !== undefined &&
    published.pr === pr &&
    canonical(published.issueLinks) === canonical(links)
  )
}
