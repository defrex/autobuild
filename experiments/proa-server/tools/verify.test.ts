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
