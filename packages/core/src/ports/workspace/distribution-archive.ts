/**
 * The Autobuild distribution archive installed into guests.
 *
 * Two sources, one archive layout (`autobuild-<version>.tgz`, the same bytes
 * `bun pm pack` produces and the guest bootstrap extracts):
 *
 * - Source checkout: `bun pm pack` from the host tree (local-git consumers,
 *   and any dispatcher running from a checkout — byte-identical to today).
 * - Checkout-less origin mode: the dispatcher's own published release asset,
 *   fetched from GitHub by the running version, so the guest installs exactly
 *   the version the launching dispatcher reports even when no source tree
 *   exists on disk.
 *
 * The guest's installed version therefore equals the running distribution's
 * version in both modes: origin mode's release-asset tag is the running
 * version by construction, and source mode packs `distributionRoot()`, whose
 * package.json is the same file `readDistributionIdentity()` reads. The hosted
 * remote store enforces exact version lockstep — a client whose
 * `x-autobuild-version` differs from the server's is rejected (409) — so
 * guest, store, and dispatcher versions must move together through a release
 * cut (`tools/release.ts`) plus store/dispatcher upgrades; there is no code
 * path that safely mixes versions. Provisioning records the installed version
 * in the guest's `.distribution-version` marker and reinstalls the archive on
 * a later mismatch, so an upgraded dispatcher retrofits its persistent guests
 * (see `vercel-sandbox.ts`).
 */
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { distributionRoot, distributionPath } from '../../distribution'
import { parseRepoCoordinates } from '../forge/github'
import {
  createGitHubFetchTransport,
  GitHubApiError,
  githubTokenFromEnv,
  type GitHubRequest,
} from '../forge/github-transport'
import { packageAutobuildDistribution } from './vercel-sandbox'

/** The canonical repository the release assets are published to. Shared with
 * `tools/release.ts`, which uploads them. */
export const CANONICAL_REPOSITORY_URL = 'https://github.com/defrex/autobuild'

/** The running distribution's version, from the shipped package.json.
 * Deployed distributions must ship `package.json` — a deployment requirement
 * the hosted entry point owns. Absence is a hard, actionable error. */
