import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { humanActor, KERNEL } from '../events/envelope'
import { sequentialIds } from '../ids'
import { MemoryBuildStore } from '../store/memory'
import { steppingClock } from '../testing/fixed'
import type { HarvestCliEnv } from './env'
import {
  abHarvestStatus,
  buildHarvestContext,
  projectHarvestStatus,
  renderHarvestStatus,
  submitHarvestProposals,
  submitHarvestVerdict,
} from './harvest'
import { describeStoreOpeningContract } from './store-opening.contract'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const workspacePath = await mkdtemp(join(tmpdir(), 'ab-harvest-cli-'))
  roots.push(workspacePath)
  const store = new MemoryBuildStore({ clock: steppingClock() })
  await store.ensureRepo('/repo')
  const packet = {
    repo: '/repo',
    run: 'h_1',
    observations: [
      {
        occurrence: { build: 'build-a', seq: 4 },
        id: 'obs-1',
        kind: 'latent-bug' as const,
        summary: 'bug',
        ts: '2026-07-15T00:00:00.000Z',
      },
    ],
    ledger: [],
  }
  await store.appendRepoWithArtifacts(
    '/repo',
    [{ kind: 'harvest-scan', content: JSON.stringify(packet) }],
    (deposited) => ({
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_1',
        observations: [{ build: 'build-a', seq: 4 }],
        scan: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
      },
    }),
  )
  const env: HarvestCliEnv = {
    store: 'local',
    repo: '/repo',
    run: 'h_1',
    phase: 'synthesize',
    round: 1,
    session: 'hs_1',
  }
  return { store, workspacePath, env, ids: sequentialIds() }
}

