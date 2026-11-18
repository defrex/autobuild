import { describe, expect, test } from 'bun:test'
import { agentActor, KERNEL } from '../events/envelope'
import { delegationFactKey } from '../kernel/service-facts'
import {
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
