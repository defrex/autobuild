import { describe, expect, test } from 'bun:test'
import type { AbEvent, EventWrite } from '../events/catalog'
import { allowedActorKinds, validateEventWrite } from '../events/catalog'
import { DISPATCHER, KERNEL, humanActor, type Actor } from '../events/envelope'
import type { EventType } from '../events/payloads'
import { steppingClock } from '../testing/fixed'
import { dispatchCapacity, epilogueLeaf, intakeCapacity, slotRequest } from './dispatch-capacity'
import { leafLandingDeclineReason } from './landing-readiness'
import { reduceBuild, type BuildState } from './reducer'
import {
  reopenCurrent,
  reopenPublicationRefusal,
  reopenRefusal,
  reopenRestart,
  reopenSpecPending,
  reopenUnsettled,
} from './reopen'

const now = new Date('2026-11-20T12:00:00Z')

function actorFor(type: EventType): Actor {
  switch (allowedActorKinds[type][0]) {
    case 'kernel':
      return KERNEL
    case 'dispatcher':
      return DISPATCHER
    case 'human':
      return humanActor('ada', { kind: 'mcp', client: 'test' })
    default:
      return { kind: 'agent', role: 'test-role', session: 's_test' }
  }
}

const w = (type: EventType, payload: Record<string, unknown>): EventWrite =>
  validateEventWrite({ actor: actorFor(type), type, payload } as EventWrite)

function log(writes: EventWrite[]): AbEvent[] {
  const clock = steppingClock()
  return writes.map(
    (write, index) =>
      ({
        ...write,
        build: 'leaf',
        seq: index + 1,
        ts: clock().toISOString(),
      }) as AbEvent,
  )
}

const asset = (name: string, revision: number) => ({
  kind: 'design',
  name,
  revision,
  layout: 'file' as const,
  size: 1,
  fileCount: 1,
  dirCount: 0,
})
const OLD = asset('old', 1)
const ASSET = asset('mock', 2)
const PR = { number: 7, url: 'https://forge/pr/7', headSha: 'sha-r1' }

/** A leaf that finished its pipeline and settled awaiting merge; seq 12 is
 * the latest finalize, so `pipeline.settled {cycle: 12}` settles it. */
function settledWrites(): EventWrite[] {
  return [
    w('build.created', {
      ticket: { source: 'file', id: 'T-1' },
      repo: 'repo',
      baseBranch: 'main',
      assets: [OLD],
    }),
    w('spec.imported', {
      artifact: { kind: 'spec', rev: 0 },
      ticket: { source: 'file', id: 'T-1' },
    }),
    w('runner.attached', { instance: 'r1', host: 'local' }),
    w('plan.started', { round: 1 }),
    w('plan.completed', { round: 1, artifact: { kind: 'plan', rev: 0 } }),
    w('plan-review.verdict', {
      round: 1,
      verdict: 'approve',
      findings: [],
      artifact: { kind: 'plan-review', rev: 0 },
    }),
    w('implement.started', { round: 1 }),
    w('implement.completed', {
      round: 1,
      commits: { base: 'b', head: 'sha-r1' },
      artifact: { kind: 'implement-notes', rev: 0 },
    }),
    w('code-review.verdict', {
      round: 1,
      verdict: 'approve',
      findings: [],
      artifact: { kind: 'code-review', rev: 0 },
    }),
    w('verify.completed', { step: 'unit', attempt: 1, pass: true }),
    w('finalize.started', {}),
    w('finalize.completed', { pr: PR }),
    w('pipeline.settled', { cycle: 12 }),
  ]
}

const state = (writes: EventWrite[]): BuildState => reduceBuild(log(writes))
const reopen = (payload: Record<string, unknown>) => w('build.reopened', payload)
const published = (rev: number, assets?: unknown[]) =>
  w('spec.revised', {
    artifact: { kind: 'spec', rev },
    operator: { user: 'ada' },
    ...(assets !== undefined ? { assets } : {}),
  })

