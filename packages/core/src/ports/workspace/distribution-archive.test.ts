import { describe, expect, test } from 'bun:test'
import {
  CANONICAL_REPOSITORY_URL,
  fetchDistributionRegistryTarball,
  fetchDistributionReleaseAsset,
  type RegistryFetch,
} from './distribution-archive'
import { GitHubApiError } from '../forge/github-transport'

/** A scripted registry: version-document URL → status/body, tarball URL → bytes. */
function registryStub(
  documents: Record<string, { status: number; body?: string; bytes?: Uint8Array }>,
  calls: string[] = [],
): RegistryFetch {
  return async (url) => {
    calls.push(url)
    const reply = documents[url] ?? { status: 404, body: '"Not Found"' }
    return {
      status: reply.status,
      text: async () => reply.body ?? '',
      arrayBuffer: async () => {
        const bytes = reply.bytes ?? new Uint8Array()
        const copy = new ArrayBuffer(bytes.byteLength)
        new Uint8Array(copy).set(bytes)
        return copy
      },
    }
  }
}

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

describe('fetchDistributionRegistryTarball', () => {
  test('honors NPM_CONFIG_REGISTRY and refuses documents without a tarball', async () => {
    const calls: string[] = []
    const bytes = await fetchDistributionRegistryTarball(
      '@defrex/autobuild',
      '1.2.3',
      { NPM_CONFIG_REGISTRY: 'https://registry.example.test/' },
      registryStub(
        {
          'https://registry.example.test/@defrex%2fautobuild/1.2.3': {
            status: 200,
            body: JSON.stringify({ dist: { tarball: 'https://cdn.example.test/a.tgz' } }),
          },
          'https://cdn.example.test/a.tgz': { status: 200, bytes: new Uint8Array([1]) },
        },
        calls,
      ),
    )
    expect(bytes).toEqual(new Uint8Array([1]))
    expect(calls[0]).toBe('https://registry.example.test/@defrex%2fautobuild/1.2.3')

    const noTarball: unknown = await fetchDistributionRegistryTarball(
      'pkg',
      '1.0.0',
      {},
      registryStub({
        'https://registry.npmjs.org/pkg/1.0.0': { status: 200, body: '{"dist":{}}' },
      }),
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect((noTarball as Error).message).toContain('names no dist.tarball')

    const missing: unknown = await fetchDistributionRegistryTarball(
      'pkg',
      '9.9.9',
      {},
      registryStub({}),
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect((missing as Error).message).toContain('HTTP 404')
    expect((missing as Error).message).toContain('publish the release first')
  })
})
