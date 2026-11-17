import { describe, expect, test } from 'bun:test'
import { buildDigestListSchema } from './protocol'

describe('build digest wire schema', () => {
  test('carries the additive ticket-wait members through a client parse', () => {
    const digest = {
      slug: 'b',
      observations: [],
      nodeTargets: [],
      waitPending: true as const,
      ticketWait: {
        id: 'w1',
        escalation: 'esc_w1',
        tickets: [{ source: 'linear', id: 'AUT-2', url: 'https://linear.app/x/AUT-2' }],
      },
    }
    expect(buildDigestListSchema.parse([digest])).toEqual([digest])
  })

  test('an older service that omits them still parses', () => {
    const [digest] = buildDigestListSchema.parse([{ slug: 'b', observations: [] }])
    expect(digest).not.toHaveProperty('waitPending')
    expect(digest).not.toHaveProperty('ticketWait')
  })
})
