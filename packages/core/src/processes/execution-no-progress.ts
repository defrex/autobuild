import type { AbEvent } from '../events/catalog'
import { DISPATCHER } from '../events/envelope'
import type { EventType } from '../events/payloads'
import type { IdSource } from '../ids'
import type { Config } from '../config/schema'
import { type Decision, decideNextFromFacts } from '../kernel/engine'
import { defineReducer } from '../kernel/incremental'
import type { RepoViewStore } from './repo-view'

/** Every new event must explicitly choose whether it advances build work. */
export const executionProgress = {
  'execution.relaunch-requested': 'bookkeeping',
  'execution.drain-authorized': 'bookkeeping',
  'execution.drain-settled': 'bookkeeping',
  'build.compatibility-deferred': 'bookkeeping',
  'build.janitor-attempt-failed': 'bookkeeping',
  'build.janitor-failing': 'bookkeeping',
  'build.janitor-recovered': 'bookkeeping',
  'landing.application-failed': 'failure',
  'landing.decided': 'progress',
  'build.hold-requested': 'progress',
  'build.land-requested': 'progress',
  'landing.command-acknowledged': 'progress',
  'landing.native-enable-started': 'bookkeeping',
  'landing.forge-merged': 'progress',
  'landing.native-applied': 'bookkeeping',
  'target.distance': 'bookkeeping',
  'target.rewritten': 'bookkeeping',
  'target.rewrite-cleared': 'bookkeeping',
  'target.moved': 'bookkeeping',
  'restack.prepared': 'progress',
  'restack.replayed': 'progress',
  'restack.publish-intended': 'progress',
  'restack.rewritten': 'progress',
  'restack.contended': 'progress',
  'restack.completed': 'progress',
  'build.created': 'progress',
  'integration.abandoned': 'progress',
  'integration.observed': 'bookkeeping',
  'integration.prepared': 'progress',
  'integration.landing-intended': 'progress',
  'integration.landed': 'progress',
  'integration.verification-failed': 'bookkeeping',
  'integration.audited': 'progress',
  'node.opening': 'progress',
  'node.writer-reserved': 'progress',
  'node.item-prepared': 'progress',
  'node.item-replayed': 'progress',
  'node.item-conflicted': 'progress',
  'node.publish-intended': 'progress',
  'node.rewritten': 'progress',
  'node.writer-settled': 'progress',
  'node.contribution-recorded': 'bookkeeping',
  'node.inventory': 'bookkeeping',
  'node.restack-requested': 'bookkeeping',
  'node.restack-satisfied': 'progress',
  'node.restack-availability-observed': 'bookkeeping',
  'node.parent-distance': 'bookkeeping',
  'node.parent-requested': 'bookkeeping',
  'node.parent-accepted': 'progress',
  'node.parent-pr-retargeted': 'progress',
  'node.parent-completed': 'progress',
  'node.parent-cancelled': 'bookkeeping',
  'node.parent-rejection-cleared': 'bookkeeping',
  'node.parent-rejected': 'bookkeeping',
  'node.opened': 'progress',
  'node.poll-checked': 'bookkeeping',
  'node.compared': 'bookkeeping',
  'pr.opened': 'progress',
  'build.completed': 'progress',
  'runner.runtime-recorded': 'bookkeeping',
  'runner.attached': 'bookkeeping',
  'runner.setup-failed': 'failure',
  'workspace.provisioned': 'bookkeeping',
  'workspace.provision-started': 'bookkeeping',
  'workspace.cleanup-required': 'bookkeeping',
  'workspace.fenced': 'bookkeeping',
  'workspace.commits-preserved': 'bookkeeping',
  'workspace.commits-lost': 'bookkeeping',
  'workspace.released': 'bookkeeping',
  'execution.started': 'bookkeeping',
  'execution.ended': 'bookkeeping',
  'infrastructure.failed': 'failure',
  'infrastructure.cleanup-attempted': 'bookkeeping',
  'pr-summary.requested': 'progress',
  'pr-summary.attempted': 'progress',
  'pr-summary.result': 'progress',
  'pr-summary.settled': 'progress',
  'finalize.step-started': 'progress',
  'publication.requested': 'progress',
  'publication.candidate-retired': 'progress',
  'publication.lost': 'progress',
  'publication.retry-scheduled': 'failure',
  'publication.retry-exhausted': 'failure',
  'abort.remote-branch-deleted': 'progress',
  'abort.local-branch-deleted': 'progress',
  'abort.ticket-returned': 'progress',
  'dispatch.failed': 'failure',
  'dispatch.comment-posted': 'bookkeeping',
  'build.pause-requested': 'progress',
  'build.resume-requested': 'progress',
  'build.abort-requested': 'progress',
  'build.discard-requested': 'progress',
  'build.auto-merge-requested': 'progress',
  'build.auto-merge-cancelled': 'progress',
  'build.auto-merge-default-observed': 'bookkeeping',
  'build.paused': 'progress',
  'build.resumed': 'progress',
  'build.aborted': 'progress',
  'spec.imported': 'progress',
  'spec.authored': 'progress',
  'spec.revised': 'progress',
  'session.suspended': 'bookkeeping',
  'session.resumed': 'bookkeeping',
  'session.resume-fallback': 'bookkeeping',
  'session.started': 'progress',
  'session.native-handle-recorded': 'bookkeeping',
  'session.ended': 'progress',
  'plan.started': 'progress',
  'plan.completed': 'progress',
  'plan-review.started': 'progress',
  'plan-review.verdict': 'progress',
  'implement.started': 'progress',
  'implement.completed': 'progress',
  'code-review.started': 'progress',
  'code-review.verdict': 'progress',
  'verify.reconcile-policy-captured': 'progress',
  'verify.config-captured': 'progress',
  'verify.config-superseded': 'progress',
  'verify.started': 'progress',
  'verify.cancelled': 'progress',
  'verify.stage-failed': 'progress',
  'verify.completed': 'progress',
  'finalize.started': 'progress',
  'finalize.completed': 'progress',
  'finalize.step-completed': 'progress',
  'pr-attachment.designated': 'progress',
  'pr-attachment.hosted': 'progress',
  'pr-attachment.reclaimed': 'progress',
  'pr-attachment.reclaim-failed': 'progress',
  'pr.auto-merge-enabled': 'progress',
  'pr.auto-merge-disabled': 'progress',
  'pr.merged': 'progress',
  'pr.closed': 'progress',
  'pr.conflicted': 'progress',
  'reconcile.progress-checked': 'progress',
  'reconcile.prepared': 'bookkeeping',
  'reconcile.contended': 'bookkeeping',
  'reconcile.replayed': 'bookkeeping',
  'reconcile.publish-intended': 'bookkeeping',
  'reconcile.rewritten': 'progress',
  'reconcile.started': 'progress',
  'reconcile.completed': 'progress',
  'observation.recorded': 'progress',
  'escalation.raised': 'progress',
  'escalation.answered': 'progress',
  'session.build-read-failed': 'bookkeeping',
  'phase.deferred': 'bookkeeping',
  'phase.deferral-escalated': 'bookkeeping',
  'phase.failed': 'failure',
} satisfies Record<EventType, 'bookkeeping' | 'failure' | 'progress'>

