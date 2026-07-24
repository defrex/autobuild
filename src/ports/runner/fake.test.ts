import { describe, expect, test } from 'bun:test'
import type { AgentStartOpts } from '../types'
import {
  CONTRACT_PERMANENT_FAILURE,
  CONTRACT_RETRYABLE_FAILURE,
  describeAgentRunnerContract,
  type AgentRunnerContractFactory,
} from './contract'
import {
  ScriptedAgentRunner,
  defaultTurnResult,
  failedTurnResult,
  type ScriptContext,
} from './fake'

function startOpts(overrides: Partial<AgentStartOpts> = {}): AgentStartOpts {
  return {
    skill: 'plan',
    buildSlug: 'auth-rate-limit',
    workspacePath: '/ws/auth-rate-limit',
    env: { AB_BUILD: 'auth-rate-limit', AB_PHASE: 'plan' },
    ...overrides,
  }
}

describe('defaultTurnResult', () => {
  test('defaults to empty text and 1/1/1 usage', () => {
    expect(defaultTurnResult()).toEqual({
      kind: 'completed',
      text: '',
      usage: { inputTokens: 1, outputTokens: 1, turns: 1 },
    })
  })

  test('carries the given text', () => {
    expect(defaultTurnResult('done').text).toBe('done')
  })

  test('scripts a structured failure without rewriting it', () => {
    expect(failedTurnResult('403 quota exhausted', true)).toEqual({
      kind: 'failed',
      text: '',
      usage: { inputTokens: 0, outputTokens: 0, turns: 1 },
      failure: { message: '403 quota exhausted', permanent: true },
    })
  })
})

const scriptedContractFactory: AgentRunnerContractFactory = (scenario) => {
  const turns: Array<{ message?: string; env: Record<string, string> }> = []
  const runner = new ScriptedAgentRunner({
    script: (ctx) => {
      turns.push({
        ...(ctx.message !== undefined ? { message: ctx.message } : {}),
        env: ctx.opts.env,
      })
      if (scenario === 'retryable-failure') {
        return failedTurnResult(CONTRACT_RETRYABLE_FAILURE, false)
      }
      if (scenario === 'permanent-failure') {
        return failedTurnResult(CONTRACT_PERMANENT_FAILURE, true)
      }
      return defaultTurnResult(`contract turn ${ctx.turn}`)
    },
  })
  return {
    runner,
    model: 'contract/scripted-model',
    workspacePath: process.cwd(),
    turns: () => turns,
  }
}

describeAgentRunnerContract('ScriptedAgentRunner', scriptedContractFactory)

