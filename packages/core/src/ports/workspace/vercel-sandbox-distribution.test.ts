import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { distributionRoot } from '../../distribution'
import { packageAutobuildDistribution } from './distribution-archive'
import { spawnExec } from './git-worktree'
import { installPackedDistribution } from '../../testing/packed-install'

// The packed-distribution install/refresh cases exercise core's
// distribution-packaging testkit (`installPackedDistribution` — unpublished,
// excluded from `files`, on no public subpath — plus `packageAutobuildDistribution`
// and `distributionRoot`), so they stay in core while the provider itself moved
// to `@defrex/autobuild-vercel-sandbox` (AUT-505). The provider is imported
// nowhere here: these cases pin the packaging surface only.

describe('VercelSandboxProvider distribution packaging', () => {
  test('packs, extracts, and production-installs the real distribution without lifecycle scripts', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ab-vercel-package-'))
    const archivePath = join(tmp, 'autobuild.tgz')
    const extracted = join(tmp, 'autobuild')
    try {
      await writeFile(archivePath, await packageAutobuildDistribution())
      // The root `files` array excludes test files with a negated glob; the
      // packer stages the positive entries and `bun pm pack` applies the
      // negation from the staged manifest, so the packed distribution must not
      // carry test files.
      const listing = await spawnExec(['tar', '-tzf', archivePath], { cwd: tmp })
      expect(listing).toMatchObject({ exitCode: 0, stderr: '' })
      expect(listing.stdout.split('\n').some((entry) => entry.endsWith('.test.ts'))).toBe(false)
      await mkdir(extracted)
      const unpacked = await spawnExec(
        ['tar', '-xzf', archivePath, '--strip-components=1', '-C', extracted],
        { cwd: tmp },
      )
      expect(unpacked).toMatchObject({ exitCode: 0, stderr: '' })
      const installed = await installPackedDistribution(
        ['--production', '--ignore-scripts'],
        extracted,
      )
      expect(installed.exitCode).toBe(0)
      expect(installed.stderr).not.toContain('husky')
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }, 600_000)

  test('the packed distribution carries only the files set and never the web app', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ab-vercel-package-members-'))
    const archivePath = join(tmp, 'autobuild.tgz')
    try {
      await writeFile(archivePath, await packageAutobuildDistribution())
      const listing = await spawnExec(['tar', '-tzf', archivePath], { cwd: tmp })
      expect(listing).toMatchObject({ exitCode: 0, stderr: '' })
      const members = listing.stdout.split('\n').filter((entry) => entry.length > 0)

      // The operator web app lives in the hosted store service package
      // (AUT-409). The root `files` list has never carried it; pin the
      // absence so a future files edit cannot silently ship the web app in
      // the CLI tarball.
      const forbidden = [
        /^package\/app\//,
        /^package\/server\.ts$/,
        /^package\/next\.config/,
        /^package\/next-env\.d\.ts$/,
        /^package\/vercel\.json$/,
      ]
      for (const pattern of forbidden) {
        expect(members.filter((member) => pattern.test(member))).toEqual([])
      }

      // Every member stays inside the root manifest's positive `files` set
      // (directories contribute their whole subtree) plus the manifest itself.
      const manifest = JSON.parse(
        await readFile(join(distributionRoot(), 'package.json'), 'utf8'),
      ) as { files: string[] }
      const positive = manifest.files.filter((entry) => !entry.startsWith('!'))
      const covered = (member: string) =>
        member === 'package/package.json' ||
        positive.some(
          (entry) => member === `package/${entry}` || member.startsWith(`package/${entry}/`),
        )
      expect(members.filter((member) => !covered(member))).toEqual([])
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
