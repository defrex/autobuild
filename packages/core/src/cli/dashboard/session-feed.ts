/**
 * The session view's live-read cycle (SPEC §9): ONE module both controllers
 * call, so the follow/close/fallback semantics cannot drift between the
 * `DispatchLoop` (the wire-injected path the capture harness exercises) and
 * `DispatchFrontend` (the production interactive path).
 *
 * `SessionStreamFeed.poll(view)` performs one immediate store read
 * (`waitSeconds: 0` — the store waits only when `waitSeconds > 0`), so no read
 * can hold a frame longer than the controller's poll interval, and the writer's
 * 250 ms flush cadence puts new parts on screen within one poll. It returns the
 * next view fields — appended parts, advanced `lastSeq`, status/outcome on
 * close, the pruned-chunk artifact fallback, or an error message that the next
 * poll retries — and never throws into the frame.
 *
 * The returned update carries the identity and `since` cursor it started from;
 * `applySessionFeedUpdate` is the apply-fence: a read that raced an Escape, a
 * session switch, or a newer apply is discarded instead of retargeting the
 * view. The stored part sequence is only ever appended to — the view never
 * rewrites history.
 */
import type { UIMessage } from 'ai'
import type { StreamOutcome, StreamPart, StreamRead } from '../../store/streams/types'
import type { SessionDashboardView } from './model'

/** The read-only store surface the feed consumes (injected; no terminal). */
export interface SessionFeedStore {
  readStream(streamId: string, opts?: { since?: number; waitSeconds?: number }): Promise<StreamRead>
  getArtifact(
    slug: string,
    kind: string,
    rev?: number,
  ): Promise<{
    content: Uint8Array | string
  } | null>
}

/** The mutable fields of a session view the feed may produce. */
export interface SessionViewFields {
  status: 'open' | 'closed'
  outcome?: StreamOutcome
  source:
    | { kind: 'parts'; parts: StreamPart[]; lastSeq: number }
    | { kind: 'document'; document: UIMessage[] }
  error?: string
}

/** The identity-bearing result of one poll: `since` is the cursor the read
 * started from (the parts `lastSeq`, or 0 for a document retry), and
 * everything is applied only through the fence below. */
export interface SessionFeedUpdate {
  slug: string
  sessionId: string
  stream: string
  since: number
  /** Which source shape this update was polled from — the fence compares it
   * against the current view so a read that raced a source switch is
   * discarded. */
  polledSource: 'parts' | 'document'
  fields: SessionViewFields
}

/** The shape of a session view the feed polls. */
export type PollableSessionView = SessionDashboardView

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseDocument(content: Uint8Array | string): UIMessage[] | undefined {
  try {
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content)
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return undefined
    return parsed as UIMessage[]
  } catch {
    return undefined
  }
}

export class SessionStreamFeed {
  constructor(
    private readonly store: SessionFeedStore,
    private readonly slug: string,
  ) {}

  /** One immediate read cycle for the given view. Returns `undefined` when
   * nothing changed (a document-source view is final; an open stream with no
   * new chunks leaves the view alone). Errors are retained as view fields and
   * retried by the next poll, never thrown. */
  async poll(view: PollableSessionView): Promise<SessionFeedUpdate | undefined> {
    // A finalized document is the end state; only a failed read of it retries.
    if (view.source.kind === 'document' && view.error === undefined) return undefined

    const polledSource = view.source.kind
    const since = view.source.kind === 'parts' ? view.source.lastSeq : 0
    const base: SessionViewFields = {
      status: view.status,
      ...(view.outcome !== undefined ? { outcome: view.outcome } : {}),
      source: view.source,
      ...(view.error !== undefined ? { error: view.error } : {}),
    }
    try {
      const read = await this.store.readStream(this.streamId(view), { since, waitSeconds: 0 })

      // A closed stream that yields no chunks despite a nonempty cursor — or
      // one whose chunk log was pruned — renders the finalized artifact
      // instead. This also covers a closed-session view opened to an empty log.
      if (read.status === 'closed' && read.chunks.length === 0) {
        return await this.artifactFallback(view, base, since, polledSource, read)
      }

      const parts = view.source.kind === 'parts' ? [...view.source.parts] : []
      let lastSeq = since
      for (const chunk of read.chunks) {
        parts.push(...chunk.parts)
        if (chunk.seq > lastSeq) lastSeq = chunk.seq
      }
      const fields: SessionViewFields = {
        status: read.status,
        ...(read.outcome !== undefined ? { outcome: read.outcome } : {}),
        source: { kind: 'parts', parts, lastSeq },
      }
      if (
        read.chunks.length === 0 &&
        read.status === base.status &&
        read.outcome === base.outcome &&
        base.error === undefined
      ) {
        return undefined
      }
      return this.update(view, since, polledSource, fields)
    } catch (error) {
      return this.update(view, since, polledSource, { ...base, error: errorMessage(error) })
    }
  }

  /** Read the closed stream's deposited document artifact. A failed or absent
   * read keeps the view's current content and carries the error for the next
   * poll to retry. */
  private async artifactFallback(
    view: PollableSessionView,
    base: SessionViewFields,
    since: number,
    polledSource: 'parts' | 'document',
    read: StreamRead,
  ): Promise<SessionFeedUpdate> {
    try {
      const artifact = await this.store.getArtifact(this.slug, `stream:${this.streamId(view)}`, 0)
      const document = artifact === null ? undefined : parseDocument(artifact.content)
      if (document === undefined) {
        return this.update(view, since, polledSource, {
          ...base,
          status: 'closed',
          ...(read.outcome !== undefined ? { outcome: read.outcome } : {}),
          error:
            artifact === null
              ? `stream artifact stream:${this.streamId(view)} is not retrievable`
              : 'stream artifact is not a readable session document',
        })
      }
      return this.update(view, since, polledSource, {
        status: 'closed',
        ...(read.outcome !== undefined ? { outcome: read.outcome } : {}),
        source: { kind: 'document', document },
      })
    } catch (error) {
      return this.update(view, since, polledSource, {
        ...base,
        status: 'closed',
        ...(read.outcome !== undefined ? { outcome: read.outcome } : {}),
        error: errorMessage(error),
      })
    }
  }

  private streamId(view: PollableSessionView): string {
    return view.stream
  }

  private update(
    view: PollableSessionView,
    since: number,
    polledSource: 'parts' | 'document',
    fields: SessionViewFields,
  ): SessionFeedUpdate {
    return {
      slug: view.slug,
      sessionId: view.sessionId,
      stream: view.stream,
      since,
      polledSource,
      fields,
    }
  }
}

/**
 * The apply-fence: apply a feed update to `current` only when it is still the
 * same session view this update was polled from, at the same cursor. Anything
 * else — an Escape to detail, a session switch, a newer apply — rejects the
 * stale read by returning `undefined`.
 */
export function applySessionFeedUpdate(
  current: SessionDashboardView | undefined,
  update: SessionFeedUpdate,
): SessionDashboardView | undefined {
  if (current === undefined) return undefined
  if (
    current.slug !== update.slug ||
    current.sessionId !== update.sessionId ||
    current.stream !== update.stream
  ) {
    return undefined
  }
  if (update.polledSource === 'parts') {
    if (current.source.kind !== 'parts' || current.source.lastSeq !== update.since) return undefined
  } else if (current.source.kind !== 'document') {
    return undefined
  }
  return { ...current, ...update.fields }
}
