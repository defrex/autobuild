import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// Browser errors reach the runtime log through the layout's inline head
// script. Errors an explicit boundary catches are only logged to the console
// by React, so every boundary must report through the script's hook.

const appDir = import.meta.dir
const read = (path: string) => readFileSync(join(appDir, path), 'utf8')

function boundaries(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : boundaries(path)
    return /^(global-)?error\.(t|j)sx?$/.test(entry.name) ? [path] : []
  })
}

test('every explicit error boundary reports through the bootstrap hook', () => {
  const silent = boundaries(appDir).filter(
    (path) => !readFileSync(path, 'utf8').includes('__autobuildReportBrowserError'),
  )
  expect(silent.map((path) => relative(appDir, path))).toEqual([])
})

test('the layout renders the error reporter before any other head script', () => {
  const layout = read('layout.tsx')
  expect(layout).toContain('browserErrorBootstrap(')
  const reporter = layout.indexOf('BROWSER_ERRORS }}')
  expect(reporter).toBeGreaterThan(-1)
  expect(reporter).toBeLessThan(layout.indexOf('THEME_BOOTSTRAP }}'))
  expect(layout.indexOf('<script')).toBeLessThan(reporter)
  expect(layout.indexOf('<script', layout.indexOf('<script') + 1)).toBeGreaterThan(reporter)
})

test('the report endpoint is mounted for POST', () => {
  const route = read('client-errors/route.ts')
  expect(route).toContain("from '../machine'")
  expect(route).toContain('export { POST }')
})

test('production browser source maps are published so logged stacks resolve', () => {
  expect(read('../next.config.ts')).toContain('productionBrowserSourceMaps: true')
})
