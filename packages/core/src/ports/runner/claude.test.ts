import { afterEach, describe, expect, test } from 'bun:test'
import { delimiter } from 'node:path'
import type { StreamPart } from '../../store/streams/types'
import type { AgentRunner, AgentStartOpts, SessionStreamEmitter } from '../types'
import {
  CONTRACT_EXHAUSTION_FAILURE,
  CONTRACT_FOLLOW_UP,
  CONTRACT_ONE_SHOT_PROMPT,
  CONTRACT_ONE_SHOT_TEXT,
  CONTRACT_PERMANENT_FAILURE,
  CONTRACT_RETRYABLE_FAILURE,
  CONTRACT_STREAM_TOOL,
  describeAgentRunnerContract,
  type AgentRunnerContractFactory,
} from './contract'
import {
  ClaudeAgentRunner,
  isClaudeRuntimeUsable,
  type ClaudeCliInvocation,
  type ClaudeCliResult,
  type ClaudeCliRunFn,
  type ClaudeCliStreamHandle,
} from './claude'
import { AGENT_BIN_DIR } from './session-env'

describe('Claude init usability', () => {
  const input = { cwd: '/repo', env: { PATH: '/bin' }, models: [] }

  test('requires a successful logged-in auth status', async () => {
    expect(
      await isClaudeRuntimeUsable(input, async () => ({
        stdout: '{"loggedIn":true}',
        stderr: '',
        exitCode: 0,
      })),
    ).toEqual({ usable: true, reason: 'Claude Code is installed and logged in' })
    expect(
      await isClaudeRuntimeUsable(input, async () => ({
        stdout: '{"loggedIn":false}',
        stderr: '',
        exitCode: 0,
      })),
    ).toEqual({ usable: false, reason: 'Claude Code is not logged in' })
  })

  test('treats missing executables and malformed output as unusable', async () => {
    expect(
      await isClaudeRuntimeUsable(input, async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }),
    ).toEqual({ usable: false, reason: 'missing' })
    expect(
      await isClaudeRuntimeUsable(input, async () => ({
        stdout: 'not-json',
        stderr: '',
        exitCode: 0,
      })),
    ).toEqual({ usable: false, reason: 'Claude auth status returned malformed JSON' })
  })
})

function event(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

function assistant(...texts: string[]): Record<string, unknown> {
  return {
    type: 'assistant',
    message: { content: texts.map((text) => ({ type: 'text', text })) },
  }
}

function result(
  sessionId: string,
  inputTokens: number,
  outputTokens: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    ...extra,
  }
}

function output(
  events: Record<string, unknown>[],
  opts: { stderr?: string; exitCode?: number } = {},
): ClaudeCliResult {
  return {
    stdout: events.map(event).join('\n') + (events.length > 0 ? '\n' : ''),
    stderr: opts.stderr ?? '',
    exitCode: opts.exitCode ?? 0,
  }
}

function fakeCli(
  scripts: Array<ClaudeCliResult | Error | ((call: ClaudeCliInvocation) => ClaudeCliResult)>,
): { calls: ClaudeCliInvocation[]; runCli: ClaudeCliRunFn } {
  const calls: ClaudeCliInvocation[] = []
  return {
    calls,
    runCli: async (call) => {
      calls.push(call)
      const script = scripts[calls.length - 1]
      if (script === undefined) throw new Error('missing fake CLI script')
      if (script instanceof Error) throw script
      return typeof script === 'function' ? script(call) : script
    },
  }
}

