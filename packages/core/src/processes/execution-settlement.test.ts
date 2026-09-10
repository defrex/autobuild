import { describe, expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import type { AbEvent } from '../events/catalog'
import { MemoryBuildStore } from '../store/memory'
import { manualClock } from '../testing/fixed'
import type { BuildExecution, ExecutionObservation } from '../ports/workspace/build-execution'
import { openExecution, settleExecution } from './execution-settlement'

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
