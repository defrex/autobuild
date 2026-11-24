import { describe, expect, test } from 'bun:test'
import { ticketsSchema } from '../config/schema'
import { LinearTicketSource } from '../ports/tickets/linear'
import type { TicketSource } from '../ports/types'
import {
  assertGitHubStateLabels,
  createReadinessRedactor,
  ticketRoleReadiness,
} from './init-validation'

const linear = (states: string[]) =>
  Object.assign(Object.create(LinearTicketSource.prototype), {
    name: 'linear',
    workflowStateNames: async () => states,
  }) as TicketSource

test('redacts nested error causes without hiding non-secret configuration', () => {
  const redact = createReadinessRedactor({
    API_KEY: 'distinct-secret',
    AB_STORE: 'https://store.example',
  })
  const error = new AggregateError(
    [new Error('runtime echoed distinct-secret')],
    'provider distinct-secret failed at https://store.example',
  )
  expect(redact(error)).toContain('[REDACTED]')
  expect(redact(error)).not.toContain('distinct-secret')
  expect(redact(error)).toContain('https://store.example')
})

test('unset roles are notes, never failures, and read nothing', async () => {
  const tickets = ticketsSchema.parse({ source: 'file', readyState: 'ready' })
  let opened = false
  const result = await ticketRoleReadiness(tickets, async () => {
    opened = true
    throw new Error('no source needed')
  })
  expect(opened).toBe(false)
  expect(result.checks).toEqual([])
  expect(result.notes).toEqual([
    'Note: [tickets].backlogState is not set; the backlog role is unavailable (recommended: backlogState = "backlog")',
    'Note: [tickets].rejectedState is not set; the rejected role is unavailable (recommended: rejectedState = "rejected")',
  ])
})

test('a configured role naming no source state is a warning', async () => {
  const tickets = ticketsSchema.parse({
    source: 'linear',
    teamKey: 'ENG',
    readyState: 'Todo',
    triageState: 'Triage',
    backlogState: 'Icebox',
    rejectedState: 'canceled',
  })
  const result = await ticketRoleReadiness(tickets, async () =>
    linear(['Triage', 'Todo', 'In Progress', 'Done', 'Canceled']),
  )
  expect(result.notes).toEqual([])
  expect(result.checks).toEqual([
    {
      name: 'ticket-role-backlog',
      status: 'warning',
      detail:
        '[tickets].backlogState "Icebox" names no state in the linear source (known: Triage, Todo, In Progress, Done, Canceled)',
    },
  ])
})

describe('github ticket source init validation', () => {
  test('a configured state that cannot be an autobuild: label is refused naming the key', () => {
    const tickets = ticketsSchema.parse({ source: 'github', readyState: 'Ready Now' })
    expect(() => assertGitHubStateLabels(tickets)).toThrow(
      '[tickets].readyState "Ready Now" cannot be a GitHub state label (autobuild:<state>)',
    )
    expect(() =>
      assertGitHubStateLabels(
        ticketsSchema.parse({ source: 'github', backlogState: 'x'.repeat(41) }),
      ),
    ).toThrow('[tickets].backlogState')
  })

  test('done and rejected are closing reasons and need no label', () => {
    expect(() =>
      assertGitHubStateLabels(
        ticketsSchema.parse({
          source: 'github',
          doneState: 'Done Done',
          rejectedState: 'Won’t Do',
          backlogState: 'backlog',
        }),
      ),
    ).not.toThrow()
  })
})
