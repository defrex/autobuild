import { describe, expect, test } from 'bun:test'
import { delimiter } from 'node:path'
import type { StreamPart } from '../../store/streams/types'
import {
  agyPromptArg,
  AntigravityAgentRunner,
  isAntigravityRuntimeUsable,
  type AntigravityCliResult,
  type AntigravityCliStreamFn,
} from './antigravity'
import { createProductionRuntimes } from './production'
import { AGENT_BIN_DIR } from './session-env'

import {
  type Event,
  init,
  delta,
  userInput,
  tool,
  result,
  output,
  type Script,
  fakeCli,
  fakeStream,
  promptOf,
  startOpts,
} from './antigravity-test.fixture'
describe('agyPromptArg', () => {
  test('guards only values that would start with a dash', () => {
    expect(agyPromptArg('- finding')).toBe('\n- finding')
    expect(agyPromptArg('--x')).toBe('\n--x')
    expect(agyPromptArg('/ab-plan Run this skill')).toBe('/ab-plan Run this skill')
    expect(agyPromptArg('plain')).toBe('plain')
  })
})

describe('AntigravityAgentRunner start and continue', () => {
  test('uses exact headless argv, the native conversation id, and /skill syntax', async () => {
    const cli = fakeCli([
      output([
        init('native-conv'),
        delta('native-conv', 1, 'started'),
        result('native-conv', { response: 'started' }),
      ]),
      output([
        init('native-conv'),
        delta('native-conv', 1, 'continued'),
        result('native-conv', { response: 'continued' }),
      ]),
    ])
    const runner = new AntigravityAgentRunner({ runCli: cli.runCli })
    const opts = startOpts({ model: 'gemini-3.8-flash-medium', args: ['--effort', 'high'] })
    const { session, result: started } = await runner.start(opts)
    expect(session).toEqual({
      id: 'native-conv',
      runner: 'antigravity',
      model: 'gemini-3.8-flash-medium',
    })
    expect(started).toEqual({
      kind: 'completed',
      text: 'started',
      usage: { inputTokens: 3, outputTokens: 2, turns: 1 },
    })
    const prompt = runner.startPrompt(opts)
    expect(prompt.startsWith('/ab-plan ')).toBe(true)
    expect(cli.calls[0]?.args).toEqual([
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--model',
      'gemini-3.8-flash-medium',
      '--effort',
      'high',
      '-p',
      prompt,
    ])
    expect(cli.calls[0]?.cwd).toBe('/ws/agy-runtime')

    await runner.continue(session, '- fix the bullet', { env: { AB_PHASE: 'implement@2' } })
    const args = cli.calls[1]!.args
    expect(args).toEqual([
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--model',
      'gemini-3.8-flash-medium',
      '--conversation',
      'native-conv',
      '--effort',
      'high',
      '-p',
      '\n- fix the bullet',
    ])
    for (const call of cli.calls) {
      expect(call.args).not.toContain('--disable-slash-commands')
      expect(call.args.some((arg) => arg.startsWith('--prompt='))).toBe(false)
      expect(promptOf(call).startsWith('-')).toBe(false)
    }
    const env = cli.calls[1]!.env
    expect(env.AB_PHASE).toBe('implement@2')
    expect(env.AB_BUILD).toBe('agy-runtime')
    expect(env.PATH?.split(delimiter)[0]).toBe(AGENT_BIN_DIR)

    const transcript = JSON.parse((await runner.end(session)).content) as {
      nativeConversationId: string
      turns: Array<{ prompt: string }>
    }
    expect(transcript.nativeConversationId).toBe('native-conv')
    expect(transcript.turns.map((turn) => turn.prompt)).toEqual([prompt, '- fix the bullet'])
  })

  test('omits --model when no model is configured', async () => {
    const cli = fakeCli([output([init(), result('conv-1', { response: 'ok' })])])
    const runner = new AntigravityAgentRunner({ runCli: cli.runCli })
    const { session } = await runner.start(startOpts())
    expect(cli.calls[0]?.args).not.toContain('--model')
    await runner.end(session)
  })

  test('session-control role args are configuration failures that never launch', async () => {
    for (const arg of ['--conversation', '--conversation=x', '-c', '--continue', '-i']) {
      const cli = fakeCli([])
      const runner = new AntigravityAgentRunner({ runCli: cli.runCli })
      const { session, result: started } = await runner.start(startOpts({ args: [arg, 'x'] }))
      expect(started).toMatchObject({
        kind: 'failed',
        failure: { permanent: true, cause: 'configuration' },
      })
      expect(cli.calls).toHaveLength(0)
      await runner.end(session)
    }
  })

  test('continue after a start without a conversation id throws', async () => {
    const runner = new AntigravityAgentRunner({
      runCli: fakeCli([new Error('boom')]).runCli,
      createSessionId: () => 'synthetic',
    })
    const { session } = await runner.start(startOpts())
    await expect(runner.continue(session, 'again')).rejects.toThrow(
      'antigravity: cannot continue session "synthetic"',
    )
    await runner.end(session)
  })
})

