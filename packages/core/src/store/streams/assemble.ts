/**
 * Close-time assembly (SPEC §7.6): the one piece of shared core code every
 * adapter uses to turn a stream's part sequence into the protocol's
 * `UIMessage[]` document.
 *
 * The SDK's own processor is the protocol: classification reuses
 * `uiMessageChunkSchema` (the executable definition of "defined part type")
 * and assembly reuses `readUIMessageStream`. Parts of undefined types — and
 * malformed defined-type parts — are dropped and counted, never fatal.
 *
 * The SDK's stream state machine models exactly one message per stream (a
 * `start` chunk updates the message id/metadata without resetting accumulated
 * parts), while a stream here is a whole session. The part sequence is
 * therefore split into segments at each `start` chunk, and one `UIMessage`
 * per segment is collected, in order. Verified against ai@7 behavior by
 * `assemble.test.ts`, which is the tripwire if an SDK upgrade changes it.
 */
import { readUIMessageStream, uiMessageChunkSchema } from 'ai'
import type { UIMessage } from 'ai'
import type { StreamPart } from './types'

const chunkSchema = uiMessageChunkSchema() as unknown as {
  validate: (value: unknown) => Promise<{ success: boolean }>
}

/** Classify one part against the protocol's defined chunk union. */
async function isDefinedPart(part: StreamPart): Promise<boolean> {
  return (await chunkSchema.validate(part)).success
}

/**
 * Assemble the ordered part sequence of a whole stream into the document.
 * Returns the `UIMessage[]` (empty when nothing assembled, e.g. zero chunks)
 * and the count of dropped parts (undefined types and malformed defined-type
 * parts). Per-chunk protocol errors surface through the SDK's `onError` and
 * are swallowed — an `error` chunk is content, not an assembly failure.
 */
export async function assembleUIMessageDocument(
  parts: StreamPart[],
): Promise<{ document: UIMessage[]; droppedPartCount: number }> {
  const defined: StreamPart[] = []
  let droppedPartCount = 0
  for (const part of parts) {
    if (await isDefinedPart(part)) {
      defined.push(part)
    } else {
      droppedPartCount++
    }
  }

  // Split into segments at each `start` chunk (a segment begins with its
  // `start`); parts before the first `start` form a leading segment.
  const segments: StreamPart[][] = []
  let current: StreamPart[] = []
  for (const part of defined) {
    if (part.type === 'start' && current.length > 0) {
      segments.push(current)
      current = []
    }
    current.push(part)
  }
  if (current.length > 0) segments.push(current)

  const document: UIMessage[] = []
  for (const segment of segments) {
    const stream = new ReadableStream<StreamPart>({
      start(controller) {
        for (const part of segment) controller.enqueue(part)
        controller.close()
      },
    })
    let last: UIMessage | undefined
    for await (const message of readUIMessageStream({ stream: stream as never })) {
      last = message
    }
    if (last) document.push(last)
  }
  return { document, droppedPartCount }
}
