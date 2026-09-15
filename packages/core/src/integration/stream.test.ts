/**
 * Session-stream integration (SPEC §9): a fake-harness build driven by a REAL
 * builtin adapter — the Claude runner over a scripted streaming CLI boundary
 * that emits `stream_event` deltas, a tool call with its result, and the
 * `result` line, exactly the live translation seam — runs through plan and
 * implement; every session bracket opens exactly one stream, closes with the
 * right outcome, and finalizes into a `stream:<id>` artifact whose
 * `UIMessage[]` document contains the session, prompt, text, and tool
 * content. A second scenario runs the same transport with streaming disabled
 * and asserts the engine's decisions are identical — same event sequence
 * (stripping the `stream` field), same final state — so streams stay
 * presentation, never routing.
 */
import { afterEach, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import {
  ClaudeAgentRunner,
  type ClaudeCliInvocation,
  type ClaudeCliResult,
} from '../ports/runner/claude'
import type { ScriptedAgentRunner } from '../ports/runner/fake'
import type { AgentSessionHandle, AgentTurnResult } from '../ports/types'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import { textContent } from '../store/types'
import {
  CONFIG_TOML,
  happyHandlers,
  makeHarness,
  ofType,
  readyTicket,
  type E2eHarness,
} from './harness'

const SLUG = 'add-rate-limiting'

/** CONFIG_TOML with every role routed to the real Claude builtin adapter. */
const CLAUDE_CONFIG_TOML = CONFIG_TOML.replace('runtime = "scripted"', 'runtime = "claude"')

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
  // Commit SHAs are real git objects stamped with the wall clock (§8.2 pins
  // identity, not time), so equal trees across two runs hash differently
  // across a second boundary. They carry no engine decision.
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
      .join('<tmp>')
      .replace(/[0-9a-f]{40}/g, '<sha>'),
  )
}

interface PartShape {
  type: string
  data?: { text?: string }
  text?: string
  state?: string
  toolCallId?: string
  input?: unknown
  output?: unknown
}

/**
 * The scripted Claude CLI boundary: a transport in front of a REAL
 * ClaudeAgentRunner that delegates each turn to the harness's scripted agent
 * (so phase scripts still drive the real in-process `ab` CLI) and renders the
 * underlying turn as Claude Code stream-json — `stream_event` chunks with
 * partial text deltas, a buffered `input_json_delta` tool call, the `user`
 * tool_result line, and the `result` line. Both boundaries (buffered and
 * streaming) share one session map and one renderer, so a turn parses
 * identically whichever boundary carried it.
 */
function claudeTransport(
  agents: ScriptedAgentRunner,
  observed: { streamingArgs: string[] },
): ClaudeAgentRunner {
  const sessions = new Map<string, AgentSessionHandle>()

  const isOneShot = (args: string[]): boolean => args.includes('--no-session-persistence')

  /** Run one turn against the scripted agent underneath. */
  const perform = async (
    call: ClaudeCliInvocation,
  ): Promise<{ result: AgentTurnResult; sessionId: string }> => {
    const index = call.args.indexOf('--')
    const prompt = call.args[index + 1] ?? ''
    const modelIndex = call.args.indexOf('--model')
    const model = modelIndex >= 0 ? call.args[modelIndex + 1] : undefined
    const resumeIndex = call.args.indexOf('--resume')
    if (resumeIndex >= 0) {
      const id = call.args[resumeIndex + 1]!
      const underlying = sessions.get(id)
      if (underlying === undefined) throw new Error(`unknown fake Claude session "${id}"`)
      const result = await agents.continue(underlying, prompt, { env: call.env })
      return { result, sessionId: id }
    }
    const match = /^\/(\S+) ?(.*)$/.exec(prompt)
    if (match === null) throw new Error(`unexpected Claude phase prompt: ${prompt}`)
    const sessionIndex = call.args.indexOf('--session-id')
    const id = sessionIndex >= 0 ? call.args[sessionIndex + 1]! : 'claude-1'
    const started = await agents.start({
      skill: match[1]!,
      invocation: match[2]!,
      workspacePath: call.cwd,
      ...(model !== undefined ? { model } : {}),
      env: call.env,
    })
    sessions.set(id, started.session)
    return { result: started.result, sessionId: id }
  }

  /** Render a completed underlying turn as the harness's stream-json lines. */
  const linesFor = (result: AgentTurnResult, sessionId: string): string[] => {
    const lines: string[] = []
    const event = (value: unknown): void => {
      lines.push(JSON.stringify(value))
    }
    const text = result.kind === 'failed' ? '' : result.text
    event({ type: 'stream_event', event: { type: 'message_start' } })
    event({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', id: 'blk-text' },
      },
    })
    if (text.length > 0) {
      // Partial-message chunks: the harness reports text as it arrives.
      const half = Math.ceil(text.length / 2)
      event({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: text.slice(0, half) },
        },
      })
      event({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: text.slice(half) },
        },
      })
    }
    event({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
    event({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'shell' },
      },
    })
    event({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"command":["bun","test"]}' },
      },
    })
    event({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } })
    event({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
    })
    event({ type: 'stream_event', event: { type: 'message_stop' } })
    event({
      type: 'assistant',
      message: {
        content: [
          ...(text.length > 0 ? [{ type: 'text', text }] : []),
          { type: 'tool_use', id: 'tool-1', name: 'shell', input: { command: ['bun', 'test'] } },
        ],
      },
    })
    const failed = result.kind === 'failed'
    event({
      type: 'result',
      subtype: failed ? 'error_during_execution' : 'success',
      is_error: failed,
      session_id: sessionId,
      ...(failed ? { result: result.failure.message } : { result: text }),
      usage: {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
      },
    })
    return lines
  }

  const cliFor = (lines: string[]): ClaudeCliResult => ({
    stdout: `${lines.join('\n')}\n`,
    stderr: '',
    exitCode: 0,
  })

  return new ClaudeAgentRunner({
    // Buffered boundary: one-shot completions and unstreamed turns
    // (streamSessions disabled) parse the same rendered output.
    runCli: async (call) => {
      if (isOneShot(call.args)) {
        return cliFor([
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: 'one-shot',
            result: SLUG,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        ])
      }
      const { result, sessionId } = await perform(call)
      return cliFor(linesFor(result, sessionId))
    },
    // Live streaming boundary: the adapter translates the lines as it
    // consumes them; the result promise settles once they have been.
    runCliStream: (call) => {
      observed.streamingArgs.push(...call.args)
      let turn: Promise<{ result: AgentTurnResult; sessionId: string }> | undefined
      const ensure = (): Promise<{ result: AgentTurnResult; sessionId: string }> =>
        (turn ??= perform(call))
      const lines = (async function* (): AsyncGenerator<string> {
        const { result, sessionId } = await ensure()
        yield* linesFor(result, sessionId)
      })()
      const result = ensure().then(({ result, sessionId }) => cliFor(linesFor(result, sessionId)))
      return { lines, result }
    },
  })
}

