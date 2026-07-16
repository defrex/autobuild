/**
 * ClaudeAgentRunner tests run entirely against an injected fake QueryFn —
 * the SDK is never loaded. The default queryFn (the dynamic import of
 * `@anthropic-ai/claude-agent-sdk`) is deliberately untested: it is the
 * adapter's single cast point and contains no logic beyond the import.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import type { AgentStartOpts } from '../types'
import {
  ClaudeAgentRunner,
  type QueryFn,
  type SdkAssistantMessage,
  type SdkMessage,
  type SdkResultMessage,
} from './claude'

function assistant(...texts: string[]): SdkAssistantMessage {
  return {
    type: 'assistant',
    message: { content: texts.map((text) => ({ type: 'text', text })) },
  }
}

function sdkResult(
  sessionId: string,
  inputTokens: number,
  outputTokens: number,
): SdkResultMessage {
  return {
    type: 'result',
    session_id: sessionId,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  }
}

interface RecordedCall {
  prompt: string
  options: {
    cwd: string
    env: Record<string, string>
    model?: string
    resume?: string
  }
}

/** A QueryFn that records every call and plays back one scripted stream per
 * call, in order. */
function fakeQuery(streams: SdkMessage[][]): {
  calls: RecordedCall[]
  queryFn: QueryFn
} {
  const calls: RecordedCall[] = []
  const queryFn: QueryFn = (opts) => {
    calls.push(opts)
    const messages = streams[calls.length - 1] ?? []
    return (async function* () {
      yield* messages
    })()
  }
  return { calls, queryFn }
}

function startOpts(overrides: Partial<AgentStartOpts> = {}): AgentStartOpts {
  return {
    skill: 'plan',
    buildSlug: 'auth-rate-limit',
    workspacePath: '/ws/auth-rate-limit',
    env: { AB_BUILD: 'auth-rate-limit', AB_SESSION: 's_9f2' },
    ...overrides,
  }
}

afterEach(() => {
  delete process.env['AB_TEST_AMBIENT']
  delete process.env['AB_TEST_OVERRIDE']
})

describe('ClaudeAgentRunner.start', () => {
  test('formats the prompt as /{skill} {buildSlug} (§4)', async () => {
    const { calls, queryFn } = fakeQuery([[sdkResult('sdk-1', 1, 1)]])
    const runner = new ClaudeAgentRunner({ queryFn })
    await runner.start(startOpts())
    expect(calls[0]?.prompt).toBe('/plan auth-rate-limit')
  })

  test('passes workspacePath as cwd and model through', async () => {
    const { calls, queryFn } = fakeQuery([[sdkResult('sdk-1', 1, 1)]])
    const runner = new ClaudeAgentRunner({ queryFn })
    const { session } = await runner.start(
      startOpts({ model: 'claude-opus-4' }),
    )
    expect(calls[0]?.options.cwd).toBe('/ws/auth-rate-limit')
    expect(calls[0]?.options.model).toBe('claude-opus-4')
    expect(calls[0]?.options.resume).toBeUndefined()
    expect(session.model).toBe('claude-opus-4')
  })

  test('merges ambient-auth env over process.env (D8)', async () => {
    process.env['AB_TEST_AMBIENT'] = 'from-process'
    process.env['AB_TEST_OVERRIDE'] = 'ambient-loses'
    const { calls, queryFn } = fakeQuery([[sdkResult('sdk-1', 1, 1)]])
    const runner = new ClaudeAgentRunner({ queryFn })
    await runner.start(
      startOpts({ env: { AB_TEST_OVERRIDE: 'scoped-wins', AB_TOKEN: 'tok' } }),
    )
    const env = calls[0]?.options.env
    expect(env?.['AB_TEST_AMBIENT']).toBe('from-process')
    expect(env?.['AB_TEST_OVERRIDE']).toBe('scoped-wins')
    expect(env?.['AB_TOKEN']).toBe('tok')
  })

  test('captures the SDK session_id as the handle id', async () => {
    const { queryFn } = fakeQuery([[sdkResult('sdk-session-42', 1, 1)]])
    const runner = new ClaudeAgentRunner({ queryFn })
    const { session } = await runner.start(startOpts())
    expect(session).toEqual({ id: 'sdk-session-42', runner: 'claude' })
  })

  test('accumulates assistant text blocks; ignores other messages and blocks', async () => {
    const { queryFn } = fakeQuery([
      [
        { type: 'system' },
        assistant('first'),
        {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use' }, { type: 'text', text: 'second' }],
          },
        },
        { type: 'stream_event' },
        sdkResult('sdk-1', 10, 5),
      ],
    ])
    const runner = new ClaudeAgentRunner({ queryFn })
    const { result } = await runner.start(startOpts())
    expect(result.text).toBe('first\nsecond')
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, turns: 1 })
  })

  test('throws when the stream ends without a result message', async () => {
    const { queryFn } = fakeQuery([[assistant('no terminal result')]])
    const runner = new ClaudeAgentRunner({ queryFn })
    await expect(runner.start(startOpts())).rejects.toThrow(
      'stream ended without a result message',
    )
  })
})

