import { z } from 'zod'
import { expandIssues, type IssueSink } from '../../zod-issues'
import type { IssueLink, IssueLinkIntent, TicketSource } from '../types'

export type { IssueLink, IssueLinkIntent } from '../types'

/** Input form: intent is optional and defaults to `closes` in `normalizeIssueLinks`. */
export interface IssueLinkInput {
  issue: number
  intent?: IssueLinkIntent
}

export const issueLinkInputSchema = z.strictObject({
  issue: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  intent: z.enum(['closes', 'refs']).optional(),
})

export function refineUniqueIssues(links: ReadonlyArray<{ issue: number }>, ctx: IssueSink): void {
  const seen = new Set<number>()
  for (const link of links) {
    if (seen.has(link.issue))
      ctx.addIssue({ code: 'custom', message: `duplicate issue #${link.issue}` })
    seen.add(link.issue)
  }
}

export const issueLinksInputSchema = z.array(issueLinkInputSchema).superRefine(refineUniqueIssues)

/** Validate, default intent to `closes`, and sort ascending by issue number. */
export function normalizeIssueLinks(input: ReadonlyArray<IssueLinkInput>): IssueLink[] {
  const result = issueLinksInputSchema.safeParse(input)
  if (!result.success)
    throw new Error(
      `invalid issue links — ${expandIssues(result.error.issues)
        .map((issue) => {
          const path = issue.path.join('.')
          return path === '' ? issue.message : `${path}: ${issue.message}`
        })
        .join('; ')}`,
    )
  return result.data
    .map((link) => ({ issue: link.issue, intent: link.intent ?? 'closes' }))
    .sort((a, b) => a.issue - b.issue)
}

/** Parse a CLI comma list such as `824,820:refs`; an empty value yields `[]`. */
export function parseIssueLinkList(value: string, flag = '--issues'): IssueLink[] {
  const links: IssueLinkInput[] = []
  for (const item of value.split(',').map((part) => part.trim())) {
    if (!item) continue
    const match = /^#?(\d+)(?::(closes|refs))?$/.exec(item)
    if (!match)
      throw new Error(`${flag}: invalid issue link "${item}" — expected N, N:closes or N:refs`)
    links.push({
      issue: Number(match[1]),
      ...(match[2] !== undefined ? { intent: match[2] as IssueLinkIntent } : {}),
    })
  }
  try {
    return normalizeIssueLinks(links)
  } catch (error) {
    throw new Error(`${flag}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Human form, e.g. `closes #824, refs #820`. */
export function formatIssueLinks(links: ReadonlyArray<IssueLink>): string {
  return links.map((link) => `${link.intent} #${link.issue}`).join(', ')
}

/** A write naming issue links reached a source that cannot store them. */
export class TicketIssueLinksUnsupported extends Error {
  constructor(readonly source: string) {
    super(`${source} ticket source cannot store issue links; nothing was written`)
    this.name = 'TicketIssueLinksUnsupported'
  }
}

/** Refuse before any write: a present `issueLinks` (including `[]`) needs the capability. */
export function refuseUnsupportedIssueLinks(
  source: Pick<TicketSource, 'name' | 'issueLinks'>,
  patch: { issueLinks?: unknown },
): void {
  if (patch.issueLinks !== undefined && !source.issueLinks)
    throw new TicketIssueLinksUnsupported(source.name)
}
