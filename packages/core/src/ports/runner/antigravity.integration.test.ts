import type { StreamPart } from '../../store/streams/types'
import type { AgentRunner, SessionStreamEmitter } from '../types'
import {
  CONTRACT_EXHAUSTION_FAILURE,
  CONTRACT_FOLLOW_UP,
  CONTRACT_PERMANENT_FAILURE,
  CONTRACT_RETRYABLE_FAILURE,
  CONTRACT_STREAM_TOOL,
  describeAgentRunnerContract,
  type AgentRunnerContractFactory,
} from './contract'
import {
  AntigravityAgentRunner,
  type AntigravityCliInvocation,
  type AntigravityCliResult,
  type AntigravityCliStreamFn,
} from './antigravity'

import { init, delta, userInput, tool, result, output, promptOf } from './antigravity-test.fixture'
function waitForContractAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (signal === undefined) return reject(new Error('contract CLI received no AbortSignal'))
    const abort = () => reject(signal.reason ?? new Error('contract CLI aborted'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

const antigravityContractFactory: AgentRunnerContractFactory = (scenario) => {
  const calls: AntigravityCliInvocation[] = []
  const respond = (call: AntigravityCliInvocation): AntigravityCliResult | Promise<never> => {
    const prompt = promptOf(call)
    const id = 'contract-conversation'
    if (
      scenario === 'cancel-start' ||
      (scenario === 'cancel-continue' && prompt === CONTRACT_FOLLOW_UP)
    ) {
      return waitForContractAbort(call.signal)
    }
    if (scenario === 'retryable-failure')
      return output(
        [init(id), result(id, { status: 'ERROR', error: CONTRACT_RETRYABLE_FAILURE })],
        {
          exitCode: 1,
        },
      )
    if (scenario === 'permanent-failure')
      return output(
        [init(id), result(id, { status: 'ERROR', error: CONTRACT_PERMANENT_FAILURE })],
        {
          exitCode: 1,
        },
      )
    if (scenario === 'exhaustion-failure')
      return output(
        [init(id), result(id, { status: 'ERROR', error: CONTRACT_EXHAUSTION_FAILURE })],
        { exitCode: 1 },
      )
    if (scenario === 'stream-turn') {
      return output([
        init(id),
        userInput(id, 0),
        delta(id, 1, 'contract ', 'ACTIVE'),
        delta(id, 1, 'stream', 'DONE', { input_tokens: 2, output_tokens: 1 }),
        tool(id, 2, CONTRACT_STREAM_TOOL, { query: 'x' }, 'found', 'ACTIVE'),
        tool(id, 2, CONTRACT_STREAM_TOOL, { query: 'x' }, 'found'),
        result(id, { response: 'contract stream' }),
      ])
    }
    const text = prompt === CONTRACT_FOLLOW_UP ? 'contract continued' : 'contract started'
    return output([init(id), delta(id, 1, text), result(id, { response: text })])
  }
  const runCliStream: AntigravityCliStreamFn = (call) => {
    calls.push(call)
    const completed = Promise.resolve(respond(call))
    return {
      lines: (async function* () {
        const cli = await completed
        for (const line of cli.stdout.split('\n')) if (line !== '') yield line
      })(),
      result: completed,
    }
  }
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
  const inner = new AntigravityAgentRunner({
    runCliStream,
    createSessionId: () => 'synthetic-contract',
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
    model: 'gemini-contract-model',
    workspacePath: process.cwd(),
    stream: () => recorded,
    idempotentEnd: true,
    turns: () =>
      calls.map((call) => ({
        ...(call.args.includes('--conversation') ? { message: promptOf(call) } : {}),
        env: call.env,
      })),
  }
}

describeAgentRunnerContract('AntigravityAgentRunner (injected agy CLI)', antigravityContractFactory)
