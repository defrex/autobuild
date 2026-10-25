import type { Config } from '../../config/schema'
import type { BuildState } from '../../kernel/reducer'
import type { LeafRestackState } from '../../kernel/leaf-restack-state'
import {
  integrationComplete,
  integrationCurrent,
  integrationCycleVerified,
} from '../../kernel/integration-state'
import { landingReady } from '../../kernel/landing-readiness'
import type { BuildRecord } from '../../store/types'
import type { DashboardBuild, PipelineStep } from './model'
import { nodeLandingPolicyDisplay } from './landing-display'

/** Repair prompts share the engine's settled-stage barrier and exact cycle evidence. */
export function integrationRepairSteps(state: BuildState): string[] {
  const cycle = state.integration?.cycle
  if (!cycle || !integrationCurrent(state)) return []
  const pinned = JSON.parse(cycle.config).verify
  if (Array.isArray(pinned.stages)) {
    const receipt = state.verifyStage.failures.find(
      (failure) =>
        failure.cycle === cycle.seq &&
        failure.restackId === cycle.id &&
        failure.headSha === cycle.head &&
        failure.baseSha === cycle.parent,
    )
    return receipt?.failed.map((failure) => failure.step) ?? []
  }
  const first = state.verify.results.find(
    (result) =>
      result.seq > cycle.seq &&
      result.restackId === cycle.id &&
      result.headSha === cycle.head &&
      result.baseSha === cycle.parent &&
      result.outcome === 'fail',
  )
  return first ? [first.step] : []
}

/** Shared list progress and five integration steps. */
export interface IntegrationRow {
  parentDistance?: string
  destination: string
  children:
    | { known: false }
    | { known: true; landed: number; building: number; queued: number; total: number }
  verified: boolean
  steps: PipelineStep[]
  alert?: { tone: 'red' | 'yellow'; text: string }
  openChildren: string[]
}

export function projectIntegrationRow(
  record: BuildRecord,
  state: BuildState,
  restack: LeafRestackState,
  config: Config,
): IntegrationRow | undefined {
  if (state.kind !== 'node') return undefined
  const destination = state.target
    ? `${state.target.ticket.id} ${state.target.build}`
    : (state.baseBranch ?? 'unknown destination')
  const observation = state.integration?.observation
  const openChildren = [...new Set(observation?.openChildren ?? [])]
  const landed = new Set(observation?.contributions ?? []).size
  const known = !!observation && observation.diagnostics.length === 0
  const complete = integrationComplete(state)
  const current = integrationCurrent(state)
  const verified = current && integrationCycleVerified(state)
  const cycle = state.integration?.cycle
  const selected: string[] = cycle ? JSON.parse(cycle.config).verify.steps : []
  const expected = [...new Set(selected)]
  const receipts =
    current && cycle
      ? state.verify.results.filter(
          (r) =>
            r.seq > cycle.seq &&
            r.restackId === cycle.id &&
            r.headSha === cycle.head &&
            r.baseSha === cycle.parent &&
            expected.includes(r.step),
        )
      : []
  const failed = integrationRepairSteps(state)
  const passed = new Set(
    receipts.filter((r) => r.outcome === 'pass' || r.outcome === 'skipped').map((r) => r.step),
  ).size
  const ready = landingReady(state, restack)
  const mode = nodeLandingPolicyDisplay(state, config.landing)
  const step = (
    label: string,
    done: boolean,
    active: boolean,
    qualifier?: PipelineStep['qualifier'],
  ): PipelineStep => ({
    label,
    state: done ? 'done' : active ? 'current' : 'pending',
    ...(qualifier ? { qualifier } : {}),
  })
  const conflicted = state.nodeRestack?.conflict || (restack.active && restack.replay?.conflicted)
  const alert: IntegrationRow['alert'] = state.janitor?.attention
    ? { tone: 'red', text: `Janitor failing: ${state.janitor.message}` }
    : conflicted
      ? {
          tone: 'red',
          text: `restack onto ${destination} conflicted — open the detail view for files`,
        }
      : failed.length
        ? {
            tone: 'red',
            text: `${failed.join(', ')} failed — file a repair child targeting ${record.ticket?.id ?? record.slug}`,
          }
        : ready && mode === 'consent' && state.landing?.command?.kind !== 'land'
          ? {
              tone: 'yellow',
              text: `ready to merge into ${destination} — press l, or ab merge ${record.slug}`,
            }
          : undefined
  return {
    destination,
    parentDistance: nodeParentDistance(state),
    openChildren,
    children: known
      ? {
          known: true,
          landed,
          building: 0,
          queued: openChildren.length,
          total: landed + openChildren.length,
        }
      : { known: false },
    verified,
    steps: [
      step('spec', state.specRev !== undefined, false),
      step('open', !!state.nodeOpened, !state.nodeOpened),
      step('collect', complete, !!state.nodeOpened && !complete),
      step(
        'verify',
        verified,
        current && !verified,
        failed.length
          ? 'failed'
          : current && !verified
            ? `${passed}/${expected.length}`
            : undefined,
      ),
      step('merge', !!state.integration?.landing, ready, mode),
    ],
    ...(alert ? { alert } : {}),
  }
}

