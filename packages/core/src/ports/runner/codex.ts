/**
 * CodexAgentRunner (SPEC §9): AgentRunner over the locally installed OpenAI
 * Codex CLI. Phase turns use Codex's JSONL exec protocol and native thread
 * resumption; non-phase judgments run as isolated, tool-free ephemeral turns.
 */
import type { StreamPart } from '../../store/streams/types'
import {
  agentInvocation,
  type AgentContinueOpts,
  type AgentRunner,
  type AgentSessionHandle,
  type AgentStartOpts,
  type AgentTurnFailure,
  type AgentTurnResult,
  type SessionStreamEmitter,
  type Transcript,
} from '../types'
import type { OneShotCompletion, OneShotCompletionInput, OneShotCompletionResult } from './one-shot'
import { classifyProviderError, configurationFailure, credentialFailure } from './provider-error'
import {
  abortPart,
  errorPart,
  finishPart,
  finishStepPart,
  promptPart,
  reasoningDeltaPart,
  reasoningEndPart,
  reasoningStartPart,
  startPart,
  startStepPart,
  textDeltaPart,
  textEndPart,
  textStartPart,
  toolInputPart,
  toolOutputPart,
} from './stream-parts'
import type { RuntimeUsabilityInput, RuntimeUsabilityResult } from './runtime'
import { sessionEnv } from './session-env'

export interface CodexCliInvocation {
  /** Arguments after the `codex` executable. */
  args: string[]
  cwd: string
  env: Record<string, string>
  signal?: AbortSignal
}

export interface CodexCliResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Injectable direct-process boundary used by deterministic adapter tests. */
export type CodexCliRunFn = (invocation: CodexCliInvocation) => Promise<CodexCliResult>

/** A streaming CLI turn: decoded JSONL lines as they arrive, plus the
 * completed result. The consumer accumulates the lines it needs. */
export interface CodexCliStreamHandle {
  lines: AsyncIterable<string>
  result: Promise<CodexCliResult>
}

/** Injectable streaming boundary: production spawns the same argv; tests
 * script line-at-a-time output. */
export type CodexCliStreamFn = (invocation: CodexCliInvocation) => CodexCliStreamHandle

const runCodexCli: CodexCliRunFn = async (invocation) => {
  const proc = Bun.spawn(['codex', ...invocation.args], {
    cwd: invocation.cwd,
    env: invocation.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    ...(invocation.signal !== undefined ? { signal: invocation.signal } : {}),
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

const runCodexCliStream: CodexCliStreamFn = (invocation) => {
  const proc = Bun.spawn(['codex', ...invocation.args], {
    cwd: invocation.cwd,
    env: invocation.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    ...(invocation.signal !== undefined ? { signal: invocation.signal } : {}),
  })
  const decoder = new LineDecoder()
  return {
    lines: decoder.lines(proc.stdout),
    result: (async () => {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { stdout, stderr, exitCode }
    })(),
  }
}

/** Incremental line decoder shared by the streaming path. */
class LineDecoder {
  private buffer = ''
  private readonly text = new TextDecoder()

  async *lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    for await (const chunk of stream) {
      this.buffer += this.text.decode(chunk, { stream: true })
      yield* this.drain()
    }
    this.buffer += this.text.decode()
    yield* this.drain()
    if (this.buffer.length > 0) yield this.buffer
  }

  private *drain(): Generator<string> {
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) break
      let line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length > 0) yield line
    }
  }
}

