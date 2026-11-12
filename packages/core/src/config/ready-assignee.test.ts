import { describe, expect, test } from 'bun:test'
import type { TicketSource } from '../ports/types'
import { parseConfig } from './load'
import {
  assertCreateAssigneeAccepted,
  assertCreateAssigneeSupported,
  assertReadyAssigneeAccepted,
  createAssigneeUnsupported,
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

const creating = (createAssignee?: string): TicketsConfig =>
  parseConfig(
    `[tickets]\nsource = "jira"\nreadyState = "Open"\n${
      createAssignee !== undefined ? `createAssignee = "${createAssignee}"\n` : ''
    }`,
  ).tickets

describe('createAssignee capability', () => {
  test('the unsupported message names the key, source and plugin', () => {
    expect(createAssigneeUnsupported('jira', 'acme')).toBe(
      '[tickets].createAssignee: ticket source "jira" from plugin "acme" cannot assign tickets — remove createAssignee (selected source: "jira")',
    )
  })

  test('a plugin source without the assignees declaration is refused', () => {
    expect(() => assertCreateAssigneeSupported(creating('me'), source(), 'acme')).toThrow(
      'from plugin "acme" cannot assign tickets',
    )
    expect(assertCreateAssigneeSupported(creating(), source())).toBeUndefined()
    expect(assertCreateAssigneeSupported(creating('me'), source({ assignees: true }))).toBe(
      undefined,
    )
  })

  test('assertCreateAssigneeAccepted applies the source refusal synchronously', () => {
    const refusing = source({
      assignees: true,
      createAssigneeRefusal: (value) => (value === 'me' ? 'no user behind the token' : undefined),
    })
    expect(() => assertCreateAssigneeAccepted(creating('me'), refusing)).toThrow(
      'no user behind the token',
    )
    expect(assertCreateAssigneeAccepted(creating('pat'), refusing)).toBeUndefined()
  })

  test('dispatch preparation fails with createAssignee alone and applies its refusal', async () => {
    const failing = source({
      assignees: true,
      prepareReadyAssignee: () => Promise.reject(new Error('network down')),
    })
    await expect(
      prepareReadyAssigneeForDispatch(failing, creating('me'), () => {}),
    ).rejects.toThrow('network down')
    const refusing = source({
      assignees: true,
      prepareReadyAssignee: async () => {},
      createAssigneeRefusal: () => 'refused create assignee',
    })
    await expect(
      prepareReadyAssigneeForDispatch(refusing, creating('me'), () => {}),
    ).rejects.toThrow('refused create assignee')
    await expect(
      prepareReadyAssigneeForDispatch(source(), creating('me'), () => {}),
    ).rejects.toThrow('cannot assign tickets')
  })
})
