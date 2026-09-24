/**
 * Durable conversation reconstruction (AUT-342): a turn runner holds no
 * process memory. On every invocation the whole conversation is rebuilt from
 * the session's durable state alone — the finalized artifacts of earlier
 * turns, the live stream of the open turn, and the session events.
 *
 * Ordering rule: a turn's assembled messages attach AT ITS `turn.started`
 * event, not at its terminal fact. Attaching at the terminal fact would
 * place a message posted while the turn was suspended BEFORE that turn's
 * already-generated output, interleaving the new message into the middle of
 * the checkpoint the original invocation produced — breaking the identical-
 * input guarantee for a resumed turn in exactly the reachable case (a
 * message landing during a suspension). Attached at `turn.started`, every
 * step the original invocation completed appears verbatim and in the
 * position the model generated it from, and a mid-suspension message reads
 * as a plain next user message.
 *
 * Message-triggered turns contribute no input message of their own (the
 * `message.posted` fact is the input); wake-triggered turns carry their
 * input — the event record and the build's reduced state, frozen at wake
 * time — in the `turn.started` payload, so reconstruction is byte-identical
 * across invocations even though live build state keeps moving.
 */
import { assembleUIMessageDocument } from '../store/streams/assemble'
import type { StreamPart, StreamRead } from '../store/streams/types'
import type { UIMessage } from 'ai'
import type { BuildStore } from '../store/types'
import type { SessionEvent } from '../events/sessions'
import type { StreamRecord } from '../store/streams/types'

const STREAM_ARTIFACT_PREFIX = 'stream:'

interface TurnStreamSource {
  /** The turn's stream id, from its `turn.started` fact. */
  stream: string
  /** Durable status of the stream at read time. */
  status: 'open' | 'closed'
}

async function readTurnDocument(
  store: BuildStore,
  sessionId: string,
  source: TurnStreamSource,
): Promise<UIMessage[]> {
  if (source.status === 'open') {
    const read: StreamRead = await store.readStream(source.stream)
    const parts: StreamPart[] = read.chunks.flatMap((chunk) => chunk.parts)
    const { document } = await assembleUIMessageDocument(parts)
    return document
  }
  // Closed streams finalize into the `stream:<id>` session artifact; the
  // chunks themselves are retention-pruned, so the artifact is the durable
  // form a later invocation must read.
  const artifact = await store.getSessionArtifact(
    sessionId,
    `${STREAM_ARTIFACT_PREFIX}${source.stream}`,
  )
  if (artifact === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(artifact.content))
  } catch {
    return []
  }
  return Array.isArray(parsed) ? (parsed as UIMessage[]) : []
}

export interface ReconstructedConversation {
  messages: UIMessage[]
  /** Per turn, in start order: the turn id and how many messages its
   * document contributed. Diagnostics, not contract. */
  turns: { turn: string; messages: number }[]
}

/**
 * Reconstruct the conversation for a session from durable state alone.
 * `events` must be the complete session event log (seq 1 upward).
 */
export async function reconstructConversation(
  store: BuildStore,
  sessionId: string,
  events: SessionEvent[],
): Promise<ReconstructedConversation> {
  const messages: UIMessage[] = []
  const turns: ReconstructedConversation['turns'] = []

  // Resolve each turn's stream status up front so the walk stays ordered:
  // the open turn reads its live stream, closed turns read their artifacts.
  const sources = new Map<string, TurnStreamSource>()
  for (const event of events) {
    if (event.type !== 'turn.started') continue
    const record: StreamRecord | null = await store.getStream(event.payload.stream)
    sources.set(event.payload.turn, {
      stream: event.payload.stream,
      status: record?.status === 'open' ? 'open' : 'closed',
    })
  }

  for (const event of events) {
    if (event.type === 'message.posted') {
      messages.push({
        id: `msg_${event.seq}`,
        role: 'user',
        parts: [{ type: 'text', text: event.payload.text }],
      })
    } else if (event.type === 'turn.started') {
      const source = sources.get(event.payload.turn)
      if (source === undefined) continue
      // A wake turn's input is the frozen snapshot carried by its own
      // `turn.started` fact — recorded before the fact, so every invocation
      // reconstructs the identical user message.
      if (event.payload.trigger.kind === 'wake' && event.payload.wake !== undefined) {
        messages.push(
          wakeTriggerInputMessage({
            build: event.payload.trigger.build,
            journal: event.payload.trigger.journal === true,
            type: event.payload.trigger.type,
            event: event.payload.wake.event,
            buildState: event.payload.wake.buildState,
          }),
        )
      }
      const document = await readTurnDocument(store, sessionId, source)
      turns.push({ turn: event.payload.turn, messages: document.length })
      messages.push(...document)
    }
  }

  return { messages, turns }
}

/**
 * The user input message a wake trigger delivers to its turn: the attention
 * event record and — for a build wake — the build's reduced state, as JSON.
 * A journal wake names the repository journal instead of a build and carries
 * no build-state section (there is no build; the turn's operator registry
 * exposes bounded repository reads). The runner embeds the same object in
 * the `turn.started` payload, so this function and the reconstruction agree
 * by construction.
 */
export function wakeTriggerInputMessage(input: {
  build?: string
  journal?: boolean
  type: string
  event: { seq: number; ts: string; type: string; payload: unknown }
  buildState?: unknown
}): UIMessage {
  const journal = input.journal === true || input.build === undefined
  return {
    id: journal ? `wake_journal_${input.event.seq}` : `wake_${input.build}_${input.event.seq}`,
    role: 'user',
    parts: [
      {
        type: 'text',
        text: journal
          ? `Repository-journal attention event: ${input.type} (seq ${input.event.seq}).\n` +
            'Event record:\n' +
            JSON.stringify(input.event, null, 2)
          : `Attention event on build ${input.build}: ${input.type} (seq ${input.event.seq}).\n` +
            'Event record:\n' +
            JSON.stringify(input.event, null, 2) +
            '\nBuild state:\n' +
            JSON.stringify(input.buildState, null, 2),
      },
    ],
  }
}