function capacityBuild(current: BuildState) {
  return {
    record: {
      slug: 'leaf',
      repo: 'repo',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    state: current,
    workspace: true,
  }
}

describe('reduced reopen', () => {
  test('records the operator, feedback and a verify cycle boundary', () => {
    const current = state([...settledWrites(), reopen({ feedback: 'rename it' })])
    expect(current.reopen).toEqual({
      seq: 14,
      ts: current.lastEvent!.ts,
      user: 'ada',
      via: { kind: 'mcp', client: 'test' },
      feedback: 'rename it',
    })
    expect(current.verify.cycleSince).toBe(14)
  })

  test('clears the code ceiling, and the plan ceiling only with a spec', () => {
    const ceilings: EventWrite[] = [
      w('escalation.raised', {
        id: 'e1',
        phase: 'code-review',
        source: 'policy',
        policyCause: 'review-round-limit',
        question: 'q',
      }),
      w('escalation.answered', {
        id: 'e1',
        answer: 'go',
        resolution: 'guidance',
        reviewRoundCeiling: 9,
      }),
    ]
    const withCeiling = [...settledWrites(), ...ceilings]
    expect(state(withCeiling).reviewRoundCeilings.code).toBe(9)
    expect(state([...withCeiling, reopen({ feedback: 'x' })]).reviewRoundCeilings.code).toBe(
      undefined,
    )
  })

  test('keeps the recorded assets exactly as given and publishes them on the matching revision', () => {
    for (const assets of [[ASSET], [], undefined]) {
      const spec = { artifact: { kind: 'spec', rev: 1 }, ...(assets ? { assets } : {}) }
      const recorded = state([...settledWrites(), reopen({ spec })])
      expect(recorded.reopen?.spec).toEqual(spec)
      // The pins change only when the kernel publishes the revision.
      expect(recorded.pinnedAssets).toEqual([OLD])
      const after = state([...settledWrites(), reopen({ spec }), published(1, assets)])
      expect(after.reopen?.specPublishedSeq).toBe(15)
      expect(after.pinnedAssets).toEqual(assets ?? [OLD])
    }
  })

  test('an unrelated revision does not count as the publication', () => {
    const current = state([
      ...settledWrites(),
      reopen({ spec: { artifact: { kind: 'spec', rev: 2 } } }),
      w('spec.revised', { artifact: { kind: 'spec', rev: 1 }, escalation: 1 }),
    ])
    expect(current.reopen?.specPublishedSeq).toBeUndefined()
    expect(reopenSpecPending(current)).toBe(true)
  })
})

describe('reopen predicates across the lifecycle', () => {
  test('feedback reopen → resettle → later escalation revision', () => {
    const reopened = [...settledWrites(), reopen({ feedback: 'x' })]
    let current = state(reopened)
    expect([reopenCurrent(current), reopenUnsettled(current), reopenSpecPending(current)]).toEqual([
      true,
      true,
      false,
    ])
    current = state([...reopened, w('pipeline.settled', { cycle: 14 })])
    expect([reopenCurrent(current), reopenUnsettled(current)]).toEqual([true, false])
    current = state([
      ...reopened,
      w('pipeline.settled', { cycle: 14 }),
      w('spec.revised', { artifact: { kind: 'spec', rev: 1 }, escalation: 1 }),
    ])
    expect(reopenCurrent(current)).toBe(false)
  })

  test('spec reopen → publication → later escalation revision', () => {
    const recorded = [...settledWrites(), reopen({ spec: { artifact: { kind: 'spec', rev: 1 } } })]
    let current = state(recorded)
    expect([reopenSpecPending(current), reopenCurrent(current), reopenRestart(current)]).toEqual([
      true,
      false,
      false,
    ])
    current = state([...recorded, published(1)])
    expect([reopenSpecPending(current), reopenCurrent(current), reopenRestart(current)]).toEqual([
      false,
      true,
      true,
    ])
    current = state([
      ...recorded,
      published(1),
      w('spec.revised', { artifact: { kind: 'spec', rev: 2 }, escalation: 1 }),
    ])
    expect([reopenCurrent(current), reopenRestart(current)]).toEqual([false, false])
  })
})

describe('reopenRefusal', () => {
  const refused = (writes: EventWrite[], opts = {}) =>
    reopenRefusal('leaf', state(writes), opts)?.code

  test('accepts a settled leaf, paused or held', () => {
    expect(refused(settledWrites())).toBeUndefined()
    expect(
      refused([...settledWrites(), w('build.pause-requested', {}), w('build.paused', {})]),
    ).toBeUndefined()
    expect(refused([...settledWrites(), w('build.hold-requested', {})])).toBeUndefined()
  })

  test('refuses each ineligible state with its code', () => {
    const settled = settledWrites()
    expect(refused([...settled, w('pr.merged', { sha: 's' })])).toBe('not-reopenable')
    expect(refused([...settled, w('pr.closed', {})])).toBe('not-reopenable')
    expect(refused([...settled, w('build.completed', { outcome: 'merged' })])).toBe('inactive')
    expect(refused([...settled, w('build.aborted', {})])).toBe('inactive')
    expect(refused(settled.slice(0, 1))).toBe('inactive')
    expect(refused([...settled, w('build.abort-requested', {})])).toBe('abort-pending')
    expect(refused(settled, { attempt: true })).toBe('not-reopenable')
    expect(refused(settled, { restackActive: true })).toBe('not-reopenable')
    expect(
      refused([
        ...settled,
        w('escalation.raised', { id: 'e', phase: 'implement', source: 'agent', question: 'q' }),
      ]),
    ).toBe('not-reopenable')
    expect(refused([...settled, w('pr.conflicted', { baseSha: 'm' })])).toBe('not-reopenable')
    // Not settled: finalize ran but no settlement is recorded yet.
    expect(refused(settled.slice(0, -1))).toBe('not-reopenable')
    // A reopen still re-running refuses another.
    expect(refused([...settled, reopen({ feedback: 'x' })])).toBe('not-reopenable')
    const node = state(settled)
    expect(reopenRefusal('leaf', { ...node, kind: 'node' })?.code).toBe('not-reopenable')
    expect(
      reopenRefusal('leaf', { ...node, discardRequest: { seq: 1, actor: humanActor('a') } })?.code,
    ).toBe('discard-pending')
  })

  test('a terminal refusal names the new-ticket rule', () => {
    expect(
      reopenRefusal('leaf', state([...settledWrites(), w('pr.merged', { sha: 's' })]))?.message,
    ).toContain('new ticket')
  })
})

describe('reopenPublicationRefusal', () => {
  const recorded = [...settledWrites(), reopen({ spec: { artifact: { kind: 'spec', rev: 1 } } })]
  const refusal = (writes: EventWrite[]) => reopenPublicationRefusal('leaf', state(writes))

  test('allows publication on the deliberately unsettled leaf', () => {
    expect(refusal(recorded)).toBeUndefined()
    expect(reopenSpecPending(state(recorded))).toBe(true)
  })

  test('refuses abort, ended PRs and terminal builds', () => {
    expect(refusal([...recorded, w('build.abort-requested', {})])?.code).toBe('abort-pending')
    expect(refusal([...recorded, w('pr.merged', { sha: 's' })])?.code).toBe('not-reopenable')
    expect(refusal([...recorded, w('pr.closed', {})])?.code).toBe('not-reopenable')
    expect(refusal([...recorded, w('build.aborted', {})])?.code).toBe('inactive')
    expect(
      reopenPublicationRefusal('leaf', {
        ...state(recorded),
        discardRequest: { seq: 1, actor: humanActor('a') },
      })?.message,
    ).toContain('was recorded but its spec was not published')
  })
})

describe('capacity and landing for a reopened leaf', () => {
  test('a feedback reopen parks, requests a reopen slot and reserves intake', () => {
    const current = state([...settledWrites(), reopen({ feedback: 'x' })])
    const build = capacityBuild(current)
    expect(epilogueLeaf(current)).toBe(true)
    expect(slotRequest(build, now)).toBe('reopen')
    const capacity = dispatchCapacity([build], 2, now)
    expect(capacity).toMatchObject({
      occupied: 0,
      waitingBuilds: [{ slug: 'leaf', request: 'reopen' }],
    })
    expect(intakeCapacity(capacity)).toBe(1)
  })

  test('once admitted it occupies a slot; resettled it requests nothing', () => {
    const current = state([...settledWrites(), reopen({ feedback: 'x' })])
    const leased = {
      ...capacityBuild(current),
      record: {
        ...capacityBuild(current).record,
        lease: { holder: 'h', expiresAt: new Date(now.getTime() + 60_000).toISOString() },
      },
    }
    expect(dispatchCapacity([leased], 2, now).occupied).toBe(1)
    const resettled = state([
      ...settledWrites(),
      reopen({ feedback: 'x' }),
      w('finalize.completed', { pr: PR }),
      w('pipeline.settled', { cycle: 15 }),
    ])
    expect(slotRequest(capacityBuild(resettled), now)).toBeUndefined()
  })

  test('a spec reopen requests nothing until published, then stays a parked leaf', () => {
    const recorded = [...settledWrites(), reopen({ spec: { artifact: { kind: 'spec', rev: 1 } } })]
    expect(slotRequest(capacityBuild(state(recorded)), now)).toBeUndefined()
    const restarted = state([...recorded, published(1)])
    expect(epilogueLeaf(restarted)).toBe(true)
    expect(slotRequest(capacityBuild(restarted), now)).toBe('reopen')
  })

  test('landing declines while the reopen re-runs', () => {
    expect(leafLandingDeclineReason(state(settledWrites()))).toBeUndefined()
    expect(leafLandingDeclineReason(state([...settledWrites(), reopen({ feedback: 'x' })]))).toBe(
      'the build was reopened and is re-running its pipeline',
    )
  })
})
