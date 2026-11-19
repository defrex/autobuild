import { describe, expect, test } from 'bun:test'
import { agentActor, KERNEL } from '../events/envelope'
import { delegationFactKey } from '../kernel/service-facts'
import { judgePreferenceReadBudget } from '../testing/reduced-read-budget'
import { sampleBuildInput } from './contract'
import { MemoryBuildStore } from './memory'
import {
  appendJudgePreference,
  JUDGE_APPEND_ATTEMPTS,
  JudgePreferenceContentionError,
  judgeLifecycleFacts,
  judgeScopeRefusal,
  judgeWriteRefusal,
  type JudgeScope,
  type JudgeWriteCandidate,
} from './judge-authority'

const SCOPE: JudgeScope = { build: 'b-1', panel: 'panel-1', judge: 2, session: 's_j2' }

function write(overrides: Partial<JudgeWriteCandidate> = {}, payload = {}): JudgeWriteCandidate {
  return {
    type: 'panel.preferred',
    actor: agentActor('judge', 's_j2'),
    payload: {
      panel: 'panel-1',
      judge: 2,
      session: 's_j2',
      preference: 'A',
      reason: 'clearer',
      ...payload,
    },
    ...overrides,
  }
}

const OPEN = { started: true, ended: false, preferred: false }

describe('judge write scope', () => {
  test('its own preference is in scope', () => {
    expect(judgeScopeRefusal(SCOPE, write())).toBeUndefined()
    expect(judgeWriteRefusal(SCOPE, write(), OPEN)).toBeUndefined()
  })

  test('any other type, actor or target is refused', () => {
    expect(judgeScopeRefusal(SCOPE, write({ type: 'panel.judged' }))).toBe(
      'a judge may append only panel.preferred',
    )
    expect(judgeScopeRefusal(SCOPE, write({ actor: KERNEL }))).toBe(
      'a judge writes only as its own judge session',
    )
    expect(judgeScopeRefusal(SCOPE, write({ actor: agentActor('implement', 's_j2') }))).toBe(
      'a judge writes only as its own judge session',
    )
    expect(judgeScopeRefusal(SCOPE, write({ actor: agentActor('judge', 's_other') }))).toBe(
      'a judge writes only as its own judge session',
    )
    expect(judgeScopeRefusal(SCOPE, write({ payload: null }))).toBe(
      'panel.preferred needs a payload',
    )
    expect(judgeScopeRefusal(SCOPE, write({}, { panel: 'panel-0' }))).toBe(
      'preference for another panel',
    )
    expect(judgeScopeRefusal(SCOPE, write({}, { judge: 3 }))).toBe('preference for another judge')
    expect(judgeScopeRefusal(SCOPE, write({}, { session: 's_other' }))).toBe(
      'preference for another session',
    )
  })

  test('the lifecycle refuses an unstarted, ended or already answered session', () => {
    expect(judgeWriteRefusal(SCOPE, write(), { ...OPEN, started: false })).toBe(
      'the judge session was never started',
    )
    expect(judgeWriteRefusal(SCOPE, write(), { ...OPEN, ended: true })).toBe(
      'the judge session has ended',
    )
    expect(judgeWriteRefusal(SCOPE, write(), { ...OPEN, preferred: true })).toBe(
      'this judge already recorded its preference',
    )
    expect(judgeWriteRefusal(SCOPE, write({ type: 'x' }), { ...OPEN, preferred: true })).toBe(
      'a judge may append only panel.preferred',
    )
  })

  test('lifecycle facts come from the delegation value', () => {
    const key = delegationFactKey('s_j2')
    expect(judgeLifecycleFacts({ sessions: {}, preferred: {} }, 's_j2')).toEqual({
      started: false,
      ended: false,
      preferred: false,
    })
    expect(
      judgeLifecycleFacts(
        {
          sessions: { [key]: { starts: [4], endings: [{ seq: 9, at: '2026-11-18T00:00:00Z' }] } },
          preferred: { [key]: true },
        },
        's_j2',
      ),
    ).toEqual({ started: true, ended: true, preferred: true })
  })
})

