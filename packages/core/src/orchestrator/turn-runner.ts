/**
 * The orchestrator turn runner (AUT-342): a stateless agent loop over the
 * operator tool registry. Every invocation reconstructs its whole
 * conversation from durable state (`conversation.ts`), streams its output as
 * protocol parts onto the turn's session-scoped stream, checkpoints at step
 * boundaries via the stream sink's awaitable flush, and records its outcome
 * as session facts. A turn that outlives one function invocation suspends on
 * budget and resumes in a fresh invocation without losing a step; a tool in
 * the approval list suspends the turn until the operator answers.
 *
 * Nothing here encodes this repository's specifics.
 */
import {
  ToolLoopAgent,
  convertToModelMessages,
  isStepCount,
  toUIMessageChunk,
  type LanguageModel,
} from 'ai'
import { createSessionStreamSink } from '../store/streams/session-writer'
import type { StreamPart } from '../store/streams/types'
import type { Config } from '../config/schema'
import { ORCHESTRATOR_ROUTE_LIMIT_SECONDS } from '../config/schema'
import type { OperatorToolRegistry } from '../operator/registry'
import { agentActor, type Via } from '../events/envelope'
import type { SessionEventEnvelope, SessionEventWrite, SessionEventType } from '../events/sessions'
import type { SessionTurnTrigger } from '../store/session-reducer'
import { reduceSession } from '../store/session-reducer'
import { validateExpectedSeq, type BuildStore, type Clock } from '../store/types'
import type { IdSource } from '../ids'
import { reconstructConversation } from './conversation'
import { buildTurnSystemPrompt } from './prompt'
import { registryTools } from './tools'
import { approvalConfiguration, parseApprovalEntries } from './approvals'
import { classifyModelError, resolveGatewayModel, type TurnFailureKind } from './model'
export type { TurnFailureKind }

/** Hard cap on tool-loop steps per invocation — a runaway loop stops here
 * even when the budget condition somehow never fires. */
export const ORCHESTRATOR_MAX_STEPS = 32

/** Seconds of margin the budget condition reserves for the final durable
 * flush and outcome writes: the stop condition fires slightly before the
 * invocation deadline so the suspension lands durably. */
export const ORCHESTRATOR_FLUSH_MARGIN_SECONDS = 5

/** The wake input a wake trigger delivers: the attention event record and
 * the build's reduced state, frozen at wake time. Embedded in the
 * `turn.started` payload so reconstruction is byte-identical across
 * invocations even though live build state keeps moving. */
export interface WakeTurnInput {
  event: { seq: number; ts: string; type: string; payload: unknown }
  buildState: unknown
}

export interface TurnOutcome {
  kind: 'completed' | 'suspended' | 'failed'
  cause?: 'budget' | 'approval'
  failureKind?: TurnFailureKind
  usage?: { inputTokens: number; outputTokens: number; steps: number }
  error?: string
}

export interface StartTurnOptions {
  /** Remaining invocation budget in seconds (the tick's), clamping the
   * configured `invocationBudgetSeconds` for this run. The tick recomputes
   * it per session so every turn draws down the same deadline. */
  remainingBudgetSeconds?: number
}

export interface StartTurnResult {
  /** False when the session was not idle (or the CAS lost the race) — no
   * turn was started and no loop is running. */
  started: boolean
  turn?: string
  stream?: string
  /** The running loop's outcome. The caller decides to await it (the tick)
   * or background it (the operator route via `after()`); the promise starts
   * executing immediately either way. */
  outcome?: Promise<TurnOutcome>
}

export interface ResumeTurnOptions {
  /** When the turn was suspended for approval and the operator has answered:
   * the decision and the answered tool call id. The runner recovers the
   * request's wire `approvalId` from the open stream and appends the
   * protocol's `tool-approval-response` part so the SDK's resume path
   * executes (approve) or synthesizes the denied output (deny). */
  approval?: { decision: 'approve' | 'deny'; toolCallId: string }
  /** Remaining invocation budget in seconds (the tick's), clamping the
   * configured `invocationBudgetSeconds` for this run. */
  remainingBudgetSeconds?: number
}

export interface ResumeTurnResult {
  resumed: boolean
  outcome?: Promise<TurnOutcome>
}

