import { expect, test } from 'bun:test'
import { seedTicketStates } from './ticket-states'
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
