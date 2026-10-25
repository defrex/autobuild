import { temporaryDirectories as ownTempDirectories } from '../../testing/temp-directories'
import { afterEach, describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRunner, AgentStartOpts, NativeSessionHandle } from '../types'
import { ClaudeAgentRunner, type ClaudeCliRunFn } from './claude'
import { CodexAgentRunner, type CodexCliRunFn } from './codex'
import { PiAgentRunner } from './pi'
import { ScriptedAgentRunner, defaultTurnResult, failedTurnResult } from './fake'
import { describeNativeResumeContract } from './contract'
import { nativeHandle, resumeAgent } from './native-session'

const mkdtemp = ownTempDirectories(afterEach)

const opts: AgentStartOpts = {
  skill: 'ab-probe',
  invocation: 'probe',
  workspacePath: '/tmp',
  env: {},
}
function output(provider: string, id: string, text: string, failure = false) {
  const events =
    provider === 'claude'
      ? [
          { type: 'system', subtype: 'init', session_id: id },
          {
            type: 'result',
            subtype: failure ? 'error_during_execution' : 'success',
            result: text,
            is_error: failure,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        ]
      : [
          { type: 'thread.started', thread_id: id },
          failure
            ? { type: 'turn.failed', error: { message: text } }
            : { type: 'item.completed', item: { type: 'agent_message', text } },
          ...(!failure
            ? [{ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }]
            : []),
        ]
  return {
    stdout: events.map((e) => JSON.stringify(e)).join('\n'),
    stderr: '',
    exitCode: failure ? 1 : 0,
  }
}

for (const provider of ['claude', 'codex', 'pi', 'scripted']) {
  describeNativeResumeContract(provider, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ab-native-contract-'))
    const path = join(cwd, 'session.jsonl')
    const id = 'native-contract-id'
    let available = false
    let memory = ''
    const fakeState = new Map<string, string[]>()
    const runCli: ClaudeCliRunFn & CodexCliRunFn = async (invocation) => {
      const resume = invocation.args.includes('resume') || invocation.args.includes('--resume')
      if (resume && !available) return { stdout: '', stderr: 'Session not found', exitCode: 1 }
      available = true
      const message = invocation.args.at(-1)!
      if (message.startsWith('remember ')) memory = message.slice(9)
      return output(
        provider,
        id,
        message === 'provider-failure'
          ? 'provider unavailable'
          : `${memory} ${invocation.env.NATIVE_CONTRACT_FRESH ?? ''}`,
        message === 'provider-failure',
      )
    }
    return {
      opts: { ...opts, workspacePath: cwd },
      createRunner(): AgentRunner {
        if (provider === 'claude') return new ClaudeAgentRunner({ runCli })
        if (provider === 'codex') return new CodexAgentRunner({ runCli })
        if (provider === 'scripted')
          return new ScriptedAgentRunner({
            nativeState: fakeState,
            script: (ctx) =>
              ctx.message === 'provider-failure'
                ? failedTurnResult('provider unavailable', false)
                : defaultTurnResult(
                    `${ctx.history.join(' ')} ${ctx.opts.env.NATIVE_CONTRACT_FRESH ?? ''}`,
                  ),
          })
        return new PiAgentRunner({
          createSessionFn: async (creation) => {
            if (creation.sessionFile === undefined) {
              available = true
              await writeFile(path, `${JSON.stringify({ type: 'session', id })}\n`)
            }
            return {
              sessionId: id,
              sessionFile: path,
              dispose() {},
              async prompt(message, env) {
                if (message.startsWith('remember ')) memory = message.slice(9)
                return {
                  text: `${memory} ${env.NATIVE_CONTRACT_FRESH ?? ''}`,
                  usage: { inputTokens: 1, outputTokens: 1 },
                  ...(message === 'provider-failure'
                    ? { failure: { message: 'provider unavailable', permanent: false } }
                    : {}),
                }
              },
            }
          },
        })
      },
      async forget() {
        available = false
        fakeState.clear()
        await rm(path, { force: true })
      },
      async cleanup() {
        await rm(cwd, { recursive: true, force: true })
      },
    }
  })
}

