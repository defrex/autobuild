import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  bindOperatorIds,
  checkOperatorCorpus,
  generateOperatorCorpus,
  operatorAnswers,
  operatorBuildActions,
  operatorInventory,
  operatorRoutes,
  operatorScenarios,
  replayOperatorScenario,
  type OperatorCorpus,
} from './operator-fixtures'

const saved = (): OperatorCorpus =>
  JSON.parse(readFileSync(resolve(import.meta.dir, '../fixtures/operator-corpus.json'), 'utf8'))

describe('operator HTTP oracle foundation', () => {
  test('saved corpus replays the actual TypeScript HTTP server with exact results and logs', async () => {
    await checkOperatorCorpus(saved())
  })

  test('detects response, durable actor, sequence, refusal text and manifest drift', async () => {
    const corpus = await generateOperatorCorpus()
    const message = corpus.fixtures.find((fixture) => fixture.scenario.id === 'session-message')!
    const event = message.observations[0]!.sessions[0]!.events.at(-1) as Record<string, unknown>
    expect(event).toMatchObject({
      seq: 2,
      actor: { kind: 'human', user: 'operator@example.com' },
      type: 'message.posted',
      payload: { text: 'Help with this build' },
    })
    event.actor = { kind: 'human', user: 'forged' }
    await expect(checkOperatorCorpus(corpus)).rejects.toThrow('operator corpus is stale')
    const changed = saved()
    changed.manifest.sourceClosureSha256 = 'stale'
    await expect(checkOperatorCorpus(changed)).rejects.toThrow('operator corpus is stale')
  })

  test('binds only generated identifiers without erasing actor, order or timestamp', () => {
    expect(
      bindOperatorIds(
        {
          actor: { kind: 'human', user: 'Ada' },
          session: 'os_generated',
          error: 'unknown session "os_generated"',
          seq: 3,
          ts: '2026-09-02T00:00:00.000Z',
        },
        ['os_generated'],
      ),
    ).toEqual({
      actor: { kind: 'human', user: 'Ada' },
      session: '$session:0',
      error: 'unknown session "$session:0"',
      seq: 3,
      ts: '2026-09-02T00:00:00.000Z',
    })
  })

  test('inventory retains all typed routes, build actions, answer variants and available registry entries', () => {
    const inventory = operatorInventory()
    expect(inventory.routes).toHaveLength(33)
    expect(new Set(inventory.routes).size).toBe(inventory.routes.length)
    expect(inventory.buildActions).toEqual([
      'pause',
      'cancel-pause',
      'resume',
      'abort',
      'discard',
      'land',
      'hold',
    ])
    expect(inventory.answers).toEqual([
      'guidance',
      'retry',
      'dismiss',
      'review-round-ceiling',
      'revise-spec:body',
      'revise-spec:ticket',
    ])
    expect(inventory.tools).toContain('notes.write')
    expect(inventory.tools.some((name) => name.startsWith('sandbox.'))).toBe(false)
    const corpus = saved()
    expect(corpus.inventory).toEqual(inventory)
    expect(corpus.coverage.missingBuildActions).toEqual(operatorBuildActions)
    expect(corpus.coverage.missingAnswers).toEqual(operatorAnswers)
    expect(corpus.coverage.missingTools).toEqual(inventory.tools)
    expect([...corpus.coverage.routes, ...corpus.coverage.missingRoutes].sort()).toEqual(
      [...operatorRoutes].sort(),
    )
  })

  test('unsupported identity is checked before authentication and every refusal leaves the seed intact', () => {
    const corpus = saved()
    const identity = corpus.fixtures.find(
      (fixture) => fixture.scenario.id === 'identity-before-auth',
    )!
    expect(identity.observations[0]).toMatchObject({ status: 409, body: { kind: 'conflict' } })
    for (const fixture of corpus.fixtures) {
      if (fixture.observations.every((observation) => observation.status >= 400)) {
        for (const observation of fixture.observations)
          expect(observation.sessions).toEqual(fixture.seed)
      }
    }
  })

  test('session ownership, terminal refusal and approval matching come from TypeScript policy', () => {
    const corpus = saved()
    const byId = (id: string) =>
      corpus.fixtures.find((fixture) => fixture.scenario.id === id)!.observations[0]!
    expect(byId('session-other-reader').status).toBe(200)
    expect(byId('session-other-writer').status).toBe(403)
    expect(byId('session-foreign-hidden').status).toBe(404)
    expect(byId('session-approval-mismatch').status).toBe(409)
    expect(byId('session-archived-message').status).toBe(409)
    for (const decision of ['approve', 'deny']) {
      const observation = byId(`session-approval-${decision}`)
      expect(observation.status).toBe(200)
      expect(observation.sessions[0]!.events.at(-1)).toMatchObject({
        seq: 6,
        type: 'approval.answered',
        payload: { turn: 'ot_fixture', toolCallId: 'call_fixture', decision },
      })
    }
  })

  test('non-owner and archived session cases never gain a via marker', async () => {
    const scenario = operatorScenarios().find((scenario) => scenario.id === 'session-message')!
    const replay = await replayOperatorScenario(scenario)
    const writes = replay.observations[0]!.sessions[0]!.events.slice(replay.seed[0]!.events.length)
    expect(writes).toHaveLength(1)
    expect((writes[0] as { actor: unknown }).actor).toEqual({
      kind: 'human',
      user: 'operator@example.com',
    })
  })
})
