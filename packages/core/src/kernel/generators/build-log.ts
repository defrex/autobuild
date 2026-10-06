/** Seeded generated build logs for the incremental reducer property tests. */
import { DISPATCHER, KERNEL, humanActor, type Actor } from '../../events/envelope'
import {
  validateEventWrite,
  allowedActorKinds,
  type AbEvent,
  type EventWrite,
} from '../../events/catalog'
import type { EventType } from '../../events/payloads'
import { steppingClock } from '../../testing/fixed'
import { pick, seededRandom } from '../incremental-contract'

function actorFor(type: EventType): Actor {
  switch (allowedActorKinds[type][0]) {
    case 'kernel':
      return KERNEL
    case 'dispatcher':
      return DISPATCHER
    case 'human':
      return humanActor('aron')
    case 'agent':
      return { kind: 'agent', role: 'test-role', session: 's_test' }
    default:
      return { kind: 'ingester', source: 'test' }
  }
}

const w = (type: EventType, payload: Record<string, unknown>): EventWrite =>
  validateEventWrite({ actor: actorFor(type), type, payload } as EventWrite)

const SHA = 'a'.repeat(40)
const ART = (kind: string, rev: number) => ({ kind, rev })

/** Plausible payload templates drawn from the catalog; ids and rounds come
 * from small pools so correlations (escalations, sessions, rounds) happen. */
