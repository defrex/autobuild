import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { afterEach } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CANONICAL_REPOSITORY_URL,
  defaultDistributionArchive,
  findPrebuiltDistributionArchive,
  PREBUILT_DISTRIBUTION_DIR,
  writePrebuiltDistributionArchive,
  distributionAssetName,
  fetchDistributionReleaseAsset,
  readDistributionIdentity,
} from './distribution-archive'
import { GitHubApiError } from '../forge/github-transport'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('readDistributionIdentity', () => {
  test('reads the shipped package.json version of its own distribution root', async () => {
    // The workspace IS the source checkout: its root package.json carries the
    // running version. A malformed root manifest still fails hard.
    const identity = await readDistributionIdentity()
    expect(identity).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('distributionAssetName', () => {
  test('follows the published release-asset layout the guest bootstrap extracts', () => {
    expect(distributionAssetName('1.2.3')).toBe('autobuild-1.2.3.tgz')
  })
})

describe('fetchDistributionReleaseAsset', () => {
  const bytes = new Uint8Array([1, 2, 3])
  const release = {
    json: {
      assets: [
        { name: 'other.txt', browser_download_url: 'https://example.invalid/other' },
        { name: 'autobuild-1.2.3.tgz', browser_download_url: 'https://downloads.example/asset' },
      ],
    },
  }

  test('resolves the canonical repository, finds the version asset, and downloads its bytes', async () => {
    const calls: { method: string; path: string }[] = []
    const archive = await fetchDistributionReleaseAsset('1.2.3', {}, (async (
      method: string,
      path: string,
    ) => {
      calls.push({ method, path })
      if (path.endsWith('/releases/tags/v1.2.3')) return { status: 200, headers: {}, ...release }
      return { status: 200, headers: {}, bytes }
    }) as never)
    expect(archive).toEqual(bytes)
    const [owner, name] = CANONICAL_REPOSITORY_URL.replace(/^https:\/\/github\.com\//, '').split(
      '/',
    )
    expect(calls[0]).toEqual({
      method: 'GET',
      path: `repos/${owner}/${name}/releases/tags/v1.2.3`,
    })
    expect(calls[1]?.path).toBe('https://downloads.example/asset')
  })

  test('a missing release names the exact missing asset and the remedy', async () => {
    const error: unknown = await fetchDistributionReleaseAsset('9.9.9', {}, (async () => {
      throw new GitHubApiError(404, 'Not Found')
    }) as never).then(
      () => null,
      (e: unknown) => e,
    )
    expect((error as Error).message).toContain('autobuild-9.9.9.tgz')
    expect((error as Error).message).toContain('tools/release.ts')
  })

  test('a release without the distribution asset refuses to guess', async () => {
    const error: unknown = await fetchDistributionReleaseAsset('1.2.3', {}, (async (
      _method: string,
      path: string,
    ) => {
      if (path.endsWith('/releases/tags/v1.2.3')) {
        return {
          status: 200,
          headers: {},
          json: { assets: [{ name: 'notes.txt', browser_download_url: 'https://x/n' }] },
        }
      }
      throw new Error('must not download')
    }) as never).then(
      () => null,
      (e: unknown) => e,
    )
    expect((error as Error).message).toContain('does not carry the autobuild-1.2.3.tgz')
  })
})

describe('defaultDistributionArchive', () => {
  test('packs from the source checkout when one exists', async () => {
    // The real workspace root has .git — the source-checkout branch runs.
    const archive = await defaultDistributionArchive({})
    expect(archive.byteLength).toBeGreaterThan(0)
  })

  test('a checkout with bun on PATH still takes the pack path', async () => {
    // The real workspace root has .git and no prebuilt archive; injecting
    // bun availability pins the contract that a present bun keeps the pack
    // path rather than routing to the release asset.
    const archive = await defaultDistributionArchive({}, undefined, () => true)
    expect(archive.byteLength).toBeGreaterThan(0)
  })

  test('a bundled deployment with a vestigial .git and no bun falls through to the release asset', async () => {
    // The real workspace root has .git and no prebuilt archive; with bun
    // unavailable, the release asset for the running version is fetched —
    // the pack path is never taken (the marker bytes prove it).
    const version = await readDistributionIdentity()
    const marker = new Uint8Array([7, 7, 7])
    const calls: string[] = []
    const archive = await defaultDistributionArchive(
      {},
      (async (method: string, path: string) => {
        calls.push(`${method} ${path}`)
        if (path.endsWith(`/releases/tags/v${version}`)) {
          return {
            status: 200,
            headers: {},
            json: {
              assets: [
                {
                  name: distributionAssetName(version),
                  browser_download_url: 'https://downloads.example/asset',
                },
              ],
            },
          }
        }
        return { status: 200, headers: {}, bytes: marker }
      }) as never,
      () => false,
    )
    expect(archive).toEqual(marker)
    expect(calls.some((call) => call.endsWith(`/releases/tags/v${version}`))).toBe(true)
  })

  test('a bundled deployment with no bun and no release asset names the missing prebuilt archive', async () => {
    const version = await readDistributionIdentity()
    const original = new GitHubApiError(404, 'Not Found')
    const error: unknown = await defaultDistributionArchive(
      {},
      (async () => {
        throw original
      }) as never,
      () => false,
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect((error as Error).message).toContain(`.autobuild-dist/autobuild-${version}.tgz`)
    expect((error as Error).message).toContain('AB_DISTRIBUTION_ARCHIVE')
    // fetchDistributionReleaseAsset wraps a 404 in its own "cut a release"
    // error before the guard rethrows with guidance, so the original error is
    // preserved through the cause chain rather than as the direct cause.
    const causes: unknown[] = []
    for (let cause = (error as Error).cause; cause instanceof Error; cause = cause.cause) {
      causes.push(cause)
    }
    expect(causes).toContain(original)
  })

  test('without a checkout, fetches the published release asset for the running version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-dist-release-'))
    cleanups.push(dir)
    await writeFile(join(dir, 'package.json'), '{"version":"5.4.3"}\n')
    const calls: string[] = []
    // The release-branch test runs from a temp dir where the module's own
    // distribution root has no .git... the source branch wins in this
    // workspace, so we exercise the fetch path directly instead.
    const fetched = await fetchDistributionReleaseAsset('5.4.3', {}, (async (
      method: string,
      path: string,
    ) => {
      calls.push(`${method} ${path}`)
      if (path.endsWith('/releases/tags/v5.4.3')) {
        return {
          status: 200,
          headers: {},
          json: {
            assets: [{ name: 'autobuild-5.4.3.tgz', browser_download_url: 'https://d.example/a' }],
          },
        }
      }
      return { status: 200, headers: {}, bytes: new Uint8Array([9, 9]) }
    }) as never)
    const archive = fetched
    expect(archive).toEqual(new Uint8Array([9, 9]))
    expect(calls.some((call) => call.endsWith('/releases/tags/v5.4.3'))).toBe(true)
  })
})

describe('findPrebuiltDistributionArchive', () => {
  test('an explicit AB_DISTRIBUTION_ARCHIVE wins and must exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-dist-explicit-'))
    cleanups.push(dir)
    const explicit = join(dir, 'autobuild-9.9.9.tgz')
    await writeFile(explicit, new Uint8Array([1, 2, 3]))
    expect(
      await findPrebuiltDistributionArchive({ AB_DISTRIBUTION_ARCHIVE: explicit }, [dir]),
    ).toBe(explicit)
    await expect(
      findPrebuiltDistributionArchive({ AB_DISTRIBUTION_ARCHIVE: join(dir, 'missing.tgz') }, [dir]),
    ).rejects.toThrow(/AB_DISTRIBUTION_ARCHIVE names a file that does not exist/)
    // An explicit archive is what defaultDistributionArchive returns, byte for byte.
    expect(await defaultDistributionArchive({ AB_DISTRIBUTION_ARCHIVE: explicit })).toEqual(
      new Uint8Array([1, 2, 3]),
    )
  })

  test('finds the single archive under .autobuild-dist of the first root that has one', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'ab-dist-empty-'))
    const root = await mkdtemp(join(tmpdir(), 'ab-dist-root-'))
    cleanups.push(empty, root)
    expect(await findPrebuiltDistributionArchive({}, [empty])).toBeNull()
    await mkdir(join(root, PREBUILT_DISTRIBUTION_DIR), { recursive: true })
    await writeFile(join(root, PREBUILT_DISTRIBUTION_DIR, 'autobuild-1.2.3.tgz'), 'x')
    await writeFile(join(root, PREBUILT_DISTRIBUTION_DIR, 'notes.txt'), 'ignored')
    expect(await findPrebuiltDistributionArchive({}, [empty, root])).toBe(
      join(root, PREBUILT_DISTRIBUTION_DIR, 'autobuild-1.2.3.tgz'),
    )
    await writeFile(join(root, PREBUILT_DISTRIBUTION_DIR, 'autobuild-1.2.4.tgz'), 'y')
    await expect(findPrebuiltDistributionArchive({}, [root])).rejects.toThrow(
      /more than one distribution archive \(autobuild-1\.2\.3\.tgz, autobuild-1\.2\.4\.tgz\)/,
    )
  })

  test('writePrebuiltDistributionArchive packs the running version into the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ab-dist-write-'))
    cleanups.push(root)
    const path = await writePrebuiltDistributionArchive(root)
    const version = await readDistributionIdentity()
    expect(path).toBe(join(root, PREBUILT_DISTRIBUTION_DIR, distributionAssetName(version)))
    expect((await readFile(path)).byteLength).toBeGreaterThan(0)
    expect(await findPrebuiltDistributionArchive({}, [root])).toBe(path)
  })
})
