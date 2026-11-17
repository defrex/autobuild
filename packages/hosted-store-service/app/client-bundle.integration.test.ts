import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// Client components run in the browser, where the `Bun` global does not
// exist. Core modules that touch it at import time (reducer identities hash
// with Bun.CryptoHasher) must never be reachable from a client component: one
// stray import took the whole dashboard down with "Bun is not defined".

const appDir = import.meta.dir

function clientComponents(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return clientComponents(path)
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return []
    return /^['"]use client['"]/.test(readFileSync(path, 'utf8')) ? [path] : []
  })
}

test('client components bundle for the browser without Bun runtime references', async () => {
  const entrypoints = clientComponents(appDir)
  expect(entrypoints.length).toBeGreaterThan(0)
  const result = await Bun.build({
    entrypoints,
    target: 'browser',
    external: ['react', 'react-dom', 'next', 'next/*'],
    throw: false,
  })
  expect(result.logs.filter((log) => log.level === 'error').map(String)).toEqual([])
  const offenders: string[] = []
  for (const output of result.outputs) {
    const references = new Set((await output.text()).match(/\bBun\.[A-Za-z]+/g) ?? [])
    if (references.size > 0)
      offenders.push(`${relative(appDir, output.path)}: ${[...references].join(', ')}`)
  }
  expect(offenders).toEqual([])
}, 60_000)
