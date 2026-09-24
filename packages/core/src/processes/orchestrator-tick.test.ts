/**
 * The dispatcher tick's orchestrator step (AUT-342): resume, reaper, and
 * wake — against the memory store, the fake ticket source, and the mock
 * language model. The two construction gates (origin mode, effective
 * config) are asserted separately through the Dispatcher at the bottom.
 */
import { describe, expect, test } from 'bun:test'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { parseConfig } from '../config/load'
import { agentActor, humanActor, DISPATCHER } from '../events/envelope'
import { FakeTicketSource } from '../ports/tickets/fake'
import { MemoryBuildStore } from '../store/memory'
import type { Clock } from '../store/types'
import { sequentialIds } from '../ids'
import { reduceSession } from '../store/session-reducer'
import { runOrchestratorTickStep } from './orchestrator-tick'

const REPO = 'https://github.com/acme/widgets'

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

type MockStreamPart = { type: string } & Record<string, unknown>

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

const textStep = (text: string): MockStreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id: 't', modelId: 'mock', timestamp: new Date(0) },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: text },
  { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(10, 5) },
]

const toolCallStep = (toolCallId: string, toolName: string, input: string): MockStreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id: 't', modelId: 'mock', timestamp: new Date(0) },
  { type: 'tool-input-start', id: toolCallId, toolName },
  { type: 'tool-input-delta', id: toolCallId, delta: input },
  { type: 'tool-input-end', id: toolCallId },
  { type: 'tool-call', toolCallId, toolName, input },
  {
    type: 'finish',
    finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
    usage: usage(10, 5),
  },
]

function textModel(): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: textStep(`turn ${++call}`) as never,
        initialDelayInMs: 0,
      }),
    }),
  })
}

function sequenceModel(steps: MockStreamPart[][]): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: steps[Math.min(call++, steps.length - 1)]! as never,
        initialDelayInMs: 0,
      }),
    }),
  })
}

