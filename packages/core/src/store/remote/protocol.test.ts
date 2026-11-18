import { describe, expect, test } from 'bun:test'
import { BuildDigestCapabilityError, digestOptimization } from '../digest'
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

  test('carries the optimization signal, and an older answer fails closed for nodes', () => {
    const signal = {
      measured: true as const,
      inFlight: 1,
      concurrency: 2,
      emptyProposals: 0,
      openedAt: '2026-11-17T00:00:00.000Z',
      proposal: { request: 'r1', deposited: { ids: ['a'], at: '2026-11-17T00:01:00.000Z' } },
      wakeSeq: 9,
      deferredSeq: 4,
    }
    const node = { slug: 'n', kind: 'node' as const, observations: [], optimization: signal }
    const plain = {
      slug: 'p',
      kind: 'node' as const,
      observations: [],
      optimization: false as const,
    }
    expect(buildDigestListSchema.parse([node, plain])).toEqual([node, plain])
    const [older, leaf] = buildDigestListSchema.parse([
      { slug: 'o', kind: 'node', observations: [] },
      { slug: 'l', kind: 'work', observations: [] },
    ])
    expect(() => digestOptimization(older!)).toThrow(BuildDigestCapabilityError)
    expect(digestOptimization(leaf!)).toBeUndefined()
  })
})