/** The harness registry with a real Claude builtin registration, streaming
 * capability declared exactly as the builtin registrations declare it. */
function makeClaudeRegistry(observed: { streamingArgs: string[] }) {
  return (agents: ScriptedAgentRunner): RuntimeRegistry => ({
    claude: {
      runner: claudeTransport(agents, observed),
      servesModels: [],
      openSessionStream: async (sink, info) => sink.open(`session:${info.session}`),
    },
    scripted: { runner: agents, servesModels: [] },
  })
}

test('one stream per session bracket with finalized artifacts through plan and implement', async () => {
  const observed = { streamingArgs: [] as string[] }
  const h = await track(
    makeHarness({
      handlers: happyHandlers(),
      tickets: [readyTicket('T-1')],
      createRuntimeRegistry: makeClaudeRegistry(observed),
      configToml: CLAUDE_CONFIG_TOML,
    }),
  )
  await h.dispatcher.tick()
  const state = await h.runLatest()
  expect(state.status).toBe('running')
  expect(state.prState).toBe('open')

  // The real adapter ran the turns over the live streaming boundary.
  expect(observed.streamingArgs.length).toBeGreaterThan(0)
  expect(observed.streamingArgs).toContain('--include-partial-messages')

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
    // The finalized document contains the session, prompt, text, and tool
    // content — the adapter's live translation reached the store and the
    // artifact through the batching writer.
    const parts = (JSON.parse(textContent(artifact!)) as Array<{ parts?: PartShape[] }>).flatMap(
      (message) => message.parts ?? [],
    )
    expect(parts[0]?.type).toBe('data-ab-session')
    // Every turn's prompt (the skill invocation on turn 1) is a
    // data-ab-prompt part preceding that turn's output.
    const prompts = parts
      .filter((part) => part.type === 'data-ab-prompt')
      .map((part) => part.data?.text)
    expect(prompts).toEqual([`/ab-${bracket.payload.role} ${SLUG}`])
    const types = parts.map((part) => part.type)
    // The adapter's live translation assembled into message content: the
    // turn's text (streamed as partial deltas) and the tool call with its
    // input and output, bracketed by the session and prompt parts.
    expect(parts.find((part) => part.type === 'text')).toMatchObject({
      state: 'done',
      text: `ab-${bracket.payload.role} finished`,
    })
    expect(parts.find((part) => part.type === 'tool-shell')).toMatchObject({
      toolCallId: 'tool-1',
      state: 'output-available',
      input: { command: ['bun', 'test'] },
      output: 'ok',
    })
    expect(types).toContain('step-start')
  }
})

test('engine decisions are identical with streaming disabled (presentation, never routing)', async () => {
  const streamedObserved = { streamingArgs: [] as string[] }
  const streamed = await track(
    makeHarness({
      handlers: happyHandlers(),
      tickets: [readyTicket('T-1')],
      createRuntimeRegistry: makeClaudeRegistry(streamedObserved),
      configToml: CLAUDE_CONFIG_TOML,
    }),
  )
  await streamed.dispatcher.tick()
  const streamedState = await streamed.runLatest()
  const streamedEvents = stripStreamFields(await streamed.events(SLUG), streamed.tmp)

  const plainObserved = { streamingArgs: [] as string[] }
  const plain = await track(
    makeHarness({
      handlers: happyHandlers(),
      tickets: [readyTicket('T-1')],
      createRuntimeRegistry: makeClaudeRegistry(plainObserved),
      configToml: CLAUDE_CONFIG_TOML,
      streamSessions: false,
    }),
  )
  await plain.dispatcher.tick()
  const plainState = await plain.runLatest()
  const plainEvents = stripStreamFields(await plain.events(SLUG), plain.tmp)

  // Same transport, same harness output: only the streaming flag differed.
  expect(plainObserved.streamingArgs).toHaveLength(0)
  expect(streamedObserved.streamingArgs).toContain('--include-partial-messages')
  expect(plainEvents).toEqual(streamedEvents)
  expect(plainState.status).toBe(streamedState.status)
  expect(plainState.prState).toBe(streamedState.prState)
  expect(plainState.pr).toEqual(streamedState.pr)
  // The unstreamed run produced no streams at all.
  expect(await plain.store.listStreams({ kind: 'build', build: SLUG })).toHaveLength(0)
})
