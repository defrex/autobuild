/** PiAgentRunner contract tests inject the local RPC-session boundary. */
import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
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
  isPiRuntimeUsable,
  MINIMUM_PI_VERSION,
  PiAgentRunner,
  type PiCliInvocation,
  type PiCliRunFn,
  type PiCreateSessionFn,
  type PiModelRef,
  type PiTurn,
} from './pi'
import { classifyProviderError } from './provider-error'
import { AGENT_BIN_DIR } from './session-env'

describe('Pi init usability', () => {
  const input = {
    cwd: '/repo',
    env: { OPENAI_API_KEY: 'secret' },
    models: ['openai/gpt-test', 'kimi-coding/k3'],
  }

  function fakeCli(
    handler: (call: PiCliInvocation) => { stdout: string; stderr?: string; exitCode?: number },
  ): {
    calls: PiCliInvocation[]
    run: PiCliRunFn
  } {
    const calls: PiCliInvocation[] = []
    return {
      calls,
      run: async (call) => {
        calls.push(call)
        const result = handler(call)
        return {
          stdout: result.stdout,
          stderr: result.stderr ?? '',
          exitCode: result.exitCode ?? 0,
        }
      },
    }
  }

  test('requires the minimum local version, catalog membership, and auth for every model', async () => {
    const cli = fakeCli((call) => {
      if (call.args[0] === '--version') return { stdout: `${MINIMUM_PI_VERSION}\n` }
      if (call.args[0] === '--list-models') {
        return {
          stdout:
            'provider     model       context  max-out  thinking  images\n' +
            'openai       gpt-test    128K     32K      yes       yes\n' +
            'kimi-coding  k3          1.0M     131.1K   yes       yes\n',
        }
      }
      return { stdout: '{"status":"ready","provider":"test","authType":"oauth"}\n' }
    })
    expect(await isPiRuntimeUsable(input, cli.run)).toEqual({
      usable: true,
      reason: 'Local Pi CLI, model catalog, and authentication are available',
    })
    expect(cli.calls.map((call) => call.args)).toEqual([
      ['--version'],
      ['auth', 'check', '--model', 'openai/gpt-test', '--json'],
      ['--list-models'],
      ['auth', 'check', '--model', 'kimi-coding/k3', '--json'],
    ])
    expect(cli.calls[1]?.env.OPENAI_API_KEY).toBe('secret')
  })

  test('rejects ready authentication when the exact model is absent from the local catalog', async () => {
    const cli = fakeCli((call) => {
      if (call.args[0] === '--version') return { stdout: `${MINIMUM_PI_VERSION}\n` }
      if (call.args[0] === '--list-models') {
        return {
          stdout:
            'provider  model          context  max-out  thinking  images\n' +
            'openai    gpt-test-mini  128K     32K      yes       yes\n',
        }
      }
      return { stdout: '{"status":"ready"}\n' }
    })

    expect(await isPiRuntimeUsable({ ...input, models: ['openai/gpt-test'] }, cli.run)).toEqual({
      usable: false,
      reason: 'Pi model "openai/gpt-test" is unavailable from the local Pi model catalog',
    })
  })

  test('accepts an exact catalog model whose id contains additional slashes', async () => {
    const model = 'cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6'
    const cli = fakeCli((call) => {
      if (call.args[0] === '--version') return { stdout: `${MINIMUM_PI_VERSION}\n` }
      if (call.args[0] === '--list-models') {
        return {
          stdout:
            'provider               model                         context  max-out  thinking  images\n' +
            'cloudflare-workers-ai  @cf/moonshotai/kimi-k2.6     128K     32K      yes       no\n',
        }
      }
      return { stdout: '{"status":"ready"}\n' }
    })

    expect(await isPiRuntimeUsable({ ...input, models: [model] }, cli.run)).toEqual({
      usable: true,
      reason: 'Local Pi CLI, model catalog, and authentication are available',
    })
  })

  test('reports old, missing, and unready local Pi installations actionably', async () => {
    const old = fakeCli(() => ({ stdout: '0.80.10\n' }))
    expect(await isPiRuntimeUsable(input, old.run)).toEqual({
      usable: false,
      reason: expect.stringContaining(
        `detected Pi 0.80.10, but Autobuild requires Pi ${MINIMUM_PI_VERSION}`,
      ),
    })

    const missing: PiCliRunFn = async () => {
      throw Object.assign(new Error('spawn pi ENOENT'), { code: 'ENOENT' })
    }
    expect(await isPiRuntimeUsable(input, missing)).toEqual({
      usable: false,
      reason: expect.stringContaining('executable "pi" was not found'),
    })

    const unready = fakeCli((call) =>
      call.args[0] === '--version'
        ? { stdout: `${MINIMUM_PI_VERSION}\n` }
        : { stdout: '{"status":"not_ready","reason":"credentials_not_configured"}', exitCode: 1 },
    )
    expect(await isPiRuntimeUsable(input, unready.run)).toEqual({
      usable: false,
      reason: expect.stringContaining('is not ready in the local Pi login'),
    })
    expect(unready.calls.map((call) => call.args)).not.toContainEqual(['--list-models'])
  })

  test('keeps malformed authentication distinct and does not probe the catalog', async () => {
    const cli = fakeCli((call) =>
      call.args[0] === '--version' ? { stdout: `${MINIMUM_PI_VERSION}\n` } : { stdout: 'not json' },
    )

    expect(await isPiRuntimeUsable({ ...input, models: ['openai/gpt-test'] }, cli.run)).toEqual({
      usable: false,
      reason: 'Pi authentication check for model "openai/gpt-test" returned malformed JSON',
    })
    expect(cli.calls.map((call) => call.args)).not.toContainEqual(['--list-models'])
  })

  test('fails closed with a catalog-specific reason for a malformed model table', async () => {
    const cli = fakeCli((call) => {
      if (call.args[0] === '--version') return { stdout: `${MINIMUM_PI_VERSION}\n` }
      if (call.args[0] === '--list-models') return { stdout: 'openai/gpt-test\n' }
      return { stdout: '{"status":"ready"}\n' }
    })

    expect(await isPiRuntimeUsable({ ...input, models: ['openai/gpt-test'] }, cli.run)).toEqual({
      usable: false,
      reason: expect.stringContaining('local model catalog probe returned a malformed table'),
    })
  })

  test('reports a non-zero catalog command with its stderr and exit code', async () => {
    const cli = fakeCli((call) => {
      if (call.args[0] === '--version') return { stdout: `${MINIMUM_PI_VERSION}\n` }
      if (call.args[0] === '--list-models') {
        return { stdout: '', stderr: 'registry cache is unavailable\n', exitCode: 23 }
      }
      return { stdout: '{"status":"ready"}\n' }
    })

    expect(await isPiRuntimeUsable({ ...input, models: ['openai/gpt-test'] }, cli.run)).toEqual({
      usable: false,
      reason:
        'Pi local model catalog probe failed: "pi --list-models" exited with code 23: registry cache is unavailable',
    })
    expect(cli.calls.map((call) => call.args)).toEqual([
      ['--version'],
      ['auth', 'check', '--model', 'openai/gpt-test', '--json'],
      ['--list-models'],
    ])
  })

  test('identifies a non-zero catalog command even when it returns no diagnostic', async () => {
    const cli = fakeCli((call) => {
      if (call.args[0] === '--version') return { stdout: `${MINIMUM_PI_VERSION}\n` }
      if (call.args[0] === '--list-models') return { stdout: '', stderr: '', exitCode: 9 }
      return { stdout: '{"status":"ready"}\n' }
    })

    expect(await isPiRuntimeUsable({ ...input, models: ['openai/gpt-test'] }, cli.run)).toEqual({
      usable: false,
      reason:
        'Pi local model catalog probe failed: "pi --list-models" exited with code 9: no diagnostic',
    })
    expect(cli.calls.map((call) => call.args)).toEqual([
      ['--version'],
      ['auth', 'check', '--model', 'openai/gpt-test', '--json'],
      ['--list-models'],
    ])
  })

  test('reports a catalog-specific launch failure with the underlying spawn error', async () => {
    const cli = fakeCli((call) => {
      if (call.args[0] === '--version') return { stdout: `${MINIMUM_PI_VERSION}\n` }
      if (call.args[0] === '--list-models') throw new Error('spawn pi EACCES')
      return { stdout: '{"status":"ready"}\n' }
    })

    expect(await isPiRuntimeUsable({ ...input, models: ['openai/gpt-test'] }, cli.run)).toEqual({
      usable: false,
      reason: 'Pi local model catalog probe failed to launch: spawn pi EACCES',
    })
    expect(cli.calls.map((call) => call.args)).toEqual([
      ['--version'],
      ['auth', 'check', '--model', 'openai/gpt-test', '--json'],
      ['--list-models'],
    ])
  })
})

