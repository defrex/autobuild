import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import {
  currentPrAttachments,
  frozenPrImageHost,
  hostedPrAttachments,
  pendingPrAttachmentReclaims,
} from './pr-attachments'

function event(
  seq: number,
  type: AbEvent['type'],
  payload: unknown,
): AbEvent {
  return {
    build: 'attachments',
    seq,
    ts: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
    actor: { kind: 'kernel' },
    type,
    payload,
  } as AbEvent
}

const target = {
  provider: 'github-release',
  repository: 'acme/review-assets',
  releaseId: 42,
} as const
const asset = {
  ...target,
  assetId: 7,
  url: 'https://example.invalid/screenshot.png',
}

function designation(seq: number, kind: string, rev: number): AbEvent {
  return event(seq, 'pr-attachment.designated', {
    artifact: { kind, rev },
    filename: `${kind.replaceAll(':', '-')}.png`,
    mediaType: 'image/png',
  })
}

describe('currentPrAttachments', () => {
  test('uses only post-restart designations and the latest revision per kind in event order', () => {
    const events = [
      designation(2, 'visual:old-only', 0),
      designation(3, 'visual:home', 0),
      event(7, 'spec.revised', {
        artifact: { kind: 'spec', rev: 1 },
        escalation: 1,
      }),
      designation(11, 'visual:home', 1),
      designation(9, 'visual:trace', 0),
      designation(13, 'visual:home', 2),
    ]

    expect(
      currentPrAttachments(events).map((item) => [
        item.seq,
        item.payload.artifact.kind,
        item.payload.artifact.rev,
      ]),
    ).toEqual([
      [9, 'visual:trace', 0],
      [13, 'visual:home', 2],
    ])
  })

  test('reads frozen host consent without depending on array order', () => {
    expect(
      frozenPrImageHost([
        event(8, 'build.created', {
          ticket: { source: 'file', id: 'A-1' },
          repo: 'acme/app',
          baseBranch: 'main',
          pr: { imageHost: target },
        }),
      ]),
    ).toEqual(target)
    expect(frozenPrImageHost([])).toBeUndefined()
  })
})

describe('attachment hosting correlations', () => {
  test('ignores unknown/backwards correlations and selects a later host by designation seq', () => {
    const designated = designation(5, 'visual:home', 0)
    const backwards = event(4, 'pr-attachment.hosted', {
      designationSeq: 5,
      asset,
    })
    const unknown = event(6, 'pr-attachment.hosted', {
      designationSeq: 99,
      asset: { ...asset, assetId: 8 },
    })
    const valid = event(7, 'pr-attachment.hosted', {
      designationSeq: 5,
      asset: { ...asset, assetId: 9 },
    })

    expect(
      hostedPrAttachments([backwards, unknown, valid, designated]).get(5)?.seq,
    ).toBe(7)
  })

  test('reclamation remains pending through failures and only a later correlated success settles it', () => {
    const hosted = event(7, 'pr-attachment.hosted', {
      designationSeq: 5,
      asset,
    })
    const failure = event(8, 'pr-attachment.reclaim-failed', {
      hostedSeq: 7,
      attempt: 1,
      error: 'timeout',
    })
    const backwardsAck = event(6, 'pr-attachment.reclaimed', { hostedSeq: 7 })
    const unknownAck = event(9, 'pr-attachment.reclaimed', { hostedSeq: 99 })

    expect(
      pendingPrAttachmentReclaims([
        unknownAck,
        hosted,
        failure,
        backwardsAck,
      ]).map((item) => item.seq),
    ).toEqual([7])
    expect(
      pendingPrAttachmentReclaims([
        hosted,
        event(10, 'pr-attachment.reclaimed', { hostedSeq: 7 }),
      ]),
    ).toEqual([])
  })
})
