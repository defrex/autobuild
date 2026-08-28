/**
 * CodexAgentRunner (SPEC §9): AgentRunner over the locally installed OpenAI
 * Codex CLI. Phase turns use Codex's JSONL exec protocol and native thread
 * resumption; non-phase judgments run as isolated, tool-free ephemeral turns.
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
import type { OneShotCompletion, OneShotCompletionInput, OneShotCompletionResult } from './one-shot'
import { classifyProviderError, configurationFailure, credentialFailure } from './provider-error'
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
  private readonly createSessionId: () => string
  private readonly sessions = new Map<string, SessionState>()

  constructor(
    opts: {
      runCli?: CodexCliRunFn
      createSessionId?: () => string
    } = {},
  ) {
    this.runCli = opts.runCli ?? runCodexCli
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

  private runTurn(
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
    return this.runPrompt({
      args,
      cwd: opts.workspacePath,
      env: sessionEnv(opts.env),
      ...(signal !== undefined ? { signal } : {}),
    })
  }

  private async runPrompt(invocation: CodexCliInvocation): Promise<CodexTurn> {
    let cli: CodexCliResult
    try {
      cli = await this.runCli(invocation)
    } catch (error) {
      const missing = isEnoent(error)
      const message = missing
        ? MISSING_CLI_MESSAGE
        : `${this.name} runtime: failed to launch Codex CLI executable "codex": ${errorText(error)}`
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

    const parsed = parseCodexOutput(cli.stdout)
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
  const parsed: ParsedCodexOutput = {
    events: [],
    malformedLines: [],
    assistantText: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    completed: false,
    failureMessages: [],
    statuses: [],
    codes: [],
    toolItems: [],
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

    if (value.type === 'thread.started') {
      const id = stringField(value, 'thread_id') ?? stringField(value, 'threadId')
      if (id !== undefined && id.length > 0) parsed.threadId = id
    }

    if (value.type === 'item.completed' || value.type === 'item.started') {
      const item = isRecord(value.item) ? value.item : undefined
      const itemType = stringField(item, 'type')
      if (value.type === 'item.completed' && itemType === 'agent_message') {
        const text = itemText(item)
        if (text !== undefined) parsed.assistantText.push(text)
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
        parsed.toolItems.push(itemType)
      }
    }

    if (value.type === 'turn.completed') {
      parsed.completed = true
      const usage = isRecord(value.usage) ? value.usage : undefined
      parsed.usage = {
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
      if (message !== undefined) parsed.failureMessages.push(message)
      collectHints(value, parsed)
      if (nested !== undefined) collectHints(nested, parsed)
    }
  }
  return parsed
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

function collectHints(value: JsonRecord, parsed: ParsedCodexOutput): void {
  for (const key of ['status', 'status_code', 'statusCode']) {
    const status = value[key]
    if (typeof status === 'number' && Number.isFinite(status)) parsed.statuses.push(status)
  }
  for (const key of ['code', 'type', 'category']) {
    const code = value[key]
    if (typeof code === 'string' || typeof code === 'number') parsed.codes.push(code)
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