describe('AntigravityAgentRunner failure classification', () => {
  async function failureOf(script: Script) {
    const runner = new AntigravityAgentRunner({
      runCli: fakeCli([script]).runCli,
      createSessionId: () => 'synthetic',
    })
    const { session, result: started } = await runner.start(startOpts())
    await runner.end(session)
    if (started.kind !== 'failed') throw new Error('expected a failed turn')
    return started.failure
  }

  test('authentication text is a credential failure', async () => {
    expect(
      await failureOf(output([], { stderr: 'authentication required', exitCode: 1 })),
    ).toMatchObject({ cause: 'credentials', permanent: true, message: 'authentication required' })
    expect(
      await failureOf(
        output([], { stderr: 'failed to retrieve token: secret keyring is locked', exitCode: 1 }),
      ),
    ).toMatchObject({ cause: 'credentials' })
    expect(
      await failureOf(output([], { stderr: 'GEMINI_API_KEY is not set', exitCode: 1 })),
    ).toMatchObject({ cause: 'credentials' })
  })

  test('quota text is exhaustion and keeps its message verbatim', async () => {
    const message = 'RESOURCE_EXHAUSTED: quota exceeded for this project'
    expect(
      await failureOf(
        output([init(), result('conv-1', { status: 'ERROR', error: message })], { exitCode: 1 }),
      ),
    ).toEqual({ message, permanent: true, cause: 'exhaustion' })
  })

  test('an unknown model is a permanent configuration failure', async () => {
    const message =
      'invalid model selection (does-not-exist): does-not-exist is not recognized as a known model'
    expect(
      await failureOf(
        output([init(), result('conv-1', { status: 'ERROR', error: message })], { exitCode: 1 }),
      ),
    ).toEqual({ message, permanent: true, cause: 'configuration' })
  })

  test('a WAITING result is a configuration failure naming the remedy', async () => {
    const failure = await failureOf(
      output([init(), result('conv-1', { status: 'WAITING', error: 'waiting for review' })]),
    )
    expect(failure).toMatchObject({ permanent: true, cause: 'configuration' })
    expect(failure.message).toContain('artifactReviewPolicy')
    expect(failure.message).toContain('agentMode "plan"')
  })

  test('a generic error stays retryable availability', async () => {
    expect(
      await failureOf(
        output([init(), result('conv-1', { status: 'ERROR', error: 'backend hiccup' })], {
          exitCode: 1,
        }),
      ),
    ).toEqual({ message: 'backend hiccup', permanent: false, cause: 'availability' })
  })

  test('malformed output, a missing result, and a missing conversation id fail', async () => {
    expect(
      (
        await failureOf(
          output([init(), result('conv-1', { response: 'ok' })], { extra: 'not json\n' }),
        )
      ).message,
    ).toBe('antigravity runtime: agy emitted malformed stream-json output')
    expect((await failureOf(output([init(), delta('conv-1', 1, 'partial')]))).message).toBe(
      'antigravity runtime: agy stream ended without a result event',
    )
    expect(
      (
        await failureOf(
          output([{ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }]),
        )
      ).message,
    ).toBe('antigravity runtime: agy stream ended without a conversation_id')
  })

  test('a missing executable explains installation and authentication', async () => {
    const failure = await failureOf(Object.assign(new Error('spawn agy'), { code: 'ENOENT' }))
    expect(failure).toMatchObject({
      permanent: true,
      cause: 'configuration',
      missingExecutable: true,
    })
    expect(failure.message).toContain('"agy" was not found')
    expect(failure.message).toContain('GEMINI_API_KEY')
    expect(failure.message).toContain('AGY_ADC_AUTH=true')
  })

  test('another launch error stays retryable', async () => {
    expect(await failureOf(new Error('EACCES'))).toMatchObject({
      permanent: false,
      cause: 'availability',
    })
  })
})

