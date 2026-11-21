/**
 * AntigravityAgentRunner (SPEC §9): AgentRunner over the locally installed
 * Google Antigravity CLI (`agy`). Each phase turn is one headless
 * `agy -p <prompt> --output-format stream-json` process; later turns and
 * fresh-process resumes continue the recorded conversation with
 * `--conversation <id>`. Authentication is ambient: the operator's keyring
 * login, `GEMINI_API_KEY` with `modelProvider = "gemini"`, or ADC.
 *
 * There is deliberately no tool-free one-shot completion: agy offers no
 * per-invocation way to guarantee zero tool execution, so the runtime omits
 * the optional capability and callers take their deterministic fallback.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamPart } from '../../store/streams/types'
import {
  agentInvocation,
  type AgentContinueOpts,
  type AgentResumeResult,
  type AgentRunner,
  type AgentSessionHandle,
  type AgentStartOpts,
  type AgentTurnFailure,
  type AgentTurnResult,
  type NativeSessionHandle,
  type SessionStreamEmitter,
  type StartPromptOpts,
  type Transcript,
} from '../types'
import { spawnCliStream } from './cli-stream'
import {
  guardNativeHandle,
  nativeObserver,
  nativeStateUnavailable,
  NativeIdentityMismatch,
  NativeObservationError,
  notResumable,
} from './native-session'
import {
  classifyProviderError,
  configurationFailure,
  credentialFailure,
  missingExecutableFailure,
} from './provider-error'
import type { RuntimeUsabilityInput, RuntimeUsabilityResult } from './runtime'
import { sessionEnv } from './session-env'
import { startPrompt } from './start-prompt'
import {
  abortPart,
  errorPart,
  finishPart,
  finishStepPart,
  promptPart,
  startPart,
  startStepPart,
  textDeltaPart,
  textEndPart,
  textStartPart,
  toolInputPart,
  toolOutputPart,
} from './stream-parts'

export interface AntigravityCliInvocation {
  /** Arguments after the `agy` executable. */
  args: string[]
  cwd: string
  env: Record<string, string>
  signal?: AbortSignal
}

export interface AntigravityCliResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Injectable direct-process boundary used by deterministic adapter tests. */
export type AntigravityCliRunFn = (
  invocation: AntigravityCliInvocation,
) => Promise<AntigravityCliResult>

/** A streaming CLI turn: decoded NDJSON lines as they arrive, plus the
 * completed result. */
export interface AntigravityCliStreamHandle {
  lines: AsyncIterable<string>
  result: Promise<AntigravityCliResult>
}

export type AntigravityCliStreamFn = (
  invocation: AntigravityCliInvocation,
) => AntigravityCliStreamHandle