const piContractFactory: AgentRunnerContractFactory = (scenario) => {
  const creates: RecordedCreate[] = []
  const prompts: RecordedPrompt[] = []
  let nextSession = 0
  let disposals = 0
  const createSessionFn: PiCreateSessionFn = async (opts) => {
    creates.push({
      cwd: opts.cwd,
      model: opts.model,
      tools: opts.tools,
      args: opts.args,
    })
    nextSession += 1
    return {
      sessionId: `pi-contract-${nextSession}`,
      async prompt(text, env, signal): Promise<PiTurn> {
        prompts.push({ text, env, signal })
        if (text === CONTRACT_ONE_SHOT_PROMPT) {
          return {
            text: CONTRACT_ONE_SHOT_TEXT,
            usage: { inputTokens: 2, outputTokens: 1 },
          }
        }
        if (
          scenario === 'cancel-start' ||
          (scenario === 'cancel-continue' && text === CONTRACT_FOLLOW_UP)
        ) {
          await new Promise<never>((_, reject) => {
            if (signal === undefined) return reject(new Error('contract prompt received no signal'))
            const abort = () => reject(signal.reason ?? new Error('contract prompt aborted'))
            if (signal.aborted) abort()
            else signal.addEventListener('abort', abort, { once: true })
          })
        }
        if (scenario !== 'success' && scenario !== 'cancel-continue') {
          const message =
            scenario === 'permanent-failure'
              ? CONTRACT_PERMANENT_FAILURE
              : scenario === 'exhaustion-failure'
                ? CONTRACT_EXHAUSTION_FAILURE
                : CONTRACT_RETRYABLE_FAILURE
          return {
            text: '',
            usage: { inputTokens: 0, outputTokens: 0 },
            failure: classifyProviderError(message),
          }
        }
        return {
          text: text === CONTRACT_FOLLOW_UP ? 'contract continued' : 'contract started',
          usage: { inputTokens: 3, outputTokens: 2 },
        }
      },
      dispose() {
        disposals += 1
      },
    }
  }
  const runner = new PiAgentRunner({ createSessionFn })
  return {
    runner,
    model: 'openai/contract-model',
    workspacePath: process.cwd(),
    turns: () =>
      prompts
        .filter((prompt) => prompt.text !== CONTRACT_ONE_SHOT_PROMPT)
        .map((prompt) => ({
          ...(prompt.text === CONTRACT_FOLLOW_UP ? { message: prompt.text } : {}),
          env: prompt.env,
        })),
    disposed: () => disposals,
    oneShot: {
      completion: runner,
      observation: () => {
        const prompt = prompts.find((candidate) => candidate.text === CONTRACT_ONE_SHOT_PROMPT)
        const create = creates[0]
        if (prompt === undefined || create === undefined) return undefined
        return {
          prompt: prompt.text,
          cwd: create.cwd,
          env: prompt.env,
          ...(create.model !== undefined
            ? { model: `${create.model.provider}/${create.model.id}` }
            : {}),
        }
      },
    },
  }
}