export interface OrchestratorTurnRunner {
  startTurn(
    sessionId: string,
    trigger: SessionTurnTrigger,
    wake?: WakeTurnInput,
    opts?: StartTurnOptions,
  ): Promise<StartTurnResult>
  resumeTurn(sessionId: string, opts?: ResumeTurnOptions): Promise<ResumeTurnResult>
}

export interface OrchestratorRunnerOptions {
  store: BuildStore
  registry: OperatorToolRegistry
  /** The repository this runner serves; the session's repository must match. */
  repo: string
  config: Config
  clock: Clock
  ids: IdSource
  /** Injected language model; defaults to the configured gateway model. */
  model?: LanguageModel
  /** Remaining invocation budget in seconds (the tick's), clamping the
   * configured `invocationBudgetSeconds` for turns this runner starts. */
  remainingBudgetSeconds?: number
  /** The agent's in-turn retry bound. Default 2 (the plan's bound); tests
   * pass 0 to keep model-failure cases fast. */
  maxRetries?: number
}

/** The agent actor every turn fact carries. */
function turnActor(turn: string) {
  return agentActor('orchestrator', turn)
}

/** The session's reduced state and its event log's last sequence — the CAS
 * expectation for the runner's own appends. */
async function reduceSessionState(
  store: BuildStore,
  sessionId: string,
): Promise<{ state: ReturnType<typeof reduceSession>; lastSeq: number }> {
  const events = await store.getSessionEvents(sessionId)
  const state = reduceSession(events)
  const lastSeq = events.length > 0 ? (events[events.length - 1]?.seq ?? 0) : 0
  return { state, lastSeq }
}

