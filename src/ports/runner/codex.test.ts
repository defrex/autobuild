import { afterEach, describe, expect, test } from 'bun:test'
import { delimiter } from 'node:path'
import type { AgentStartOpts } from '../types'
import {
  CONTRACT_EXHAUSTION_FAILURE,
  CONTRACT_FOLLOW_UP,
  CONTRACT_ONE_SHOT_PROMPT,
  CONTRACT_ONE_SHOT_TEXT,
  CONTRACT_PERMANENT_FAILURE,
  CONTRACT_RETRYABLE_FAILURE,
  describeAgentRunnerContract,
  type AgentRunnerContractFactory,
} from './contract'
import {
  CodexAgentRunner,
  isCodexRuntimeUsable,
  type CodexCliInvocation,
  type CodexCliResult,
  type CodexCliRunFn,
} from './codex'
import { AGENT_BIN_DIR } from './session-env'

function event(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

function thread(id = 'thread-1'): Record<string, unknown> {
  return { type: 'thread.started', thread_id: id }
}

function message(text: string): Record<string, unknown> {
  return { type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text } }
}

function completed(inputTokens = 3, outputTokens = 2): Record<string, unknown> {
  return {
    type: 'turn.completed',
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  }
}

function output(
  events: Record<string, unknown>[],
  opts: { stderr?: string; exitCode?: number } = {},
): CodexCliResult {
  return {
    stdout: events.map(event).join('\n') + (events.length > 0 ? '\n' : ''),
    stderr: opts.stderr ?? '',
    exitCode: opts.exitCode ?? 0,
  }
}

function fakeCli(
  scripts: Array<CodexCliResult | Error | ((call: CodexCliInvocation) => CodexCliResult)>,
): { calls: CodexCliInvocation[]; runCli: CodexCliRunFn } {
  const calls: CodexCliInvocation[] = []
  return {
    calls,
    runCli: async (call) => {
      calls.push(call)
      const script = scripts[calls.length - 1]
      if (script === undefined) throw new Error('missing fake Codex CLI script')
      if (script instanceof Error) throw script
      return typeof script === 'function' ? script(call) : script
    },
  }
}

function promptOf(call: CodexCliInvocation): string {
  const delimiter = call.args.lastIndexOf('--')
  return call.args[delimiter + 1] ?? ''
}