describe('AntigravityAgentRunner usage and transcripts', () => {
  async function twoTurns(turn1: Event[], turn2: Event[]) {
    const cli = fakeCli([output(turn1), output(turn2)])
    const runner = new AntigravityAgentRunner({ runCli: cli.runCli })
    const { session, result: first } = await runner.start(startOpts({ model: 'gemini-x' }))
    const second = await runner.continue(session, 'again')
    const transcript = await runner.end(session)
    return { first, second, transcript }
  }

  const turn1 = [
    init('c'),
    userInput('c', 0),
    delta('c', 1, 'one', 'DONE', { input_tokens: 30384, output_tokens: 4 }),
    result('c', { response: 'one', usage: { input_tokens: 30384, output_tokens: 4 }, numTurns: 1 }),
  ]

  test('per-step usage is per turn when the result is cumulative', async () => {
    const { first, second, transcript } = await twoTurns(turn1, [
      init('c'),
      userInput('c', 2),
      delta('c', 3, 'two', 'DONE', { input_tokens: 278, output_tokens: 4 }),
      result('c', {
        response: 'two',
        usage: { input_tokens: 30662, output_tokens: 8 },
        numTurns: 2,
      }),
    ])
    expect(first.usage).toEqual({ inputTokens: 30384, outputTokens: 4, turns: 1 })
    expect(second.usage).toEqual({ inputTokens: 278, outputTokens: 4, turns: 1 })
    expect(transcript.metadata.usage).toEqual({ inputTokens: 30662, outputTokens: 8, turns: 2 })
  })

  test('per-step usage is per turn when the result resets', async () => {
    const { second, transcript } = await twoTurns(turn1, [
      init('c'),
      userInput('c', 0),
      delta('c', 1, 'two', 'DONE', { input_tokens: 278, output_tokens: 4 }),
      result('c', { response: 'two', usage: { input_tokens: 278, output_tokens: 4 }, numTurns: 1 }),
    ])
    expect(second.usage).toEqual({ inputTokens: 278, outputTokens: 4, turns: 1 })
    expect(transcript.metadata.usage).toEqual({ inputTokens: 30662, outputTokens: 8, turns: 2 })
  })

  test('a replayed earlier step before the new user_input is not counted', async () => {
    const { second } = await twoTurns(turn1, [
      init('c'),
      delta('c', 1, 'one', 'DONE', { input_tokens: 30384, output_tokens: 4 }),
      userInput('c', 2),
      delta('c', 3, 'two', 'DONE', { input_tokens: 278, output_tokens: 4 }),
      result('c', {
        response: 'two',
        usage: { input_tokens: 30662, output_tokens: 8 },
        numTurns: 2,
      }),
    ])
    expect(second.usage).toEqual({ inputTokens: 278, outputTokens: 4, turns: 1 })
    expect(second.text).toBe('two')
  })

  test('without step usage, the result is used only when it describes this turn', async () => {
    const plain = (usage: { input_tokens: number; output_tokens: number }, numTurns: number) => [
      init('c'),
      delta('c', 1, 'x'),
      result('c', { response: 'x', usage, numTurns }),
    ]
    const single = await twoTurns(
      plain({ input_tokens: 10, output_tokens: 2 }, 1),
      plain({ input_tokens: 7, output_tokens: 1 }, 1),
    )
    expect(single.first.usage).toEqual({ inputTokens: 10, outputTokens: 2, turns: 1 })
    expect(single.second.usage).toEqual({ inputTokens: 7, outputTokens: 1, turns: 1 })

    const delta2 = await twoTurns(
      plain({ input_tokens: 10, output_tokens: 2 }, 1),
      plain({ input_tokens: 17, output_tokens: 3 }, 2),
    )
    expect(delta2.second.usage).toEqual({ inputTokens: 7, outputTokens: 1, turns: 1 })

    // A resumed turn knows no previous raw usage: report 0/0, keep the raw value.
    const runner = new AntigravityAgentRunner({
      runCli: fakeCli([output(plain({ input_tokens: 17, output_tokens: 3 }, 2))]).runCli,
    })
    const { nativeHandle } = await import('./native-session')
    const resumed = await runner.resume(
      nativeHandle('antigravity', 'c', '/ws/agy-runtime'),
      'again',
      startOpts(),
    )
    if (resumed.kind !== 'resumed') throw new Error(resumed.message)
    expect(resumed.result.usage).toEqual({ inputTokens: 0, outputTokens: 0, turns: 1 })
    const content = JSON.parse((await runner.end(resumed.session)).content) as {
      turns: Array<{ resultUsage: unknown; events: unknown[] }>
    }
    expect(content.turns[0]?.resultUsage).toEqual({ inputTokens: 17, outputTokens: 3 })
  })

  test('the transcript holds both turns, raw usage, and the native id', async () => {
    const { transcript } = await twoTurns(turn1, [
      init('c'),
      userInput('c', 2),
      delta('c', 3, 'two', 'DONE', { input_tokens: 278, output_tokens: 4 }),
      result('c', {
        response: 'two',
        usage: { input_tokens: 30662, output_tokens: 8 },
        numTurns: 2,
      }),
    ])
    const content = JSON.parse(transcript.content) as {
      nativeConversationId: string
      turns: Array<{ events: unknown[]; resultUsage: unknown }>
    }
    expect(content.nativeConversationId).toBe('c')
    expect(content.turns).toHaveLength(2)
    expect(content.turns[1]?.events).toHaveLength(4)
    expect(content.turns[1]?.resultUsage).toEqual({ inputTokens: 30662, outputTokens: 8 })
    expect(transcript.metadata).toMatchObject({ runner: 'antigravity', model: 'gemini-x' })
  })

  test('end is idempotent, bounded, and rejects unknown sessions', async () => {
    const scripts = Array.from({ length: 34 }, (_, i) =>
      output([init(`c${i}`), result(`c${i}`, { response: 'ok' })]),
    )
    const runner = new AntigravityAgentRunner({ runCli: fakeCli(scripts).runCli })
    const first = await runner.start(startOpts())
    const transcript = await runner.end(first.session)
    expect(await runner.end(first.session)).toEqual(transcript)
    await expect(runner.continue(first.session, 'again')).rejects.toThrow()
    await expect(runner.end({ id: 'never', runner: 'antigravity' })).rejects.toThrow(
      'antigravity: end on unknown session "never"',
    )
    for (let i = 1; i <= 32; i++) {
      const started = await runner.start(startOpts())
      await runner.end(started.session)
    }
    await expect(runner.end(first.session)).rejects.toThrow('end on unknown session "c0"')
  })
})