function promptOf(call: ClaudeCliInvocation): string {
  const index = call.args.indexOf('--')
  return call.args[index + 1] ?? ''
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

function waitForContractAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (signal === undefined) return reject(new Error('contract CLI received no AbortSignal'))
    const abort = () => reject(signal.reason ?? new Error('contract CLI aborted'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

const claudeContractFactory: AgentRunnerContractFactory = (scenario) => {
  const calls: ClaudeCliInvocation[] = []
  const runCli: ClaudeCliRunFn = async (call) => {
    calls.push(call)
    const prompt = promptOf(call)
    if (prompt === CONTRACT_ONE_SHOT_PROMPT) {
      return output([
        assistant(CONTRACT_ONE_SHOT_TEXT),
        result('unused-one-shot', 2, 1, { result: CONTRACT_ONE_SHOT_TEXT }),
      ])
    }
    if (
      scenario === 'cancel-start' ||
      (scenario === 'cancel-continue' && prompt === CONTRACT_FOLLOW_UP)
    ) {
      return waitForContractAbort(call.signal)
    }
    if (scenario === 'retryable-failure') {
      return output([
        result('contract-session', 0, 0, {
          is_error: true,
          result: CONTRACT_RETRYABLE_FAILURE,
        }),
      ])
    }
    if (scenario === 'permanent-failure') {
      return output([
        result('contract-session', 0, 0, {
          is_error: true,
          result: CONTRACT_PERMANENT_FAILURE,
          api_error_status: 401,
        }),
      ])
    }
    if (scenario === 'exhaustion-failure') {
      return output([
        result('contract-session', 0, 0, {
          is_error: true,
          result: CONTRACT_EXHAUSTION_FAILURE,
          api_error_status: 402,
        }),
      ])
    }
    const text = prompt === CONTRACT_FOLLOW_UP ? 'contract continued' : 'contract started'
    if (scenario === 'stream-turn') {
      return output([
        assistant('contract stream'),
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'tool-1', name: CONTRACT_STREAM_TOOL, input: { q: 'x' } },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
          },
        },
        result('contract-session', 3, 2, { result: text }),
      ])
    }
    return output([assistant(text), result('contract-session', 3, 2, { result: text })])
  }
  // The recording emitter forwards to the caller's emitter (if any) while
  // keeping every part observable for the stream contract tests.
  const recorded: StreamPart[] = []
  const record = <T extends { stream?: SessionStreamEmitter }>(opts: T): T =>
    opts.stream === undefined
      ? opts
      : {
          ...opts,
          stream: {
            append: (parts: StreamPart[]) => {
              recorded.push(...parts)
              opts.stream?.append(parts)
            },
          },
        }
  const inner = new ClaudeAgentRunner({
    runCli,
    createSessionId: () => 'contract-session',
  })
  const runner: AgentRunner = {
    name: inner.name,
    start: (opts) => inner.start(record(opts)),
    continue: (session, message, opts) =>
      inner.continue(session, message, opts === undefined ? undefined : record(opts)),
    end: (session) => inner.end(session),
  }
  return {
    runner,
    model: 'claude-contract-model',
    workspacePath: process.cwd(),
    stream: () => recorded,
    turns: () =>
      calls
        .filter((call) => promptOf(call) !== CONTRACT_ONE_SHOT_PROMPT)
        .map((call) => ({
          ...(promptOf(call) === CONTRACT_FOLLOW_UP ? { message: promptOf(call) } : {}),
          env: call.env,
        })),
    oneShot: {
      completion: inner,
      observation: () => {
        const call = calls.find((candidate) => promptOf(candidate) === CONTRACT_ONE_SHOT_PROMPT)
        if (call === undefined) return undefined
        const modelIndex = call.args.indexOf('--model')
        return {
          prompt: promptOf(call),
          cwd: call.cwd,
          env: call.env,
          ...(modelIndex >= 0 ? { model: call.args[modelIndex + 1] } : {}),
        }
      },
    },
  }
}

describeAgentRunnerContract('ClaudeAgentRunner (injected Claude Code CLI)', claudeContractFactory)

afterEach(() => {
  delete process.env.AB_TEST_AMBIENT
  delete process.env.AB_TEST_OVERRIDE
})

