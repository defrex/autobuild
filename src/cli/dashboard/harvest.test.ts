import { describe, expect, test } from 'bun:test'
import { humanActor, KERNEL } from '../../events/envelope'
import { MemoryBuildStore } from '../../store/memory'
import { projectHarvest } from './model'
import { renderDashboard, stripAnsi } from './render'

describe('dashboard harvest row', () => {
  test('a stopped synthesize failure marks only synthesize failed and leaves later steps pending', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo('/repo')
    await store.appendRepoWithArtifacts(
      '/repo',
      [{ kind: 'harvest-scan', content: '{}' }],
      (deposited) => ({
        actor: KERNEL,
        type: 'harvest.started',
        payload: {
          run: 'h_failed',
          observations: [{ build: 'a', seq: 1 }],
          scan: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
        },
      }),
    )
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.step.started',
      payload: { run: 'h_failed', step: 'scan' },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.step.completed',
      payload: { run: 'h_failed', step: 'scan', outcome: 'completed' },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.step.started',
      payload: { run: 'h_failed', step: 'synthesize', round: 1 },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_failed',
        step: 'synthesize',
        round: 1,
        attempt: 2,
        error: 'no-terminal',
        willRetry: false,
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.step.completed',
      payload: {
        run: 'h_failed',
        step: 'synthesize',
        round: 1,
        outcome: 'failed',
      },
    })

    const projected = projectHarvest(await store.getRepoEvents('/repo'))!
    const byLabel = new Map(projected.steps.map((step) => [step.label, step]))
    expect(projected).toMatchObject({
      status: 'failed',
      detail:
        'stopped at synthesize r1 — automatic recovery 0/2; no-terminal',
    })
    expect(byLabel.get('scan')?.state).toBe('done')
    expect(byLabel.get('synthesize')).toMatchObject({
      state: 'provisional',
      qualifier: 'failed',
    })
    expect(byLabel.get('review')).toMatchObject({ state: 'pending' })
    expect(byLabel.get('review')?.qualifier).toBeUndefined()
    expect(byLabel.get('file')).toMatchObject({ state: 'pending' })
    expect(byLabel.get('file')?.qualifier).toBeUndefined()

    const rendered = stripAnsi(
      renderDashboard(
        {
          repo: '/repo',
          mode: 'watch',
          capacity: 1,
          drained: false,
          statusLine: '',
          builds: [],
          harvest: projected,
        },
        { color: true, width: 100, height: 20, now: Date.now() + 60_000 },
      ).join('\n'),
    )
    expect(rendered).toContain('FAILED')
    expect(rendered).toMatch(/\[x\] scan/)
    expect(rendered).toMatch(/synthesize\(failed,/)
    expect(rendered).toContain('no-terminal')
  })

  test('shows recovery progress and an exhausted human-attention barrier', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo('/repo')
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_recovery',
        observations: [{ build: 'a', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_recovery',
        step: 'file',
        attempt: 2,
        error: 'provider down',
        willRetry: false,
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.recovery-requested',
      payload: { run: 'h_recovery', attempt: 1, limit: 2 },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.resumed',
      payload: {},
    })
    expect(projectHarvest(await store.getRepoEvents('/repo'))).toMatchObject({
      status: 'running',
      detail: 'automatic recovery 1/2 resumed',
    })

    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_recovery',
        step: 'file',
        attempt: 3,
        error: 'provider down',
        willRetry: false,
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.recovery-requested',
      payload: { run: 'h_recovery', attempt: 2, limit: 2 },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.resumed',
      payload: {},
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_recovery',
        step: 'file',
        attempt: 4,
        error: 'provider down',
        willRetry: false,
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.recovery-exhausted',
      payload: {
        run: 'h_recovery',
        step: 'file',
        error: 'provider down',
        attempts: 2,
        limit: 2,
        releasedObservations: [{ build: 'a', seq: 1 }],
        committedDispositions: [],
        pendingProposals: [],
      },
    })
    let projected = projectHarvest(await store.getRepoEvents('/repo'))!
    expect(projected).toMatchObject({
      status: 'failed',
      detail:
        'recovery exhausted — human attention required; stopped at file; pending 1',
    })
    const rendered = stripAnsi(
      renderDashboard(
        {
          repo: '/repo',
          mode: 'watch',
          capacity: 1,
          drained: false,
          statusLine: '',
          builds: [],
          harvest: projected,
        },
        { color: true, width: 120, height: 20, now: Date.now() },
      ).join('\n'),
    )
    expect(rendered).toContain('FAILED')
    expect(rendered).toContain('recovery exhausted — human attention required')

    await store.appendRepo('/repo', {
      actor: humanActor('operator'),
      type: 'harvest.resume-requested',
      payload: {},
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.resumed',
      payload: {},
    })
    projected = projectHarvest(await store.getRepoEvents('/repo'))!
    expect(projected.detail).toContain('attention acknowledged')
    expect(projected.status).toBe('failed')
  })

  test('projects an acknowledged repository pause, freezes open timing, and supports no-run pauses', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo('/repo')
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_paused',
        observations: [{ build: 'a', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.step.started',
      payload: { run: 'h_paused', step: 'synthesize', round: 1 },
    })
    await store.appendRepo('/repo', {
      actor: humanActor('operator'),
      type: 'harvest.pause-requested',
      payload: {},
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.paused',
      payload: {},
    })

    const projected = projectHarvest(await store.getRepoEvents('/repo'))!
    expect(projected.status).toBe('paused')
    expect(projected.steps.find((step) => step.label === 'synthesize')).toMatchObject({
      state: 'pending',
      timing: { accumulatedMs: expect.any(Number) },
    })
    expect(
      projected.steps.find((step) => step.label === 'synthesize')?.timing
        ?.runningSince,
    ).toBeUndefined()
    const rendered = stripAnsi(
      renderDashboard(
        {
          repo: '/repo',
          mode: 'watch',
          capacity: 1,
          drained: false,
          statusLine: '',
          builds: [],
          harvest: projected,
        },
        { color: false, width: 100, height: 20, now: Date.now() + 60_000 },
      ).join('\n'),
    )
    expect(rendered).toContain('PAUSED')

    const idleStore = new MemoryBuildStore()
    await idleStore.ensureRepo('/idle')
    await idleStore.appendRepo('/idle', {
      actor: humanActor('operator'),
      type: 'harvest.pause-requested',
      payload: {},
    })
    await idleStore.appendRepo('/idle', {
      actor: KERNEL,
      type: 'harvest.paused',
      payload: {},
    })
    expect(projectHarvest(await idleStore.getRepoEvents('/idle'))).toMatchObject({
      kind: 'harvest',
      status: 'paused',
      observations: 0,
      rounds: 0,
    })
  })

  test('projects the staged run, keeps terminal runs visible, and renders a selectable Harvest row', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo('/repo')
    await store.appendRepoWithArtifacts(
      '/repo',
      [{ kind: 'harvest-scan', content: '{}' }],
      (deposited) => ({
        actor: KERNEL,
        type: 'harvest.started',
        payload: {
          run: 'h_1',
          observations: [{ build: 'a', seq: 1 }],
          scan: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
        },
      }),
    )
    for (const step of ['scan', 'synthesize'] as const) {
      await store.appendRepo('/repo', {
        actor: KERNEL,
        type: 'harvest.step.started',
        payload: { run: 'h_1', step, ...(step === 'synthesize' ? { round: 2 } : {}) },
      })
      await store.appendRepo('/repo', {
        actor: KERNEL,
        type: 'harvest.step.completed',
        payload: {
          run: 'h_1',
          step,
          outcome: 'completed',
          ...(step === 'synthesize' ? { round: 2 } : {}),
        },
      })
    }
    const projected = projectHarvest(await store.getRepoEvents('/repo'))
    expect(projected?.kind).toBe('harvest')
    expect(projected?.steps.map((step) => step.label)).toEqual([
      'scan',
      'synthesize',
      'review',
      'file',
    ])
    expect(projected?.rounds).toBe(2)

    const lines = renderDashboard(
      {
        repo: '/repo',
        mode: 'watch',
        capacity: 2,
        drained: false,
        statusLine: '',
        selection: { kind: 'harvest' },
        builds: [],
        harvest: projected!,
      },
      { color: true, width: 100, height: 20, now: Date.now() },
    )
    const plain = stripAnsi(lines.join('\n'))
    expect(plain).toContain('> Harvest')
    expect(plain).not.toContain('h_1')
  })
})
