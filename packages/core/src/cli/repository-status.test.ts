import { expect, test } from 'bun:test'
import {
  OPERATOR_PRESENCE_UNAVAILABLE,
  projectRepositoryStatus,
  renderRepositoryStatus,
  type RepositoryStatus,
} from './repository-status'
const REPO = '/main/repo'

test('human output labels the repository and every dispatcher setting', () => {
  const status = projectRepositoryStatus(REPO, [])
  expect(renderRepositoryStatus(status)).toEqual([
    'operator: unavailable (presence not loaded)',
    'forge requests: unavailable',
    `repository: ${REPO}`,
    'dispatcher: absent — no dispatcher holds the repository',
    'intake: ON',
    'repository pause: OFF',
    'default auto-merge: OFF',
  ])
})

test('human repository status explains actual, configured and descendant-held capacity', () => {
  const status = projectRepositoryStatus(REPO, [])
  expect(status.capacity).toBeUndefined()
  status.capacity = { configured: 5, occupied: 6, effective: 6, borrowingNodes: ['website-node'] }
  expect(renderRepositoryStatus(status)).toContain(
    'capacity: 6/6 effective; 5 configured; 1 node using descendant-held slots: website-node',
  )
  expect(JSON.parse(JSON.stringify(status)).capacity).toEqual(status.capacity)
  status.capacity = {
    configured: 2,
    occupied: 2,
    effective: 2,
    borrowingNodes: [],
    waitingNodes: [{ slug: 'release-node', request: 'verification' }],
  }
  expect(renderRepositoryStatus(status)).toContain(
    'capacity: 2/2 effective; 2 configured; 0 nodes using descendant-held slots; 1 node waiting for a slot ahead of normal ticket claims: release-node (verification)',
  )
  expect(JSON.parse(JSON.stringify(status)).capacity).toEqual(status.capacity)
})

test('the event projection and the facts projection agree on forge rate limits', () => {
  const now = new Date('2026-11-20T12:00:00.000Z')
  const resetAt = new Date(now.getTime() + 60_000).toISOString()
  const degraded = {
    repo: REPO,
    seq: 1,
    ts: now.toISOString(),
    actor: { kind: 'kernel' as const },
    type: 'dispatcher.forge-degraded' as const,
    payload: { forge: 'github', message: 'limit', resetAt, firstFailureAt: now.toISOString() },
  }
  const fromEvents = projectRepositoryStatus(REPO, [degraded], undefined, now)
  expect(fromEvents.forgeRateLimit).toEqual({ limits: [], paused: true, pausedUntil: resetAt })
  expect(renderRepositoryStatus(fromEvents)).toContain(
    `forge landing/polling paused until ${resetAt} (rate-limit cooldown)`,
  )
})

test('human output renders one line distinguishing unavailable, absent and present', () => {
  const lines = (operator: RepositoryStatus['operator']): string[] =>
    renderRepositoryStatus({ ...projectRepositoryStatus(REPO, []), operator }).filter((line) =>
      line.startsWith('operator:'),
    )
  const row = {
    id: 'a',
    repo: REPO,
    host: 'one',
    pid: 10,
    startedAt: '2026-10-24T12:00:00.000Z',
    heartbeatAt: '2026-10-24T12:00:00.000Z',
    heartbeatAgeMs: 0,
  }
  expect(lines({ presence: 'unavailable', reason: OPERATOR_PRESENCE_UNAVAILABLE })).toEqual([
    'operator: unavailable (presence not loaded)',
  ])
  expect(lines({ presence: 'loaded', registrations: [] })).toEqual(['operator: absent'])
  expect(lines({ presence: 'loaded', registrations: [row, { ...row, id: 'b' }] })).toEqual([
    'operator: present (2 registrations)',
  ])
})
