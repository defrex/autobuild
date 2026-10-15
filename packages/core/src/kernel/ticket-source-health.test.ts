import { expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import { MemoryBuildStore } from '../store/memory'
import { checkIncremental } from './incremental-contract'
import { reduceTicketSourceHealth, ticketSourceHealthReducer } from './ticket-source-health'
import { projectRepositoryStatus, renderRepositoryStatus } from '../cli/repository-status'

test('degradation survives bounded replay across dispatcher runs and recovery clears it', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo('repo')
  const condition = {
    source: 'fake',
    cause: 'rate-limited' as const,
    operation: 'dependency-check' as const,
    message: 'quota exhausted',
    resetAt: '2026-10-14T12:00:00.000Z',
  }
  await store.appendRepo('repo', {
    actor: DISPATCHER,
    type: 'dispatcher.ticket-source-degraded',
    payload: condition,
  })
  // A newer run must not truncate the earlier onset from bounded state.
  await store.appendRepo('repo', {
    actor: DISPATCHER,
    type: 'dispatcher.tick-failed',
    payload: { run: 'new-run', error: 'failed again' },
  })
  const full = await store.getRepoEvents('repo')
  expect(reduceTicketSourceHealth(await store.getRepoStateEvents('repo'))).toEqual(condition)
  expect(projectRepositoryStatus('repo', full).ticketSourceDegradation).toEqual(condition)
  expect(renderRepositoryStatus(projectRepositoryStatus('repo', full)).join('\n')).toContain(
    condition.resetAt,
  )
  checkIncremental(ticketSourceHealthReducer, full)
  await store.appendRepo('repo', {
    actor: DISPATCHER,
    type: 'dispatcher.ticket-source-recovered',
    payload: { source: 'fake', cause: 'rate-limited', operation: 'dependency-check' },
  })
  const recovered = await store.getRepoEvents('repo')
  checkIncremental(ticketSourceHealthReducer, recovered)
  expect(reduceTicketSourceHealth(recovered)).toBeUndefined()
  expect(
    projectRepositoryStatus('repo', await store.getRepoStateEvents('repo')).ticketSourceDegradation,
  ).toBeUndefined()
})

test('dependency evidence strengthens a listing episode durably without another onset', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo('repo')
  await store.appendRepo('repo', {
    actor: DISPATCHER,
    type: 'dispatcher.ticket-source-degraded',
    payload: {
      source: 'fake',
      cause: 'rate-limited',
      operation: 'ready-scan',
      message: 'quota exhausted',
      resetAt: '2026-10-14T12:00:00.000Z',
    },
  })
  await store.appendRepo('repo', {
    actor: DISPATCHER,
    type: 'dispatcher.ticket-source-dependency-limited',
    payload: { source: 'other' },
  })
  expect(reduceTicketSourceHealth(await store.getRepoEvents('repo'))?.operation).toBe('ready-scan')
  await store.appendRepo('repo', {
    actor: DISPATCHER,
    type: 'dispatcher.ticket-source-dependency-limited',
    payload: { source: 'fake' },
  })
  const events = await store.getRepoEvents('repo')
  checkIncremental(ticketSourceHealthReducer, events)
  expect(reduceTicketSourceHealth(events)?.operation).toBe('dependency-check')
  expect(reduceTicketSourceHealth(await store.getRepoStateEvents('repo'))).toEqual(
    reduceTicketSourceHealth(events),
  )
})
