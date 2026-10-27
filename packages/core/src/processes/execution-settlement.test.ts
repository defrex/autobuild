import { executionNoProgressReducer } from './execution-no-progress'
import { describe, expect, test } from 'bun:test'
import { RUNTIME_IDENTITY } from '../runtime-identity'
import { KERNEL, DISPATCHER } from '../events/envelope'
import type { AbEvent } from '../events/catalog'
import { MemoryBuildStore } from '../store/memory'
import { manualClock } from '../testing/fixed'
import type { BuildExecution, ExecutionObservation } from '../ports/workspace/build-execution'
import { openExecution, settleExecution, settleOpenExecution } from './execution-settlement'

function started(over: { instance?: string; commandId?: string } = {}): AbEvent {
  return {
    type: 'execution.started',
    payload: {
      provider: 'remote-test',
      workspaceRef: 'sandbox-g0',
      instance: over.instance ?? 'instance-1',
      environmentId: 'sandbox-g0',
      sessionId: 'session-1',
      ...(over.commandId !== undefined ? { commandId: over.commandId } : {}),
    },
  } as unknown as AbEvent
}

function ended(instance: string, outcome: 'completed' | 'stopped' | 'lost'): AbEvent {
  return {
    type: 'execution.ended',
    payload: {
      instance,
      workspaceRef: 'sandbox-g0',
      outcome,
      ...(outcome === 'lost' ? {} : { exitCode: 0 }),
    },
  } as unknown as AbEvent
}

describe('openExecution', () => {
  test('the latest started without a following instance-matched end is open', () => {
    const open = openExecution([
      started({ instance: 'a', commandId: 'c1' }),
      started({ instance: 'b', commandId: 'c2' }),
    ])
    expect(open?.instance).toBe('b')
    expect(open?.commandId).toBe('c2')
    expect(open?.provider).toBe('remote-test')
  })

  test('an ended fact for a different instance does not close a newer execution', () => {
    const open = openExecution([
      started({ instance: 'old', commandId: 'c0' }),
      started({ instance: 'new', commandId: 'c1' }),
      ended('other', 'completed'),
    ])
    expect(open?.instance).toBe('new')
  })

  test('an instance-matched end closes the execution', () => {
    expect(openExecution([started({ instance: 'a' }), ended('a', 'completed')])).toBeNull()
  })

  test('an empty log has no open execution', () => {
    expect(openExecution([])).toBeNull()
  })
})

