import { parseRepoCoordinates } from '../forge/github'
import {
  createGitHubFetchTransport,
  GitHubApiError,
  githubTokenFromEnv,
  type GitHubRequest,
} from '../forge/github-transport'
export const CANONICAL_REPOSITORY_URL = 'https://github.com/defrex/autobuild'
export function distributionAssetName(version: string): string {
  return `autobuild-${version}.tgz`
}
/** Fetch the exact version’s published asset through the authenticated transport. */
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
  if (download.bytes === undefined || download.bytes.byteLength === 0) {
    throw new Error(`the ${assetName} release asset downloaded no bytes`)
  }
  return download.bytes
}
