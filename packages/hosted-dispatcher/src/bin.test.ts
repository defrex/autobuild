import { describe, expect, test } from 'bun:test'
import { runPackDistribution } from './bin'

describe('pack-distribution command', () => {
  test('writes the running distribution archive under the given root and prints its path', async () => {
    const { mkdtemp, rm, stat } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'ab-pack-'))
    try {
      const output: string[] = []
      expect(
        await runPackDistribution(['pack-distribution', '--root', root], output.push.bind(output)),
      ).toBe(0)
      expect(output).toHaveLength(1)
      expect(output[0]).toBe(
        join(
          root,
          '.autobuild-dist',
          `autobuild-${(await import('../../../package.json')).version}.tgz`,
        ),
      )
      expect((await stat(output[0]!)).size).toBeGreaterThan(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  test('rejects unknown arguments with usage', async () => {
    const errors: string[] = []
    expect(
      await runPackDistribution(
        ['pack-distribution', '--bogus'],
        () => {},
        errors.push.bind(errors),
      ),
    ).toBe(2)
    expect(errors[0]).toContain('unknown argument: --bogus')
    expect(errors[0]).toContain('Usage:')
  })
})
