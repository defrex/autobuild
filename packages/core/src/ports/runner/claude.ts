/**
 * ClaudeAgentRunner (SPEC §9): AgentRunner over the locally installed Claude
 * Code CLI. Each turn runs `claude -p` with structured streaming output;
 * Claude Code's native session ids preserve context across review rounds.
 *
 * The subprocess sits behind an injectable boundary so normal tests stay
 * deterministic and offline. Production uses direct argv (never a shell),
 * inherits the operator's Claude Code login, and receives a fresh `sessionEnv`
 * on every turn so the current scoped Autobuild identity reaches tool calls.
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
import { classifyProviderError, configurationFailure } from './provider-error'
import { sessionEnv } from './session-env'
import type { OneShotCompletion, OneShotCompletionInput, OneShotCompletionResult } from './one-shot'
import type { RuntimeUsabilityInput, RuntimeUsabilityResult } from './runtime'

export interface ClaudeCliInvocation {
  /** Arguments after the `claude` executable. */
  args: string[]
  cwd: string
  env: Record<string, string>
  signal?: AbortSignal
}

export interface ClaudeCliResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Injectable direct-process boundary used by the offline contract suite. */
export type ClaudeCliRunFn = (invocation: ClaudeCliInvocation) => Promise<ClaudeCliResult>

/** A streaming CLI turn: decoded stdout lines as they arrive, plus the
 * completed result. The consumer accumulates the lines it needs. */
export interface ClaudeCliStreamHandle {
  lines: AsyncIterable<string>
  result: Promise<ClaudeCliResult>
}

/** Injectable streaming boundary: production spawns with
 * `--include-partial-messages` (the adapter adds that flag when a turn
 * carries an emitter); tests script line-at-a-time output. */
export type ClaudeCliStreamFn = (invocation: ClaudeCliInvocation) => ClaudeCliStreamHandle