describe('ClaudeAgentRunner start and continue', () => {
  test('uses exact headless argv and -- terminates a leading-dash resume prompt', async () => {
    const cli = fakeCli([
      output([result('cli-echoed-id', 1, 1, { result: 'started' })]),
      output([result('cli-echoed-id', 2, 1, { result: 'continued' })]),
    ])
    const runner = new ClaudeAgentRunner({
      runCli: cli.runCli,
      createSessionId: () => '11111111-1111-4111-8111-111111111111',
    })
    const { session } = await runner.start(
      startOpts({ model: 'claude-opus-4', args: ['--bg', '--permission-mode', 'plan'] }),
    )
    await runner.continue(session, '- address findings')

    expect(session).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      runner: 'claude',
      model: 'claude-opus-4',
    })
    expect(cli.calls[0]?.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--session-id',
      session.id,
      '--model',
      'claude-opus-4',
      '--bg',
      '--permission-mode',
      'plan',
      '--',
      '/ab-plan auth-rate-limit',
    ])
    expect(cli.calls[1]?.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--resume',
      session.id,
      '--model',
      'claude-opus-4',
      '--bg',
      '--permission-mode',
      'plan',
      '--',
      '- address findings',
    ])
    expect(cli.calls[0]?.cwd).toBe('/ws/auth-rate-limit')
    expect(cli.calls[1]?.cwd).toBe('/ws/auth-rate-limit')
    await runner.end(session)
  })

  test('omits --model so Claude Code selects its configured default', async () => {
    const cli = fakeCli([output([result('ignored', 1, 1)])])
    const runner = new ClaudeAgentRunner({ runCli: cli.runCli })
    const { session } = await runner.start(startOpts())
    expect(cli.calls[0]?.args).not.toContain('--model')
    expect(session.model).toBeUndefined()
    expect(session.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    await runner.end(session)
  })

  test('refreshes scoped env on resume and keeps managed ab first on PATH', async () => {
    process.env.AB_TEST_AMBIENT = 'from-process'
    process.env.AB_TEST_OVERRIDE = 'ambient-loses'
    const cli = fakeCli([output([result('ignored', 1, 1)]), output([result('ignored', 1, 1)])])
    const runner = new ClaudeAgentRunner({ runCli: cli.runCli, createSessionId: () => 's1' })
    const { session } = await runner.start(
      startOpts({
        env: {
          AB_BUILD: 'auth-rate-limit',
          AB_PHASE: 'implement@1',
          AB_SESSION: 'round-1',
          AB_TEST_OVERRIDE: 'scoped-wins',
        },
      }),
    )
    await runner.continue(session, 'next', {
      env: { AB_PHASE: 'implement@2', AB_SESSION: 'round-2' },
    })

    expect(cli.calls[0]?.env.AB_TEST_AMBIENT).toBe('from-process')
    expect(cli.calls[0]?.env.AB_TEST_OVERRIDE).toBe('scoped-wins')
    expect(cli.calls[1]?.env).toMatchObject({
      AB_BUILD: 'auth-rate-limit',
      AB_PHASE: 'implement@2',
      AB_SESSION: 'round-2',
    })
    expect(cli.calls[1]?.env.PATH?.split(delimiter)[0]).toBe(AGENT_BIN_DIR)
    await runner.end(session)
  })

  test('uses result text and usage while retaining assistant/tool/system events', async () => {
    const events = [
      { type: 'system', subtype: 'init' },
      assistant('streamed text'),
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
      result('ignored', 10, 5, { result: 'terminal text' }),
    ]
    const cli = fakeCli([output(events)])
    const runner = new ClaudeAgentRunner({ runCli: cli.runCli, createSessionId: () => 's1' })
    const { session, result: turn } = await runner.start(startOpts())
    expect(turn).toEqual({
      kind: 'completed',
      text: 'terminal text',
      usage: { inputTokens: 10, outputTokens: 5, turns: 1 },
    })
    const transcript = JSON.parse((await runner.end(session)).content)
    expect(transcript.turns[0].events).toEqual(events)
  })
})

