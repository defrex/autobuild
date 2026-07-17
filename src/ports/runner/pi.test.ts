/**
 * PiAgentRunner tests run entirely against an injected fake PiQueryFn — the pi
 * SDK is never loaded. The default queryFn (the non-literal dynamic import) is
 * deliberately untested: it is the adapter's single cast point and contains no
 * logic beyond the import.
 */
import { describe, expect, test } from 'bun:test'
import type { AgentStartOpts } from '../types'
import {
  PiAgentRunner,
  type PiAssistantMessage,
  type PiMessage,
  type PiQueryFn,
  type PiResultMessage,
} from './pi'

function assistant(...texts: string[]): PiAssistantMessage {
  return {
    type: 'assistant',
    message: { content: texts.map((text) => ({ type: 'text', text })) },
  }
}

function piResult(sessionId: string, inputTokens: number, outputTokens: number): PiResultMessage {
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
    abortController?: AbortController
    maxTurns?: number
    tools?: string[]
    permissionMode: 'bypassPermissions'
    allowDangerouslySkipPermissions: true
  }
}

function fakeQuery(streams: PiMessage[][]): { calls: RecordedCall[]; queryFn: PiQueryFn } {
  const calls: RecordedCall[] = []
  const queryFn: PiQueryFn = (opts) => {
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
    skill: 'ab-plan',
    buildSlug: 'auth-rate-limit',
    workspacePath: '/ws/auth-rate-limit',
    env: { AB_BUILD: 'auth-rate-limit', AB_SESSION: 's_9f2' },
    ...overrides,
  }
}

describe('PiAgentRunner.start', () => {
  test('formats the prompt as /{skill} {buildSlug} and flows the model from config (§4, §9)', async () => {
    const { calls, queryFn } = fakeQuery([[piResult('pi-1', 1, 1)]])
    const runner = new PiAgentRunner({ queryFn })
    const { session } = await runner.start(startOpts({ model: 'kimi-k3' }))
    expect(calls[0]?.prompt).toBe('/ab-plan auth-rate-limit')
    expect(calls[0]?.options.cwd).toBe('/ws/auth-rate-limit')
    // Model id is taken from opts (config), never hardcoded.
    expect(calls[0]?.options.model).toBe('kimi-k3')
    expect(session.model).toBe('kimi-k3')
    expect(session.runner).toBe('pi')
  })

  test('captures the SDK session_id as the handle id', async () => {
    const { queryFn } = fakeQuery([[piResult('pi-session-42', 1, 1)]])
    const runner = new PiAgentRunner({ queryFn })
    const { session } = await runner.start(startOpts())
    expect(session).toEqual({ id: 'pi-session-42', runner: 'pi' })
  })

  test('bypasses interactive permissions for unattended sessions', async () => {
    const { calls, queryFn } = fakeQuery([[piResult('pi-1', 1, 1)]])
    const runner = new PiAgentRunner({ queryFn })
    await runner.start(startOpts())
    expect(calls[0]?.options.permissionMode).toBe('bypassPermissions')
    expect(calls[0]?.options.allowDangerouslySkipPermissions).toBe(true)
    expect(calls[0]?.options.resume).toBeUndefined()
    expect(calls[0]?.options.maxTurns).toBeUndefined()
    expect(calls[0]?.options.tools).toBeUndefined()
    expect(calls[0]?.options.abortController).toBeUndefined()
  })

  test('accumulates assistant text; captures usage; ignores other messages', async () => {
    const { queryFn } = fakeQuery([
      [{ type: 'system' }, assistant('first'), assistant('second'), piResult('pi-1', 10, 5)],
    ])
    const runner = new PiAgentRunner({ queryFn })
    const { result } = await runner.start(startOpts())
    expect(result.text).toBe('first\nsecond')
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, turns: 1 })
  })

  test('throws when the stream ends without a result message', async () => {
    const { queryFn } = fakeQuery([[assistant('no terminal')]])
    const runner = new PiAgentRunner({ queryFn })
    await expect(runner.start(startOpts())).rejects.toThrow(
      'stream ended without a result message',
    )
  })
})