describe('settleExecution', () => {
  function harness(observation: ExecutionObservation | Error) {
    const clock = manualClock()
    const store = new MemoryBuildStore({ clock })
    const settled: string[] = []
    const observed: unknown[] = []
    const execution: BuildExecution = {
      async start() {
        throw new Error('not used')
      },
      async observe(identity) {
        observed.push(identity)
        if (observation instanceof Error) throw observation
        return observation
      },
    }
    return {
      store,
      execution,
      observed,
      settled,
      settlePublication: async (slug: string) => {
        settled.push(slug)
      },
      async seed(): Promise<void> {
        await store.createBuild({ slug: 'build', repo: 'repo', branch: 'ab/build' })
      },
    }
  }

  test('missing-credential attention is durable and deduplicated while exits still release leases and settle publication', async () => {
    const attention =
      'Missing credentials: account "review" (REVIEW_TOKEN): renew with claude setup-token'
    let observation: ExecutionObservation = { state: 'running', attention }
    const h = harness(observation)
    h.execution.observe = async () => observation
    await h.seed()
    await h.store.claimLease('build', 'i1', 60_000)
    await h.store.append('build', {
      actor: DISPATCHER,
      type: 'execution.started',
      payload: {
        provider: 'remote-test',
        workspaceRef: 'sandbox-g0',
        instance: 'i1',
        commandId: 'cmd-1',
      },
    })
    const settle = async () => settleExecution(h, 'build', await h.store.getEvents('build'))
    expect(await settle()).toBe('running')
    expect(await settle()).toBe('running')
    const blocked = await h.store.getEvents('build')
    const escalations = blocked.filter((event) => event.type === 'escalation.raised')
    expect(escalations).toHaveLength(1)
    expect(escalations[0]!.payload.question).toBe(attention)
    expect((await h.store.getBuild('build'))!.lease?.holder).toBe('i1')
    observation = { state: 'ended', exitCode: 0, attention }
    expect(await settle()).toBe('settled')
    expect((await h.store.getBuild('build'))!.lease).toBeUndefined()
    expect(h.settled).toEqual(['build'])
    expect(
      (await h.store.getEvents('build')).filter((event) => event.type === 'escalation.raised'),
    ).toHaveLength(1)
    expect(await settle()).toBe('settled')
    expect(h.settled).toEqual(['build'])
  })

  for (const exitCode of [0, 1]) {
    test(`durable relaunch intent survives supervisor loss; exit ${exitCode} remains factual`, async () => {
      const h = harness({ state: 'ended', exitCode })
      await h.seed()
      const start = started({ instance: 'i1', commandId: 'cmd-1' })
      await h.store.append('build', {
        actor: DISPATCHER,
        type: 'execution.started',
        payload: start.payload as never,
      })
      const runtime = RUNTIME_IDENTITY
      await h.store.append('build', {
        actor: DISPATCHER,
        type: 'execution.drain-authorized',
        payload: {
          instance: 'i1',
          correlation: 'h',
          run: 'old',
          runtime,
          targetRuntime: { ...runtime, commit: 'f'.repeat(40) },
        },
      })
      await h.store.append('build', {
        actor: KERNEL,
        type: 'execution.relaunch-requested',
        payload: {
          instance: 'i1',
          correlation: 'h',
          from: runtime,
          to: { ...runtime, commit: 'f'.repeat(40) },
        },
      })
      await h.store.claimLease('build', 'i1', 60_000)
      await settleExecution(
        { store: h.store, execution: h.execution },
        'build',
        await h.store.getEvents('build'),
      )
      const events = await h.store.getEvents('build')
      expect(events.findLast((e) => e.type === 'execution.ended')?.payload).toMatchObject({
        instance: 'i1',
        outcome: exitCode === 0 ? 'relaunch' : 'completed',
        exitCode,
      })
      expect(executionNoProgressReducer.reduce(events).count).toBe(0)
      expect((await h.store.getBuild('build'))?.lease).toBeUndefined()
    })
  }

  test('running observations write nothing', async () => {
    const h = harness({ state: 'running' })
    await h.seed()
    const result = await settleExecution(
      {
        store: h.store,
        execution: h.execution,
        settlePublication: h.settlePublication,
      },
      'build',
      [started({ instance: 'i1', commandId: 'cmd-1' })],
    )
    expect(result).toBe('running')
    expect((await h.store.getEvents('build')).some((e) => e.type === 'execution.ended')).toBe(false)
    expect(h.settled).toEqual([])
  })

  test('a proved end appends the recorded completion, releases the exact lease, and settles publication', async () => {
    const h = harness({ state: 'ended', exitCode: 0 })
    await h.seed()
    expect(await h.store.claimLease('build', 'i1', 60_000)).toBe(true)
    const result = await settleExecution(
      {
        store: h.store,
        execution: h.execution,
        settlePublication: h.settlePublication,
      },
      'build',
      [started({ instance: 'i1', commandId: 'cmd-1' })],
    )
    expect(result).toBe('settled')
    const events = await h.store.getEvents('build')
    const ended = events.findLast((e) => e.type === 'execution.ended')
    expect(ended?.payload).toMatchObject({ instance: 'i1', outcome: 'completed', exitCode: 0 })
    expect(ended?.actor).toEqual(DISPATCHER)
    expect((await h.store.getBuild('build'))?.lease).toBeUndefined()
    expect(h.settled).toEqual(['build'])
  })

  test('a lease held by a DIFFERENT instance is never released', async () => {
    const h = harness({ state: 'ended', exitCode: 1 })
    await h.seed()
    expect(await h.store.claimLease('build', 'runner-new', 60_000)).toBe(true)
    await settleExecution({ store: h.store, execution: h.execution }, 'build', [
      started({ instance: 'i1', commandId: 'cmd-1' }),
    ])
    expect((await h.store.getBuild('build'))?.lease?.holder).toBe('runner-new')
  })

  test('a proved loss ends the execution lost, releases the lease, and never settles publication', async () => {
    const h = harness({ state: 'lost' })
    await h.seed()
    expect(await h.store.claimLease('build', 'i1', 60_000)).toBe(true)
    const result = await settleExecution(
      {
        store: h.store,
        execution: h.execution,
        settlePublication: h.settlePublication,
      },
      'build',
      [started({ instance: 'i1', commandId: 'cmd-1' })],
    )
    expect(result).toBe('lost')
    expect(
      (await h.store.getEvents('build')).findLast((e) => e.type === 'execution.ended')?.payload,
    ).toMatchObject({ instance: 'i1', outcome: 'lost' })
    expect((await h.store.getBuild('build'))?.lease).toBeUndefined()
    expect(h.settled).toEqual([])
  })

  test('observation errors are contained and read as running — never reap on an unknown', async () => {
    const h = harness(new Error('provider unreachable'))
    await h.seed()
    const result = await settleExecution({ store: h.store, execution: h.execution }, 'build', [
      started({ instance: 'i1', commandId: 'cmd-1' }),
    ])
    expect(result).toBe('running')
    // Observation errors append nothing durable.
    expect(await h.store.getEvents('build')).toHaveLength(0)
  })

  test('a legacy execution without a recorded command id supervises as before', async () => {
    const h = harness({ state: 'ended', exitCode: 0 })
    await h.seed()
    const result = await settleExecution(
      {
        store: h.store,
        execution: h.execution,
        settlePublication: h.settlePublication,
      },
      'build',
      [started({ instance: 'i1' })],
    )
    expect(result).toBe('running')
    expect(h.observed).toEqual([])
  })
})

