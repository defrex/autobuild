/**
 * ScriptedAgentRunner (SPEC §9): the deterministic AgentRunner used by every
 * kernel/process/integration test. A single script function plays the agent;
 * the runner records every turn into public journals so tests can assert the
 * exact session traffic — and `end()` produces a Transcript like any real
 * adapter, because transcripts come back through the interface, guaranteed.
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
import { sessionEnv } from './session-env'

/** What the script sees on each invocation — one call per turn. */
export interface ScriptContext {
  /** This TURN's opts: on `continue`, the refreshed ambient env (§10, D8)
   * merged over the start env — exactly what a real adapter launches with. */
  opts: AgentStartOpts
  session: AgentSessionHandle
  /** 1 on `start`, incremented on each `continue`. */
  turn: number
  /** The `continue` message; undefined on turn 1 (start has no message). */
  message?: string
  /** All prior `continue` messages, oldest first (excludes this turn's). */
  history: string[]
}

export type Script = (ctx: ScriptContext) => Promise<AgentTurnResult> | AgentTurnResult

/** Default completed turn (text '', usage 1/1/1) — keeps scripts terse. */
export function defaultTurnResult(text = ''): AgentTurnResult {
  return {
    kind: 'completed',
    text,
    usage: { inputTokens: 1, outputTokens: 1, turns: 1 },
  }
}

/** Script a provider/runner-declared failure while preserving the same endable
 * fake session and transcript behavior as a real adapter. */
export function failedTurnResult(message: string, permanent: boolean, text = ''): AgentTurnResult {
  return {
    kind: 'failed',
    text,
    usage: { inputTokens: 0, outputTokens: 0, turns: 1 },
    failure: { message, permanent },
  }
}

export interface RecordedTurn {
  turn: number
  /** Undefined on turn 1 — the start prompt is derived from `opts`. */
  message?: string
  result: AgentTurnResult
}

/** Per-session journal, public for assertions. */
export interface SessionJournal {
  session: AgentSessionHandle
  opts: AgentStartOpts
  turns: RecordedTurn[]
  /** Messages passed to `continue`, in order. */
  messages: string[]
  ended: boolean
}

export class ScriptedAgentRunner implements AgentRunner {
  readonly name = 'scripted'
  /** Journals keyed by session id (`s_1`, `s_2`, …), in creation order. */
  readonly sessions = new Map<string, SessionJournal>()

  private readonly script: Script
  private nextSession = 0

  constructor(opts: { script: Script }) {
    this.script = opts.script
  }

  async start(
    opts: AgentStartOpts,
  ): Promise<{ session: AgentSessionHandle; result: AgentTurnResult }> {
    this.nextSession += 1
    const session: AgentSessionHandle = {
      id: `s_${this.nextSession}`,
      runner: this.name,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    }
    const journal: SessionJournal = {
      session,
      opts,
      turns: [],
      messages: [],
      ended: false,
    }
    this.sessions.set(session.id, journal)

    const result = await this.script({
      // Scripts observe the same effective launch environment as production
      // adapters; the journal below intentionally retains the caller's raw
      // start options as the session identity.
      opts: { ...opts, env: sessionEnv(opts.env) },
      session,
      turn: 1,
      history: [],
    })
    journal.turns.push({ turn: 1, result })
    return { session, result }
  }

  async continue(
    session: AgentSessionHandle,
    message: string,
    opts?: AgentContinueOpts,
  ): Promise<AgentTurnResult> {
    const journal = this.liveJournal(session, 'continue')
    const history = [...journal.messages]
    const turn = journal.turns.length + 1
    // Mirror the real adapters (§10, D8): the continued turn runs under the
    // refreshed ambient env merged over the start env, so the script's fake
    // CLI resolves exactly what a real agent's `ab` would. The journal keeps
    // the START opts — they are the session's identity.
    const scoped = opts?.env !== undefined ? { ...journal.opts.env, ...opts.env } : journal.opts.env
    const turnOpts = { ...journal.opts, env: sessionEnv(scoped) }

    const result = await this.script({
      opts: turnOpts,
      session: journal.session,
      turn,
      message,
      history,
    })
    journal.messages.push(message)
    journal.turns.push({ turn, message, result })
    return result
  }

  async end(session: AgentSessionHandle): Promise<Transcript> {
    const journal = this.liveJournal(session, 'end')
    journal.ended = true

    const usage = { inputTokens: 0, outputTokens: 0, turns: 0 }
    for (const { result } of journal.turns) {
      usage.inputTokens += result.usage.inputTokens
      usage.outputTokens += result.usage.outputTokens
      usage.turns += result.usage.turns
    }

    return {
      content: JSON.stringify(
        {
          session: journal.session.id,
          skill: journal.opts.skill,
          invocation: agentInvocation(journal.opts),
          ...(journal.opts.buildSlug !== undefined ? { buildSlug: journal.opts.buildSlug } : {}),
          turns: journal.turns,
        },
        null,
        2,
      ),
      metadata: {
        runner: this.name,
        ...(journal.session.model !== undefined ? { model: journal.session.model } : {}),
        usage,
      },
    }
  }

  private liveJournal(session: AgentSessionHandle, op: 'continue' | 'end'): SessionJournal {
    const journal = this.sessions.get(session.id)
    if (!journal) {
      throw new Error(`${this.name}: ${op} on unknown session "${session.id}"`)
    }
    if (journal.ended) {
      throw new Error(`${this.name}: ${op} on ended session "${session.id}"`)
    }
    return journal
  }
}
