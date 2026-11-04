/**
 * A node's issue-link union (SPEC "Forge issue links"). Each landed child
 * records its contribution once as `node.issue-links-recorded` on the node;
 * the node's reducer folds contributions with `mergeNodeIssueLinks`, so the
 * union is never recomputed from child logs. Only a root node's PR into the
 * default branch carries the union, written through
 * `Forge.updatePrIssueLinks` and confirmed by `node.issue-links-published`.
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

/** What a landed child records on its target node: a nested node's own
 * union, or a leaf's effective links with downgrade provenance. A node
 * ticket's own frozen links are not part of its union. */
export function contributedIssueLinks(state: NodeIssueLinkState): NodeIssueLink[] {
  if (state.kind === 'node') return (state.nodeIssueLinks?.links ?? []).map((link) => ({ ...link }))
  return [...state.issueLinks]
    .sort((a, b) => a.issue - b.issue)
    .map(({ issue, intent, downgrade }) => ({
      issue,
      intent,
      ...(downgrade !== undefined ? { downgraded: true as const } : {}),
    }))
}

/** The union a root node's PR body carries, when it should: the build is a
 * node aimed at the configured base, the forge closes issues and can update
 * a PR's keyword lines, and the union is nonempty. */
export function nodeIssueLinksForForge(
  state: NodeIssueLinkState,
  forge: Pick<Forge, 'closesIssues' | 'updatePrIssueLinks'>,
): IssueLink[] | undefined {
  if (
    state.kind !== 'node' ||
    state.target !== undefined ||
    forge.closesIssues !== true ||
    typeof forge.updatePrIssueLinks !== 'function'
  )
    return undefined
  const links = state.nodeIssueLinks?.links ?? []
  return links.length > 0 ? links.map(({ issue, intent }) => ({ issue, intent })) : undefined
}

function canonical(links: readonly IssueLink[]): string {
  return JSON.stringify(
    [...links].sort((a, b) => a.issue - b.issue).map(({ issue, intent }) => ({ issue, intent })),
  )
}

/** The links to write when the open root-node PR's last confirmed readback
 * differs from the union. A pure comparison of reduced state: no forge call
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
