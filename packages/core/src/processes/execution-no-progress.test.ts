import { expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { DISPATCHER, KERNEL, humanActor } from '../events/envelope'
import { parseConfig } from '../config/load'
import { sequentialIds } from '../ids'
import { checkIncremental } from '../kernel/incremental-contract'
import { MemoryBuildStore } from '../store/memory'
import { RepoViewStore } from './repo-view'
import {
  executionNoProgressReducer as reducer,
  executionProgress,
  ensureExecutionProgress,
} from './execution-no-progress'

const event = (type: string, payload: unknown = {}): AbEvent =>
  ({
    build: 'empty',
    seq: 1,
    ts: '2026-01-01T00:00:00Z',
    actor: DISPATCHER,
    type,
    payload,
  }) as AbEvent
const start = (instance: string) => event('execution.started', { instance })
const end = (instance: string, outcome = 'completed', exitCode: number | null | undefined = 0) =>
  event('execution.ended', { instance, outcome, exitCode })
const empty = (instance: string) => [start(instance), end(instance)]
const three = [...empty('a'), ...empty('b'), ...empty('c')]
const raise = event('escalation.raised', {
  id: 'guard',
  source: 'policy',
  policyCause: 'execution-no-progress',
})
const answer = (id = 'guard', resolution = 'retry') =>
  event('escalation.answered', { id, resolution })

function numbered(events: AbEvent[]) {
  return events.map((e, i) => ({ ...e, seq: i + 1 }))
}

test('exact threshold, open executions, unmatched and duplicate ends', () => {
  expect(reducer.reduce(three).count).toBe(3)
  expect(reducer.reduce([...three, end('c'), end('stray')]).count).toBe(3)
  expect(reducer.reduce([...three, start('d')]).count).toBe(3)
  expect(reducer.reduce([...three, start('d'), start('e'), end('d')]).count).toBe(0)
})

for (const [type, classification] of Object.entries(executionProgress)) {
  if (
    ['execution.started', 'execution.ended', 'escalation.raised', 'escalation.answered'].includes(
      type,
    )
  )
    continue
  test(`${type} is explicitly ${classification}, inside and between executions`, () => {
    const fact = event(type)
    const ignored = classification === 'bookkeeping'
    expect(reducer.reduce([...three, fact]).count).toBe(ignored ? 3 : 0)
    expect(reducer.reduce([...three, start('d'), fact, end('d')]).count).toBe(ignored ? 4 : 0)
  })
}

for (const [outcome, exitCode] of [
  ['completed', 1],
  ['completed', null],
  ['stopped', 0],
  ['lost', 0],
] as const) {
  test(`${outcome}/${exitCode} breaks the streak without consuming an allowance`, () => {
    expect(
      reducer.reduce([...three, start('d'), end('d', outcome, exitCode), ...empty('e')]).count,
    ).toBe(1)
  })
}
test('missing historical exit code cannot count', () => {
  expect(
    reducer.reduce([
      ...three,
      start('d'),
      event('execution.ended', { instance: 'd', outcome: 'completed' }),
    ]).count,
  ).toBe(0)
})

test('guidance/retry reset only matching open raises, including an active baseline', () => {
  for (const resolution of ['retry', 'guidance']) {
    expect(reducer.reduce([...three, raise, answer('other')])).toMatchObject({
      count: 3,
      open: ['guard'],
    })
    expect(
      reducer.reduce([...three, raise, start('d'), answer('guard', resolution), end('d')]),
    ).toMatchObject({ count: 0, open: [], active: null })
    expect(reducer.reduce([...three, answer()]).count).toBe(3)
  }
})

test('prefix, partition and JSON snapshot equivalence across third end, raise and answer', () => {
  checkIncremental(
    reducer,
    numbered([
      ...three,
      raise,
      answer(),
      ...empty('d'),
      start('e'),
      event('phase.failed'),
      end('e'),
      ...empty('f'),
    ]),
  )
})

async function fixture() {
  const backing = new MemoryBuildStore()
  await backing.createBuild({ slug: 'empty', repo: 'repo' })
  await backing.append('empty', {
    actor: DISPATCHER,
    type: 'build.created',
    payload: { ticket: { source: 'file', id: '1' }, repo: 'repo', baseBranch: 'main' },
  })
  await backing.append('empty', {
    actor: DISPATCHER,
    type: 'spec.imported',
    payload: { artifact: { kind: 'spec', rev: 0 }, ticket: { source: 'file', id: '1' } },
  })
  for (const instance of ['a', 'b', 'c']) {
    await backing.append('empty', {
      actor: DISPATCHER,
      type: 'execution.started',
      payload: { instance, provider: 'fake', workspaceRef: 'ws' },
    })
    await backing.append('empty', {
      actor: DISPATCHER,
      type: 'execution.ended',
      payload: { instance, workspaceRef: 'ws', outcome: 'completed', exitCode: 0 },
    })
  }
  return {
    backing,
    store: new RepoViewStore(backing, { repo: 'repo' }),
    config: parseConfig('[tickets]\nsource="file"\nreadyState="ready"'),
  }
}

test('fresh views concurrently repair the crash gap once, restart and answers re-arm', async () => {
  const { backing, store, config } = await fixture()
  const ids = sequentialIds()
  expect(
    await Promise.all(
      [store, new RepoViewStore(backing, { repo: 'repo' })].map((view) =>
        ensureExecutionProgress(view, ids, 'empty', config),
      ),
    ),
  ).toEqual([false, false])
  const events = await backing.getEvents('empty')
  const raises = events.filter((e) => e.type === 'escalation.raised')
  expect(raises).toHaveLength(1)
  expect(raises[0]?.payload).toMatchObject({ policyCause: 'execution-no-progress', phase: 'setup' })
  expect(raises[0]?.payload.question).toContain('3 consecutive executions')
  expect(raises[0]?.payload.question).toContain('plan')

  const cold = new RepoViewStore(backing, { repo: 'repo' })
  expect(await ensureExecutionProgress(cold, ids, 'empty', config)).toBe(false)
  await backing.append('empty', {
    actor: humanActor('operator'),
    type: 'escalation.answered',
    payload: { id: raises[0]!.payload.id, resolution: 'retry', answer: 'retry' },
  })
  expect(await ensureExecutionProgress(cold, ids, 'empty', config)).toBe(true)
})

test('pending abort remains executable while blocked, then terminal work stays parked', async () => {
  const { backing, store, config } = await fixture()
  const ids = sequentialIds()
  await ensureExecutionProgress(store, ids, 'empty', config)
  await backing.append('empty', {
    actor: humanActor('operator'),
    type: 'build.abort-requested',
    payload: {},
  })
  expect(await ensureExecutionProgress(store, ids, 'empty', config)).toBe(true)
  await backing.append('empty', { actor: KERNEL, type: 'build.aborted', payload: {} })
  expect(await ensureExecutionProgress(store, ids, 'empty', config)).toBe(false)
})

test('a concurrent progress fact defeats a stale escalation append and recomputes the allowance', async () => {
  const { store, backing, config } = await fixture()
  let raced = false
  const contended = new Proxy(store, {
    get(target, key) {
      if (key === 'appendIfCurrent')
        return async (...args: Parameters<RepoViewStore['appendIfCurrent']>) => {
          if (!raced) {
            raced = true
            await backing.append('empty', {
              actor: KERNEL,
              type: 'plan.started',
              payload: { round: 1 },
            })
          }
          return target.appendIfCurrent(...args)
        }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  expect(await ensureExecutionProgress(contended, sequentialIds(), 'empty', config)).toBe(true)
  expect(raced).toBe(true)
  expect((await backing.getEvents('empty')).filter((e) => e.type === 'escalation.raised')).toEqual(
    [],
  )
})

test('three harmless parked completions do not manufacture an escalation', async () => {
  const { backing, store, config } = await fixture()
  await backing.append('empty', { actor: KERNEL, type: 'build.paused', payload: {} })
  for (const instance of ['d', 'e', 'f']) {
    await backing.append('empty', {
      actor: DISPATCHER,
      type: 'execution.started',
      payload: { instance, provider: 'fake', workspaceRef: 'ws' },
    })
    await backing.append('empty', {
      actor: DISPATCHER,
      type: 'execution.ended',
      payload: { instance, workspaceRef: 'ws', outcome: 'completed', exitCode: 0 },
    })
  }
  expect(await ensureExecutionProgress(store, sequentialIds(), 'empty', config)).toBe(true)
  expect((await store.buildFacts('empty')).executionNoProgress.count).toBe(3)
  expect((await backing.getEvents('empty')).filter((e) => e.type === 'escalation.raised')).toEqual(
    [],
  )
})

test('publication backoff failures cannot exhaust the empty-execution guard', () => {
  const log: AbEvent[] = []
  for (let attempt = 1; attempt <= 7; attempt++) {
    log.push(start(`retry-${attempt}`))
    log.push(
      event(attempt === 7 ? 'publication.retry-exhausted' : 'publication.retry-scheduled', {
        operation: 'restack',
        rewriteId: 'r',
        round: 1,
        anchor: 0,
        failure: attempt,
        error: 'HTTP 503',
        ...(attempt === 7 ? {} : { retryAt: '2026-01-01T00:01:00.000Z' }),
      }),
    )
    log.push(end(`retry-${attempt}`))
    expect(reducer.reduce(log).count).toBe(0)
  }
  expect(executionProgress['publication.retry-scheduled']).toBe('failure')
  expect(executionProgress['publication.retry-exhausted']).toBe('failure')
})