describe('ScriptedAgentRunner', () => {
  test('start creates sessions s_1, s_2, … and invokes the script with turn 1', async () => {
    const contexts: ScriptContext[] = []
    const runner = new ScriptedAgentRunner({
      script: (ctx) => {
        contexts.push(ctx)
        return defaultTurnResult('turn-1')
      },
    })

    const opts = startOpts()
    const first = await runner.start(opts)
    const second = await runner.start(startOpts({ skill: 'code-review' }))

    expect(first.session).toEqual({ id: 's_1', runner: 'scripted' })
    expect(second.session.id).toBe('s_2')
    expect(first.result.text).toBe('turn-1')

    expect(contexts[0]).toMatchObject({
      opts,
      session: { id: 's_1' },
      turn: 1,
      history: [],
    })
    expect(contexts[0]?.message).toBeUndefined()
  })

  test('session handle carries the requested model', async () => {
    const runner = new ScriptedAgentRunner({ script: () => defaultTurnResult() })
    const { session } = await runner.start(startOpts({ model: 'claude-opus-4' }))
    expect(session.model).toBe('claude-opus-4')
  })

  test('continue increments the turn and accumulates history of prior messages', async () => {
    const contexts: ScriptContext[] = []
    const runner = new ScriptedAgentRunner({
      script: (ctx) => {
        contexts.push(ctx)
        return defaultTurnResult(`text-${ctx.turn}`)
      },
    })

    const { session } = await runner.start(startOpts())
    const round2 = await runner.continue(session, 'revise: findings f_1')
    const round3 = await runner.continue(session, 'revise: findings f_2')

    expect(round2.text).toBe('text-2')
    expect(round3.text).toBe('text-3')

    expect(contexts[1]).toMatchObject({
      turn: 2,
      message: 'revise: findings f_1',
      history: [],
    })
    expect(contexts[2]).toMatchObject({
      turn: 3,
      message: 'revise: findings f_2',
      history: ['revise: findings f_1'],
    })
  })

  test('continue exposes the re-issued ambient env to the script, merged over the start env (§10, D8)', async () => {
    // Regression: the fake used to hand the script the START opts on every
    // turn, hiding the real adapters' per-turn env refresh from every test
    // built on it.
    const contexts: ScriptContext[] = []
    const runner = new ScriptedAgentRunner({
      script: (ctx) => {
        contexts.push(ctx)
        return defaultTurnResult()
      },
    })
    const { session } = await runner.start(
      startOpts({
        env: { AB_BUILD: 'auth-rate-limit', AB_PHASE: 'implement@1', AB_SESSION: 's_3' },
      }),
    )
    await runner.continue(session, 'revise: findings f_1', {
      env: { AB_PHASE: 'implement@2', AB_SESSION: 's_5' },
    })

    expect(contexts[1]?.opts.env).toMatchObject({
      AB_BUILD: 'auth-rate-limit', // start-only key survives the merge
      AB_PHASE: 'implement@2',
      AB_SESSION: 's_5',
    })
    // The journal keeps the START opts — they are the session's identity.
    expect(runner.sessions.get('s_1')?.opts.env.AB_PHASE).toBe('implement@1')
  })

  test('sessions are independent: histories never leak across handles', async () => {
    const histories: string[][] = []
    const runner = new ScriptedAgentRunner({
      script: (ctx) => {
        histories.push(ctx.history)
        return defaultTurnResult()
      },
    })

    const a = await runner.start(startOpts())
    const b = await runner.start(startOpts({ skill: 'code-review' }))
    await runner.continue(a.session, 'to-a')
    await runner.continue(b.session, 'to-b')
    await runner.continue(b.session, 'to-b-again')

    expect(histories).toEqual([[], [], [], [], ['to-b']])
  })

  test('journals record per-session turns for assertions', async () => {
    const runner = new ScriptedAgentRunner({
      script: (ctx) => defaultTurnResult(`t${ctx.turn}`),
    })
    const { session } = await runner.start(startOpts())
    await runner.continue(session, 'again')

    const journal = runner.sessions.get('s_1')
    expect(journal?.opts.skill).toBe('plan')
    expect(journal?.turns).toEqual([
      { turn: 1, result: defaultTurnResult('t1') },
      { turn: 2, message: 'again', result: defaultTurnResult('t2') },
    ])
    expect(journal?.messages).toEqual(['again'])
    expect(journal?.ended).toBe(false)
  })

  test('end returns a Transcript: JSON of recorded turns + summed usage', async () => {
    const runner = new ScriptedAgentRunner({
      script: (ctx) => ({
        kind: 'completed',
        text: `turn-${ctx.turn}`,
        usage: { inputTokens: ctx.turn * 10, outputTokens: ctx.turn, turns: 1 },
      }),
    })

    const { session } = await runner.start(startOpts({ model: 'claude-sonnet-4' }))
    await runner.continue(session, 'round 2 feedback')
    const transcript = await runner.end(session)

    expect(transcript.metadata).toEqual({
      runner: 'scripted',
      model: 'claude-sonnet-4',
      usage: { inputTokens: 30, outputTokens: 3, turns: 2 },
    })

    const content = JSON.parse(transcript.content)
    expect(content.session).toBe('s_1')
    expect(content.skill).toBe('plan')
    expect(content.buildSlug).toBe('auth-rate-limit')
    expect(content.turns).toHaveLength(2)
    expect(content.turns[0].result.text).toBe('turn-1')
    expect(content.turns[1].message).toBe('round 2 feedback')
    expect(content.turns[1].result.text).toBe('turn-2')

    expect(runner.sessions.get('s_1')?.ended).toBe(true)
  })

  test('failed turns remain in the journal and transcript', async () => {
    const failed = failedTurnResult('permission denied', true)
    const runner = new ScriptedAgentRunner({ script: () => failed })
    const { session, result } = await runner.start(startOpts())
    expect(result).toEqual(failed)
    expect(runner.sessions.get(session.id)?.turns[0]?.result).toEqual(failed)
    const transcript = JSON.parse((await runner.end(session)).content)
    expect(transcript.turns[0].result).toEqual(failed)
  })

  test('continue on an ended session throws', async () => {
    const runner = new ScriptedAgentRunner({ script: () => defaultTurnResult() })
    const { session } = await runner.start(startOpts())
    await runner.end(session)
    await expect(runner.continue(session, 'more')).rejects.toThrow(
      'continue on ended session "s_1"',
    )
  })

  test('end on an ended session throws', async () => {
    const runner = new ScriptedAgentRunner({ script: () => defaultTurnResult() })
    const { session } = await runner.start(startOpts())
    await runner.end(session)
    await expect(runner.end(session)).rejects.toThrow('end on ended session "s_1"')
  })

  test('continue and end on an unknown session throw', async () => {
    const runner = new ScriptedAgentRunner({ script: () => defaultTurnResult() })
    const ghost = { id: 's_404', runner: 'scripted' }
    await expect(runner.continue(ghost, 'hello')).rejects.toThrow('unknown session "s_404"')
    await expect(runner.end(ghost)).rejects.toThrow('unknown session "s_404"')
  })

  test('async scripts are awaited', async () => {
    const runner = new ScriptedAgentRunner({
      script: async () => defaultTurnResult('async'),
    })
    const { result } = await runner.start(startOpts())
    expect(result.text).toBe('async')
  })
})
