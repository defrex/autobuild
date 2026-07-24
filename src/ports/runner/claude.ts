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
import {
  agentInvocation,
  type AgentContinueOpts,
  type AgentRunner,
  type AgentSessionHandle,
  type AgentStartOpts,
  type AgentTurnFailure,
  type AgentTurnResult,
  type Transcript,
} from '../types'
import { classifyProviderError } from './provider-error'
import { sessionEnv } from './session-env'
import type { OneShotCompletion, OneShotCompletionInput, OneShotCompletionResult } from './one-shot'

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

const MISSING_CLI_MESSAGE =
  'claude runtime: Claude Code CLI executable "claude" was not found. ' +
  'Install Claude Code (https://code.claude.com/docs/en/setup), run `claude`, ' +
  'and complete login before running Autobuild.'

export class ClaudeAgentRunner implements AgentRunner, OneShotCompletion {
  readonly name = 'claude'

  private readonly runCli: ClaudeCliRunFn
  private readonly createSessionId: () => string
  private readonly sessions = new Map<string, SessionState>()

  constructor(
    opts: {
      runCli?: ClaudeCliRunFn
      createSessionId?: () => string
    } = {},
  ) {
    this.runCli = opts.runCli ?? runClaudeCli
    this.createSessionId = opts.createSessionId ?? (() => crypto.randomUUID())
  }

  /** Non-phase judgment: one verbatim prompt, one model turn, and no tools or
   * resumable session persistence. */
  async complete(input: OneShotCompletionInput): Promise<OneShotCompletionResult> {
    const args = this.baseArgs()
    args.push('--tools', '', '--max-turns', '1', '--no-session-persistence')
    if (input.model !== undefined) args.push('--model', input.model)
    args.push('--', input.prompt)

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
    const turn = await this.runTurn(message, turnOpts, { resume: session.id })
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

  private runTurn(
    prompt: string,
    opts: AgentStartOpts,
    session: { sessionId: string } | { resume: string },
  ): Promise<ClaudeTurn> {
    const args = this.baseArgs()
    if ('sessionId' in session) args.push('--session-id', session.sessionId)
    else args.push('--resume', session.resume)
    if (opts.model !== undefined) args.push('--model', opts.model)
    args.push('--', prompt)

    return this.runPrompt({
      args,
      cwd: opts.workspacePath,
      env: sessionEnv(opts.env),
    })
  }

  private baseArgs(): string[] {
    return ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']
  }

  private async runPrompt(invocation: ClaudeCliInvocation): Promise<ClaudeTurn> {
    let cli: ClaudeCliResult
    try {
      cli = await this.runCli(invocation)
    } catch (error) {
      const missing = isEnoent(error)
      const message = missing
        ? MISSING_CLI_MESSAGE
        : `${this.name} runtime: failed to launch Claude Code CLI: ${errorText(error)}`
      return {
        text: '',
        usage: { inputTokens: 0, outputTokens: 0 },
        failure: missing ? { message, permanent: true } : classifyProviderError(message),
        cli: {
          stdout: '',
          stderr: errorText(error),
          exitCode: -1,
        },
        events: [],
        malformedLines: [],
      }
    }

    const parsed = parseCliOutput(cli.stdout)
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
  const parsed: ParsedCliOutput = {
    events: [],
    malformedLines: [],
    assistantText: [],
    assistantErrors: [],
    statuses: [],
    codes: [],
  }
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      parsed.malformedLines.push(line)
      continue
    }
    if (!isRecord(value)) {
      parsed.malformedLines.push(line)
      continue
    }
    parsed.events.push(value)
    if (value.type === 'assistant') collectAssistant(value, parsed)
    if (value.type === 'result') parsed.result = value
    if (value.type === 'system' || value.type === 'api_retry') {
      collectHints(value, parsed)
    }
  }
  return parsed
}

function collectAssistant(event: JsonRecord, parsed: ParsedCliOutput): void {
  const error = stringField(event, 'error')
  if (error !== undefined) parsed.assistantErrors.push(error)
  const message = event.message
  if (!isRecord(message) || !Array.isArray(message.content)) return
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== 'text') continue
    const text = stringField(block, 'text')
    if (text !== undefined) parsed.assistantText.push(text)
  }
}

function collectHints(event: JsonRecord, parsed: ParsedCliOutput): void {
  const status = numberField(event, 'api_error_status', 'status', 'status_code', 'statusCode')
  if (status !== undefined) parsed.statuses.push(status)
  for (const key of ['code', 'error', 'category', 'subtype']) {
    const code = stringOrNumberField(event, key)
    if (code !== undefined) parsed.codes.push(code)
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
