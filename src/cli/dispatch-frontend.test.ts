import { expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import type { BuildStore } from '../store/types'
import { MemoryBuildStore } from '../store/memory'
import { createTerminalModeController } from './terminal-restore'
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
  const incrementalAt = repositoryReads.findIndex((sinceSeq) => sinceSeq > 0)
  expect(repositoryReads.slice(incrementalAt).every((sinceSeq) => sinceSeq > 0)).toBe(true)

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
  const betaEvents = await backing.getEvents('beta')
  expect(betaEvents.some((event) => event.type === 'build.abort-requested')).toBe(false)
  expect(betaEvents.some((event) => event.type === 'build.discard-requested')).toBe(true)
  let repoEvents = await backing.getRepoEvents(repo)
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