/** Verify both the local executable and Codex login for init suggestions. */
export async function isCodexRuntimeUsable(
  input: RuntimeUsabilityInput,
  runCli: CodexCliRunFn = runCodexCli,
): Promise<RuntimeUsabilityResult> {
  const env = Object.fromEntries(
    Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  try {
    const result = await runCli({ args: ['login', 'status'], cwd: input.cwd, env })
    return result.exitCode === 0
      ? { usable: true, reason: 'Codex CLI is installed and logged in' }
      : {
          usable: false,
          reason: result.stderr.trim() || result.stdout.trim() || 'Codex is not logged in',
        }
  } catch (error) {
    return {
      usable: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

interface JsonRecord {
  [key: string]: unknown
}

interface ParsedCodexOutput {
  events: JsonRecord[]
  malformedLines: string[]
  threadId?: string
  assistantText: string[]
  usage: { inputTokens: number; outputTokens: number }
  completed: boolean
  failureMessages: string[]
  statuses: number[]
  codes: Array<string | number>
  toolItems: string[]
}

interface CodexTurn {
  text: string
  usage: { inputTokens: number; outputTokens: number }
  failure?: AgentTurnFailure
  cli: CodexCliResult
  events: JsonRecord[]
  malformedLines: string[]
  threadId?: string
  toolItems: string[]
}

interface TurnRecord {
  turn: number
  prompt: string
  text: string
  usage: { inputTokens: number; outputTokens: number }
  failure?: AgentTurnFailure
  cli: CodexCliResult
  events: JsonRecord[]
  malformedLines: string[]
  threadId?: string
  toolItems: string[]
}

interface SessionState {
  opts: AgentStartOpts
  model?: string
  /** Absent when start failed before Codex emitted `thread.started`. */
  nativeThreadId?: string
  turns: TurnRecord[]
}

const CODEX_JSON_ARG = '--json'
const CODEX_MODEL_ARG = '--model'
const CODEX_MODEL_ALIAS = '-m'

/** Structural separator before Codex's positional prompt. */
export const CODEX_PROMPT_BOUNDARY = '--'

/** Options that select the model or the JSONL protocol parsed below. */
export const CODEX_OWNED_ARGS = [CODEX_JSON_ARG, CODEX_MODEL_ARG, CODEX_MODEL_ALIAS] as const

const MISSING_CLI_MESSAGE =
  'codex runtime: Codex CLI executable "codex" was not found. ' +
  'Install the Codex CLI (https://developers.openai.com/codex/cli), run `codex login`, ' +
  'and complete authentication before running Autobuild.'

const SHELL_ENV_INHERIT = 'shell_environment_policy.inherit=all'

/** Feature gates disabled for tool-free one-shot judgments. The isolated
 * invocation also ignores user config/rules and runs in a read-only sandbox;
 * emitted item kinds are still checked fail-closed for future Codex versions. */
const ONE_SHOT_DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'standalone_web_search',
  'apps',
  'plugins',
  'multi_agent',
  'multi_agent_v2',
  'image_generation',
  'computer_use',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
] as const

export class CodexAgentRunner implements AgentRunner, OneShotCompletion {
  readonly name = 'codex'

  private readonly runCli: CodexCliRunFn
  private readonly runCliStream: CodexCliStreamFn | undefined
  private readonly createSessionId: () => string
  private readonly sessions = new Map<string, SessionState>()

  constructor(
    opts: {
      runCli?: CodexCliRunFn
      runCliStream?: CodexCliStreamFn
      createSessionId?: () => string
    } = {},
  ) {
    this.runCli = opts.runCli ?? runCodexCli
    // A test injecting only the buffered boundary takes the buffered
    // translation path for streaming turns (degraded latency, same content);
    // production gets the live streaming boundary.
    this.runCliStream =
      opts.runCliStream ?? (opts.runCli !== undefined ? undefined : runCodexCliStream)
    this.createSessionId = opts.createSessionId ?? (() => crypto.randomUUID())
  }

  async complete(input: OneShotCompletionInput): Promise<OneShotCompletionResult> {
    const args = [
      'exec',
      CODEX_JSON_ARG,
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--sandbox',
      'read-only',
      // The legacy web_search feature gates emit deprecation warning items in
      // current Codex releases. This supported config value disables search
      // without making a healthy one-shot look like tool activity.
      '-c',
      'web_search="disabled"',
    ]
    for (const feature of ONE_SHOT_DISABLED_FEATURES) args.push('--disable', feature)
    if (input.model !== undefined) args.push(CODEX_MODEL_ARG, input.model)
    args.push(...(input.args ?? []), CODEX_PROMPT_BOUNDARY, input.prompt)

    const turn = await this.runPrompt({
      args,
      cwd: input.cwd,
      env: sessionEnv(input.env),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })
    if (turn.failure !== undefined) throw new Error(turn.failure.message)
    if (turn.toolItems.length > 0) {
      throw new Error(
        `codex runtime: tool-free completion emitted tool item(s): ${turn.toolItems.join(', ')}`,
      )
    }
    return { text: turn.text }
  }

  async start(
    opts: AgentStartOpts,
  ): Promise<{ session: AgentSessionHandle; result: AgentTurnResult }> {
    // Codex Agent Skills use `$name`, unlike Claude/Pi's slash invocation.
    const prompt = `$${opts.skill} ${agentInvocation(opts)}`
    const executed = await this.runTurn(prompt, opts)
    const turn: CodexTurn =
      executed.failure === undefined && executed.threadId === undefined
        ? {
            ...executed,
            failure: classifyProviderError(
              `${this.name} runtime: Codex CLI stream ended without a thread.started event`,
            ),
          }
        : executed
    const id = turn.threadId ?? this.createSessionId()
    const session: AgentSessionHandle = {
      id,
      runner: this.name,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    }
    this.sessions.set(id, {
      opts,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(turn.threadId !== undefined ? { nativeThreadId: turn.threadId } : {}),
      turns: [this.turnRecord(1, prompt, turn)],
    })
    return { session, result: this.toResult(turn) }
  }

  async continue(
    session: AgentSessionHandle,
    message: string,
    opts?: AgentContinueOpts,
  ): Promise<AgentTurnResult> {
    const state = this.liveState(session, 'continue')
    if (state.nativeThreadId === undefined) {
      throw new Error(
        `${this.name}: cannot continue session "${session.id}" because Codex start failed before thread.started`,
      )
    }
    const turnOpts =
      opts?.env !== undefined
        ? { ...state.opts, env: { ...state.opts.env, ...opts.env } }
        : state.opts
    const turn = await this.runTurn(message, turnOpts, state.nativeThreadId, opts?.signal)
    state.turns.push(this.turnRecord(state.turns.length + 1, message, turn))
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
          ...(state.nativeThreadId !== undefined ? { nativeThreadId: state.nativeThreadId } : {}),
          skill: state.opts.skill,
          invocation: agentInvocation(state.opts),
          ...(state.opts.buildSlug !== undefined ? { buildSlug: state.opts.buildSlug } : {}),
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

  private liveState(session: AgentSessionHandle, op: 'continue' | 'end'): SessionState {
    const state = this.sessions.get(session.id)
    if (state === undefined) {
      throw new Error(`${this.name}: ${op} on unknown session "${session.id}"`)
    }
    return state
  }

  private async runTurn(
    prompt: string,
    opts: AgentStartOpts,
    resume?: string,
    signal: AbortSignal | undefined = opts.signal,
  ): Promise<CodexTurn> {
    const args = ['exec']
    if (resume !== undefined) args.push('resume')
    args.push(
      CODEX_JSON_ARG,
      '--dangerously-bypass-approvals-and-sandbox',
      '--config',
      SHELL_ENV_INHERIT,
    )
    if (opts.model !== undefined) args.push(CODEX_MODEL_ARG, opts.model)
    args.push(...(opts.args ?? []))
    if (resume !== undefined) args.push(resume)
    args.push(CODEX_PROMPT_BOUNDARY, prompt)
    const invocation: CodexCliInvocation = {
      args,
      cwd: opts.workspacePath,
      env: sessionEnv(opts.env),
      ...(signal !== undefined ? { signal } : {}),
    }
    if (opts.stream === undefined) return this.runPrompt(invocation)

    // Streaming turn: translate while the CLI runs. Without an injected
    // streaming boundary (offline fakes), the buffered path still translates
    // after completion — degraded latency, same content.
    const emitter = opts.stream
    emitter.append([promptPart(prompt), startPart(crypto.randomUUID())])
    let turn: CodexTurn
    if (this.runCliStream !== undefined) {
      turn = await this.runStreamingPrompt(invocation, emitter)
    } else {
      turn = await this.runPrompt(invocation)
      translateBufferedCodexTurn(turn, (parts) => emitter.append(parts))
    }
    this.emitTurnEnd(turn, emitter, signal)
    return turn
  }

  /** Completed-turn, failed-turn, and cancelled-turn closing parts. */
  private emitTurnEnd(
    turn: CodexTurn,
    emitter: SessionStreamEmitter,
    signal: AbortSignal | undefined,
  ): void {
    if (turn.failure === undefined) {
      emitter.append([finishPart()])
      return
    }
    if (signal?.aborted) {
      const reason = signal.reason
      emitter.append([
        abortPart(reason instanceof Error ? reason.message : 'codex runtime: turn aborted'),
      ])
      return
    }
    emitter.append([errorPart(turn.failure.message)])
  }

  /** Live translation path: consume JSONL lines as they arrive while the
   * same records feed the ordinary accumulators. */
  private async runStreamingPrompt(
    invocation: CodexCliInvocation,
    emitter: SessionStreamEmitter,
  ): Promise<CodexTurn> {
    let handle: CodexCliStreamHandle
    try {
      handle = this.runCliStream!(invocation)
    } catch (error) {
      return launchFailure(error)
    }
    const acc = new CodexOutputAccumulator()
    const translator = createCodexStreamTranslator((parts) => emitter.append(parts))
    try {
      for await (const line of handle.lines) {
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          acc.push(line)
          continue
        }
        if (!isRecord(value)) {
          acc.push(line)
          continue
        }
        acc.pushRecord(value)
        translator.onEvent(value)
      }
    } catch {
      // The result promise below still carries the CLI's exit and stderr.
    }
    const cli = await handle.result
    return this.finishTurn(cli, acc.snapshot())
  }

  private async runPrompt(invocation: CodexCliInvocation): Promise<CodexTurn> {
    let cli: CodexCliResult
    try {
      cli = await this.runCli(invocation)
    } catch (error) {
      return launchFailure(error)
    }
    return this.finishTurn(cli, parseCodexOutput(cli.stdout))
  }

  /** Shared post-processing of a completed CLI run. */
  private finishTurn(cli: CodexCliResult, parsed: ParsedCodexOutput): CodexTurn {
    const text = parsed.assistantText.join('\n')
    let failureMessage: string | undefined
    let loggedOut = false
    if (cli.exitCode !== 0 || parsed.failureMessages.length > 0) {
      const provider = parsed.failureMessages.find((message) => message.length > 0)
      const stderr = nonempty(cli.stderr)
      const detail = provider ?? stderr
      loggedOut = detail !== undefined && looksLoggedOut(detail)
      if (loggedOut) {
        failureMessage =
          `codex runtime: Codex CLI executable "codex" is not authenticated. ` +
          `Run \`codex login\` and complete authentication. ${detail}`
      } else {
        failureMessage =
          detail ??
          `${this.name} runtime: Codex CLI exited with code ${cli.exitCode} without error text`
      }
    } else if (parsed.malformedLines.length > 0) {
      failureMessage = `${this.name} runtime: Codex CLI emitted malformed JSONL output`
    } else if (!parsed.completed) {
      failureMessage = `${this.name} runtime: Codex CLI stream ended without a turn.completed event`
    }

    return {
      text,
      usage: parsed.usage,
      ...(failureMessage !== undefined
        ? {
            failure: loggedOut
              ? credentialFailure(failureMessage)
              : classifyProviderError(failureMessage, {
                  status: parsed.statuses[0],
                  codes: parsed.codes,
                }),
          }
        : {}),
      cli,
      events: parsed.events,
      malformedLines: parsed.malformedLines,
      ...(parsed.threadId !== undefined ? { threadId: parsed.threadId } : {}),
      toolItems: parsed.toolItems,
    }
  }

  private turnRecord(turnNumber: number, prompt: string, turn: CodexTurn): TurnRecord {
    return {
      turn: turnNumber,
      prompt,
      text: turn.text,
      usage: turn.usage,
      ...(turn.failure !== undefined ? { failure: turn.failure } : {}),
      cli: turn.cli,
      events: turn.events,
      malformedLines: turn.malformedLines,
      ...(turn.threadId !== undefined ? { threadId: turn.threadId } : {}),
      toolItems: turn.toolItems,
    }
  }

  private toResult(turn: CodexTurn): AgentTurnResult {
    const base = { text: turn.text, usage: { ...turn.usage, turns: 1 } }
    return turn.failure === undefined
      ? { kind: 'completed', ...base }
      : { kind: 'failed', ...base, failure: turn.failure }
  }
}

function parseCodexOutput(stdout: string): ParsedCodexOutput {
  const acc = new CodexOutputAccumulator()
  for (const line of stdout.split(/\r?\n/)) acc.push(line)
  return acc.snapshot()
}

/**
 * Incremental accumulator over Codex's JSONL exec protocol, shared by the
 * buffered parse and the streaming path (which also feeds the stream
 * translator below). Collects the same shape `parseCodexOutput` always
 * returned so outcome classification is byte-identical in both paths.
 */
class CodexOutputAccumulator {
  readonly events: JsonRecord[] = []
  readonly malformedLines: string[] = []
  readonly assistantText: string[] = []
  readonly failureMessages: string[] = []
  readonly statuses: number[] = []
  readonly codes: Array<string | number> = []
  readonly toolItems: string[] = []
  usage = { inputTokens: 0, outputTokens: 0 }
  completed = false
  threadId: string | undefined

  push(line: string): void {
    if (line.trim() === '') return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      this.malformedLines.push(line)
      return
    }
    if (!isRecord(value)) {
      this.malformedLines.push(line)
      return
    }
    this.pushRecord(value)
  }

  pushRecord(value: JsonRecord): void {
    this.events.push(value)

    if (value.type === 'thread.started') {
      const id = stringField(value, 'thread_id') ?? stringField(value, 'threadId')
      if (id !== undefined && id.length > 0) this.threadId = id
    }

    if (value.type === 'item.completed' || value.type === 'item.started') {
      const item = isRecord(value.item) ? value.item : undefined
      const itemType = stringField(item, 'type')
      if (value.type === 'item.completed' && itemType === 'agent_message') {
        const text = itemText(item)
        if (text !== undefined) this.assistantText.push(text)
      }
      // Codex represents non-fatal warnings/deprecation notices as `error`
      // thread items. They are transcript evidence, not executed tools. Every
      // other unknown item remains fail-closed so newly added capabilities
      // cannot silently weaken one-shot isolation.
      if (
        itemType !== undefined &&
        itemType !== 'agent_message' &&
        itemType !== 'reasoning' &&
        itemType !== 'error'
      ) {
        this.toolItems.push(itemType)
      }
    }

    if (value.type === 'turn.completed') {
      this.completed = true
      const usage = isRecord(value.usage) ? value.usage : undefined
      this.usage = {
        inputTokens: tokenCount(usage?.input_tokens ?? usage?.inputTokens),
        outputTokens: tokenCount(usage?.output_tokens ?? usage?.outputTokens),
      }
    }

    if (value.type === 'turn.failed' || value.type === 'error') {
      const nested = isRecord(value.error) ? value.error : undefined
      const message =
        stringField(nested, 'message') ??
        stringField(value, 'message') ??
        stringField(value, 'error')
      if (message !== undefined) this.failureMessages.push(message)
      collectHints(value, this)
      if (nested !== undefined) collectHints(nested, this)
    }
  }

  snapshot(): ParsedCodexOutput {
    return {
      events: [...this.events],
      malformedLines: [...this.malformedLines],
      ...(this.threadId !== undefined ? { threadId: this.threadId } : {}),
      assistantText: [...this.assistantText],
      usage: { ...this.usage },
      completed: this.completed,
      failureMessages: [...this.failureMessages],
      statuses: [...this.statuses],
      codes: [...this.codes],
      toolItems: [...this.toolItems],
    }
  }
}

function itemText(item: JsonRecord | undefined): string | undefined {
  const direct = stringField(item, 'text')
  if (direct !== undefined) return direct
  const content = item?.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    const text = stringField(block, 'text')
    if (text !== undefined) parts.push(text)
  }
  return parts.length > 0 ? parts.join('') : undefined
}

function collectHints(value: JsonRecord, acc: CodexOutputAccumulator): void {
  for (const key of ['status', 'status_code', 'statusCode']) {
    const status = value[key]
    if (typeof status === 'number' && Number.isFinite(status)) acc.statuses.push(status)
  }
  for (const key of ['code', 'type', 'category']) {
    const code = value[key]
    if (typeof code === 'string' || typeof code === 'number') acc.codes.push(code)
  }
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: JsonRecord | undefined, key: string): string | undefined {
  const field = value?.[key]
  return typeof field === 'string' ? field : undefined
}

function nonempty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

function looksLoggedOut(message: string): boolean {
  return /not logged in|not authenticated|codex login|authentication required/i.test(message)
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A CLI that never ran: missing executable vs. a failed launch. */
function launchFailure(error: unknown): CodexTurn {
  const missing = isEnoent(error)
  const message = missing
    ? MISSING_CLI_MESSAGE
    : `codex runtime: failed to launch Codex CLI executable "codex": ${errorText(error)}`
  return {
    text: '',
    usage: { inputTokens: 0, outputTokens: 0 },
    failure: missing ? configurationFailure(message) : classifyProviderError(message),
    cli: { stdout: '', stderr: errorText(error), exitCode: -1 },
    events: [],
    malformedLines: [],
    toolItems: [],
  }
}

/**
 * Live stream translation (SPEC §9): turn.started → start-step; tool-shaped
 * item.started → tool-input-available; item.completed → tool output, whole
 * agent-message text, or reasoning parts; item.updated → text deltas when it
 * carries incremental text. Unrecognized records produce no parts.
 *
 * Items without an `id` still correlate across started/updated/completed:
 * each item kind's events arrive sequentially, so a stable per-kind key is
 * assigned when the item is first seen and reused until the item completes.
 */
function createCodexStreamTranslator(emit: (parts: StreamPart[]) => void): {
  onEvent(event: JsonRecord): void
} {
  const openText = new Set<string>()
  const keys = createItemKeyTracker()
  const itemKey = keys.keyFor

  return {
    onEvent(event) {
      switch (event.type) {
        case 'turn.started':
          emit([startStepPart()])
          break
        case 'item.started': {
          const item = isRecord(event.item) ? event.item : undefined
          const itemType = stringField(item, 'type')
          // agent_message/reasoning items stream at item.updated/item.completed;
          // a bare item.started opens nothing yet (the first delta does).
          if (itemType === undefined || itemType === 'agent_message' || itemType === 'reasoning') {
            break
          }
          emit([toolInputPart(itemKey(item, itemType), itemType, itemCommand(item) ?? item)])
          break
        }
        case 'item.updated': {
          const item = isRecord(event.item) ? event.item : undefined
          if (item === undefined) break
          if (stringField(item, 'type') !== 'agent_message') break
          const delta = itemText(item)
          if (delta === undefined || delta.length === 0) break
          const id = itemKey(item, 'agent_message')
          if (!openText.has(id)) emit([textStartPart(id)])
          openText.add(id)
          emit([textDeltaPart(id, delta)])
          break
        }
        case 'item.completed': {
          const item = isRecord(event.item) ? event.item : undefined
          const itemType = stringField(item, 'type')
          if (itemType === 'agent_message') {
            const id = itemKey(item, itemType)
            const text = itemText(item)
            if (openText.has(id)) {
              emit([textEndPart(id)])
              openText.delete(id)
            } else if (text !== undefined && text.length > 0) {
              emit([textStartPart(id), textDeltaPart(id, text), textEndPart(id)])
            }
            keys.complete(item, itemType)
            break
          }
          if (itemType === 'reasoning') {
            const id = itemKey(item, itemType)
            const text = itemText(item)
            if (text !== undefined && text.length > 0) {
              emit([reasoningStartPart(id), reasoningDeltaPart(id, text), reasoningEndPart(id)])
            }
            keys.complete(item, itemType)
            break
          }
          if (itemType === undefined) break
          emit([toolOutputPart(itemKey(item, itemType), itemCommand(item) ?? item)])
          keys.complete(item, itemType)
          break
        }
        case 'turn.completed':
          keys.clear()
          emit([finishStepPart()])
          break
        default:
          break
      }
    },
  }
}

/** Codex items carry their human-readable payload in `command`/`input`. */
function itemCommand(item: JsonRecord | undefined): unknown {
  const command = item?.command
  if (typeof command === 'string') return command
  const input = item?.input
  if (input !== undefined) return input
  return undefined
}

/**
 * Stable per-item keys (SPEC §9 translation): items carrying an `id` key by
 * it; items without one key by kind and occurrence — each kind's events
 * arrive sequentially, so the slot assigned when the item is first seen is
 * reused until it completes, and a per-turn reset frees the counters.
 */
function createItemKeyTracker(): {
  keyFor(item: JsonRecord | undefined, itemType: string | undefined): string
  complete(item: JsonRecord | undefined, itemType: string | undefined): void
  clear(): void
} {
  const counters = new Map<string, number>()
  const lastIdless = new Map<string, string>()
  return {
    keyFor(item, itemType) {
      const id = stringField(item, 'id')
      if (id !== undefined && id.length > 0) return id
      const kind = itemType ?? 'item'
      const known = lastIdless.get(kind)
      if (known !== undefined) return known
      const n = (counters.get(kind) ?? 0) + 1
      counters.set(kind, n)
      const key = `cx-${kind}-${n}`
      lastIdless.set(kind, key)
      return key
    },
    /** An id-less item's kind slot frees up when the item completes. */
    complete(item, itemType) {
      if (stringField(item, 'id') === undefined) lastIdless.delete(itemType ?? 'item')
    },
    clear() {
      lastIdless.clear()
    },
  }
}

/**
 * Buffered-path translation (degraded latency, same content): walk the
 * completed turn's events and emit whole messages — start-step/finish-step
 * around the turn, text/reasoning parts from items, and tool input/output
 * from non-message items.
 */
function translateBufferedCodexTurn(turn: CodexTurn, emit: (parts: StreamPart[]) => void): void {
  const keys = createItemKeyTracker()
  emit([startStepPart()])
  for (const event of turn.events) {
    if (event.type !== 'item.completed' && event.type !== 'item.started') continue
    const item = isRecord(event.item) ? event.item : undefined
    const itemType = stringField(item, 'type')
    if (itemType === 'agent_message' && event.type === 'item.completed') {
      const text = itemText(item)
      if (text !== undefined && text.length > 0) {
        const id = keys.keyFor(item, itemType)
        emit([textStartPart(id), textDeltaPart(id, text), textEndPart(id)])
      }
      keys.complete(item, itemType)
    } else if (itemType === 'reasoning' && event.type === 'item.completed') {
      const text = itemText(item)
      if (text !== undefined && text.length > 0) {
        const id = keys.keyFor(item, itemType)
        emit([reasoningStartPart(id), reasoningDeltaPart(id, text), reasoningEndPart(id)])
      }
      keys.complete(item, itemType)
    } else if (itemType !== undefined && itemType !== 'agent_message' && itemType !== 'reasoning') {
      // Mirror the live mapping: input at item.started, output at completed.
      const id = keys.keyFor(item, itemType)
      if (event.type === 'item.started')
        emit([toolInputPart(id, itemType, itemCommand(item) ?? item)])
      else emit([toolOutputPart(id, itemCommand(item) ?? item)])
      if (event.type === 'item.completed') keys.complete(item, itemType)
    }
  }
  emit([finishStepPart()])
}
