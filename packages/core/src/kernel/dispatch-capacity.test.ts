import { expect, test } from 'bun:test'
import { reduceBuild } from './reducer'
import {
  capacityExplanation,
  dispatchCapacity,
  intakeCapacity,
  nodeCapacity,
  occupiesCapacity,
  slotRequest,
  slotWaitText,
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
