/**
 * ClaudeAgentRunner (SPEC §9): AgentRunner over the Claude Agent SDK
 * (subscription billing). The SDK sits behind an injectable `QueryFn`
 * boundary so tests never load it; the default lazily dynamic-imports
 * `@anthropic-ai/claude-agent-sdk`.
 *
 * The SDK has native session resumption, so `continue` uses `resume` rather
 * than the start-with-rehydrate-from-store fallback other adapters need (§9).
 */
import type {
  AgentContinueOpts,
  AgentRunner,
  AgentSessionHandle,
  AgentStartOpts,
  AgentTurnResult,
  Transcript,
} from '../types'

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

export class ClaudeAgentRunner implements AgentRunner {
  readonly name = 'claude'

  private readonly queryFn: QueryFn
  private readonly sessions = new Map<string, SessionState>()

  constructor(opts: { queryFn?: QueryFn } = {}) {
    this.queryFn = opts.queryFn ?? sdkQueryFn
  }

  async start(
    opts: AgentStartOpts,
  ): Promise<{ session: AgentSessionHandle; result: AgentTurnResult }> {
    // Every phase skill takes only the build slug (§4).
    const prompt = `/${opts.skill} ${opts.buildSlug}`
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
          buildSlug: state.opts.buildSlug,
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

  /** Run one prompt through the SDK stream; accumulate text, capture usage
   * and session id from the terminal result message. */
  private async runTurn(
    prompt: string,
    opts: AgentStartOpts,
    resume?: string,
  ): Promise<{
    text: string
    usage: { inputTokens: number; outputTokens: number }
    sessionId: string
  }> {
    const stream = this.queryFn({
      prompt,
      options: {
        cwd: opts.workspacePath,
        // Ambient auth (D8): AB_* scoped vars merged over process.env.
        env: { ...ambientEnv(), ...opts.env },
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(resume !== undefined ? { resume } : {}),
      },
    })

    const texts: string[] = []
    let result: SdkResultMessage | undefined
    for await (const message of stream) {
      if (isAssistant(message)) {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text !== undefined) {
            texts.push(block.text)
          }
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

function ambientEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  return env
}
