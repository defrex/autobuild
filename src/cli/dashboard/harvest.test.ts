import { describe, expect, test } from 'bun:test'
import { KERNEL } from '../../events/envelope'
import { MemoryBuildStore } from '../../store/memory'
import { projectHarvest } from './model'
import { renderDashboard, stripAnsi } from './render'

describe('dashboard harvest row', () => {
  test('a terminal synthesize failure marks only synthesize failed and leaves later steps pending', async () => {
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
    expect(byLabel.get('scan')?.state).toBe('done')
    expect(byLabel.get('synthesize')).toMatchObject({
      state: 'provisional',
      qualifier: 'failed',
    })
    expect(byLabel.get('review')).toMatchObject({ state: 'pending' })
    expect(byLabel.get('review')?.qualifier).toBeUndefined()
    expect(byLabel.get('file')).toMatchObject({ state: 'pending' })
    expect(byLabel.get('file')?.qualifier).toBeUndefined()
  })

  test('projects the staged run, keeps terminal runs visible, and renders a literal nonselectable marker', async () => {
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
        builds: [],
        harvest: projected!,
      },
      { color: true, width: 100, height: 20, now: Date.now() },
    )
    const plain = stripAnsi(lines.join('\n'))
    expect(plain).toContain('HARVEST')
    expect(plain).toContain('h_1')
    expect(plain).not.toContain('> HARVEST')
  })
})
