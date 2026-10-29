import semver from 'semver'
import publications from './released-clients.json'

export interface ReleasedClient {
  version: string
  publishedAt: string
  protocol?: string
  contract?: string
  /** Header sent by the published client; absent for pre-header releases. */
  catalogIdentity?: string
  projects?: boolean
  provenance: {
    registry?: string
    tarball?: string
    integrity?: string
    commit?: string
    tag?: string
  }
}
export const RELEASED_CLIENTS: readonly ReleasedClient[] = publications
export const CLIENT_POLICY_FLOOR = '1.2.0'
export const CLIENT_SUPPORT_DAYS = 90
export const CLIENT_SUPPORT_POLICY =
  'policy floor 1.2; support ends only after two newer minor lines and 90 days since the successor line was first published (across majors; service first)'
export const releaseLine = (version: string) => {
  const parsed = semver.parse(version)
  if (!parsed) throw new Error(`invalid release identity: ${version}`)
  return `${parsed.major}.${parsed.minor}.0`
}

/** Publication facts survive retirement of identities, catalogs and handlers.
 * Stable patch publications never reset the first publication of their line. */
export function publishedLines(serviceVersion: string, releases = RELEASED_CLIENTS) {
  const service = releaseLine(serviceVersion)
  const lines = new Map<string, number>()
  for (const release of releases) {
    const parsed = semver.parse(release.version)
    if (!parsed || parsed.prerelease.length) continue
    const line = releaseLine(release.version)
    if (semver.lt(line, CLIENT_POLICY_FLOOR) || semver.gt(line, service)) continue
    const time = Date.parse(release.publishedAt)
    if (!Number.isFinite(time)) throw new Error(`invalid publication timestamp: ${release.version}`)
    lines.set(line, Math.min(lines.get(line) ?? Infinity, time))
  }
  return [...lines].sort(([a], [b]) => semver.compare(a, b))
}

/** Pure, local policy computation; no store access and no process-lifetime cache. */
export function supportedPublishedLines(
  serviceVersion: string,
  now: number,
  releases = RELEASED_CLIENTS,
) {
  const lines = publishedLines(serviceVersion, releases)
  return lines
    .filter((_, index) => {
      const successor = lines[index + 1]
      return (
        lines.length - index - 1 < 2 ||
        !successor ||
        now < successor[1] + CLIENT_SUPPORT_DAYS * 86400000
      )
    })
    .map(([line]) => line)
}

export function validatePublications(releases: readonly ReleasedClient[]): void {
  let previous: string | undefined
  for (const release of releases) {
    const parsed = semver.parse(release.version)
    if (!parsed || parsed.version !== release.version || parsed.build.length)
      throw new Error(`invalid published version: ${release.version}`)
    if (previous && semver.gte(previous, release.version))
      throw new Error('publications must be unique and ordered')
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(release.publishedAt) ||
      !Number.isFinite(Date.parse(release.publishedAt))
    )
      throw new Error(`invalid publication timestamp: ${release.version}`)
    const normalized = release.publishedAt.includes('.')
      ? release.publishedAt
      : release.publishedAt.replace('Z', '.000Z')
    if (new Date(release.publishedAt).toISOString() !== normalized)
      throw new Error(`invalid publication timestamp: ${release.version}`)
    previous = release.version
  }
}
validatePublications(RELEASED_CLIENTS)
