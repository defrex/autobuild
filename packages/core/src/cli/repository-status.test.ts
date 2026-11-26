import { expect, test } from 'bun:test'
import { repositoryReadFactsReducer } from '../kernel/read-facts'
import { yieldedNewcomerJournal } from '../testing/dispatch-journals'
import { projectDispatcherLiveness } from '../kernel/dispatcher-liveness'
import {
  OPERATOR_PRESENCE_UNAVAILABLE,
  projectRepositoryStatus,
  renderRepositoryStatus,
  repositoryStatusFromFacts,
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

test('human repository status reports slot holders against configured capacity', () => {
  const status = projectRepositoryStatus(REPO, [])
  expect(status.capacity).toBeUndefined()
  status.capacity = {
    configured: 2,
    occupied: 2,
    effective: 2,
    borrowingNodes: [],
    waitingNodes: [{ slug: 'release-node', request: 'verification' }],
    waitingBuilds: [{ slug: 'fix', request: 'resume', priority: 'urgent' }],
    slots: {
      'release-node': { state: 'requested', request: 'verification' },
      fix: { state: 'requested', request: 'resume', priority: 'urgent' },
      b: { state: 'held' },
      a: { state: 'held' },
      parked: { state: 'none' },
    },
  }
  const lines = renderRepositoryStatus(status)
  const at = lines.findIndex((entry) => entry.startsWith('capacity:'))
  expect(lines.slice(at, at + 2)).toEqual([
    'capacity: 2/2; 1 node waiting for a slot ahead of normal ticket claims: release-node (verification); 1 parked build waiting for a slot ahead of normal ticket claims: fix (resume, urgent)',
    // Every build's slot state; occupancy counts exactly the held ones.
    'slots: held a, b; requested fix (resume, urgent), release-node (verification); none parked',
  ])
  expect(JSON.parse(JSON.stringify(status)).capacity).toEqual(status.capacity)
  status.capacity = { ...status.capacity, slots: {} }
  expect(renderRepositoryStatus(status)).toContain('slots: none')
  // An older server's projection renders its occupancy as-is, never borrowing,
  // and without slot states reports none of them: unknown is never `none`.
  status.capacity = { configured: 5, occupied: 6, effective: 6, borrowingNodes: ['website-node'] }
  const older = renderRepositoryStatus(status)
  expect(older).toContain('capacity: 6/5')
  expect(older.some((line) => line.startsWith('slots:'))).toBe(false)
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

test('the event projection and the facts projection agree on warning lines across a yielded run', () => {
  const events = yieldedNewcomerJournal()
  const now = new Date(0)
  const dispatcher = projectDispatcherLiveness(null, [], now)
  const fromEvents = projectRepositoryStatus(REPO, events, dispatcher, now)
  expect(fromEvents.warningLines).toEqual([
    'A role warning',
    expect.stringContaining('run-a cannot squash'),
  ])
  expect(
    repositoryStatusFromFacts(REPO, repositoryReadFactsReducer.reduce(events), dispatcher, now)
      .warningLines,
  ).toEqual(fromEvents.warningLines)
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
