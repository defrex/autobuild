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
      action: 'resume',
      detail: 'stopped at synthesize r1 - automatic recovery 0/2; no-terminal',
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
          queued: 1,
          active: { current: 0, limit: 1 },
          observations: { current: 0, limit: 5 },
          drained: false,
          repositoryPaused: false,
          defaultAutoMerge: false,
          harvestPaused: false,
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
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_later_completed',
        observations: [{ build: 'later', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 1 },
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.completed',
      payload: {
        run: 'h_later_completed',
        dispositions: [
          {
            occurrence: { build: 'later', seq: 1 },
            action: 'suppressed',
            proposalKey: 'later-completed',
          },
        ],
        report: { kind: 'harvest-report', rev: 1 },
      },
    })
    let projected = projectHarvest(await store.getRepoEvents('/repo'))!
    expect(projected).toMatchObject({
      run: 'h_recovery',
      status: 'failed',
      action: 'acknowledge',
      detail: 'recovery exhausted - human attention required; stopped at file; pending 1',
    })
    const rendered = stripAnsi(
      renderDashboard(
        {
          repo: '/repo',
          queued: 1,
          active: { current: 0, limit: 1 },
          observations: { current: 0, limit: 5 },
          drained: false,
          repositoryPaused: false,
          defaultAutoMerge: false,
          harvestPaused: false,
          builds: [],
          harvest: projected,
        },
        { color: true, width: 120, height: 20, now: Date.now() },
      ).join('\n'),
    )
    expect(rendered).toContain('FAILED')
    expect(rendered).toContain('recovery exhausted - human attention required')

    await store.appendRepo('/repo', {
      actor: humanActor('operator'),
      type: 'harvest.resume-requested',
      payload: {},
    })
    projected = projectHarvest(await store.getRepoEvents('/repo'))!
    expect(projected.status).toBe('failed')
    expect(projected.action).toBeUndefined()

    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.resumed',
      payload: {},
    })
    expect(projectHarvest(await store.getRepoEvents('/repo'))).toBeUndefined()
  })

  test('an acknowledged gate pause freezes an open run without manufacturing an idle row', async () => {
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
      projected.steps.find((step) => step.label === 'synthesize')?.timing?.runningSince,
    ).toBeUndefined()
    const rendered = stripAnsi(
      renderDashboard(
        {
          repo: '/repo',
          queued: 1,
          active: { current: 0, limit: 1 },
          observations: { current: 0, limit: 5 },
          drained: false,
          repositoryPaused: false,
          defaultAutoMerge: false,
          harvestPaused: true,
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
    expect(projectHarvest(await idleStore.getRepoEvents('/idle'))).toBeUndefined()
  })

  test('projects an open staged run and renders a selectable Harvest row', async () => {
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
        payload: {
          run: 'h_1',
          step,
          ...(step === 'synthesize' ? { round: 2 } : {}),
        },
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
        queued: 2,
        active: { current: 0, limit: 1 },
        observations: { current: 0, limit: 5 },
        drained: false,
        repositoryPaused: false,
        defaultAutoMerge: false,
        harvestPaused: false,
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

  test('completion removes the latest run row immediately', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo('/repo')
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_completed',
        observations: [{ build: 'a', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    expect(projectHarvest(await store.getRepoEvents('/repo'))?.status).toBe('running')

    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.completed',
      payload: {
        run: 'h_completed',
        dispositions: [
          {
            occurrence: { build: 'a', seq: 1 },
            action: 'suppressed',
            proposalKey: 'suppressed:a:1',
          },
        ],
        report: { kind: 'harvest-report', rev: 0 },
      },
    })
    expect(projectHarvest(await store.getRepoEvents('/repo'))).toBeUndefined()
  })

  test('escalation stays visible through a request and disappears only after its acknowledged resume pair', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo('/repo')
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_escalated',
        observations: [{ build: 'a', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.escalated',
      payload: {
        run: 'h_escalated',
        source: 'agent',
        reason: 'operator judgment required',
        observations: [{ build: 'a', seq: 1 }],
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_later_running',
        observations: [{ build: 'b', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 1 },
      },
    })
    expect(projectHarvest(await store.getRepoEvents('/repo'))).toMatchObject({
      run: 'h_escalated',
      status: 'escalated',
      action: 'acknowledge',
      detail: 'operator judgment required',
    })

    // Model the header route: the gate is acknowledged off, then h requests
    // its resume. The same request also becomes the run-attention evidence.
    await store.appendRepo('/repo', {
      actor: humanActor('prior-process'),
      type: 'harvest.pause-requested',
      payload: {},
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.paused',
      payload: {},
    })
    await store.appendRepo('/repo', {
      actor: humanActor('header-operator'),
      type: 'harvest.resume-requested',
      payload: {},
    })
    const pending = projectHarvest(await store.getRepoEvents('/repo'))
    expect(pending).toMatchObject({ status: 'escalated' })
    expect(pending?.action).toBeUndefined()

    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.resumed',
      payload: {},
    })
    expect(projectHarvest(await store.getRepoEvents('/repo'))).toMatchObject({
      run: 'h_later_running',
      status: 'running',
    })
  })

  test('an ordinary failed run stays visible while resume is pending and reopens on acknowledgement', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo('/repo')
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_resume',
        observations: [{ build: 'a', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_resume',
        step: 'scan',
        attempt: 1,
        error: 'store unavailable',
        willRetry: false,
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_newer_completed',
        observations: [{ build: 'b', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 1 },
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.completed',
      payload: {
        run: 'h_newer_completed',
        dispositions: [
          {
            occurrence: { build: 'b', seq: 1 },
            action: 'suppressed',
            proposalKey: 'newer-completed',
          },
        ],
        report: { kind: 'harvest-report', rev: 1 },
      },
    })
    expect(projectHarvest(await store.getRepoEvents('/repo'))).toMatchObject({
      run: 'h_resume',
      action: 'resume',
    })
    await store.appendRepo('/repo', {
      actor: humanActor('operator'),
      type: 'harvest.resume-requested',
      payload: {},
    })
    expect(projectHarvest(await store.getRepoEvents('/repo'))?.action).toBeUndefined()
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.resumed',
      payload: {},
    })
    expect(projectHarvest(await store.getRepoEvents('/repo'))).toMatchObject({
      run: 'h_resume',
      status: 'running',
    })
  })

  describe('session-stream enrichment through the terminal wrapper', () => {
    /** Seed one harvest run bracket plus one synthesize session whose
     * `harvest.session.ended` carries the fixture usage. */
    async function seedRun(store: MemoryBuildStore): Promise<void> {
      await store.ensureRepo('/repo')
      await store.appendRepo('/repo', {
        actor: KERNEL,
        type: 'harvest.started',
        payload: {
          run: 'h_streamed',
          observations: [{ build: 'a', seq: 1 }],
          scan: { kind: 'harvest-scan', rev: 0 },
        },
      })
      await store.appendRepo('/repo', {
        actor: KERNEL,
        type: 'harvest.session.started',
        payload: {
          run: 'h_streamed',
          session: 'hs_1',
          role: 'harvest',
          runner: 'pi',
          step: 'synthesize',
          round: 1,
          stream: 'st_payload',
        },
      })
      await store.appendRepo('/repo', {
        actor: KERNEL,
        type: 'harvest.session.ended',
        payload: {
          run: 'h_streamed',
          session: 'hs_1',
          transcript: { kind: 'transcript:harvest', rev: 0 },
          usage: { inputTokens: 1, outputTokens: 1, turns: 1 },
        },
      })
    }

    test('repo-scoped stream records attach authoritative stream ids and closed status', async () => {
      const store = new MemoryBuildStore()
      await seedRun(store)
      const record = await store.createStream({ kind: 'repo', repo: '/repo' }, 'session:hs_1')
      await store.closeStream(record.id, 'completed')

      const projected = projectHarvest(
        await store.getRepoEvents('/repo'),
        await store.listStreams({ kind: 'repo', repo: '/repo' }),
      )
      expect(projected?.sessions).toEqual([
        {
          session: 'hs_1',
          role: 'harvest',
          step: 'synthesize',
          round: 1,
          stream: record.id,
          streamStatus: 'closed',
          status: 'ended',
        },
      ])
    })

    test('an open record attaches its stream id with open status', async () => {
      const store = new MemoryBuildStore()
      await seedRun(store)
      await store.createStream({ kind: 'repo', repo: '/repo' }, 'session:hs_1')

      const projected = projectHarvest(
        await store.getRepoEvents('/repo'),
        await store.listStreams({ kind: 'repo', repo: '/repo' }),
      )
      const [session] = projected?.sessions ?? []
      expect(session).toMatchObject({ session: 'hs_1', streamStatus: 'open', status: 'ended' })
    })

    test('a label-mismatched record does not enrich: the payload pairing survives', async () => {
      const store = new MemoryBuildStore()
      await seedRun(store)
      const stranger = await store.createStream({ kind: 'repo', repo: '/repo' }, 'session:hs_other')
      await store.closeStream(stranger.id, 'completed')

      const projected = projectHarvest(
        await store.getRepoEvents('/repo'),
        await store.listStreams({ kind: 'repo', repo: '/repo' }),
      )
      // Without a matching record the pairing degrades to the payload: the
      // event's own stream id reads closed once its bracket ended.
      expect(projected?.sessions).toEqual([
        {
          session: 'hs_1',
          role: 'harvest',
          step: 'synthesize',
          round: 1,
          stream: 'st_payload',
          streamStatus: 'closed',
          status: 'ended',
        },
      ])
    })

    test('build-scoped records never enrich the repo-scoped pairing', async () => {
      const store = new MemoryBuildStore()
      await seedRun(store)
      await store.createBuild({ slug: 'other-build', repo: '/repo' })
      const buildStream = await store.createStream(
        { kind: 'build', build: 'other-build' },
        'session:hs_1',
      )
      await store.closeStream(buildStream.id, 'completed')

      const projected = projectHarvest(
        await store.getRepoEvents('/repo'),
        await store.listStreams({ kind: 'repo', repo: '/repo' }).then((records) =>
          // The caller passes only what listStreams returned for the repo
          // scope; the build-scoped record here models a scope-filter failure
          // by appending it by hand.
          [
            ...records,
            {
              ...buildStream,
            },
          ],
        ),
      )
      expect(projected?.sessions).toEqual([
        {
          session: 'hs_1',
          role: 'harvest',
          step: 'synthesize',
          round: 1,
          stream: 'st_payload',
          streamStatus: 'closed',
          status: 'ended',
        },
      ])
    })

    test('absent enrichment degrades to the payload-derived pairing', async () => {
      const store = new MemoryBuildStore()
      await seedRun(store)
      const projected = projectHarvest(await store.getRepoEvents('/repo'))
      expect(projected?.sessions).toEqual([
        {
          session: 'hs_1',
          role: 'harvest',
          step: 'synthesize',
          round: 1,
          stream: 'st_payload',
          streamStatus: 'closed',
          status: 'ended',
        },
      ])
    })

    test("failed enrichment degrades identically (a throwing listStreams is the caller's catch)", async () => {
      const store = new MemoryBuildStore()
      await seedRun(store)
      // The wrapper itself never touches the store: the caller passes
      // whatever it resolved, so a failed read arrives as `undefined`.
      const projected = projectHarvest(await store.getRepoEvents('/repo'), undefined)
      expect(projected?.sessions).toHaveLength(1)
      expect(projected?.sessions?.[0]).toMatchObject({ session: 'hs_1' })
    })

    test('the terminal renderer renders nothing new from the sessions field', async () => {
      const store = new MemoryBuildStore()
      await seedRun(store)
      const record = await store.createStream({ kind: 'repo', repo: '/repo' }, 'session:hs_1')
      await store.closeStream(record.id, 'completed')
      const streams = await store.listStreams({ kind: 'repo', repo: '/repo' })
      const without = projectHarvest(await store.getRepoEvents('/repo'))!
      const withSessions = projectHarvest(await store.getRepoEvents('/repo'), streams)!

      const render = (harvest: typeof without): string =>
        stripAnsi(
          renderDashboard(
            {
              repo: '/repo',
              queued: 1,
              active: { current: 0, limit: 1 },
              observations: { current: 0, limit: 5 },
              drained: false,
              repositoryPaused: false,
              defaultAutoMerge: false,
              harvestPaused: false,
              builds: [],
              harvest,
            },
            { color: false, width: 100, height: 20, now: Date.now() },
          ).join('\n'),
        )
      // The additive field is display-silent in the terminal.
      expect(render(withSessions)).toBe(render(without))
      expect(render(withSessions)).not.toContain('st_payload')
      expect(render(withSessions)).not.toContain(record.id)
    })
  })
})