function randomWrite(rand: () => number): EventWrite {
  const round = 1 + Math.floor(rand() * 3)
  const attempt = 1 + Math.floor(rand() * 3)
  const id = pick(rand, ['e_1', 'e_2', 'e_3'])
  const session = pick(rand, ['s_a', 's_b'])
  const step = pick(rand, ['types', 'unit'])
  const templates: Array<() => EventWrite> = [
    () => w('runner.attached', { instance: 'runner-1', host: 'local' }),
    () => w('spec.imported', { artifact: ART('spec', 0), ticket: { source: 'linear', id: 'E-1' } }),
    () => w('spec.revised', { artifact: ART('spec', round), escalation: 1 }),
    () => w('plan.started', { round }),
    () => w('plan.completed', { round, artifact: ART('plan', round) }),
    () => w('plan-review.started', { round }),
    () =>
      w('plan-review.verdict', {
        round,
        verdict: pick(rand, ['approve', 'revise'] as const),
        findings: [],
        artifact: ART('plan-review', round),
      }),
    () => w('implement.started', { round }),
    () =>
      w('implement.completed', {
        round,
        commits: { base: 'b', head: `h${round}` },
        artifact: ART('implement-notes', round),
      }),
    () => w('code-review.started', { round }),
    () =>
      w('code-review.verdict', {
        round,
        verdict: pick(rand, ['approve', 'revise'] as const),
        findings: [],
        artifact: ART('code-review', round),
      }),
    () => w('verify.started', { step, attempt }),
    () => w('verify.completed', { step, attempt, pass: rand() < 0.5 }),
    () => w('finalize.started', {}),
    () =>
      w('finalize.completed', {
        pr: { number: 7, url: 'https://github.com/o/r/pull/7', headSha: 'h' },
      }),
    () => w('finalize.step-completed', { step: 'notes', ok: rand() < 0.5 }),
    () => w('pr.conflicted', { baseSha: 'm' }),
    () => w('reconcile.started', { attempt, baseSha: 'm' }),
    () =>
      w('reconcile.completed', { mergeCommit: 'mc', artifact: ART('reconcile-notes', attempt) }),
    () => w('pr.merged', { sha: 's' }),
    () => w('build.completed', { outcome: 'merged' }),
    () => w('build.pause-requested', {}),
    () => w('build.resume-requested', {}),
    () => w('build.paused', {}),
    () => w('build.resumed', {}),
    () => w('build.abort-requested', {}),
    () => w('build.aborted', {}),
    () => w('build.auto-merge-requested', {}),
    () => w('build.auto-merge-cancelled', {}),
    () => w('pr.auto-merge-enabled', { commandSeq: 1 }),
    () =>
      w('escalation.raised', {
        id,
        phase: pick(rand, ['plan', 'implement', 'plan-review'] as const),
        source: 'agent',
        question: 'q',
      }),
    () =>
      w('escalation.answered', {
        id,
        answer: 'a',
        resolution: pick(rand, ['guidance', 'abort', 'retry'] as const),
      }),
    () =>
      w('session.started', {
        session,
        role: 'plan',
        runner: 'claude',
        phase: 'plan',
        round,
      }),
    () =>
      w('session.ended', {
        session,
        transcript: ART('transcript', 0),
        usage: { inputTokens: 1, outputTokens: 1, turns: 1 },
      }),
    () =>
      w('observation.recorded', { id: `o_${round}`, kind: 'refactor', summary: 's', files: [] }),
    () => w('phase.failed', { phase: 'plan', round, attempt, error: 'x', willRetry: true }),
    () => w('dispatch.failed', { stage: 'workspace', attempt, error: 'offline' }),
    () => w('execution.started', { provider: 'p', workspaceRef: 'w', instance: 'i' }),
    () => w('execution.ended', { instance: 'i', workspaceRef: 'w', outcome: 'completed' }),
    () =>
      w('infrastructure.failed', {
        provider: 'p',
        workspaceRef: 'w',
        instance: 'i',
        operation: 'wait',
        cause: 'timeout',
        attempt,
        retryable: true,
        cleanupPending: false,
        error: 'x',
      }),
    () =>
      w('infrastructure.cleanup-attempted', {
        provider: 'p',
        workspaceRef: 'w',
        operation: 'stop',
        attempt,
        outcome: 'confirmed',
      }),
    () => w('runner.setup-failed', { command: 'bun install', attempt, exitStatus: 1, output: 'x' }),
    () => w('build.discard-requested', {}),
    () =>
      w('escalation.raised', {
        id,
        phase: 'plan',
        source: 'policy',
        policyCause: 'infrastructure-failure-limit',
        question: 'q',
      }),
    () =>
      w('workspace.provision-started', { provider: 'worktree', branch: 'ab/x', generation: round }),
    () =>
      w('workspace.provisioned', {
        provider: 'worktree',
        ref: `/ws/${round}`,
        branch: 'ab/x',
        base: { source: 'remote', sha: `base${round}` },
        ...(rand() < 0.5 ? { remote: true } : {}),
      }),
    () => w('workspace.released', rand() < 0.5 ? {} : { ref: '/ws/1', reason: 'completion' }),
    () =>
      w('publication.requested', {
        operation: 'implement',
        branch: 'ab/x',
        sha: SHA,
        round,
        base: SHA,
        artifact: ART('implement-notes', round),
      }),
    () =>
      w('publication.requested', {
        operation: 'reconcile',
        branch: 'ab/x',
        sha: SHA,
        artifact: ART('reconcile-notes', round),
      }),
    () =>
      w('publication.lost', {
        request: round,
        operation: 'implement',
        branch: 'ab/x',
        sha: SHA,
        reason: 'released',
      }),
    () =>
      w('pr-attachment.designated', {
        artifact: ART('screenshot', round),
        filename: `shot${round}.png`,
        mediaType: 'image/png',
      }),
    () =>
      w('pr-attachment.hosted', {
        designationSeq: 1 + Math.floor(rand() * 20),
        asset: {
          provider: 'github-release',
          repository: 'o/r',
          releaseId: round,
          assetId: attempt,
          url: 'https://example.com/a.png',
        },
      }),
    () => w('pr-attachment.reclaimed', { hostedSeq: 1 + Math.floor(rand() * 20) }),
    () => w('build.auto-merge-default-observed', { defaultSeq: round }),
    () =>
      w('observation.recorded', {
        id: `o_d${round}`,
        kind: 'followup',
        summary: 'deferred',
        files: [],
        refs: [`auto-merge-gate:pr:7:${round}`],
      }),
    () =>
      w('spec.revised', {
        artifact: ART('spec', round),
        escalation: 1,
        assets: [
          {
            kind: 'design',
            name: 'a',
            revision: round,
            layout: 'file',
            size: 1,
            fileCount: 1,
            dirCount: 0,
          },
        ],
      }),
  ]
  return pick(rand, templates)()
}

export function randomBuildLog(seed: number, length: number): AbEvent[] {
  const rand = seededRandom(seed)
  const clock = steppingClock()
  const created = w('build.created', {
    ticket: { source: 'linear', id: 'E-1', title: 't' },
    repo: 'o/r',
    baseBranch: 'main',
  })
  const writes = [created, ...Array.from({ length }, () => randomWrite(rand))]
  return writes.map(
    (write, index) =>
      ({
        build: 'gen',
        seq: index + 1,
        ts: clock().toISOString(),
        actor: write.actor,
        type: write.type,
        payload: write.payload,
      }) as AbEvent,
  )
}
