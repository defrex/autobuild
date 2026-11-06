import { describe, expect, test } from 'bun:test'
import {
  assertArchiveMatchesDistribution,
  parseShipDeployment,
  runPackDistribution,
  runShipDeployment,
} from './bin'

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

describe('ship-deployment command', () => {
  test('parses a repeatable --plugin and defaults the root and dist directory', () => {
    expect(
      parseShipDeployment(
        ['ship-deployment', '--root', '/p', '--plugin', 'a', '--plugin', 'b', '--dist-dir', 'out'],
        '/cwd',
      ),
    ).toEqual({ root: '/p', distDir: 'out', plugins: ['a', 'b'] })
    expect(parseShipDeployment(['ship-deployment'], '/cwd')).toEqual({
      root: '/cwd',
      distDir: '.next',
      plugins: [],
    })
    expect(() => parseShipDeployment(['ship-deployment', '--root', 'a', '--root', 'b'])).toThrow(
      'only be supplied once',
    )
    expect(() => parseShipDeployment(['ship-deployment', '--plugin'])).toThrow('requires a value')
  })

  test('unknown arguments exit 2 with usage; shipping failures exit 1', async () => {
    const errors: string[] = []
    expect(
      await runShipDeployment(['ship-deployment', '--bogus'], () => {}, errors.push.bind(errors)),
    ).toBe(2)
    expect(errors[0]).toContain('unknown argument: --bogus')
    expect(errors[0]).toContain('ship-deployment [--root DIR]')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'ab-ship-deployment-'))
    try {
      errors.length = 0
      expect(
        await runShipDeployment(
          ['ship-deployment', '--root', root],
          () => {},
          errors.push.bind(errors),
        ),
      ).toBe(1)
      expect(errors[0]).toContain('pack-distribution')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('an archive of another version than the installed distribution is rejected', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'ab-ship-version-'))
    try {
      const manifest = join(root, 'package.json')
      await writeFile(manifest, '{"name":"@defrex/autobuild","version":"2.0.0"}')
      await assertArchiveMatchesDistribution(join(root, 'autobuild-2.0.0.tgz'), manifest)
      await expect(
        assertArchiveMatchesDistribution(join(root, 'autobuild-1.9.0.tgz'), manifest),
      ).rejects.toThrow(
        'distribution archive autobuild-1.9.0.tgz is version 1.9.0 but the installed @defrex/autobuild is 2.0.0 — rerun pack-distribution',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