function startOpts(overrides: Partial<AgentStartOpts> = {}): AgentStartOpts {
  return {
    skill: 'ab-plan',
    invocation: 'codex-runtime',
    workspacePath: '/ws/codex-runtime',
    env: { AB_BUILD: 'codex-runtime', AB_SESSION: 's_1' },
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

const codexContractFactory: AgentRunnerContractFactory = (scenario) => {
  const calls: CodexCliInvocation[] = []
  const runCli: CodexCliRunFn = async (call) => {
    calls.push(call)
    const prompt = promptOf(call)
    if (prompt === CONTRACT_ONE_SHOT_PROMPT) {
      return output([thread('one-shot'), message(CONTRACT_ONE_SHOT_TEXT), completed(2, 1)])
    }
    if (
      scenario === 'cancel-start' ||
      (scenario === 'cancel-continue' && prompt === CONTRACT_FOLLOW_UP)
    ) {
      return waitForContractAbort(call.signal)
    }
    if (scenario === 'retryable-failure') {
      return output([
        thread('contract-thread'),
        { type: 'turn.failed', error: { message: CONTRACT_RETRYABLE_FAILURE } },
      ])
    }
    if (scenario === 'permanent-failure') {
      return output([
        thread('contract-thread'),
        { type: 'turn.failed', error: { message: CONTRACT_PERMANENT_FAILURE, status: 401 } },
      ])
    }
    if (scenario === 'exhaustion-failure') {
      return output([
        thread('contract-thread'),
        { type: 'turn.failed', error: { message: CONTRACT_EXHAUSTION_FAILURE, status: 402 } },
      ])
    }
    const text = prompt === CONTRACT_FOLLOW_UP ? 'contract continued' : 'contract started'
    return output([thread('contract-thread'), message(text), completed()])
  }
  const runner = new CodexAgentRunner({ runCli, createSessionId: () => 'synthetic-contract' })
  return {
    runner,
    model: 'gpt-contract-model',
    workspacePath: process.cwd(),
    turns: () =>
      calls
        .filter((call) => promptOf(call) !== CONTRACT_ONE_SHOT_PROMPT)
        .map((call) => ({
          ...(promptOf(call) === CONTRACT_FOLLOW_UP ? { message: promptOf(call) } : {}),
          env: call.env,
        })),
    oneShot: {
      completion: runner,
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

describeAgentRunnerContract('CodexAgentRunner (injected Codex CLI)', codexContractFactory)

afterEach(() => {
  delete process.env.AB_TEST_AMBIENT
})

describe('Codex runtime usability', () => {
  const input = { cwd: '/workspace', env: { PATH: '/bin', UNSET: undefined }, models: [] }

  test('requires a successful local login status', async () => {
    const usable = fakeCli([output([])])
    expect(await isCodexRuntimeUsable(input, usable.runCli)).toEqual({
      usable: true,
      reason: 'Codex CLI is installed and logged in',
    })
    expect(usable.calls).toEqual([
      { args: ['login', 'status'], cwd: '/workspace', env: { PATH: '/bin' } },
    ])

    const loggedOut = fakeCli([output([], { exitCode: 1 })])
    expect(await isCodexRuntimeUsable(input, loggedOut.runCli)).toEqual({
      usable: false,
      reason: 'Codex is not logged in',
    })
  })

  test('treats a missing executable as unusable', async () => {
    const missing = fakeCli([Object.assign(new Error('missing'), { code: 'ENOENT' })])
    expect(await isCodexRuntimeUsable(input, missing.runCli)).toEqual({
      usable: false,
      reason: 'missing',
    })
  })
})

describe('CodexAgentRunner start and continue', () => {
  test('uses exact exec/resume argv, native thread id, and Codex skill syntax', async () => {
    const cli = fakeCli([
      output([thread('native-thread'), message('started'), completed(4, 2)]),
      output([thread('native-thread'), message('continued'), completed(2, 1)]),
    ])
    const runner = new CodexAgentRunner({ runCli: cli.runCli })
    const { session, result } = await runner.start(startOpts({ model: 'gpt-5.4' }))
    await runner.continue(session, '- address findings')

    expect(session).toEqual({ id: 'native-thread', runner: 'codex', model: 'gpt-5.4' })
    expect(result).toEqual({
      kind: 'completed',
      text: 'started',
      usage: { inputTokens: 4, outputTokens: 2, turns: 1 },
    })
    expect(cli.calls[0]?.args).toEqual([
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--config',
      'shell_environment_policy.inherit=all',
      '--model',
      'gpt-5.4',
      '--',
      '$ab-plan codex-runtime',
    ])
    expect(cli.calls[1]?.args).toEqual([
      'exec',
      'resume',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--config',
      'shell_environment_policy.inherit=all',
      '--model',
      'gpt-5.4',
      'native-thread',
      '--',
      '- address findings',
    ])
    await runner.end(session)
  })

  test('omits model, refreshes scoped env, and keeps managed ab first on PATH', async () => {
    process.env.AB_TEST_AMBIENT = 'from-process'
    const cli = fakeCli([output([thread(), completed()]), output([thread(), completed()])])
    const runner = new CodexAgentRunner({ runCli: cli.runCli })
    const { session } = await runner.start(startOpts({ env: { AB_PHASE: 'implement@1' } }))
    await runner.continue(session, 'next', { env: { AB_PHASE: 'implement@2' } })

    expect(cli.calls[0]?.args).not.toContain('--model')
    expect(cli.calls[0]?.env.AB_TEST_AMBIENT).toBe('from-process')
    expect(cli.calls[1]?.env.AB_PHASE).toBe('implement@2')
    expect(cli.calls[1]?.env.PATH?.split(delimiter)[0]).toBe(AGENT_BIN_DIR)
    await runner.end(session)
  })
})

describe('CodexAgentRunner protocol and failures', () => {
  test('retains raw JSONL/stdout/stderr and sums usage', async () => {
    const first = output(
      [
        thread(),
        { type: 'item.completed', item: { type: 'reasoning', text: 'r' } },
        message('one'),
        completed(10, 5),
      ],
      { stderr: 'diagnostic one\n' },
    )
    const second = output([thread(), message('two'), completed(7, 3)], {
      stderr: 'diagnostic two\n',
    })
    const cli = fakeCli([first, second])
    const runner = new CodexAgentRunner({ runCli: cli.runCli })
    const { session } = await runner.start(startOpts({ model: 'gpt-5.4' }))
    await runner.continue(session, 'revise')
    const transcript = await runner.end(session)
    expect(transcript.metadata).toEqual({
      runner: 'codex',
      model: 'gpt-5.4',
      usage: { inputTokens: 17, outputTokens: 8, turns: 2 },
    })
    const content = JSON.parse(transcript.content)
    expect(content.nativeThreadId).toBe('thread-1')
    expect(content.turns[0].cli).toEqual(first)
    expect(content.turns[1].cli).toEqual(second)
  })

  test.each([
    ['malformed JSONL', { stdout: 'not-json\n', stderr: '', exitCode: 0 }, 'malformed JSONL'],
    ['missing terminal', output([thread(), message('partial')]), 'without a turn.completed'],
  ])('returns an endable retryable handle for %s', async (_name, script, expected) => {
    const cli = fakeCli([script])
    const runner = new CodexAgentRunner({ runCli: cli.runCli })
    const { session, result } = await runner.start(startOpts())
    expect(result).toMatchObject({ kind: 'failed', failure: { permanent: false } })
    if (result.kind === 'failed') expect(result.failure.message).toContain(expected)
    const transcript = JSON.parse((await runner.end(session)).content)
    expect(transcript.turns[0].cli.stdout).toBe(script.stdout)
  })

  test.each([
    ['startup exit', { stdout: '', stderr: 'worker crashed', exitCode: 7 }, 'worker crashed'],
    [
      'missing thread event',
      output([message('orphaned completion'), completed()]),
      'without a thread.started event',
    ],
  ])(
    'a pre-thread %s gets a synthetic endable, non-resumable handle',
    async (_name, script, expected) => {
      const cli = fakeCli([script])
      const runner = new CodexAgentRunner({ runCli: cli.runCli, createSessionId: () => 'local-1' })
      const { session, result } = await runner.start(startOpts())
      expect(session.id).toBe('local-1')
      expect(result).toMatchObject({
        kind: 'failed',
        failure: { permanent: false },
      })
      if (result.kind === 'failed') expect(result.failure.message).toContain(expected)
      await expect(runner.continue(session, 'retry')).rejects.toThrow('before thread.started')
      await runner.end(session)
    },
  )

  test('missing executable and logged-out output are actionable and permanent', async () => {
    const missing = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })
    const cli = fakeCli([
      missing,
      output(
        [thread('logged-out'), { type: 'error', message: 'Not logged in. Run codex login.' }],
        { exitCode: 1 },
      ),
    ])
    const runner = new CodexAgentRunner({
      runCli: cli.runCli,
      createSessionId: () => 'local-missing',
    })
    const absent = await runner.start(startOpts())
    expect(absent.result).toMatchObject({ kind: 'failed', failure: { permanent: true } })
    if (absent.result.kind === 'failed') {
      expect(absent.result.failure.message).toContain('codex runtime')
      expect(absent.result.failure.message).toContain('executable "codex"')
      expect(absent.result.failure.message).toContain('codex login')
    }
    await runner.end(absent.session)

    const loggedOut = await runner.start(startOpts())
    expect(loggedOut.result).toMatchObject({ kind: 'failed', failure: { permanent: true } })
    if (loggedOut.result.kind === 'failed') {
      expect(loggedOut.result.failure.message).toContain('codex runtime')
      expect(loggedOut.result.failure.message).toContain('executable "codex"')
      expect(loggedOut.result.failure.message).toContain('Not logged in')
    }
    await runner.end(loggedOut.session)
  })

  test('rejects unknown continue/end and double end', async () => {
    const runner = new CodexAgentRunner({
      runCli: fakeCli([output([thread(), completed()])]).runCli,
    })
    await expect(runner.continue({ id: 'nope', runner: 'codex' }, 'x')).rejects.toThrow(
      'unknown session',
    )
    const { session } = await runner.start(startOpts())
    await runner.end(session)
    await expect(runner.end(session)).rejects.toThrow('unknown session')
  })
})

describe('CodexAgentRunner complete', () => {
  test('is ephemeral/read-only, tolerates warning items, forwards cancellation, and pins tool-free argv', async () => {
    const cli = fakeCli([
      output([
        thread('ephemeral'),
        {
          type: 'item.completed',
          item: { type: 'error', message: 'Model metadata not found; using fallback metadata.' },
        },
        message('slug-name'),
        completed(2, 1),
      ]),
    ])
    const runner = new CodexAgentRunner({ runCli: cli.runCli })
    const controller = new AbortController()
    const result = await runner.complete({
      prompt: 'name this spec',
      cwd: '/repo',
      env: { CODEX_HOME: '/auth/codex', AB_PHASE: 'slug' },
      model: 'gpt-5.4-mini',
      signal: controller.signal,
    })
    expect(result).toEqual({ text: 'slug-name' })
    expect(cli.calls[0]).toMatchObject({ cwd: '/repo', signal: controller.signal })
    expect(cli.calls[0]?.env.CODEX_HOME).toBe('/auth/codex')
    expect(cli.calls[0]?.args).toEqual([
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--sandbox',
      'read-only',
      '-c',
      'web_search="disabled"',
      '--disable',
      'shell_tool',
      '--disable',
      'unified_exec',
      '--disable',
      'standalone_web_search',
      '--disable',
      'apps',
      '--disable',
      'plugins',
      '--disable',
      'multi_agent',
      '--disable',
      'multi_agent_v2',
      '--disable',
      'image_generation',
      '--disable',
      'computer_use',
      '--disable',
      'browser_use',
      '--disable',
      'browser_use_external',
      '--disable',
      'browser_use_full_cdp_access',
      '--model',
      'gpt-5.4-mini',
      '--',
      'name this spec',
    ])
    expect(cli.calls[0]?.args).not.toContain('web_search_request')
    expect(cli.calls[0]?.args).not.toContain('web_search_cached')
    expect(promptOf(cli.calls[0]!)).toBe('name this spec')
  })

  test('fails closed when Codex emits tool activity', async () => {
    const cli = fakeCli([
      output([
        thread('ephemeral'),
        { type: 'item.completed', item: { type: 'command_execution', command: 'pwd' } },
        message('result'),
        completed(),
      ]),
    ])
    const runner = new CodexAgentRunner({ runCli: cli.runCli })
    await expect(runner.complete({ prompt: 'name it', cwd: '/repo', env: {} })).rejects.toThrow(
      'tool item(s): command_execution',
    )
  })
})
