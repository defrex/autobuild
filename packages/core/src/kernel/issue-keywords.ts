/**
 * Forge issue keywords for a build's frozen issue links (SPEC "Forge issue
 * links"). One pure module owns the text rules so the PR title and body, the
 * landed commit message and every identity comparison compose identically:
 *
 * - each linked issue gets one canonical `Closes #N` or `Refs #N` line;
 * - a closing keyword aimed at a `refs` issue is rewritten to `refs`, wherever
 *   it appears, so prose cannot close what the build only partly resolves;
 * - the keyword paragraph sits before a terminal git trailer block, never
 *   inside it, so `Autobuild-Build` and co-author parsing stay intact.
 *
 * With no links every function returns its input unchanged.
 */
import type { Forge, IssueLink } from '../ports/types'
import { splitTrailerBlock, withBuildTrailer } from './build-identity'

export interface IssueKeywordOptions {
  /** `owner/name` of the forge repository. Qualified references
   * (`owner/name#N`, issue URLs) count only for this repository. */
  repository?: string
}

/** GitHub's closing keywords ("Linking a pull request to an issue"). */
const CLOSING = 'close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved'
const MENTION = 'refs?|references'
const SEPARATOR = String.raw`(?:[ \t]*:[ \t]*|[ \t]+)`

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** One issue reference in any form GitHub resolves to this repository. */
function referenceSource(repository: string | undefined): string {
  const local = String.raw`#\d+|GH-\d+`
  if (repository === undefined) return local
  const repo = repository.split('/').map(escapeRegExp).join('/')
  return [
    String.raw`(?:https?://)?(?:www\.)?github\.com/${repo}/issues/\d+`,
    String.raw`${repo}#\d+`,
    local,
  ].join('|')
}

function referencedIssue(reference: string): number {
  return Number(/(\d+)$/.exec(reference)![1])
}

/** `Closes #820`, `Refs #824`, one per link, ascending by issue number. */
export function issueKeywordLines(links: readonly IssueLink[]): string[] {
  return [...links]
    .sort((a, b) => a.issue - b.issue)
    .map((link) => `${link.intent === 'closes' ? 'Closes' : 'Refs'} #${link.issue}`)
}

/**
 * Rewrite every closing keyword whose reference names a linked `refs` issue to
 * `refs`, keeping the separator and the reference as written. Each
 * keyword–reference pair stands alone: `Fixes #1, fixes #824` rewrites only
 * the second. Other repositories, unlinked numbers and `closes` issues are
 * untouched.
 */
export function neutralizeClosingReferences(
  text: string,
  links: readonly IssueLink[],
  options: IssueKeywordOptions = {},
): string {
  const refs = new Set(links.filter((link) => link.intent === 'refs').map((link) => link.issue))
  if (refs.size === 0) return text
  const pattern = new RegExp(
    String.raw`\b(${CLOSING})(${SEPARATOR})(${referenceSource(options.repository)})(?!\w)`,
    'gi',
  )
  return text.replace(pattern, (whole, keyword: string, separator: string, reference: string) => {
    if (!refs.has(referencedIssue(reference))) return whole
    const replacement = keyword[0] === keyword[0]!.toUpperCase() ? 'Refs' : 'refs'
    return `${replacement}${separator}${reference}`
  })
}

/** A line that is only a keyword and a reference to a linked issue. */
function isLinkedKeywordLine(line: string, linked: ReadonlySet<number>, source: RegExp): boolean {
  const match = source.exec(line)
  return match !== null && linked.has(referencedIssue(match[2]!))
}

/**
 * Neutralize, drop whole lines that only restate a linked issue, and append
 * the canonical keyword paragraph. With `trailers` (the default) a terminal
 * git trailer block stays last and the paragraph goes before it; a PR body
 * passes `trailers: false` so it ends with the lines. Idempotent.
 */
export function withIssueKeywords(
  text: string,
  links: readonly IssueLink[],
  options: IssueKeywordOptions & { trailers?: boolean; includesSubject?: boolean } = {},
): string {
  if (links.length === 0) return text
  const neutral = neutralizeClosingReferences(text, links, options)
  const { body, trailers } =
    options.trailers === false
      ? { body: neutral, trailers: '' }
      : splitTrailerBlock(neutral, { includesSubject: options.includesSubject === true })
  const linked = new Set(links.map((link) => link.issue))
  const line = new RegExp(
    String.raw`^[ \t]*(${CLOSING}|${MENTION})${SEPARATOR}(${referenceSource(options.repository)})[ \t]*\.?\r?$`,
    'i',
  )
  const keep = (part: string): string =>
    part
      .split('\n')
      .filter((entry) => !isLinkedKeywordLine(entry, linked, line))
      .join('\n')
      .replace(/\s+$/, '')
  const prose = keep(body)
  const tail = keep(trailers)
  const block = issueKeywordLines(links).join('\n')
  const composed = `${prose === '' ? '' : `${prose}\n\n`}${block}${tail === '' ? '' : `\n\n${tail}`}`
  return /\n$/.test(text) ? `${composed}\n` : composed
}

/** The landed commit message: keyword paragraph, then the build trailer
 * block. With no links this is exactly `withBuildTrailer`. */
export function landingMessage(
  message: string,
  slug: string,
  links: readonly IssueLink[],
  options: IssueKeywordOptions & { includesSubject?: boolean } = {},
): string {
  return withBuildTrailer(
    withIssueKeywords(message, links, options),
    slug,
    options.includesSubject === true ? { includesSubject: true } : {},
  )
}

/** A leaf's own keywords reach the default branch only when it is aimed at
 * the configured base, through a forge whose merges close issues. Nodes and
 * node-target leaves carry links upward instead (`kernel/node-issue-links`),
 * and only a root node's PR body emits their union. */
export function emitsIssueKeywords(
  state: {
    kind?: 'work' | 'node'
    target?: unknown
    issueLinks: readonly IssueLink[]
  },
  forge: Pick<Forge, 'closesIssues'>,
): boolean {
  return (
    forge.closesIssues === true &&
    state.kind !== 'node' &&
    state.target === undefined &&
    state.issueLinks.length > 0
  )
}

/** The `{issue, intent}` projection a forge receives, when it should. */
export function issueLinksForForge(
  state: Parameters<typeof emitsIssueKeywords>[0],
  forge: Pick<Forge, 'closesIssues'>,
): { issueLinks: IssueLink[] } | Record<string, never> {
  return emitsIssueKeywords(state, forge)
    ? { issueLinks: state.issueLinks.map(({ issue, intent }) => ({ issue, intent })) }
    : {}
}

/** Human form with downgrade provenance, e.g.
 * `closes #820, refs #824 (downgraded from closes: only the API half)`. */
export function describeIssueLinks(
  links: ReadonlyArray<IssueLink & { downgrade?: { reason: string } }>,
): string {
  return links
    .map(
      (link) =>
        `${link.intent} #${link.issue}${
          link.downgrade !== undefined ? ` (downgraded from closes: ${link.downgrade.reason})` : ''
        }`,
    )
    .join(', ')
}