const runClaudeCli: ClaudeCliRunFn = async (invocation) => {
  const proc = Bun.spawn(['claude', ...invocation.args], {
    cwd: invocation.cwd,
    env: invocation.env,
    // The positional prompt is the turn's only input. Claude Code also reads
    // non-TTY stdin in print mode, so inheriting a supervisor's pipe could
    // inject unrelated bytes into the conversation or delay process exit.
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

const runClaudeCliStream: ClaudeCliStreamFn = (invocation) => {
  const proc = Bun.spawn(['claude', ...invocation.args], {
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

/** Verify both the local executable and Claude Code login for init suggestions. */
export async function isClaudeRuntimeUsable(
  input: RuntimeUsabilityInput,
  runCli: ClaudeCliRunFn = runClaudeCli,
): Promise<RuntimeUsabilityResult> {
  const env = Object.fromEntries(
    Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  try {
    const result = await runCli({ args: ['auth', 'status', '--json'], cwd: input.cwd, env })
    if (result.exitCode !== 0) {
      return { usable: false, reason: result.stderr.trim() || 'Claude Code is not logged in' }
    }
    let status: unknown
    try {
      status = JSON.parse(result.stdout)
    } catch {
      return { usable: false, reason: 'Claude auth status returned malformed JSON' }
    }
    return isRecord(status) && status.loggedIn === true
      ? { usable: true, reason: 'Claude Code is installed and logged in' }
      : { usable: false, reason: 'Claude Code is not logged in' }
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

interface ParsedCliOutput {
  events: JsonRecord[]
  malformedLines: string[]
  result?: JsonRecord
  assistantText: string[]
  assistantErrors: string[]
  statuses: number[]
  codes: Array<string | number>
}

interface ClaudeTurn {
  text: string
  usage: { inputTokens: number; outputTokens: number }
  failure?: AgentTurnFailure
  cli: ClaudeCliResult
  events: JsonRecord[]
  malformedLines: string[]
}

interface TurnRecord {
  turn: number
  prompt: string
  text: string
  usage: { inputTokens: number; outputTokens: number }
  failure?: AgentTurnFailure
  cli: ClaudeCliResult
  events: JsonRecord[]
  malformedLines: string[]
}

interface SessionState {
  opts: AgentStartOpts
  model?: string
  turns: TurnRecord[]
}

const CLAUDE_PRINT_ARG = '-p'
const CLAUDE_PRINT_ALIAS = '--print'
const CLAUDE_OUTPUT_FORMAT_ARG = '--output-format'
const CLAUDE_MODEL_ARG = '--model'
const CLAUDE_INCLUDE_PARTIAL_ARG = '--include-partial-messages'

/** Structural separator before Claude's positional prompt. */
export const CLAUDE_PROMPT_BOUNDARY = '--'

/** Options that select the model or the structured protocol parsed below. */
export const CLAUDE_OWNED_ARGS = [
  CLAUDE_PRINT_ARG,
  CLAUDE_PRINT_ALIAS,
  CLAUDE_OUTPUT_FORMAT_ARG,
  CLAUDE_MODEL_ARG,
] as const

const MISSING_CLI_MESSAGE =
  'claude runtime: Claude Code CLI executable "claude" was not found. ' +
  'Install Claude Code (https://code.claude.com/docs/en/setup), run `claude`, ' +
  'and complete login before running Autobuild.'

export class ClaudeAgentRunner implements AgentRunner, OneShotCompletion {
  readonly name = 'claude'

  private readonly runCli: ClaudeCliRunFn
  private readonly runCliStream: ClaudeCliStreamFn | undefined
  private readonly createSessionId: () => string
  private readonly sessions = new Map<string, SessionState>()

  constructor(
    opts: {
      runCli?: ClaudeCliRunFn
      runCliStream?: ClaudeCliStreamFn
      createSessionId?: () => string
    } = {},
  ) {
    this.runCli = opts.runCli ?? runClaudeCli
    this.runCliStream = opts.runCliStream ?? runClaudeCliStream
    this.createSessionId = opts.createSessionId ?? (() => crypto.randomUUID())
  }

  /** Non-phase judgment: one verbatim prompt, one tool-free completion, and no
   * resumable session persistence. With no built-in or MCP tools, the single
   * print-mode prompt cannot enter a tool-result loop. */
  async complete(input: OneShotCompletionInput): Promise<OneShotCompletionResult> {
    const args = this.baseArgs()
    args.push('--tools', '', '--disallowedTools', 'mcp__*', '--no-session-persistence')
    if (input.model !== undefined) args.push(CLAUDE_MODEL_ARG, input.model)
    args.push(...(input.args ?? []), CLAUDE_PROMPT_BOUNDARY, input.prompt)

    const turn = await this.runPrompt({
      args,
      cwd: input.cwd,
      env: sessionEnv(input.env),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })
    if (turn.failure !== undefined) throw new Error(turn.failure.message)
    return { text: turn.text }
  }

  async start(
    opts: AgentStartOpts,
  ): Promise<{ session: AgentSessionHandle; result: AgentTurnResult }> {
    const sessionId = this.createSessionId()
    const prompt = `/${opts.skill} ${agentInvocation(opts)}`
    const turn = await this.runTurn(prompt, opts, { sessionId })

    const session: AgentSessionHandle = {
      id: sessionId,
      runner: this.name,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    }
    this.sessions.set(session.id, {
      opts,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
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
    // §10/D8: a continued turn gets this round's AB_PHASE/AB_SESSION while
    // retaining start-only values. A fresh process env is built below.
    const turnOpts =
      opts?.env !== undefined
        ? { ...state.opts, env: { ...state.opts.env, ...opts.env } }
        : state.opts
    const turn = await this.runTurn(message, turnOpts, { resume: session.id }, opts?.signal)
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
    if (!state) {
      throw new Error(`${this.name}: ${op} on unknown session "${session.id}"`)
    }
    return state
  }

  private async runTurn(
    prompt: string,
    opts: AgentStartOpts,
    session: { sessionId: string } | { resume: string },
    signal: AbortSignal | undefined = opts.signal,
  ): Promise<ClaudeTurn> {
    const args = this.baseArgs()
    if ('sessionId' in session) args.push('--session-id', session.sessionId)
    else args.push('--resume', session.resume)
    if (opts.model !== undefined) args.push(CLAUDE_MODEL_ARG, opts.model)
    // Partial message chunks only exist with the streaming flag; a turn
    // without an emitter never asks for them.
    if (opts.stream !== undefined) args.push(CLAUDE_INCLUDE_PARTIAL_ARG)
    args.push(...(opts.args ?? []), CLAUDE_PROMPT_BOUNDARY, prompt)

    const invocation: ClaudeCliInvocation = {
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
    let turn: ClaudeTurn
    if (this.runCliStream !== undefined) {
      turn = await this.runStreamingPrompt(invocation, emitter)
    } else {
      turn = await this.runPrompt(invocation)
      translateBufferedClaudeTurn(turn, (parts) => emitter.append(parts))
    }
    this.emitTurnEnd(turn, emitter, signal)
    return turn
  }

  /** Completed-turn, failed-turn, and cancelled-turn closing parts. */
  private emitTurnEnd(
    turn: ClaudeTurn,
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
        abortPart(reason instanceof Error ? reason.message : 'claude runtime: turn aborted'),
      ])
      return
    }
    emitter.append([errorPart(turn.failure.message)])
  }

  private baseArgs(): string[] {
    return [
      CLAUDE_PRINT_ARG,
      CLAUDE_OUTPUT_FORMAT_ARG,
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ]
  }

  private async runPrompt(invocation: ClaudeCliInvocation): Promise<ClaudeTurn> {
    let cli: ClaudeCliResult
    try {
      cli = await this.runCli(invocation)
    } catch (error) {
      return launchFailure(error)
    }
    return this.finishTurn(cli, parseCliOutput(cli.stdout))
  }

  /** Live translation path: consume stdout lines as they arrive, mapping
   * `stream_event` chunks onto the part vocabulary while the same records
   * feed the ordinary accumulators (so outcome classification is identical). */
  private async runStreamingPrompt(
    invocation: ClaudeCliInvocation,
    emitter: SessionStreamEmitter,
  ): Promise<ClaudeTurn> {
    let handle: ClaudeCliStreamHandle
    try {
      handle = this.runCliStream!(invocation)
    } catch (error) {
      return launchFailure(error)
    }
    const acc = new ClaudeOutputAccumulator()
    const translator = createClaudeStreamTranslator((parts) => emitter.append(parts))
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
    const parsed = acc.snapshot()
    // Fail open against a harness that ignored the partial-messages flag: if
    // nothing streamed, translate the buffered events instead.
    if (!translator.streamedAnything()) {
      const turn = this.finishTurn(cli, parsed)
      translateBufferedClaudeTurn(turn, (parts) => emitter.append(parts))
      return turn
    }
    return this.finishTurn(cli, parsed)
  }

  /** Shared post-processing of a completed CLI run: text, usage, failure
   * classification. Identical for the buffered and streaming paths. */
  private finishTurn(cli: ClaudeCliResult, parsed: ParsedCliOutput): ClaudeTurn {
    const usage = resultUsage(parsed.result)
    const resultText = stringField(parsed.result, 'result')
    const text = resultText ?? parsed.assistantText.join('\n')

    let failureMessage: string | undefined
    if (cli.exitCode !== 0 || parsed.result?.is_error === true) {
      failureMessage =
        nonempty(resultText) ??
        firstStringArray(parsed.result?.errors) ??
        nonempty(stringField(parsed.result, 'error')) ??
        parsed.assistantErrors.find((value) => value.length > 0) ??
        nonempty(cli.stderr) ??
        `${this.name} runtime: Claude Code CLI exited with code ${cli.exitCode} without error text`
    } else if (parsed.malformedLines.length > 0) {
      failureMessage = `${this.name} runtime: Claude Code CLI emitted malformed stream-json output`
    } else if (parsed.result === undefined) {
      failureMessage = `${this.name} runtime: Claude Code CLI stream ended without a result event`
    }

    const resultStatus = numberField(
      parsed.result,
      'api_error_status',
      'status',
      'status_code',
      'statusCode',
    )
    const resultCodes = [
      stringOrNumberField(parsed.result, 'error'),
      stringOrNumberField(parsed.result, 'code'),
      stringOrNumberField(parsed.result, 'category'),
      stringOrNumberField(parsed.result, 'subtype'),
      ...parsed.codes,
    ]

    return {
      text,
      usage,
      ...(failureMessage !== undefined
        ? {
            failure: classifyProviderError(failureMessage, {
              status: resultStatus ?? parsed.statuses[0],
              codes: [...parsed.assistantErrors, ...resultCodes],
            }),
          }
        : {}),
      cli,
      events: parsed.events,
      malformedLines: parsed.malformedLines,
    }
  }

  private turnRecord(turnNumber: number, prompt: string, turn: ClaudeTurn): TurnRecord {
    return {
      turn: turnNumber,
      prompt,
      text: turn.text,
      usage: turn.usage,
      ...(turn.failure !== undefined ? { failure: turn.failure } : {}),
      cli: turn.cli,
      events: turn.events,
      malformedLines: turn.malformedLines,
    }
  }

  private toResult(turn: ClaudeTurn): AgentTurnResult {
    const base = { text: turn.text, usage: { ...turn.usage, turns: 1 } }
    return turn.failure === undefined
      ? { kind: 'completed', ...base }
      : { kind: 'failed', ...base, failure: turn.failure }
  }
}

function parseCliOutput(stdout: string): ParsedCliOutput {
  const acc = new ClaudeOutputAccumulator()
  for (const line of stdout.split(/\r?\n/)) acc.push(line)
  return acc.snapshot()
}

/**
 * Incremental accumulator over Claude Code's stream-json lines, shared by
 * the buffered parse and the streaming path (which also feeds the stream
 * translator below). Collects the same shape `parseCliOutput` always
 * returned so outcome classification is byte-identical in both paths.
 */
class ClaudeOutputAccumulator {
  readonly events: JsonRecord[] = []
  readonly malformedLines: string[] = []
  readonly assistantText: string[] = []
  readonly assistantErrors: string[] = []
  readonly statuses: number[] = []
  readonly codes: Array<string | number> = []
  result: JsonRecord | undefined

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
    if (value.type === 'assistant') collectAssistant(value, this)
    if (value.type === 'result') this.result = value
    if (value.type === 'system' || value.type === 'api_retry') collectHints(value, this)
  }

  snapshot(): ParsedCliOutput {
    return {
      events: [...this.events],
      malformedLines: [...this.malformedLines],
      ...(this.result !== undefined ? { result: this.result } : {}),
      assistantText: [...this.assistantText],
      assistantErrors: [...this.assistantErrors],
      statuses: [...this.statuses],
      codes: [...this.codes],
    }
  }
}

function collectAssistant(event: JsonRecord, acc: ClaudeOutputAccumulator): void {
  const error = stringField(event, 'error')
  if (error !== undefined) acc.assistantErrors.push(error)
  const message = event.message
  if (!isRecord(message) || !Array.isArray(message.content)) return
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== 'text') continue
    const text = stringField(block, 'text')
    if (text !== undefined) acc.assistantText.push(text)
  }
}

function collectHints(event: JsonRecord, acc: ClaudeOutputAccumulator): void {
  const status = numberField(event, 'api_error_status', 'status', 'status_code', 'statusCode')
  if (status !== undefined) acc.statuses.push(status)
  for (const key of ['code', 'error', 'category', 'subtype']) {
    const code = stringOrNumberField(event, key)
    if (code !== undefined) acc.codes.push(code)
  }
}

function resultUsage(result: JsonRecord | undefined): ClaudeTurn['usage'] {
  const usage = result?.usage
  if (!isRecord(usage)) return { inputTokens: 0, outputTokens: 0 }
  return {
    inputTokens: tokenCount(usage.input_tokens),
    outputTokens: tokenCount(usage.output_tokens),
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

function stringOrNumberField(
  value: JsonRecord | undefined,
  key: string,
): string | number | undefined {
  const field = value?.[key]
  return typeof field === 'string' || typeof field === 'number' ? field : undefined
}

function numberField(value: JsonRecord | undefined, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const field = value?.[key]
    if (typeof field === 'number' && Number.isFinite(field)) return field
  }
  return undefined
}

function firstStringArray(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  )
  return strings.length > 0 ? strings.join('\n') : undefined
}

function nonempty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

function isEnoent(error: unknown): boolean {
  if (!isRecord(error)) return false
  return error.code === 'ENOENT'
}

/** A CLI that never ran: missing executable vs. a failed launch. */
function launchFailure(error: unknown): ClaudeTurn {
  const missing = isEnoent(error)
  const message = missing
    ? MISSING_CLI_MESSAGE
    : `claude runtime: failed to launch Claude Code CLI: ${errorText(error)}`
  return {
    text: '',
    usage: { inputTokens: 0, outputTokens: 0 },
    failure: missing ? configurationFailure(message) : classifyProviderError(message),
    cli: {
      stdout: '',
      stderr: errorText(error),
      exitCode: -1,
    },
    events: [],
    malformedLines: [],
  }
}

/**
 * Live stream translation (SPEC §9): `stream_event` chunks carry the raw
 * Anthropic stream; `assistant`/`user` lines still feed the accumulators and
 * surface tool_use blocks the stream events did not (fail-open against
 * harness drift). Unrecognized records produce no parts.
 */
function createClaudeStreamTranslator(emit: (parts: StreamPart[]) => void): {
  onEvent(event: JsonRecord): void
  streamedAnything(): boolean
} {
  let nextId = 0
  let streamed = false
  let messageOpen = false
  const blocks = new Map<
    number,
    { kind: 'text' | 'thinking' | 'tool'; id: string; name?: string; json: string }
  >()
  const emittedTools = new Set<string>()

  return {
    streamedAnything() {
      return streamed
    },
    onEvent(event) {
      if (event.type === 'stream_event') {
        const inner = isRecord(event.event) ? event.event : undefined
        if (inner === undefined) return
        const index = typeof inner.index === 'number' ? inner.index : -1
        switch (inner.type) {
          case 'message_start':
            if (!messageOpen) {
              messageOpen = true
              streamed = true
              emit([startStepPart()])
            }
            break
          case 'content_block_start': {
            const block = isRecord(inner.content_block) ? inner.content_block : {}
            const id =
              typeof block.id === 'string' && block.id.length > 0 ? block.id : `cl-${++nextId}`
            if (block.type === 'text') {
              blocks.set(index, { kind: 'text', id, json: '' })
              streamed = true
              emit([textStartPart(id)])
            } else if (block.type === 'thinking') {
              blocks.set(index, { kind: 'thinking', id, json: '' })
              streamed = true
              emit([reasoningStartPart(id)])
            } else if (block.type === 'tool_use') {
              blocks.set(index, {
                kind: 'tool',
                id,
                name: typeof block.name === 'string' ? block.name : 'tool',
                json: '',
              })
            }
            break
          }
          case 'content_block_delta': {
            const block = blocks.get(index)
            const delta = isRecord(inner.delta) ? inner.delta : {}
            if (block === undefined) break
            if (block.kind === 'text' && typeof delta.text === 'string') {
              streamed = true
              emit([textDeltaPart(block.id, delta.text)])
            } else if (block.kind === 'thinking' && typeof delta.thinking === 'string') {
              streamed = true
              emit([reasoningDeltaPart(block.id, delta.thinking)])
            } else if (block.kind === 'tool' && typeof delta.partial_json === 'string') {
              block.json += delta.partial_json
            }
            break
          }
          case 'content_block_stop': {
            const block = blocks.get(index)
            if (block === undefined) break
            if (block.kind === 'text') {
              emit([textEndPart(block.id)])
            } else if (block.kind === 'thinking') {
              emit([reasoningEndPart(block.id)])
            } else {
              let input: unknown = {}
              if (block.json.length > 0) {
                try {
                  input = JSON.parse(block.json)
                } catch {
                  input = block.json
                }
              }
              emittedTools.add(block.id)
              streamed = true
              emit([toolInputPart(block.id, block.name ?? 'tool', input)])
            }
            blocks.delete(index)
            break
          }
          case 'message_stop':
            if (messageOpen) {
              messageOpen = false
              emit([finishStepPart()])
            }
            break
          default:
            break
        }
        return
      }

      if (event.type === 'assistant') {
        const message = isRecord(event.message) ? event.message : {}
        if (!Array.isArray(message.content)) return
        for (const block of message.content) {
          if (!isRecord(block) || block.type !== 'tool_use') continue
          const id =
            typeof block.id === 'string' && block.id.length > 0 ? block.id : `cl-${++nextId}`
          if (emittedTools.has(id)) continue
          emittedTools.add(id)
          streamed = true
          emit([
            toolInputPart(
              id,
              typeof block.name === 'string' ? block.name : 'tool',
              block.input ?? {},
            ),
          ])
        }
        return
      }

      if (event.type === 'user') {
        const message = isRecord(event.message) ? event.message : {}
        if (!Array.isArray(message.content)) return
        for (const block of message.content) {
          if (!isRecord(block) || block.type !== 'tool_result') continue
          const id =
            typeof block.tool_use_id === 'string' && block.tool_use_id.length > 0
              ? block.tool_use_id
              : `cl-${++nextId}`
          streamed = true
          emit([toolOutputPart(id, block.content ?? null)])
        }
      }
    },
  }
}

/**
 * Buffered-path translation (degraded latency, same content): walk the
 * completed turn's events and emit whole messages — start-step/finish-step
 * around each assistant message, text/reasoning/tool parts from blocks, and
 * tool outputs from `user` tool_result lines.
 */
function translateBufferedClaudeTurn(turn: ClaudeTurn, emit: (parts: StreamPart[]) => void): void {
  let nextId = 0
  let stepOpen = false
  const closeStep = (): void => {
    if (stepOpen) {
      stepOpen = false
      emit([finishStepPart()])
    }
  }
  for (const event of turn.events) {
    if (event.type === 'assistant') {
      closeStep()
      stepOpen = true
      emit([startStepPart()])
      const message = isRecord(event.message) ? event.message : {}
      if (!Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (!isRecord(block)) continue
        const id = typeof block.id === 'string' && block.id.length > 0 ? block.id : `cl-${++nextId}`
        if (block.type === 'text' && typeof block.text === 'string') {
          emit([textStartPart(id), textDeltaPart(id, block.text), textEndPart(id)])
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          emit([
            reasoningStartPart(id),
            reasoningDeltaPart(id, block.thinking),
            reasoningEndPart(id),
          ])
        } else if (block.type === 'tool_use') {
          emit([
            toolInputPart(
              id,
              typeof block.name === 'string' ? block.name : 'tool',
              block.input ?? {},
            ),
          ])
        }
      }
    } else if (event.type === 'user') {
      const message = isRecord(event.message) ? event.message : {}
      if (!Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (!isRecord(block) || block.type !== 'tool_result') continue
        const id =
          typeof block.tool_use_id === 'string' && block.tool_use_id.length > 0
            ? block.tool_use_id
            : `cl-${++nextId}`
        emit([toolOutputPart(id, block.content ?? null)])
      }
    }
  }
  closeStep()
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
