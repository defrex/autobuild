import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

// Next only forwards a path to the hosted service when a route file claims
// it; anything unclaimed answers Next's HTML 404 before authentication.
const STORE_ROOTS = ['builds', 'credentials', 'repos', 'sessions', 'streams']

describe('machine route mounts', () => {
  test('the store server names exactly the roots mounted here', async () => {
    const source = await Bun.file(join(import.meta.dir, '../src/remote-store-server.ts')).text()
    const match = source.match(/if \(\[([^\]]+)\]\.includes\(segments\[0\]/)
    expect(match).not.toBeNull()
    const roots = [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
    expect(roots).toEqual(STORE_ROOTS)
  })

  for (const root of STORE_ROOTS) {
    test(`/${root} forwards every method to the hosted service`, async () => {
      const source = await Bun.file(join(import.meta.dir, root, '[[...path]]', 'route.ts')).text()
      expect(source).toContain("from '../../machine'")
      expect(source).toContain('export { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT }')
    })
  }
})
