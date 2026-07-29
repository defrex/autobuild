import { describe, expect, test } from 'bun:test'
import type { AbEvent, EventEnvelope, EventWrite } from '../events/catalog'
import type { EventType } from '../events/payloads'
import { sampleBuildInput, sampleEventWrite } from '../store/contract'
import { MemoryBuildStore } from '../store/memory'
import {
  autoMergeDeferralObservation,
  autoMergeDeferralRef,
  classifyAutoMergeEnable,
  hasAutoMergeDeferralObservation,
  mergeStateStatuses,
  recordAutoMergeDeferralObservation,
  type MergeGatePresence,
} from './auto-merge'

describe('classifyAutoMergeEnable', () => {
  const expected = {
    BEHIND: { present: 'native', absent: 'direct' },
    BLOCKED: { present: 'native', absent: 'error' },
    CLEAN: { present: 'native', absent: 'direct' },
    DIRTY: { present: 'deferred', absent: 'deferred' },
    DRAFT: { present: 'error', absent: 'error' },
    HAS_HOOKS: { present: 'native', absent: 'native' },
    UNKNOWN: { present: 'native', absent: 'deferred' },
    UNSTABLE: { present: 'native', absent: 'direct' },
  } as const

  for (const state of mergeStateStatuses) {
    for (const gate of ['present', 'absent'] as const satisfies readonly MergeGatePresence[]) {
      test(`${state} + gate ${gate} -> ${expected[state][gate]}`, () => {
        expect(classifyAutoMergeEnable(state, gate).kind).toBe(expected[state][gate])
      })
    }
  }

  test('CLEAN never chooses direct ownership from current satisfaction alone', () => {
    expect(classifyAutoMergeEnable('CLEAN', 'present')).toEqual({ kind: 'native' })
    expect(classifyAutoMergeEnable('CLEAN', 'absent')).toEqual({ kind: 'direct' })
  })
})

const DEFERRAL_REASON = {
  code: 'repository-auto-merge-disabled',
  detail: 'allow_auto_merge=false',
} as const

class InterleavingStore extends MemoryBuildStore {
  private interleave = true

  override async appendIfCurrent<T extends EventType>(
    slug: string,
    expectedSeq: number,
    event: EventWrite<T>,
  ): Promise<EventEnvelope<T> | null> {
    if (this.interleave) {
      this.interleave = false
      await this.append(slug, sampleEventWrite('unrelated concurrent event'))
    }
    return super.appendIfCurrent(slug, expectedSeq, event)
  }
}

class ConditionalBarrierStore extends MemoryBuildStore {
  private arrivals = 0
  private release!: () => void
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve
  })

  override async appendIfCurrent<T extends EventType>(
    slug: string,
    expectedSeq: number,
    event: EventWrite<T>,
  ): Promise<EventEnvelope<T> | null> {
    this.arrivals += 1
    if (this.arrivals === 2) this.release()
    await this.gate
    return super.appendIfCurrent(slug, expectedSeq, event)
  }
}