describe('AntigravityAgentRunner streaming', () => {
  const events = [
    init('s'),
    userInput('s', 0),
    delta('s', 1, 'hel', 'ACTIVE'),
    delta('s', 1, 'lo', 'DONE'),
    tool('s', 2, 'run_command', { command: 'ls' }, 'a\nb', 'ACTIVE'),
    tool('s', 2, 'run_command', { command: 'ls' }, 'a\nb'),
    result('s', { response: 'hello' }),
  ]
  const expected = [
    'data-ab-prompt',
    'start',
    'start-step',
    'text-start',
    'text-delta',
    'text-delta',
    'text-end',
    'finish-step',
    'tool-input-available',
    'tool-output-available',
    'finish',
  ]

  test('live and buffered paths emit the same ordered parts', async () => {
    for (const runner of [
      new AntigravityAgentRunner({ runCliStream: fakeStream([output(events)]).runCliStream }),
      new AntigravityAgentRunner({ runCli: fakeCli([output(events)]).runCli }),
    ]) {
      const parts: StreamPart[] = []
      const { session } = await runner.start(
        startOpts({ stream: { append: (appended) => parts.push(...appended) } }),
      )
      expect(parts.map((part) => part.type)).toEqual(expected)
      expect(parts[8]).toEqual({
        type: 'tool-input-available',
        toolCallId: 'agy-2',
        toolName: 'run_command',
        input: { command: 'ls' },
      })
      expect(parts[9]).toEqual({
        type: 'tool-output-available',
        toolCallId: 'agy-2',
        output: 'a\nb',
      })
      await runner.end(session)
    }
  })

  test('an unfinished text step is closed before the turn ends with error', async () => {
    const parts: StreamPart[] = []
    const runner = new AntigravityAgentRunner({
      runCliStream: fakeStream([
        output([init('s'), delta('s', 1, 'partial', 'ACTIVE')], { exitCode: 1, stderr: 'crash' }),
      ]).runCliStream,
    })
    const { session } = await runner.start(
      startOpts({ stream: { append: (appended) => parts.push(...appended) } }),
    )
    expect(parts.map((part) => part.type).slice(-3)).toEqual(['text-end', 'finish-step', 'error'])
    await runner.end(session)
  })

  /** Streams `partial`, then aborts and rejects the result promise. */
  function interruptedStream(partial: Event[]): AntigravityCliStreamFn {
    return (call) => {
      const rejected = new Promise<AntigravityCliResult>((_, reject) => {
        void Promise.resolve().then(() => reject(new Error('agy read failed')))
      })
      rejected.catch(() => {})
      return {
        lines: (async function* () {
          for (const event of partial) yield JSON.stringify(event)
          ;(call.signal as AbortSignal | undefined)?.throwIfAborted()
        })(),
        result: rejected,
      }
    }
  }

  test('a rejected result after partial output keeps it on start', async () => {
    const controller = new AbortController()
    const partial = [
      init('partial-conversation'),
      delta('partial-conversation', 1, 'partial answer', 'ACTIVE'),
    ]
    const runner = new AntigravityAgentRunner({
      runCliStream: (call) => {
        controller.abort(new Error('cancelled'))
        return interruptedStream(partial)(call)
      },
      createSessionId: () => 'random-replacement',
    })
    const { session, result: turn } = await runner.start(startOpts({ signal: controller.signal }))
    expect(turn.kind).toBe('failed')
    expect(turn.text).toBe('partial answer')
    expect(session.id).toBe('partial-conversation')
    const content = JSON.parse((await runner.end(session)).content) as {
      nativeConversationId: string
      turns: Array<{ events: unknown[]; text: string; conversationId: string }>
    }
    expect(content.nativeConversationId).toBe('partial-conversation')
    expect(content.turns[0]?.events).toEqual(partial)
    expect(content.turns[0]?.text).toBe('partial answer')
    expect(content.turns[0]?.conversationId).toBe('partial-conversation')
  })

  test('a rejected result after partial output keeps it on continue', async () => {
    const first = fakeStream([output([init('c'), result('c', { response: 'one' })])])
    const partial = [
      init('c'),
      userInput('c', 2),
      delta('c', 3, 'half', 'ACTIVE', { input_tokens: 5, output_tokens: 1 }),
      tool('c', 4, 'run_command', { command: 'ls' }, 'a'),
    ]
    let calls = 0
    const runner = new AntigravityAgentRunner({
      runCliStream: (call) =>
        calls++ === 0 ? first.runCliStream(call) : interruptedStream(partial)(call),
    })
    const { session } = await runner.start(startOpts())
    const turn = await runner.continue(session, 'again')
    expect(turn.kind).toBe('failed')
    expect(turn.text).toBe('half')
    const content = JSON.parse((await runner.end(session)).content) as {
      turns: Array<{ events: unknown[]; conversationId: string; toolSteps: string[] }>
    }
    expect(content.turns[1]?.events).toEqual(partial)
    expect(content.turns[1]?.conversationId).toBe('c')
    expect(content.turns[1]?.toolSteps).toEqual(['run_command'])
  })

  test('the production registration labels its stream by the Autobuild session', async () => {
    const registration = createProductionRuntimes().runtimes.antigravity!
    const opened: string[] = []
    const label = await registration.openSessionStream!(
      {
        open: async (name: string) => {
          opened.push(name)
          return name
        },
      } as never,
      { session: 's_42', role: 'implement', runner: 'antigravity', phase: 'implement' },
    )
    expect(label).toBe('session:s_42')
    expect(opened).toEqual(['session:s_42'])
  })
})