describeAgentRunnerContract('PiAgentRunner (injected Pi RPC session)', piContractFactory)

const KIMI_QUOTA =
  '403 {"error":{"type":"permission_error","message":"You\'ve reached your usage limit for this billing cycle. Please try again after your quota refreshes."}}'

/** One scripted turn's output for the fake session. */
interface ScriptedTurn {
  text: string
  inputTokens: number
  outputTokens: number
  failure?: NonNullable<PiTurn['failure']>
}

interface RecordedCreate {
  cwd: string
  model?: PiModelRef
  tools: readonly string[]
  args: readonly string[]
}

interface RecordedPrompt {
  text: string
  env: Record<string, string>
  signal?: AbortSignal
}

/**
 * A fake createSessionFn: each `createSessionFn` call yields a session that
 * plays the next scripted stream of turns in order, recording every create and
 * every prompt. `sessionId` is fixed per session so the handle/id assertions
 * stay legible.
 */
function fakeSessions(sessions: Array<{ sessionId: string; turns: ScriptedTurn[] }>): {
  creates: RecordedCreate[]
  prompts: RecordedPrompt[]
  disposed: string[]
  createSessionFn: PiCreateSessionFn
} {
  const creates: RecordedCreate[] = []
  const prompts: RecordedPrompt[] = []
  const disposed: string[] = []
  const createSessionFn: PiCreateSessionFn = async (opts) => {
    creates.push({
      cwd: opts.cwd,
      model: opts.model,
      tools: opts.tools,
      args: opts.args,
    })
    const script = sessions[creates.length - 1] ?? { sessionId: `s-${creates.length}`, turns: [] }
    let turn = 0
    return {
      sessionId: script.sessionId,
      async prompt(text, env, signal): Promise<PiTurn> {
        prompts.push({ text, env, signal })
        if (signal?.aborted === true) throw signal.reason
        const scripted = script.turns[turn++]
        if (scripted === undefined) {
          throw new Error(`fake session "${script.sessionId}": no scripted turn ${turn}`)
        }
        return {
          text: scripted.text,
          usage: { inputTokens: scripted.inputTokens, outputTokens: scripted.outputTokens },
          ...(scripted.failure !== undefined ? { failure: scripted.failure } : {}),
        }
      },
      dispose() {
        disposed.push(script.sessionId)
      },
    }
  }
  return { creates, prompts, disposed, createSessionFn }
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

describe('PiAgentRunner.start', () => {
  test('formats the prompt as /{skill} {buildSlug} and flows the model from config (§4, §9)', async () => {
    const { creates, prompts, createSessionFn } = fakeSessions([
      { sessionId: 'pi-1', turns: [{ text: 'ok', inputTokens: 1, outputTokens: 1 }] },
    ])
    const runner = new PiAgentRunner({ createSessionFn })
    const { session } = await runner.start(startOpts({ model: 'openai/gpt-5.6-sol' }))

    expect(prompts[0]?.text).toBe('/skill:ab-plan auth-rate-limit')
    expect(creates[0]?.cwd).toBe('/ws/auth-rate-limit')
    // Provider-qualified model id is parsed into (provider, id), from config.
    expect(creates[0]?.model).toEqual({ provider: 'openai', id: 'gpt-5.6-sol' })
    // The handle carries the raw config id.
    expect(session.model).toBe('openai/gpt-5.6-sol')
    expect(session.runner).toBe('pi')
  })

  test('parses a slashy provider id (cloudflare) keeping the full model id', async () => {
    const { creates, createSessionFn } = fakeSessions([
      { sessionId: 'pi-1', turns: [{ text: 'ok', inputTokens: 1, outputTokens: 1 }] },
    ])
    const runner = new PiAgentRunner({ createSessionFn })
    await runner.start(startOpts({ model: 'cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6' }))
    expect(creates[0]?.model).toEqual({
      provider: 'cloudflare-workers-ai',
      id: '@cf/moonshotai/kimi-k2.6',
    })
  })

  test('rejects a model id that is not provider-qualified', async () => {
    const { createSessionFn } = fakeSessions([])
    const runner = new PiAgentRunner({ createSessionFn })
    await expect(runner.start(startOpts({ model: 'kimi-k3' }))).rejects.toThrow(
      'not provider-qualified',
    )
  })

  test('enables bash among the tool set (the agent invokes ab through it)', async () => {
    const { creates, createSessionFn } = fakeSessions([
      { sessionId: 'pi-1', turns: [{ text: 'ok', inputTokens: 1, outputTokens: 1 }] },
    ])
    const runner = new PiAgentRunner({ createSessionFn })
    await runner.start(startOpts())
    expect(creates[0]?.tools).toContain('bash')
  })

  test('forwards ordered per-phase args; absent is an empty list', async () => {
    const { creates, createSessionFn } = fakeSessions([
      { sessionId: 'pi-1', turns: [{ text: 'ok', inputTokens: 1, outputTokens: 1 }] },
      { sessionId: 'pi-2', turns: [{ text: 'ok', inputTokens: 1, outputTokens: 1 }] },
    ])
    const runner = new PiAgentRunner({ createSessionFn })
    await runner.start(
      startOpts({ args: ['--session', 'operator-session', '--extension', './web-access.js'] }),
    )
    expect(creates[0]?.args).toEqual([
      '--session',
      'operator-session',
      '--extension',
      './web-access.js',
    ])
    // Absent passes an empty argv list, not undefined.
    await runner.start(startOpts())
    expect(creates[1]?.args).toEqual([])
  })

  test('captures the local RPC session id as the handle id', async () => {
    const { createSessionFn } = fakeSessions([
      { sessionId: 'pi-session-42', turns: [{ text: 'ok', inputTokens: 1, outputTokens: 1 }] },
    ])
    const runner = new PiAgentRunner({ createSessionFn })
    const { session } = await runner.start(startOpts())
    expect(session).toEqual({ id: 'pi-session-42', runner: 'pi' })
  })

  test('returns the turn text and per-turn usage as integers', async () => {
    const { createSessionFn } = fakeSessions([
      { sessionId: 'pi-1', turns: [{ text: 'the plan', inputTokens: 10, outputTokens: 5 }] },
    ])
    const runner = new PiAgentRunner({ createSessionFn })
    const { result } = await runner.start(startOpts())
    expect(result.text).toBe('the plan')
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, turns: 1 })
  })

  test('a local prerequisite launch failure returns an endable synthetic handle', async () => {
    const runner = new PiAgentRunner({
      createSessionFn: async () => {
        throw new Error(
          `pi runtime: detected Pi 0.80.10, but Autobuild requires Pi ${MINIMUM_PI_VERSION} or newer.`,
        )
      },
      createSessionId: () => 'pi-prerequisite-failure',
    })
    const { session, result } = await runner.start(startOpts())
    expect(session.id).toBe('pi-prerequisite-failure')
    expect(result).toMatchObject({
      kind: 'failed',
      failure: { permanent: true, cause: 'configuration' },
    })
    await expect(runner.continue(session, 'retry')).rejects.toThrow('failed to start')
    expect((await runner.end(session)).metadata.usage.turns).toBe(1)
  })

  test('returns a failed result with an endable handle and retains it in the transcript', async () => {
    const { disposed, createSessionFn } = fakeSessions([
      {
        sessionId: 'pi-quota',
        turns: [
          {
            text: '',
            inputTokens: 0,
            outputTokens: 0,
            failure: { message: KIMI_QUOTA, permanent: true },
          },
        ],
      },
    ])
    const runner = new PiAgentRunner({ createSessionFn })
    const { session, result } = await runner.start(startOpts({ model: 'kimi-coding/k3' }))

    expect(result).toEqual({
      kind: 'failed',
      text: '',
      usage: { inputTokens: 0, outputTokens: 0, turns: 1 },
      failure: { message: KIMI_QUOTA, permanent: true },
    })
    const transcript = await runner.end(session)
    expect(JSON.parse(transcript.content).turns[0].failure).toEqual({
      message: KIMI_QUOTA,
      permanent: true,
    })
    expect(disposed).toEqual(['pi-quota'])
  })

  test('passes the ambient process env through, with scoped AB_* winning the merge (D8)', async () => {
    process.env.AB_TEST_AMBIENT = 'from-process'
    process.env.AB_TEST_OVERRIDE = 'ambient-loses'
    try {
      const { prompts, createSessionFn } = fakeSessions([
        { sessionId: 'pi-1', turns: [{ text: 'ok', inputTokens: 1, outputTokens: 1 }] },
      ])
      const runner = new PiAgentRunner({ createSessionFn })
      await runner.start(startOpts({ env: { AB_TEST_OVERRIDE: 'scoped-wins', AB_TOKEN: 'tok' } }))
      const env = prompts[0]?.env
      expect(env?.AB_TEST_AMBIENT).toBe('from-process')
      expect(env?.AB_TEST_OVERRIDE).toBe('scoped-wins')
      expect(env?.AB_TOKEN).toBe('tok')
    } finally {
      delete process.env.AB_TEST_AMBIENT
      delete process.env.AB_TEST_OVERRIDE
    }
  })
})

