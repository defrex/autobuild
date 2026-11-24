import { describe, expect, test } from 'bun:test'
import type { TicketsConfig } from '../config/schema'
import { stateRoles } from './ticket'

describe('ticket state roles', () => {
  const tickets = (over: Partial<TicketsConfig> = {}): TicketsConfig =>
    ({ source: 'file', readyState: 'ready', labels: [], ...over }) as TicketsConfig

  test('stateRoles uses the defaults, case-insensitive matching, and fixed doing for claimed', () => {
    const names = ['triage', 'ready', 'doing', 'done', 'icebox']
    expect([...stateRoles(tickets(), names)]).toEqual([
      ['triage', ['triage', 'create', 'proposal']],
      ['ready', ['ready']],
      ['doing', ['claimed']],
      ['done', ['done']],
      ['icebox', []],
    ])
    const custom = stateRoles(
      tickets({
        readyState: 'Icebox',
        createState: 'Ready',
        triageState: 'icebox',
        proposalState: 'Triage',
      }),
      names,
    )
    expect(custom.get('icebox')).toEqual(['triage', 'ready'])
    expect(custom.get('ready')).toEqual(['create'])
    expect(custom.get('triage')).toEqual(['proposal'])
  })
})
