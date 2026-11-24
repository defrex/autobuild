import { readFile, stat, access } from 'node:fs/promises'
import { dirname } from 'node:path'
import { nativeHandle } from './native-session'
import { expect, test } from 'bun:test'
import type { StreamPart } from '../../store/streams/types'
import type { AgentRunner, SessionStreamEmitter } from '../types'
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
  type ClaudeCliInvocation,
  type ClaudeCliResult,
  type ClaudeCliRunFn,
} from './claude'

import { assistant, result, output, promptOf, startOpts } from './claude-test.fixture'
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

test('selected account owns auth settings on start and continue and credential rejection names renewal', async () => {
  const calls: ClaudeCliInvocation[] = []
  const runner = new ClaudeAgentRunner({
    runCli: async (invocation) => {
      calls.push(invocation)
      const path = invocation.args[invocation.args.indexOf('--settings') + 1]!
      const settings = JSON.parse(await readFile(path, 'utf8'))
      expect(settings.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(invocation.env.CLAUDE_CODE_OAUTH_TOKEN)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
      expect(invocation.args.join(' ')).not.toContain(invocation.env.CLAUDE_CODE_OAUTH_TOKEN!)
      return {
        stdout: JSON.stringify({
          type: 'result',
          is_error: true,
          result: 'OAuth access token is invalid',
          api_error_status: 401,
        }),
        stderr: '',
        exitCode: 1,
      }
    },
  })
  const account = {
    name: 'personal',
    descriptor: { kind: 'claude-subscription' as const, credentialEnv: 'PERSONAL' },
  }
  const started = await runner.start({
    skill: 'ab-implement',
    invocation: 'b',
    workspacePath: '/workspace',
    account,
    env: {
      AB_ACCOUNT_PLACEHOLDERS: '0',
      AB_BUILD_RUNNER_OPTIONS: '',
      AB_HARVEST_RUNNER_OPTIONS: '',
      PERSONAL: 'sentinel-account-token',
      ANTHROPIC_API_KEY: 'competing-key',
      ANTHROPIC_BASE_URL: 'https://api.kimi.ai/coding/',
    },
  })
  expect(calls[0]!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sentinel-account-token')
  expect(calls[0]!.env.ANTHROPIC_API_KEY).toBeUndefined()
  expect(calls[0]!.env.ANTHROPIC_BASE_URL).toBeUndefined()
  const settingsIndex = calls[0]!.args.indexOf('--settings')
  expect(
    await access(calls[0]!.args[settingsIndex + 1]!).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  expect(started.result.kind).toBe('failed')
  if (started.result.kind === 'failed') {
    expect(started.result.failure.cause).toBe('credentials')
    expect(started.result.failure.message).toContain('personal')
    expect(started.result.failure.message).toContain('claude setup-token')
  }
  await runner.continue(started.session, 'retry', { env: { PERSONAL: 'rotated-sentinel' } })
  expect(calls[1]!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('rotated-sentinel')
})

for (const kind of ['claude', 'overseas', 'china', 'remote'] as const) {
  for (const mode of [
    'buffered',
    'stream',
    'fallback',
    'observer',
    'complete',
    'throw',
    'reject',
    'abort',
    'pre-abort',
    'resume',
    'sync-buffer',
  ] as const) {
    test(`protected account settings: ${kind} ${mode}`, async () => {
      const paths: string[] = []
      const parts: StreamPart[] = []
      const controller = new AbortController()
      const account = {
        name: 'selected',
        descriptor:
          kind === 'claude'
            ? { kind: 'claude-subscription' as const, credentialEnv: 'SELECTED_KEY' }
            : {
                kind: 'kimi-code' as const,
                credentialEnv: 'SELECTED_KEY',
                region: kind === 'china' ? ('china' as const) : ('overseas' as const),
              },
      }
      const inspect = async (invocation: ClaudeCliInvocation) => {
        const path = invocation.args[invocation.args.indexOf('--settings') + 1]!
        paths.push(path)
        expect(invocation.args.join(' ')).not.toContain('synthetic-selected-secret')
        expect(invocation.args.join(' ')).not.toContain('synthetic-competing-secret')
        const file = await stat(path)
        expect(file.isFile()).toBe(true)
        expect(file.mode & 0o777).toBe(0o600)
        expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
        const raw = await readFile(path, 'utf8')
        const settings = JSON.parse(raw)
        expect(settings.apiKeyHelper).toBe('')
        const key = kind === 'claude' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY'
        expect(settings.env[key]).toBe(invocation.env[key])
        if (kind === 'remote') {
          expect(raw).not.toContain('synthetic-')
          expect(JSON.stringify(invocation.env)).not.toContain('synthetic-')
        } else expect(settings.env[key]).toBe('synthetic-selected-secret')
        expect(
          settings.env[kind === 'claude' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN'],
        ).toBe('')
        if (kind !== 'claude') {
          expect(settings.env.ANTHROPIC_BASE_URL).toBe(
            `https://api.kimi.${kind === 'china' ? 'com' : 'ai'}/coding/`,
          )
          expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-for-coding')
        }
        if (mode === 'abort' || mode === 'pre-abort') {
          if (mode === 'abort') controller.abort(new Error('cancelled'))
          await waitForContractAbort(invocation.signal)
        }
        if (mode === 'reject') throw new Error('offline launch rejected')
        return output([result('protected-native', 0, 0, { result: 'ok' })])
      }
      const runner = new ClaudeAgentRunner({
        runCli:
          mode === 'sync-buffer'
            ? (invocation) => {
                paths.push(invocation.args[invocation.args.indexOf('--settings') + 1]!)
                throw new Error('offline synchronous spawn failed')
              }
            : inspect,
        ...(['stream', 'observer', 'throw', 'abort', 'pre-abort'].includes(mode)
          ? {
              runCliStream: (invocation: ClaudeCliInvocation) => {
                if (mode === 'throw') {
                  paths.push(invocation.args[invocation.args.indexOf('--settings') + 1]!)
                  throw new Error('offline spawn failed')
                }
                const pending = inspect(invocation)
                // Attach immediately, as the real streaming boundary does.
                void pending.catch(() => {})
                return {
                  lines: (async function* () {
                    yield (await pending).stdout
                  })(),
                  result: pending,
                }
              },
            }
          : {}),
      })
      if (mode === 'pre-abort') controller.abort(new Error('already cancelled'))
      const opts = startOpts({
        account,
        env: {
          AB_ACCOUNT_PLACEHOLDERS: kind === 'remote' ? '1' : '0',
          AB_BUILD_RUNNER_OPTIONS: '',
          AB_HARVEST_RUNNER_OPTIONS: '',
          SELECTED_KEY: 'synthetic-selected-secret',
          ANTHROPIC_API_KEY: 'synthetic-competing-secret',
        },
        signal: controller.signal,
        ...(['stream', 'fallback', 'throw', 'abort', 'pre-abort'].includes(mode)
          ? { stream: { append: (values: readonly StreamPart[]) => parts.push(...values) } }
          : {}),
        ...(mode === 'observer' ? { onNativeSession: async () => {} } : {}),
      })
      if (mode === 'complete')
        await runner.complete({
          prompt: 'offline',
          cwd: opts.workspacePath,
          env: opts.env,
          account,
        })
      else if (mode === 'resume') {
        const resumed = await runner.resume(
          nativeHandle('claude', 'protected-native', opts.workspacePath),
          'offline resume',
          opts,
        )
        expect(resumed.kind).toBe('resumed')
      } else
        await runner.start(opts).catch((error) => {
          expect(['abort', 'pre-abort']).toContain(mode)
          expect(String(error)).not.toContain('synthetic-')
        })
      expect(paths).toHaveLength(1)
      for (const path of paths) {
        expect(
          await access(path).then(
            () => true,
            () => false,
          ),
        ).toBe(false)
        expect(
          await access(dirname(path)).then(
            () => true,
            () => false,
          ),
        ).toBe(false)
      }
      expect(JSON.stringify(parts)).not.toContain('synthetic-')
    })
  }
}

test('native observer failure awaits child settlement before removing protected settings', async () => {
  let path!: string
  let finish!: (result: ClaudeCliResult) => void
  let cancelled!: () => void
  const aborted = new Promise<void>((resolve) => {
    cancelled = resolve
  })
  const runner = new ClaudeAgentRunner({
    runCliStream: (invocation) => {
      path = invocation.args[invocation.args.indexOf('--settings') + 1]!
      invocation.signal!.addEventListener('abort', cancelled, { once: true })
      return {
        lines: (async function* () {
          yield JSON.stringify({ type: 'system', session_id: 'offline' })
        })(),
        result: new Promise<ClaudeCliResult>((resolve) => {
          finish = resolve
        }),
      }
    },
  })
  const pending = runner.start(
    startOpts({
      account: {
        name: 'test',
        descriptor: { kind: 'claude-subscription', credentialEnv: 'TOKEN' },
      },
      env: {
        TOKEN: 'synthetic-observer-token',
        AB_ACCOUNT_PLACEHOLDERS: '0',
        AB_BUILD_RUNNER_OPTIONS: '',
        AB_HARVEST_RUNNER_OPTIONS: '',
      },
      onNativeSession: async () => {
        throw new Error('observer failed')
      },
    }),
  )
  const failure = pending.catch((error: unknown) => error)
  try {
    await aborted
    expect(
      await access(path).then(
        () => true,
        () => false,
      ),
    ).toBe(true)
  } finally {
    finish({ stdout: '', stderr: 'cancelled', exitCode: 1 })
  }
  expect(await failure).toHaveProperty('result.kind', 'failed')
  expect(
    await access(dirname(path)).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
})
