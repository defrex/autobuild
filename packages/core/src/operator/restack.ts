import { randomUUID } from 'node:crypto'
import { humanActor, type Via } from '../events/envelope'
import { readBuildFacts } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'
import { requireRouteBuild, RouteRefusalError } from './requests'

/** Request only: ordinary dispatcher safety gates own execution. */
export async function requestNodeRestack(input: {
  store: BuildStore
  repo: string
  slug: string
  user: string
  via?: Via
}) {
  const { store, repo, slug } = input
  await requireRouteBuild(store, repo, slug)
  for (;;) {
    const state = (await readBuildFacts(store, slug)).value.state
    const refuse = (error: string): never => {
      throw new RouteRefusalError({ kind: 'conflict', error })
    }
    if (state.kind !== 'node') refuse(`build "${slug}" is not a node; leaves restack automatically`)
    if (
      state.status === 'done' ||
      state.status === 'aborted' ||
      state.prState === 'merged' ||
      state.prState === 'closed'
    )
      refuse(`node "${slug}" is terminal; restack requires an open node`)
    if (!state.nodeOpened || !state.baseBranch) refuse(`node "${slug}" has no open branch yet`)
    const branch = state.baseBranch!
    const parent =
      state.nodeRestack?.observedParent?.sha ??
      state.nodeComparison?.parentSha ??
      state.nodeRestack?.contributionBase ??
      state.nodeOpened!.sha
    const existing = Object.values(state.nodeRestack?.requests ?? {}).find(
      (request) =>
        request.reason === 'operator' && request.branch === branch && request.parent === parent,
    )
    const waiting = state.status === 'paused' || state.status === 'blocked'
    if (existing) return { slug, request: existing, coalesced: true, waiting }
    const request = { id: randomUUID(), reason: 'operator' as const, branch, parent }
    const event = await store.appendIfCurrent(slug, state.lastSeq, {
      actor: humanActor(input.user, input.via),
      type: 'node.restack-requested',
      payload: request,
    })
    if (event) return { slug, request, coalesced: false, waiting }
  }
}