describe('ClaudeAgentRunner failures', () => {
  test('classifies the real logged-out success-subtype shape as permanent', async () => {
    const message = 'Not logged in · Please run /login'
    const cli = fakeCli([
      output([
        { type: 'assistant', error: 'authentication_failed', message: { content: [] } },
        result('ignored', 0, 0, {
          subtype: 'success',
          is_error: true,
          result: message,
        }),
      ]),
    ])
    const runner = new ClaudeAgentRunner({ runCli: cli.runCli, createSessionId: () => 's-auth' })
    const { session, result: turn } = await runner.start(startOpts())
    expect(turn).toEqual({
      kind: 'failed',
      text: message,
      usage: { inputTokens: 0, outputTokens: 0, turns: 1 },
      failure: { message, permanent: true, cause: 'credentials' },
    })
    await runner.end(session)
  })

  test('uses system api-retry status/category as positive classification hints', async () => {
    const message = 'request rejected'
    const cli = fakeCli([
      output([
        { type: 'system', subtype: 'api_retry', status: 403, category: 'permission_denied' },
        result('ignored', 0, 0, { is_error: true, result: message }),
      ]),
    ])
    const runner = new ClaudeAgentRunner({ runCli: cli.runCli, createSessionId: () => 's1' })
    const { session, result: turn } = await runner.start(startOpts())
    expect(turn).toMatchObject({
      kind: 'failed',
      failure: { message, permanent: true },
    })
    await runner.end(session)
  })

  test('keeps nonzero unknown stderr verbatim and retryable', async () => {
    const stderr = 'worker process exited unexpectedly\nwith details\n'
    const cli = fakeCli([{ stdout: '', stderr, exitCode: 7 }])
    const runner = new ClaudeAgentRunner({ runCli: cli.runCli, createSessionId: () => 's1' })
    const { session, result: turn } = await runner.start(startOpts())
    expect(turn).toMatchObject({
      kind: 'failed',
      failure: { message: stderr, permanent: false },
    })
    await runner.end(session)
  })

  test.each([
    [
      'malformed stream',
      { stdout: 'not-json\n', stderr: '', exitCode: 0 },
      'malformed stream-json',
    ],
    ['missing result', output([assistant('partial')]), 'without a result event'],
  ])('returns an endable retryable handle for %s', async (_name, script, message) => {
    const cli = fakeCli([script])
    const runner = new ClaudeAgentRunner({
      runCli: cli.runCli,
      createSessionId: () => 's-protocol',
    })
    const { session, result: turn } = await runner.start(startOpts())
    expect(turn.kind).toBe('failed')
    if (turn.kind !== 'failed') throw new Error('unreachable')
    expect(turn.failure.permanent).toBe(false)
    expect(turn.failure.message).toContain(message)
    const transcript = JSON.parse((await runner.end(session)).content)
    expect(transcript.turns[0].cli.stdout).toBe(script.stdout)
  })

  test('missing executable is actionable, permanent, zero-usage, and transcript-backed', async () => {
    const missing = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
    const cli = fakeCli([missing])
    const runner = new ClaudeAgentRunner({ runCli: cli.runCli, createSessionId: () => 's-missing' })
    const { session, result: turn } = await runner.start(startOpts())
    expect(turn).toMatchObject({
      kind: 'failed',
      text: '',
      usage: { inputTokens: 0, outputTokens: 0, turns: 1 },
      failure: { permanent: true },
    })
    if (turn.kind !== 'failed') throw new Error('unreachable')
    expect(turn.failure.message).toContain('Install Claude Code')
    expect(turn.failure.message).toContain('complete login')
    const transcript = await runner.end(session)
    expect(transcript.content).toContain('spawn claude ENOENT')
  })
})

describe('ClaudeAgentRunner complete', () => {
  test('is tool-free, single-turn, non-persistent, verbatim, and forwards cancellation', async () => {
    const cli = fakeCli([output([result('unused', 2, 1, { result: 'slug-name' })])])
    const runner = new ClaudeAgentRunner({ runCli: cli.runCli })
    const controller = new AbortController()
    const completed = await runner.complete({
      prompt: 'name this spec verbatim',
      cwd: '/repos/app',
      env: { NAMING_TOKEN: 'secret' },
      model: 'claude-haiku-4',
      args: ['--effort', 'high'],
      signal: controller.signal,
    })

    expect(completed).toEqual({ text: 'slug-name' })
    expect(cli.calls[0]).toMatchObject({ cwd: '/repos/app', signal: controller.signal })
    expect(cli.calls[0]?.env.NAMING_TOKEN).toBe('secret')
    expect(cli.calls[0]?.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--tools',
      '',
      '--disallowedTools',
      'mcp__*',
      '--no-session-persistence',
      '--model',
      'claude-haiku-4',
      '--effort',
      'high',
      '--',
      'name this spec verbatim',
    ])
    expect(cli.calls[0]?.args).not.toContain('--max-turns')
    expect(cli.calls[0]?.args).not.toContain('--session-id')
    expect(cli.calls[0]?.args).not.toContain('--resume')
    await expect(runner.end({ id: 'unused', runner: 'claude' })).rejects.toThrow(
      'unknown session "unused"',
    )
  })

  test('throws provider failures', async () => {
    const cli = fakeCli([
      output([result('unused', 0, 0, { is_error: true, result: 'Billing error: no credits' })]),
    ])
    const runner = new ClaudeAgentRunner({ runCli: cli.runCli })
    await expect(runner.complete({ prompt: 'name it', cwd: '/repo', env: {} })).rejects.toThrow(
      'Billing error: no credits',
    )
  })
})