for (const provider of ['claude', 'codex'] as const) {
  describe(`${provider} native observation`, () => {
    for (const streaming of [false, true])
      test(`reports identity while the turn is blocked (UI streaming ${streaming})`, async () => {
        let release!: () => void
        const blocked = new Promise<void>((resolve) => {
          release = resolve
        })
        let seen!: () => void
        const observed = new Promise<void>((resolve) => {
          seen = resolve
        })
        let handle: NativeSessionHandle | undefined
        const cli = output(provider, 'native-id', 'done')
        const runCliStream = () => ({
          lines: (async function* () {
            yield cli.stdout.split('\n')[0]!
            await blocked
            for (const line of cli.stdout.split('\n').slice(1)) yield line
          })(),
          result: blocked.then(() => cli),
        })
        const runner =
          provider === 'claude'
            ? new ClaudeAgentRunner({ runCliStream })
            : new CodexAgentRunner({ runCliStream })
        const running = runner.start({
          ...opts,
          onNativeSession: async (value) => {
            handle = value
            seen()
          },
          ...(streaming ? { stream: { append() {} } } : {}),
        })
        try {
          await observed
          expect(handle?.nativeId).toBe('native-id')
          expect(handle?.runner).toBe(provider)
        } finally {
          release()
        }
        const started = await running
        expect(started.result.kind).toBe('completed')
        await runner.end(started.session)
      })

    test('observer rejection propagates and conflicting identities are rejected', async () => {
      const cli = output(provider, 'native-id', 'done')
      const make = (stdout = cli.stdout) =>
        provider === 'claude'
          ? new ClaudeAgentRunner({ runCli: async () => ({ ...cli, stdout }) })
          : new CodexAgentRunner({ runCli: async () => ({ ...cli, stdout }) })
      await expect(
        make().start({
          ...opts,
          onNativeSession: async () => {
            throw new Error('store unavailable')
          },
        }),
      ).rejects.toThrow('Native session observation failed')
      const second = output(provider, 'conflicting-id', 'done').stdout
      await expect(
        make(`${cli.stdout}\n${second}`).start({ ...opts, onNativeSession: async () => {} }),
      ).rejects.toThrow('Native session observation failed')
    })

    test('no identity on launch failure, but identity survives a provider failure', async () => {
      const handles: NativeSessionHandle[] = []
      const observe = async (value: NativeSessionHandle) => {
        handles.push(value)
      }
      const failedLaunch = async () => {
        throw new Error('launch failed')
      }
      const a =
        provider === 'claude'
          ? new ClaudeAgentRunner({ runCli: failedLaunch })
          : new CodexAgentRunner({ runCli: failedLaunch })
      const launched = await a.start({ ...opts, onNativeSession: observe })
      expect(handles).toHaveLength(0)
      await a.end(launched.session)
      const runCli = async () => output(provider, 'native-id', 'provider unavailable', true)
      const b =
        provider === 'claude' ? new ClaudeAgentRunner({ runCli }) : new CodexAgentRunner({ runCli })
      const failed = await b.start({ ...opts, onNativeSession: observe })
      expect(failed.result.kind).toBe('failed')
      expect(handles).toHaveLength(1)
      await b.end(failed.session)
    })
  })
}

test('adapters without resume report the optional capability as unsupported', async () => {
  const runner = new ScriptedAgentRunner({ script: () => defaultTurnResult() })
  const legacy = {
    name: runner.name,
    start: runner.start.bind(runner),
    continue: runner.continue.bind(runner),
    end: runner.end.bind(runner),
  }
  expect(
    await resumeAgent(legacy, nativeHandle('scripted', 'id', '/tmp'), 'hello', opts),
  ).toMatchObject({ kind: 'not-resumable', reason: 'unsupported' })
})