describe('auto-merge deferral observations', () => {
  test('uses an auto-merge-gate-specific summary and stable PR/command marker', () => {
    const write = autoMergeDeferralObservation(DEFERRAL_REASON, 42, 17, 'obs_1')
    expect(write.payload.summary).toContain('Auto-merge gate')
    expect(write.payload.summary).toContain('repository-level auto-merge is disabled')
    expect(write.payload.refs).toEqual([autoMergeDeferralRef(42, 17)])

    const event = {
      build: 'build-1',
      seq: 18,
      ts: '2026-01-01T00:00:00.000Z',
      ...write,
    } as AbEvent
    expect(hasAutoMergeDeferralObservation([event], 42, 17)).toBe(true)
    expect(hasAutoMergeDeferralObservation([event], 42, 19)).toBe(false)
  })

  test('describes a local checkout collision with the provider path detail', () => {
    const write = autoMergeDeferralObservation(
      {
        code: 'local-base-checkout-dirty',
        detail: "error: Entry 'src/config.ts' not uptodate. Cannot merge.",
      },
      42,
      17,
      'obs_checkout',
    )
    expect(write.payload.summary).toBe(
      "Auto-merge gate could not apply consent for PR #42: local merge is blocked by uncommitted work in the base checkout — error: Entry 'src/config.ts' not uptodate. Cannot merge.",
    )
    expect(write.payload.refs).toEqual([autoMergeDeferralRef(42, 17)])
  })

  test('a single writer records a newly encountered deferral', async () => {
    const store = new MemoryBuildStore()
    await store.createBuild(sampleBuildInput('deferral-single'))

    const recorded = await recordAutoMergeDeferralObservation(
      store,
      'deferral-single',
      DEFERRAL_REASON,
      42,
      17,
      'obs_single',
    )

    expect(recorded?.seq).toBe(1)
    expect((await store.getEvents('deferral-single')).map((event) => event.type)).toEqual([
      'observation.recorded',
    ])
  })

  test('an already-recorded marker suppresses repeated processing', async () => {
    const store = new MemoryBuildStore()
    await store.createBuild(sampleBuildInput('deferral-existing'))
    await store.append(
      'deferral-existing',
      autoMergeDeferralObservation(DEFERRAL_REASON, 42, 17, 'obs_existing'),
    )

    const recorded = await recordAutoMergeDeferralObservation(
      store,
      'deferral-existing',
      DEFERRAL_REASON,
      42,
      17,
      'obs_duplicate',
    )

    expect(recorded).toBeNull()
    const events = await store.getEvents('deferral-existing')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ id: 'obs_existing' })
  })

  test('an unrelated interleaving append causes a retry rather than dropping the observation', async () => {
    const store = new InterleavingStore()
    await store.createBuild(sampleBuildInput('deferral-interleaved'))

    const recorded = await recordAutoMergeDeferralObservation(
      store,
      'deferral-interleaved',
      DEFERRAL_REASON,
      42,
      17,
      'obs_after_retry',
    )

    expect(recorded?.seq).toBe(2)
    const events = await store.getEvents('deferral-interleaved')
    expect(events.map((event) => event.seq)).toEqual([1, 2])
    expect(hasAutoMergeDeferralObservation(events, 42, 17)).toBe(true)
  })

  test('two callers racing at the conditional append seam retain exactly one winner', async () => {
    const store = new ConditionalBarrierStore()
    await store.createBuild(sampleBuildInput('deferral-race'))

    const results = await Promise.all([
      recordAutoMergeDeferralObservation(store, 'deferral-race', DEFERRAL_REASON, 42, 17, 'obs_a'),
      recordAutoMergeDeferralObservation(store, 'deferral-race', DEFERRAL_REASON, 42, 17, 'obs_b'),
    ])

    const winner = results.find((result) => result !== null)
    expect(results.filter((result) => result !== null)).toHaveLength(1)
    const events = (await store.getEvents('deferral-race')).filter(
      (event) => event.type === 'observation.recorded',
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ id: winner?.payload.id })
  })

  test('a new command sequence remains independently recordable', async () => {
    const store = new MemoryBuildStore()
    await store.createBuild(sampleBuildInput('deferral-new-command'))
    await store.append(
      'deferral-new-command',
      autoMergeDeferralObservation(DEFERRAL_REASON, 42, 17, 'obs_old'),
    )

    await recordAutoMergeDeferralObservation(
      store,
      'deferral-new-command',
      DEFERRAL_REASON,
      42,
      18,
      'obs_new',
    )

    const events = await store.getEvents('deferral-new-command')
    expect(events).toHaveLength(2)
    expect(hasAutoMergeDeferralObservation(events, 42, 17)).toBe(true)
    expect(hasAutoMergeDeferralObservation(events, 42, 18)).toBe(true)
  })
})
