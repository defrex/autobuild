import type { WebFrame } from '../../../core/src/web/protocol'
import {
  AttentionLine,
  BuildRow,
  DispatcherStrip,
  EmptySentence,
  SectionHeading,
} from '../components/composites'
import { type FlowBlock, StableFlow } from '../components/motion'
import { finishedRowModel, harvestRowModel, liveRowModel } from './rows'
import { buildHref } from './routes'

const line = (key: string, text: string): FlowBlock => ({
  key,
  node: (
    <p data-app="line">
      <span>{text}</span>
    </p>
  ),
})

/** Before the frame carries an overview, and for notice-only failure frames:
 * the repository header's own terms. */
function summaryBlocks(frame: WebFrame): FlowBlock[] {
  const repository = frame.repository
  return [
    ...(frame.notice !== undefined
      ? [{ key: 'notice', node: <EmptySentence>{frame.notice}</EmptySentence> }]
      : []),
    ...(repository !== undefined
      ? [
          {
            key: 'summary',
            node: (
              <p data-app="line">
                <span>Queued </span>
                <span data-ansi="num">{repository.queued}</span>
                <span> · Triage </span>
                <span data-ansi="num">{repository.triage ?? '–'}</span>
              </p>
            ),
          },
        ]
      : []),
    ...(repository?.warningLines ?? []).map((text, index) => line(`warning:${index}`, text)),
  ]
}

/**
 * The overview as a flat list of keyed flow blocks: the dispatcher strip,
 * any notice, then Needs attention, Active, Queued and Recently finished, in
 * projection order. Keys are per fact, so a row that moves sections keeps its
 * identity and changes position.
 */
export function overviewBlocks({ frame, now }: { frame: WebFrame; now: number }): FlowBlock[] {
  const overview = frame.overview
  if (overview === undefined) return summaryBlocks(frame)
  const blocks: FlowBlock[] = [
    {
      key: 'strip',
      node: (
        <DispatcherStrip
          model={{
            mode: overview.dispatcher,
            counts: overview.header.counts,
            ...(overview.header.capacityNote !== undefined
              ? { capacityNote: overview.header.capacityNote }
              : {}),
            gates: overview.header.gates,
          }}
        />
      ),
    },
  ]
  if (frame.notice !== undefined)
    blocks.push({ key: 'notice', node: <EmptySentence>{frame.notice}</EmptySentence> })

  blocks.push({
    key: 'h:attention',
    node: <SectionHeading title="Needs attention" count={String(overview.attention.length)} />,
  })
  if (overview.attention.length === 0)
    blocks.push({
      key: 'empty:attention',
      node: <EmptySentence>Nothing needs a person right now.</EmptySentence>,
    })
  overview.attention.forEach((item, index) => {
    const identity = item.ticketId ?? item.slug
    blocks.push({
      key: `att:${item.kind}:${item.slug ?? index}`,
      node: (
        <AttentionLine
          tone={item.tone}
          {...(identity !== undefined ? { identity } : {})}
          {...(item.slug !== undefined ? { href: buildHref(item.slug) } : {})}
        >
          {item.text}
        </AttentionLine>
      ),
    })
  })

  blocks.push({ key: 'h:active', node: <SectionHeading title="Active" /> })
  if (overview.harvest !== undefined)
    blocks.push({
      key: 'harvest',
      node: <BuildRow build={harvestRowModel(overview.harvest, now)} />,
    })
  for (const row of overview.active)
    blocks.push({ key: `row:${row.slug}`, node: <BuildRow build={liveRowModel(row, now)} /> })
  if (overview.harvest === undefined && overview.active.length === 0)
    blocks.push({
      key: 'empty:active',
      node: <EmptySentence>No builds are running.</EmptySentence>,
    })

  blocks.push({ key: 'h:queued', node: <SectionHeading title="Queued" /> })
  for (const row of overview.queued)
    blocks.push({ key: `row:${row.slug}`, node: <BuildRow build={liveRowModel(row, now)} /> })
  if (overview.queued.length === 0)
    blocks.push({ key: 'empty:queued', node: <EmptySentence>No builds are queued.</EmptySentence> })

  blocks.push({ key: 'h:finished', node: <SectionHeading title="Recently finished" /> })
  for (const row of overview.finished)
    blocks.push({ key: `fin:${row.slug}`, node: <BuildRow build={finishedRowModel(row)} /> })
  if (overview.finished.length === 0)
    blocks.push({
      key: 'empty:finished',
      node: <EmptySentence>No build has finished yet.</EmptySentence>,
    })
  return blocks
}

export interface PageProps {
  frame: WebFrame
  now: number
  seq: number
  onSettled?: (seq: number) => void
}

export function OverviewPage({ frame, now, seq, onSettled }: PageProps) {
  return (
    <StableFlow
      blocks={overviewBlocks({ frame, now })}
      seq={seq}
      {...(onSettled !== undefined ? { onSettled } : {})}
    />
  )
}
