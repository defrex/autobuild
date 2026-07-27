import { describe, expect, test } from 'bun:test'
import { parseTranscript } from './transcript'

describe('parseTranscript', () => {
  test('recognizes shipped turn records, including failures and usage', () => {
    expect(
      parseTranscript(
        JSON.stringify({
          turns: [
            {
              prompt: '/ab-plan auth',
              text: 'drafted the plan',
              usage: { inputTokens: 12, outputTokens: 4 },
            },
            {
              prompt: 'retry',
              text: '',
              usage: { inputTokens: 2, outputTokens: 0 },
              failure: { message: 'quota exhausted', permanent: true },
            },
          ],
        }),
      ),
    ).toEqual({
      kind: 'turns',
      turns: [
        {
          prompt: '/ab-plan auth',
          text: 'drafted the plan',
          usage: { inputTokens: 12, outputTokens: 4 },
        },
        {
          prompt: 'retry',
          text: '',
          usage: { inputTokens: 2, outputTokens: 0 },
          failure: 'quota exhausted',
        },
      ],
    })
  })

  test('recognizes producer round boundary records and explains their asymmetry', () => {
    const parsed = parseTranscript(
      JSON.stringify({
        note: 'producer session kept live for §10 continuation; per-round turn transcript',
        turn: {
          text: 'implemented the change',
          usage: { inputTokens: 8, outputTokens: 3, turns: 1 },
        },
      }),
    )
    expect(parsed.kind).toBe('producer-boundary')
    if (parsed.kind !== 'producer-boundary') throw new Error('unreachable')
    expect(parsed.notice).toContain('only this round')
    expect(parsed.turns[0]?.text).toBe('implemented the change')
  })

  test('pretty-prints valid unknown JSON and preserves malformed raw text', () => {
    expect(parseTranscript('{"future":{"shape":true}}')).toEqual({
      kind: 'raw',
      text: '{\n  "future": {\n    "shape": true\n  }\n}',
    })
    expect(parseTranscript('not json\nraw café')).toEqual({
      kind: 'raw',
      text: 'not json\nraw café',
    })
  })

  test('falls back rather than partially rendering an unrecognized turns array', () => {
    const content = JSON.stringify({ turns: [{ providerSpecific: true }] })
    expect(parseTranscript(content)).toEqual({
      kind: 'raw',
      text: '{\n  "turns": [\n    {\n      "providerSpecific": true\n    }\n  ]\n}',
    })
  })
})