test('Pi observes initialized native state before a blocked prompt and propagates rejected observers', async () => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  let seen!: () => void
  const observed = new Promise<void>((resolve) => {
    seen = resolve
  })
  let prompts = 0
  let disposed = 0
  const createSessionFn = async () => ({
    sessionId: 'pi-native',
    sessionFile: '/tmp/pi-native.jsonl',
    async prompt() {
      prompts++
      await blocked
      return { text: 'done', usage: { inputTokens: 1, outputTokens: 1 } }
    },
    dispose() {
      disposed++
    },
  })
  const runner = new PiAgentRunner({ createSessionFn })
  const pending = runner.start({
    ...opts,
    onNativeSession: async (handle) => {
      expect(handle.statePath).toBe('/tmp/pi-native.jsonl')
      seen()
    },
  })
  await observed
  release()
  await runner.end((await pending).session)
  const before = prompts
  await expect(
    new PiAgentRunner({ createSessionFn }).start({
      ...opts,
      onNativeSession: async () => {
        throw new Error('store failed')
      },
    }),
  ).rejects.toThrow('Native session observation failed')
  expect(prompts).toBe(before)
  expect(disposed).toBe(2)
})

test('Pi refuses malformed state or a different initialized identity before prompting', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ab-pi-native-state-'))
  const path = join(cwd, 'native.jsonl')
  let prompts = 0
  let disposed = 0
  const runner = new PiAgentRunner({
    createSessionFn: async () => ({
      sessionId: 'replacement',
      sessionFile: path,
      async prompt() {
        prompts++
        return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }
      },
      dispose() {
        disposed++
      },
    }),
  })
  const handle = nativeHandle('pi', 'original', cwd, undefined, path)
  try {
    await writeFile(path, '')
    expect(
      (await resumeAgent(runner, handle, 'new message', { ...opts, workspacePath: cwd })).kind,
    ).toBe('not-resumable')
    await writeFile(path, JSON.stringify({ type: 'session', id: 'original' }))
    expect(
      (await resumeAgent(runner, handle, 'new message', { ...opts, workspacePath: cwd })).kind,
    ).toBe('not-resumable')
    expect(prompts).toBe(0)
    expect(disposed).toBe(1)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

for (const provider of ['claude', 'codex'] as const)
  test(`${provider}: streamed observer failures propagate and resume rejects replacement identities`, async () => {
    const cli = output(provider, 'replacement', 'done')
    const runCliStream = () => ({
      lines: (async function* () {
        for (const line of cli.stdout.split('\n')) yield line
      })(),
      result: Promise.resolve(cli),
    })
    const create = () =>
      provider === 'claude'
        ? new ClaudeAgentRunner({ runCliStream })
        : new CodexAgentRunner({ runCliStream })
    await expect(
      create().start({
        ...opts,
        onNativeSession: async () => {
          throw new Error('store failed')
        },
      }),
    ).rejects.toThrow('Native session observation failed')
    const result = await resumeAgent(
      create(),
      nativeHandle(provider, 'original', opts.workspacePath),
      'hello',
      opts,
    )
    expect(result).toMatchObject({ kind: 'not-resumable', reason: 'missing-state' })
  })

for (const provider of ['claude', 'codex', 'pi'])
  test(`${provider}: conflicting persistence arguments are configuration failures`, async () => {
    const runner =
      provider === 'claude'
        ? new ClaudeAgentRunner({
            runCli: async () => {
              throw new Error('must not launch')
            },
          })
        : provider === 'codex'
          ? new CodexAgentRunner({
              runCli: async () => {
                throw new Error('must not launch')
              },
            })
          : new PiAgentRunner({
              createSessionFn: async () => {
                throw new Error('must not launch')
              },
            })
    const result = await runner.start({
      ...opts,
      args: [
        provider === 'claude'
          ? '--no-session-persistence'
          : provider === 'codex'
            ? '--ephemeral'
            : '--no-session',
      ],
    })
    expect(result.result).toMatchObject({ kind: 'failed', failure: { cause: 'configuration' } })
    await runner.end(result.session)
  })

test('native lookup classification preserves provider availability and credential failures', async () => {
  const { nativeStateUnavailable } = await import('./native-session')
  expect(
    nativeStateUnavailable({ message: 'No rollout found for thread id abc', permanent: false }),
  ).toBe(true)
  expect(
    nativeStateUnavailable({
      message: 'No conversation found with session ID abc',
      permanent: false,
    }),
  ).toBe(true)
  expect(
    nativeStateUnavailable({
      message: 'Service unavailable while processing thread abc',
      permanent: false,
      cause: 'availability',
    }),
  ).toBe(false)
  expect(
    nativeStateUnavailable({
      message: 'Session not found in credential provider',
      permanent: true,
      cause: 'credentials',
    }),
  ).toBe(false)
})
