import { expect, test } from 'bun:test'
import { nodeRestackDemand, presenceRestackPath } from './node-restack-demand'
import { reduceBuild, type BuildState } from './reducer'
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

test('durable negative availability uses canonical evidence and invalidates on semantic changes', async () => {
  const { restackAvailabilityFingerprint, actionableRestackDemand } = await import(
    './node-restack-demand'
  )
  const state: BuildState & { nodeRestack: NodeRestackState } = {
    ...reduceBuild([]),
    nodeRestack: {
      items: [],
      contributionBase: 'base',
      requests: {
        waiting: {
          ...request,
          id: 'waiting',
          reason: 'presence' as const,
          dependent: { source: 'fake', id: 'D' },
          identities: ['build:missing'],
        },
      },
    },
  }
  const evidence = {
    entries: [],
    states: new Map([['node', state]]),
    aliases: new Map(),
    landings: [],
  }
  const key = () =>
    restackAvailabilityFingerprint(state, 'node', 'main', 'head', 'parent', evidence)
  const fingerprint = key()
  expect(actionableRestackDemand(state, fingerprint)).toBe(true)
  advanceNodeRestack(state.nodeRestack, [
    {
      build: 'node',
      seq: 1,
      ts: '2026-10-29T00:00:00Z',
      actor: { kind: 'kernel' },
      type: 'node.restack-availability-observed',
      payload: {
        version: 1,
        fingerprint,
        branch: 'node',
        parentBranch: 'main',
        head: 'head',
        parent: 'parent',
        base: 'base',
        available: [],
      },
    } as AbEvent,
  ])
  expect(actionableRestackDemand(structuredClone(state), key())).toBe(false)
  state.lastSeq++
  expect(key()).toBe(fingerprint)
  for (const changed of [
    { ...evidence, landings: [{ slug: 'missing', sha: 'parent' }] },
    {
      ...evidence,
      states: new Map([
        [
          'node',
          { ...state, target: { build: 'new-parent', ticket: { source: 'fake', id: 'P' } } },
        ],
      ]),
    },
  ]) {
    const next = restackAvailabilityFingerprint(state, 'node', 'main', 'head', 'parent', changed)
    expect(next).not.toBe(fingerprint)
    expect(actionableRestackDemand(state, next)).toBe(true)
  }
  expect(
    actionableRestackDemand(
      state,
      restackAvailabilityFingerprint(state, 'node', 'main', 'push', 'parent', evidence),
    ),
  ).toBe(true)
  const mixed = structuredClone(state)
  mixed.nodeRestack.requests!.operator = request
  expect(actionableRestackDemand(mixed, fingerprint)).toBe(true)
  const available = structuredClone(state)
  available.nodeRestack.availability!.available = ['waiting']
  expect(actionableRestackDemand(available, fingerprint)).toBe(true)
  for (const next of [
    { ...state, nodeRestack: { ...state.nodeRestack, contributionBase: 'new-base' } },
    {
      ...state,
      nodeRestack: {
        ...state.nodeRestack,
        requests: {
          ...state.nodeRestack.requests,
          newer: { ...request, id: 'newer' },
        },
      },
    },
  ])
    expect(
      restackAvailabilityFingerprint(next, 'node', 'main', 'head', 'parent', evidence),
    ).not.toBe(fingerprint)
  expect(
    restackAvailabilityFingerprint(state, 'node', 'main', 'head', 'changed-parent', evidence),
  ).not.toBe(fingerprint)
  expect(
    restackAvailabilityFingerprint(state, 'node', 'new-branch', 'head', 'parent', evidence),
  ).not.toBe(fingerprint)
  expect(
    actionableRestackDemand(
      {
        ...state,
        integration: {
          observation: {
            openChildren: [],
            diagnostics: [],
            contributions: ['owned'],
          },
        },
      },
      fingerprint,
    ),
  ).toBe(true)
  expect(
    actionableRestackDemand(
      {
        ...state,
        nodeRestack: {
          ...state.nodeRestack,
          active: {
            id: 'recovery',
            operation: 'restack',
            expected: 'head',
            parent: 'parent',
            oldBase: 'base',
            archive: 'archive',
            changes: [],
            upstreamBuilds: [],
            merges: [],
          },
        },
      },
      fingerprint,
    ),
  ).toBe(true)
  expect(
    actionableRestackDemand(
      {
        ...state,
        nodeRestack: {
          ...state.nodeRestack,
          parentChange: {
            id: 'accepted',
            old: { target: null, branch: 'main' },
            next: { target: null, branch: 'next' },
            revision: 'revision',
          },
        },
      },
      fingerprint,
    ),
  ).toBe(true)
  const aliases = {
    ...state,
    nodeRestack: { ...state.nodeRestack, foreignAliases: { z: 'a', y: 'b' } },
  }
  const a = { ...evidence, states: new Map([['node', aliases]]) }
  expect(restackAvailabilityFingerprint(state, 'node', 'main', 'head', 'parent', a)).not.toBe(
    fingerprint,
  )
  const b = {
    ...evidence,
    states: new Map([
      [
        'node',
        { ...aliases, nodeRestack: { ...aliases.nodeRestack, foreignAliases: { y: 'b', z: 'a' } } },
      ],
    ]),
  }
  expect(restackAvailabilityFingerprint(state, 'node', 'main', 'head', 'parent', a)).toBe(
    restackAvailabilityFingerprint(state, 'node', 'main', 'head', 'parent', b),
  )
})
