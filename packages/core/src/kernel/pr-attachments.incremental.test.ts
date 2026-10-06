import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { checkIncremental, pick, seededRandom, shuffled } from './incremental-contract'
import {
  type PrAttachmentDesignationEvent,
  CURRENT_PR_ATTACHMENTS_REDUCER_VERSION,
  FROZEN_PR_IMAGE_HOST_REDUCER_VERSION,
  HOSTED_PR_ATTACHMENTS_REDUCER_VERSION,
  PENDING_PR_ATTACHMENT_RECLAIMS_REDUCER_VERSION,
  currentPrAttachments,
  currentPrAttachmentsReducer,
  frozenPrImageHost,
  frozenPrImageHostReducer,
  hostedPrAttachments,
  hostedPrAttachmentsReducer,
  pendingPrAttachmentReclaims,
  pendingPrAttachmentReclaimsReducer,
} from './pr-attachments'

function event(seq: number, type: AbEvent['type'], payload: unknown): AbEvent {
  return {
    build: 'attachments',
    seq,
    ts: `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    actor: { kind: 'kernel' },
    type,
    payload,
  } as AbEvent
}

const target = { provider: 'github-release', repository: 'acme/review-assets', releaseId: 42 }
const asset = { ...target, assetId: 7, url: 'https://example.invalid/screenshot.png' }
const designation = (seq: number, kind: string, rev: number) =>
  event(seq, 'pr-attachment.designated', {
    artifact: { kind, rev },
    filename: `${kind.replaceAll(':', '-')}.png`,
    mediaType: 'image/png',
  })
const hosted = (seq: number, designationSeq: number) =>
  event(seq, 'pr-attachment.hosted', { designationSeq, asset: { ...asset, assetId: seq } })
const reclaimed = (seq: number, hostedSeq: number) =>
  event(seq, 'pr-attachment.reclaimed', { hostedSeq })
const revised = (seq: number) =>
  event(seq, 'spec.revised', { artifact: { kind: 'spec', rev: 1 }, escalation: 1 })
const created = (seq: number, withHost: boolean) =>
  event(seq, 'build.created', {
    ticket: { source: 'file', id: 'A-1' },
    repo: 'acme/app',
    baseBranch: 'main',
    ...(withHost ? { pr: { imageHost: target } } : {}),
  })
const noise = (seq: number) => event(seq, 'observation.recorded', { kind: 'note', note: 'n' })

const fixtures: Record<string, AbEvent[]> = {
  empty: [],
  restart: [
    designation(2, 'visual:old-only', 0),
    designation(3, 'visual:home', 0),
    revised(7),
    designation(11, 'visual:home', 1),
    designation(9, 'visual:trace', 0),
    designation(13, 'visual:home', 2),
  ],
  correlations: [
    hosted(4, 5),
    hosted(6, 99),
    hosted(7, 5),
    designation(5, 'visual:home', 0),
    hosted(9, 5),
  ],
  reclaims: [
    reclaimed(9, 99),
    hosted(7, 5),
    event(8, 'pr-attachment.reclaim-failed', { hostedSeq: 7, attempt: 1, error: 'timeout' }),
    reclaimed(6, 7),
    hosted(3, 1),
    reclaimed(10, 7),
  ],
  hostConsent: [created(8, true), noise(2), created(3, false), created(12, true)],
}

function generated(seed: number): AbEvent[] {
  const rand = seededRandom(seed)
  const kinds = ['visual:a', 'visual:b', 'visual:c']
  const log: AbEvent[] = []
  const n = 4 + Math.floor(rand() * 18)
  for (let seq = 1; seq <= n; seq++) {
    const roll = rand()
    if (roll < 0.3) log.push(designation(seq, pick(rand, kinds), seq))
    else if (roll < 0.5) log.push(hosted(seq, 1 + Math.floor(rand() * n)))
    else if (roll < 0.65) log.push(reclaimed(seq, 1 + Math.floor(rand() * n)))
    else if (roll < 0.72) log.push(revised(seq))
    else if (roll < 0.8) log.push(created(seq, rand() < 0.5))
    else log.push(noise(seq))
  }
  return rand() < 0.7 ? shuffled(rand, log) : log
}

// The original whole-array implementations, as the oracle.
function oracleCurrent(events: readonly AbEvent[]) {
  let restartSeq = 0
  for (const e of events) if (e.type === 'spec.revised') restartSeq = Math.max(restartSeq, e.seq)
  const byKind = new Map<string, Extract<AbEvent, { type: 'pr-attachment.designated' }>>()
  for (const e of events) {
    if (e.type !== 'pr-attachment.designated' || e.seq <= restartSeq) continue
    const prev = byKind.get(e.payload.artifact.kind)
    if (prev === undefined || e.seq > prev.seq) byKind.set(e.payload.artifact.kind, e)
  }
  return [...byKind.values()].sort((a, b) => a.seq - b.seq)
}
function oracleHosted(events: readonly AbEvent[]) {
  const bySeq = new Map(oracleCurrent(events).map((e) => [e.seq, e]))
  const out = new Map<number, Extract<AbEvent, { type: 'pr-attachment.hosted' }>>()
  for (const e of events) {
    if (e.type !== 'pr-attachment.hosted') continue
    const d = bySeq.get(e.payload.designationSeq)
    if (d === undefined || e.seq <= d.seq) continue
    const prev = out.get(d.seq)
    if (prev === undefined || e.seq > prev.seq) out.set(d.seq, e)
  }
  return out
}
function oracleReclaims(events: readonly AbEvent[]) {
  const hostedEvents = events
    .filter(
      (e): e is Extract<AbEvent, { type: 'pr-attachment.hosted' }> =>
        e.type === 'pr-attachment.hosted',
    )
    .sort((a, b) => a.seq - b.seq)
  const seqs = new Set(hostedEvents.map((e) => e.seq))
  const done = new Set<number>()
  for (const e of events) {
    if (
      e.type === 'pr-attachment.reclaimed' &&
      seqs.has(e.payload.hostedSeq) &&
      e.seq > e.payload.hostedSeq
    )
      done.add(e.payload.hostedSeq)
  }
  return hostedEvents.filter((e) => !done.has(e.seq))
}
function oracleHost(events: readonly AbEvent[]) {
  let c: Extract<AbEvent, { type: 'build.created' }> | undefined
  for (const e of events)
    if (e.type === 'build.created' && (c === undefined || e.seq < c.seq)) c = e
  return c?.payload.pr?.imageHost
}

const logs: [string, AbEvent[]][] = [
  ...Object.entries(fixtures),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map((seed): [string, AbEvent[]] => [
    `seed ${seed}`,
    generated(seed),
  ]),
]

describe('pr-attachments incremental reducers', () => {
  test('versions start at 1', () => {
    expect(FROZEN_PR_IMAGE_HOST_REDUCER_VERSION).toBe(1)
    expect(CURRENT_PR_ATTACHMENTS_REDUCER_VERSION).toBe(1)
    expect(HOSTED_PR_ATTACHMENTS_REDUCER_VERSION).toBe(1)
    expect(PENDING_PR_ATTACHMENT_RECLAIMS_REDUCER_VERSION).toBe(1)
  })

  for (const [name, log] of logs) {
    test(`matches the whole-array oracle and the incremental contract: ${name}`, () => {
      expect(frozenPrImageHost(log)).toEqual(oracleHost(log))
      expect(currentPrAttachments(log)).toEqual(oracleCurrent(log))
      expect(hostedPrAttachments(log)).toEqual(oracleHosted(log))
      expect(pendingPrAttachmentReclaims(log)).toEqual(oracleReclaims(log))
      checkIncremental(frozenPrImageHostReducer, log)
      checkIncremental(currentPrAttachmentsReducer, log)
      checkIncremental(hostedPrAttachmentsReducer, log)
      checkIncremental(pendingPrAttachmentReclaimsReducer, log)
    })
  }

  test('hostedPrAttachments still honours an explicit designations argument', () => {
    const log = [designation(5, 'visual:home', 0), hosted(7, 5), hosted(8, 6)]
    expect(hostedPrAttachments(log, []).size).toBe(0)
    expect(
      hostedPrAttachments(log, [designation(6, 'visual:x', 0) as PrAttachmentDesignationEvent]).get(
        6,
      )?.seq,
    ).toBe(8)
  })

  test('accumulators are plain JSON', () => {
    const log = fixtures.correlations as AbEvent[]
    const acc = hostedPrAttachmentsReducer.advance(hostedPrAttachmentsReducer.initial(), log)
    expect(JSON.parse(JSON.stringify(acc))).toEqual(acc)
  })
})