const runAgyCli: AntigravityCliRunFn = async (invocation) => {
  const proc = Bun.spawn(['agy', ...invocation.args], {
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

const runAgyCliStream: AntigravityCliStreamFn = (invocation) => spawnCliStream('agy', invocation)

const AGY_PROMPT_ARG = '-p'
const AGY_OUTPUT_FORMAT_ARG = '--output-format'
const AGY_MODEL_ARG = '--model'
const AGY_CONVERSATION_ARG = '--conversation'

/** Options that select the model or the headless input/output protocol
 * parsed below. `--effort`, `--mode`, `--sandbox` and the rest stay freeform. */
export const ANTIGRAVITY_OWNED_ARGS = [
  AGY_PROMPT_ARG,
  '--print',
  '--prompt',
  AGY_OUTPUT_FORMAT_ARG,
  '--input-format',
  AGY_MODEL_ARG,
] as const

/** Session-control options the adapter owns per turn; a role arg naming one
 * would fork or replace the recorded conversation. */
const ANTIGRAVITY_SESSION_ARGS = [
  AGY_CONVERSATION_ARG,
  '--continue',
  '-c',
  '--prompt-interactive',
  '-i',
] as const

const MISSING_CLI_MESSAGE =
  'antigravity runtime: Antigravity CLI executable "agy" was not found. ' +
  'Install Antigravity CLI (https://antigravity.google/docs/getting-started), make sure ' +
  '~/.local/bin is on PATH, and authenticate: run `agy` once to sign in, or export ' +
  'GEMINI_API_KEY with modelProvider = "gemini", or set AGY_ADC_AUTH=true after ' +
  'gcloud auth application-default login.'

/** agy's documented and observed authentication diagnostics. Checked before
 * the shared exhaustion patterns so a login problem is never reported as
 * capacity. */
const AGY_CREDENTIAL_TEXT =
  /authentication required|not (?:logged|signed) in|please (?:log|sign) in|sign in to antigravity|GEMINI_API_KEY[^\n]*not set|keyring[^\n]*locked|failed to retrieve token|application default credentials|AGY_ADC_AUTH/i

/** agy's documented unknown-model diagnostic. */
const AGY_INVALID_MODEL_TEXT = /invalid model selection|not recognized as a known model/i

/** Ended transcripts retained for an idempotent repeated `end`. */
const ENDED_TRANSCRIPT_LIMIT = 32

/** `-p` is string-valued. A value starting with `-` is the one shape the
 * documented contract leaves open, so it gets a single inert leading
 * newline and the argv element never starts with `-`. */
export function agyPromptArg(message: string): string {
  return message.startsWith('-') ? `\n${message}` : message
}

interface JsonRecord {
  [key: string]: unknown
}

interface Usage {
  inputTokens: number
  outputTokens: number
}

interface ResultUsage {
  usage: Usage
  numTurns?: number
}

interface ParsedAgyOutput {
  events: JsonRecord[]
  malformedLines: string[]
  conversationId?: string
  result?: JsonRecord
  deltas: string[]
  stepUsage?: Usage
  toolSteps: string[]
}

interface AntigravityTurn {
  text: string
  usage: Usage
  resultUsage?: Usage
  numTurns?: number
  failure?: AgentTurnFailure
  cli: AntigravityCliResult
  events: JsonRecord[]
  malformedLines: string[]
  conversationId?: string
  toolSteps: string[]
}

interface TurnRecord {
  turn: number
  prompt: string
  text: string
  usage: Usage
  resultUsage?: Usage
  numTurns?: number
  failure?: AgentTurnFailure
  cli: AntigravityCliResult
  events: JsonRecord[]
  malformedLines: string[]
  conversationId?: string
  toolSteps: string[]
}

interface SessionState {
  opts: AgentStartOpts
  model?: string
  /** Absent when start failed before agy reported a conversation id. */
  nativeConversationId?: string
  turns: TurnRecord[]
}

export class AntigravityAgentRunner implements AgentRunner {
  readonly name = 'antigravity'
  readonly executable = 'agy'

  private readonly runCli: AntigravityCliRunFn
  private readonly runCliStream: AntigravityCliStreamFn | undefined
  private readonly host: () => string
  private readonly createSessionId: () => string
  private readonly sessions = new Map<string, SessionState>()
  private readonly ended = new Map<string, Transcript>()

  constructor(
    opts: {
      hostname?: () => string
      runCli?: AntigravityCliRunFn
      runCliStream?: AntigravityCliStreamFn
      createSessionId?: () => string
    } = {},
  ) {
    this.host = opts.hostname ?? hostname
    this.runCli = opts.runCli ?? runAgyCli
    // A test injecting only the buffered boundary takes the buffered
    // translation path for streaming turns (degraded latency, same content);
    // production gets the live streaming boundary.
    this.runCliStream =
      opts.runCliStream ?? (opts.runCli !== undefined ? undefined : runAgyCliStream)
    this.createSessionId = opts.createSessionId ?? (() => crypto.randomUUID())
  }

  startPrompt(opts: StartPromptOpts): string {
    return startPrompt('antigravity', opts)
  }

  async start(
    opts: AgentStartOpts,
  ): Promise<{ session: AgentSessionHandle; result: AgentTurnResult }> {
    const prompt = this.startPrompt(opts)
    const executed = await this.runTurn(prompt, opts)
    const turn: AntigravityTurn =
      executed.failure === undefined && executed.conversationId === undefined
        ? {
            ...executed,
            failure: classifyProviderError(
              `${this.name} runtime: agy stream ended without a conversation_id`,
            ),
          }
        : executed
    const id = turn.conversationId ?? this.createSessionId()
    const session: AgentSessionHandle = {
      id,
      runner: this.name,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    }
    this.sessions.set(id, {
      opts,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(turn.conversationId !== undefined ? { nativeConversationId: turn.conversationId } : {}),
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
    const conversation = state.nativeConversationId
    if (conversation === undefined) {
      throw new Error(
        `${this.name}: cannot continue session "${session.id}" because agy start failed before reporting a conversation_id`,
      )
    }
    // §10/D8: a continued turn gets this round's env, and streams through
    // THIS turn's emitter only.
    const turnOpts: AgentStartOpts = {
      ...(opts?.env !== undefined
        ? { ...state.opts, env: { ...state.opts.env, ...opts.env } }
        : state.opts),
      stream: opts?.stream,
      onNativeSession: opts?.onNativeSession,
    }
    const observe = nativeObserver({ ...turnOpts }, this.name, this.host(), conversation)
    await observe(conversation)
    turnOpts.onNativeSession = async (handle) => observe(handle.nativeId)
    const turn = await this.runTurn(
      message,
      turnOpts,
      conversation,
      opts?.signal,
      lastResultUsage(state.turns),
    )
    state.turns.push(this.turnRecord(state.turns.length + 1, message, turn))
    return this.toResult(turn)
  }

  async resume(
    handle: NativeSessionHandle,
    message: string,
    opts: AgentStartOpts,
  ): Promise<AgentResumeResult> {
    const invalid = guardNativeHandle(handle, this.name, opts, this.host())
    if (invalid !== undefined) return invalid
    let observed = false
    const callerObserver = opts.onNativeSession
    opts = {
      ...opts,
      onNativeSession: async (native) => {
        observed = true
        await callerObserver?.(native)
      },
    }
    let turn: AntigravityTurn
    try {
      turn = await this.runTurn(message, opts, handle.nativeId)
    } catch (error) {
      // A resume that silently starts a new conversation reports a different id.
      if (error instanceof NativeIdentityMismatch)
        return notResumable('missing-state', 'Native resume returned a different identity')
      throw error
    }
    // agy's missing-conversation text is not documented; the shared
    // "conversation … not found" recognizer covers the observed form.
    if (turn.failure !== undefined && nativeStateUnavailable(turn.failure))
      return notResumable('missing-state', turn.failure.message)
    if (!observed && turn.failure === undefined)
      return notResumable('missing-state', 'Native resume reported no identity')
    const id = handle.nativeId
    const session: AgentSessionHandle = {
      id,
      runner: this.name,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    }
    this.sessions.set(id, {
      opts,
      model: opts.model,
      nativeConversationId: id,
      turns: [this.turnRecord(1, message, turn)],
    })
    return { kind: 'resumed', session, result: this.toResult(turn) }
  }

  /** Idempotent: no agy process outlives a turn, so the first `end` only
   * builds the transcript, and a repeated `end` returns the same one. */
  async end(session: AgentSessionHandle): Promise<Transcript> {
    const previous = this.ended.get(session.id)
    const state = this.sessions.get(session.id)
    if (state === undefined) {
      if (previous !== undefined) return previous
      throw new Error(`${this.name}: end on unknown session "${session.id}"`)
    }
    this.sessions.delete(session.id)

    const usage = { inputTokens: 0, outputTokens: 0, turns: 0 }
    for (const turn of state.turns) {
      usage.inputTokens += turn.usage.inputTokens
      usage.outputTokens += turn.usage.outputTokens
      usage.turns += 1
    }

    const transcript: Transcript = {
      content: JSON.stringify(
        {
          session: session.id,
          ...(state.nativeConversationId !== undefined
            ? { nativeConversationId: state.nativeConversationId }
            : {}),
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
    this.ended.delete(session.id)
    this.ended.set(session.id, transcript)
    while (this.ended.size > ENDED_TRANSCRIPT_LIMIT) {
      const oldest = this.ended.keys().next().value
      if (oldest === undefined) break
      this.ended.delete(oldest)
    }
    return transcript
  }

  private liveState(session: AgentSessionHandle, op: 'continue'): SessionState {
    const state = this.sessions.get(session.id)
    if (state === undefined) {
      throw new Error(`${this.name}: ${op} on unknown session "${session.id}"`)
    }
    return state
  }

  private async runTurn(
    prompt: string,
    opts: AgentStartOpts,
    conversation?: string,
    signal: AbortSignal | undefined = opts.signal,
    previous?: ResultUsage,
  ): Promise<AntigravityTurn> {
    const observe = nativeObserver(opts, this.name, this.host(), conversation)
    const conflict = (opts.args ?? []).find((arg) =>
      ANTIGRAVITY_SESSION_ARGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
    )
    if (conflict !== undefined) {
      const failed = launchFailure(new Error(`Conflicting session-control argument: ${conflict}`))
      failed.failure = configurationFailure(`Conflicting session-control argument: ${conflict}`)
      return failed
    }
    // `--dangerously-skip-permissions` is agy's always-proceed mode: no
    // approval prompt can hang or soft-deny an unattended turn. Slash
    // commands stay enabled because phase prompts lead with `/<skill>`.
    const args = [AGY_OUTPUT_FORMAT_ARG, 'stream-json', '--dangerously-skip-permissions']
    if (opts.model !== undefined) args.push(AGY_MODEL_ARG, opts.model)
    if (conversation !== undefined) args.push(AGY_CONVERSATION_ARG, conversation)
    args.push(...(opts.args ?? []), AGY_PROMPT_ARG, agyPromptArg(prompt))
    const invocation: AntigravityCliInvocation = {
      args,
      cwd: opts.workspacePath,
      env: sessionEnv(opts.env, process.env, opts.judgeLaunch),
      ...(signal !== undefined ? { signal } : {}),
    }

    // One parse path serves every turn: the live line boundary when present,
    // otherwise the buffered run replayed through the same accumulator.
    if (opts.stream === undefined) {
      return this.runCliStream !== undefined
        ? await this.runStreamingPrompt(invocation, undefined, observe, previous)
        : await this.runPrompt(invocation, undefined, previous, observe)
    }

    const emitter = opts.stream
    emitter.append([promptPart(prompt), startPart(crypto.randomUUID())])
    const turn =
      this.runCliStream !== undefined
        ? await this.runStreamingPrompt(invocation, emitter, observe, previous)
        : await this.runPrompt(invocation, emitter, previous, observe)
    this.emitTurnEnd(turn, emitter, signal)
    return turn
  }

  /** Completed-turn, failed-turn, and cancelled-turn closing parts. */
  private emitTurnEnd(
    turn: AntigravityTurn,
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
        abortPart(reason instanceof Error ? reason.message : 'antigravity runtime: turn aborted'),
      ])
      return
    }
    emitter.append([errorPart(turn.failure.message)])
  }

  /** Live translation path: consume NDJSON lines as they arrive while the
   * same records feed the accumulator. */
  private async runStreamingPrompt(
    invocation: AntigravityCliInvocation,
    emitter: SessionStreamEmitter | undefined,
    observe: (id: string) => Promise<void>,
    previous: ResultUsage | undefined,
  ): Promise<AntigravityTurn> {
    let handle: AntigravityCliStreamHandle
    const controller = new AbortController()
    try {
      handle = this.runCliStream!({
        ...invocation,
        signal:
          invocation.signal === undefined
            ? controller.signal
            : AbortSignal.any([invocation.signal, controller.signal]),
      })
    } catch (error) {
      return launchFailure(error, invocation.signal)
    }
    const acc = new AgyOutputAccumulator()
    const translator = createAntigravityStreamTranslator((parts) => emitter?.append(parts))
    try {
      for await (const line of handle.lines) {
        const value = parseLine(line)
        if (value === undefined) {
          acc.push(line)
          continue
        }
        const id = conversationIdOf(value)
        if (id !== undefined) await observe(id)
        acc.pushRecord(value)
        translator.onEvent(value)
      }
    } catch (error) {
      if (error instanceof NativeObservationError) {
        controller.abort(error)
        void handle.result.catch(() => {})
        throw error
      }
      // The result promise below still carries the CLI's exit and stderr.
    }
    translator.close()
    let cli: AntigravityCliResult
    try {
      cli = await handle.result
    } catch (error) {
      return launchFailure(error, invocation.signal)
    }
    return finishTurn(cli, acc.snapshot(), invocation.signal, previous)
  }

  /** Buffered path: run to completion, then observe and translate the
   * recorded events through the same translator as the live path. */
  private async runPrompt(
    invocation: AntigravityCliInvocation,
    emitter: SessionStreamEmitter | undefined,
    previous: ResultUsage | undefined,
    observe?: (id: string) => Promise<void>,
  ): Promise<AntigravityTurn> {
    let cli: AntigravityCliResult
    try {
      cli = await this.runCli(invocation)
    } catch (error) {
      return launchFailure(error, invocation.signal)
    }
    const parsed = parseAgyOutput(cli.stdout)
    if (observe !== undefined) {
      for (const event of parsed.events) {
        const id = conversationIdOf(event)
        if (id !== undefined) await observe(id)
      }
    }
    if (emitter !== undefined) {
      const translator = createAntigravityStreamTranslator((parts) => emitter.append(parts))
      for (const event of parsed.events) translator.onEvent(event)
      translator.close()
    }
    return finishTurn(cli, parsed, invocation.signal, previous)
  }

  private turnRecord(turnNumber: number, prompt: string, turn: AntigravityTurn): TurnRecord {
    return {
      turn: turnNumber,
      prompt,
      text: turn.text,
      usage: turn.usage,
      ...(turn.resultUsage !== undefined ? { resultUsage: turn.resultUsage } : {}),
      ...(turn.numTurns !== undefined ? { numTurns: turn.numTurns } : {}),
      ...(turn.failure !== undefined ? { failure: turn.failure } : {}),
      cli: turn.cli,
      events: turn.events,
      malformedLines: turn.malformedLines,
      ...(turn.conversationId !== undefined ? { conversationId: turn.conversationId } : {}),
      toolSteps: turn.toolSteps,
    }
  }

  private toResult(turn: AntigravityTurn): AgentTurnResult {
    const base = { text: turn.text, usage: { ...turn.usage, turns: 1 } }
    return turn.failure === undefined
      ? { kind: 'completed', ...base }
      : { kind: 'failed', ...base, failure: turn.failure }
  }
}

function lastResultUsage(turns: readonly TurnRecord[]): ResultUsage | undefined {
  const last = turns.at(-1)
  if (last?.resultUsage === undefined) return undefined
  return {
    usage: last.resultUsage,
    ...(last.numTurns !== undefined ? { numTurns: last.numTurns } : {}),
  }
}

/** Shared post-processing of a completed CLI run. */
function finishTurn(
  cli: AntigravityCliResult,
  parsed: ParsedAgyOutput,
  signal: AbortSignal | undefined,
  previous: ResultUsage | undefined,
): AntigravityTurn {
  const result = parsed.result
  const text = stringField(result, 'response') ?? parsed.deltas.join('')
  const status = stringField(result, 'status')
  const resultUsage = isRecord(result?.usage) ? usageOf(result.usage) : undefined
  const numTurns = countField(result, 'num_turns')

  let failure: AgentTurnFailure | undefined
  if (cli.exitCode !== 0 || (result !== undefined && status !== 'SUCCESS')) {
    const message =
      nonempty(errorMessage(result?.error)) ??
      nonempty(cli.stderr.trim()) ??
      `antigravity runtime: agy exited with code ${cli.exitCode} (status ${status ?? 'none'}) without error text`
    failure = classifyAgyFailure(message, {
      stderr: cli.stderr,
      ...(status !== undefined ? { status } : {}),
      aborted: signal?.aborted === true,
    })
  } else if (parsed.malformedLines.length > 0) {
    failure = classifyProviderError('antigravity runtime: agy emitted malformed stream-json output')
  } else if (result === undefined) {
    failure = classifyProviderError('antigravity runtime: agy stream ended without a result event')
  }

  return {
    text,
    usage: turnUsage(parsed.stepUsage, resultUsage, numTurns, previous),
    ...(resultUsage !== undefined ? { resultUsage } : {}),
    ...(numTurns !== undefined ? { numTurns } : {}),
    ...(failure !== undefined ? { failure } : {}),
    cli,
    events: parsed.events,
    malformedLines: parsed.malformedLines,
    ...(parsed.conversationId !== undefined ? { conversationId: parsed.conversationId } : {}),
    toolSteps: parsed.toolSteps,
  }
}

/**
 * Per-turn usage. agy's `result.usage` is cumulative over a session while
 * each `step_update` carries per-step usage, and whether a fresh
 * `--conversation` process resets the result counters is undocumented. Step
 * sums are correct either way; the result is used only when it provably
 * describes this turn alone, and otherwise the turn reports 0/0 rather
 * than counting a cumulative value twice.
 */
function turnUsage(
  stepUsage: Usage | undefined,
  resultUsage: Usage | undefined,
  numTurns: number | undefined,
  previous: ResultUsage | undefined,
): Usage {
  if (stepUsage !== undefined) return stepUsage
  if (resultUsage === undefined) return { inputTokens: 0, outputTokens: 0 }
  if (numTurns === undefined || numTurns <= 1) return resultUsage
  if (previous?.numTurns !== undefined && numTurns > previous.numTurns) {
    return {
      inputTokens: Math.max(0, resultUsage.inputTokens - previous.usage.inputTokens),
      outputTokens: Math.max(0, resultUsage.outputTokens - previous.usage.outputTokens),
    }
  }
  return { inputTokens: 0, outputTokens: 0 }
}

/** Classify a failed agy turn without rewriting its message. */
export function classifyAgyFailure(
  message: string,
  evidence: { stderr?: string; status?: string; aborted?: boolean } = {},
): AgentTurnFailure {
  // A cancelled turn stays retryable whatever the dying process printed.
  if (evidence.aborted === true) return classifyProviderError(message)
  if (AGY_CREDENTIAL_TEXT.test(`${message}\n${evidence.stderr ?? ''}`))
    return credentialFailure(message)
  if (evidence.status === 'WAITING') {
    return configurationFailure(
      `${message}; agy waited for input it cannot receive headlessly — set artifactReviewPolicy to "always-proceed" and do not use agentMode "plan" for Autobuild sessions`,
    )
  }
  if (AGY_INVALID_MODEL_TEXT.test(message)) return configurationFailure(message)
  return classifyProviderError(message)
}

function parseAgyOutput(stdout: string): ParsedAgyOutput {
  const acc = new AgyOutputAccumulator()
  for (const line of stdout.split(/\r?\n/)) acc.push(line)
  return acc.snapshot()
}

/**
 * Incremental accumulator over agy's stream-json events, shared by the
 * buffered parse and the streaming path.
 */
class AgyOutputAccumulator {
  readonly events: JsonRecord[] = []
  readonly malformedLines: string[] = []
  readonly deltas: string[] = []
  readonly toolSteps: string[] = []
  /** Per-step DONE usage since the latest user_input step, by step_index. */
  private steps = new Map<number, Usage>()
  conversationId: string | undefined
  result: JsonRecord | undefined

  push(line: string): void {
    if (line.trim() === '') return
    const value = parseLine(line)
    if (value === undefined) {
      this.malformedLines.push(line)
      return
    }
    this.pushRecord(value)
  }

  pushRecord(value: JsonRecord): void {
    this.events.push(value)
    const id = conversationIdOf(value)
    if (id !== undefined && this.conversationId === undefined) this.conversationId = id

    if (value.event === 'step_update' && isRecord(value.step_update)) {
      const step = value.step_update
      const type = stringField(step, 'step_type')
      const done = stringField(step, 'state') === 'DONE'
      const index = countField(step, 'step_index')
      if (type === 'user_input' && done) {
        // Each turn opens with its own user_input step: anything before it
        // (a replayed earlier turn) is not this turn's usage.
        this.steps = new Map()
        this.deltas.length = 0
      }
      if (type === 'agent_response') {
        const delta = stringField(step, 'text_delta')
        if (delta !== undefined && delta.length > 0) this.deltas.push(delta)
      }
      if (type === 'tool' && done) {
        const info = isRecord(step.tool_info) ? step.tool_info : undefined
        this.toolSteps.push(stringField(info, 'name') ?? stringField(step, 'tool_name') ?? 'tool')
      }
      if (done && index !== undefined && isRecord(step.usage)) {
        this.steps.set(index, usageOf(step.usage))
      }
    }

    if (value.event === 'result' && isRecord(value.result)) this.result = value.result
  }

  snapshot(): ParsedAgyOutput {
    let stepUsage: Usage | undefined
    for (const usage of this.steps.values()) {
      stepUsage ??= { inputTokens: 0, outputTokens: 0 }
      stepUsage.inputTokens += usage.inputTokens
      stepUsage.outputTokens += usage.outputTokens
    }
    return {
      events: [...this.events],
      malformedLines: [...this.malformedLines],
      ...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}),
      ...(this.result !== undefined ? { result: this.result } : {}),
      deltas: [...this.deltas],
      ...(stepUsage !== undefined ? { stepUsage } : {}),
      toolSteps: [...this.toolSteps],
    }
  }
}

/**
 * Live stream translation (SPEC §9), keyed by `step_index`: an
 * agent_response step opens a step and a text part on first sight, streams
 * each `text_delta`, and closes both at DONE; a tool step emits its input on
 * first sight and its output (or error) at DONE. user_input and checkpoint
 * steps emit nothing. `close()` balances any step still open.
 */
export function createAntigravityStreamTranslator(emit: (parts: StreamPart[]) => void): {
  onEvent(event: JsonRecord): void
  close(): void
} {
  const openText = new Set<string>()
  const toolsSeen = new Set<string>()
  const toolsDone = new Set<string>()
  const closeAll = () => {
    for (const id of openText) emit([textEndPart(id), finishStepPart()])
    openText.clear()
  }
  return {
    onEvent(event) {
      if (event.event === 'result') {
        closeAll()
        return
      }
      if (event.event !== 'step_update' || !isRecord(event.step_update)) return
      const step = event.step_update
      const index = countField(step, 'step_index')
      if (index === undefined) return
      const id = `agy-${index}`
      const done = stringField(step, 'state') === 'DONE'
      switch (stringField(step, 'step_type')) {
        case 'agent_response': {
          if (!openText.has(id)) {
            emit([startStepPart(), textStartPart(id)])
            openText.add(id)
          }
          const delta = stringField(step, 'text_delta')
          if (delta !== undefined && delta.length > 0) emit([textDeltaPart(id, delta)])
          if (done) {
            emit([textEndPart(id), finishStepPart()])
            openText.delete(id)
          }
          break
        }
        case 'tool': {
          const info = isRecord(step.tool_info) ? step.tool_info : undefined
          if (!toolsSeen.has(id)) {
            toolsSeen.add(id)
            emit([
              toolInputPart(
                id,
                stringField(info, 'name') ?? stringField(step, 'tool_name') ?? 'tool',
                info?.parameters ?? {},
              ),
            ])
          }
          if (done && !toolsDone.has(id)) {
            toolsDone.add(id)
            emit([toolOutputPart(id, info?.error ?? info?.output ?? null)])
          }
          break
        }
        default:
          break
      }
    },
    close: closeAll,
  }
}

export interface AntigravityUsabilityDeps {
  runCli?: AntigravityCliRunFn
  makeProbeDir?: () => Promise<string>
  removeProbeDir?: (path: string) => Promise<void>
}

const PROBE_PROMPT = 'Reply with exactly: ok'
const PROBE_TIMEOUT_MS = 90_000

/**
 * `ab init` probe: one minimal headless request per configured model (or
 * one with agy's default), because a model listing does not prove that
 * ambient authentication works. It runs in a fresh empty directory so no
 * repository content reaches the provider, and redacts secrets from every
 * returned reason.
 */
export async function isAntigravityRuntimeUsable(
  input: RuntimeUsabilityInput,
  deps: AntigravityUsabilityDeps = {},
): Promise<RuntimeUsabilityResult> {
  const runCli = deps.runCli ?? runAgyCli
  const makeProbeDir = deps.makeProbeDir ?? (() => mkdtemp(join(tmpdir(), 'ab-agy-probe-')))
  const removeProbeDir =
    deps.removeProbeDir ?? ((path: string) => rm(path, { recursive: true, force: true }))
  const env = Object.fromEntries(
    Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const redact = redactor(env)
  const models: readonly (string | undefined)[] =
    input.models.length > 0 ? input.models : [undefined]
  let dir: string
  try {
    dir = await makeProbeDir()
  } catch (error) {
    return { usable: false, reason: redact(firstLine(errorText(error))) }
  }
  try {
    for (const model of models) {
      const reason = await probeOnce(runCli, dir, env, model)
      if (reason !== undefined) return { usable: false, reason: redact(reason) }
    }
    return {
      usable: true,
      reason:
        'Antigravity CLI is installed and a minimal model request succeeded' +
        (input.models.length > 0 ? ` (model ${input.models.join(', ')})` : ''),
    }
  } finally {
    await removeProbeDir(dir).catch(() => {})
  }
}

/** One probe request; undefined when it succeeded, otherwise the reason. */
async function probeOnce(
  runCli: AntigravityCliRunFn,
  cwd: string,
  env: Record<string, string>,
  model: string | undefined,
): Promise<string | undefined> {
  const args = [
    AGY_PROMPT_ARG,
    PROBE_PROMPT,
    AGY_OUTPUT_FORMAT_ARG,
    'json',
    '--disable-slash-commands',
    '--print-timeout',
    '60s',
    ...(model !== undefined ? [AGY_MODEL_ARG, model] : []),
  ]
  const suffix = model !== undefined ? ` (model ${model})` : ''
  let cli: AntigravityCliResult
  try {
    cli = await runCli({ args, cwd, env, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  } catch (error) {
    return isEnoent(error) ? MISSING_CLI_MESSAGE : `${firstLine(errorText(error))}${suffix}`
  }
  let envelope: JsonRecord | undefined
  try {
    const value: unknown = JSON.parse(cli.stdout)
    envelope = isRecord(value) ? value : undefined
  } catch {
    envelope = undefined
  }
  if (cli.exitCode === 0 && envelope !== undefined && envelope.status === 'SUCCESS')
    return undefined
  const detail =
    nonempty(errorMessage(envelope?.error)) ??
    nonempty(cli.stderr.trim()) ??
    (envelope === undefined && cli.exitCode === 0
      ? 'agy returned malformed JSON'
      : `agy exited with code ${cli.exitCode}`)
  const status = stringField(envelope, 'status')
  const failure = classifyAgyFailure(detail, {
    stderr: cli.stderr,
    ...(status !== undefined ? { status } : {}),
  })
  const prefix =
    failure.cause === 'credentials'
      ? 'Antigravity CLI is not authenticated'
      : failure.cause === 'configuration'
        ? 'Antigravity CLI configuration problem'
        : 'Antigravity CLI request failed'
  return `${prefix}: ${firstLine(detail)}${suffix}`
}

function redactor(env: Record<string, string>): (text: string) => string {
  const secrets = Object.entries(env)
    .filter(
      ([name, value]) =>
        value.length > 0 &&
        (name === 'GEMINI_API_KEY' || (value.length > 16 && /KEY|TOKEN|SECRET/i.test(name))),
    )
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length)
  return (text) => secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), text)
}

function parseLine(line: string): JsonRecord | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** agy carries the conversation id at the top level of `init` and inside
 * `step_update` and `result`. */
function conversationIdOf(event: JsonRecord): string | undefined {
  for (const candidate of [event, event.step_update, event.result]) {
    const id = isRecord(candidate) ? stringField(candidate, 'conversation_id') : undefined
    if (id !== undefined && id.trim() !== '') return id
  }
  return undefined
}

function usageOf(usage: JsonRecord): Usage {
  // output_tokens already includes thinking tokens.
  return {
    inputTokens: tokenCount(usage.input_tokens),
    outputTokens: tokenCount(usage.output_tokens),
  }
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error
  if (isRecord(error)) return stringField(error, 'message')
  return undefined
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

function countField(value: JsonRecord | undefined, key: string): number | undefined {
  const field = value?.[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: JsonRecord | undefined, key: string): string | undefined {
  const field = value?.[key]
  return typeof field === 'string' ? field : undefined
}

function nonempty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim() !== '') ?? text
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A CLI that never ran (or was torn down): missing executable vs. a failed
 * or cancelled launch, which stays retryable. */
function launchFailure(error: unknown, signal?: AbortSignal): AntigravityTurn {
  const missing = isEnoent(error)
  const message = missing
    ? MISSING_CLI_MESSAGE
    : signal?.aborted === true
      ? `antigravity runtime: agy turn aborted: ${errorText(error)}`
      : `antigravity runtime: failed to launch agy: ${errorText(error)}`
  return {
    text: '',
    usage: { inputTokens: 0, outputTokens: 0 },
    failure: missing ? missingExecutableFailure(message) : classifyProviderError(message),
    cli: { stdout: '', stderr: errorText(error), exitCode: -1 },
    events: [],
    malformedLines: [],
    toolSteps: [],
  }
}
