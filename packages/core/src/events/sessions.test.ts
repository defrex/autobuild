import { describe, expect, test } from 'bun:test'
import { agentActor } from './envelope'
import { EventValidationError } from './catalog'
import { sessionEventPayloadSchemas, validateSessionEventWrite } from './sessions'

const RUNNER = agentActor('orchestrator', 'os_turn')

/** A wake `turn.started` payload parsed like every store append validates it. */
function turnStarted(trigger: unknown) {
  return sessionEventPayloadSchemas['turn.started'].parse({
    turn: 'ot_1',
    stream: 'st_1',
    trigger,
  })
}

/** The store-level validation gate, which wraps zod issues into a typed
 * `EventValidationError` — the shape an ambiguous trigger meets in practice. */
function gate(trigger: unknown) {
  return validateSessionEventWrite({
    actor: RUNNER,
    type: 'turn.started',
    payload: { turn: 'ot_1', stream: 'st_1', trigger },
  })
}

describe('session catalog wake-trigger gate', () => {
  test('a build wake trigger (the historical shape) still validates', () => {
    const payload = turnStarted({ kind: 'wake', build: 'b1', seq: 2, type: 'escalation.raised' })
    expect(payload.trigger).toEqual({
      kind: 'wake',
      build: 'b1',
      seq: 2,
      type: 'escalation.raised',
    })
    expect(() =>
      gate({ kind: 'wake', build: 'b1', seq: 2, type: 'escalation.raised' }),
    ).not.toThrow()
  })

  test('a journal wake trigger validates and carries no build', () => {
    const payload = turnStarted({ kind: 'wake', journal: true, seq: 3, type: 'harvest.escalated' })
    expect(payload.trigger).toEqual({
      kind: 'wake',
      journal: true,
      seq: 3,
      type: 'harvest.escalated',
    })
    expect(() =>
      gate({ kind: 'wake', journal: true, seq: 3, type: 'harvest.escalated' }),
    ).not.toThrow()
  })

  test('a wake trigger naming both sources is rejected', () => {
    try {
      gate({ kind: 'wake', build: 'b1', journal: true, seq: 2, type: 'escalation.raised' })
      throw new Error('expected a rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(EventValidationError)
      expect((error as Error).message).toContain('exactly one of build or journal')
    }
  })

  test('a wake trigger naming neither source is rejected', () => {
    try {
      gate({ kind: 'wake', seq: 2, type: 'escalation.raised' })
      throw new Error('expected a rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(EventValidationError)
      expect((error as Error).message).toContain('exactly one of build or journal')
    }
  })
})
