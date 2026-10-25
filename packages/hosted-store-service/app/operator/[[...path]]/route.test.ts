import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

describe('operator route segment config', () => {
  test('maxDuration is a literal HTTP deployment bound', async () => {
    // Next.js rejects non-literal segment config at build time, so the route
    // spells the deployment bound out.
    const source = await Bun.file(join(import.meta.dir, 'route.ts')).text()
    const match = source.match(/^export const maxDuration = (\d+)$/m)
    expect(match).not.toBeNull()
    expect(Number(match?.[1])).toBe(300)
  })
})
