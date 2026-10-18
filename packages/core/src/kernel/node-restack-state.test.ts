import { expect, test } from 'bun:test'
import type { EventPayload, EventType } from '../events/payloads'
import type { AbEvent } from '../events/catalog'
import { KERNEL } from '../events/envelope'
import { nodeRestackReducer } from './node-restack-state'

function event<T extends EventType>(type: T, payload: EventPayload<T>, seq = 1): AbEvent {
  return { build: 'node', seq, ts: '2026-10-17T00:00:00Z', actor: KERNEL, type, payload } as AbEvent
}
const reservation = event(
  'node.writer-reserved',
  {
    id: 'tx',
    operation: 'restack',
    expected: 'old-head',
    parent: 'new-parent',
    oldBase: 'old-parent',
    archive: 'archive',
    changes: [{ sha: 'first', build: 'one' }, { sha: 'foreign' }],
    upstreamBuilds: [],
    merges: [],
  },
  2,
)
const prepared = (index: number, base: string) =>
  event('node.item-prepared', { id: 'tx', index, base })
const receipt = (index: number, base: string, head: string, dropped = false) =>
  event('node.item-replayed', { id: 'tx', index, base, head, dropped })

test('old node logs have a boundary but no invented transaction or inventory', () => {
  const state = nodeRestackReducer.advance(nodeRestackReducer.initial(), [
    event('node.opened', { sha: 'initial' }),
  ])
  expect(state.contributionBase).toBe('initial')
  expect(state.active).toBeUndefined()
  expect(state.inventory).toBeUndefined()
})

test('arbitrary replay prefixes survive serialization and completion alone promotes the base', () => {
  let state = nodeRestackReducer.advance(nodeRestackReducer.initial(), [
    event('node.opened', { sha: 'initial' }),
    reservation,
    prepared(0, 'new-parent'),
    receipt(0, 'new-parent', 'prefix'),
  ])
  state = JSON.parse(JSON.stringify(state))
  state = nodeRestackReducer.advance(state, [
    prepared(1, 'prefix'),
    event('node.item-conflicted', { id: 'tx', index: 1, base: 'prefix' }),
  ])
  expect(state.conflict?.index).toBe(1)
  expect(state.contributionBase).toBe('initial')
  state = nodeRestackReducer.advance(state, [
    receipt(1, 'prefix', 'resolved'),
    event('node.publish-intended', { id: 'tx', head: 'resolved' }),
    event('node.rewritten', { id: 'tx', previous: 'old-head', head: 'resolved' }),
  ])
  expect(state.contributionBase).toBe('initial')
  expect(state.foreignAliases).toBeUndefined()
  state = nodeRestackReducer.advance(state, [
    event('node.writer-settled', { id: 'tx', outcome: 'completed' }),
  ])
  expect(state.contributionBase).toBe('new-parent')
  expect(state.foreignAliases).toEqual({ resolved: 'foreign' })
  expect(state.contributionBoundaries?.resolved).toBe('new-parent')
  expect(state.active).toBeUndefined()
})

test('reservations reject competing operations, incorrect items and premature publication', () => {
  const initial = () => nodeRestackReducer.advance(nodeRestackReducer.initial(), [reservation])
  expect(() => nodeRestackReducer.advance(initial(), [reservation])).toThrow('already reserved')
  expect(() => nodeRestackReducer.advance(initial(), [prepared(1, 'new-parent')])).toThrow(
    'next reserved',
  )
  expect(() => nodeRestackReducer.advance(initial(), [prepared(0, 'wrong-prefix')])).toThrow(
    'invalid replay prefix',
  )
  expect(() =>
    nodeRestackReducer.advance(initial(), [
      event('node.publish-intended', { id: 'tx', head: 'old-head' }),
    ]),
  ).toThrow('complete replay')
  expect(() =>
    nodeRestackReducer.advance(initial(), [
      event('node.writer-settled', { id: 'tx', outcome: 'completed' }),
    ]),
  ).toThrow('confirmed rewrite')
})

test('contention does not promote the contribution base or fabricate inventory', () => {
  let state = nodeRestackReducer.advance(nodeRestackReducer.initial(), [
    event('node.opened', { sha: 'initial' }),
    reservation,
  ])
  state = nodeRestackReducer.advance(state, [
    event('node.writer-settled', { id: 'tx', outcome: 'contended', actual: 'hand-push' }),
  ])
  expect(state.contributionBase).toBe('initial')
  expect(state.active).toBeUndefined()
  expect(state.inventory).toBeUndefined()
})

test('late resolver receipts cannot revive settled or superseded reservations', () => {
  let state = nodeRestackReducer.advance(nodeRestackReducer.initial(), [
    event('node.opened', { sha: 'initial' }),
    reservation,
    prepared(0, 'new-parent'),
    event('node.writer-settled', { id: 'tx', outcome: 'abandoned' }),
  ])
  const settled = structuredClone(state)
  state = nodeRestackReducer.advance(state, [receipt(0, 'new-parent', 'late')])
  expect(state).toEqual(settled)
  const replacement = event('node.writer-reserved', {
    ...(reservation.payload as EventPayload<'node.writer-reserved'>),
    id: 'replacement',
  })
  state = nodeRestackReducer.advance(state, [replacement])
  const next = structuredClone(state)
  state = nodeRestackReducer.advance(state, [receipt(0, 'new-parent', 'late')])
  expect(state).toEqual(next)
})

test('duplicate receipts do not corrupt a later prepared item', () => {
  let state = nodeRestackReducer.advance(nodeRestackReducer.initial(), [
    reservation,
    prepared(0, 'new-parent'),
    receipt(0, 'new-parent', 'prefix'),
    prepared(1, 'prefix'),
  ])
  const before = structuredClone(state)
  state = nodeRestackReducer.advance(state, [receipt(0, 'new-parent', 'prefix')])
  expect(state).toEqual(before)
})

test('completed restacks retain dropped owned identities rather than treating them as inherited history', () => {
  const state = nodeRestackReducer.advance(nodeRestackReducer.initial(), [
    event('node.opened', { sha: 'old-parent' }),
    reservation,
    prepared(0, 'new-parent'),
    receipt(0, 'new-parent', 'new-parent', true),
    prepared(1, 'new-parent'),
    receipt(1, 'new-parent', 'new-parent', true),
    event('node.publish-intended', { id: 'tx', head: 'new-parent' }),
    event('node.rewritten', { id: 'tx', previous: 'old-head', head: 'new-parent' }),
    event('node.writer-settled', { id: 'tx', outcome: 'completed' }),
  ])
  expect(state.droppedIdentities).toEqual(['build:one', 'foreign:foreign'])
  expect(state.contributionBase).toBe('new-parent')
  expect(state.foreignAliases).toEqual({})
})
