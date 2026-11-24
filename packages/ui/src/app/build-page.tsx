import type { WebBuildRow, WebFinishedRow, WebFrame } from '../../../core/src/web/protocol'
import {
  AttentionLine,
  BuildRow,
  EmptySentence,
  FactList,
  SectionHeading,
} from '../components/composites'
import { WordAction } from '../components/controls'
import { SignOff, StateWord } from '../components/display'
import { type FlowBlock, StableFlow } from '../components/motion'
import type { PageProps } from './overview'
import { completedText, finishedRowModel, liveRowModel } from './rows'

type Found = { kind: 'live'; row: WebBuildRow } | { kind: 'finished'; row: WebFinishedRow }

function find(frame: WebFrame, slug: string): Found | undefined {
  const overview = frame.overview
  if (overview === undefined) return undefined
  const live =
    overview.active.find((row) => row.slug === slug) ??
    overview.queued.find((row) => row.slug === slug)
  if (live !== undefined) return { kind: 'live', row: live }
  const finished = overview.finished.find((row) => row.slug === slug)
  return finished !== undefined ? { kind: 'finished', row: finished } : undefined
}

function liveBlocks(row: WebBuildRow, now: number): FlowBlock[] {
  const { href: _href, attention: _attention, ...header } = liveRowModel(row, now)
  const blocks: FlowBlock[] = [{ key: 'header', node: <BuildRow build={header} /> }]
  row.attention.forEach((item, index) => {
    const key = `att:${index}`
    if (item.kind === 'escalation')
      blocks.push({
        key,
        node: (
          <SignOff kind="escalation" question={item.text}>
            <p>
              <span>
                The build stopped to ask. A human answer resumes it from where it stopped; answer
                with{' '}
              </span>
              <code>ab answer {row.slug}</code>
              <span>.</span>
            </p>
          </SignOff>
        ),
      })
    else if (item.kind === 'wait')
      blocks.push({ key, node: <SignOff kind="wait" question={item.text} /> })
    else
      blocks.push({
        key,
        node: <AttentionLine tone={item.tone}>{item.text}</AttentionLine>,
      })
  })
  blocks.push(
    { key: 'h:build', node: <SectionHeading title="Build" /> },
    {
      key: 'facts:build',
      node: (
        <FactList
          facts={[
            {
              term: 'status',
              value: <StateWord tone={row.status.tone}>{row.status.word}</StateWord>,
            },
            { term: 'phase', value: row.phase ?? '–', mono: true },
            { term: 'kind', value: row.kind, mono: true },
            ...(row.target !== undefined
              ? [
                  {
                    term: 'target',
                    value: `${row.target.destination} ${row.target.distance}`,
                    mono: true,
                  },
                ]
              : []),
            ...(row.merge !== undefined ? [{ term: 'merge', value: row.merge.text }] : []),
            ...(row.pr !== undefined
              ? [{ term: 'PR', value: <a href={row.pr.url}>{row.pr.text}</a> }]
              : []),
            ...(row.ceiling !== undefined ? [{ term: 'ceiling', value: row.ceiling }] : []),
          ]}
        />
      ),
    },
    { key: 'h:ticket', node: <SectionHeading title="Ticket" /> },
  )
  if (row.ticketId === undefined)
    blocks.push({
      key: 'empty:ticket',
      node: <EmptySentence>This build has no ticket.</EmptySentence>,
    })
  else
    blocks.push({
      key: 'facts:ticket',
      node: (
        <FactList
          facts={[
            {
              term: 'id',
              value:
                row.ticketUrl !== undefined ? (
                  <a data-ansi="ticket-id" href={row.ticketUrl}>
                    {row.ticketId}
                  </a>
                ) : (
                  <span data-ansi="ticket-id">{row.ticketId}</span>
                ),
            },
            ...(row.title !== undefined ? [{ term: 'title', value: row.title }] : []),
          ]}
        />
      ),
    })
  return blocks
}

function finishedBlocks(row: WebFinishedRow): FlowBlock[] {
  const { href: _href, ...header } = finishedRowModel(row)
  return [
    { key: 'header', node: <BuildRow build={header} /> },
    { key: 'h:build', node: <SectionHeading title="Build" /> },
    {
      key: 'facts:build',
      node: (
        <FactList
          facts={[
            { term: 'outcome', value: <StateWord tone={row.tone}>{row.word}</StateWord> },
            { term: 'kind', value: row.kind, mono: true },
            {
              term: 'completed',
              value: <time dateTime={row.completedAt}>{completedText(row.completedAt)}</time>,
              mono: true,
            },
          ]}
        />
      ),
    },
    { key: 'h:ticket', node: <SectionHeading title="Ticket" /> },
    {
      key: 'empty:ticket',
      node: <EmptySentence>The roster does not record finished builds' tickets.</EmptySentence>,
    },
  ]
}

/**
 * One build's page: its header row, its attention as sign-off regions, its
 * facts and its ticket. The build is found among the frame's active, queued
 * and recently finished rows, which are exactly the rows that link here.
 */
export function buildPageBlocks({
  frame,
  slug,
  now,
}: {
  frame: WebFrame
  slug: string
  now: number
}): FlowBlock[] {
  const found = find(frame, slug)
  if (found === undefined)
    return [
      {
        key: 'missing',
        node: (
          <p data-app="line">
            <span>This build is not active, queued or among the recently finished builds. </span>
            <WordAction href="/">Back to the Overview</WordAction>
          </p>
        ),
      },
    ]
  return found.kind === 'live' ? liveBlocks(found.row, now) : finishedBlocks(found.row)
}

export function BuildPage({ frame, slug, now, seq, onSettled }: PageProps & { slug: string }) {
  return (
    <StableFlow
      blocks={buildPageBlocks({ frame, slug, now })}
      seq={seq}
      {...(onSettled !== undefined ? { onSettled } : {})}
    />
  )
}
