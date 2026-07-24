import { afterEach, describe, expect, test } from 'bun:test'
import { delimiter } from 'node:path'
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
  type ClaudeCliInvocation,
  type ClaudeCliResult,
  type ClaudeCliRunFn,
} from './claude'
import { AGENT_BIN_DIR } from './session-env'

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
    const text = prompt === CONTRACT_FOLLOW_UP ? 'contract continued' : 'contract started'
    return output([assistant(text), result('contract-session', 3, 2, { result: text })])
  }
  const runner = new ClaudeAgentRunner({
    runCli,
    createSessionId: () => 'contract-session',
  })
  return {
    runner,
    model: 'claude-contract-model',
    workspacePath: process.cwd(),
    turns: () =>
      calls
        .filter((call) => promptOf(call) !== CONTRACT_ONE_SHOT_PROMPT)
        .map((call) => ({
          ...(promptOf(call) === CONTRACT_FOLLOW_UP
            ? { message: promptOf(call) }
            : {}),
          env: call.env,
        })),
    oneShot: {
      completion: runner,
      observation: () => {
        const call = calls.find(
          (candidate) => promptOf(candidate) === CONTRACT_ONE_SHOT_PROMPT,
        )
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

describeAgentRunnerContract(
  'ClaudeAgentRunner (injected Claude Code CLI)',
  claudeContractFactory,
)

afterEach(() => {
  delete process.env['AB_TEST_AMBIENT']
  delete process.env['AB_TEST_OVERRIDE']
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
    const { session } = await runner.start(startOpts({ model: 'claude-opus-4' }))
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
    process.env['AB_TEST_AMBIENT'] = 'from-process'
    process.env['AB_TEST_OVERRIDE'] = 'ambient-loses'
    const cli = fakeCli([
      output([result('ignored', 1, 1)]),
      output([result('ignored', 1, 1)]),
    ])
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

    expect(cli.calls[0]?.env['AB_TEST_AMBIENT']).toBe('from-process')
    expect(cli.calls[0]?.env['AB_TEST_OVERRIDE']).toBe('scoped-wins')
    expect(cli.calls[1]?.env).toMatchObject({
      AB_BUILD: 'auth-rate-limit',
      AB_PHASE: 'implement@2',
      AB_SESSION: 'round-2',
    })
    expect(cli.calls[1]?.env['PATH']?.split(delimiter)[0]).toBe(AGENT_BIN_DIR)
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
      failure: { message, permanent: true },
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
    ['malformed stream', { stdout: 'not-json\n', stderr: '', exitCode: 0 }, 'malformed stream-json'],
    ['missing result', output([assistant('partial')]), 'without a result event'],
  ])('returns an endable retryable handle for %s', async (_name, script, message) => {
    const cli = fakeCli([script])
    const runner = new ClaudeAgentRunner({ runCli: cli.runCli, createSessionId: () => 's-protocol' })
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
    const cli = fakeCli([
      output([result('unused', 2, 1, { result: 'slug-name' })]),
    ])
    const runner = new ClaudeAgentRunner({ runCli: cli.runCli })
    const controller = new AbortController()
    const completed = await runner.complete({
      prompt: 'name this spec verbatim',
      cwd: '/repos/app',
      env: { NAMING_TOKEN: 'secret' },
      model: 'claude-haiku-4',
      signal: controller.signal,
    })

    expect(completed).toEqual({ text: 'slug-name' })
    expect(cli.calls[0]).toMatchObject({ cwd: '/repos/app', signal: controller.signal })
    expect(cli.calls[0]?.env['NAMING_TOKEN']).toBe('secret')
    expect(cli.calls[0]?.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--tools',
      '',
      '--max-turns',
      '1',
      '--no-session-persistence',
      '--model',
      'claude-haiku-4',
      '--',
      'name this spec verbatim',
    ])
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
    const first = output(
      [assistant('one'), result('ignored', 10, 5, { result: 'one' })],
      { stderr: 'first diagnostic\n' },
    )
    const second = output(
      [assistant('two'), result('ignored', 7, 3, { result: 'two' })],
      { stderr: 'second diagnostic\n' },
    )
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