describe('ClaudeAgentRunner transcript and lifecycle', () => {
  test('retains complete raw stdout/stderr and sums per-turn usage', async () => {
    const first = output([assistant('one'), result('ignored', 10, 5, { result: 'one' })], {
      stderr: 'first diagnostic\n',
    })
    const second = output([assistant('two'), result('ignored', 7, 3, { result: 'two' })], {
      stderr: 'second diagnostic\n',
    })
    const cli = fakeCli([first, second])
    const runner = new ClaudeAgentRunner({ runCli: cli.runCli, createSessionId: () => 's1' })
    const { session } = await runner.start(startOpts({ model: 'claude-opus-4' }))
    await runner.continue(session, 'revise please')
    const transcript = await runner.end(session)

    expect(transcript.metadata).toEqual({
      runner: 'claude',
      model: 'claude-opus-4',
      usage: { inputTokens: 17, outputTokens: 8, turns: 2 },
    })
    const content = JSON.parse(transcript.content)
    expect(content.turns[0].cli).toEqual(first)
    expect(content.turns[1].cli).toEqual(second)
    expect(content.turns[1]).toMatchObject({
      turn: 2,
      prompt: 'revise please',
      text: 'two',
    })
  })

  test('rejects unknown continue/end and double end', async () => {
    const cli = fakeCli([output([result('ignored', 1, 1)])])
    const runner = new ClaudeAgentRunner({ runCli: cli.runCli, createSessionId: () => 's1' })
    await expect(runner.continue({ id: 'nope', runner: 'claude' }, 'hello')).rejects.toThrow(
      'unknown session "nope"',
    )
    await expect(runner.end({ id: 'nope', runner: 'claude' })).rejects.toThrow(
      'unknown session "nope"',
    )
    const { session } = await runner.start(startOpts())
    await runner.end(session)
    await expect(runner.end(session)).rejects.toThrow('unknown session "s1"')
  })
})

describe('ClaudeAgentRunner streaming boundary (SPEC §9)', () => {
  function streamHandle(lines: string[], cli: ClaudeCliResult): { handle: ClaudeCliStreamHandle } {
    return {
      handle: {
        lines: (async function* () {
          for (const line of lines) yield line
        })(),
        result: Promise.resolve(cli),
      },
    }
  }

  test('maps stream_event deltas live and adds --include-partial-messages only when streaming', async () => {
    const recorded: string[] = []
    const stream = streamHandle(
      [
        event({ type: 'stream_event', event: { type: 'message_start' } }),
        event({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', id: 't1' },
          },
        }),
        event({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'hel' },
          },
        }),
        event({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'lo' },
          },
        }),
        event({
          type: 'stream_event',
          event: { type: 'content_block_stop', index: 0 },
        }),
        event({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'tool-1', name: 'grep' },
          },
        }),
        event({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' },
          },
        }),
        event({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } }),
        event({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
        }),
        event({ type: 'stream_event', event: { type: 'message_stop' } }),
        event(assistant('hello')),
        event(result('s1', 3, 2, { result: 'hello' })),
      ],
      output([result('s1', 3, 2, { result: 'hello' })]),
    )
    let streamingArgs: string[] | undefined
    const runner = new ClaudeAgentRunner({
      createSessionId: () => 's1',
      runCliStream: (invocation) => {
        streamingArgs = invocation.args
        recorded.push('stream')
        return stream.handle
      },
      runCli: async (invocation) => {
        recorded.push('buffered')
        void invocation
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    })
    const parts: StreamPart[] = []
    const started = await runner.start({
      ...startOpts(),
      stream: { append: (appended) => parts.push(...appended) },
    })
    expect(started.result).toMatchObject({ kind: 'completed', text: 'hello' })
    // Only the streaming boundary ran, and the flag is present.
    expect(recorded).toEqual(['stream'])
    expect(streamingArgs).toContain('--include-partial-messages')

    const types = parts.map((part) => part.type)
    expect(types[0]).toBe('data-ab-prompt')
    expect(types).toContain('start')
    expect(types).toContain('start-step')
    expect(types).toContain('text-start')
    expect(types).toContain('text-delta')
    expect(types).toContain('text-end')
    expect(types).toContain('tool-input-available')
    expect(types).toContain('tool-output-available')
    expect(types).toContain('finish-step')
    expect(parts.at(-1)?.type).toBe('finish')

    // The tool input arrives from buffered input_json_delta, parsed.
    const toolInput = parts.find((p) => p.type === 'tool-input-available') as unknown as {
      input: unknown
    }
    expect(toolInput.input).toEqual({ q: 'x' })

    // A turn WITHOUT an emitter never asks for partial messages and uses the
    // buffered boundary.
    const plain = new ClaudeAgentRunner({
      createSessionId: () => 's2',
      runCli: async () => output([assistant('plain'), result('s2', 1, 1, { result: 'plain' })]),
    })
    const unstreamed = await plain.start(startOpts())
    expect(unstreamed.result).toMatchObject({ kind: 'completed', text: 'plain' })
  })

  test('a streamed failure emits error and a cancelled turn emits abort', async () => {
    const runner = new ClaudeAgentRunner({
      createSessionId: () => 's1',
      runCliStream: () => ({
        lines: (async function* () {
          yield event({ type: 'stream_event', event: { type: 'message_start' } })
          yield event(result('s1', 0, 0, { is_error: true, result: CONTRACT_RETRYABLE_FAILURE }))
        })(),
        result: Promise.resolve(
          output([result('s1', 0, 0, { is_error: true, result: CONTRACT_RETRYABLE_FAILURE })]),
        ),
      }),
    })
    const failedParts: StreamPart[] = []
    await runner.start({
      ...startOpts(),
      stream: { append: (appended) => failedParts.push(...appended) },
    })
    expect(failedParts.at(-1)?.type).toBe('error')

    const cancelledParts: StreamPart[] = []
    const controller = new AbortController()
    const cancelling = new ClaudeAgentRunner({
      createSessionId: () => 's1',
      runCliStream: (invocation) => ({
        lines: (async function* () {
          yield event({ type: 'stream_event', event: { type: 'message_start' } })
          await new Promise((resolve) => {
            const abort = () => resolve(undefined)
            if (invocation.signal?.aborted) abort()
            else invocation.signal?.addEventListener('abort', abort, { once: true })
          })
        })(),
        result: new Promise((resolve) => {
          invocation.signal?.addEventListener('abort', () => {
            resolve({ stdout: '', stderr: 'aborted', exitCode: 1 })
          })
        }),
      }),
    })
    const pending = cancelling.start({
      ...startOpts(),
      signal: controller.signal,
      stream: { append: (appended) => cancelledParts.push(...appended) },
    })
    controller.abort(new Error('operator stopped'))
    await pending
    expect(cancelledParts.at(-1)?.type).toBe('abort')
  })
})