interface Accumulator {
  active: { instance: string; seq: number; eligible: boolean } | null
  count: number
  open: string[]
  latest: { instance: string; seq: number } | null
}

export const executionNoProgressReducer = defineReducer({
  version: 6,
  initial: (): Accumulator => ({ active: null, count: 0, open: [], latest: null }),
  fold(acc, events: readonly AbEvent[]) {
    for (const event of events) {
      if (event.type === 'execution.started') {
        // An abandoned start breaks the consecutive completed-execution streak.
        if (acc.active !== null) acc.count = 0
        acc.active = { instance: event.payload.instance, seq: event.seq, eligible: true }
      } else if (event.type === 'execution.ended') {
        if (acc.active?.instance !== event.payload.instance) continue
        const clean = event.payload.outcome === 'completed' && event.payload.exitCode === 0
        acc.count = clean && acc.active.eligible ? acc.count + 1 : 0
        acc.latest = { instance: event.payload.instance, seq: event.seq }
        acc.active = null
      } else if (
        event.type === 'escalation.raised' &&
        event.payload.source === 'policy' &&
        event.payload.policyCause === 'execution-no-progress'
      ) {
        if (!acc.open.includes(event.payload.id)) acc.open.push(event.payload.id)
      } else if (event.type === 'escalation.answered') {
        if (!acc.open.includes(event.payload.id)) continue
        acc.open = acc.open.filter((id) => id !== event.payload.id)
        acc.count = 0
        acc.active = null
      } else if (executionProgress[event.type] !== 'bookkeeping') {
        acc.count = 0
        if (acc.active !== null) acc.active.eligible = false
      }
    }
  },
  finish: (acc) => ({ ...acc, open: [...acc.open] }),
})

/** Describe routing without copying commands or phase feedback into the question. */
function expectedAction(decision: Decision): string {
  if (decision.kind === 'run-phase') return `${decision.kind} ${decision.phase}@${decision.round}`
  if ('step' in decision)
    return `${decision.kind} ${decision.step} (attempt ${'attempt' in decision ? decision.attempt : 1})`
  if (decision.kind === 'raise-escalation') return `${decision.kind} ${decision.phase}`
  return decision.kind
}

/** Repair the third-completion/raise crash gap without provisioning execution four. */
export async function ensureExecutionProgress(
  store: Pick<RepoViewStore, 'buildFacts' | 'appendIfCurrent' | 'refreshBuild'>,
  ids: IdSource,
  slug: string,
  config: Config,
  decide?: (
    state: Parameters<typeof decideNextFromFacts>[0],
    log: Parameters<typeof decideNextFromFacts>[1],
  ) => Promise<Decision | undefined>,
): Promise<boolean> {
  for (;;) {
    await store.refreshBuild(slug)
    const facts = await store.buildFacts(slug)
    const decision = decide
      ? await decide(facts.state, facts.log)
      : decideNextFromFacts(facts.state, facts.log, config)
    if (decision === undefined) return false
    // Commands must still be acknowledged even while this guard is parked.
    if (decision.kind === 'acknowledge') return true
    const streak = facts.executionNoProgress
    if (streak.open.length > 0) return false
    // Callers own wait routing, including publication-recovery launches. A
    // legitimate wait is not dispatcher/runner disagreement.
    if (decision.kind === 'wait') return true
    if (streak.count < 3) return true
    const raised = await store.appendIfCurrent(slug, facts.state.lastSeq, {
      actor: DISPATCHER,
      type: 'escalation.raised',
      payload: {
        id: ids('esc'),
        phase: 'setup',
        source: 'policy',
        policyCause: 'execution-no-progress',
        question: `${streak.count} consecutive executions ended normally without build progress. Dispatcher expected ${expectedAction(decision)}. Inspect the dispatcher/runner disagreement, then answer with guidance or retry.`,
        refs:
          streak.latest === null
            ? []
            : [`execution:${streak.latest.instance}`, `seq:${streak.latest.seq}`],
      },
    })
    if (raised !== null) return false
  }
}