describe('harvest status', () => {
  test('reports the durable pause gate while preserving underlying run state', async () => {
    const deps = await fixture()
    await deps.store.appendRepo('/repo', {
      actor: humanActor('operator'),
      type: 'harvest.pause-requested',
      payload: {},
    })
    const paused = await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.paused',
      payload: {},
    })

    const view = projectHarvestStatus(
      '/repo',
      await deps.store.getRepoEvents('/repo'),
    )
    expect(view).toMatchObject({
      run: 'h_1',
      status: 'paused',
      runStatus: 'running',
      paused: true,
      pausedSeq: paused.seq,
      pausedAt: paused.ts,
      pendingCommands: [],
      observations: 1,
    })

    const idle = new MemoryBuildStore({ clock: steppingClock() })
    await idle.ensureRepo('/idle')
    await idle.appendRepo('/idle', {
      actor: humanActor('operator'),
      type: 'harvest.pause-requested',
      payload: {},
    })
    await idle.appendRepo('/idle', {
      actor: KERNEL,
      type: 'harvest.paused',
      payload: {},
    })
    expect(
      projectHarvestStatus('/idle', await idle.getRepoEvents('/idle')),
    ).toMatchObject({
      status: 'paused',
      paused: true,
      observations: 0,
      steps: [],
    })
  })

  test('event history remains harvest-focused in a mixed repository journal', async () => {
    const deps = await fixture()
    await deps.store.appendRepo('/repo', {
      actor: humanActor('operator'),
      type: 'dispatcher.intake-set',
      payload: { enabled: false },
    })
    await deps.store.appendRepo('/repo', {
      actor: humanActor('operator'),
      type: 'dispatcher.auto-merge-default-set',
      payload: { enabled: true },
    })

    const view = projectHarvestStatus(
      '/repo',
      await deps.store.getRepoEvents('/repo'),
      2,
    )
    expect(view.status).toBe('running')
    expect(view.events?.map((event) => event.type)).toEqual([
      'harvest.started',
    ])
    expect(renderHarvestStatus(view).join('\n')).not.toContain('dispatcher.')
  })

  test('reports every shadowed failure alongside the latest run', async () => {
    const deps = await fixture()
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_1',
        step: 'review',
        round: 1,
        attempt: 2,
        error: 'first failure',
        willRetry: false,
      },
    })
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.recovery-requested',
      payload: { run: 'h_1', attempt: 1, limit: 2 },
    })
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.resumed',
      payload: {},
    })
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_1',
        step: 'review',
        round: 1,
        attempt: 3,
        error: 'first failure again',
        willRetry: false,
      },
    })
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_2',
        observations: [{ build: 'build-b', seq: 8 }],
        scan: { kind: 'harvest-scan', rev: 2 },
      },
    })
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_2',
        step: 'file',
        attempt: 2,
        error: 'second failure',
        willRetry: false,
      },
    })
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_3',
        observations: [{ build: 'build-c', seq: 9 }],
        scan: { kind: 'harvest-scan', rev: 3 },
      },
    })
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.completed',
      payload: {
        run: 'h_3',
        dispositions: [
          {
            occurrence: { build: 'build-c', seq: 9 },
            action: 'suppressed',
            proposalKey: 'completed-c',
          },
        ],
        report: { kind: 'harvest-report', rev: 0 },
      },
    })

    const view = projectHarvestStatus(
      '/repo',
      await deps.store.getRepoEvents('/repo'),
    )
    expect(view).toMatchObject({
      status: 'failed',
      run: 'h_1',
      runs: [
        {
          run: 'h_1',
          status: 'failed',
          recovery: {
            automatic: { attempts: 1, limit: 2 },
            stopped: { step: 'review', round: 1 },
            pending: {
              observations: [{ build: 'build-a', seq: 4 }],
            },
          },
        },
        {
          run: 'h_2',
          status: 'failed',
          recovery: {
            automatic: { attempts: 0, limit: 2 },
            stopped: { step: 'file' },
            pending: {
              observations: [{ build: 'build-b', seq: 8 }],
            },
          },
        },
        { run: 'h_3', status: 'completed' },
      ],
    })
    const rendered = renderHarvestStatus(view).join('\n')
    expect(rendered).toContain('harvest h_1 — failed')
    expect(rendered).toContain('harvest h_2 — failed')
    expect(rendered).toContain('harvest h_3 — completed')
    expect(rendered).toContain('pending: 1 observation (build-a:4)')
    expect(rendered).toContain('pending: 1 observation (build-b:8)')
  })

  test('projects an infrastructure stop before resume and the same running run after acknowledgement', async () => {
    const deps = await fixture()
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.step.started',
      payload: { run: 'h_1', step: 'file' },
    })
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.proposal.filed',
      payload: {
        run: 'h_1',
        proposalKey: 'cluster-1',
        ticket: { source: 'fake', id: 'T-1' },
      },
    })
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_1',
        step: 'file',
        attempt: 2,
        error: 'ticket provider unavailable',
        willRetry: false,
      },
    })

    const before = projectHarvestStatus(
      '/repo',
      await deps.store.getRepoEvents('/repo'),
    )
    expect(before).toMatchObject({
      run: 'h_1',
      status: 'failed',
      runStatus: 'failed',
      observations: 1,
      failure: {
        step: 'file',
        attempt: 2,
        error: 'ticket provider unavailable',
      },
      filed: [
        {
          proposalKey: 'cluster-1',
          ticket: { source: 'fake', id: 'T-1' },
        },
      ],
    })

    await deps.store.appendRepo('/repo', {
      actor: humanActor('operator'),
      type: 'harvest.resume-requested',
      payload: {},
    })
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.resumed',
      payload: {},
    })
    const after = projectHarvestStatus(
      '/repo',
      await deps.store.getRepoEvents('/repo'),
    )
    expect(after).toMatchObject({
      run: 'h_1',
      status: 'running',
      runStatus: 'running',
      observations: 1,
      steps: before.steps,
      filed: before.filed,
    })
    expect(after.failure).toBeUndefined()
  })

  test('reports automatic recovery progress, exhausted pending work, and attention acknowledgement', async () => {
    const deps = await fixture()
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_1',
        step: 'file',
        attempt: 2,
        error: 'ticket provider unavailable',
        willRetry: false,
      },
    })
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.recovery-requested',
      payload: { run: 'h_1', attempt: 1, limit: 2 },
    })
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.resumed',
      payload: {},
    })
    let view = projectHarvestStatus(
      '/repo',
      await deps.store.getRepoEvents('/repo'),
    )
    expect(view).toMatchObject({
      status: 'running',
      recovery: {
        recoverable: false,
        finished: false,
        automatic: { attempts: 1, limit: 2, exhausted: false },
        attention: { required: false, acknowledged: false },
      },
    })

    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_1',
        step: 'file',
        attempt: 3,
        error: 'ticket provider unavailable',
        willRetry: false,
      },
    })
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.recovery-requested',
      payload: { run: 'h_1', attempt: 2, limit: 2 },
    })
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.resumed',
      payload: {},
    })
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_1',
        step: 'file',
        attempt: 4,
        error: 'ticket provider unavailable',
        willRetry: false,
      },
    })
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.recovery-exhausted',
      payload: {
        run: 'h_1',
        step: 'file',
        error: 'ticket provider unavailable',
        attempts: 2,
        limit: 2,
        releasedObservations: [{ build: 'build-a', seq: 4 }],
        committedDispositions: [],
        pendingProposals: [
          {
            proposalKey: 'pending-cluster',
            action: 'create',
            observations: [{ build: 'build-a', seq: 4 }],
          },
        ],
      },
    })
    view = projectHarvestStatus(
      '/repo',
      await deps.store.getRepoEvents('/repo'),
    )
    expect(view).toMatchObject({
      status: 'failed',
      recovery: {
        recoverable: false,
        finished: true,
        automatic: { attempts: 2, limit: 2, exhausted: true },
        stopped: { step: 'file' },
        attention: { required: true, acknowledged: false },
        pending: {
          observations: [{ build: 'build-a', seq: 4 }],
          proposalKeys: ['pending-cluster'],
        },
      },
    })
    const rendered = renderHarvestStatus(view).join('\n')
    expect(rendered).toContain('stopped at: file')
    expect(rendered).toContain('automatic recovery: 2/2 exhausted')
    expect(rendered).toContain('pending: 1 observation (build-a:4)')
    expect(rendered).toContain('attention: human acknowledgement required')

    await deps.store.appendRepo('/repo', {
      actor: humanActor('operator'),
      type: 'harvest.resume-requested',
      payload: {},
    })
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.resumed',
      payload: {},
    })
    view = projectHarvestStatus(
      '/repo',
      await deps.store.getRepoEvents('/repo'),
    )
    expect(view.runStatus).toBe('failed')
    expect(view.recovery.attention).toEqual({
      required: false,
      acknowledged: true,
    })
    expect(renderHarvestStatus(view)).toContain('attention: acknowledged')
  })

  test('completed and escalated runs project as terminal, never recoverable', async () => {
    const deps = await fixture()
    await deps.store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.escalated',
      payload: {
        run: 'h_1',
        source: 'agent',
        reason: 'human judgment required',
        observations: [{ build: 'build-a', seq: 4 }],
      },
    })
    const view = projectHarvestStatus(
      '/repo',
      await deps.store.getRepoEvents('/repo'),
    )
    expect(view.status).toBe('escalated')
    expect(view.recovery).toMatchObject({
      recoverable: false,
      finished: true,
      automatic: { attempts: 0, exhausted: false },
    })
  })

  test('shares store precedence and uses the main checkout as journal identity', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.ensureRepo('/main/repo')
    const exec = async () => ({
      stdout: '/main/repo/.git\n/main/repo/.git\n/main/repo\n',
      stderr: '',
      exitCode: 0,
    })
    const refs: string[] = []
    const outputs: string[] = []
    const common = {
      repo: '/linked/worktree',
      exec,
      stdout: (line: string) => outputs.push(line),
      json: true,
      openStore: (ref: string) => {
        refs.push(ref)
        return store
      },
    }

    await abHarvestStatus({
      ...common,
      env: { AB_STORE: 'environment' },
      storeRef: 'flag',
    })
    await abHarvestStatus({ ...common, env: { AB_STORE: 'environment' } })
    await abHarvestStatus({ ...common, env: {} })

    expect(refs).toEqual([
      '/main/repo/flag',
      '/main/repo/environment',
      '/main/repo/.autobuild',
    ])
    expect(outputs.map((line) => JSON.parse(line).repo)).toEqual([
      '/main/repo',
      '/main/repo',
      '/main/repo',
    ])
  })
})