describe('PiAgentRunner.complete', () => {
  test('runs one verbatim, tool-free, cancellable turn without opening a resumable session', async () => {
    const { creates, prompts, disposed, createSessionFn } = fakeSessions([
      {
        sessionId: 'one-shot-id',
        turns: [{ text: 'login-rate-limit', inputTokens: 4, outputTokens: 2 }],
      },
    ])
    const runner = new PiAgentRunner({ createSessionFn })
    const controller = new AbortController()

    const result = await runner.complete({
      prompt: 'name this spec verbatim',
      cwd: '/repos/app',
      env: { NAMING_TOKEN: 'secret' },
      model: 'openai/gpt-5.6-sol',
      args: ['--extension', './naming.js'],
      signal: controller.signal,
    })

    expect(result).toEqual({ text: 'login-rate-limit' })
    expect(creates[0]).toEqual({
      cwd: '/repos/app',
      model: { provider: 'openai', id: 'gpt-5.6-sol' },
      tools: [],
      args: ['--extension', './naming.js'],
    })
    expect(prompts[0]?.text).toBe('name this spec verbatim')
    expect(prompts[0]?.env.NAMING_TOKEN).toBe('secret')
    expect(prompts[0]?.signal).toBe(controller.signal)
    expect(disposed).toEqual(['one-shot-id'])
    await expect(runner.end({ id: 'one-shot-id', runner: 'pi' })).rejects.toThrow(
      'unknown session "one-shot-id"',
    )
  })

  test('throws a failed provider turn and still disposes the one-shot session', async () => {
    const { disposed, createSessionFn } = fakeSessions([
      {
        sessionId: 'failed-one-shot',
        turns: [
          {
            text: '',
            inputTokens: 0,
            outputTokens: 0,
            failure: { message: KIMI_QUOTA, permanent: true },
          },
        ],
      },
    ])
    const runner = new PiAgentRunner({ createSessionFn })

    await expect(
      runner.complete({ prompt: 'name this spec', cwd: '/repos/app', env: {} }),
    ).rejects.toThrow(KIMI_QUOTA)
    expect(disposed).toEqual(['failed-one-shot'])
  })

  test('forwards an already-aborted deadline and still disposes the one-shot session', async () => {
    const { prompts, disposed, createSessionFn } = fakeSessions([
      {
        sessionId: 'cancelled-one-shot',
        turns: [{ text: 'unused', inputTokens: 0, outputTokens: 0 }],
      },
    ])
    const runner = new PiAgentRunner({ createSessionFn })
    const controller = new AbortController()
    controller.abort(new Error('naming deadline'))

    await expect(
      runner.complete({
        prompt: 'name this spec',
        cwd: '/repos/app',
        env: {},
        signal: controller.signal,
      }),
    ).rejects.toThrow('naming deadline')

    expect(prompts[0]?.signal).toBe(controller.signal)
    expect(disposed).toEqual(['cancelled-one-shot'])
  })
})