export async function readDistributionIdentity(): Promise<string> {
  try {
    const manifest = JSON.parse(await Bun.file(distributionPath('package.json')).text()) as {
      version?: unknown
    }
    if (typeof manifest.version !== 'string' || manifest.version === '') {
      throw new Error('the distribution package.json has no usable version field')
    }
    return manifest.version
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `could not read the running Autobuild version from the distribution package.json: ${detail}; ` +
        'a deployed distribution must ship package.json — install Autobuild from its packed archive or release',
      { cause: error },
    )
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** The release asset a version's distribution ships under. */
export function distributionAssetName(version: string): string {
  return `autobuild-${version}.tgz`
}

/** Fetch the published `autobuild-<version>.tgz` release asset for the
 * running version. Uses the dispatcher's GitHub credentials when present
 * (required for a private canonical repository). */
export async function fetchDistributionReleaseAsset(
  version: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  transport: GitHubRequest = createGitHubFetchTransport({
    token: githubTokenFromEnv(env),
  }),
): Promise<Uint8Array> {
  const coordinates = parseRepoCoordinates(CANONICAL_REPOSITORY_URL)
  if (coordinates === null) {
    throw new Error(`the canonical repository URL is not parseable: ${CANONICAL_REPOSITORY_URL}`)
  }
  const repo = `repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.name)}`
  const tag = `v${version}`
  const release = await transport('GET', `${repo}/releases/tags/${tag}`).catch((error: unknown) => {
    if (error instanceof GitHubApiError && error.status === 404) {
      throw new Error(
        `Autobuild release ${tag} has no published GitHub release; origin-mode dispatch ` +
          'installs the guest distribution from the release asset autobuild-' +
          `${version}.tgz — cut a release with tools/release.ts first`,
        { cause: error },
      )
    }
    throw error
  })
  const assets = (
    release.json as { assets?: { name?: unknown; browser_download_url?: unknown }[] } | undefined
  )?.assets
  const assetName = distributionAssetName(version)
  const asset = (assets ?? []).find((candidate) => candidate.name === assetName)
  if (asset === undefined || typeof asset.browser_download_url !== 'string') {
    throw new Error(
      `Autobuild release ${tag} does not carry the ${assetName} distribution asset; ` +
        'origin-mode dispatch cannot install a guest distribution without it — ' +
        'cut a release with tools/release.ts first',
    )
  }
  const download = await transport('GET', asset.browser_download_url, {
    headers: { Accept: 'application/octet-stream' },
  })
  if (download.bytes === undefined) {
    throw new Error(`the ${assetName} release asset downloaded no bytes`)
  }
  return download.bytes
}

/** Directory, relative to a distribution root, where a deployment ships the
 * archive it packed at build time (`ab-hosted-store pack-distribution`). A
 * bundled deployment — the hosted service on Vercel — has neither `bun` nor a
 * source tree at runtime, so the archive must be produced while both exist
 * and carried into the function bundle. */
export const PREBUILT_DISTRIBUTION_DIR = '.autobuild-dist'

/** The environment variable naming an explicit archive file, for deployments
 * that place it somewhere other than `PREBUILT_DISTRIBUTION_DIR`. */
export const DISTRIBUTION_ARCHIVE_ENV = 'AB_DISTRIBUTION_ARCHIVE'

/** Pack the running distribution into `<root>/.autobuild-dist/autobuild-<version>.tgz`
 * (the same bytes `bun pm pack` produces) and return the archive path. Meant
 * for a deployment's build step, where `bun` and the source tree exist. */
export async function writePrebuiltDistributionArchive(
  root: string = distributionRoot(),
): Promise<string> {
  const version = await readDistributionIdentity()
  const archive = await packageAutobuildDistribution()
  const dir = join(root, PREBUILT_DISTRIBUTION_DIR)
  await mkdir(dir, { recursive: true })
  const path = join(dir, distributionAssetName(version))
  await writeFile(path, archive)
  return path
}

/** Locate a prebuilt archive: `AB_DISTRIBUTION_ARCHIVE` when set, else the
 * single `autobuild-*.tgz` under `.autobuild-dist/` of the distribution root
 * or the working directory (a bundled function's root). Null when none. */
export async function findPrebuiltDistributionArchive(
  env: Readonly<Record<string, string | undefined>> = process.env,
  roots: readonly string[] = [distributionRoot(), process.cwd()],
): Promise<string | null> {
  const explicit = env[DISTRIBUTION_ARCHIVE_ENV]?.trim()
  if (explicit) {
    const path = resolve(explicit)
    if (!(await fileExists(path))) {
      throw new Error(`${DISTRIBUTION_ARCHIVE_ENV} names a file that does not exist: ${path}`)
    }
    return path
  }
  for (const root of [...new Set(roots)]) {
    const dir = join(root, PREBUILT_DISTRIBUTION_DIR)
    let names: string[]
    try {
      names = (await readdir(dir)).filter(
        (name) => name.startsWith('autobuild-') && name.endsWith('.tgz'),
      )
    } catch {
      continue
    }
    if (names.length === 0) continue
    if (names.length > 1) {
      throw new Error(
        `${dir} holds more than one distribution archive (${names.sort().join(', ')}); ` +
          'a deployment ships exactly one',
      )
    }
    return join(dir, names[0]!)
  }
  return null
}

/**
 * The default guest distribution source, in precedence order: an archive
 * prebuilt for this deployment (`AB_DISTRIBUTION_ARCHIVE` or
 * `.autobuild-dist/`), then a source checkout packed from the host tree, then
 * the running version's published release asset (see module docs). The
 * prebuilt archive comes first because a bundled deployment can carry a
 * vestigial `.git` directory without a `bun` executable to pack with.
 */
export async function defaultDistributionArchive(
  env: Readonly<Record<string, string | undefined>> = process.env,
  transport?: GitHubRequest,
): Promise<Uint8Array> {
  const prebuilt = await findPrebuiltDistributionArchive(env)
  if (prebuilt !== null) return new Uint8Array(await readFile(prebuilt))
  if (await fileExists(join(distributionRoot(), '.git'))) {
    return packageAutobuildDistribution()
  }
  const version = await readDistributionIdentity()
  return fetchDistributionReleaseAsset(version, env, transport)
}
