import { describe, expect, test } from 'bun:test'
import type { TicketSource } from '../ports/types'
import { parseConfig } from './load'
import {
  assertReadyAssigneeAccepted,
  prepareReadyAssigneeForDispatch,
  readyAssigneeUnsupported,
} from './ready-assignee'
import type { TicketsConfig } from './schema'

const tickets = (readyAssignee?: string): TicketsConfig =>
  parseConfig(
    `[tickets]\nsource = "jira"\nreadyState = "Open"\n${
      readyAssignee !== undefined ? `readyAssignee = "${readyAssignee}"\n` : ''
    }`,
  ).tickets

function source(opts: Partial<TicketSource> = {}): TicketSource {
  return { name: 'jira', ...opts } as TicketSource
}

describe('readyAssignee capability', () => {
  test('the unsupported message names the source and plugin', () => {
    expect(readyAssigneeUnsupported('jira', 'acme')).toBe(
      '[tickets].readyAssignee: ticket source "jira" from plugin "acme" cannot filter ready tickets by assignee — remove readyAssignee (selected source: "jira")',
    )
  })

  test('assertReadyAssigneeAccepted is synchronous and refuses without the declaration', () => {
    expect(() => assertReadyAssigneeAccepted(tickets('me'), source())).toThrow(
      'cannot filter ready tickets by assignee',
    )
    expect(assertReadyAssigneeAccepted(tickets(), source())).toBeUndefined()
    const refusing = source({
      readyAssignee: true,
      readyAssigneeRefusal: (value) => (value === 'me' ? 'no user behind the key' : undefined),
    })
    expect(() => assertReadyAssigneeAccepted(tickets('me'), refusing)).toThrow(
      'no user behind the key',
    )
    expect(assertReadyAssigneeAccepted(tickets('pat'), refusing)).toBeUndefined()
  })

  test('dispatch preparation warns without readyAssignee, fails with it, and applies refusals', async () => {
    const failing = source({
      readyAssignee: true,
      prepareReadyAssignee: () => Promise.reject(new Error('network down')),
    })
    const warnings: string[] = []
    await prepareReadyAssigneeForDispatch(failing, tickets(), (line) => warnings.push(line))
    expect(warnings).toEqual(['ticket source "jira" could not prepare readyAssignee: network down'])
    await expect(prepareReadyAssigneeForDispatch(failing, tickets('me'), () => {})).rejects.toThrow(
      'network down',
    )
    let prepared = 0
    const refusing = source({
      readyAssignee: true,
      prepareReadyAssignee: async () => {
        prepared += 1
      },
      readyAssigneeRefusal: () => 'refused',
    })
    await expect(
      prepareReadyAssigneeForDispatch(refusing, tickets('me'), () => {}),
    ).rejects.toThrow('refused')
    await prepareReadyAssigneeForDispatch(refusing, tickets(), () => {})
    expect(prepared).toBe(2)
    await expect(
      prepareReadyAssigneeForDispatch(source(), tickets('me'), () => {}),
    ).rejects.toThrow('cannot filter ready tickets by assignee')
  })
})
