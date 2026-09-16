import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EVENT_WAIT_POLL_MS as fromAdapter } from '@defrex/autobuild/store-adapter'
import { EVENT_WAIT_POLL_MS as fromStore } from './store'

describe('EVENT_WAIT_POLL_MS unification (AUT-388)', () => {
  const source = readFileSync(join(import.meta.dir, 'store.ts'), 'utf8')

  test('store.ts does not redefine the constant (AUT-388)', () => {
    expect(source).not.toMatch(/const\s+EVENT_WAIT_POLL_MS\s*=/)
  })

  test('store.ts imports the core constant via @defrex/autobuild/store-adapter', () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bEVENT_WAIT_POLL_MS\b[^}]*\}\s*from\s*'@defrex\/autobuild\/store-adapter'/s,
    )
  })

  test('the postgres-store export is the core binding, not a copy', () => {
    expect(fromStore).toBe(fromAdapter)
  })
})
