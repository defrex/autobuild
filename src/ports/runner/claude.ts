/**
 * ClaudeAgentRunner (SPEC §9): AgentRunner over the Claude Agent SDK
 * (subscription billing). The SDK sits behind an injectable `QueryFn`
 * boundary so tests never load it; the default lazily dynamic-imports
 * `@anthropic-ai/claude-agent-sdk`.
 *
 * The SDK has native session resumption, so `continue` uses `resume` rather
 * than the start-with-rehydrate-from-store fallback other adapters need (§9).
 * Sessions are deliberately non-interactive: build workspaces are disposable,
 * agents must be able to invoke `ab` and development tools without a human
 * approval prompt, and the pipeline's typed CLI remains the state boundary.
 */
import {
  agentInvocation,
  type AgentContinueOpts,
  type AgentRunner,
  type AgentSessionHandle,
  type AgentStartOpts,
  type AgentTurnResult,
  type Transcript,
} from '../types'
import type {
  OneShotCompletion,
  OneShotCompletionInput,
  OneShotCompletionResult,
} from './one-shot'

// ── Structural SDK types ─────────────────────────────────────────────────────
//
// Minimal shapes for exactly what we consume from the stream; the SDK's real
// message union is far wider and everything else is ignored.

export interface SdkAssistantMessage {
  type: 'assistant'
  message: { content: Array<{ type: string; text?: string }> }
}

export interface SdkResultMessage {
  type: 'result'
  session_id: string
  usage: { input_tokens: number; output_tokens: number }
}

export type SdkMessage =
  | SdkAssistantMessage
  | SdkResultMessage
  | { type: string }

function isAssistant(m: SdkMessage): m is SdkAssistantMessage {
  return m.type === 'assistant'
}

function isResult(m: SdkMessage): m is SdkResultMessage {
  return m.type === 'result'
}

export type QueryFn = (opts: {
  prompt: string
  options: {
    cwd: string
    env: Record<string, string>
    model?: string
    resume?: string
    abortController?: AbortController
    maxTurns?: number
    tools?: string[]
    permissionMode: 'bypassPermissions'
    allowDangerouslySkipPermissions: true
  }
}) => AsyncIterable<SdkMessage>

/**
 * The single cast point: the SDK's `query()` accepts a superset of our
 * options and yields a superset of `SdkMessage`; we consume only the
 * structural subset above, so narrowing the stream type here is safe.
 * Deliberately untested — tests inject a fake QueryFn instead (offline).
 */
const sdkQueryFn: QueryFn = async function* (opts) {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  yield* sdk.query({
    prompt: opts.prompt,
    options: opts.options,
  }) as AsyncIterable<SdkMessage>
}

interface TurnRecord {
  turn: number
  prompt: string
  text: string
  usage: { inputTokens: number; outputTokens: number }
}

interface SessionState {
  opts: AgentStartOpts
  model?: string
  turns: TurnRecord[]
}

export class ClaudeAgentRunner implements AgentRunner, OneShotCompletion {
  readonly name = 'claude'

  private readonly queryFn: QueryFn
  private readonly sessions = new Map<string, SessionState>()

  constructor(opts: { queryFn?: QueryFn } = {}) {
    this.queryFn = opts.queryFn ?? sdkQueryFn
  }

  /** Pre-build judgment: one verbatim prompt, one model turn, and no tools.
   * It deliberately creates no resumable AgentRunner session state. */
  async complete(input: OneShotCompletionInput): Promise<OneShotCompletionResult> {
    const cancellation = linkAbortSignal(input.signal)
    try {
      const turn = await this.runPrompt(input.prompt, {
        cwd: input.cwd,
        env: { ...ambientEnv(), ...input.env },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
        tools: [],
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(cancellation.abortController !== undefined
          ? { abortController: cancellation.abortController }
          : {}),
      })
      return { text: turn.text }
    } finally {
      cancellation.dispose()
    }
  }

  async start(
    opts: AgentStartOpts,
  ): Promise<{ session: AgentSessionHandle; result: AgentTurnResult }> {
    // Every phase skill takes only the build slug (§4).
    const prompt = `/${opts.skill} ${agentInvocation(opts)}`
    const turn = await this.runTurn(prompt, opts)

    const session: AgentSessionHandle = {
      id: turn.sessionId,
      runner: this.name,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    }
    this.sessions.set(session.id, {
      opts,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      turns: [{ turn: 1, prompt, text: turn.text, usage: turn.usage }],
    })
    return { session, result: this.toResult(turn) }
  }

