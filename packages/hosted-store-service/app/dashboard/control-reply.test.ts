import { expect, test } from 'bun:test'
import {
  answerRequest,
  classifyAnswerReply,
  classifyControlReply,
  controlReplyText,
  type BuildControlReply,
} from './control-reply'

const slug = 'blocked-build'

test('answer-required control replies transition to the answer step', () => {
  expect(
    classifyControlReply(slug, {
      kind: 'answer-required',
      slug,
      escalationIds: ['esc-1', 'esc-2'],
    }),
  ).toEqual({ kind: 'answer', slug, escalationIds: ['esc-1', 'esc-2'] })
})

test('a same-build command is the only immediately recorded control success', () => {
  expect(
    classifyControlReply(slug, { kind: 'command', slug, command: 'pause', event: {} }),
  ).toEqual({ kind: 'recorded' })
})

for (const command of ['land', 'hold'] as const) {
  test(`${command} replies with recorded landing events are recognized as success`, () => {
    const reply = {
      kind: 'command',
      slug,
      command,
      event: {
        build: slug,
        seq: 12,
        ts: '2026-10-24T12:00:00.000Z',
        actor: { kind: 'human', user: 'operator' },
        ...(command === 'land'
          ? { type: 'build.land-requested', payload: { decisionSeq: 10 } }
          : { type: 'build.hold-requested', payload: {} }),
      },
    } satisfies BuildControlReply

    expect(classifyControlReply(slug, reply)).toEqual({ kind: 'recorded' })
    expect(classifyControlReply('other-build', reply).kind).toBe('unexpected')
    expect(classifyControlReply(slug, { ...reply, event: null }).kind).toBe('unexpected')
  })
}

test('malformed, mismatched, and unrecorded replies are preserved as compact errors', () => {
  const replies = [
    { kind: 'answer-required', slug: 'other', escalationIds: ['esc-1'] },
    { kind: 'answer-required', slug, escalationIds: [1] },
    { kind: 'answered', slug, count: 1 },
    null,
    'try again',
  ]
  expect(replies.map((reply) => classifyControlReply(slug, reply))).toEqual(
    replies.map((reply) => ({ kind: 'unexpected', text: controlReplyText(reply) })),
  )
  expect(classifyAnswerReply(slug, { kind: 'answered', slug: 'other' })).toEqual({
    kind: 'unexpected',
    text: '{"kind":"answered","slug":"other"}',
  })
  expect(
    classifyAnswerReply(slug, {
      kind: 'answered',
      slug,
      count: 1,
      resolution: 'retry',
      resumed: true,
    }),
  ).toEqual({ kind: 'answered' })
})

test('answer input maps blank text to retry and trimmed text to guidance', () => {
  expect(answerRequest('  \n ')).toEqual({ resolution: 'retry' })
  expect(answerRequest('  continue with option B  ')).toEqual({
    resolution: 'guidance',
    text: 'continue with option B',
  })
})