describe('Antigravity runtime usability', () => {
  const baseInput = {
    cwd: '/repo',
    env: { PATH: '/bin', UNSET: undefined } as Record<string, string | undefined>,
    models: [] as string[],
  }

  function probe(scripts: Script[]) {
    const cli = fakeCli(scripts)
    const removed: string[] = []
    return {
      cli,
      removed,
      deps: {
        runCli: cli.runCli,
        makeProbeDir: async () => '/tmp/ab-agy-probe-x',
        removeProbeDir: async (path: string) => {
          removed.push(path)
        },
      },
    }
  }

  const success = {
    stdout: JSON.stringify({ status: 'SUCCESS', response: 'ok' }),
    stderr: '',
    exitCode: 0,
  }

  test('makes one minimal request in an empty probe directory', async () => {
    const p = probe([success])
    expect(await isAntigravityRuntimeUsable(baseInput, p.deps)).toEqual({
      usable: true,
      reason: 'Antigravity CLI is installed and a minimal model request succeeded',
    })
    expect(p.cli.calls).toHaveLength(1)
    const call = p.cli.calls[0]!
    expect(call.args).toEqual([
      '-p',
      'Reply with exactly: ok',
      '--output-format',
      'json',
      '--disable-slash-commands',
      '--print-timeout',
      '60s',
    ])
    expect(call.args).not.toContain('models')
    expect(call.args).not.toContain('--dangerously-skip-permissions')
    expect(call.cwd).toBe('/tmp/ab-agy-probe-x')
    expect(call.env).toEqual({ PATH: '/bin' })
    expect(call.signal).toBeDefined()
    expect(p.removed).toEqual(['/tmp/ab-agy-probe-x'])
  })

  test('probes each configured model and names a failing one', async () => {
    const ok = probe([success])
    expect(
      await isAntigravityRuntimeUsable({ ...baseInput, models: ['gemini-a'] }, ok.deps),
    ).toEqual({
      usable: true,
      reason: 'Antigravity CLI is installed and a minimal model request succeeded (model gemini-a)',
    })
    expect(ok.cli.calls[0]?.args.slice(-2)).toEqual(['--model', 'gemini-a'])

    const p = probe([
      success,
      {
        stdout: JSON.stringify({
          status: 'ERROR',
          error: 'invalid model selection (gemini-b): gemini-b is not recognized as a known model',
        }),
        stderr: '',
        exitCode: 1,
      },
    ])
    const outcome = await isAntigravityRuntimeUsable(
      { ...baseInput, models: ['gemini-a', 'gemini-b'] },
      p.deps,
    )
    expect(outcome).toMatchObject({ usable: false })
    expect((outcome as { reason: string }).reason).toStartWith(
      'Antigravity CLI configuration problem: invalid model selection',
    )
    expect((outcome as { reason: string }).reason).toEndWith('(model gemini-b)')
    expect(p.removed).toEqual(['/tmp/ab-agy-probe-x'])
  })

  test('a reachable CLI without authentication is unusable', async () => {
    for (const script of [
      {
        stdout: JSON.stringify({ status: 'ERROR', error: 'authentication required' }),
        stderr: '',
        exitCode: 0,
      },
      { stdout: '', stderr: 'GEMINI_API_KEY is not set\nmore detail', exitCode: 1 },
      { stdout: '', stderr: 'failed to retrieve token: secret keyring is locked', exitCode: 1 },
    ]) {
      const p = probe([script])
      const outcome = (await isAntigravityRuntimeUsable(baseInput, p.deps)) as {
        usable: boolean
        reason: string
      }
      expect(outcome.usable).toBe(false)
      expect(outcome.reason).toStartWith('Antigravity CLI is not authenticated: ')
      expect(outcome.reason).not.toContain('\n')
    }
  })

  test('malformed JSON, a missing executable, and a timeout are unusable', async () => {
    expect(
      await isAntigravityRuntimeUsable(
        baseInput,
        probe([{ stdout: 'nope', stderr: '', exitCode: 0 }]).deps,
      ),
    ).toEqual({
      usable: false,
      reason: 'Antigravity CLI request failed: agy returned malformed JSON',
    })
    const missing = (await isAntigravityRuntimeUsable(
      baseInput,
      probe([Object.assign(new Error('spawn agy'), { code: 'ENOENT' })]).deps,
    )) as { usable: boolean; reason: string }
    expect(missing.usable).toBe(false)
    expect(missing.reason).toContain('"agy" was not found')
    expect(
      await isAntigravityRuntimeUsable(
        baseInput,
        probe([new Error('The operation timed out.')]).deps,
      ),
    ).toEqual({ usable: false, reason: 'The operation timed out.' })
  })

  test('redacts secrets echoed by the CLI', async () => {
    const key = 'AIzaSyD-synthetic-secret-value'
    const p = probe([{ stdout: '', stderr: `invalid API key ${key}`, exitCode: 1 }])
    const outcome = (await isAntigravityRuntimeUsable(
      { ...baseInput, env: { ...baseInput.env, GEMINI_API_KEY: key } },
      p.deps,
    )) as { usable: boolean; reason: string }
    expect(outcome.usable).toBe(false)
    expect(outcome.reason).not.toContain(key)
    expect(outcome.reason).toContain('[redacted]')
  })
})
