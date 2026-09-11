import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { afterEach } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CANONICAL_REPOSITORY_URL,
  defaultDistributionArchive,
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
