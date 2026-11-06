// Deliberately offending unit tests. tools/unit-io-guard.integration.test.ts
// runs this file under the unit IO guard and expects every test to fail.
// The name keeps it out of both suites' collection.
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Server, Socket } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'

describe('unit IO offender', () => {
  test('swallowed readFileSync', () => {
    try {
      readFileSync('package.json')
    } catch {}
    expect(true).toBe(true)
  })

  test('Bun.spawnSync', () => {
    Bun.spawnSync(['true'])
  })

  test('fetch', async () => {
    await fetch('http://127.0.0.1:9')
  })

  test('delayed setTimeout', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
  })

  test('swallowed Socket#connect', () => {
    try {
      new Socket().connect(9, '127.0.0.1')
    } catch {}
  })

  test('timers/promises setTimeout', async () => {
    await sleep(5)
  })

  test('swallowed Atomics.wait', () => {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    } catch {}
  })

  test('Server#listen', () => {
    new Server().listen(0)
  })

  test('swallowed file-backed SQLite', () => {
    try {
      new Database('.ab/unit-io-offender.sqlite').close()
    } catch {}
  })
})