export function createOrchestratorTurnRunner(
  options: OrchestratorRunnerOptions,
): OrchestratorTurnRunner {
  const { store, registry, repo, config, clock, ids } = options
  const approvals = parseApprovalEntries(config.orchestrator.approvals)
  const approvalConfig = approvalConfiguration(approvals)
  const budgetSeconds = Math.min(
    config.orchestrator.invocationBudgetSeconds,
    ORCHESTRATOR_ROUTE_LIMIT_SECONDS,
  )

  function modelFor(): LanguageModel {
    return options.model ?? resolveGatewayModel(config.orchestrator.model ?? '')
  }

  /** The invocation deadline: min(configured budget, caller-supplied
   * remaining budget) in wall-clock milliseconds from now. */
  function deadlineMs(remainingBudgetSeconds?: number): number {
    const effective =
      remainingBudgetSeconds === undefined
        ? budgetSeconds
        : Math.max(0, Math.min(budgetSeconds, remainingBudgetSeconds))
    return clock().getTime() + effective * 1000
  }

  /** Append one agent session fact; the store validates and sequences it. */
  function append<T extends SessionEventType>(
    sessionId: string,
    turn: string,
    type: T,
    payload: SessionEventWrite<T>['payload'],
  ): Promise<SessionEventEnvelope<T>> {
    return store.appendSessionEvent(sessionId, {
      actor: turnActor(turn),
      type,
      payload,
    }) as Promise<SessionEventEnvelope<T>>
  }

  // ── The agent loop ────────────────────────────────────────────────────────

  async function runLoop(
    sessionId: string,
    operator: string,
    turn: string,
    streamId: string,
    deadline: number,
  ): Promise<TurnOutcome> {
    const sink = createSessionStreamSink({
      store,
      scope: { kind: 'session', session: sessionId },
    })
    await sink.resume(streamId)

    // Durable reconstruction — identical model input across invocations.
    const events = await store.getSessionEvents(sessionId)
    const conversation = await reconstructConversation(store, sessionId, events)
    const state = reduceSession(events)
    const system = await buildTurnSystemPrompt({
      store,
      repo,
      wakeGlobs: state.wakeGlobs,
      config: config.orchestrator,
    })

    // Tool-call inputs, remembered as their `tool-input-available` parts pass
    // so an approval request can name what the model asked to run.
    const toolInputs = new Map<string, { toolName: string; input: unknown }>()
    let approvalRequest: { toolCallId: string; toolName: string; input: unknown } | undefined
    let budgetFired = false

    const via: Via = { kind: 'session', id: sessionId }
    const tools = registryTools({ registry, repo, operator, via })
    const agent = new ToolLoopAgent({
      model: modelFor(),
      instructions: system,
      tools,
      toolApproval: approvalConfig,
      maxRetries: options.maxRetries ?? 2,
      stopWhen: [
        (_loopState) => {
          if (clock().getTime() >= deadline - ORCHESTRATOR_FLUSH_MARGIN_SECONDS * 1000) {
            budgetFired = true
            return true
          }
          return false
        },
        isStepCount(ORCHESTRATOR_MAX_STEPS),
      ],
      onStepEnd: async () => {
        // The checkpoint: everything streamed so far is durable before the
        // next step starts.
        await sink.flush()
      },
    })

    const abortController = new AbortController()
    const abortTimer = setTimeout(
      () => abortController.abort(new Error('orchestrator invocation deadline exceeded')),
      Math.max(0, deadline - clock().getTime()),
    )
    abortTimer.unref?.()

    // The SDK surfaces model failures as `error` parts on the full stream
    // (never a thrown error), carrying the ORIGINAL error object — the UI
    // chunk reduces it to a generic errorText, so the loop consumes the raw
    // stream and maps each part through `toUIMessageChunk` itself: typed
    // classification sees the real error class, the sink still stores
    // protocol chunks.
    try {
      const result = await agent.stream({
        messages: await convertToModelMessages(conversation.messages),
        abortSignal: abortController.signal,
      })
      for await (const part of result.stream) {
        if (part.type === 'error') {
          throw part.error
        }
        const chunk = toUIMessageChunk(part as never, { tools: tools as never })
        if (chunk === undefined) continue
        sink.append([chunk as unknown as StreamPart])
        if (chunk.type === 'tool-input-available') {
          toolInputs.set(chunk.toolCallId, {
            toolName: chunk.toolName as string,
            input: chunk.input,
          })
        } else if (chunk.type === 'tool-approval-request') {
          const known = toolInputs.get(chunk.toolCallId)
          approvalRequest = {
            toolCallId: chunk.toolCallId,
            toolName: known?.toolName ?? 'unknown',
            input: known?.input ?? {},
          }
        }
      }
      clearTimeout(abortTimer)

      // An approval request suspends the turn for the operator; a budget stop
      // suspends it for the next invocation; otherwise the turn completed.
      if (approvalRequest !== undefined) {
        await append(sessionId, turn, 'approval.requested', {
          turn,
          toolCallId: approvalRequest.toolCallId,
          toolName: approvalRequest.toolName,
          input: approvalRequest.input as Record<string, unknown>,
        })
        await append(sessionId, turn, 'turn.suspended', { turn, cause: 'approval' })
        return { kind: 'suspended', cause: 'approval' }
      }
      if (budgetFired || abortController.signal.aborted) {
        await append(sessionId, turn, 'turn.suspended', { turn, cause: 'budget' })
        return { kind: 'suspended', cause: 'budget' }
      }

      const totalUsage = await result.totalUsage
      const steps = await result.steps
      const usage = {
        inputTokens: totalUsage.inputTokens ?? 0,
        outputTokens: totalUsage.outputTokens ?? 0,
        steps: steps.length,
      }
      await append(sessionId, turn, 'turn.completed', { turn, usage })
      await sink.close('completed')
      return { kind: 'completed', usage }
    } catch (error) {
      clearTimeout(abortTimer)
      if (abortController.signal.aborted) {
        // A runaway step interrupted at the deadline: the durable state so
        // far is the checkpoint; the next invocation resumes it.
        await append(sessionId, turn, 'turn.suspended', { turn, cause: 'budget' })
        return { kind: 'suspended', cause: 'budget' }
      }
      const kind = classifyModelError(error)
      const message = error instanceof Error ? error.message : String(error)
      await append(sessionId, turn, 'turn.failed', { turn, kind, error: message })
      await sink.close('aborted')
      return { kind: 'failed', failureKind: kind, error: message }
    }
  }

  return {
    async startTurn(sessionId, trigger, wake, opts = {}) {
      const { state, lastSeq } = await reduceSessionState(store, sessionId)
      if (state.status !== 'idle') return { started: false }
      // Sessions with empty wake settings are never woken.
      if (trigger.kind === 'wake' && state.wakeGlobs.length === 0) return { started: false }

      const turn = ids('ot')
      // The stream is created before the CAS because the fact must name its
      // id; on a miss the just-created stream is closed aborted so a losing
      // double-click cannot leak an open stream no turn ever references (the
      // reaper only watches turns, so an orphan would otherwise live forever).
      const stream = await store.createStream(
        { kind: 'session', session: sessionId },
        `turn:${turn}`,
      )
      const payload: Record<string, unknown> = { turn, stream: stream.id, trigger }
      if (wake !== undefined) payload.wake = wake

      validateExpectedSeq(lastSeq)
      const appended = await store
        .appendSessionEventIfCurrent(sessionId, lastSeq, {
          actor: turnActor(turn),
          type: 'turn.started',
          payload,
        } as unknown as SessionEventWrite<'turn.started'>)
        .catch(() => null)
      if (appended === null) {
        await store.closeStream(stream.id, 'aborted').catch(() => undefined)
        return { started: false }
      }

      const record = await store.getSession(sessionId)
      const outcome = runLoop(
        sessionId,
        record?.operator ?? '',
        turn,
        stream.id,
        deadlineMs(opts.remainingBudgetSeconds ?? options.remainingBudgetSeconds),
      )
      return { started: true, turn, stream: stream.id, outcome }
    },

    async resumeTurn(sessionId, opts = {}) {
      const { state, lastSeq } = await reduceSessionState(store, sessionId)
      if (state.status !== 'suspended') return { resumed: false }
      if (state.pendingApproval !== undefined) return { resumed: false }
      const open = state.openTurn
      if (open === undefined) return { resumed: false }

      if (opts.approval !== undefined) {
        const recovered = await recoverApprovalResponse(store, open.stream, opts.approval)
        if (recovered === null) {
          // A missing request part (e.g. dropped by assembly) fails the
          // resume with a typed failure rather than proceeding without it.
          await append(sessionId, open.turn, 'turn.failed', {
            turn: open.turn,
            kind: 'internal',
            error: `approval answer for tool call ${JSON.stringify(opts.approval.toolCallId)} matches no persisted approval request`,
          })
          // The failed resume is terminal, so the turn's stream closes here
          // like every other terminal path — the reaper only watches running
          // turns and would otherwise never close it. Closing an
          // already-closed stream is a contract-pinned no-op, so the
          // non-open-stream leg of recoverApprovalResponse's null is covered
          // too.
          await store.closeStream(open.stream, 'aborted').catch(() => undefined)
          return { resumed: false }
        }
      }

      validateExpectedSeq(lastSeq)
      const appended = await store
        .appendSessionEventIfCurrent(sessionId, lastSeq, {
          actor: turnActor(open.turn),
          type: 'turn.resumed',
          payload: { turn: open.turn },
        } as unknown as SessionEventWrite<'turn.resumed'>)
        .catch(() => null)
      if (appended === null) return { resumed: false }

      const record = await store.getSession(sessionId)
      const outcome = runLoop(
        sessionId,
        record?.operator ?? '',
        open.turn,
        open.stream,
        deadlineMs(opts.remainingBudgetSeconds),
      )
      return { resumed: true, outcome }
    },
  }
}