describeStoreOpeningContract('ab harvest status', {
  run: ({ targetRepo, ...opts }) =>
    abHarvestStatus({
      ...opts,
      repo: targetRepo,
      json: true,
    }),
  canonicalMarker: (stdout) =>
    (JSON.parse(stdout.join('\n')) as { repo: string }).repo,
  expectedCanonicalMarker: '/main/repo',
})

describe('harvest CLI', () => {
  test('context scopes inputs; submit enforces coverage; reviewer deposits typed verdict', async () => {
    const deps = await fixture()
    const manifest = await buildHarvestContext(deps)
    expect(manifest.allowedTerminal).toBe('submit')
    expect(
      JSON.parse(await readFile(join(deps.workspacePath, '.ab', 'observations.json'), 'utf8')),
    ).toHaveLength(1)

    const bad = join(deps.workspacePath, 'bad.json')
    await writeFile(bad, JSON.stringify({ proposals: [{ action: 'suppress', reason: 'x', observations: [{ build: 'other', seq: 1 }] }] }))
    await expect(submitHarvestProposals(deps, bad)).rejects.toThrow(
      /cover every claimed observation exactly once/,
    )

    const good = join(deps.workspacePath, 'good.json')
    await writeFile(
      good,
      JSON.stringify({
        proposals: [
          {
            action: 'create',
            title: 'Bug',
            whatWhy: 'Users encounter the recorded bug.',
            acceptanceCriteria: ['The bug is fixed.'],
            outOfScope: ['Other behavior.'],
            observations: [{ build: 'build-a', seq: 4 }],
          },
        ],
      }),
    )
    const submitted = await submitHarvestProposals(deps, good)
    expect(submitted.type).toBe('harvest.proposals.submitted')
    await expect(submitHarvestProposals(deps, good)).rejects.toThrow(
      /second harvest terminal/,
    )

    const reviewDeps = {
      ...deps,
      env: { ...deps.env, phase: 'review' as const, session: 'hs_2' },
    }
    const reviewContext = await buildHarvestContext(reviewDeps)
    expect(reviewContext.allowedTerminal).toBe('verdict')
    const notes = join(deps.workspacePath, 'review.md')
    await writeFile(notes, 'approved')
    const verdict = await submitHarvestVerdict(reviewDeps, {
      verdict: 'approve',
      notes,
    })
    expect(verdict.payload.verdict).toBe('approve')

    const view = projectHarvestStatus('/repo', await deps.store.getRepoEvents('/repo'))
    expect(view.run).toBe('h_1')
    expect(view.rounds).toBe(1)
  })
})