describe('PiAgentRunner.complete', () => {
  test('runs a verbatim, bounded, tool-free prompt and returns text without opening a session', async () => {
    const { calls, queryFn } = fakeQuery([
      [assistant('login-rate-limit'), piResult('one-shot-id', 4, 2)],
    ])
    const runner = new PiAgentRunner({ queryFn })
    const controller = new AbortController()
    controller.abort('deadline')

    const result = await runner.complete({
      prompt: 'name this spec verbatim',
      cwd: '/repos/app',
      env: { NAMING_TOKEN: 'secret' },
      model: 'kimi-k3',
      signal: controller.signal,
    })

    expect(result).toEqual({ text: 'login-rate-limit' })
    expect(calls[0]?.prompt).toBe('name this spec verbatim')
    expect(calls[0]?.options.cwd).toBe('/repos/app')
    expect(calls[0]?.options.env['NAMING_TOKEN']).toBe('secret')
    expect(calls[0]?.options.model).toBe('kimi-k3')
    expect(calls[0]?.options.resume).toBeUndefined()
    expect(calls[0]?.options.maxTurns).toBe(1)
    expect(calls[0]?.options.tools).toEqual([])
    expect(calls[0]?.options.abortController?.signal.aborted).toBe(true)
    expect(calls[0]?.options.permissionMode).toBe('bypassPermissions')
    await expect(runner.end({ id: 'one-shot-id', runner: 'pi' })).rejects.toThrow(
      'unknown session "one-shot-id"',
    )
  })
})

describe('PiAgentRunner.continue', () => {
  test('resumes with the captured session id as the resume token (§9)', async () => {
    const { calls, queryFn } = fakeQuery([
      [piResult('pi-1', 10, 5)],
      [assistant('revised'), piResult('pi-1', 7, 3)],
    ])
    const runner = new PiAgentRunner({ queryFn })
    const { session } = await runner.start(startOpts({ model: 'kimi-k3' }))
    const result = await runner.continue(session, 'address findings f_1, f_2')

    expect(calls[1]?.prompt).toBe('address findings f_1, f_2')
    expect(calls[1]?.options.resume).toBe('pi-1')
    expect(calls[1]?.options.model).toBe('kimi-k3')
    expect(result).toEqual({ text: 'revised', usage: { inputTokens: 7, outputTokens: 3, turns: 1 } })
  })

  test('re-issued ambient env merges over the start env for the continued turn (§10, D8)', async () => {
    const { calls, queryFn } = fakeQuery([
      [piResult('pi-1', 10, 5)],
      [assistant('revised'), piResult('pi-1', 7, 3)],
    ])
    const runner = new PiAgentRunner({ queryFn })
    const { session } = await runner.start(
      startOpts({ env: { AB_BUILD: 'auth-rate-limit', AB_PHASE: 'implement@1', AB_SESSION: 's_3' } }),
    )
    await runner.continue(session, 'fix', {
      env: { AB_PHASE: 'implement@2', AB_SESSION: 's_5' },
    })
    const env = calls[1]?.options.env
    expect(env?.['AB_PHASE']).toBe('implement@2')
    expect(env?.['AB_SESSION']).toBe('s_5')
    expect(env?.['AB_BUILD']).toBe('auth-rate-limit')
  })

  test('throws on an unknown session', async () => {
    const { queryFn } = fakeQuery([])
    const runner = new PiAgentRunner({ queryFn })
    await expect(runner.continue({ id: 'nope', runner: 'pi' }, 'hi')).rejects.toThrow(
      'unknown session "nope"',
    )
  })
})

describe('PiAgentRunner.end', () => {
  test('returns a Transcript with runner "pi", the model, summed usage, and both turns', async () => {
    const { queryFn } = fakeQuery([
      [assistant('the plan'), piResult('pi-1', 10, 5)],
      [assistant('the revision'), piResult('pi-1', 7, 3)],
    ])
    const runner = new PiAgentRunner({ queryFn })
    const { session } = await runner.start(startOpts({ model: 'kimi-k3' }))
    await runner.continue(session, 'revise please')
    const transcript = await runner.end(session)

    expect(transcript.metadata).toEqual({
      runner: 'pi',
      model: 'kimi-k3',
      usage: { inputTokens: 17, outputTokens: 8, turns: 2 },
    })
    const content = JSON.parse(transcript.content)
    expect(content.session).toBe('pi-1')
    expect(content.buildSlug).toBe('auth-rate-limit')
    expect(content.turns).toHaveLength(2)
    expect(content.turns[0]).toMatchObject({ turn: 1, prompt: '/ab-plan auth-rate-limit' })
  })

  test('a session started with no model yields a transcript with no model', async () => {
    const { queryFn } = fakeQuery([[piResult('pi-1', 1, 1)]])
    const runner = new PiAgentRunner({ queryFn })
    const { session } = await runner.start(startOpts())
    const transcript = await runner.end(session)
    expect(transcript.metadata.model).toBeUndefined()
    expect(transcript.metadata.runner).toBe('pi')
  })

  test('throws on an unknown session, and on a second end', async () => {
    const { queryFn } = fakeQuery([[piResult('pi-1', 1, 1)]])
    const runner = new PiAgentRunner({ queryFn })
    await expect(runner.end({ id: 'nope', runner: 'pi' })).rejects.toThrow('unknown session "nope"')
    const { session } = await runner.start(startOpts())
    await runner.end(session)
    await expect(runner.end(session)).rejects.toThrow('unknown session "pi-1"')
  })
})
