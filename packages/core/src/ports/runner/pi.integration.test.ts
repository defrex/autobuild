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
import { PiAgentRunner, type PiCreateSessionFn, type PiModelRef, type PiTurn } from './pi'
import { classifyProviderError } from './provider-error'

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
    const onEvent = opts.onEvent
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
        // Native session events: a registered translator (a streamed turn)
        // maps them onto parts; other scenarios never carry one.
        if (onEvent !== undefined) {
          onEvent({ type: 'turn_start' })
          onEvent({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_start', id: 't1' },
          })
          onEvent({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: 'contract stream' },
          })
          onEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_end', id: 't1' } })
          onEvent({
            type: 'tool_execution_start',
            toolCallId: 'tool-1',
            toolName: CONTRACT_STREAM_TOOL,
            args: { q: 'x' },
          })
          onEvent({ type: 'tool_execution_end', toolCallId: 'tool-1', result: 'ok' })
          onEvent({ type: 'turn_end' })
        }
        if (
          scenario !== 'success' &&
          scenario !== 'cancel-continue' &&
          scenario !== 'stream-turn'
        ) {
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
