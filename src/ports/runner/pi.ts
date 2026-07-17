/**
 * PiAgentRunner (SPEC §9): AgentRunner over the `pi` runtime (the real
 * `@earendil-works/pi-coding-agent` SDK) — the second registered runtime,
 * serving the models the Claude Agent SDK does not (Moonshot/Kimi, OpenAI/GPT,
 * and anything else Pi's provider catalog reaches). Structurally a sibling of
 * ClaudeAgentRunner, but Pi's SDK is session-shaped, not request-shaped: you
 * `createAgentSession(...)` once and drive it with `session.prompt(text)`, so
 * the injectable boundary here is a session FACTORY, not a query function.
 *
 * Two things the Claude adapter gets "for free" from its SDK need explicit
 * handling here, both grounded in the real Pi types:
 *
 *  1. Per-turn env → tool subprocess. Pi has no per-prompt `env` option; its
 *     bash tool spawns with the shell env. The build-runner refreshes the
 *     ambient AB_* env every round (§10/D8: new AB_PHASE, new AB_SESSION), and
 *     the `ab` CLI the agent invokes must see THIS round's identity. We install
 *     a custom bash tool whose `spawnHook` overlays a mutable env ref, and
 *     update that ref before every `prompt()`. This is why we hold ONE live
 *     session across continues rather than mutating `process.env` — the
 *     dispatcher runs multiple builds concurrently in one process (§16.1), so a
 *     global mutation would race.
 *
 *  2. Per-turn usage. Pi exposes cumulative token totals via
 *     `session.getSessionStats()`, not a per-turn result message. We snapshot
 *     the totals around each `prompt()` and diff them; the port's usage schema
 *     is non-negative integers (`session.ended`), so the diff is rounded and
 *     clamped.
 *
 * The model identifier is provider-qualified and flows from config
 * (`opts.model`, e.g. `openai/gpt-5.6-sol`), never hardcoded — the whole point
 * of the two-axis config is that the model is a config line, not a code
 * constant. `parsePiModel` splits it into the `(provider, id)` pair Pi's
 * `ModelRuntime.getModel` wants.
 *
 * Sessions are deliberately non-interactive (build workspaces are disposable,
 * agents invoke `ab` without a human approval prompt), matching claude.
 */
import type {
  AgentContinueOpts,
  AgentRunner,
  AgentSessionHandle,
  AgentStartOpts,
  AgentTurnResult,
  Transcript,
} from '../types'

/** Built-in tool set enabled for a build session. `bash` is mandatory — the
 * agent invokes the `ab` CLI through it — and is the one we override with an
 * env-injecting variant (see the default factory). */
const PI_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const

/** A provider-qualified model id, e.g. `openai/gpt-5.6-sol`. */
export interface PiModelRef {
  provider: string
  id: string
}

/**
 * Split a provider-qualified config model id into the `(provider, id)` pair Pi
 * resolves through `ModelRuntime.getModel`. The `id` keeps every segment after
 * the first `/`, so cloudflare's own slashy ids survive
 * (`cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6` →
 * `{ provider: 'cloudflare-workers-ai', id: '@cf/moonshotai/kimi-k2.6' }`).
 */
export function parsePiModel(model: string): PiModelRef {
  const slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(
      `pi runtime: model "${model}" is not provider-qualified — expected ` +
        `"<provider>/<id>" (e.g. "openai/gpt-5.6-sol", ` +
        `"moonshotai/kimi-k3", "cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6"). ` +
        `Run \`ab models <query>\` to look up an id.`,
    )
  }
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) }
}

/** One prompt's captured output: accumulated assistant text and the per-turn
 * token delta (already non-negative integers). */
export interface PiTurn {
  text: string
  usage: { inputTokens: number; outputTokens: number }
}

/**
 * A live Pi agent session, abstracted to exactly what the runner drives. The
 * default factory wraps the real `AgentSession`; tests inject a fake so they
 * never load the SDK.
 */