  async continue(
    session: AgentSessionHandle,
    message: string,
    opts?: AgentContinueOpts,
  ): Promise<AgentTurnResult> {
    const state = this.liveState(session, 'continue')
    // §10/D8: a continued turn is a new session bracket — the refreshed
    // ambient env (new AB_PHASE round, new AB_SESSION) merges over the start
    // env, so the CLI resolves THIS round, not round 1's stale identity.
    const turnOpts =
      opts?.env !== undefined
        ? { ...state.opts, env: { ...state.opts.env, ...opts.env } }
        : state.opts
    const turn = await this.runTurn(message, turnOpts, session.id)
    state.turns.push({
      turn: state.turns.length + 1,
      prompt: message,
      text: turn.text,
      usage: turn.usage,
    })
    return this.toResult(turn)
  }

  async end(session: AgentSessionHandle): Promise<Transcript> {
    const state = this.liveState(session, 'end')
    this.sessions.delete(session.id)

    const usage = { inputTokens: 0, outputTokens: 0, turns: 0 }
    for (const turn of state.turns) {
      usage.inputTokens += turn.usage.inputTokens
      usage.outputTokens += turn.usage.outputTokens
      usage.turns += 1
    }

    return {
      content: JSON.stringify(
        {
          session: session.id,
          skill: state.opts.skill,
          invocation: agentInvocation(state.opts),
          ...(state.opts.buildSlug !== undefined
            ? { buildSlug: state.opts.buildSlug }
            : {}),
          turns: state.turns,
        },
        null,
        2,
      ),
      metadata: {
        runner: this.name,
        ...(state.model !== undefined ? { model: state.model } : {}),
        usage,
      },
    }
  }

  private liveState(
    session: AgentSessionHandle,
    op: 'continue' | 'end',
  ): SessionState {
    const state = this.sessions.get(session.id)
    if (!state) {
      throw new Error(`${this.name}: ${op} on unknown session "${session.id}"`)
    }
    return state
  }

  /** Build-session wrapper around the shared stream consumer. */
  private runTurn(
    prompt: string,
    opts: AgentStartOpts,
    resume?: string,
  ): Promise<{
    text: string
    usage: { inputTokens: number; outputTokens: number }
    sessionId: string
  }> {
    return this.runPrompt(prompt, {
      cwd: opts.workspacePath,
      // Ambient auth (D8): AB_* scoped vars merged over process.env.
      env: { ...ambientEnv(), ...opts.env },
      // The SDK is headless here: no user exists to answer permission
      // prompts. Build sessions therefore opt into unattended execution
      // explicitly; isolation and credentials remain launcher concerns.
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(resume !== undefined ? { resume } : {}),
    })
  }

  /** Consume one SDK stream for both phase sessions and one-shot prompts. */
  private async runPrompt(
    prompt: string,
    options: Parameters<QueryFn>[0]['options'],
  ): Promise<{
    text: string
    usage: { inputTokens: number; outputTokens: number }
    sessionId: string
  }> {
    const stream = this.queryFn({ prompt, options })
    const texts: string[] = []
    let result: SdkResultMessage | undefined
    for await (const message of stream) {
      if (isAssistant(message)) {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text !== undefined) texts.push(block.text)
        }
      } else if (isResult(message)) {
        result = message
      }
    }
    if (!result) {
      throw new Error(
        `${this.name}: SDK stream ended without a result message (prompt "${prompt}")`,
      )
    }
    return {
      text: texts.join('\n'),
      usage: {
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
      },
      sessionId: result.session_id,
    }
  }

  private toResult(turn: {
    text: string
    usage: { inputTokens: number; outputTokens: number }
  }): AgentTurnResult {
    return { text: turn.text, usage: { ...turn.usage, turns: 1 } }
  }
}

function linkAbortSignal(signal?: AbortSignal): {
  abortController?: AbortController
  dispose: () => void
} {
  if (signal === undefined) return { dispose: () => {} }
  const abortController = new AbortController()
  const abort = (): void => abortController.abort(signal.reason)
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  return {
    abortController,
    dispose: () => signal.removeEventListener('abort', abort),
  }
}

function ambientEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  return env
}
