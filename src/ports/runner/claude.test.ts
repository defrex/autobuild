/**
 * ClaudeAgentRunner tests run entirely against an injected fake QueryFn —
 * the SDK is never loaded. The default queryFn (the dynamic import of
 * `@anthropic-ai/claude-agent-sdk`) is deliberately untested: it is the
 * adapter's single cast point and contains no logic beyond the import.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { AgentStartOpts } from '../types'
import {
  CONTRACT_FOLLOW_UP,
  CONTRACT_ONE_SHOT_PROMPT,
  CONTRACT_ONE_SHOT_TEXT,
  CONTRACT_PERMANENT_FAILURE,
  CONTRACT_RETRYABLE_FAILURE,
  describeAgentRunnerContract,
  type AgentRunnerContractFactory,
} from './contract'
import {
  ClaudeAgentRunner,
  type QueryFn,
  type SdkAssistantMessage,
  type SdkMessage,
  type SdkResultMessage,
} from './claude'
import { AGENT_BIN_DIR } from './session-env'

function assistant(...texts: string[]): SdkAssistantMessage {
  return {
    type: 'assistant',
    message: { content: texts.map((text) => ({ type: 'text', text })) },
  }
}

function assistantError(error: string): SdkAssistantMessage {
  return { type: 'assistant', message: { content: [] }, error }
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

function sdkError(
  sessionId: string,
  message: string,
  opts: { subtype?: string; status?: number | null } = {},
): SdkResultMessage {
  return {
    type: 'result',
    subtype: opts.subtype ?? 'error_during_execution',
    is_error: true,
    errors: [message],
    ...(opts.status !== undefined ? { api_error_status: opts.status } : {}),
    session_id: sessionId,
    usage: { input_tokens: 0, output_tokens: 0 },
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
    skill: 'ab-plan',
    buildSlug: 'auth-rate-limit',
    workspacePath: '/ws/auth-rate-limit',
    env: { AB_BUILD: 'auth-rate-limit', AB_SESSION: 's_9f2' },
    ...overrides,
  }
}

const claudeContractFactory: AgentRunnerContractFactory = (scenario) => {
  const calls: RecordedCall[] = []
  const queryFn: QueryFn = (opts) => {
    calls.push(opts)
    return (async function* (): AsyncIterable<SdkMessage> {
      if (opts.prompt === CONTRACT_ONE_SHOT_PROMPT) {
        yield assistant(CONTRACT_ONE_SHOT_TEXT)
        yield sdkResult('claude-contract-one-shot', 2, 1)
        return
      }
      if (scenario === 'retryable-failure') {
        yield sdkError('claude-contract-retryable', CONTRACT_RETRYABLE_FAILURE)
        return
      }
      if (scenario === 'permanent-failure') {
        yield sdkError(
          'claude-contract-permanent',
          CONTRACT_PERMANENT_FAILURE,
          { status: 401 },
        )
        return
      }
      if (opts.prompt === CONTRACT_FOLLOW_UP) {
        yield assistant('contract continued')
      } else {
        yield assistant('contract started')
      }
      yield sdkResult('claude-contract-session', 3, 2)
    })()
  }
  const runner = new ClaudeAgentRunner({ queryFn })
  return {
    runner,
    model: 'claude-contract-model',
    workspacePath: process.cwd(),
    turns: () =>
      calls
        .filter((call) => call.prompt !== CONTRACT_ONE_SHOT_PROMPT)
        .map((call) => ({
          ...(call.prompt === CONTRACT_FOLLOW_UP
            ? { message: call.prompt }
            : {}),
          env: call.options.env,
        })),
    oneShot: {
      completion: runner,
      observation: () => {
        const call = calls.find(
          (candidate) => candidate.prompt === CONTRACT_ONE_SHOT_PROMPT,
        )
        if (call === undefined) return undefined
        return {
          prompt: call.prompt,
          cwd: call.options.cwd,
          env: call.options.env,
          ...(call.options.model !== undefined
            ? { model: call.options.model }
            : {}),
        }
      },
    },
  }
}

describeAgentRunnerContract('ClaudeAgentRunner (injected SDK)', claudeContractFactory)

async function writeConflictingAb(dir: string): Promise<void> {
  const path = join(dir, 'ab')
  await writeFile(path, '#!/bin/sh\necho host-conflicting-ab\nexit 91\n')
  await chmod(path, 0o755)
}

async function invokeAbHelp(env: Record<string, string>): Promise<{
  stdout: string
  stderr: string
  code: number
}> {
  const proc = Bun.spawn(['ab', '--help'], {
    cwd: process.cwd(),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
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
    expect(calls[0]?.prompt).toBe('/ab-plan auth-rate-limit')
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
    expect(calls[0]?.options.maxTurns).toBeUndefined()
    expect(calls[0]?.options.tools).toBeUndefined()
    expect(calls[0]?.options.abortController).toBeUndefined()
    expect(session.model).toBe('claude-opus-4')
  })

  test('bypasses interactive SDK permissions for unattended sessions', async () => {
    const { calls, queryFn } = fakeQuery([[sdkResult('sdk-1', 1, 1)]])
    const runner = new ClaudeAgentRunner({ queryFn })
    await runner.start(startOpts())

    expect(calls[0]?.options.permissionMode).toBe('bypassPermissions')
    expect(calls[0]?.options.allowDangerouslySkipPermissions).toBe(true)
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

  test('returns an authentication failure verbatim with an endable handle and transcript', async () => {
    const message = 'Invalid API key: authentication failed'
    const { queryFn } = fakeQuery([
      [assistantError('authentication_failed'), sdkError('sdk-auth', message, { status: 401 })],
    ])
    const runner = new ClaudeAgentRunner({ queryFn })
    const { session, result } = await runner.start(startOpts())

    expect(result).toEqual({
      kind: 'failed',
      text: '',
      usage: { inputTokens: 0, outputTokens: 0, turns: 1 },
      failure: { message, permanent: true },
    })
    const transcript = await runner.end(session)
    expect(JSON.parse(transcript.content).turns[0].failure).toEqual({
      message,
      permanent: true,
    })
  })

  test.each([
    ['permission', 'You do not have permission to use this model'],
    ['billing', 'Billing error: account has insufficient credits'],
  ])('classifies a %s SDK result as permanent', async (_name, message) => {
    const { queryFn } = fakeQuery([[sdkError('sdk-permanent', message)]])
    const runner = new ClaudeAgentRunner({ queryFn })
    const { session, result } = await runner.start(startOpts())
    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('unreachable')
    expect(result.failure).toEqual({ message, permanent: true })
    await runner.end(session)
  })

  test('keeps an unknown execution error eligible for bounded retry', async () => {
    const message = 'worker process exited unexpectedly'
    const { queryFn } = fakeQuery([[sdkError('sdk-unknown', message)]])
    const runner = new ClaudeAgentRunner({ queryFn })
    const { session, result } = await runner.start(startOpts())
    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('unreachable')
    expect(result.failure).toEqual({ message, permanent: false })
    await runner.end(session)
  })

  test('throws when the stream ends without a result message', async () => {
    const { queryFn } = fakeQuery([[assistant('no terminal result')]])
    const runner = new ClaudeAgentRunner({ queryFn })
    await expect(runner.start(startOpts())).rejects.toThrow(
      'stream ended without a result message',
    )
  })
})

describe('ClaudeAgentRunner.complete', () => {
  test('runs a verbatim, bounded, tool-free prompt and returns text without opening a session', async () => {
    const { calls, queryFn } = fakeQuery([
      [assistant('login-rate-limit'), sdkResult('one-shot-id', 4, 2)],
    ])
    const runner = new ClaudeAgentRunner({ queryFn })
    const controller = new AbortController()
    controller.abort('deadline')

    const result = await runner.complete({
      prompt: 'name this spec verbatim',
      cwd: '/repos/app',
      env: { NAMING_TOKEN: 'secret' },
      model: 'claude-haiku-4',
      signal: controller.signal,
    })

    expect(result).toEqual({ text: 'login-rate-limit' })
    expect(calls[0]?.prompt).toBe('name this spec verbatim')
    expect(calls[0]?.options.cwd).toBe('/repos/app')
    expect(calls[0]?.options.env['NAMING_TOKEN']).toBe('secret')
    expect(calls[0]?.options.model).toBe('claude-haiku-4')
    expect(calls[0]?.options.resume).toBeUndefined()
    expect(calls[0]?.options.maxTurns).toBe(1)
    expect(calls[0]?.options.tools).toEqual([])
    expect(calls[0]?.options.abortController?.signal.aborted).toBe(true)
    expect(calls[0]?.options.permissionMode).toBe('bypassPermissions')
    await expect(
      runner.end({ id: 'one-shot-id', runner: 'claude' }),
    ).rejects.toThrow('unknown session "one-shot-id"')
  })

  test('throws a failed one-shot result instead of returning empty text', async () => {
    const message = 'Billing error: no credits remain'
    const { queryFn } = fakeQuery([[sdkError('one-shot-error', message)]])
    const runner = new ClaudeAgentRunner({ queryFn })
    await expect(
      runner.complete({ prompt: 'name this spec', cwd: '/repo', env: {} }),
    ).rejects.toThrow(message)
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
    expect(calls[1]?.options.permissionMode).toBe('bypassPermissions')
    expect(calls[1]?.options.allowDangerouslySkipPermissions).toBe(true)
    expect(calls[1]?.options.env['AB_BUILD']).toBe('auth-rate-limit')
    expect(result).toEqual({
      kind: 'completed',
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

  test('keeps the distribution CLI ahead of a conflicting host ab on start and continue', async () => {
    const conflictDir = await mkdtemp(join(tmpdir(), 'ab-claude-path-'))
    const originalPath = process.env['PATH']
    try {
      await writeConflictingAb(conflictDir)
      const inheritedPath = [conflictDir, originalPath ?? '']
        .filter((entry) => entry !== '')
        .join(delimiter)
      process.env['PATH'] = inheritedPath
      const { calls, queryFn } = fakeQuery([
        [sdkResult('sdk-path', 1, 1)],
        [sdkResult('sdk-path', 1, 1)],
      ])
      const runner = new ClaudeAgentRunner({ queryFn })
      const { session } = await runner.start(
        startOpts({
          env: {
            AB_BUILD: 'auth-rate-limit',
            AB_PHASE: 'plan@1',
            AB_SESSION: 's_1',
          },
        }),
      )
      await runner.continue(session, 'next round', {
        env: { AB_PHASE: 'plan@2', AB_SESSION: 's_2' },
      })

      for (const call of calls) {
        const entries = call.options.env['PATH']!.split(delimiter)
        expect(entries[0]).toBe(AGENT_BIN_DIR)
        expect(entries[1]).toBe(conflictDir)
      }

      const smoke = await invokeAbHelp(calls[1]!.options.env)
      expect(smoke).toMatchObject({ code: 0, stderr: '' })
      expect(smoke.stdout).toContain('ab — the agent↔store channel')
      expect(smoke.stdout).not.toContain('host-conflicting-ab')
      await runner.end(session)
    } finally {
      if (originalPath === undefined) delete process.env['PATH']
      else process.env['PATH'] = originalPath
      await rm(conflictDir, { recursive: true, force: true })
    }
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
      prompt: '/ab-plan auth-rate-limit',
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
