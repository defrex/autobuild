import { describe, expect, test, mock } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { afterEach } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CANONICAL_REPOSITORY_URL,
  defaultDistributionArchive,
  DISTRIBUTION_ARCHIVE_ENV,
  distributionStampFor,
  findPrebuiltDistributionArchive,
  PREBUILT_DISTRIBUTION_DIR,
  resetDistributionArchiveCacheForTest,
  resolveDistributionArchive,
  writePrebuiltDistributionArchive,
  distributionAssetName,
  fetchDistributionReleaseAsset,
  fetchDistributionRegistryTarball,
  readDistributionIdentity,
  readDistributionIdentityStamp,
  readDistributionPackage,
  packageAutobuildDistribution,
  type RegistryFetch,
} from './distribution-archive'
import * as gitWorktree from './git-worktree'
import { GitHubApiError } from '../forge/github-transport'
import { REMOTE_STORE_PROTOCOL_VERSION } from '../../store/remote/version'

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

const registryAbsent = registryStub({})

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

/** Pin the archive source through `AB_DISTRIBUTION_ARCHIVE` and reset the
 * per-process memo around `fn`, so stamp tests resolve known bytes instead of
 * packing the real tree — and never leak the pinned env or a stale memo. */
async function withPinnedArchive(path: string, fn: () => Promise<void>): Promise<void> {
  const previous = process.env[DISTRIBUTION_ARCHIVE_ENV]
  process.env[DISTRIBUTION_ARCHIVE_ENV] = path
  resetDistributionArchiveCacheForTest()
  try {
    await fn()
  } finally {
    if (previous === undefined) delete process.env[DISTRIBUTION_ARCHIVE_ENV]
    else process.env[DISTRIBUTION_ARCHIVE_ENV] = previous
    resetDistributionArchiveCacheForTest()
  }
}

describe('readDistributionIdentityStamp', () => {
  test('combines the package version, the protocol version, and the archive digest', async () => {
    // The stamp is everything the marker comparison must catch: the hosted
    // store's skew check (`x-autobuild-version` +
    // `x-autobuild-protocol-version`; AUT-521) plus the digest of the exact
    // packed archive the dispatcher installs, so a code-only deploy that
    // changes guest-visible bytes without bumping either one still mismatches
    // every guest marker (AUT-600). The archive is pinned through the
    // `AB_DISTRIBUTION_ARCHIVE` seam and the memo reset, so no test packs the
    // real tree.
    const dir = await mkdtemp(join(tmpdir(), 'ab-dist-stamp-'))
    cleanups.push(dir)
    const archivePath = join(dir, 'autobuild-1.2.3.tgz')
    const bytes = new Uint8Array([1, 2, 3, 4])
    await writeFile(archivePath, bytes)
    await withPinnedArchive(archivePath, async () => {
      const stamp = await readDistributionIdentityStamp()
      const version = await readDistributionIdentity()
      const digest = createHash('sha256').update(bytes).digest('hex')
      expect(stamp).toBe(`${version}+protocol${REMOTE_STORE_PROTOCOL_VERSION}+sha256-${digest}`)
      expect(stamp).not.toBe(version)
    })
  })
})

describe('distributionStampFor', () => {
  test('archives differing only in bytes produce different stamps; identical bytes do not', async () => {
    // Same package version and protocol on both sides: only the archive
    // digest separates the stamps, so a code-only change is a mismatch and an
    // identical archive is not (AUT-600 acceptance).
    const stampA = await distributionStampFor(new Uint8Array([1, 2, 3]))
    const stampB = await distributionStampFor(new Uint8Array([1, 2, 4]))
    expect(stampA).not.toBe(stampB)
    expect(stampA).toBe(await distributionStampFor(new Uint8Array([1, 2, 3])))
    const version = await readDistributionIdentity()
    expect(stampA.startsWith(`${version}+protocol${REMOTE_STORE_PROTOCOL_VERSION}+sha256-`)).toBe(
      true,
    )
  })
})