export interface PiSession {
  /** The SDK session id — becomes the frozen `AgentSessionHandle.id`. */
  readonly sessionId: string
  /**
   * Run one prompt to completion (Pi's `prompt()` resolves only after the full
   * run finishes, retries included) and return its text + per-turn usage.
   * `env` is the ambient+scoped env for THIS turn; the session overlays it onto
   * the bash tool's subprocess env.
   */
  prompt(text: string, env: Record<string, string>): Promise<PiTurn>
  /** Release the session (SDK `dispose()`). */
  dispose(): Promise<void> | void
}

/** The injectable boundary: create a live session for one build phase. */
export type PiCreateSessionFn = (opts: {
  cwd: string
  model?: PiModelRef
  /** Built-in tools to activate. */
  tools: readonly string[]
  /** Named Pi extensions/packages this phase may use (§9). Matched
   * case-insensitively as substrings of installed package sources; their tools
   * are activated alongside `tools`. Empty ⇒ hermetic (builtins only). */
  extensions: readonly string[]
}) => Promise<PiSession>

// ── The single cast point (untested) ────────────────────────────────────────
//
// The real SDK is a hard dependency (package.json), but its message/event and
// model generics are heavy; the interop is kept here behind minimal local
// shapes so the rest of the adapter stays cleanly typed. Deliberately untested
// — tests inject a fake PiCreateSessionFn instead (offline).

/** Minimal shape of the SDK `message_update`/`text_delta` event we consume. */
interface PiTextDeltaEvent {
  type: string
  assistantMessageEvent?: { type: string; delta?: string }
}

/** Minimal shape of `getSessionStats().tokens`. */
interface PiTokens {
  input: number
  output: number
}