describe('PiAgentRunner.continue', () => {
  test('drives the same live session with the raw message and per-turn usage', async () => {
    const { prompts, createSessionFn } = fakeSessions([
      {
        sessionId: 'pi-1',
        turns: [
          { text: 'the plan', inputTokens: 10, outputTokens: 5 },
          { text: 'revised', inputTokens: 7, outputTokens: 3 },
        ],
      },
    ])
    const runner = new PiAgentRunner({ createSessionFn })
    const { session } = await runner.start(startOpts({ model: 'moonshotai/kimi-k3' }))
    const result = await runner.continue(session, 'address findings f_1, f_2')

    expect(prompts[1]?.text).toBe('address findings f_1, f_2')
    expect(result).toEqual({
      kind: 'completed',
      text: 'revised',
      usage: { inputTokens: 7, outputTokens: 3, turns: 1 },
    })
  })

  test('re-issued ambient env merges over the start env for the continued turn (§10, D8)', async () => {
    const { prompts, createSessionFn } = fakeSessions([
      {
        sessionId: 'pi-1',
        turns: [
          { text: 'the plan', inputTokens: 10, outputTokens: 5 },
          { text: 'revised', inputTokens: 7, outputTokens: 3 },
        ],
      },
    ])
    const runner = new PiAgentRunner({ createSessionFn })
    const { session } = await runner.start(
      startOpts({
        env: { AB_BUILD: 'auth-rate-limit', AB_PHASE: 'implement@1', AB_SESSION: 's_3' },
      }),
    )
    await runner.continue(session, 'fix', { env: { AB_PHASE: 'implement@2', AB_SESSION: 's_5' } })

    const env = prompts[1]?.env
    expect(env?.AB_PHASE).toBe('implement@2')
    expect(env?.AB_SESSION).toBe('s_5')
    // A start-only key survives the per-turn refresh.
    expect(env?.AB_BUILD).toBe('auth-rate-limit')
  })

  test('keeps the distribution CLI ahead of a conflicting host ab on start and continue', async () => {
    const conflictDir = await mkdtemp(join(tmpdir(), 'ab-pi-path-'))
    try {
      await writeConflictingAb(conflictDir)
      const inheritedPath = [conflictDir, process.env.PATH ?? '']
        .filter((entry) => entry !== '')
        .join(delimiter)
      const { prompts, createSessionFn } = fakeSessions([
        {
          sessionId: 'pi-path',
          turns: [
            { text: 'first', inputTokens: 1, outputTokens: 1 },
            { text: 'second', inputTokens: 1, outputTokens: 1 },
          ],
        },
      ])
      const runner = new PiAgentRunner({ createSessionFn })
      const { session } = await runner.start(
        startOpts({
          env: {
            AB_BUILD: 'auth-rate-limit',
            AB_PHASE: 'plan@1',
            AB_SESSION: 's_1',
            PATH: inheritedPath,
          },
        }),
      )
      await runner.continue(session, 'next round', {
        env: { AB_PHASE: 'plan@2', AB_SESSION: 's_2' },
      })

      for (const prompt of prompts) {
        const entries = prompt.env.PATH!.split(delimiter)
        expect(entries[0]).toBe(AGENT_BIN_DIR)
        expect(entries[1]).toBe(conflictDir)
      }

      const smoke = await invokeAbHelp(prompts[1]!.env)
      expect(smoke).toMatchObject({ code: 0, stderr: '' })
      expect(smoke.stdout).toContain('ab — agent-driven software delivery')
      expect(smoke.stdout).not.toContain('host-conflicting-ab')
      await runner.end(session)
    } finally {
      await rm(conflictDir, { recursive: true, force: true })
    }
  })

  test('throws on an unknown session', async () => {
    const { createSessionFn } = fakeSessions([])
    const runner = new PiAgentRunner({ createSessionFn })
    await expect(runner.continue({ id: 'nope', runner: 'pi' }, 'hi')).rejects.toThrow(
      'unknown session "nope"',
    )
  })
})