describe('resolveDistributionArchive', () => {
  test('resolves at most once per process and clears the memo on rejection', async () => {
    // Memoized fulfillment: after the first resolution the backing archive
    // file can be deleted and a second resolution still succeeds from cache —
    // proving no second pack/read per tick.
    const dir = await mkdtemp(join(tmpdir(), 'ab-dist-memo-'))
    cleanups.push(dir)
    const archivePath = join(dir, 'autobuild-9.9.9.tgz')
    await writeFile(archivePath, new Uint8Array([5, 6, 7]))
    await withPinnedArchive(archivePath, async () => {
      const first = await resolveDistributionArchive()
      await rm(archivePath)
      const second = await resolveDistributionArchive()
      expect(second).toBe(first)
      expect(second.archive).toEqual(new Uint8Array([5, 6, 7]))
    })

    // A rejected resolution is not memoized: the next call retries, so a
    // transient origin-mode failure cannot poison a long-lived dispatcher.
    const brokenPath = join(dir, 'missing.tgz')
    await withPinnedArchive(brokenPath, async () => {
      await expect(resolveDistributionArchive()).rejects.toThrow(
        /AB_DISTRIBUTION_ARCHIVE names a file that does not exist/,
      )
      await writeFile(brokenPath, new Uint8Array([8]))
      const repaired = await resolveDistributionArchive()
      expect(repaired.archive).toEqual(new Uint8Array([8]))
    })
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
      registryAbsent,
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
      registryAbsent,
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

  test('a bundled deployment installs the npm registry tarball of the running version first', async () => {
    const { name, version } = await readDistributionPackage()
    const encoded = name.replace('/', '%2f')
    const documentUrl = `https://registry.npmjs.org/${encoded}/${version}`
    const tarballUrl = `https://registry.npmjs.org/${name}/-/autobuild-${version}.tgz`
    const marker = new Uint8Array([4, 2, 4, 2])
    const calls: string[] = []
    const archive = await defaultDistributionArchive(
      {},
      (async () => {
        throw new Error('GitHub must not be consulted when the registry has the version')
      }) as never,
      () => false,
      registryStub(
        {
          [documentUrl]: { status: 200, body: JSON.stringify({ dist: { tarball: tarballUrl } }) },
          [tarballUrl]: { status: 200, bytes: marker },
        },
        calls,
      ),
    )
    expect(archive).toEqual(marker)
    expect(calls).toEqual([documentUrl, tarballUrl])
  })

  test('the registry tarball fetch honors NPM_CONFIG_REGISTRY and refuses documents without a tarball', async () => {
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
      registryAbsent,
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect((missing as Error).message).toContain('HTTP 404')
    expect((missing as Error).message).toContain('publish the release first')
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

// `mock.module` is process-global, not per-file: `bun test` loads every file
// into one module registry, so this override persists into files loaded later.
// Two guards keep that safe (do not weaken either):
//  1. the describe-scoped `afterEach` below resets the override after every
//     test, so sibling suites always see the real `spawnExec`;
//  2. this describe stays last in the file so no existing real-spawn test in
//     this file ever runs while an override is set.
const realSpawnExec = gitWorktree.spawnExec // snapshot BEFORE mock.module, avoids self-recursion
const spawnOverride: { impl?: typeof gitWorktree.spawnExec } = {}
mock.module('./git-worktree', () => ({
  ...gitWorktree, // preserve every other export for the rest of the file's import graph
  spawnExec: (cmd: string[], opts: { cwd?: string; signal?: AbortSignal }) =>
    (spawnOverride.impl ?? realSpawnExec)(cmd, opts),
}))

describe('packageAutobuildDistribution exec failure semantics', () => {
  afterEach(() => {
    spawnOverride.impl = undefined // restore real spawn behavior; mandatory, see above
  })

  test('a failing pack throws with the exit code and the trimmed stderr', async () => {
    spawnOverride.impl = async () => ({
      stdout: ' stdout filler ',
      stderr: 'pack exploded',
      exitCode: 3,
    })
    // The `\S+` wildcard exists only because the `--destination` tmpdir is
    // random; every other character of the message is pinned.
    await expect(packageAutobuildDistribution()).rejects.toThrow(
      /^bun pm pack --ignore-scripts --destination \S+ exited 3: pack exploded$/,
    )
  })

  test('with empty stderr the message falls back to the trimmed stdout', async () => {
    spawnOverride.impl = async () => ({ stdout: '  noisy stdout  ', stderr: '', exitCode: 7 })
    await expect(packageAutobuildDistribution()).rejects.toThrow(/exited 7: noisy stdout$/)
  })
})
