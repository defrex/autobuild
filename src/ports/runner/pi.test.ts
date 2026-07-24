/**
 * PiAgentRunner tests run entirely against an injected fake PiCreateSessionFn —
 * the pi SDK is never loaded. The default factory (`piSdkCreateSession`, the
 * cast point that dynamically imports `@earendil-works/pi-coding-agent`, builds
 * a ModelRuntime, and wraps a real AgentSession) is deliberately untested: it
 * is pure interop with no logic beyond the SDK calls.
 */
import { describe, expect, test } from 'bun:test'
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
  PiAgentRunner,
  PiTurnCapture,
  type PiCreateSessionFn,
  type PiModelRef,
  type PiTurn,
} from './pi'
import { AGENT_BIN_DIR } from './session-env'

const piContractFactory: AgentRunnerContractFactory = (scenario) => {
  const creates: RecordedCreate[] = []
  const prompts: RecordedPrompt[] = []
  let nextSession = 0
  const createSessionFn: PiCreateSessionFn = async (opts) => {
    creates.push({
      cwd: opts.cwd,
      model: opts.model,
      tools: opts.tools,
      extensions: opts.extensions,
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
        if (scenario !== 'success') {
          const message =
            scenario === 'permanent-failure'
              ? CONTRACT_PERMANENT_FAILURE
              : CONTRACT_RETRYABLE_FAILURE
          const capture = new PiTurnCapture()
          capture.observe({
            type: 'message_end',
            message: {
              role: 'assistant',
              stopReason: 'error',
              errorMessage: message,
            },
          })
          return capture.result({ inputTokens: 0, outputTokens: 0 })
        }
        return {
          text: text === CONTRACT_FOLLOW_UP ? 'contract continued' : 'contract started',
          usage: { inputTokens: 3, outputTokens: 2 },
        }
      },
      dispose() {},
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
          ...(prompt.text === CONTRACT_FOLLOW_UP
            ? { message: prompt.text }
            : {}),
          env: prompt.env,
        })),
    oneShot: {
      completion: runner,
      observation: () => {
        const prompt = prompts.find(
          (candidate) => candidate.text === CONTRACT_ONE_SHOT_PROMPT,
        )
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

describeAgentRunnerContract('PiAgentRunner (injected SDK)', piContractFactory)

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
  extensions: readonly string[]
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
function fakeSessions(
  sessions: Array<{ sessionId: string; turns: ScriptedTurn[] }>,
): {
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
      extensions: opts.extensions,
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

describe('PiTurnCapture', () => {
  test('extracts the reproduced provider error and classifies it without rewriting', () => {
    const capture = new PiTurnCapture()
    capture.observe({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'error',
        error: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: KIMI_QUOTA,
        },
      },
    })
    capture.observe({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: KIMI_QUOTA,
      },
    })

    expect(capture.result({ inputTokens: 0, outputTokens: 0 })).toEqual({
      text: '',
      usage: { inputTokens: 0, outputTokens: 0 },
      failure: { message: KIMI_QUOTA, permanent: true },
    })
  })

  test('a successful completion after Pi internal retry clears the stale error', () => {
    const capture = new PiTurnCapture()
    capture.observe({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: '503 overloaded' },
    })
    capture.observe({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        delta: 'recovered',
      },
    })
    capture.observe({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop' },
    })

    expect(capture.result({ inputTokens: 2, outputTokens: 1 })).toEqual({
      text: 'recovered',
      usage: { inputTokens: 2, outputTokens: 1 },
    })
  })
})

