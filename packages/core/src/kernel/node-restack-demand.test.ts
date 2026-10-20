import { expect, test } from 'bun:test'
import { nodeRestackDemand, presenceRestackPath } from './node-restack-demand'
import { reduceBuild } from './reducer'
import { advanceNodeRestack, type NodeRestackState } from './node-restack-state'
import type { AbEvent } from '../events/catalog'

const request = { id: 'request', reason: 'operator' as const, branch: 'main', parent: 'parent' }
test('movement alone is not demand; explicit requests and legacy reservations are', () => {
  const state = reduceBuild([])
  expect(nodeRestackDemand(state)).toBe(false)
  expect(
    nodeRestackDemand({
      ...state,
      nodeRestack: { items: [], observedParent: { sha: 'parent', branch: 'main' } },
    }),
  ).toBe(false)
  expect(nodeRestackDemand({ ...state, nodeRestack: { items: [], requests: { request } } })).toBe(
    true,
  )
})
test('presence paths stop at the nearest proof and exclude unknown identities', () => {
  const path = [
    { slug: 'target', identities: [] },
    { slug: 'parent', identities: ['build:near'] },
    { slug: 'ancestor', identities: [] },
    { identities: ['build:far'] },
  ]
  expect(presenceRestackPath(path, ['build:near'])).toEqual(['target'])
  expect(presenceRestackPath(path, ['build:near', 'build:far'])).toEqual([
    'ancestor',
    'parent',
    'target',
  ])
  expect(presenceRestackPath(path, ['build:absent'])).toEqual([])
})
test('acknowledging one request preserves newer requests and old logs need no migration', () => {
  const state: NodeRestackState = { items: [] }
  const event = (type: string, payload: unknown) => ({ type, payload }) as AbEvent
  advanceNodeRestack(state, [
    event('node.restack-requested', request),
    event('node.restack-requested', { ...request, id: 'newer', parent: 'new-parent' }),
  ])
  advanceNodeRestack(state, [
    event('node.restack-satisfied', { id: 'request', parent: 'parent', outcome: 'covered' }),
  ])
  expect(Object.keys(state.requests!)).toEqual(['newer'])
  advanceNodeRestack(state, [
    event('node.parent-distance', { base: 'base', parent: 'parent', branch: 'main', count: 3 }),
    event('node.parent-accepted', { id: 'move', target: null }),
  ])
  expect(state.distance).toBeUndefined()
})

test('completed legacy and demand reservations clear only their frozen request coverage', () => {
  const state: NodeRestackState = {
    items: [],
    contributionBase: 'old',
    requests: {
      first: { ...request, id: 'first' },
      newer: { ...request, id: 'newer', parent: 'new' },
    },
    active: {
      id: 'tx',
      operation: 'restack',
      expected: 'old',
      oldBase: 'old',
      parent: 'parent',
      archive: 'archive',
      changes: [],
      upstreamBuilds: [],
      merges: [],
      requests: ['first'],
    },
    rewritten: { id: 'tx', previous: 'old', head: 'parent' },
  }
  advanceNodeRestack(state, [
    { type: 'node.writer-settled', payload: { id: 'tx', outcome: 'completed' } } as AbEvent,
  ])
  expect(state.contributionBase).toBe('parent')
  expect(state.requests).toEqual({ newer: { ...request, id: 'newer', parent: 'new' } })
  expect(state.active).toBeUndefined()
})

test('inventory preserves the sampled source boundary while a node intentionally trails', () => {
  const state: NodeRestackState = { items: [], contributionBase: 'confirmed-parent' }
  advanceNodeRestack(state, [
    {
      build: 'node',
      seq: 1,
      ts: '2026-10-20T00:00:00Z',
      actor: { kind: 'dispatcher' },
      type: 'node.inventory',
      payload: {
        head: 'revived-tip',
        base: 'recorded-source-base',
        builds: [],
        foreign: ['revived-tip'],
      },
    } as AbEvent,
  ])
  expect(state.contributionBase).toBe('confirmed-parent')
  expect(state.contributionBoundaries?.['revived-tip']).toBe('recorded-source-base')
})
