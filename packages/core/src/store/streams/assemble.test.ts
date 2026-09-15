/**
 * Pins the close-time assembly behavior verified empirically against
 * ai@7.0.101 (see assemble.ts). If an `ai` upgrade changes how the SDK's own
 * processor handles the protocol, these tests are the tripwire: the contract
 * suite's representative-sequence close test asserts the same document
 * byte-for-byte through every adapter.
 */
import { describe, expect, test } from 'bun:test'
import { assembleUIMessageDocument } from './assemble'

async function assemble(parts: unknown[]) {
  return assembleUIMessageDocument(parts as Parameters<typeof assembleUIMessageDocument>[0])
}

describe('assembleUIMessageDocument', () => {
  test('assembles a representative sequence: text, tool input+output, reasoning, data-*, error, undefined type', async () => {
    const { document, droppedPartCount } = await assemble([
      { type: 'start', messageId: 'm1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'hello ' },
      { type: 'text-delta', id: 't1', delta: 'world' },
      { type: 'text-end', id: 't1' },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'thinking' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'grep', input: { q: 'x' } },
      { type: 'tool-output-available', toolCallId: 'c1', output: { hits: 3 } },
      { type: 'data-probe', id: 'd1', data: { n: 1 } },
      { type: 'error', errorText: 'transient' },
      { type: 'mystery-part', foo: 1 },
      { type: 'finish', finishReason: 'stop' },
    ])
    // The undefined-type part is dropped and counted; everything else
    // assembles into the SDK's own UIMessage shape. The `error` chunk is
    // content — surfaced via onError, never an assembly failure.
    expect(droppedPartCount).toBe(1)
    expect(document).toEqual([
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'hello world', state: 'done' },
          { type: 'reasoning', id: 'r1', text: 'thinking', state: 'done' },
          {
            type: 'tool-grep',
            toolCallId: 'c1',
            state: 'output-available',
            input: { q: 'x' },
            output: { hits: 3 },
          },
          { type: 'data-probe', id: 'd1', data: { n: 1 } },
        ],
      },
    ])
  })

  test('splits the sequence at each start chunk into one UIMessage per segment', async () => {
    const { document, droppedPartCount } = await assemble([
      { type: 'start', messageId: 'a' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'one' },
      { type: 'text-end', id: 't' },
      { type: 'start', messageId: 'b' },
      { type: 'text-start', id: 'u' },
      { type: 'text-delta', id: 'u', delta: 'two' },
      { type: 'text-end', id: 'u' },
    ])
    expect(droppedPartCount).toBe(0)
    expect(document.map((message) => [message.id, message.parts])).toEqual([
      ['a', [{ type: 'text', text: 'one', state: 'done' }]],
      ['b', [{ type: 'text', text: 'two', state: 'done' }]],
    ])
  })

  test('parts before the first start chunk form a leading message', async () => {
    const { document } = await assemble([
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'lead' },
      { type: 'text-end', id: 't' },
      { type: 'start', messageId: 'm' },
      { type: 'text-start', id: 'u' },
      { type: 'text-delta', id: 'u', delta: 'next' },
      { type: 'text-end', id: 'u' },
    ])
    expect(document.map((message) => message.id)).toEqual(['', 'm'])
    expect(document[0]?.parts).toEqual([{ type: 'text', text: 'lead', state: 'done' }])
  })

  test('an empty or entirely-undefined part sequence assembles to an empty document', async () => {
    expect(await assemble([])).toEqual({ document: [], droppedPartCount: 0 })
    expect(await assemble([{ type: 'mystery', a: 1 }])).toEqual({
      document: [],
      droppedPartCount: 1,
    })
  })

  test('a malformed defined-type part is dropped and counted, not fatal', async () => {
    // text-delta without its required `delta` field fails the schema.
    const { document, droppedPartCount } = await assemble([
      { type: 'start', messageId: 'm' },
      { type: 'text-delta', id: 't' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'ok' },
      { type: 'text-end', id: 't' },
    ])
    expect(droppedPartCount).toBe(1)
    expect(document).toEqual([
      { id: 'm', role: 'assistant', parts: [{ type: 'text', text: 'ok', state: 'done' }] },
    ])
  })

  test('tool output without prior input is skipped, not fatal', async () => {
    const { document } = await assemble([
      { type: 'start', messageId: 'm' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'before' },
      { type: 'text-end', id: 't' },
      { type: 'tool-output-available', toolCallId: 'ghost', output: 1 },
    ])
    // The orphan tool-output part raises a swallowed UIMessageStreamError via
    // the SDK's onError; the message assembles from the surviving parts.
    expect(document).toEqual([
      { id: 'm', role: 'assistant', parts: [{ type: 'text', text: 'before', state: 'done' }] },
    ])
  })
})
