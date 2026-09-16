import { describe, expect, test } from 'bun:test'
import type { AbEvent, EventEnvelope, EventWrite } from '../events/catalog'
import { KERNEL } from '../events/envelope'
import type { EventType } from '../events/payloads'
import { sampleBuildInput, sampleEventWrite } from '../store/contract'
import { MemoryBuildStore } from '../store/memory'
import {
  autoMergeDeferralObservation,
  autoMergeDeferralRef,
  classifyAutoMergeEnable,
  currentAutoMergeDeferral,
  currentDeferralObservation,
  hasAutoMergeDeferralObservation,
  mergeStateStatuses,
  recordAutoMergeDeferralObservation,
  type MergeGatePresence,
} from './auto-merge'
import { autoMergeDeferralClasses } from '../ports/types'

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

describe('autoMergeDeferralClasses', () => {
  test('pins the closed classification of the deferral-code union', () => {
    expect(autoMergeDeferralClasses).toEqual({
      'github-plan-limitation': 'human-actionable',
      'repository-auto-merge-disabled': 'human-actionable',
      'unproven-gate-state': 'human-actionable',
      'merge-conflicts': 'pipeline-resolved',
      'mergeability-uncomputed': 'pipeline-resolved',
      'local-base-checkout-dirty': 'human-actionable',
      'local-git-identity-missing': 'human-actionable',
    })
  })
})

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