describe('settleOpenExecution', () => {
  const observations: ExecutionObservation[] = [
    { state: 'running' },
    { state: 'ended', exitCode: 0 },
    { state: 'lost' },
  ]
  const logs: AbEvent[][] = [
    [],
    [started({ instance: 'a' })],
    [started({ instance: 'a', commandId: 'c1' })],
    [started({ instance: 'a', commandId: 'c1' }), ended('a', 'completed')],
    [started({ instance: 'a', commandId: 'c1' }), started({ instance: 'b', commandId: 'c2' })],
  ]

  test.each(
    logs.flatMap((_log, index) => observations.map((observation) => [index, observation] as const)),
  )(
    'settleExecution and settleOpenExecution agree: log %i, observation %p',
    async (index, observation) => {
      const events = logs[index]!
      const run = async (settle: 'events' | 'open') => {
        const store = new MemoryBuildStore({ clock: manualClock() })
        await store.createBuild({ slug: 'b', repo: 'r' })
        const execution: BuildExecution = {
          async start() {
            throw new Error('not used')
          },
          async observe() {
            return observation
          },
        }
        const result =
          settle === 'events'
            ? await settleExecution({ store, execution }, 'b', events)
            : await settleOpenExecution({ store, execution }, 'b', openExecution(events))
        return {
          result,
          appended: (await store.getEvents('b')).map((event) => [event.type, event.payload]),
        }
      }
      expect(await run('open')).toEqual(await run('events'))
    },
  )
})

test('provider-observed clean completions survive supervisor restart as empty executions', async () => {
  const store = new MemoryBuildStore()
  await store.createBuild({ slug: 'empty', repo: 'repo' })
  const execution: BuildExecution = {
    async start() {
      throw new Error('not used')
    },
    async observe() {
      return { state: 'ended', exitCode: 0 }
    },
  }
  for (const instance of ['a', 'b', 'c']) {
    const fact = started({ instance, commandId: `command-${instance}` })
    await store.append('empty', {
      actor: DISPATCHER,
      type: 'execution.started',
      payload: fact.payload as never,
    })
    await settleOpenExecution(
      { store, execution },
      'empty',
      openExecution(await store.getEvents('empty'))!,
    )
  }
  expect(executionNoProgressReducer.reduce(await store.getEvents('empty')).count).toBe(3)
})
