import { expect, test } from 'bun:test'
import { reduceBuild } from './reducer'
import {
  capacityExplanation,
  dispatchCapacity,
  epilogueLeaf,
  epilogueUnsettled,
  intakeCapacity,
  nodeCapacity,
  occupiesCapacity,
  settlementDue,
  settlementKey,
  slotRequest,
  slotWaitText,
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

test('paused, blocked, escalated, deferred and verified nodes do not wait', () => {
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
  ).toBe(' (2 configured; 1 node waiting for a slot ahead of new ticket claims: n)')
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
    ' (2 configured; 1 node using descendant-held slots: b; 2 nodes waiting for a slot ahead of new ticket claims: m, n)',
  )
  expect(slotWaitText('verification')).toBe(
    'verification waiting for a slot ahead of new ticket claims',
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
  expect(intakeCapacity(capacity, { denied: new Set(['wait-r', 'other']) })).toBe(-1)
  expect(
    intakeCapacity(capacity, { settled: new Set(['wait-r']), denied: new Set(['wait-r']) }),
  ).toBe(0)
  expect(waitingExplanation(capacity, { requests: true })).toBe(
    '2 parked builds waiting for a slot ahead of new ticket claims: wait-r (reconcile), wait-v (verification)',
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
    ' (2 configured; 1 node waiting for a slot ahead of new ticket claims: n; 1 parked build waiting for a slot ahead of new ticket claims: p)',
  )
})