describe('currentAutoMergeDeferral', () => {
  const observation = (pr: number, commandSeq: number, summary: string, seq?: number): AbEvent =>
    ({
      build: 'build-1',
      seq: seq ?? commandSeq + 1,
      ts: '2026-01-01T00:00:00.000Z',
      ...autoMergeDeferralObservation(
        { code: 'repository-auto-merge-disabled', detail: summary },
        pr,
        commandSeq,
        `obs_${seq ?? commandSeq + 1}`,
      ),
    }) as AbEvent

  const reconcileDone = (seq: number): AbEvent =>
    ({
      build: 'build-1',
      seq,
      ts: '2026-01-01T00:00:00.000Z',
      actor: { kind: 'agent', role: 'reconcile', session: 's_reconcile' },
      type: 'reconcile.completed',
      payload: { mergeCommit: 'sha-merge', artifact: { kind: 'reconcile-notes', rev: 0 } },
    }) as AbEvent

  const finalizeDone = (seq: number, headSha: string): AbEvent =>
    ({
      build: 'build-1',
      seq,
      ts: '2026-01-01T00:00:00.000Z',
      actor: KERNEL,
      type: 'finalize.completed',
      payload: { pr: { number: 42, url: 'https://example.test/42', headSha } },
    }) as AbEvent

  const prMerged = (seq: number): AbEvent =>
    ({
      build: 'build-1',
      seq,
      ts: '2026-01-01T00:00:00.000Z',
      actor: { kind: 'dispatcher' },
      type: 'pr.merged',
      payload: { sha: 'squash-42' },
    }) as AbEvent

  const prClosed = (seq: number): AbEvent =>
    ({
      build: 'build-1',
      seq,
      ts: '2026-01-01T00:00:00.000Z',
      actor: { kind: 'dispatcher' },
      type: 'pr.closed',
      payload: {},
    }) as AbEvent

  const state = {
    pr: { number: 42, url: 'https://example.test/42', headSha: 'head' },
    autoMerge: { requested: true, commandSeq: 17 },
  }

  test('returns the complete provider-bearing summary for the current pending enable', () => {
    const github = observation(42, 17, 'allow_auto_merge=false')
    const local = observation(42, 18, "error: Entry 'src/config.ts' not uptodate")

    expect(
      currentAutoMergeDeferral([github], {
        pr: { number: 42, url: 'https://example.test/42', headSha: 'head' },
        autoMerge: { requested: true, commandSeq: 17 },
      }),
    ).toContain('allow_auto_merge=false')
    expect(
      currentAutoMergeDeferral([local], {
        pr: { number: 42, url: 'local://42', headSha: 'head' },
        autoMerge: { requested: true, commandSeq: 18 },
      }),
    ).toContain("error: Entry 'src/config.ts' not uptodate")
  })

  test('ignores another PR or superseded command', () => {
    const old = observation(42, 17, 'old provider detail')
    expect(
      currentAutoMergeDeferral([old], {
        pr: { number: 43, url: 'https://example.test/43', headSha: 'head' },
        autoMerge: { requested: true, commandSeq: 17 },
      }),
    ).toBeUndefined()
    expect(
      currentAutoMergeDeferral([old], {
        pr: { number: 42, url: 'https://example.test/42', headSha: 'head' },
        autoMerge: { requested: true, commandSeq: 19 },
      }),
    ).toBeUndefined()
  })

  test('ignores applied and cancelled consent', () => {
    const deferred = observation(42, 17, 'provider detail')
    expect(
      currentAutoMergeDeferral([deferred], {
        pr: { number: 42, url: 'https://example.test/42', headSha: 'head' },
        autoMerge: { requested: true, commandSeq: 17, applied: { enabled: true, commandSeq: 17 } },
      }),
    ).toBeUndefined()
    expect(
      currentAutoMergeDeferral([deferred], {
        pr: { number: 42, url: 'https://example.test/42', headSha: 'head' },
        autoMerge: { requested: false, commandSeq: 19 },
      }),
    ).toBeUndefined()
  })

  test('a reconcile.completed after the observation supersedes it until consent is re-examined', () => {
    expect(
      currentAutoMergeDeferral(
        [observation(42, 17, 'stale provider detail'), reconcileDone(19)],
        state,
      ),
    ).toBeUndefined()
  })

  test('a fresh observation after the reconcile.completed is the current summary', () => {
    expect(
      currentAutoMergeDeferral(
        [
          observation(42, 17, 'stale provider detail', 18),
          reconcileDone(19),
          observation(42, 17, 'fresh provider detail', 20),
        ],
        state,
      ),
    ).toContain('fresh provider detail')
  })

  test('a finalize.completed naming a new head supersedes the observation', () => {
    expect(
      currentAutoMergeDeferral(
        [
          finalizeDone(17, 'head-1'),
          observation(42, 17, 'old detail', 18),
          finalizeDone(19, 'head-2'),
        ],
        state,
      ),
    ).toBeUndefined()
  })

  test('a finalize.completed that adopted the same PR at the same head keeps the observation', () => {
    // With and without a baseline finalize.completed before the observation —
    // the second shape is the §8.7 retry that honors a pre-existing marker.
    expect(
      currentAutoMergeDeferral(
        [finalizeDone(17, 'head-1'), observation(42, 17, 'detail', 18), finalizeDone(19, 'head-1')],
        state,
      ),
    ).toContain('detail')
    expect(
      currentAutoMergeDeferral(
        [observation(42, 17, 'detail', 17), finalizeDone(19, 'head-1')],
        state,
      ),
    ).toContain('detail')
  })

  test('a merged or closed PR ends the deferral even while consent is pending', () => {
    expect(
      currentAutoMergeDeferral([observation(42, 17, 'provider detail'), prMerged(19)], state),
    ).toBeUndefined()
    expect(
      currentAutoMergeDeferral([observation(42, 17, 'provider detail'), prClosed(19)], state),
    ).toBeUndefined()
  })

  test('the shared predicate underlies both the projection and the dedupe', () => {
    const superseded = [observation(42, 17, 'detail', 18), reconcileDone(19)]
    expect(currentDeferralObservation(superseded, 42, 17)).toBeUndefined()
    expect(hasAutoMergeDeferralObservation(superseded, 42, 17)).toBe(false)
    const current = [observation(42, 17, 'detail', 18)]
    expect(currentDeferralObservation(current, 42, 17)?.payload.summary).toContain('detail')
    expect(hasAutoMergeDeferralObservation(current, 42, 17)).toBe(true)
  })
})

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

  test('describes missing local Git identity with setup guidance and stable consent marker', () => {
    const write = autoMergeDeferralObservation(
      {
        code: 'local-git-identity-missing',
        detail:
          'Configure the repository identity with `git config user.name "Your Name"` and `git config user.email "you@example.com"`.',
      },
      42,
      17,
      'obs_identity',
    )
    expect(write.payload.summary).toContain(
      'local squash requires a configured Git author and committer identity',
    )
    expect(write.payload.summary).toContain('git config user.name')
    expect(write.payload.summary).toContain('git config user.email')
    expect(write.payload.refs).toEqual([autoMergeDeferralRef(42, 17)])
  })

  test('a pipeline-owned or transient deferral records nothing and leaves consent pending', async () => {
    for (const code of ['merge-conflicts', 'mergeability-uncomputed'] as const) {
      const slug = `deferral-${code}`
      const store = new MemoryBuildStore()
      await store.createBuild(sampleBuildInput(slug))

      const recorded = await recordAutoMergeDeferralObservation(
        store,
        slug,
        { code, detail: `forge detail for ${code}` },
        42,
        17,
        `obs_${code}`,
      )

      expect(recorded).toBeNull()
      expect(await store.getEvents(slug)).toEqual([])
    }
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

  test('a head-changing event supersedes the marker so the gate can re-record', async () => {
    const store = new MemoryBuildStore()
    await store.createBuild(sampleBuildInput('deferral-superseded'))
    await store.append(
      'deferral-superseded',
      autoMergeDeferralObservation(DEFERRAL_REASON, 42, 17, 'obs_old'),
    )
    expect(
      hasAutoMergeDeferralObservation(await store.getEvents('deferral-superseded'), 42, 17),
    ).toBe(true)

    await store.append('deferral-superseded', {
      actor: { kind: 'agent', role: 'reconcile', session: 's_reconcile' },
      type: 'reconcile.completed',
      payload: { mergeCommit: 'sha-merge', artifact: { kind: 'reconcile-notes', rev: 0 } },
    })
    expect(
      hasAutoMergeDeferralObservation(await store.getEvents('deferral-superseded'), 42, 17),
    ).toBe(false)

    const reRecorded = await recordAutoMergeDeferralObservation(
      store,
      'deferral-superseded',
      DEFERRAL_REASON,
      42,
      17,
      'obs_renewed',
    )
    expect(reRecorded).not.toBeNull()
    const events = await store.getEvents('deferral-superseded')
    expect(events.map((event) => event.type)).toEqual([
      'observation.recorded',
      'reconcile.completed',
      'observation.recorded',
    ])
    expect(hasAutoMergeDeferralObservation(events, 42, 17)).toBe(true)
  })
})
