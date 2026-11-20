import { expect, test } from 'bun:test'
import { leafRestackStatus } from './status'
import { leafRestackReducer } from '../kernel/leaf-restack-state'
import { leafRestackLog, leafTransaction } from '../kernel/generators/leaf-restack-log'
import type { AbEvent } from '../events/catalog'

const append = (log: AbEvent[], type: string, payload: unknown) => [
  ...log,
  { ...log[0]!, seq: log.length + 1, type, payload } as AbEvent,
]

test('a restack replay resolved by regeneration names its commands while open and once completed', () => {
  const full = leafRestackLog()
  let log = append(
    full.slice(0, full.findIndex((e) => e.type === 'restack.prepared') + 1),
    'restack.replayed',
    { id: leafTransaction.id, conflicted: true, files: ['gen.txt'] },
  )
  expect(leafRestackStatus(leafRestackReducer.reduce(log))?.state).toBe('conflicted')
  log = append(log, 'restack.regenerated', {
    id: leafTransaction.id,
    files: ['gen.txt'],
    commands: [{ command: 'bun run gen', files: ['gen.txt'] }],
    outcome: 'resolved',
    head: 'e'.repeat(40),
  })
  expect(leafRestackStatus(leafRestackReducer.reduce(log))).toEqual({
    trigger: 'verify-entry',
    state: 'replaying',
    onto: leafTransaction.targetBase,
    regenerated: ['bun run gen'],
  })
  log = append(log, 'restack.completed', { ...leafTransaction, headSha: 'e'.repeat(40) })
  expect(leafRestackStatus(leafRestackReducer.reduce(log))).toEqual({
    trigger: 'verify-entry',
    state: 'completed',
    onto: leafTransaction.targetBase,
    regenerated: ['bun run gen'],
  })
  // A clean restack reports nothing regenerated.
  expect(leafRestackStatus(leafRestackReducer.reduce(full))).not.toHaveProperty('regenerated')
})
