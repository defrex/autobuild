import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { TicketUpdate } from '../types'
import { renderTicketUpdateIssues, validateTicketUpdate } from './update'

describe('ticket update validation', () => {
  test('issue rendering expands a synthetic untagged union with complete paths', () => {
    // Renderer-contract seam only: `ticketUpdateSchema` cannot currently
    // produce this union issue, and this fixture does not widen that schema.
    const fixture = z.strictObject({
      reviews: z.array(
        z.strictObject({
          detail: z.union([
            z.object({ left: z.custom(() => false, 'left alternative rejected') }),
            z.object({ right: z.custom(() => false, 'right alternative rejected') }),
          ]),
        }),
      ),
    })
    const result = fixture.safeParse({ reviews: [{ detail: { left: 1, right: 2 } }] })
    if (result.success) throw new Error('renderer fixture must fail')

    const rendered = renderTicketUpdateIssues(result.error.issues)

    expect(rendered).toBe(
      'reviews.0.detail.left: option 1 of 2: left alternative rejected; ' +
        'reviews.0.detail.right: option 2 of 2: right alternative rejected',
    )
    expect(rendered).not.toContain('Invalid input')
  })

  test('current reachable failures retain specific diagnostics', () => {
    expect(() => validateTicketUpdate({})).toThrow(
      /invalid ticket update — update must name at least one of title, body, labels, kind, or target/,
    )
    expect(() => validateTicketUpdate({ title: '   ' })).toThrow(
      /invalid ticket update — title: title must not be blank/,
    )
    expect(() => validateTicketUpdate({ body: '\n' })).toThrow(
      /invalid ticket update — body: body must not be blank/,
    )
    expect(() =>
      validateTicketUpdate({ title: 'kept', extra: true } as unknown as TicketUpdate),
    ).toThrow(/invalid ticket update — Unrecognized key: "extra"/)
  })
})

test('metadata-only updates retain null clears and validate kind and nonblank ids', () => {
  expect(validateTicketUpdate({ kind: 'node' })).toEqual({ kind: 'node' })
  expect(validateTicketUpdate({ target: null })).toEqual({ target: null })
  expect(validateTicketUpdate({ kind: 'work', target: 'node-id' })).toEqual({
    kind: 'work',
    target: 'node-id',
  })
  expect(() => validateTicketUpdate({ target: '  ' })).toThrow('target must not be blank')
  expect(() => validateTicketUpdate({ kind: 'other' } as unknown as TicketUpdate)).toThrow('kind')
})