describe('ClaudeAgentRunner.continue', () => {
  test('sends the message as prompt with resume: session.id, same cwd/env/model', async () => {
    const { calls, queryFn } = fakeQuery([
      [sdkResult('sdk-1', 10, 5)],
      [assistant('revised'), sdkResult('sdk-1', 7, 3)],
    ])
    const runner = new ClaudeAgentRunner({ queryFn })
    const { session } = await runner.start(startOpts({ model: 'claude-opus-4' }))
    const result = await runner.continue(session, 'address findings f_1, f_2')

    expect(calls[1]?.prompt).toBe('address findings f_1, f_2')
    expect(calls[1]?.options.resume).toBe('sdk-1')
    expect(calls[1]?.options.cwd).toBe('/ws/auth-rate-limit')
    expect(calls[1]?.options.model).toBe('claude-opus-4')
    expect(calls[1]?.options.env['AB_BUILD']).toBe('auth-rate-limit')
    expect(result).toEqual({
      text: 'revised',
      usage: { inputTokens: 7, outputTokens: 3, turns: 1 },
    })
  })

  test('re-issued ambient env (§10, D8) merges over the start env for the continued turn', async () => {
    // Regression: continue used to reuse the START opts verbatim, so the
    // continued round's CLI resolved round 1's AB_PHASE/AB_SESSION and its
    // terminal was rejected as a D5 second call (§8.4).
    const { calls, queryFn } = fakeQuery([
      [sdkResult('sdk-1', 10, 5)],
      [assistant('revised'), sdkResult('sdk-1', 7, 3)],
    ])
    const runner = new ClaudeAgentRunner({ queryFn })
    const { session } = await runner.start(
      startOpts({
        env: { AB_BUILD: 'auth-rate-limit', AB_PHASE: 'implement@1', AB_SESSION: 's_3' },
      }),
    )
    await runner.continue(session, 'address findings f_1', {
      env: { AB_PHASE: 'implement@2', AB_SESSION: 's_5' },
    })
    const env = calls[1]?.options.env
    expect(env?.['AB_PHASE']).toBe('implement@2')
    expect(env?.['AB_SESSION']).toBe('s_5')
    // Start-only keys survive the refresh (merged, not replaced).
    expect(env?.['AB_BUILD']).toBe('auth-rate-limit')
  })

  test('throws on an unknown session', async () => {
    const { queryFn } = fakeQuery([])
    const runner = new ClaudeAgentRunner({ queryFn })
    await expect(
      runner.continue({ id: 'nope', runner: 'claude' }, 'hello'),
    ).rejects.toThrow('unknown session "nope"')
  })
})

describe('ClaudeAgentRunner.end', () => {
  test('returns a transcript with summed usage and both turns in the content', async () => {
    const { queryFn } = fakeQuery([
      [assistant('the plan'), sdkResult('sdk-1', 10, 5)],
      [assistant('the revision'), sdkResult('sdk-1', 7, 3)],
    ])
    const runner = new ClaudeAgentRunner({ queryFn })
    const { session } = await runner.start(startOpts({ model: 'claude-opus-4' }))
    await runner.continue(session, 'revise please')
    const transcript = await runner.end(session)

    expect(transcript.metadata).toEqual({
      runner: 'claude',
      model: 'claude-opus-4',
      usage: { inputTokens: 17, outputTokens: 8, turns: 2 },
    })

    const content = JSON.parse(transcript.content)
    expect(content.session).toBe('sdk-1')
    expect(content.buildSlug).toBe('auth-rate-limit')
    expect(content.turns).toHaveLength(2)
    expect(content.turns[0]).toMatchObject({
      turn: 1,
      prompt: '/plan auth-rate-limit',
      text: 'the plan',
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    expect(content.turns[1]).toMatchObject({
      turn: 2,
      prompt: 'revise please',
      text: 'the revision',
      usage: { inputTokens: 7, outputTokens: 3 },
    })
  })

  test('throws on an unknown session, and on a second end', async () => {
    const { queryFn } = fakeQuery([[sdkResult('sdk-1', 1, 1)]])
    const runner = new ClaudeAgentRunner({ queryFn })
    await expect(runner.end({ id: 'nope', runner: 'claude' })).rejects.toThrow(
      'unknown session "nope"',
    )

    const { session } = await runner.start(startOpts())
    await runner.end(session)
    await expect(runner.end(session)).rejects.toThrow('unknown session "sdk-1"')
  })
})