/** Scan the open turn's stream for the `tool-approval-request` part whose
 * top-level `toolCallId` matches the answered call, and append the protocol's
 * `tool-approval-response` part. The persisted parts are UI message stream
 * chunks — the SDK flattens the internal approval request into a chunk with
 * the call id at the top level, and no `toolCall` property exists on the
 * stored chunk — and neither `approval.requested` nor the answer event
 * carries the wire `approvalId`, so the stream is its durable home. A deny
 * response makes the SDK synthesize the denied tool output. Returns null
 * (appending nothing) when no request part matches. */
async function recoverApprovalResponse(
  store: BuildStore,
  streamId: string,
  answer: { decision: 'approve' | 'deny'; toolCallId: string },
): Promise<{ approvalId: string } | null> {
  const read = await store.readStream(streamId)
  if (read.status !== 'open') return null
  let approvalId: string | undefined
  for (const chunk of read.chunks) {
    for (const part of chunk.parts) {
      if (
        part.type === 'tool-approval-request' &&
        part.toolCallId === answer.toolCallId &&
        typeof part.approvalId === 'string'
      ) {
        approvalId = part.approvalId
      }
    }
  }
  if (approvalId === undefined) return null
  await store.appendStreamParts(streamId, [
    {
      type: 'tool-approval-response',
      approvalId,
      approved: answer.decision === 'approve',
    },
  ])
  return { approvalId }
}
