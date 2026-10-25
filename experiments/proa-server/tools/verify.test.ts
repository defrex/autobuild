import { expect, test } from 'bun:test'
import { cachePath, run } from './verify'

test('failed subprocess rejects rather than proceeding', async () => {
  await expect(run(['bun', '-e', 'process.exit(23)'])).rejects.toThrow('exited 23')
})
test('cache identity separates repositories but not worktree locations', () => {
  expect(cachePath('/repo/.git', '/cache')).toBe(cachePath('/repo/.git', '/cache'))
  expect(cachePath('/other/.git', '/cache')).not.toBe(cachePath('/repo/.git', '/cache'))
  expect(cachePath('/repo/.git', '/cache')).toStartWith('/cache/')
})

test('operator checkpoint gates keep oracle drift and native write evidence mandatory', async () => {
  const source = await Bun.file(new URL('./verify.ts', import.meta.url)).text()
  for (const stage of [
    'tools/operator-fixtures.ts',
    'tools/writer-fixtures.ts',
    'tools/request-fixtures.ts',
    'tools/config-fixtures.ts',
    'tools/api-read-fixtures.ts',
    'tools/advanced-control-fixtures.ts',
    'tools/registry-fixtures.ts',
    'tools/dispatcher-integration.ts',
    'tools/control-fixtures.ts',
    'tools/query-fixtures.ts',
    'tools/delegation-fixtures.ts',
    'tools/operator-integration.ts',
  ])
    expect(source).toContain(`['bun', '${stage}']`)
})

test('operator replay requires runtime coverage and direct ticket proof before reporting parity', async () => {
  const gate = await Bun.file(new URL('./verify.ts', import.meta.url)).text()
  const replay = await Bun.file(new URL('./operator-integration.ts', import.meta.url)).text()
  expect(gate).toContain("'tools/operator-coverage.ts'")
  expect(gate).toContain("'--evidence'")
  expect(replay).toContain('await ticketIntegration(adminUrl, environment)')
  expect(replay).toContain('await checkOperatorCoverage(coverage)')
})
