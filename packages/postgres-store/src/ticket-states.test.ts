import { expect, test } from 'bun:test'
import { readTicketStateCounts, seedTicketStates } from './ticket-states'
import type { Exec } from './retry'

function executor(run: (text: string, values: unknown[]) => Promise<Record<string, unknown>[]>) {
  return Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => run(strings.join('?'), values),
    { array: (names: string[], type: string) => ({ names, type }) },
  ) as unknown as Exec
}

test('initialized confirmation is bounded to distinct requested names with no lock or writes', async () => {
  const calls: string[] = []
  const q = executor(async (text, values) => {
    calls.push(text)
    expect(text).toContain('name = ANY(')
    expect(values).toEqual(['repo', { names: ['Ready', 'ready'], type: 'text' }])
    return [{ name: 'Ready' }, { name: 'ready' }]
  })
  await seedTicketStates(q, 'repo', [])
  expect(calls).toHaveLength(0)
  await seedTicketStates(q, 'repo', ['Ready', 'ready', 'Ready'])
  expect(calls).toHaveLength(1)
})

test('concurrent initializers recheck after the lock and insert only missing names', async () => {
  const names = new Set(['Ready'])
  let unlock!: () => void
  const held = new Promise<void>((resolve) => {
    unlock = resolve
  })
  let arrived!: () => void
  const waiting = new Promise<void>((resolve) => {
    arrived = resolve
  })
  const inserts: unknown[][] = []
  const q = executor(async (text, values) => {
    if (text.includes('pg_advisory')) {
      arrived()
      await held
      return []
    }
    if (text.includes('SELECT name')) return [...names].map((name) => ({ name }))
    inserts.push(values)
    names.add(String(values[1]))
    return []
  })
  const pending = seedTicketStates(q, 'repo', ['Ready', 'Done', 'Done'])
  await waiting
  // Another initializer commits while this one waits for the shared lock.
  names.add('Done')
  unlock()
  await pending
  expect(inserts).toEqual([])
  names.delete('Done')
  await seedTicketStates(q, 'repo', ['Ready', 'Done', 'Done'])
  expect(inserts).toEqual([['repo', 'Done']])
})

test('initialization propagates lookup, lock, recheck and insert failures', async () => {
  for (const failAt of [1, 2, 3, 4]) {
    let calls = 0
    const error = new Error(`statement ${failAt}`)
    const q = executor(async () => {
      if (++calls === failAt) throw error
      return []
    })
    await expect(seedTicketStates(q, 'repo', ['Ready'])).rejects.toBe(error)
    expect(calls).toBe(failAt)
  }
})

test('state counts read names and maintained totals only, never ticket rows', async () => {
  const calls: string[] = []
  const q = executor(async (text, values) => {
    calls.push(text)
    if (text.includes('name = ANY(')) return [{ name: 'Triage' }, { name: 'Ready' }]
    if (text.includes('FROM ab_ticket_state_counts')) {
      expect(values).toEqual(['repo', { names: ['Triage', 'icebox'], type: 'text' }])
      return [{ state: 'Triage', tickets: 4 }]
    }
    return [{ name: 'Triage' }, { name: 'Ready' }, { name: 'icebox' }]
  })
  expect(
    await readTicketStateCounts(q, 'repo', ['Triage', 'Ready'], ['triage', 'Missing', 'icebox']),
  ).toEqual([
    { name: 'Triage', tickets: 4 },
    { name: 'icebox', tickets: 0 },
  ])
  expect(calls).toHaveLength(3)
  for (const text of calls) expect(text).not.toMatch(/\bab_tickets\b/)
})