function tickConfig(wake?: string[]) {
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
${wake === undefined ? '' : `wake = [${wake.map((glob) => JSON.stringify(glob)).join(', ')}]`}
`)
}

function tickOptions(
  store: MemoryBuildStore,
  clock: ReturnType<typeof manualClock>,
  model: MockLanguageModelV3,
  config = tickConfig(),
) {
  return {
    store,
    repo: REPO,
    config,
    clock,
    ids: sequentialIds(),
    tickets: new FakeTicketSource([]),
    model,
  }
}

async function seedSession(
  store: MemoryBuildStore,
  clock: Clock,
  opts: { operator?: string; wake?: string[] } = {},
): Promise<string> {
  await store.ensureRepo(REPO)
  const session = await store.createSession({ repo: REPO, operator: opts.operator ?? 'op' })
  if (opts.wake !== undefined) {
    await store.appendSessionEvent(session.id, {
      actor: humanActor('op'),
      type: 'session.wake-set',
      payload: { globs: opts.wake },
    })
  }
  void clock
  return session.id
}

async function seedBuild(
  store: MemoryBuildStore,
  slug: string,
  opts: { escalate?: boolean } = {},
): Promise<void> {
  await store.createBuild({ slug, repo: REPO, branch: 'ab/x' })
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      ticket: { source: 'fake', id: 'T-1', title: 'T' },
      repo: REPO,
      baseBranch: 'main',
    },
  })
  if (opts.escalate) {
    await store.append(slug, {
      actor: agentActor('implement', 'session-x'),
      type: 'escalation.raised',
      payload: { id: 'e1', phase: 'implement', round: 1, source: 'agent', question: 'Which way?' },
    })
  }
}

describe('orchestrator tick step', () => {
  test('a wake on an escalation event starts one turn and advances the cursor through the recorded trigger', async () => {
    const store = new MemoryBuildStore({ clock: manualClock() })
    const clock = manualClock()
    const sessionId = await seedSession(store, clock, { wake: ['escalation.raised'] })
    await seedBuild(store, 'b1', { escalate: true })

    const report = await runOrchestratorTickStep(tickOptions(store, clock, textModel()))
    expect(report.woken).toBe(1)

    const state = reduceSession(await store.getSessionEvents(sessionId))
    expect(state.status).toBe('idle') // the wake turn completed
    expect(state.wakeCursors).toEqual({ b1: 2 })
    const started = (await store.getSessionEvents(sessionId)).find(
      (event) => event.type === 'turn.started',
    )
    expect(started).toBeDefined()
    if (started?.type !== 'turn.started') throw new Error('unreachable')
    expect(started.payload.trigger).toMatchObject({
      kind: 'wake',
      build: 'b1',
      seq: 2,
      type: 'escalation.raised',
    })
    // The delivered input is frozen into the fact: the event record and the
    // build's reduced state.
    expect(started.payload.wake).toBeDefined()
    expect(JSON.stringify(started.payload.wake)).toContain('Which way?')
    // The turn's model saw the wake input as its user message.
    // (sequence covered by the runner tests; here the durable fact is the pin.)
  })

  test('sessions with empty wake settings are never woken; other builds re-trigger on later ticks', async () => {
    const store = new MemoryBuildStore({ clock: manualClock() })
    const clock = manualClock()
    // No wake-set fact → wakeGlobs [] → message-only.
    const messageOnly = await seedSession(store, clock)
    // Explicit empty wake-set → never wake.
    const neverWake = await store.createSession({ repo: REPO, operator: 'op2' })
    await store.appendSessionEvent(neverWake.id, {
      actor: humanActor('op2'),
      type: 'session.wake-set',
      payload: { globs: [] },
    })
    await seedBuild(store, 'b1', { escalate: true })

    const report = await runOrchestratorTickStep(tickOptions(store, clock, textModel()))
    expect(report.woken).toBe(0)
    for (const id of [messageOnly, neverWake.id]) {
      expect(reduceSession(await store.getSessionEvents(id)).turns).toHaveLength(0)
    }

    // A woken session does not re-wake from the same event, but a matching
    // event on ANOTHER build does.
    const woken = await seedSession(store, clock, { wake: ['escalation.raised'] })
    await seedBuild(store, 'b2', { escalate: true })
    const first = await runOrchestratorTickStep(tickOptions(store, clock, textModel()))
    expect(first.woken).toBe(1)
    const second = await runOrchestratorTickStep(tickOptions(store, clock, textModel()))
    expect(second.woken).toBe(1) // b2's event, not b1's again
    const state = reduceSession(await store.getSessionEvents(woken))
    expect(state.wakeCursors).toEqual({ b1: 2, b2: 2 })
  })

  test('a budget-suspended turn resumes and completes; an answered approval resumes too', async () => {
    const store = new MemoryBuildStore({ clock: manualClock() })
    const clock = manualClock()
    await store.ensureRepo(REPO)

    // Seed the durable shape the resume pass reads — exactly what the runner
    // records (pinned by the runner tests): an open turn suspended for
    // budget, its stream carrying the checkpoint.
    const budget = await store.createSession({ repo: REPO, operator: 'op' })
    const budgetStream = await store.createStream(
      { kind: 'session', session: budget.id },
      'turn:ot_budget',
    )
    await store.appendStreamParts(budgetStream.id, [
      { type: 'start', messageId: 'm1' },
      { type: 'text-delta', id: 't1', delta: 'halfway' },
    ])
    for (const event of [
      { actor: humanActor('op'), type: 'message.posted' as const, payload: { text: 'go' } },
      {
        actor: agentActor('orchestrator', 'ot_budget'),
        type: 'turn.started' as const,
        payload: {
          turn: 'ot_budget',
          stream: budgetStream.id,
          trigger: { kind: 'message' as const, messageSeq: 2 },
        },
      },
      {
        actor: agentActor('orchestrator', 'ot_budget'),
        type: 'turn.suspended' as const,
        payload: { turn: 'ot_budget', cause: 'budget' as const },
      },
    ]) {
      await store.appendSessionEvent(budget.id, event)
    }

    // An answered approval: suspended(approval), request recorded, answer
    // appended (pendingApproval cleared), and the resuming invocation died —
    // the tick is the fallback.
    const approval = await store.createSession({ repo: REPO, operator: 'op' })
    const approvalStream = await store.createStream(
      { kind: 'session', session: approval.id },
      'turn:ot_appr',
    )
    await store.appendStreamParts(approvalStream.id, [
      { type: 'start', messageId: 'm1' },
      { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'c1' },
    ])
    for (const event of [
      { actor: humanActor('op'), type: 'message.posted' as const, payload: { text: 'go' } },
      {
        actor: agentActor('orchestrator', 'ot_appr'),
        type: 'turn.started' as const,
        payload: {
          turn: 'ot_appr',
          stream: approvalStream.id,
          trigger: { kind: 'message' as const, messageSeq: 2 },
        },
      },
      {
        actor: agentActor('orchestrator', 'ot_appr'),
        type: 'turn.suspended' as const,
        payload: { turn: 'ot_appr', cause: 'approval' as const },
      },
      {
        actor: agentActor('orchestrator', 'ot_appr'),
        type: 'approval.requested' as const,
        payload: { turn: 'ot_appr', toolCallId: 'c1', toolName: 'notes.write', input: {} },
      },
      {
        actor: humanActor('op'),
        type: 'approval.answered' as const,
        payload: { turn: 'ot_appr', toolCallId: 'c1', decision: 'approve' as const },
      },
    ]) {
      await store.appendSessionEvent(approval.id, event)
    }

    const report = await runOrchestratorTickStep(tickOptions(store, clock, textModel()))
    expect(report.resumed).toBe(2)

    const budgetState = reduceSession(await store.getSessionEvents(budget.id))
    expect(budgetState.status).toBe('idle')
    expect(budgetState.turns[0]).toMatchObject({ state: 'completed' })
    const approvalState = reduceSession(await store.getSessionEvents(approval.id))
    expect(approvalState.status).toBe('idle')
    expect(approvalState.turns[0]).toMatchObject({ state: 'completed' })
    // The approval resume recovered the wire approvalId from the persisted
    // request part and appended the response before running the loop.
    const parts = (await store.readStream(approvalStream.id)).chunks.flatMap((c) => c.parts)
    expect(parts.some((part) => part.type === 'tool-approval-response')).toBe(true)
  })

  test('the reaper fails a stale running turn but never touches suspended or awaiting-approval sessions', async () => {
    const store = new MemoryBuildStore({ clock: manualClock() })
    const clock = manualClock()
    await store.ensureRepo(REPO)

    // A stale running session: turn started, stream written, then silence.
    const stale = await store.createSession({ repo: REPO, operator: 'op' })
    const staleStream = await store.createStream(
      { kind: 'session', session: stale.id },
      'turn:ot_stale',
    )
    await store.appendStreamParts(staleStream.id, [{ type: 'start', messageId: 'm1' }])
    await store.appendSessionEvent(stale.id, {
      actor: agentActor('orchestrator', 'ot_stale'),
      type: 'turn.started',
      payload: {
        turn: 'ot_stale',
        stream: staleStream.id,
        trigger: { kind: 'message', messageSeq: 1 },
      },
    })

    // A suspended-for-approval session whose stream is equally stale: the
    // operator may take arbitrarily long, so the reaper must leave it alone.
    const approval = await store.createSession({ repo: REPO, operator: 'op' })
    const approvalStream = await store.createStream(
      { kind: 'session', session: approval.id },
      'turn:ot_appr',
    )
    await store.appendStreamParts(approvalStream.id, [
      { type: 'start', messageId: 'm1' },
      { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'c1' },
    ])
    for (const [id, turn, stream] of [[approval.id, 'ot_appr', approvalStream.id]] as const) {
      await store.appendSessionEvent(id, {
        actor: agentActor('orchestrator', turn),
        type: 'turn.started',
        payload: { turn, stream, trigger: { kind: 'message', messageSeq: 1 } },
      })
      await store.appendSessionEvent(id, {
        actor: agentActor('orchestrator', turn),
        type: 'turn.suspended',
        payload: { turn, cause: 'approval' },
      })
      await store.appendSessionEvent(id, {
        actor: agentActor('orchestrator', turn),
        type: 'approval.requested',
        payload: { turn, toolCallId: 'c1', toolName: 'notes.write', input: {} },
      })
    }

    // 16 minutes of silence.
    clock.advance(16 * 60_000)
    const report = await runOrchestratorTickStep(tickOptions(store, clock, textModel()))
    expect(report.reaped).toBe(1)

    const staleState = reduceSession(await store.getSessionEvents(stale.id))
    expect(staleState.status).toBe('idle')
    expect(staleState.turns[0]).toMatchObject({ state: 'failed' })
    expect(await store.getStream(staleStream.id)).toMatchObject({
      status: 'closed',
      outcome: 'aborted',
    })

    const approvalState = reduceSession(await store.getSessionEvents(approval.id))
    expect(approvalState.status).toBe('awaiting-approval')
    expect(approvalState.pendingApproval).toBeDefined()
    expect(await store.getStream(approvalStream.id)).toMatchObject({ status: 'open' })
  })

  test('a wake turn keeps the full ticket surface through the ticket-source backend', async () => {
    const store = new MemoryBuildStore({ clock: manualClock() })
    const clock = manualClock()
    const sessionId = await seedSession(store, clock, { wake: ['escalation.raised'] })
    await seedBuild(store, 'b1', { escalate: true })

    // The ticket backend the tick adapts from the dispatcher's ticket source
    // reads the effective config out of the repository's deposited artifact
    // (openOperatorTickets → effectiveConfig) — so the test deposits the
    // real durable shape: a `dispatcher-effective-config` artifact plus the
    // `dispatcher.run-started` fact that references it. Without these the
    // tool refuses, a refusal the old assertion ("the turn completed")
    // could not tell from a real listing (f_15fa9981).
    await store.appendRepoWithArtifacts(
      REPO,
      [
        {
          kind: 'dispatcher-effective-config',
          content: JSON.stringify({
            capacity: 4,
            roles: { default: { runtime: 'claude' } },
            policy: { harvestThreshold: 9 },
            tickets: { source: 'hosted', teamKey: 'acme', readyState: 'ready' },
          }),
        },
      ],
      (artifacts) => ({
        actor: DISPATCHER,
        type: 'dispatcher.run-started' as const,
        payload: {
          run: 'run-1',
          pid: 999,
          effectiveConfig: { kind: artifacts[0]!.kind, rev: artifacts[0]!.revision },
          roleWarnings: [],
        },
      }),
    )

    // A real ticket in the effective triage state: the listing must name it.
    const tickets = new FakeTicketSource([
      {
        ref: { source: 'fake', id: 'T-9' },
        title: 'Fix the flake',
        body: 'It flakes.',
        state: 'Backlog',
        labels: [],
      },
    ])
    const model = sequenceModel([
      toolCallStep('c1', 'tickets.list', '{}'),
      textStep('Checked the queue.'),
    ])
    const report = await runOrchestratorTickStep({
      ...tickOptions(store, clock, model),
      tickets,
    })
    expect(report.woken).toBe(1)
    const state = reduceSession(await store.getSessionEvents(sessionId))
    expect(state.status).toBe('idle')
    expect(state.turns[0]?.state).toBe('completed')

    // The tool output is a REAL queue listing resolved through the adapted
    // backend — the effective lifecycle names and the seeded ticket — not
    // the `{kind, error}` refusal body a RegistryError would have produced.
    const turnStream = state.turns[0]!.stream
    const parts = (await store.readStream(turnStream)).chunks.flatMap((c) => c.parts)
    const output = parts.find(
      (part) => part.type === 'tool-output-available' && part.toolCallId === 'c1',
    ) as
      | { output: { tickets?: Array<{ ref?: { id?: string } }>; triageState?: string } }
      | undefined
    expect(output).toBeDefined()
    expect(output!.output.triageState).toBe('Backlog')
    expect(output!.output.tickets?.map((ticket) => ticket.ref?.id)).toContain('T-9')
  })

  test('a nearly exhausted tick budget skips the step entirely', async () => {
    const store = new MemoryBuildStore({ clock: manualClock() })
    const clock = manualClock()
    const sessionId = await seedSession(store, clock, { wake: ['escalation.raised'] })
    await seedBuild(store, 'b1', { escalate: true })
    const report = await runOrchestratorTickStep({
      ...tickOptions(store, clock, textModel()),
      remainingBudgetSeconds: 10, // below the 30 s floor
    })
    expect(report).toEqual({ resumed: 0, reaped: 0, woken: 0 })
    expect(reduceSession(await store.getSessionEvents(sessionId)).turns).toHaveLength(0)
  })

  test('every resumed turn draws down the same tick deadline, not a fresh slice each', async () => {
    const store = new MemoryBuildStore({ clock: manualClock() })
    const clock = manualClock()
    await store.ensureRepo(REPO)
    const sessionIds: string[] = []
    for (let index = 0; index < 5; index++) {
      const session = await store.createSession({ repo: REPO, operator: 'op' })
      const stream = await store.createStream(
        { kind: 'session', session: session.id },
        `turn:ot_${index}`,
      )
      await store.appendStreamParts(stream.id, [{ type: 'start', messageId: 'm1' }])
      for (const event of [
        { actor: humanActor('op'), type: 'message.posted' as const, payload: { text: 'go' } },
        {
          actor: agentActor('orchestrator', `ot_${index}`),
          type: 'turn.started' as const,
          payload: {
            turn: `ot_${index}`,
            stream: stream.id,
            trigger: { kind: 'message' as const, messageSeq: 2 },
          },
        },
        {
          actor: agentActor('orchestrator', `ot_${index}`),
          type: 'turn.suspended' as const,
          payload: { turn: `ot_${index}`, cause: 'budget' as const },
        },
      ]) {
        await store.appendSessionEvent(session.id, event)
      }
      sessionIds.push(session.id)
    }

    // A model whose every call consumes 90 s of the shared clock. With a
    // fixed per-session slice (the f_9c1161ae bug) five one-step turns would
    // each get remaining − floor and overrun the 300 s tick budget by 150 s;
    // drawn down against one deadline, the step serves only the sessions
    // that fit and defers the rest to a later tick (durable state makes
    // deferral safe).
    const slowModel = new MockLanguageModelV3({
      doStream: async () => {
        clock.advance(90_000)
        return {
          stream: simulateReadableStream({
            chunks: textStep('done') as never,
            initialDelayInMs: 0,
          }),
        }
      },
    })

    const report = await runOrchestratorTickStep({
      ...tickOptions(store, clock, slowModel),
      remainingBudgetSeconds: 300,
    })
    expect(report.resumed).toBe(3)
    // The sessions the step could no longer fit stay suspended, untouched —
    // a later tick resumes them.
    for (const id of sessionIds.slice(3)) {
      const state = reduceSession(await store.getSessionEvents(id))
      expect(state.status).toBe('suspended')
      expect(state.suspendedCause).toBe('budget')
    }
  })
})
