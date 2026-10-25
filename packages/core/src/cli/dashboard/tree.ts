import type { BuildRecord } from '../../store/types'
import type { BuildState } from '../../kernel/reducer'
import type { LeafRestackState } from '../../kernel/leaf-restack-state'
import {
  integrationComplete,
  integrationCurrent,
  integrationCycleVerified,
} from '../../kernel/integration-state'
import { mergeVocabulary } from './landing-display'
import { awaitsConsent, landingReady } from '../../kernel/landing-readiness'

export const treeVocabulary = {
  root: 'root',
  node: 'node',
  target: 'target',
  integration: 'integration build',
  landing: mergeVocabulary.label,
  restack: 'restack',
  consent: 'consent',
  queue: 'queue',
  work: 'work',
  integrationKind: 'integration',
  branch: 'branch',
  children: 'children',
  verify: 'verify',
  verification: 'verification',
  current: 'current',
  pending: 'pending',
  readyToLand: 'ready to merge',
  notReady: 'not ready',
} as const

/** Frozen effective ancestry shared by queue entries and readiness observations. */
export function effectiveTreeTarget(state: Pick<BuildState, 'target' | 'baseBranch'>) {
  return {
    kind: state.target ? ('node' as const) : ('root' as const),
    branch: state.baseBranch,
    ...(state.target ? { ticket: state.target.ticket, build: state.target.build } : {}),
  }
}

export function projectTree(
  record: BuildRecord,
  state: BuildState,
  restack: LeafRestackState,
  expectedSteps?: readonly string[],
) {
  const cycle = state.integration?.cycle
  const candidate = state.landing?.decision?.candidate
  const receipts = state.verify.results.filter((result) =>
    state.kind === 'node'
      ? !!cycle &&
        result.restackId === cycle.id &&
        result.headSha === cycle.head &&
        result.baseSha === cycle.parent
      : result.seq > state.verify.cycleSince,
  )
  const observation = state.integration?.observation
  return {
    kind: state.kind === 'node' ? ('node' as const) : ('work' as const),
    target: effectiveTreeTarget(state),
    branch: record.branch ?? state.nodeOpening?.branch,
    candidate,
    restack:
      state.nodeRestack?.conflict || (restack.active && restack.replay?.conflicted)
        ? ('conflicted' as const)
        : state.nodeRestack?.active || restack.active
          ? ('active' as const)
          : ('idle' as const),
    verification: {
      head: cycle?.head ?? candidate?.head,
      parent: cycle?.parent ?? candidate?.parent,
      current:
        state.kind === 'node'
          ? integrationCurrent(state) && integrationCycleVerified(state)
          : landingReady(state, restack),
      results: receipts,
      ...(expectedSteps ? { expectedSteps: [...expectedSteps] } : {}),
    },
    ...(state.kind === 'node'
      ? {
          children: observation?.openChildren,
          diagnostics: observation?.diagnostics,
          completeness: !observation
            ? ('unknown' as const)
            : integrationComplete(state)
              ? ('complete' as const)
              : ('incomplete' as const),
        }
      : {}),
    ready: landingReady(state, restack),
    consent: awaitsConsent(state, restack),
    reason: awaitsConsent(state, restack)
      ? state.landing?.command?.kind === 'hold'
        ? ('held' as const)
        : ('consent required' as const)
      : undefined,
  }
}
export type TreeProjection = ReturnType<typeof projectTree>
export type ConsentQueueEntry = TreeProjection & { slug: string }
export function consentQueue(
  builds: readonly { slug: string; tree?: TreeProjection }[],
): ConsentQueueEntry[] {
  return builds
    .flatMap((build) => (build.tree?.consent ? [{ slug: build.slug, ...build.tree }] : []))
    .sort((a, b) => a.slug.localeCompare(b.slug))
}