describe('ClaudeAgentRunner continued-turn stream forwarding (SPEC §9)', () => {
  test('a continued turn translates through its own per-turn emitter', async () => {
    const events = [assistant('continued text'), result('s1', 2, 1, { result: 'continued text' })]
    const cli = fakeCli([
      output([assistant('started text'), result('s1', 1, 1, { result: 'started text' })]),
      output(events),
    ])
    const runner = new ClaudeAgentRunner({ runCli: cli.runCli, createSessionId: () => 's1' })
    const startParts: StreamPart[] = []
    const { session } = await runner.start({
      ...startOpts(),
      stream: { append: (appended) => startParts.push(...appended) },
    })
    const continueParts: StreamPart[] = []
    await runner.continue(session, '- address findings', {
      env: { AB_PHASE: 'implement@2', AB_SESSION: 'round-2' },
      stream: { append: (appended) => continueParts.push(...appended) },
    })

    // The continued turn emits the same translation sequence as the
    // equivalent start turn — the per-turn emitter is the only difference.
    expect(continueParts.map((part) => part.type)).toEqual(startParts.map((part) => part.type))
    expect(continueParts[0]).toEqual({
      type: 'data-ab-prompt',
      data: { text: '- address findings' },
    })
    // Both turns asked for partial messages: each carried a live emitter.
    expect(cli.calls[0]?.args).toContain('--include-partial-messages')
    expect(cli.calls[1]?.args).toContain('--include-partial-messages')
  })

  test("a continued turn without an emitter emits nothing, not the start turn's stream", async () => {
    const cli = fakeCli([
      output([assistant('started'), result('s1', 1, 1, { result: 'started' })]),
      output([assistant('continued'), result('s1', 2, 1, { result: 'continued' })]),
    ])
    const runner = new ClaudeAgentRunner({ runCli: cli.runCli, createSessionId: () => 's1' })
    const startParts: StreamPart[] = []
    const { session } = await runner.start({
      ...startOpts(),
      stream: { append: (appended) => startParts.push(...appended) },
    })
    const startPartCount = startParts.length
    await runner.continue(session, '- address findings')

    // The start emitter received nothing from the continued turn, and the
    // continued CLI invocation never asked for partial messages.
    expect(startParts.length).toBe(startPartCount)
    expect(cli.calls[1]?.args).not.toContain('--include-partial-messages')
  })
})
