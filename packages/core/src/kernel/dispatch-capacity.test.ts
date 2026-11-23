import { describe, expect, test } from 'bun:test'
import { DISPATCHER, KERNEL } from '../events/envelope'
import {
  commandObjective,
  OPTIMIZATION_SHA,
  OptimizationLogBuilder,
} from './generators/optimization-log'
import { reduceBuild } from './reducer'
import {
  buildPriority,
  capacityExplanation,
  dispatchCapacity,
  epilogueLeaf,
  epilogueUnsettled,
  intakeCapacity,
  nodeCapacity,
  occupiesCapacity,
  reservedAhead,
  settlementDue,
  settlementKey,
  slotRequest,
  slotWaitText,
  startCapacity,
  startClaimDemand,
  strandedNodeWorkspace,
  urgentClaimDemand,
  waitingExplanation,
  type CapacityBuild,
  type DispatchCapacity,
} from './dispatch-capacity'

const now = new Date('2026-10-20T15:00:00Z')
function build(
  slug: string,
  kind: 'work' | 'node' = 'work',
  status: CapacityBuild['state']['status'] = 'running',
  parent?: string,
): CapacityBuild {
  return {
    record: {
      slug,
      repo: 'repo',
      ticket: { source: 'file', id: slug },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    state: {
      ...reduceBuild([]),
      kind,
      status,
      ...(parent ? { target: { build: parent, ticket: { source: 'file', id: parent } } } : {}),
    },
    workspace: false,
  }
}
function conflict(slug: string): CapacityBuild {
  const node = build(slug, 'node')
  node.state.nodeRestack = { items: [], conflict: { id: 'conflict', index: 0, base: 'base' } }
  node.workspace = true
  return node
}

test('capacity five: two unrelated builds, three blocked descendants, and a reconcile node', () => {
  const builds = [
    conflict('node'),
    build('a'),
    build('b'),
    ...['c', 'd', 'e'].map((id) => build(id, 'work', 'blocked', 'node')),
  ]
  expect(nodeCapacity(builds, 'node', now)).toEqual({
    occupied: 2,
    excludedDescendants: ['c', 'd', 'e'],
  })
  expect(dispatchCapacity(builds, 5, now)).toEqual({
    configured: 5,
    occupied: 6,
    effective: 6,
    borrowingNodes: ['node'],
  })
  expect(dispatchCapacity(builds.slice(1), 5, now).occupied).toBe(5)
})

test('nested accepted ancestry and paused descendants qualify; running descendants and unrelated load count', () => {
  const builds = [
    conflict('node'),
    build('nested', 'node', 'collecting', 'node'),
    build('paused', 'work', 'paused', 'nested'),
    build('running', 'work', 'running', 'node'),
    build('unrelated', 'work', 'blocked'),
  ]
  expect(nodeCapacity(builds, 'node', now)).toEqual({
    occupied: 2,
    excludedDescendants: ['paused'],
  })
  builds[1]!.state.target = undefined
  expect(nodeCapacity(builds, 'node', now).excludedDescendants).toEqual([])
})

for (const malformed of ['missing', 'foreign', 'cycle'] as const)
  test(`conservative ancestry: ${malformed}`, () => {
    const node = conflict('node')
    const nested = build('nested', 'node', 'collecting', 'node')
    const child = build('child', 'work', 'blocked', 'nested')
    if (malformed === 'missing') child.state.target!.build = 'absent'
    if (malformed === 'foreign') child.state.target!.ticket.source = 'linear'
    if (malformed === 'cycle')
      nested.state.target = { build: 'nested', ticket: nested.record.ticket! }
    expect(nodeCapacity([node, nested, child], 'node', now).excludedDescendants).toEqual([])
  })

test('terminal and idle nodes are free; duplicate identities count once; unrelated saturation prevents admission', () => {
  const node = conflict('node')
  const builds = [
    node,
    build('idle', 'node', 'collecting'),
    build('done', 'work', 'done'),
    ...['a', 'b', 'c', 'd', 'e'].map((id) => build(id)),
  ]
  expect(nodeCapacity(builds, 'node', now).occupied).toBe(5)
  expect(dispatchCapacity([...builds, builds[3]!], 5, now).occupied).toBe(6)
  expect(dispatchCapacity(builds, 5, now).borrowingNodes).toEqual([])
})

test('active unrelated nodes count, even when another node excludes their blocked children', () => {
  const builds = [conflict('first'), conflict('second'), build('child', 'work', 'blocked', 'first')]
  expect(nodeCapacity(builds, 'first', now).occupied).toBe(1)
  expect(nodeCapacity(builds, 'second', now).occupied).toBe(2)
})

test('an idle node lease does not occupy execution capacity', () => {
  const node = build('node', 'node', 'collecting')
  node.record.lease = { holder: 'runner', expiresAt: '2026-10-20T16:00:00Z' }
  expect(occupiesCapacity(node, now)).toBe(false)
})

function verifying(slug: string): CapacityBuild {
  const node = build(slug, 'node')
  node.state.nodeRestack = { items: [], contributionBase: 'parent' }
  node.state.nodeComparison = { headSha: 'head', parentSha: 'parent', ahead: 1 }
  node.state.integration = {
    observation: { openChildren: [], diagnostics: [], contributions: ['child'] },
    cycle: {
      id: 'cycle',
      seq: 1,
      head: 'head',
      parent: 'parent',
      config: JSON.stringify({ verify: { steps: ['unit'] } }),
    },
  }
  return node
}

test('verification reserves occupancy with workspace, provisioning or live lease; expired leases do not', () => {
  const node = verifying('node')
  expect(occupiesCapacity(node, now)).toBe(false)
  node.provisioning = true
  expect(occupiesCapacity(node, now)).toBe(true)
  node.provisioning = false
  node.record.lease = { holder: 'runner', expiresAt: '2026-10-20T16:00:00Z' }
  expect(occupiesCapacity(node, now)).toBe(true)
  node.record.lease.expiresAt = now.toISOString()
  expect(occupiesCapacity(node, now)).toBe(false)
  node.workspace = true
  expect(occupiesCapacity(node, now)).toBe(true)
})

test('pending verification may exclude paused descendants but active unrelated nodes consume the next admission slot', () => {
  const first = verifying('first')
  const second = verifying('second')
  const builds = [first, second, build('child', 'work', 'paused', 'first')]
  expect(nodeCapacity(builds, 'first', now).occupied).toBe(0)
  first.provisioning = true
  expect(nodeCapacity(builds, 'second', now).occupied).toBe(2)
  expect(dispatchCapacity(builds, 1, now)).toEqual({
    configured: 1,
    occupied: 2,
    effective: 2,
    borrowingNodes: ['first'],
    waitingNodes: [{ slug: 'second', request: 'verification' }],
  })
})

test('migration normalization joins remapped frozen ancestry on both sides without changing records', async () => {
  const { migrationIdentity } = await import('./ticket-migrations')
  const node = conflict('node')
  const child = build('child', 'work', 'paused', 'node')
  node.record.ticket = { source: 'linear', id: 'OLD-NODE' }
  const original = structuredClone(node.record)
  const normalize = migrationIdentity(
    {
      migrations: [
        { identity: 'cutover', from: 'linear', to: 'file', mapping: { 'OLD-NODE': 'node' } },
      ],
    },
    'file',
  )
  expect(nodeCapacity([node, child], 'node', now).excludedDescendants).toEqual([])
  expect(nodeCapacity([node, child], 'node', now, normalize).excludedDescendants).toEqual(['child'])
  child.state.target!.ticket = { source: 'linear', id: 'OLD-NODE' }
  node.record.ticket = { source: 'file', id: 'node' }
  expect(nodeCapacity([node, child], 'node', now, normalize).excludedDescendants).toEqual(['child'])
  expect(original.ticket).toEqual({ source: 'linear', id: 'OLD-NODE' })
})

test('a node awaiting verification reserves one intake slot without occupying one', () => {
  const builds = [verifying('node'), build('a'), build('b')]
  const capacity = dispatchCapacity(builds, 3, now)
  expect(capacity).toEqual({
    configured: 3,
    occupied: 2,
    effective: 3,
    borrowingNodes: [],
    waitingNodes: [{ slug: 'node', request: 'verification' }],
  })
  expect(intakeCapacity(capacity)).toBe(0)
  expect(nodeCapacity(builds, 'node', now).occupied).toBe(2)
})

test('a node holding its workspace, provisioning or live lease is occupied, not waiting', () => {
  for (const hold of ['workspace', 'provisioning', 'lease'] as const) {
    const node = verifying('node')
    if (hold === 'workspace') node.workspace = true
    if (hold === 'provisioning') node.provisioning = true
    if (hold === 'lease')
      node.record.lease = {
        holder: 'runner',
        expiresAt: '2026-10-20T16:00:00Z',
      }
    expect(slotRequest(node, now)).toBeUndefined()
    const capacity = dispatchCapacity([node, build('a')], 3, now)
    expect(capacity.occupied).toBe(2)
    expect(capacity.waitingNodes).toBeUndefined()
    expect(intakeCapacity(capacity)).toBe(1)
  }
})

test('paused, blocked, escalated, deferred, verified and landed nodes do not wait', () => {
  const variants: ((node: CapacityBuild) => void)[] = [
    (node) => (node.state.status = 'paused'),
    (node) => (node.state.status = 'blocked'),
    (node) =>
      (node.state.openEscalations = [
        { id: 'esc', phase: 'integration', question: 'q', seq: 2 } as never,
      ]),
    (node) => (node.state.compatibility = { decisiveFacts: 1 } as never),
    (node) => (node.state.prState = 'merged'),
    (node) =>
      (node.state.integration!.landing = {
        head: 'head',
        landed: 'head',
        provenance: 'human',
        fenced: false,
        verified: false,
      }),
    (node) =>
      (node.state.nodeComparison = {
        headSha: 'moved',
        parentSha: 'parent',
        ahead: 1,
      }),
  ]
  for (const change of variants) {
    const node = verifying('node')
    change(node)
    expect(slotRequest(node, now)).toBeUndefined()
    expect(intakeCapacity(dispatchCapacity([node], 2, now))).toBe(2)
  }
})

test('an unallocated conflict node waits for reconcile without being subtracted twice', () => {
  const node = conflict('node')
  node.workspace = false
  const capacity = dispatchCapacity([node, build('a')], 3, now)
  expect(capacity.occupied).toBe(2)
  expect(capacity.waitingNodes).toEqual([{ slug: 'node', request: 'reconcile' }])
  expect(intakeCapacity(capacity)).toBe(1)
  node.state.openEscalations = [{ id: 'esc' } as never]
  expect(slotRequest(node, now)).toBeUndefined()
})

test('capacity wording covers waiting, borrowing, both and a legacy projection', () => {
  const base: DispatchCapacity = {
    configured: 2,
    occupied: 2,
    effective: 2,
    borrowingNodes: [],
  }
  expect(capacityExplanation(base)).toBe('')
  expect(capacityExplanation(undefined)).toBe('')
  expect(
    capacityExplanation({
      ...base,
      waitingNodes: [{ slug: 'n', request: 'verification' }],
    }),
  ).toBe(' (2 configured; 1 node waiting for a slot ahead of normal ticket claims: n)')
  expect(capacityExplanation({ ...base, borrowingNodes: ['b'] })).toBe(
    ' (2 configured; 1 node using descendant-held slots: b)',
  )
  expect(
    capacityExplanation({
      ...base,
      borrowingNodes: ['b'],
      waitingNodes: [
        { slug: 'm', request: 'reconcile' },
        { slug: 'n', request: 'verification' },
      ],
    }),
  ).toBe(
    ' (2 configured; 1 node using descendant-held slots: b; 2 nodes waiting for a slot ahead of normal ticket claims: m, n)',
  )
  expect(slotWaitText('verification')).toBe(
    'verification waiting for a slot ahead of normal ticket claims',
  )
  expect(intakeCapacity(base)).toBe(0)
})

/** A leaf past `finalize.completed` at seq 10, settled at `settled` when given. */
function finished(
  slug: string,
  opts: {
    settled?: number
    status?: CapacityBuild['state']['status']
    lease?: boolean
    provisioning?: boolean
  } = {},
): CapacityBuild {
  const leaf = build(slug, 'work', opts.status ?? 'running')
  leaf.workspace = true
  leaf.state.finalizeCompletedSeq = 10
  leaf.state.prState = 'open'
  leaf.state.verify = { ...leaf.state.verify, cycleSince: 4 }
  if (opts.settled !== undefined) leaf.state.pipelineSettled = opts.settled
  if (opts.lease)
    leaf.record.lease = {
      holder: 'runner',
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    } as never
  if (opts.provisioning) leaf.provisioning = true
  return leaf
}

test('a leaf past finalize.completed keeps its slot until settlement, paused or blocked too', () => {
  for (const status of ['running', 'paused', 'blocked'] as const) {
    const leaf = finished('a', { status })
    expect(epilogueLeaf(leaf.state)).toBe(false)
    expect(occupiesCapacity(leaf, now)).toBe(true)
    expect(slotRequest(leaf, now)).toBeUndefined()
    expect(settlementDue(leaf.state)).toBe(true)
  }
})

test('a settled leaf with no runner is parked and free; a runner makes it occupy', () => {
  const parked = finished('a', { settled: 10 })
  expect(settlementKey(parked.state)).toBe(10)
  expect(epilogueLeaf(parked.state)).toBe(true)
  expect(settlementDue(parked.state)).toBe(false)
  expect(occupiesCapacity(parked, now)).toBe(false)
  expect(slotRequest(parked, now)).toBeUndefined()
  expect(occupiesCapacity(finished('a', { settled: 10, lease: true }), now)).toBe(true)
  expect(occupiesCapacity(finished('a', { settled: 10, provisioning: true }), now)).toBe(true)
  const expired = finished('a', { settled: 10 })
  expired.record.lease = { holder: 'r', expiresAt: '2026-10-20T14:00:00Z' } as never
  expect(occupiesCapacity(expired, now)).toBe(false)
  // An open provider-observable execution holds its runner past lease expiry
  // until its end is recorded; a local one's liveness is its lease.
  const execution = { provider: 'p', workspaceRef: 'w', instance: 'i', seq: 12 }
  expired.state.openExecution = { ...execution, commandId: 'cmd' }
  expect(occupiesCapacity(expired, now)).toBe(true)
  expect(slotRequest({ ...expired, restackDue: true }, now)).toBeUndefined()
  expired.state.openExecution = execution
  expect(occupiesCapacity(expired, now)).toBe(false)
  for (const status of ['paused', 'blocked'] as const) {
    const leaf = finished('a', { settled: 10, status })
    expect(occupiesCapacity(leaf, now)).toBe(false)
    leaf.state.prState = 'conflicted'
    expect(slotRequest(leaf, now)).toBeUndefined()
  }
})

test('held, consented and auto-landing settled leaves are all free', () => {
  for (const landing of [
    { hold: { seq: 11 } },
    { command: { kind: 'land', seq: 11 } },
    { decision: { seq: 11 } },
  ]) {
    const leaf = finished('a', { settled: 10 })
    leaf.state.landing = landing as never
    expect(occupiesCapacity(leaf, now)).toBe(false)
  }
})

test('a spec revision after settlement makes the leaf unfinished again', () => {
  const leaf = finished('a', { settled: 10 })
  leaf.state.restartSince = 10
  expect(epilogueLeaf(leaf.state)).toBe(false)
  expect(occupiesCapacity(leaf, now)).toBe(true)
  expect(settlementDue(leaf.state)).toBe(false)
  leaf.state.restartSince = 12
  expect(occupiesCapacity(leaf, now)).toBe(true)
})

test('a parked leaf requests reconcile, a due restack, or verification for an unsettled cycle', () => {
  const conflicted = finished('a', { settled: 10 })
  conflicted.state.prState = 'conflicted'
  expect(slotRequest(conflicted, now)).toBe('reconcile')
  const moved = finished('b', { settled: 10 })
  moved.restackDue = true
  expect(slotRequest(moved, now)).toBe('verification')
  // A reconcile completion or config supersession opens a new verify cycle.
  const reverify = finished('c', { settled: 10 })
  reverify.state.verify = { ...reverify.state.verify, cycleSince: 20 }
  expect(epilogueUnsettled(reverify.state)).toBe(true)
  expect(settlementDue(reverify.state)).toBe(true)
  expect(slotRequest(reverify, now)).toBe('verification')
  // Pause, resume and runner exits write no settlement: still unsettled.
  reverify.state.status = 'paused'
  expect(slotRequest(reverify, now)).toBeUndefined()
  reverify.state.status = 'running'
  expect(slotRequest(reverify, now)).toBe('verification')
  // Settlement at the new key clears it.
  reverify.state.pipelineSettled = 20
  expect(slotRequest(reverify, now)).toBeUndefined()
  expect(settlementDue(reverify.state)).toBe(false)
  // A running reconcile holds a lease: occupied, not waiting.
  const running = finished('d', { settled: 10, lease: true })
  running.state.prState = 'conflicted'
  expect(slotRequest(running, now)).toBeUndefined()
  expect(occupiesCapacity(running, now)).toBe(true)
})

test('a deferred or target-rewritten parked leaf makes no request', () => {
  const deferred = finished('a', { settled: 10 })
  deferred.state.prState = 'conflicted'
  deferred.state.compatibility = { ...deferred.state.compatibility, decisiveFacts: 1 }
  expect(slotRequest(deferred, now)).toBeUndefined()
  const rewritten = finished('b', { settled: 10 })
  rewritten.restackDue = true
  rewritten.state.targetRewrite = { type: 'target.rewritten' } as never
  expect(slotRequest(rewritten, now)).toBeUndefined()
})

test('parked leaves free capacity and reserve intake while they wait', () => {
  const conflicted = finished('wait-r', { settled: 10 })
  conflicted.state.prState = 'conflicted'
  const moved = finished('wait-v', { settled: 10 })
  moved.restackDue = true
  const builds = [
    build('running'),
    finished('parked', { settled: 10 }),
    conflicted,
    moved,
    finished('unsettled'),
  ]
  const capacity = dispatchCapacity(builds, 4, now)
  expect(capacity).toEqual({
    configured: 4,
    occupied: 2,
    effective: 4,
    borrowingNodes: [],
    waitingBuilds: [
      { slug: 'wait-r', request: 'reconcile' },
      { slug: 'wait-v', request: 'verification' },
    ],
  })
  expect(intakeCapacity(capacity)).toBe(0)
  expect(intakeCapacity(capacity, { settled: new Set(['wait-v']) })).toBe(1)
  expect(
    intakeCapacity(capacity, {
      denied: new Map([
        ['wait-r', 'normal'],
        ['other', 'normal'],
      ]),
    }),
  ).toBe(-1)
  expect(
    intakeCapacity(capacity, {
      settled: new Set(['wait-r']),
      denied: new Map([['wait-r', 'normal']]),
    }),
  ).toBe(0)
  expect(waitingExplanation(capacity, { requests: true })).toBe(
    '2 parked builds waiting for a slot ahead of normal ticket claims: wait-r (reconcile), wait-v (verification)',
  )
})

test('capacity wording joins node and parked-build waits', () => {
  expect(
    capacityExplanation({
      configured: 2,
      occupied: 2,
      effective: 2,
      borrowingNodes: [],
      waitingNodes: [{ slug: 'n', request: 'verification' }],
      waitingBuilds: [{ slug: 'p', request: 'reconcile' }],
    }),
  ).toBe(
    ' (2 configured; 1 node waiting for a slot ahead of normal ticket claims: n; 1 parked build waiting for a slot ahead of normal ticket claims: p)',
  )
})

describe('slot admission order', () => {
  function urgent<T extends CapacityBuild>(entry: T): T {
    entry.state.priority = 'urgent'
    return entry
  }
  function reverify(slug: string): CapacityBuild {
    const leaf = finished(slug, { settled: 10 })
    leaf.restackDue = true
    return leaf
  }

  test('a build reads absent priority as normal', () => {
    const leaf = build('a')
    expect(buildPriority(leaf.state)).toBe('normal')
    expect(buildPriority(urgent(leaf).state)).toBe('urgent')
  })

  test('waiting entries carry urgent priority and omit normal', () => {
    const capacity = dispatchCapacity([reverify('n'), urgent(reverify('u'))], 2, now)
    expect(capacity.waitingBuilds).toEqual([
      { slug: 'n', request: 'verification' },
      { slug: 'u', request: 'verification', priority: 'urgent' },
    ])
    expect(capacity.urgentClaims).toBeUndefined()
    expect(dispatchCapacity([], 2, now, undefined, { urgentClaims: 2 }).urgentClaims).toBe(2)
    expect(dispatchCapacity([], 2, now, undefined, { urgentClaims: 0 })).not.toHaveProperty(
      'urgentClaims',
    )
  })

  test('urgent work reserves ahead of normal parked work, never the reverse', () => {
    const capacity: DispatchCapacity = {
      configured: 2,
      occupied: 0,
      effective: 2,
      borrowingNodes: [],
      waitingNodes: [
        { slug: 'verify', request: 'verification', priority: 'urgent' },
        { slug: 'reconcile', request: 'reconcile', priority: 'urgent' },
        { slug: 'normal-node', request: 'verification' },
      ],
      waitingBuilds: [
        { slug: 'leaf', request: 'reconcile', priority: 'urgent' },
        { slug: 'n', request: 'resume' },
      ],
      urgentClaims: 1,
    }
    expect(reservedAhead(capacity, { slug: 'verify', priority: 'urgent' })).toBe(0)
    // An urgent reconcile node already occupies its slot; the rest reserve.
    expect(reservedAhead(capacity, { slug: 'n', priority: 'normal' })).toBe(3)
    // A waiter never reserves ahead of itself.
    expect(
      reservedAhead({ ...capacity, urgentClaims: 0 }, { slug: 'leaf', priority: 'normal' }),
    ).toBe(1)
  })

  test('urgent claims wait only for urgent parked work', () => {
    const capacity = dispatchCapacity(
      [build('running'), reverify('n'), urgent(reverify('u'))],
      3,
      now,
    )
    expect(intakeCapacity(capacity)).toBe(0)
    expect(intakeCapacity(capacity, {}, 'urgent')).toBe(1)
    expect(intakeCapacity(capacity, { settled: new Set(['u']) }, 'urgent')).toBe(2)
    // A denied normal leaf never lowers the urgent budget.
    expect(intakeCapacity(capacity, { denied: new Map([['x', 'normal']]) }, 'urgent')).toBe(1)
    expect(intakeCapacity(capacity, { denied: new Map([['x', 'urgent']]) }, 'urgent')).toBe(0)
    expect(intakeCapacity(capacity, { denied: new Map([['x', 'urgent']]) })).toBe(-1)
  })

  test('one free slot: urgent claims outrank normal parked work', () => {
    const capacity = dispatchCapacity([reverify('n')], 1, now, undefined, { urgentClaims: 1 })
    const admitted = (slug: string, priority: 'urgent' | 'normal') =>
      capacity.occupied + reservedAhead(capacity, { slug, priority }) < capacity.configured
    expect(admitted('n', 'normal')).toBe(false)
    expect(intakeCapacity(capacity, {}, 'urgent')).toBe(1)
  })

  test('one free slot: urgent parked work outranks normal, in either visit order', () => {
    const capacity = dispatchCapacity([reverify('a-normal'), urgent(reverify('z-urgent'))], 1, now)
    const admitted = (slug: string, priority: 'urgent' | 'normal') =>
      capacity.occupied + reservedAhead(capacity, { slug, priority }) < capacity.configured
    expect(admitted('a-normal', 'normal')).toBe(false)
    expect(admitted('z-urgent', 'urgent')).toBe(true)
  })

  test('urgent claim demand comes only from an admission scan with intake on', () => {
    const scan = { mode: 'admission' as const, urgentWaiting: 2 }
    const settings = { intake: true, paused: false }
    expect(urgentClaimDemand({ scan, settings })).toBe(2)
    expect(urgentClaimDemand({ scan, settings: { ...settings, intake: false } })).toBe(0)
    expect(urgentClaimDemand({ scan, settings: { ...settings, paused: true } })).toBe(0)
    expect(urgentClaimDemand({ scan: { ...scan, mode: 'observation' }, settings })).toBe(0)
    expect(urgentClaimDemand({ scan: { mode: 'admission' }, settings })).toBe(0)
    expect(urgentClaimDemand({ settings })).toBe(0)
  })

  describe('start request tiers', () => {
    const admitted = (capacity: DispatchCapacity, slug: string, priority: 'urgent' | 'normal') =>
      capacity.occupied + reservedAhead(capacity, { slug, priority }) < capacity.configured

    test('start demand counts pending requests by tier, nothing while paused', () => {
      const pending = {
        a: { priority: 'manual' as const },
        b: { priority: 'manual' as const },
        c: { priority: 'normal' as const },
      }
      const settings = { paused: false }
      expect(startClaimDemand({ ticketStarts: { pending }, settings })).toEqual({
        manual: 2,
        normal: 1,
      })
      expect(startClaimDemand({ ticketStarts: { pending }, settings: { paused: true } })).toEqual(
        {},
      )
      expect(
        dispatchCapacity([], 2, now, undefined, { startRequests: { manual: 1, urgent: 0 } })
          .startRequests,
      ).toEqual({ manual: 1 })
      expect(dispatchCapacity([], 2, now, undefined, { startRequests: {} })).not.toHaveProperty(
        'startRequests',
      )
    })

    for (const configured of [1, 2])
      test(`capacity ${configured}: a manual request goes ahead of urgent parked work`, () => {
        const capacity = dispatchCapacity([urgent(reverify('u'))], configured, now, undefined, {
          startRequests: { manual: 1 },
        })
        expect(reservedAhead(capacity, { slug: 'u', priority: 'urgent' })).toBe(1)
        expect(admitted(capacity, 'u', 'urgent')).toBe(configured > 1)
        expect(startCapacity(capacity, {}, 'manual')).toBe(configured)
        expect(intakeCapacity(capacity, {}, 'urgent')).toBe(configured - 2)
      })

    for (const configured of [1, 2])
      test(`capacity ${configured}: an urgent request waits for urgent parked work only`, () => {
        const behindUrgent = dispatchCapacity([urgent(reverify('u'))], configured, now, undefined, {
          startRequests: { urgent: 1 },
        })
        expect(startCapacity(behindUrgent, {}, 'urgent')).toBe(configured - 1)
        expect(admitted(behindUrgent, 'u', 'urgent')).toBe(true)
        expect(startCapacity(behindUrgent, { settled: new Set(['u']) }, 'urgent')).toBe(configured)
        const aheadOfNormal = dispatchCapacity([reverify('n')], configured, now, undefined, {
          startRequests: { urgent: 1 },
          urgentClaims: 1,
        })
        expect(startCapacity(aheadOfNormal, {}, 'urgent')).toBe(configured)
        expect(reservedAhead(aheadOfNormal, { slug: 'n', priority: 'normal' })).toBe(2)
        expect(admitted(aheadOfNormal, 'n', 'normal')).toBe(configured > 2)
        // An ordinary urgent claim waits behind the urgent request.
        expect(intakeCapacity(aheadOfNormal, {}, 'urgent')).toBe(configured - 1)
      })

    for (const configured of [1, 2])
      test(`capacity ${configured}: a normal request waits for normal parked work and urgent claims`, () => {
        const capacity = dispatchCapacity([reverify('n')], configured, now, undefined, {
          startRequests: { normal: 1 },
        })
        expect(startCapacity(capacity, {}, 'normal')).toBe(configured - 1)
        expect(admitted(capacity, 'n', 'normal')).toBe(true)
        expect(
          startCapacity({ ...capacity, urgentClaims: 1 }, { settled: new Set(['n']) }, 'normal'),
        ).toBe(configured - 1)
        // Ordinary normal claims leave the request's slot.
        expect(intakeCapacity(capacity)).toBe(configured - 2)
        expect(intakeCapacity(capacity, {}, 'urgent')).toBe(configured)
      })

    test('every tier reserves ahead of the ones below it', () => {
      const capacity = dispatchCapacity([], 3, now, undefined, {
        startRequests: { manual: 1, urgent: 1, normal: 1 },
      })
      expect(startCapacity(capacity, {}, 'manual')).toBe(3)
      expect(startCapacity(capacity, {}, 'urgent')).toBe(2)
      expect(startCapacity(capacity, {}, 'normal')).toBe(1)
      expect(intakeCapacity(capacity, {}, 'urgent')).toBe(1)
      expect(intakeCapacity(capacity)).toBe(0)
    })

    test('wording names each start tier ahead of parked work', () => {
      const capacity: DispatchCapacity = {
        configured: 1,
        occupied: 1,
        effective: 1,
        borrowingNodes: [],
        waitingBuilds: [{ slug: 'a', request: 'verification' }],
        startRequests: { manual: 1, urgent: 2, normal: 1 },
      }
      expect(waitingExplanation(capacity)).toBe(
        '1 manual start request waiting ahead of all other work; 2 urgent start requests waiting ahead of normal parked work; 1 normal start request waiting for a slot; 1 parked build waiting for a slot ahead of normal ticket claims: a',
      )
    })
  })

  test('wording names priority and urgent claims', () => {
    expect(slotWaitText('reconcile')).toBe(
      'reconcile waiting for a slot ahead of normal ticket claims',
    )
    expect(slotWaitText('reconcile', 'urgent')).toBe(
      'urgent reconcile waiting for a slot ahead of normal work',
    )
    const capacity: DispatchCapacity = {
      configured: 1,
      occupied: 1,
      effective: 1,
      borrowingNodes: [],
      waitingBuilds: [
        { slug: 'a', request: 'verification' },
        { slug: 'b', request: 'reconcile', priority: 'urgent' },
      ],
      urgentClaims: 1,
    }
    expect(waitingExplanation(capacity)).toBe(
      '2 parked builds waiting for a slot ahead of normal ticket claims: b (urgent), a; 1 urgent ticket claim waiting ahead of normal parked work',
    )
    expect(waitingExplanation(capacity, { requests: true })).toBe(
      '2 parked builds waiting for a slot ahead of normal ticket claims: b (reconcile, urgent), a (verification); 1 urgent ticket claim waiting ahead of normal parked work',
    )
    expect(waitingExplanation({ ...capacity, waitingBuilds: [], urgentClaims: 2 })).toBe(
      '2 urgent ticket claims waiting ahead of normal parked work',
    )
  })
})

const measurementRequest = {
  id: 'm1',
  node: 'node',
  candidate: 'c'.repeat(40),
  baseline: 'a'.repeat(40),
  harnessPin: 'a'.repeat(40),
  revision: 1,
}

test('a parked attempt with a pending measurement request is admitted as a re-verify', () => {
  const leaf = finished('a', { settled: 10 })
  expect(slotRequest(leaf, now)).toBeUndefined()
  leaf.state.attemptMeasurement = { request: { ...measurementRequest, seq: 11 } }
  expect(slotRequest(leaf, now)).toBe('verification')
  expect(dispatchCapacity([leaf], 2, now).waitingBuilds).toEqual([
    { slug: 'a', request: 'verification' },
  ])
  for (const status of ['paused', 'blocked'] as const) {
    leaf.state.status = status
    expect(slotRequest(leaf, now)).toBeUndefined()
  }
  leaf.state.status = 'running'
  // Sampled, the decision is the dispatcher's: no runner, no slot.
  leaf.state.attemptMeasurement.sampled = {
    request: 'm1',
    candidate: 'c'.repeat(40),
    baseline: 'a'.repeat(40),
    harnessPin: 'a'.repeat(40),
    revision: 1,
    samples: 3,
    medians: { baseline: 10, candidate: 9 },
    report: { kind: 'measurement-samples', rev: 0 },
    seq: 12,
  }
  expect(slotRequest(leaf, now)).toBeUndefined()
  delete leaf.state.attemptMeasurement.sampled
  leaf.state.attemptMeasurement.measured = { request: 'm1', seq: 12 }
  expect(slotRequest(leaf, now)).toBeUndefined()
})

test('a superseded measurement request asks for no slot; an unchanged baseline still does', () => {
  const leaf = finished('a', { settled: 10 })
  leaf.state.attemptMeasurement = {
    request: { ...measurementRequest, seq: 11 },
    observedHead: 'b'.repeat(40),
  }
  expect(slotRequest(leaf, now)).toBeUndefined()
  const superseded = dispatchCapacity([leaf], 2, now)
  expect(superseded.waitingBuilds).toBeUndefined()
  expect(superseded.occupied).toBe(0)
  leaf.state.attemptMeasurement.observedHead = measurementRequest.baseline
  expect(slotRequest(leaf, now)).toBe('verification')
  const unchanged = dispatchCapacity([leaf], 2, now)
  expect(unchanged.waitingBuilds).toEqual([{ slug: 'a', request: 'verification' }])
  expect(unchanged.occupied).toBe(0)
})

function measuringNode(slug: string): CapacityBuild {
  const node = build(slug, 'node')
  node.state.nodeOpened = { sha: 'a'.repeat(40) }
  const objective = {
    purpose: 'p',
    metric: {
      kind: 'command' as const,
      command: 'bench',
      direction: 'minimize' as const,
      samples: 3,
      harness: ['bench/**'],
    },
    target: { epsilon: { absolute: 1 } },
    budget: { maxAttempts: 3 },
    stop: { mode: 'abort' as const },
    proposer: { concurrency: 1 },
  }
  node.state.optimization = {
    accepted: {
      objective,
      revision: 1,
      harnessPin: 'a'.repeat(40),
      specRev: 0,
      acceptedAt: now.toISOString(),
    },
    openedAt: now.toISOString(),
    clock: { activeMs: 0, spans: [], open: {}, builds: {} },
    objective,
    revision: 1,
    revisedFields: [],
    rulerRevision: 1,
    attempts: { filed: 0, accepted: 0, rejected: 0, unmeasured: 0 },
    inFlight: [],
    rejections: [],
    plateau: 0,
    emptyProposals: 0,
    requests: 0,
  }
  return node
}

test('a node due its starting measurement requests verification and occupies while measuring', () => {
  const node = measuringNode('node')
  expect(slotRequest(node, now)).toBe('verification')
  expect(occupiesCapacity(node, now)).toBe(false)
  const capacity = dispatchCapacity([node, build('a')], 3, now)
  expect(capacity.waitingNodes).toEqual([{ slug: 'node', request: 'verification' }])
  expect(intakeCapacity(capacity)).toBe(1)
  node.workspace = true
  expect(slotRequest(node, now)).toBeUndefined()
  expect(occupiesCapacity(node, now)).toBe(true)
  node.workspace = false
  node.state.status = 'blocked'
  expect(slotRequest(node, now)).toBeUndefined()
  node.state.status = 'running'
  node.state.optimization!.starting = { value: 10, spread: 0.1, head: 'a'.repeat(40) }
  expect(slotRequest(node, now)).toBeUndefined()
})

describe('the optimization proposer', () => {
  /** An opened optimization node with an open request of `room`, after
   * `hours` of an attempt run on its active-hours clock. */
  function proposerNode(slug: string, room = 2, started = false, hours = 0): CapacityBuild {
    const log = new OptimizationLogBuilder(slug)
      .push({
        actor: DISPATCHER,
        type: 'build.created',
        payload: {
          repo: 'repo',
          ticket: { source: 'file', id: slug },
          baseBranch: 'main',
          kind: 'node',
        },
      })
      .accept(commandObjective(), 1)
      .push({ actor: DISPATCHER, type: 'node.opened', payload: { sha: OPTIMIZATION_SHA('a') } })
      .baseline(1, 50, 1)
    if (hours > 0)
      log.wait(hours * 60).activity([
        ['attempt-x', 1, 'started', 'run', hours * 60],
        ['attempt-x', 2, 'ended', 'run', 0],
      ])
    log.request('r1', room)
    if (started)
      log
        .push({ actor: KERNEL, type: 'propose.started', payload: { round: 1, request: 'r1' } })
        .revise({ concurrency: 1 }, 2)
    return { ...build(slug, 'node'), state: reduceBuild(log.events) }
  }
  const when = new Date('2026-11-17T01:00:00Z')

  test('an open undeposited request asks for a slot and reserves it from intake', () => {
    const node = proposerNode('opt')
    expect(slotRequest(node, when)).toBe('propose')
    const capacity = dispatchCapacity([node, build('a')], 3, when)
    expect(capacity.waitingNodes).toEqual([{ slug: 'opt', request: 'propose' }])
    expect(intakeCapacity(capacity)).toBe(1)
    expect(occupiesCapacity(node, when)).toBe(false)
  })

  test('a held, deposited or stale request asks for nothing; a running one keeps its slot', () => {
    const held = { ...proposerNode('opt'), workspace: true }
    expect(slotRequest(held, when)).toBeUndefined()
    expect(occupiesCapacity(held, when)).toBe(true)
    const deposited = proposerNode('opt')
    deposited.state.optimization!.proposal!.deposited = {
      artifact: { kind: 'attempts', rev: 0 },
      ids: ['a'],
      at: when.toISOString(),
    }
    expect(slotRequest(deposited, when)).toBeUndefined()
    expect(slotRequest(proposerNode('opt', 5), when)).toBeUndefined()
    // Idle hours never spend the budget; 24 active hours do.
    expect(slotRequest(proposerNode('opt'), new Date('2026-11-18T01:00:00Z'))).toBe('propose')
    expect(
      slotRequest(proposerNode('opt', 2, false, 24), new Date('2026-11-18T01:00:00Z')),
    ).toBeUndefined()
    // A started session was admitted and resumes after a shrink.
    expect(slotRequest(proposerNode('opt', 2, true), when)).toBe('propose')
  })

  test('a filed node holding a workspace no work owns is stranded until a runner or request holds it', () => {
    const filedNode = (extra?: (log: OptimizationLogBuilder) => void): CapacityBuild => {
      const log = new OptimizationLogBuilder('opt')
        .push({
          actor: DISPATCHER,
          type: 'build.created',
          payload: {
            repo: 'repo',
            ticket: { source: 'file', id: 'opt' },
            baseBranch: 'main',
            kind: 'node',
          },
        })
        .accept(commandObjective(), 1)
        .push({ actor: DISPATCHER, type: 'node.opened', payload: { sha: OPTIMIZATION_SHA('a') } })
        .baseline(1, 50, 1)
        .request('r1', 2)
        .deposit('r1', 1, ['a'])
        .file('r1', ['a'])
      extra?.(log)
      return { ...build('opt', 'node'), workspace: true, state: reduceBuild(log.events) }
    }
    expect(strandedNodeWorkspace(filedNode(), when)).toBe(true)
    expect(strandedNodeWorkspace({ ...filedNode(), workspace: false }, when)).toBe(false)
    // A live runner or a provisioning marker still owns it.
    const leased = filedNode()
    leased.record = { ...leased.record, lease: { holder: 'r', expiresAt: '2026-11-17T02:00:00Z' } }
    expect(strandedNodeWorkspace(leased, when)).toBe(false)
    expect(strandedNodeWorkspace({ ...filedNode(), provisioning: true }, when)).toBe(false)
    // An expired lease does not.
    const expired = filedNode()
    expired.record = {
      ...expired.record,
      lease: { holder: 'r', expiresAt: '2026-11-17T00:00:00Z' },
    }
    expect(strandedNodeWorkspace(expired, when)).toBe(true)
    // An open proposal's proposer owns it.
    expect(
      strandedNodeWorkspace(
        filedNode((log) => log.request('r2', 1)),
        when,
      ),
    ).toBe(false)
    expect(strandedNodeWorkspace({ ...proposerNode('opt'), workspace: true }, when)).toBe(false)
    // A plain node's workspace is outside this condition.
    expect(strandedNodeWorkspace({ ...build('plain', 'node'), workspace: true }, when)).toBe(false)
  })
})

test('cleanup keeps a workspace while measurement or a proposal owns it', () => {
  const node = measuringNode('node')
  node.workspace = true
  expect(strandedNodeWorkspace(node, now)).toBe(false)
  node.state.optimization!.starting = { value: 10, spread: 0.1, head: 'a'.repeat(40) }
  expect(strandedNodeWorkspace(node, now)).toBe(true)
  node.state.optimization!.proposal = {
    id: 'r1',
    head: 'a'.repeat(40),
    room: 1,
    requestedAt: now.toISOString(),
    round: 1,
  }
  expect(strandedNodeWorkspace(node, now)).toBe(false)
  delete node.state.optimization!.starting
  expect(slotRequest({ ...node, workspace: false }, now)).toBe('verification')
  node.state.currentPhase = { phase: 'propose', round: 1, seq: 1 }
  expect(slotRequest({ ...node, workspace: false }, now)).toBe('propose')
})

test('a panel node owing progress requests verification and occupies while measuring', () => {
  const node = measuringNode('node')
  const panel = {
    ...node.state.optimization!.objective,
    metric: { kind: 'panel' as const, judges: 3, rubric: 'evals/rubric.md', harness: ['evals/**'] },
  }
  node.state.optimization!.objective = panel
  node.state.optimization!.starting = { value: 0.5, spread: 0, head: 'a'.repeat(40) }
  expect(slotRequest(node, now)).toBeUndefined()
  node.state.optimization!.progressQueue = ['c'.repeat(40)]
  expect(slotRequest(node, now)).toBe('verification')
  expect(occupiesCapacity(node, now)).toBe(false)
  node.workspace = true
  expect(slotRequest(node, now)).toBeUndefined()
  expect(occupiesCapacity(node, now)).toBe(true)
  node.workspace = false
  node.state.status = 'paused'
  expect(slotRequest(node, now)).toBeUndefined()
})

test('progress and proposer share workspace ownership and admission priority', () => {
  const node = measuringNode('node')
  const optimization = node.state.optimization!
  optimization.objective.metric = {
    kind: 'panel',
    judges: 3,
    rubric: 'evals/rubric.md',
    harness: ['evals/**'],
  }
  optimization.starting = { value: 0.5, spread: 0, head: 'a'.repeat(40) }
  optimization.progressQueue = ['c'.repeat(40)]
  optimization.proposal = {
    id: 'r2',
    head: 'c'.repeat(40),
    room: 1,
    requestedAt: now.toISOString(),
    round: 2,
  }
  expect(slotRequest(node, now)).toBe('verification')
  node.workspace = true
  expect(strandedNodeWorkspace(node, now)).toBe(false)
  node.state.currentPhase = { phase: 'propose', round: 2, seq: 1 }
  expect(slotRequest({ ...node, workspace: false }, now)).toBe('propose')
  delete optimization.proposal
  delete node.state.currentPhase
  expect(strandedNodeWorkspace(node, now)).toBe(false)
  delete optimization.progressQueue
  expect(strandedNodeWorkspace(node, now)).toBe(true)
})
