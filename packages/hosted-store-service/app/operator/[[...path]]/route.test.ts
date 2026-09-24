import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { ORCHESTRATOR_ROUTE_LIMIT_SECONDS } from '@defrex/autobuild/operator'

describe('operator route segment config', () => {
  test('maxDuration is a literal equal to the orchestrator route limit', async () => {
    // Next.js rejects non-literal segment config at build time, so the route
    // spells the number out; this keeps it in step with the shared constant.
    const source = await Bun.file(join(import.meta.dir, 'route.ts')).text()
    const match = source.match(/^export const maxDuration = (\d+)$/m)
    expect(match).not.toBeNull()
    expect(Number(match?.[1])).toBe(ORCHESTRATOR_ROUTE_LIMIT_SECONDS)
  })
})
