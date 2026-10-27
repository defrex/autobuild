import { afterEach, expect, test } from 'bun:test'
import { projectManagement } from './api'
const original = globalThis.fetch
afterEach(() => {
  globalThis.fetch = original
})
test('a fresh Projects load rediscovers unfinished deletions without component state', async () => {
  const repo = 'https://github.com/acme/project'
  const paths: string[] = []
  globalThis.fetch = (async (input: string) => {
    paths.push(input)
    if (input.endsWith('/orgs')) return Response.json({ organizations: [] })
    if (input.endsWith('/projects/deletions')) return Response.json({ projects: [repo] })
    throw new Error(`unexpected path ${input}`)
  }) as typeof fetch
  const firstTab = await projectManagement(false)
  const secondTab = await projectManagement(false)
  expect(firstTab.pendingDeletions).toEqual([repo])
  expect(secondTab).toEqual(firstTab)
  expect(secondTab.snapshots).toEqual([])
  expect(paths.filter((path) => path.endsWith('/projects/deletions'))).toHaveLength(2)
})
