/**
 * The orchestrator turn runner against the memory store, the registry over
 * the same store, and the AI SDK's mock language model: the plain turn, the
 * two-tool-call turn with attributed writes, budget suspension and resume
 * with identical reconstructed input, approval approve/deny, the typed
 * failures, and the CAS race.
 */
import { describe, expect, test } from 'bun:test'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import {
  GatewayAuthenticationError,
  GatewayInternalServerError,
  GatewayModelNotFoundError,
  GatewayRateLimitError,
} from '@ai-sdk/gateway'
import { parseConfig } from '../config/load'
import { humanActor } from '../events/envelope'
import { MemoryBuildStore } from '../store/memory'
import type { Clock } from '../store/types'
import { sequentialIds } from '../ids'
import { buildRegistry } from '../operator/registry'
import { reduceSession } from '../store/session-reducer'
import { createOrchestratorTurnRunner, type TurnFailureKind } from './turn-runner'

const REPO = 'acme/widgets'

function manualClock(
  startMs = Date.parse('2026-09-15T00:00:00Z'),
): Clock & { advance: (ms: number) => void } {
  let now = startMs
  const clock = (() => new Date(now)) as Clock & { advance: (ms: number) => void }
  clock.advance = (ms) => {
    now += ms
  }
  return clock
}

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens: {
    total: inputTokens,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: outputTokens,
    text: undefined,
    reasoning: undefined,
    toolCall: undefined,
  },
  totalTokens: inputTokens + outputTokens,
})

/** One provider stream chunk. The mock is typed structurally here: core does
 * not depend on @ai-sdk/provider directly, and the shapes the runner tests
 * drive are small and pinned by the SDK's own schema. */
type MockStreamPart = { type: string } & Record<string, unknown>

const finish = (reason: 'stop' | 'tool-calls', tokens = usage(10, 5)): MockStreamPart => ({
  type: 'finish',
  finishReason: { unified: reason, raw: reason },
  usage: tokens,
})

const textStep = (id: string, text: string): MockStreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id, modelId: 'mock', timestamp: new Date(0) },
  { type: 'text-start', id },
  { type: 'text-delta', id, delta: text },
  { type: 'text-end', id },
  finish('stop'),
]

const toolCallStep = (
  id: string,
  toolCallId: string,
  toolName: string,
  input: string,
): MockStreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id, modelId: 'mock', timestamp: new Date(0) },
  { type: 'tool-input-start', id: toolCallId, toolName },
  { type: 'tool-input-delta', id: toolCallId, delta: input },
  { type: 'tool-input-end', id: toolCallId },
  { type: 'tool-call', toolCallId, toolName, input },
  finish('tool-calls'),
]

/** A mock whose nth doStream call returns the nth step sequence, advancing
 * the clock by `advanceMs` per call. 300_000 (the default in budget tests)
 * exhausts the 240 s budget after the first step; tests that must complete
 * pass a small advance. */
function stepwiseModel(
  clock: ReturnType<typeof manualClock>,
  steps: MockStreamPart[][],
  advanceMs = 1_000,
): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      const index = call++
      clock.advance(advanceMs)
      const step = steps[Math.min(index, steps.length - 1)]!
      return {
        stream: simulateReadableStream({ chunks: step as never, initialDelayInMs: 0 }),
      }
    },
  })
}

function orchestratorConfig(approvals: string[] = []) {
  return parseConfig(`
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = []
[finalize]
steps = []
[orchestrator]
enabled = true
model = "test/mock"
invocationBudgetSeconds = 240
approvals = [${approvals.map((entry) => JSON.stringify(entry)).join(', ')}]
`)
}

async function sessionWithMessage(store: MemoryBuildStore, text = 'hello orchestrator') {
  await store.ensureRepo(REPO)
  const session = await store.createSession({ repo: REPO, operator: 'op' })
  await store.appendSessionEvent(session.id, {
    actor: humanActor('op'),
    type: 'message.posted',
    payload: { text },
  })
  return session.id
}

function runnerFor(
  store: MemoryBuildStore,
  clock: ReturnType<typeof manualClock>,
  model: MockLanguageModelV3,
  approvals: string[] = [],
  runnerOptions: { maxRetries?: number } = {},
) {
  return createOrchestratorTurnRunner({
    store,
    registry: buildRegistry({ store, clock }),
    repo: REPO,
    config: orchestratorConfig(approvals),
    clock,
    ids: sequentialIds(),
    model,
    ...runnerOptions,
  })
}