/** Recomputed from the whole already-read repository, even on an empty parent delta.
 * Never mutate cached rows or snapshots; leaf identity is preserved. */
export function enrichIntegrationRows(
  rows: readonly DashboardBuild[],
  records: readonly BuildRecord[] = [],
): DashboardBuild[] {
  return rows.map((row) => {
    const list = row.integrationRow
    const identity = row.collectionIdentity
    if (!list || !identity) return row
    const live = (id: string, source: string, claims?: string[]) =>
      rows
        .filter((child) => {
          const match = child.collectionIdentity
          return (
            match &&
            match.repo === identity.repo &&
            match.targetBuild === row.slug &&
            (claims?.includes(child.slug) ||
              (match.targetSource === identity.source &&
                match.targetId === identity.id &&
                (match.id ? match.source === source && match.id === id : child.slug === id))) &&
            match.status !== 'queued' &&
            match.status !== 'done' &&
            match.status !== 'aborted'
          )
        })
        .sort(
          (a, b) =>
            (b.collectionIdentity?.createdAt ?? '').localeCompare(
              a.collectionIdentity?.createdAt ?? '',
            ) || b.slug.localeCompare(a.slug),
        )[0]
    const detail = row.integrationDetail
    const building = list.openChildren.filter((id) => {
      const child = detail?.children.find((entry) => entry.id === id && !entry.landed)
      return live(id, child?.source ?? identity.source ?? '', child?.claims)
    }).length
    const projected = detail?.children.map((child) => {
      const active = child.landed ? undefined : live(child.id, child.source, child.claims)
      const historical = child.builds?.length
        ? records.find((r) => r.repo === identity.repo && child.builds?.includes(r.slug))
        : undefined
      return {
        ...child,
        id: child.id === historical?.slug ? (historical.ticket?.id ?? child.id) : child.id,
        source:
          child.id === historical?.slug
            ? (historical.ticket?.source ?? child.source)
            : child.source,
        title:
          child.title === 'title unavailable'
            ? (active?.collectionIdentity?.title ?? historical?.ticket?.title ?? child.title)
            : child.title,
        state: child.landed ? 'merged' : (active?.collectionIdentity?.phase ?? 'queued'),
      }
    })
    // Historical contribution records can resolve several build slugs to the
    // same ticket, including a reopened ticket that is also currently open.
    const byTicket = new Map<string, import('./integration-detail').IntegrationChild>()
    for (const child of projected ?? []) {
      const key = JSON.stringify([child.source, child.id])
      const previous = byTicket.get(key)
      const preferred = previous && !previous.landed ? previous : child
      byTicket.set(
        key,
        previous
          ? {
              ...preferred,
              title:
                preferred.title === 'title unavailable'
                  ? previous.title === 'title unavailable'
                    ? child.title
                    : previous.title
                  : preferred.title,
              builds: [...new Set([...(previous.builds ?? []), ...(child.builds ?? [])])].sort(),
            }
          : child,
      )
    }
    const children = detail
      ? [...byTicket.values()].sort(
          (a, b) =>
            Number(a.landed) - Number(b.landed) ||
            a.source.localeCompare(b.source) ||
            a.id.localeCompare(b.id),
        )
      : undefined
    const changed = children && JSON.stringify(children) !== JSON.stringify(detail?.children)
    if ((!list.children.known || list.children.building === building) && !changed) return row
    return {
      ...row,
      integrationRow: list.children.known
        ? {
            ...list,
            children: { ...list.children, building, queued: list.openChildren.length - building },
          }
        : list,
      ...(detail && children ? { integrationDetail: { ...detail, children } } : {}),
    }
  })
}

/** Largest-remainder allocation keeps the track exactly 22 terminal cells. */
export function integrationBarCells(landed: number, building: number, queued: number): number[] {
  const total = landed + building + queued
  if (!total) return [0, 0, 22]
  const raw = [landed, building, queued].map((n) => (n * 22) / total)
  const cells = raw.map(Math.floor)
  const remaining = 22 - cells.reduce((a, b) => a + b, 0)
  const order = raw
    .map((n, i) => ({ i, remainder: n - cells[i]! }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i)
  for (const part of order.slice(0, remaining)) cells[part.i]! += 1
  return cells
}

export function nodeParentDistance(state: BuildState): string {
  const node = state.nodeRestack
  const distance = node?.distance
  const count =
    distance &&
    distance.base === node?.contributionBase &&
    distance.branch === state.baseBranch &&
    distance.parent === (node?.observedParent?.sha ?? state.nodeComparison?.parentSha)
      ? distance.count
      : null
  return count === null
    ? 'parent distance unknown'
    : count === 0
      ? 'parent current'
      : `parent ${count} commit${count === 1 ? '' : 's'} ahead`
}
