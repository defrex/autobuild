import type { StreamPart } from '../../store/streams/types'
import type { AgentRunner, SessionStreamEmitter } from '../types'
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
import { CodexAgentRunner, type CodexCliInvocation, type CodexCliRunFn } from './codex'

import { thread, message, completed, output, promptOf } from './codex-test.fixture'
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
    if (scenario === 'stream-turn') {
      return output([
        thread('contract-thread'),
        {
          type: 'item.started',
          item: { id: 'tool-1', type: 'command_execution', command: 'grep -r x' },
        },
        {
          type: 'item.completed',
          item: { id: 'tool-1', type: 'command_execution', command: 'grep -r x', exit_code: 0 },
        },
        message('contract stream'),
        completed(),
      ])
    }
    return output([thread('contract-thread'), message(text), completed()])
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
  const inner = new CodexAgentRunner({ runCli, createSessionId: () => 'synthetic-contract' })
  const runner: AgentRunner = {
    name: inner.name,
    start: (opts) => inner.start(record(opts)),
    continue: (session, message, opts) =>
      inner.continue(session, message, opts === undefined ? undefined : record(opts)),
    end: (session) => inner.end(session),
  }
  return {
    runner,
    model: 'gpt-contract-model',
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

describeAgentRunnerContract('CodexAgentRunner (injected Codex CLI)', codexContractFactory)
