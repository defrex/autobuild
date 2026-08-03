import { expect, test } from 'bun:test'
import { DISPATCHER, KERNEL, agentActor } from '../events/envelope'
import type { BuildStore } from '../store/types'
import { MemoryBuildStore } from '../store/memory'
import { createTerminalModeController } from './terminal-restore'
import { renderDashboard } from './dashboard/render'
import { DispatchFrontend } from './dispatch-frontend'
import type { DispatchChildResult } from './dispatch-process'
import type { TerminalInputEvent } from './terminal'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const tickCounters = {
  merged: 0,
  closed: 0,
  conflicted: 0,
  abandoned: 0,
  discarded: 0,
  janitorFailed: 0,
  recovered: 0,
  dispatchFailed: 0,
  resumed: 0,
  swept: 0,
  dispatched: 0,
  authored: 0,
  bounced: 0,
  claimRaces: 0,
  invalidTickets: 0,
  dependencyBlocked: 0,
  harvestStarted: 0,
  harvestResumed: 0,
  harvestCompleted: 0,
  harvestEscalated: 0,
  harvestFailed: 0,
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await predicate()) return
    await Bun.sleep(5)
  }
  throw new Error(`timed out waiting for ${message}`)
}

test('frontend input and captured controls remain responsive while the kernel is gated', async () => {
  const repo = '/repo'
  const backing = new MemoryBuildStore()
  await backing.ensureRepo(repo)
  for (const slug of ['alpha', 'beta']) {
    const ticket = { source: 'fake', id: slug, title: slug }
    await backing.createBuild({ slug, repo, ticket, branch: `ab/${slug}` })
    await backing.append(slug, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { repo, ticket, baseBranch: 'main' },
    })
  }

  const intakeEntered = deferred<void>()
  const releaseIntake = deferred<void>()
  let delayed = false
  const repositoryReads: number[] = []
  const store = new Proxy(backing, {
    get(target, property) {
      if (property === 'getRepoEvents') {
        return async (requestedRepo: string, sinceSeq = 0) => {
          repositoryReads.push(sinceSeq)
          return target.getRepoEvents(requestedRepo, sinceSeq)
        }
      }
      if (property === 'appendRepo') {
        return async (...args: Parameters<BuildStore['appendRepo']>) => {
          const event = args[1]
          if (!delayed && event.type === 'dispatcher.intake-set') {
            delayed = true
            intakeEntered.resolve()
            await releaseIntake.promise
          }
          return target.appendRepo(...args)
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as BuildStore

  let input: ((event: TerminalInputEvent) => void) | undefined
  let output = ''
  const write = (chunk: string): void => {
    output += chunk
  }
  const childDone = deferred<DispatchChildResult>()
  const frontend = new DispatchFrontend({
    repo,
    storeRef: 'memory',
    store,
    env: { USER: 'operator' },
    terminal: {
      write,
      modes: createTerminalModeController(write, write),
      columns: 100,
      rows: 30,
      interactive: true,
    },
    input: {
      start(handler) {
        input = handler
        return () => {
          input = undefined
        }
      },
    },
    once: false,
    launchChild: ({ run }) => {
      const startup = backing.appendRepoWithArtifacts(
        repo,
        [
          {
            kind: 'dispatcher-effective-config',
            content: JSON.stringify({
              capacity: 2,
              roles: { default: { runtime: 'claude' } },
              tickets: { source: 'file', readyState: 'ready' },
            }),
          },
        ],
        (artifacts) => ({
          actor: DISPATCHER,
          type: 'dispatcher.run-started',
          payload: {
            run,
            pid: 999,
            effectiveConfig: {
              kind: artifacts[0]!.kind,
              rev: artifacts[0]!.revision,
            },
            roleWarnings: [],
          },
        }),
      )
      return {
        completed: startup.then(() => childDone.promise),
        async stop() {},
      }
    },
  })

  const running = frontend.run()
  await waitFor(() => output.includes('alpha') && input !== undefined, 'first dashboard frame')
  await waitFor(() => repositoryReads.some((sinceSeq) => sinceSeq > 0), 'incremental repo cursor')
  // The frontend journal cursor still advances incrementally. The independent
  // observation scan legitimately performs its own full repository reduction.
  expect(repositoryReads.filter((sinceSeq) => sinceSeq > 0).length).toBeGreaterThan(0)

  // Occupy the Store-action queue, then navigate and confirm abort while both
  // that action and the child kernel remain unresolved.
  input!({ type: 'text', text: 'i' })
  await intakeEntered.promise
  input!({ type: 'text', text: 'p' })
  input!({ type: 'text', text: 'm' })
  input!({ type: 'text', text: 'h' })
  input!({ type: 'down' })
  input!({ type: 'enter' })
  expect(output).toContain('Keys: d discard  a abort  Esc back')
  input!({ type: 'escape' })
  input!({ type: 'text', text: 'a' })
  expect(output).toContain('Abort alpha and delete its workspace')
  input!({ type: 'enter' })
  input!({ type: 'down' })
  input!({ type: 'text', text: 'd' })
  expect(output).toContain('beta')

  releaseIntake.resolve()
  await waitFor(async () => {
    const alpha = await backing.getEvents('alpha')
    const beta = await backing.getEvents('beta')
    return (
      alpha.some((event) => event.type === 'build.abort-requested') &&
      beta.some((event) => event.type === 'build.discard-requested')
    )
  }, 'captured build-control writes')
  const alphaEvents = await backing.getEvents('alpha')
  const betaEvents = await backing.getEvents('beta')
  expect(alphaEvents.filter((event) => event.type === 'build.abort-requested')).toHaveLength(1)
  expect(betaEvents.some((event) => event.type === 'build.abort-requested')).toBe(false)
  expect(betaEvents.some((event) => event.type === 'build.discard-requested')).toBe(true)
  let repoEvents = await backing.getRepoEvents(repo)
  expect(
    repoEvents.some(
      (event) =>
        event.type === 'dispatcher.operator-reported' &&
        event.payload.message === 'build alpha: abort requested',
    ),
  ).toBe(true)
  expect(
    repoEvents.some(
      (event) => event.type === 'dispatcher.intake-set' && event.payload.enabled === false,
    ),
  ).toBe(true)
  expect(
    repoEvents.some(
      (event) => event.type === 'dispatcher.pause-set' && event.payload.enabled === true,
    ),
  ).toBe(true)
  expect(
    repoEvents.some(
      (event) =>
        event.type === 'dispatcher.auto-merge-default-set' && event.payload.enabled === true,
    ),
  ).toBe(true)
  expect(repoEvents.some((event) => event.type === 'harvest.pause-requested')).toBe(true)

  // Resume and countermand the Harvest gate while the child is still gated.
  input!({ type: 'up' })
  input!({ type: 'up' })
  input!({ type: 'text', text: 'r' })
  input!({ type: 'text', text: 'h' })
  await waitFor(async () => {
    repoEvents = await backing.getRepoEvents(repo)
    return (
      repoEvents.some(
        (event) => event.type === 'dispatcher.pause-set' && event.payload.enabled === false,
      ) && repoEvents.some((event) => event.type === 'harvest.resume-requested')
    )
  }, 'resume controls')

  input!({ type: 'interrupt' })
  expect(output).toContain('\x1b[?1049l')
  childDone.resolve({ outcome: 'forced', exitCode: 137, signal: 'SIGKILL' })
  await running
})

test('frontend owns live observation pressure and retains the last factual sample on refresh failure', async () => {
  const repo = '/pressure-repo'
  const backing = new MemoryBuildStore()
  await backing.ensureRepo(repo)
  await backing.createBuild({ slug: 'source', repo })
  await backing.append('source', {
    actor: agentActor('implement', 's_observe_1'),
    type: 'observation.recorded',
    payload: { id: 'obs-1', kind: 'followup', summary: 'first pending observation' },
  })

  let failNextObservationRead = false
  const store = new Proxy(backing, {
    get(target, property) {
      if (property === 'getEvents') {
        return async (...args: Parameters<BuildStore['getEvents']>) => {
          if (failNextObservationRead) {
            failNextObservationRead = false
            throw new Error('observation stream unavailable')
          }
          return target.getEvents(...args)
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as BuildStore

  const childDone = deferred<DispatchChildResult>()
  const frames: Array<{ current: number; limit: number; warnings: readonly string[] }> = []
  let output = ''
  const write = (chunk: string): void => {
    output += chunk
  }
  // The first failed sample must produce only a diagnostic, never a complete
  // dashboard model carrying a fabricated zero.
  failNextObservationRead = true
  const frontend = new DispatchFrontend({
    repo,
    storeRef: 'memory',
    store,
    env: {},
    terminal: {
      write,
      modes: createTerminalModeController(write, write),
      columns: 100,
      rows: 24,
      interactive: true,
    },
    input: { start: () => () => {} },
    once: false,
    resolveDashboardRenderer: () => (model) => {
      frames.push({
        current: model.observations.current,
        limit: model.observations.limit,
        warnings: model.warningLines ?? [],
      })
      return ['frame']
    },
    launchChild: ({ run }) => {
      const startup = backing
        .appendRepoWithArtifacts(
          repo,
          [
            {
              kind: 'dispatcher-effective-config',
              content: JSON.stringify({
                capacity: 1,
                roles: { default: { runtime: 'claude' } },
                policy: { harvestThreshold: 7 },
                tickets: { source: 'file', readyState: 'ready' },
              }),
            },
          ],
          (artifacts) => ({
            actor: DISPATCHER,
            type: 'dispatcher.run-started',
            payload: {
              run,
              pid: 999,
              effectiveConfig: { kind: artifacts[0]!.kind, rev: artifacts[0]!.revision },
              roleWarnings: [],
            },
          }),
        )
        .then(() =>
          backing.appendRepo(repo, {
            actor: DISPATCHER,
            type: 'dispatcher.tick-completed',
            payload: {
              run,
              queued: 0,
              observations: 99,
              counters: tickCounters,
              janitorDiagnostics: [],
              ticketDiagnostics: [],
              dependencyDiagnostics: [],
            },
          }),
        )
      return { completed: startup.then(() => childDone.promise), async stop() {} }
    },
  })

  const running = frontend.run()
  await waitFor(
    () => output.includes('observation stream unavailable'),
    'initial refresh diagnostic',
  )
  expect(frames).toHaveLength(0)
  await waitFor(
    () => frames.some((frame) => frame.current === 1 && frame.limit === 7),
    'first factual pressure sample',
  )
  expect(frames.some((frame) => frame.current === 99)).toBe(false)

  await backing.append('source', {
    actor: agentActor('implement', 's_observe_2'),
    type: 'observation.recorded',
    payload: { id: 'obs-2', kind: 'followup', summary: 'second pending observation' },
  })
  await waitFor(() => frames.some((frame) => frame.current === 2), 'recorded observation refresh')

  const firstClaim = await backing.appendRepoWithArtifacts(
    repo,
    [{ kind: 'harvest-scan', content: '{}' }],
    (artifacts) => ({
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_dispositioned',
        observations: [
          { build: 'source', seq: 1 },
          { build: 'source', seq: 2 },
        ],
        scan: { kind: artifacts[0]!.kind, rev: artifacts[0]!.revision },
      },
    }),
  )
  await waitFor(() => frames.some((frame) => frame.current === 0), 'claimed pressure refresh')
  await backing.appendRepoWithArtifacts(
    repo,
    [{ kind: 'harvest-report', content: '{}' }],
    (artifacts) => ({
      actor: KERNEL,
      type: 'harvest.completed',
      payload: {
        run: 'h_dispositioned',
        dispositions: [
          {
            occurrence: { build: 'source', seq: 1 },
            action: 'suppressed',
            proposalKey: 'first',
          },
          {
            occurrence: { build: 'source', seq: 2 },
            action: 'suppressed',
            proposalKey: 'second',
          },
        ],
        report: { kind: artifacts[0]!.kind, rev: artifacts[0]!.revision },
      },
    }),
  )
  expect(firstClaim.event.type).toBe('harvest.started')

  await backing.append('source', {
    actor: agentActor('implement', 's_observe_3'),
    type: 'observation.recorded',
    payload: { id: 'obs-3', kind: 'followup', summary: 'released observation' },
  })
  await waitFor(() => frames.some((frame) => frame.current === 1), 'new pending observation')
  const beforeSecondClaim = frames.length
  await backing.appendRepoWithArtifacts(
    repo,
    [{ kind: 'harvest-scan', content: '{}' }],
    (artifacts) => ({
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_released',
        observations: [{ build: 'source', seq: 3 }],
        scan: { kind: artifacts[0]!.kind, rev: artifacts[0]!.revision },
      },
    }),
  )
  await waitFor(
    () => frames.slice(beforeSecondClaim).some((frame) => frame.current === 0),
    'second claimed refresh',
  )
  await backing.appendRepo(repo, {
    actor: KERNEL,
    type: 'harvest.failed',
    payload: {
      run: 'h_released',
      step: 'file',
      attempt: 1,
      error: 'ticket provider unavailable',
      willRetry: false,
    },
  })
  for (const attempt of [1, 2]) {
    await backing.appendRepo(repo, {
      actor: KERNEL,
      type: 'harvest.recovery-requested',
      payload: { run: 'h_released', attempt, limit: 2 },
    })
    await backing.appendRepo(repo, {
      actor: KERNEL,
      type: 'harvest.resumed',
      payload: {},
    })
    await backing.appendRepo(repo, {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_released',
        step: 'file',
        attempt: attempt + 1,
        error: 'ticket provider unavailable',
        willRetry: false,
      },
    })
  }
  const beforeRelease = frames.length
  await backing.appendRepo(repo, {
    actor: KERNEL,
    type: 'harvest.recovery-exhausted',
    payload: {
      run: 'h_released',
      step: 'file',
      error: 'ticket provider unavailable',
      attempts: 2,
      limit: 2,
      releasedObservations: [{ build: 'source', seq: 3 }],
      committedDispositions: [],
      pendingProposals: [
        {
          proposalKey: 'released',
          action: 'create',
          observations: [{ build: 'source', seq: 3 }],
        },
      ],
    },
  })
  await waitFor(
    () => frames.slice(beforeRelease).some((frame) => frame.current === 1),
    'released pressure refresh',
  )

  const repoEventsBeforeFailure = (await backing.getRepoEvents(repo)).length
  const buildEventsBeforeFailure = (await backing.getEvents('source')).length
  failNextObservationRead = true
  await waitFor(
    () =>
      frames.some(
        (frame) =>
          frame.current === 1 &&
          frame.warnings.some((warning) => warning.includes('observation stream unavailable')),
      ),
    'retained pressure refresh diagnostic',
  )
  expect((await backing.getRepoEvents(repo)).length).toBe(repoEventsBeforeFailure)
  expect((await backing.getEvents('source')).length).toBe(buildEventsBeforeFailure)

  childDone.resolve({ outcome: 'normal', exitCode: 0 })
  await running
})

test('frontend rejects an abort confirmation that becomes terminal while its action is queued', async () => {
  const repo = '/stale-abort-repo'
  const backing = new MemoryBuildStore()
  await backing.ensureRepo(repo)
  for (const slug of ['alpha', 'beta']) {
    const ticket = { source: 'fake', id: slug, title: slug }
    await backing.createBuild({ slug, repo, ticket, branch: `ab/${slug}` })
    await backing.append(slug, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { repo, ticket, baseBranch: 'main' },
    })
  }

  const intakeEntered = deferred<void>()
  const releaseIntake = deferred<void>()
  let delayed = false
  const store = new Proxy(backing, {
    get(target, property) {
      if (property === 'appendRepo') {
        return async (...args: Parameters<BuildStore['appendRepo']>) => {
          if (!delayed && args[1].type === 'dispatcher.intake-set') {
            delayed = true
            intakeEntered.resolve()
            await releaseIntake.promise
          }
          return target.appendRepo(...args)
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as BuildStore

  let input: ((event: TerminalInputEvent) => void) | undefined
  let output = ''
  const write = (chunk: string): void => {
    output += chunk
  }
  const childDone = deferred<DispatchChildResult>()
  let confirmationSlug: string | undefined
  const frontend = new DispatchFrontend({
    repo,
    storeRef: 'memory',
    store,
    env: { USER: 'operator' },
    terminal: {
      write,
      modes: createTerminalModeController(write, write),
      columns: 100,
      rows: 30,
      interactive: true,
    },
    input: {
      start(handler) {
        input = handler
        return () => {
          input = undefined
        }
      },
    },
    once: false,
    resolveDashboardRenderer: () => (model, options) => {
      confirmationSlug = model.abortConfirmation?.slug
      return renderDashboard(model, options)
    },
    launchChild: ({ run }) => {
      const startup = backing.appendRepoWithArtifacts(
        repo,
        [
          {
            kind: 'dispatcher-effective-config',
            content: JSON.stringify({
              capacity: 1,
              roles: { default: { runtime: 'claude' } },
              tickets: { source: 'file', readyState: 'ready' },
            }),
          },
        ],
        (artifacts) => ({
          actor: DISPATCHER,
          type: 'dispatcher.run-started',
          payload: {
            run,
            pid: 999,
            effectiveConfig: { kind: artifacts[0]!.kind, rev: artifacts[0]!.revision },
            roleWarnings: [],
          },
        }),
      )
      return {
        completed: startup.then(() => childDone.promise),
        async stop() {},
      }
    },
  })

  const running = frontend.run()
  await waitFor(() => output.includes('alpha') && input !== undefined, 'first dashboard frame')

  input!({ type: 'text', text: 'i' })
  await intakeEntered.promise
  input!({ type: 'down' })
  input!({ type: 'text', text: 'a' })
  expect(output).toContain('Abort alpha and delete its workspace')
  expect(confirmationSlug).toBe('alpha')

  await backing.append('alpha', {
    actor: DISPATCHER,
    type: 'build.completed',
    payload: { outcome: 'abandoned' },
  })
  input!({ type: 'enter' })

  // The stale alpha confirmation is queued, but a new beta confirmation is
  // process-local state and must survive alpha's eventual stale dismissal.
  input!({ type: 'down' })
  input!({ type: 'text', text: 'a' })
  expect(confirmationSlug).toBe('beta')
  releaseIntake.resolve()

  await waitFor(async () => {
    const events = await backing.getRepoEvents(repo)
    return events.some(
      (event) =>
        event.type === 'dispatcher.operator-reported' &&
        event.payload.level === 'warning' &&
        event.payload.message ===
          'build alpha: abort confirmation dismissed because the build state changed',
    )
  }, 'stale abort warning')

  const buildEvents = await backing.getEvents('alpha')
  expect(buildEvents.some((event) => event.type === 'build.abort-requested')).toBe(false)
  expect(confirmationSlug).toBe('beta')
  const repoEvents = await backing.getRepoEvents(repo)
  expect(
    repoEvents.some(
      (event) =>
        event.type === 'dispatcher.operator-reported' &&
        (event.payload.message === 'build alpha: abort requested' ||
          event.payload.message === 'build alpha: action recorded'),
    ),
  ).toBe(false)
  await waitFor(
    () => output.includes('abort confirmation dismissed because the build state changed'),
    'operator-visible stale abort warning',
  )

  input!({ type: 'interrupt' })
  childDone.resolve({ outcome: 'normal', exitCode: 0 })
  await running
})

test('frontend preserves unsolicited child failure detail and process evidence', async () => {
  const repo = '/failed-repo'
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  const childDone = deferred<DispatchChildResult>()
  const frontend = new DispatchFrontend({
    repo,
    storeRef: 'memory',
    store,
    env: {},
    terminal: {
      write: () => {},
      modes: createTerminalModeController(
        () => {},
        () => {},
      ),
      columns: 80,
      rows: 24,
      interactive: true,
    },
    input: { start: () => () => {} },
    once: false,
    launchChild: () => ({ completed: childDone.promise, async stop() {} }),
  })

  const running = frontend.run()
  childDone.resolve({
    outcome: 'abnormal',
    exitCode: 2,
    signal: 'SIGTERM',
    error: 'adapter startup exploded',
  })
  await expect(running).rejects.toThrow(
    'dispatcher kernel failed: adapter startup exploded (exit code 2, signal SIGTERM)',
  )
})

test('frontend keeps the durable effective config across rejection and adopts a published reload', async () => {
  const repo = '/reload-repo'
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  const childDone = deferred<DispatchChildResult>()
  const frames: Array<{
    capacity: number
    warnings: readonly string[]
    availableUpgrade?: string
  }> = []
  let runId = ''
  const write = (_chunk: string): void => {}
  const configContent = (capacity: number): string =>
    JSON.stringify({
      capacity,
      roles: { default: { runtime: 'claude' } },
      tickets: { source: 'file', readyState: 'ready' },
    })
  const frontend = new DispatchFrontend({
    repo,
    storeRef: 'memory',
    store,
    env: {},
    terminal: {
      write,
      modes: createTerminalModeController(write, write),
      columns: 80,
      rows: 24,
      interactive: true,
    },
    input: { start: () => () => {} },
    once: false,
    resolveDashboardRenderer: () => (model) => {
      frames.push({
        capacity: model.active.limit,
        warnings: model.warningLines ?? [],
        ...(model.availableUpgrade !== undefined
          ? { availableUpgrade: model.availableUpgrade }
          : {}),
      })
      return ['frame']
    },
    launchChild: ({ run }) => {
      runId = run
      const startup = store.appendRepoWithArtifacts(
        repo,
        [{ kind: 'dispatcher-effective-config', content: configContent(2) }],
        (artifacts) => ({
          actor: DISPATCHER,
          type: 'dispatcher.run-started',
          payload: {
            run,
            pid: 999,
            effectiveConfig: {
              kind: artifacts[0]!.kind,
              rev: artifacts[0]!.revision,
            },
            roleWarnings: [],
          },
        }),
      )
      return {
        completed: startup.then(() => childDone.promise),
        async stop() {},
      }
    },
  })

  const running = frontend.run()
  await waitFor(() => frames.some((frame) => frame.capacity === 2), 'startup effective config')
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.config-rejected',
    payload: { run: runId, error: 'invalid capacity on disk' },
  })
  await waitFor(
    () => frames.some((frame) => frame.warnings.some((line) => line.includes('rejected'))),
    'rejected reload notice',
  )
  expect(frames.at(-1)?.capacity).toBe(2)

  await store.appendRepoWithArtifacts(
    repo,
    [
      { kind: 'dispatcher-config', content: 'capacity = 3' },
      { kind: 'dispatcher-effective-config', content: configContent(3) },
    ],
    (artifacts) => ({
      actor: DISPATCHER,
      type: 'dispatcher.config-reloaded',
      payload: {
        artifact: { kind: artifacts[0]!.kind, rev: artifacts[0]!.revision },
        restartRequired: [],
        effectiveChanged: true,
        run: runId,
        effectiveConfig: { kind: artifacts[1]!.kind, rev: artifacts[1]!.revision },
        roleWarnings: [],
      },
    }),
  )
  await waitFor(() => frames.some((frame) => frame.capacity === 3), 'accepted effective config')

  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.upgrade-available',
    payload: { run: runId, version: '0.5.0' },
  })
  await waitFor(
    () => frames.some((frame) => frame.availableUpgrade === '0.5.0'),
    'durable upgrade notice',
  )

  childDone.resolve({ outcome: 'normal', exitCode: 0 })
  await running
})

test('frontend elapsed repaint cadence advances while the child remains gated', async () => {
  const repo = '/timer-repo'
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  const childDone = deferred<DispatchChildResult>()
  const paints: number[] = []
  let now = 1_700_000_000_000
  const write = (_chunk: string): void => {}
  const frontend = new DispatchFrontend({
    repo,
    storeRef: 'memory',
    store,
    env: {},
    terminal: {
      write,
      modes: createTerminalModeController(write, write),
      columns: 80,
      rows: 24,
      interactive: true,
    },
    input: { start: () => () => {} },
    once: false,
    clock: () => {
      now += 1_000
      return new Date(now)
    },
    resolveDashboardRenderer: () => (_model, opts) => {
      paints.push(opts.now)
      return ['frame']
    },
    launchChild: ({ run }) => {
      const startup = store.appendRepoWithArtifacts(
        repo,
        [
          {
            kind: 'dispatcher-effective-config',
            content: JSON.stringify({
              capacity: 1,
              roles: { default: { runtime: 'claude' } },
              tickets: { source: 'file', readyState: 'ready' },
            }),
          },
        ],
        (artifacts) => ({
          actor: DISPATCHER,
          type: 'dispatcher.run-started',
          payload: {
            run,
            pid: 999,
            effectiveConfig: {
              kind: artifacts[0]!.kind,
              rev: artifacts[0]!.revision,
            },
            roleWarnings: [],
          },
        }),
      )
      return {
        completed: startup.then(() => childDone.promise),
        async stop() {},
      }
    },
  })

  const running = frontend.run()
  await waitFor(() => paints.length >= 2, 'independent elapsed repaint ticks')
  expect(paints.at(-1)!).toBeGreaterThan(paints[0]!)
  childDone.resolve({ outcome: 'normal', exitCode: 0 })
  await running
})
