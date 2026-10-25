import { projectHandPushed, type HandPushedChange } from './hand-pushed'
import type { Config } from '../../config/schema'
import type { BuildRecord } from '../../store/types'
import type { BuildState } from '../../kernel/reducer'
import type { LeafRestackState } from '../../kernel/leaf-restack-state'
import {
  integrationComplete,
  integrationCurrent,
  integrationCycleVerified,
} from '../../kernel/integration-state'
import { landingReady } from '../../kernel/landing-readiness'
import { projectIntegrationRow, integrationRepairSteps } from './integration-row'
import { nodeLandingPolicyDisplay, nodeLandingRuleDisplay } from './landing-display'

export interface IntegrationChild {
  source: string
  id: string
  title: string
  builds?: string[]
  claims?: string[]
  state: string
  landed: boolean
}
export interface IntegrationDetail {
  handPushedCommits?: HandPushedChange[]
  parentDistance?: string
  destination: string
  branch: string
  restack: string
  conflictFiles?: string[]
  children: IntegrationChild[]
  membershipKnown: boolean
  diagnostics: string[]
  verification: string
  verifySteps: { step: string; outcome: string }[]
  landing: string
}

export function projectIntegrationDetail(
  record: BuildRecord,
  state: BuildState,
  restack: LeafRestackState,
  config: Config,
  pipeline: Config,
): IntegrationDetail | undefined {
  const row = projectIntegrationRow(record, state, restack, config)
  if (!row) return undefined
  const observation = state.integration?.observation
  const membershipSource = observation?.membershipSource ?? record.ticket?.source
  const open = new Set(observation?.openChildren ?? [])
  const contributions = new Set(observation?.contributions ?? [])
  const children: IntegrationChild[] = (observation?.children ?? [])
    .filter(
      (c) =>
        observation!.diagnostics.length ||
        (c.source === membershipSource && open.has(c.id)) ||
        c.builds?.some((b) => contributions.has(b)),
    )
    .map((c) => ({
      ...c,
      title: c.title ?? 'title unavailable',
      landed:
        !!c.builds?.some((b) => contributions.has(b)) &&
        !(c.source === membershipSource && open.has(c.id)),
      state:
        c.builds?.some((b) => contributions.has(b)) &&
        !(c.source === membershipSource && open.has(c.id))
          ? 'merged'
          : 'queued',
    }))
  for (const id of open)
    if (!children.some((c) => c.id === id && c.source === membershipSource))
      children.push({
        source: membershipSource ?? '',
        id,
        title: 'title unavailable',
        state: 'queued',
        landed: false,
      })
  for (const contribution of contributions)
    if (!children.some((c) => c.builds?.includes(contribution)))
      children.push({
        source: membershipSource ?? '',
        id: contribution,
        builds: [contribution],
        title: 'title unavailable',
        state: 'merged',
        landed: true,
      })
  children.sort(
    (a, b) =>
      Number(a.landed) - Number(b.landed) ||
      a.source.localeCompare(b.source) ||
      a.id.localeCompare(b.id),
  )
  const cycle = state.integration?.cycle
  const current = integrationCurrent(state)
  const expected: string[] = cycle ? JSON.parse(cycle.config).verify.steps : pipeline.verify.steps
  const results =
    current && cycle
      ? state.verify.results.filter(
          (r) =>
            r.seq > cycle.seq &&
            r.restackId === cycle.id &&
            r.headSha === cycle.head &&
            r.baseSha === cycle.parent,
        )
      : []
  const verifySteps = [...new Set(expected)].map((step) => ({
    step,
    outcome:
      results.find((r) => r.step === step && r.outcome === 'fail')?.outcome ??
      results.findLast((r) => r.step === step)?.outcome ??
      'pending',
  }))
  const failed = integrationRepairSteps(state)
  const conflict =
    state.nodeRestack?.conflict ??
    (restack.active && restack.replay?.conflicted ? restack.replay : undefined)
  const mode = nodeLandingPolicyDisplay(state, config.landing)
  return {
    handPushedCommits: projectHandPushed(state.nodeRestack),
    parentDistance: row.parentDistance,
    destination: `${row.destination}${state.target ? '' : ' (the configured base branch)'}`,
    branch: record.branch ?? state.nodeOpening?.branch ?? 'unknown branch',
    restack: conflict
      ? 'conflicted'
      : state.nodeRestack?.active || restack.active
        ? 'active'
        : 'idle',
    ...(conflict
      ? { conflictFiles: conflict.files ?? ['conflicting filenames were not recorded'] }
      : {}),
    children,
    membershipKnown: !!observation && !observation.diagnostics.length,
    diagnostics: observation?.diagnostics ?? ['child membership unknown'],
    verification: failed.length
      ? `${failed.join(', ')} failed — file a repair child targeting ${record.ticket?.id ?? record.slug}`
      : !integrationComplete(state)
        ? `pending — runs on the node head against ${row.destination} once every child has merged`
        : current && integrationCycleVerified(state)
          ? 'verified on the current node head and destination'
          : 'pending on the current node head and destination',
    verifySteps,
    landing: `${mode} — ${nodeLandingRuleDisplay(state, config.landing)}${landingReady(state, restack) && mode === 'consent' && state.landing?.command?.kind !== 'land' ? ` — press l, or ab merge ${record.slug}` : ''}`,
  }
}
