/** AgentRunner adapter for the operator's locally installed Pi CLI. */
import semver from 'semver'
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
import { createPiRpcSession } from './pi-rpc'
import type { RuntimeUsabilityInput, RuntimeUsabilityResult } from './runtime'
import { sessionEnv } from './session-env'

export const MINIMUM_PI_VERSION = '0.84.3'
const PI_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const

export interface PiModelRef {
  provider: string
  id: string
}

export function parsePiModel(model: string): PiModelRef {
  const slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(
      `pi runtime: model "${model}" is not provider-qualified — expected "<provider>/<id>". ` +
        'Run `ab models <query>` to look up an id.',
    )
  }
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) }
}

export interface PiCliInvocation {
  args: string[]
  cwd: string
  env: Record<string, string>
}

export interface PiCliResult {
  stdout: string
  stderr: string
  exitCode: number
}

export type PiCliRunFn = (invocation: PiCliInvocation) => Promise<PiCliResult>

export const runPiCli: PiCliRunFn = async (invocation) => {
  const proc = Bun.spawn(['pi', ...invocation.args], {
    cwd: invocation.cwd,
    env: invocation.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

export interface PiPrerequisite {
  version: string
}

export async function checkLocalPi(
  cwd: string,
  env: Record<string, string>,
  runCli: PiCliRunFn = runPiCli,
): Promise<PiPrerequisite> {
  let result: PiCliResult
  try {
    result = await runCli({ args: ['--version'], cwd, env })
  } catch (error) {
    if (isEnoent(error)) {
      throw new Error(
        'pi runtime: Pi CLI executable "pi" was not found. Install Pi, run `pi` and log in, then retry.',
      )
    }
    throw new Error(`pi runtime: failed to launch Pi CLI executable "pi": ${errorText(error)}`)
  }
  const detected = result.stdout.trim()
  if (result.exitCode !== 0) {
    throw new Error(
      `pi runtime: "pi --version" exited with code ${result.exitCode}: ${result.stderr.trim() || detected || 'no diagnostic'}`,
    )
  }
  const version = semver.valid(detected)
  if (version === null) {
    throw new Error(`pi runtime: could not parse detected Pi version "${detected || '(empty)'}"`)
  }
  if (semver.lt(version, MINIMUM_PI_VERSION)) {
    throw new Error(
      `pi runtime: detected Pi ${version}, but Autobuild requires Pi ${MINIMUM_PI_VERSION} or newer. Upgrade the local "pi" executable.`,
    )
  }
  return { version }
}

export async function isPiRuntimeUsable(
  input: RuntimeUsabilityInput,
  runCli: PiCliRunFn = runPiCli,
): Promise<RuntimeUsabilityResult> {
  if (input.models.length === 0) {
    return { usable: false, reason: 'Pi has no default model configured to probe' }
  }
  const env = cleanEnv(input.env)
  try {
    await checkLocalPi(input.cwd, env, runCli)
    for (const model of new Set(input.models)) {
      parsePiModel(model)
      const result = await runCli({
        args: ['auth', 'check', '--model', model, '--json'],
        cwd: input.cwd,
        env,
      })
      let payload: unknown
      try {
        payload = JSON.parse(result.stdout)
      } catch {
        return {
          usable: false,
          reason: `Pi authentication check for model "${model}" returned malformed JSON`,
        }
      }
      const status = isRecord(payload) ? payload.status : undefined
      if (result.exitCode !== 0 || status !== 'ready') {
        const reason =
          isRecord(payload) && typeof payload.reason === 'string' ? ` (${payload.reason})` : ''
        return {
          usable: false,
          reason: `Pi model "${model}" is not ready in the local Pi login${reason}`,
        }
      }
    }
    return { usable: true, reason: 'Local Pi CLI, model catalog, and authentication are available' }
  } catch (error) {
    return { usable: false, reason: errorText(error) }
  }
}

export const PI_OWNED_ARGS = [
  '--mode',
  '--no-session',
  '--no-approve',
  '--no-context-files',
  '--no-prompt-templates',
  '--no-themes',
  '--model',
  '-m',
  '--no-tools',
  '--no-skills',
  '--skill',
  '--no-extensions',
] as const

export interface PiTurn {
  text: string
  usage: { inputTokens: number; outputTokens: number }
  failure?: AgentTurnFailure
}

export interface PiSession {
  readonly sessionId: string
  prompt(text: string, env: Record<string, string>, signal?: AbortSignal): Promise<PiTurn>
  dispose(): Promise<void> | void
}

export type PiCreateSessionFn = (opts: {
  cwd: string
  model?: PiModelRef
  tools: readonly string[]
  args: readonly string[]
  skill?: string
  env: Record<string, string>
}) => Promise<PiSession>

const createLocalPiSession: PiCreateSessionFn = async (opts) => {
  await checkLocalPi(opts.cwd, opts.env)
  return createPiRpcSession(opts)
}

interface TurnRecord {
  turn: number
  prompt: string
  text: string
  usage: { inputTokens: number; outputTokens: number }
  failure?: AgentTurnFailure
}

interface SessionState {
  opts: AgentStartOpts
  model?: string
  session?: PiSession
  turns: TurnRecord[]
}

export class PiAgentRunner implements AgentRunner, OneShotCompletion {
  readonly name = 'pi'
  private readonly createSessionFn: PiCreateSessionFn
  private readonly createSessionId: () => string
  private readonly sessions = new Map<string, SessionState>()

  constructor(opts: { createSessionFn?: PiCreateSessionFn; createSessionId?: () => string } = {}) {
    this.createSessionFn = opts.createSessionFn ?? createLocalPiSession
    this.createSessionId = opts.createSessionId ?? (() => crypto.randomUUID())
  }

  async complete(input: OneShotCompletionInput): Promise<OneShotCompletionResult> {
    const model = input.model !== undefined ? parsePiModel(input.model) : undefined
    const session = await this.createSessionFn({
      cwd: input.cwd,
      ...(model !== undefined ? { model } : {}),
      tools: [],
      args: input.args ?? [],
      env: sessionEnv(input.env),
    })
    try {
      const turn = await session.prompt(input.prompt, sessionEnv(input.env), input.signal)
      if (turn.failure !== undefined) throw new Error(turn.failure.message)
      return { text: turn.text }
    } finally {
      await session.dispose()
    }
  }

  async start(
    opts: AgentStartOpts,
  ): Promise<{ session: AgentSessionHandle; result: AgentTurnResult }> {
    const model = opts.model !== undefined ? parsePiModel(opts.model) : undefined
    const prompt = `/skill:${opts.skill} ${agentInvocation(opts)}`
    let native: PiSession | undefined
    let turn: PiTurn
    try {
      native = await this.createSessionFn({
        cwd: opts.workspacePath,
        ...(model !== undefined ? { model } : {}),
        tools: PI_TOOLS,
        args: opts.args ?? [],
        skill: opts.skill,
        env: sessionEnv(opts.env),
      })
      turn = await this.runPrompt(native, prompt, this.turnEnv(opts.env), opts.signal)
    } catch (error) {
      turn = {
        text: '',
        usage: { inputTokens: 0, outputTokens: 0 },
        failure: localPiFailure(error),
      }
    }
    const id = native?.sessionId ?? this.createSessionId()
    const handle: AgentSessionHandle = {
      id,
      runner: this.name,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    }
    this.sessions.set(id, {
      opts,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(native !== undefined ? { session: native } : {}),
      turns: [this.turnRecord(1, prompt, turn)],
    })
    return { session: handle, result: this.toResult(turn) }
  }

  async continue(
    handle: AgentSessionHandle,
    message: string,
    opts?: AgentContinueOpts,
  ): Promise<AgentTurnResult> {
    const state = this.liveState(handle, 'continue')
    if (state.session === undefined) {
      throw new Error(`pi: cannot continue session "${handle.id}" because local Pi failed to start`)
    }
    const scoped = opts?.env !== undefined ? { ...state.opts.env, ...opts.env } : state.opts.env
    const turn = await this.runPrompt(state.session, message, this.turnEnv(scoped), opts?.signal)
    state.turns.push(this.turnRecord(state.turns.length + 1, message, turn))
    return this.toResult(turn)
  }

  async end(handle: AgentSessionHandle): Promise<Transcript> {
    const state = this.liveState(handle, 'end')
    this.sessions.delete(handle.id)
    await state.session?.dispose()
    const usage = { inputTokens: 0, outputTokens: 0, turns: 0 }
    for (const turn of state.turns) {
      usage.inputTokens += turn.usage.inputTokens
      usage.outputTokens += turn.usage.outputTokens
      usage.turns += 1
    }
    return {
      content: JSON.stringify(
        {
          session: handle.id,
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

  private async runPrompt(
    session: PiSession,
    prompt: string,
    env: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<PiTurn> {
    try {
      return await session.prompt(prompt, env, signal)
    } catch (error) {
      return {
        text: '',
        usage: { inputTokens: 0, outputTokens: 0 },
        failure: localPiFailure(error),
      }
    }
  }

  private liveState(handle: AgentSessionHandle, operation: 'continue' | 'end'): SessionState {
    const state = this.sessions.get(handle.id)
    if (state === undefined) throw new Error(`pi: ${operation} on unknown session "${handle.id}"`)
    return state
  }

  private turnRecord(number: number, prompt: string, turn: PiTurn): TurnRecord {
    return {
      turn: number,
      prompt,
      text: turn.text,
      usage: turn.usage,
      ...(turn.failure !== undefined ? { failure: turn.failure } : {}),
    }
  }

  private toResult(turn: PiTurn): AgentTurnResult {
    const base = { text: turn.text, usage: { ...turn.usage, turns: 1 } }
    return turn.failure === undefined
      ? { kind: 'completed', ...base }
      : { kind: 'failed', ...base, failure: turn.failure }
  }

  private turnEnv(scoped: Record<string, string>): Record<string, string> {
    return sessionEnv(scoped)
  }
}

function localPiFailure(error: unknown): AgentTurnFailure {
  const message = errorText(error)
  if (
    /executable "pi" was not found|requires Pi .* or newer|could not parse detected Pi version/.test(
      message,
    )
  ) {
    return configurationFailure(message)
  }
  if (/not ready|authentication|logged in|credentials/i.test(message))
    return credentialFailure(message)
  return classifyProviderError(message)
}

function cleanEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