describe('PiAgentRunner.start', () => {
  test('formats the prompt as /{skill} {buildSlug} and flows the model from config (§4, §9)', async () => {
    const { creates, prompts, createSessionFn } = fakeSessions([
      { sessionId: 'pi-1', turns: [{ text: 'ok', inputTokens: 1, outputTokens: 1 }] },
    ])
    const runner = new PiAgentRunner({ createSessionFn })
    const { session } = await runner.start(startOpts({ model: 'openai/gpt-5.6-sol' }))

    expect(prompts[0]?.text).toBe('/ab-plan auth-rate-limit')
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

  test('forwards the per-phase extension allowlist; absent ⇒ hermetic (empty)', async () => {
    const { creates, createSessionFn } = fakeSessions([
      { sessionId: 'pi-1', turns: [{ text: 'ok', inputTokens: 1, outputTokens: 1 }] },
      { sessionId: 'pi-2', turns: [{ text: 'ok', inputTokens: 1, outputTokens: 1 }] },
    ])
    const runner = new PiAgentRunner({ createSessionFn })
    await runner.start(startOpts({ extensions: ['subagents', 'web-access'] }))
    expect(creates[0]?.extensions).toEqual(['subagents', 'web-access'])
    // Absent ⇒ hermetic: the adapter passes an empty allowlist, not undefined.
    await runner.start(startOpts())
    expect(creates[1]?.extensions).toEqual([])
  })

  test('captures the SDK session id as the handle id', async () => {
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
    process.env['AB_TEST_AMBIENT'] = 'from-process'
    process.env['AB_TEST_OVERRIDE'] = 'ambient-loses'
    try {
      const { prompts, createSessionFn } = fakeSessions([
        { sessionId: 'pi-1', turns: [{ text: 'ok', inputTokens: 1, outputTokens: 1 }] },
      ])
      const runner = new PiAgentRunner({ createSessionFn })
      await runner.start(
        startOpts({ env: { AB_TEST_OVERRIDE: 'scoped-wins', AB_TOKEN: 'tok' } }),
      )
      const env = prompts[0]?.env
      expect(env?.['AB_TEST_AMBIENT']).toBe('from-process')
      expect(env?.['AB_TEST_OVERRIDE']).toBe('scoped-wins')
      expect(env?.['AB_TOKEN']).toBe('tok')
    } finally {
      delete process.env['AB_TEST_AMBIENT']
      delete process.env['AB_TEST_OVERRIDE']
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
      signal: controller.signal,
    })

    expect(result).toEqual({ text: 'login-rate-limit' })
    expect(creates[0]).toEqual({
      cwd: '/repos/app',
      model: { provider: 'openai', id: 'gpt-5.6-sol' },
      tools: [],
      extensions: [],
    })
    expect(prompts[0]?.text).toBe('name this spec verbatim')
    expect(prompts[0]?.env['NAMING_TOKEN']).toBe('secret')
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
      startOpts({ env: { AB_BUILD: 'auth-rate-limit', AB_PHASE: 'implement@1', AB_SESSION: 's_3' } }),
    )
    await runner.continue(session, 'fix', { env: { AB_PHASE: 'implement@2', AB_SESSION: 's_5' } })

    const env = prompts[1]?.env
    expect(env?.['AB_PHASE']).toBe('implement@2')
    expect(env?.['AB_SESSION']).toBe('s_5')
    // A start-only key survives the per-turn refresh.
    expect(env?.['AB_BUILD']).toBe('auth-rate-limit')
  })

  test('keeps the distribution CLI ahead of a conflicting host ab on start and continue', async () => {
    const conflictDir = await mkdtemp(join(tmpdir(), 'ab-pi-path-'))
    const originalPath = process.env['PATH']
    try {
      await writeConflictingAb(conflictDir)
      const inheritedPath = [conflictDir, originalPath ?? '']
        .filter((entry) => entry !== '')
        .join(delimiter)
      process.env['PATH'] = inheritedPath
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
          },
        }),
      )
      await runner.continue(session, 'next round', {
        env: { AB_PHASE: 'plan@2', AB_SESSION: 's_2' },
      })

      for (const prompt of prompts) {
        const entries = prompt.env['PATH']!.split(delimiter)
        expect(entries[0]).toBe(AGENT_BIN_DIR)
        expect(entries[1]).toBe(conflictDir)
      }

      const smoke = await invokeAbHelp(prompts[1]!.env)
      expect(smoke).toMatchObject({ code: 0, stderr: '' })
      expect(smoke.stdout).toContain('ab — agent-driven software delivery')
      expect(smoke.stdout).not.toContain('host-conflicting-ab')
      await runner.end(session)
    } finally {
      if (originalPath === undefined) delete process.env['PATH']
      else process.env['PATH'] = originalPath
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
    expect(content.turns[0]).toMatchObject({ turn: 1, prompt: '/ab-plan auth-rate-limit' })
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