describe('PiAgentRunner.end', () => {
  test('returns a Transcript with runner "pi", the model, summed usage, and both turns', async () => {
    const { disposed, createSessionFn } = fakeSessions([
      {
        sessionId: 'pi-1',
        turns: [
          { text: 'the plan', inputTokens: 10, outputTokens: 5 },
          { text: 'the revision', inputTokens: 7, outputTokens: 3 },
        ],
      },
    ])
    const runner = new PiAgentRunner({ createSessionFn })
    const { session } = await runner.start(startOpts({ model: 'moonshotai/kimi-k3' }))
    await runner.continue(session, 'revise please')
    const transcript = await runner.end(session)

    expect(transcript.metadata).toEqual({
      runner: 'pi',
      model: 'moonshotai/kimi-k3',
      usage: { inputTokens: 17, outputTokens: 8, turns: 2 },
    })
    const content = JSON.parse(transcript.content)
    expect(content.session).toBe('pi-1')
    expect(content.buildSlug).toBe('auth-rate-limit')
    expect(content.turns).toHaveLength(2)
    expect(content.turns[0]).toMatchObject({ turn: 1, prompt: '/skill:ab-plan auth-rate-limit' })
    // end() disposes the live session.
    expect(disposed).toEqual(['pi-1'])
  })

  test('a session started with no model yields a transcript with no model', async () => {
    const { createSessionFn } = fakeSessions([
      { sessionId: 'pi-1', turns: [{ text: 'ok', inputTokens: 1, outputTokens: 1 }] },
    ])
    const runner = new PiAgentRunner({ createSessionFn })
    const { session } = await runner.start(startOpts())
    const transcript = await runner.end(session)
    expect(transcript.metadata.model).toBeUndefined()
    expect(transcript.metadata.runner).toBe('pi')
  })

  test('throws on an unknown session, and on a second end', async () => {
    const { createSessionFn } = fakeSessions([
      { sessionId: 'pi-1', turns: [{ text: 'ok', inputTokens: 1, outputTokens: 1 }] },
    ])
    const runner = new PiAgentRunner({ createSessionFn })
    await expect(runner.end({ id: 'nope', runner: 'pi' })).rejects.toThrow('unknown session "nope"')
    const { session } = await runner.start(startOpts())
    await runner.end(session)
    await expect(runner.end(session)).rejects.toThrow('unknown session "pi-1"')
  })
})