const piSdkCreateSession: PiCreateSessionFn = async (opts) => {
  let sdk: typeof import('@earendil-works/pi-coding-agent')
  try {
    sdk = await import('@earendil-works/pi-coding-agent')
  } catch (error) {
    throw new Error(
      `pi runtime: could not load the pi SDK ("@earendil-works/pi-coding-agent") — ` +
        `install it or inject a PiCreateSessionFn into PiAgentRunner (SPEC §9). ` +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const { createAgentSession, ModelRuntime, SessionManager, createBashToolDefinition } = sdk

  const modelRuntime = await ModelRuntime.create()
  let model: ReturnType<typeof modelRuntime.getModel> = undefined
  if (opts.model !== undefined) {
    model = modelRuntime.getModel(opts.model.provider, opts.model.id)
    if (model === undefined) {
      throw new Error(
        `pi runtime: model "${opts.model.provider}/${opts.model.id}" is not in Pi's ` +
          `catalog. Run \`ab models ${opts.model.id}\` to find the right id, and ensure ` +
          `the provider's credentials are configured.`,
      )
    }
  }

  // Env injected into every bash subprocess, swapped per turn via the closure
  // ref below (§10/D8). Overlaying onto ctx.env keeps the shell env Pi computes
  // and lets the scoped AB_* win.
  let injectedEnv: Record<string, string> = {}
  const bash = createBashToolDefinition(opts.cwd, {
    spawnHook: (ctx) => ({ ...ctx, env: { ...ctx.env, ...injectedEnv } }),
  })
  // The concrete bash ToolDefinition's detail generic doesn't match the
  // erased `customTools` element type; the registry only cares about the name
  // and executor, so widen at this cast point.
  const customTools = [bash] as unknown as NonNullable<
    Parameters<typeof createAgentSession>[0]
  >['customTools']

  // No `tools` allowlist here: an allowlist would suppress the user's installed
  // Pi packages (subagents, web-access, …). Instead we let the default path
  // discover packages, then activate exactly the base tools + the tools of the
  // allowlisted extensions (below). Our custom bash (same name) still shadows
  // the builtin so its spawnHook is what runs.
  const { session } = await createAgentSession({
    cwd: opts.cwd,
    modelRuntime,
    ...(model !== undefined ? { model } : {}),
    customTools,
    // In-memory: no session files written into the (git) build workspace.
    sessionManager: SessionManager.inMemory(opts.cwd),
  })

  // Activate the base tools plus the tools registered by allowlisted extension
  // packages; everything else (disallowed packages, MCP when not named) stays
  // inactive, so those capabilities are denied even though the package loaded.
  const allowed = opts.extensions.map((e) => e.toLowerCase())
  const extensionTools = session.getAllTools().filter((tool) => {
    const info = tool as { source?: { origin?: string; source?: string } }
    if (info.source?.origin !== 'package') return false
    const src = (info.source.source ?? '').toLowerCase()
    return allowed.some((name) => src.includes(name))
  })
  session.setActiveToolsByName([...opts.tools, ...extensionTools.map((t) => t.name)])

  // Assistant text streams as `text_delta`s; buffer per turn.
  let turnTexts: string[] = []
  session.subscribe((event) => {
    const e = event as PiTextDeltaEvent
    if (
      e.type === 'message_update' &&
      e.assistantMessageEvent?.type === 'text_delta' &&
      e.assistantMessageEvent.delta !== undefined
    ) {
      turnTexts.push(e.assistantMessageEvent.delta)
    }
  })

  const tokens = (): PiTokens => session.getSessionStats().tokens as PiTokens

  return {
    get sessionId() {
      return session.sessionId
    },
    async prompt(text, env) {
      injectedEnv = env
      turnTexts = []
      const before = tokens()
      await session.prompt(text)
      const after = tokens()
      return {
        text: turnTexts.join(''),
        usage: {
          inputTokens: Math.max(0, Math.round(after.input - before.input)),
          outputTokens: Math.max(0, Math.round(after.output - before.output)),
        },
      }
    },
    dispose() {
      session.dispose()
    },
  }
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
  session: PiSession
  turns: TurnRecord[]
}

export class PiAgentRunner implements AgentRunner {
  readonly name = 'pi'

  private readonly createSessionFn: PiCreateSessionFn
  private readonly sessions = new Map<string, SessionState>()

  constructor(opts: { createSessionFn?: PiCreateSessionFn } = {}) {
    this.createSessionFn = opts.createSessionFn ?? piSdkCreateSession
  }

  async start(
    opts: AgentStartOpts,
  ): Promise<{ session: AgentSessionHandle; result: AgentTurnResult }> {
    const model = opts.model !== undefined ? parsePiModel(opts.model) : undefined
    const session = await this.createSessionFn({
      cwd: opts.workspacePath,
      ...(model !== undefined ? { model } : {}),
      tools: PI_TOOLS,
      extensions: opts.extensions ?? [],
    })

    // Every phase skill takes only the build slug (§4).
    const prompt = `/${opts.skill} ${opts.buildSlug}`
    const turn = await session.prompt(prompt, this.turnEnv(opts.env))

    const handle: AgentSessionHandle = {
      id: session.sessionId,
      runner: this.name,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    }
    this.sessions.set(handle.id, {
      opts,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      session,
      turns: [{ turn: 1, prompt, text: turn.text, usage: turn.usage }],
    })
    return { session: handle, result: this.toResult(turn) }
  }

  async continue(
    session: AgentSessionHandle,
    message: string,
    opts?: AgentContinueOpts,
  ): Promise<AgentTurnResult> {
    const state = this.liveState(session, 'continue')
    // §10/D8: a continued turn refreshes the ambient env (new AB_PHASE round,
    // new AB_SESSION) merged over the start env, so the CLI — and the bash
    // subprocess it runs in — resolve THIS round, not round 1's stale identity.
    const scoped =
      opts?.env !== undefined ? { ...state.opts.env, ...opts.env } : state.opts.env
    const turn = await state.session.prompt(message, this.turnEnv(scoped))
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
    await state.session.dispose()

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

  /** Ambient process env (D8 base) with the scoped AB_* overlaid on top. */
  private turnEnv(scoped: Record<string, string>): Record<string, string> {
    return { ...ambientEnv(), ...scoped }
  }

  private liveState(session: AgentSessionHandle, op: 'continue' | 'end'): SessionState {
    const state = this.sessions.get(session.id)
    if (!state) {
      throw new Error(`${this.name}: ${op} on unknown session "${session.id}"`)
    }
    return state
  }

  private toResult(turn: PiTurn): AgentTurnResult {
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