async function eventTypes(store: MemoryBuildStore, sessionId: string) {
  return (await store.getSessionEvents(sessionId)).map((event) => event.type)
}

describe('orchestrator turn runner', () => {
  test('a plain conversational turn records facts, streams parts, and completes with usage and steps', async () => {
    const store = new MemoryBuildStore({ clock: manualClock() })
    const clock = manualClock()
    const sessionId = await sessionWithMessage(store)
    const runner = runnerFor(store, clock, stepwiseModel(clock, [textStep('t1', 'Hello there.')]))

    const start = await runner.startTurn(sessionId, { kind: 'message', messageSeq: 2 })
    expect(start.started).toBe(true)
    const outcome = await start.outcome!
    expect(outcome).toEqual({
      kind: 'completed',
      usage: { inputTokens: 10, outputTokens: 5, steps: 1 },
    })

    expect(await eventTypes(store, sessionId)).toEqual([
      'session.created',
      'message.posted',
      'turn.started',
      'turn.completed',
    ])
    const state = reduceSession(await store.getSessionEvents(sessionId))
    expect(state.status).toBe('idle')
    expect(state.openTurn).toBeUndefined()
    expect(state.turns[0]).toMatchObject({
      state: 'completed',
      usage: { inputTokens: 10, outputTokens: 5, steps: 1 },
      trigger: { kind: 'message', messageSeq: 2 },
    })

    // The turn's stream closed completed and carries the protocol parts.
    const turn = state.turns[0]!
    const record = await store.getStream(turn.stream)
    expect(record?.status).toBe('closed')
    expect(record?.outcome).toBe('completed')
    const read = await store.readStream(turn.stream)
    const types = read.chunks.flatMap((chunk) => chunk.parts.map((part) => part.type))
    expect(types).toContain('start')
    expect(types).toContain('text-delta')
    expect(types).toContain('finish')
    expect(types).not.toContain('tool-input-available')
  })

  test('a two-tool-call turn lands tool parts, attributed registry writes, and repo-free model schemas', async () => {
    const store = new MemoryBuildStore({ clock: manualClock() })
    const clock = manualClock()
    const sessionId = await sessionWithMessage(store)
    const model = stepwiseModel(clock, [
      toolCallStep('t1', 'c1', 'notes.write', JSON.stringify({ document: 'remember this' })),
      toolCallStep('t2', 'c2', 'repository.status', '{}'),
      textStep('t3', 'Done.'),
    ])
    const runner = runnerFor(store, clock, model)

    const start = await runner.startTurn(sessionId, { kind: 'message', messageSeq: 2 })
    const outcome = await start.outcome!
    expect(outcome.kind).toBe('completed')
    expect(outcome.usage?.steps).toBe(3)

    // The registry write happened against the session's repository even
    // though the model never supplied a repo, and the artifact metadata
    // carries the operator with the session via marker.
    const artifact = await store.getRepoArtifact(REPO, 'operator-notes')
    expect(artifact).not.toBeNull()
    expect(new TextDecoder().decode(artifact!.content)).toBe('remember this')
    expect(artifact!.meta.metadata).toMatchObject({
      user: 'op',
      via: { kind: 'session', id: sessionId },
    })

    // The turn's stream carries tool input and output parts for both calls.
    const state = reduceSession(await store.getSessionEvents(sessionId))
    const read = await store.readStream(state.turns[0]!.stream)
    const parts = read.chunks.flatMap((chunk) => chunk.parts)
    const inputs = parts.filter((part) => part.type === 'tool-input-available')
    const outputs = parts.filter((part) => part.type === 'tool-output-available')
    expect(inputs.map((part) => part.toolName)).toEqual(['notes.write', 'repository.status'])
    expect(outputs).toHaveLength(2)
    expect(outputs[0]!.output).toMatchObject({ revision: 0 })

    // The model-facing tool schemas carry no repo field: the model is never
    // asked for a value it cannot know.
    const sentTools = (model.doStreamCalls[0]!.tools ?? []) as Array<{
      name: string
      inputSchema: unknown
    }>
    const notesWrite = sentTools.find((tool) => tool.name === 'notes.write')
    expect(notesWrite).toBeDefined()
    expect(JSON.stringify(notesWrite!.inputSchema)).not.toContain('"repo"')
    // The executed handler saw the session's repository (the artifact landed
    // there), and the registry's allowedRepo guard is bound to it.
  })

  test('a registry refusal comes back as a tool result the model can react to, not a dead step', async () => {
    const store = new MemoryBuildStore({ clock: manualClock() })
    const clock = manualClock()
    const sessionId = await sessionWithMessage(store)
    const runner = runnerFor(
      store,
      clock,
      stepwiseModel(clock, [
        toolCallStep('t1', 'c1', 'builds.get', JSON.stringify({ slug: 'no-such-build' })),
        textStep('t2', 'That build does not exist.'),
      ]),
    )
    const start = await runner.startTurn(sessionId, { kind: 'message', messageSeq: 2 })
    const outcome = await start.outcome!
    expect(outcome.kind).toBe('completed')
    const state = reduceSession(await store.getSessionEvents(sessionId))
    const read = await store.readStream(state.turns[0]!.stream)
    const output = read.chunks
      .flatMap((chunk) => chunk.parts)
      .find((part) => part.type === 'tool-output-available')
    expect(output).toMatchObject({ toolCallId: 'c1', output: { kind: 'not-found' } })
  })

  test('budget suspension resumes with identical reconstructed input, appending a mid-suspension message after the checkpoint', async () => {
    const store = new MemoryBuildStore({ clock: manualClock() })
    const clock = manualClock()
    const sessionId = await sessionWithMessage(store)

    // Control run, no budget pressure: two model calls — a tool call, then
    // the final text. The second call's prompt is what a continuation of the
    // same conversation must reproduce verbatim.
    const controlClock = manualClock()
    const controlModel = stepwiseModel(controlClock, [
      toolCallStep('t1', 'c1', 'repository.status', '{}'),
      textStep('t2', 'All good.'),
    ])
    const controlRunner = runnerFor(store, controlClock, controlModel)
    const controlSession = await sessionWithMessage(store)
    const controlStart = await controlRunner.startTurn(controlSession, {
      kind: 'message',
      messageSeq: 2,
    })
    await controlStart.outcome!
    const continuationPrompt = controlModel.doStreamCalls[1]!.prompt

    // Budget run: the same first step, but the clock advance (300 s per
    // call) exhausts the 240 s budget after the first step.
    const budgetModel = stepwiseModel(
      clock,
      [toolCallStep('t1', 'c1', 'repository.status', '{}'), textStep('t2', 'All good.')],
      300_000,
    )
    const runner = runnerFor(store, clock, budgetModel)
    const start = await runner.startTurn(sessionId, { kind: 'message', messageSeq: 2 })
    const suspended = await start.outcome!
    expect(suspended).toEqual({ kind: 'suspended', cause: 'budget' })

    let state = reduceSession(await store.getSessionEvents(sessionId))
    expect(state.status).toBe('suspended')
    expect(state.suspendedCause).toBe('budget')
    // The stream stays open — it is the resume checkpoint.
    expect(await store.getStream(state.turns[0]!.stream)).toMatchObject({ status: 'open' })

    // A message lands while the turn is suspended.
    await store.appendSessionEvent(sessionId, {
      actor: humanActor('op'),
      type: 'message.posted',
      payload: { text: 'and also check the tickets' },
    })

    const resumed = await runner.resumeTurn(sessionId)
    expect(resumed.resumed).toBe(true)
    const outcome = await resumed.outcome!
    expect(outcome.kind).toBe('completed')

    state = reduceSession(await store.getSessionEvents(sessionId))
    expect(state.status).toBe('idle')
    expect(state.turns[0]!.state).toBe('completed')

    // Identical model input: the resumed invocation's first prompt equals
    // the control continuation verbatim, with the mid-suspension message
    // appended after the checkpoint as a plain next user message.
    const resumedPrompt = budgetModel.doStreamCalls[1]!.prompt
    expect(resumedPrompt).toEqual([
      ...continuationPrompt,
      { role: 'user', content: [{ type: 'text', text: 'and also check the tickets' }] },
    ])
  })

  test('an approval-listed tool suspends the turn; approve executes the call', async () => {
    const store = new MemoryBuildStore({ clock: manualClock() })
    const clock = manualClock()
    const sessionId = await sessionWithMessage(store)
    const model = stepwiseModel(clock, [
      toolCallStep('t1', 'c1', 'notes.write', JSON.stringify({ document: 'approved note' })),
      textStep('t2', 'Done with your approval.'),
    ])
    const runner = runnerFor(store, clock, model, ['notes.write'])

    const start = await runner.startTurn(sessionId, { kind: 'message', messageSeq: 2 })
    const suspended = await start.outcome!
    expect(suspended).toEqual({ kind: 'suspended', cause: 'approval' })

    let state = reduceSession(await store.getSessionEvents(sessionId))
    expect(state.status).toBe('awaiting-approval')
    expect(state.pendingApproval).toMatchObject({
      turn: state.turns[0]!.turn,
      toolCallId: 'c1',
      toolName: 'notes.write',
      input: { document: 'approved note' },
    })
    // The approval.requested fact precedes the suspension.
    expect(await eventTypes(store, sessionId)).toEqual([
      'session.created',
      'message.posted',
      'turn.started',
      'approval.requested',
      'turn.suspended',
    ])
    // The protocol's tool-approval-request part is on the stream, with the
    // call id at the top level.
    const requestPart = (await store.readStream(state.turns[0]!.stream)).chunks
      .flatMap((chunk) => chunk.parts)
      .find((part) => part.type === 'tool-approval-request')
    expect(requestPart).toMatchObject({ toolCallId: 'c1' })
    expect(typeof requestPart!.approvalId).toBe('string')

    // The operator answers approve; the runner resumes and the call executes.
    await store.appendSessionEvent(sessionId, {
      actor: humanActor('op'),
      type: 'approval.answered',
      payload: { turn: state.turns[0]!.turn, toolCallId: 'c1', decision: 'approve' },
    })
    const resumed = await runner.resumeTurn(sessionId, {
      approval: { decision: 'approve', toolCallId: 'c1' },
    })
    expect(resumed.resumed).toBe(true)
    const outcome = await resumed.outcome!
    expect(outcome.kind).toBe('completed')

    state = reduceSession(await store.getSessionEvents(sessionId))
    expect(state.status).toBe('idle')
    const artifact = await store.getRepoArtifact(REPO, 'operator-notes')
    expect(new TextDecoder().decode(artifact!.content)).toBe('approved note')
    expect(state.turns[0]!.state).toBe('completed')
  })

  test('a denied approval resumes with a denied tool output and never executes the call', async () => {
    const store = new MemoryBuildStore({ clock: manualClock() })
    const clock = manualClock()
    const sessionId = await sessionWithMessage(store)
    const model = stepwiseModel(clock, [
      toolCallStep('t1', 'c1', 'notes.write', JSON.stringify({ document: 'must not land' })),
      textStep('t2', 'Understood — not writing that.'),
    ])
    const runner = runnerFor(store, clock, model, ['notes.write'])

    const start = await runner.startTurn(sessionId, { kind: 'message', messageSeq: 2 })
    await start.outcome!
    let state = reduceSession(await store.getSessionEvents(sessionId))
    await store.appendSessionEvent(sessionId, {
      actor: humanActor('op'),
      type: 'approval.answered',
      payload: { turn: state.turns[0]!.turn, toolCallId: 'c1', decision: 'deny' },
    })
    const resumed = await runner.resumeTurn(sessionId, {
      approval: { decision: 'deny', toolCallId: 'c1' },
    })
    expect(resumed.resumed).toBe(true)
    const outcome = await resumed.outcome!
    expect(outcome.kind).toBe('completed')

    // The notes artifact was never written.
    expect(await store.getRepoArtifact(REPO, 'operator-notes')).toBeNull()
    // The model saw the denial as the tool result.
    const denied = JSON.stringify(model.doStreamCalls[1]!.prompt)
    expect(denied).toContain('execution-denied')
    state = reduceSession(await store.getSessionEvents(sessionId))
    expect(state.status).toBe('idle')
  })

  test('each typed model failure records turn.failed with its class and leaves the session idle', async () => {
    const cases: [string, unknown, TurnFailureKind][] = [
      [
        'credentials',
        new GatewayAuthenticationError({ message: 'bad key', statusCode: 401 }),
        'credentials',
      ],
      [
        'exhausted',
        new GatewayRateLimitError({ message: 'rate limited', statusCode: 429 }),
        'exhausted',
      ],
      [
        'provider-unavailable',
        new GatewayInternalServerError({ message: 'upstream exploded', statusCode: 500 }),
        'provider-unavailable',
      ],
      [
        'configuration',
        new GatewayModelNotFoundError({ message: 'no such model', statusCode: 404 }),
        'configuration',
      ],
    ]
    for (const [name, error, kind] of cases) {
      const store = new MemoryBuildStore({ clock: manualClock() })
      const clock = manualClock()
      const sessionId = await sessionWithMessage(store)
      const model = new MockLanguageModelV3({
        doStream: async () => {
          throw error
        },
      })
      const runner = runnerFor(store, clock, model, [], { maxRetries: 0 })
      const start = await runner.startTurn(sessionId, { kind: 'message', messageSeq: 2 })
      const outcome = await start.outcome!
      expect(outcome.kind).toBe('failed')
      expect(outcome.failureKind).toBe(kind)

      const state = reduceSession(await store.getSessionEvents(sessionId))
      expect(state.status).toBe('idle')
      expect(state.openTurn).toBeUndefined()
      expect(state.turns[0]).toMatchObject({
        state: 'failed',
        kind,
        error: expect.any(String),
      } as never)
      // The failed turn's stream closed aborted.
      expect(await store.getStream(state.turns[0]!.stream)).toMatchObject({
        status: 'closed',
        outcome: 'aborted',
      })
      expect(await eventTypes(store, sessionId)).toContain('turn.failed')
      void name
    }
  })

  test("a CAS race between two concurrent starts yields one winner and closes the loser's stream aborted", async () => {
    const store = new MemoryBuildStore({ clock: manualClock() })
    const clock = manualClock()
    const sessionId = await sessionWithMessage(store)
    const model = stepwiseModel(clock, [textStep('t1', 'Hello there.')])
    const runner = runnerFor(store, clock, model)

    const [first, second] = await Promise.all([
      runner.startTurn(sessionId, { kind: 'message', messageSeq: 2 }),
      runner.startTurn(sessionId, { kind: 'message', messageSeq: 2 }),
    ])
    const winner = first.started ? first : second
    const loser = first.started ? second : first
    expect(winner.started).toBe(true)
    expect(loser.started).toBe(false)

    await winner.outcome!
    // Exactly one turn.started fact, and the loser's stream is closed
    // aborted — no orphan open stream no turn ever references.
    const started = (await store.getSessionEvents(sessionId)).filter(
      (event) => event.type === 'turn.started',
    )
    expect(started).toHaveLength(1)
    const streams = await store.listStreams({ kind: 'session', session: sessionId })
    const loserStream = streams.find((record) => record.id !== winner.stream)
    expect(loserStream).toBeDefined()
    expect(loserStream).toMatchObject({ status: 'closed', outcome: 'aborted' })
  })

  test('a wake turn reconstructs its frozen input across invocations', async () => {
    const store = new MemoryBuildStore({ clock: manualClock() })
    const clock = manualClock()
    await store.ensureRepo(REPO)
    const sessionId = await store.createSession({ repo: REPO, operator: 'op' }).then((s) => s.id)
    await store.appendSessionEvent(sessionId, {
      actor: humanActor('op'),
      type: 'session.wake-set',
      payload: { globs: ['escalation.raised'] },
    })
    const model = stepwiseModel(
      clock,
      [toolCallStep('t1', 'c1', 'repository.status', '{}'), textStep('t2', 'On it.')],
      300_000,
    )
    const runner = runnerFor(store, clock, model)

    const wake = {
      event: {
        seq: 7,
        ts: '2026-09-15T00:01:00Z',
        type: 'escalation.raised',
        payload: { reason: 'spec gate', build: 'b1' },
      },
      buildState: { status: 'blocked', slug: 'b1', lastSeq: 7 },
    }
    const start = await runner.startTurn(
      sessionId,
      { kind: 'wake', build: 'b1', seq: 7, type: 'escalation.raised' },
      wake,
    )
    expect(start.started).toBe(true)
    // Budget fires after the first step (clock advances 300 s per call).
    const suspended = await start.outcome!
    expect(suspended).toEqual({ kind: 'suspended', cause: 'budget' })

    const resumed = await runner.resumeTurn(sessionId)
    await resumed.outcome!
    // The resumed prompt still carries the frozen wake input — the event
    // record and the build state snapshot — reconstructed from the
    // turn.started payload alone.
    const resumedJson = JSON.stringify(model.doStreamCalls[1]!.prompt)
    expect(resumedJson).toContain('escalation.raised')
    expect(resumedJson).toContain('blocked')
    // The wake cursor advanced through the recorded trigger.
    const state = reduceSession(await store.getSessionEvents(sessionId))
    expect(state.wakeCursors).toEqual({ b1: 7 })
  })
})
