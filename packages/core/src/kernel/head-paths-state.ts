/** Pure half of the head path facts (`kernel/head-paths.ts`): the folded
 * summary shape, the reducer step and the selectors. No IO, so the build
 * reducer can import it. */
import type { EventPayload } from '../events/payloads'
import { HEAD_PATHS_RECORDS } from '../events/head-paths-limits'
import type { BuildState } from './reducer'

export type HeadPathsPayload = EventPayload<'head.paths-recorded'>
export type HeadPathsSource = HeadPathsPayload['source']
/** One folded fact: the event's bounded summary plus its seq. */
export type HeadPathsSummary = HeadPathsPayload & { seq: number }

export type HeadPathsAnswer = { recorded: false } | { recorded: true; record: HeadPathsSummary }

// ── Selectors (pure, no IO) ──────────────────────────────────────────────────

/** The head a landing decision would judge: a node's integration-cycle head,
 * a leaf's PR head. */
export function candidateHead(
  state: Pick<BuildState, 'kind' | 'integration' | 'pr'>,
): string | undefined {
  return state.kind === 'node' ? state.integration?.cycle?.head : state.pr?.headSha
}

/** "Not recorded" is distinct from "recorded and empty". */
export function headPathsFor(
  state: Pick<BuildState, 'headPaths'>,
  head: string | undefined,
): HeadPathsAnswer {
  const record = head === undefined ? undefined : state.headPaths?.find((r) => r.head === head)
  return record === undefined ? { recorded: false } : { recorded: true, record }
}

export function candidateHeadPaths(
  state: Pick<BuildState, 'kind' | 'integration' | 'pr' | 'headPaths'>,
): HeadPathsAnswer {
  return headPathsFor(state, candidateHead(state))
}

/** Reducer step: the first summary per head wins (retries and races record
 * the same head again), and only the newest `HEAD_PATHS_RECORDS` are kept. */
export function foldHeadPaths(
  current: readonly HeadPathsSummary[] | undefined,
  payload: HeadPathsPayload,
  seq: number,
): HeadPathsSummary[] | undefined {
  if (current?.some((record) => record.head === payload.head)) return current as HeadPathsSummary[]
  const { source, head, destination, mergeBase, total, preview, resolution, artifact } = payload
  const record: HeadPathsSummary = {
    source,
    head,
    destination,
    mergeBase,
    total,
    preview: [...preview],
    ...(resolution === undefined
      ? {}
      : { resolution: { total: resolution.total, preview: [...resolution.preview] } }),
    artifact: { kind: artifact.kind, rev: artifact.rev },
    seq,
  }
  return [...(current ?? []), record].slice(-HEAD_PATHS_RECORDS)
}
