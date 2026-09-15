/**
 * Session-stream integration (SPEC §9): a fake-harness build whose runtime
 * registration declares the streaming capability (exactly how the builtin
 * registrations declare it) runs through plan and implement; every session
 * bracket opens exactly one stream, closes with the right outcome, and
 * finalizes into a `stream:<id>` artifact whose `UIMessage[]` document
 * contains the session, prompt, and message content. A second scenario
 * asserts the engine's decisions are identical with streaming absent —
 * same event sequence, same final state — so streams stay presentation,
 * never routing.
 */
import { afterEach, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import { textContent } from '../store/types'
import {
  happyHandlers,
  makeHarness,
  ofType,
  readyTicket,
  type E2eHarness,
  type SkillHandlers,
} from './harness'

const SLUG = 'add-rate-limiting'

const harnesses: E2eHarness[] = []
async function track(pending: Promise<E2eHarness>): Promise<E2eHarness> {
  const h = await pending
  harnesses.push(h)
  return h
}
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.cleanup()
})

function stripStreamFields(events: AbEvent[], tmp: string): unknown[] {
  return JSON.parse(
    JSON.stringify(
      events.map((event) => {
        if (event.type === 'session.started') {
          const { stream: _stream, ...payload } = event.payload
          void _stream
          return { type: event.type, payload }
        }
        return { type: event.type, payload: event.payload }
      }),
    )
      .split(tmp)
      .join('<tmp>'),
  )
}

type ScriptedAgents = Parameters<
  NonNullable<Parameters<typeof makeHarness>[0]['createRuntimeRegistry']>
>[0]

/** The happy-path handlers, each appending the turn's prompt through the
 * per-turn emitter — the ScriptedAgentRunner itself emits no parts, so the
 * harness script plays the translation the builtin adapters own. */
function streamingHandlers(): SkillHandlers {
  return Object.fromEntries(
    Object.entries(happyHandlers()).map(([skill, handler]) => [
      skill,
      async (cli) => {
        cli.ctx.opts.stream?.append([
          { type: 'data-ab-prompt', data: { text: `/${skill} ${cli.ctx.opts.invocation ?? ''}` } },
        ])
        return handler(cli)
      },
    ]),
  )
}

function streamingRegistry(agents: ScriptedAgents): RuntimeRegistry {
  return {
    scripted: {
      runner: agents,
      servesModels: [],
      openSessionStream: async (sink, info) => sink.open(`session:${info.session}`),
    },
    claude: { runner: agents, servesModels: ['claude-'] },
    pi: { runner: agents, servesModels: ['kimi-'] },
  }
}

test('one stream per session bracket with finalized artifacts through plan and implement', async () => {
  const h = await track(
    makeHarness({
      handlers: streamingHandlers(),
      tickets: [readyTicket('T-1')],
      createRuntimeRegistry: streamingRegistry,
    }),
  )
  await h.dispatcher.tick()
  const state = await h.runLatest()
  expect(state.status).toBe('running')
  expect(state.prState).toBe('open')

  const events = await h.events(SLUG)
  const started = ofType(events, 'session.started')
  expect(started.length).toBeGreaterThan(0)

  // Exactly one stream per bracket, named on the event, all closed completed.
  const streams = await h.store.listStreams({ kind: 'build', build: SLUG })
  expect(streams).toHaveLength(started.length)
  const streamIds = new Set(streams.map((record) => record.id))
  for (const event of started) {
    expect(streamIds.has(event.payload.stream as string)).toBe(true)
  }
  for (const record of streams) {
    expect(record.status).toBe('closed')
    expect(record.outcome).toBe('completed')
    const bracket = started.find((event) => event.payload.stream === record.id)!
    expect(record.label).toBe(`session:${bracket.payload.session}`)
    const artifact = await h.store.getArtifact(SLUG, `stream:${record.id}`)
    expect(artifact).not.toBeNull()
    // The finalized document contains the session, prompt, and message
    // content — the scripted handler's real work is bracketed on both sides.
    const document = JSON.parse(textContent(artifact!)) as Array<{
      parts?: Array<{ type: string; data?: { text?: string } }>
    }>
    expect(document[0]?.parts?.[0]?.type).toBe('data-ab-session')
    const prompt = document[0]?.parts?.find((part) => part.type === 'data-ab-prompt')
    expect(prompt).toBeDefined()
    // Every turn's prompt (the skill invocation on turn 1) is a
    // data-ab-prompt part preceding that turn's output.
    const promptTexts = document
      .flatMap((message) => message.parts ?? [])
      .filter((part) => part.type === 'data-ab-prompt')
      .map((part) => part.data?.text)
    expect(promptTexts).toEqual([`/${bracket.payload.role} ${SLUG}`])
  }
})

test('engine decisions are identical with streaming absent (presentation, never routing)', async () => {
  const streamed = await track(
    makeHarness({
      handlers: streamingHandlers(),
      tickets: [readyTicket('T-1')],
      createRuntimeRegistry: streamingRegistry,
    }),
  )
  await streamed.dispatcher.tick()
  const streamedState = await streamed.runLatest()
  const streamedEvents = stripStreamFields(await streamed.events(SLUG), streamed.tmp)

  const plain = await track(
    makeHarness({ handlers: happyHandlers(), tickets: [readyTicket('T-1')] }),
  )
  await plain.dispatcher.tick()
  const plainState = await plain.runLatest()
  const plainEvents = stripStreamFields(await plain.events(SLUG), plain.tmp)

  expect(plainEvents).toEqual(streamedEvents)
  expect(plainState.status).toBe(streamedState.status)
  expect(plainState.prState).toBe(streamedState.prState)
  expect(plainState.pr).toEqual(streamedState.pr)
})