describe('atomic judge preference (AUT-1245)', () => {
  const BUILD = SCOPE.build
  const preferred = async (store: MemoryBuildStore) =>
    (await store.getEvents(BUILD)).filter((event) => event.type === 'panel.preferred')

  async function judging(sessions: string[] = [SCOPE.session]): Promise<MemoryBuildStore> {
    const store = new MemoryBuildStore()
    await store.createBuild(sampleBuildInput(BUILD))
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'panel.started',
      payload: {
        panel: SCOPE.panel,
        candidate: 'c'.repeat(40),
        baseline: 'b'.repeat(40),
        harnessPin: 'a'.repeat(40),
        purpose: 'clear prose',
        rubric: 'evals/rubric.md',
        harness: ['evals/**'],
        judges: 3,
      },
    })
    for (const [index, session] of sessions.entries())
      await store.append(BUILD, {
        actor: KERNEL,
        type: 'panel.judge-started',
        payload: {
          panel: SCOPE.panel,
          judge: index + 2,
          session,
          order: 'candidate-first',
          runner: 'scripted',
        },
      })
    return store
  }

  /** Hold every caller's delegation read until `parties` callers have read,
   * so each one decides on the same facts before any appends. */
  function barrier(store: MemoryBuildStore, parties: number): void {
    const read = store.getReducerValue.bind(store)
    let waiting = 0
    let release!: () => void
    const all = new Promise<void>((resolve) => {
      release = resolve
    })
    store.getReducerValue = async (scope, request) => {
      const value = await read(scope, request)
      if (waiting < parties) {
        waiting += 1
        if (waiting === parties) release()
        await all
      }
      return value
    }
  }

  test('a read advances the cursor to the head the conditional append compares against', async () => {
    const store = await judging()
    const value = await store.getReducerValue(
      { kind: 'build', slug: BUILD },
      { reducer: 'buildDelegation' },
    )
    expect(value.cursor).toBe((await store.getEvents(BUILD)).length)
  })

  test('one session racing two different preferences records exactly one', async () => {
    const store = await judging()
    barrier(store, 2)
    const outcomes = await Promise.all([
      appendJudgePreference(store, SCOPE, write({}, { preference: 'A' })),
      appendJudgePreference(store, SCOPE, write({}, { preference: 'B' })),
    ])
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['recorded', 'refused'])
    expect(outcomes.find((outcome) => outcome.kind === 'refused')).toEqual({
      kind: 'refused',
      reason: 'this judge already recorded its preference',
    })
    const durable = await preferred(store)
    expect(durable).toHaveLength(1)
    const winner = outcomes.find((outcome) => outcome.kind === 'recorded')!
    expect(winner.kind === 'recorded' && winner.event.seq).toBe(durable[0]!.seq)
  })

  test('distinct sessions racing are each recorded', async () => {
    const store = await judging(['s_j2', 's_j3'])
    barrier(store, 2)
    const scopes = [SCOPE, { ...SCOPE, judge: 3, session: 's_j3' }]
    const outcomes = await Promise.all(
      scopes.map((scope) =>
        appendJudgePreference(
          store,
          scope,
          write(
            { actor: agentActor('judge', scope.session) },
            { judge: scope.judge, session: scope.session },
          ),
        ),
      ),
    )
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['recorded', 'recorded'])
    expect((await preferred(store)).map((event) => event.payload.session).sort()).toEqual([
      's_j2',
      's_j3',
    ])
  })

  test('an unrelated event between read and append costs one retry', async () => {
    const store = await judging()
    const read = store.getReducerValue.bind(store)
    let reads = 0
    store.getReducerValue = async (scope, request) => {
      const value = await read(scope, request)
      reads += 1
      if (reads === 1)
        await store.append(BUILD, {
          actor: KERNEL,
          type: 'observation.recorded',
          payload: { id: 'obs-1', kind: 'followup', summary: 'interleaved' },
        })
      return value
    }
    const outcome = await appendJudgePreference(store, SCOPE, write())
    expect(outcome.kind).toBe('recorded')
    expect(reads).toBe(2)
    expect(await preferred(store)).toHaveLength(1)
  })

  test('sustained contention gives up with a typed error and writes nothing', async () => {
    const store = await judging()
    let reads = 0
    const read = store.getReducerValue.bind(store)
    store.getReducerValue = async (scope, request) => {
      reads += 1
      return read(scope, request)
    }
    store.appendIfCurrent = async () => null
    const error = await appendJudgePreference(store, SCOPE, write()).catch((caught) => caught)
    expect(error).toBeInstanceOf(JudgePreferenceContentionError)
    expect(reads).toBe(JUDGE_APPEND_ATTEMPTS)
    expect(await preferred(store)).toHaveLength(0)
  })

  test('an out-of-scope write is refused before any store call', async () => {
    const store = await judging()
    let calls = 0
    store.getReducerValue = async () => {
      calls += 1
      throw new Error('unreachable')
    }
    expect(await appendJudgePreference(store, SCOPE, write({}, { judge: 3 }))).toEqual({
      kind: 'refused',
      reason: 'preference for another judge',
    })
    expect(calls).toBe(0)
  })

  test('the preference write costs the same at 100 and 100,000 events and reads no history', async () => {
    const { small } = await judgePreferenceReadBudget()
    expect(small.recorded.rows).toBe(0)
  }, 120_000)
})
