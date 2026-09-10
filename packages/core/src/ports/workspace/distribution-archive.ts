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
 */
import { access } from 'node:fs/promises'
import { join } from 'node:path'
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

/**
 * The default guest distribution source. A source checkout packs from the
 * host tree; a checkout-less dispatcher fetches its own published release
 * asset (see module docs).
 */
export async function defaultDistributionArchive(
  env: Readonly<Record<string, string | undefined>> = process.env,
  transport?: GitHubRequest,
): Promise<Uint8Array> {
  if (await fileExists(join(distributionRoot(), '.git'))) {
    return packageAutobuildDistribution()
  }
  const version = await readDistributionIdentity()
  return fetchDistributionReleaseAsset(version, env, transport)
}
