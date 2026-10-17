import semver from 'semver'
import { z } from 'zod'
import { AUTOBUILD_VERSION, REMOTE_STORE_PROTOCOL_VERSION } from './version'

/** Stable releases only: prefixes, whitespace, prereleases and build suffixes are not identities. */
export function stableVersion(value: unknown): semver.SemVer | undefined {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) return undefined
  const parsed = semver.parse(value)
  return parsed && parsed.version === value ? parsed : undefined
}

const stableVersionSchema = z.string().refine((value) => stableVersion(value) !== undefined)
export const supportedClientRangeSchema = z
  .strictObject({
    minVersion: stableVersionSchema,
    maxVersionExclusive: stableVersionSchema,
  })
  .refine((range) => semver.lt(range.minVersion, range.maxVersionExclusive))
export type SupportedClientRange = z.infer<typeof supportedClientRangeSchema>

/** A major starts a new family: X.0 has one line, X.1 two, X.2+ three. */
export function supportedClientRange(serviceVersion = AUTOBUILD_VERSION): SupportedClientRange {
  const version = stableVersion(serviceVersion)
  if (!version) throw new Error('service must have a stable release version')
  return {
    minVersion: `${version.major}.${Math.max(0, version.minor - 2)}.0`,
    maxVersionExclusive: `${version.major}.${version.minor + 1}.0`,
  }
}

export function classifyClient(
  version: unknown,
  range: SupportedClientRange,
): 'supported' | 'older' | 'newer' | 'invalid' {
  const parsed = stableVersion(version)
  if (!parsed) return 'invalid'
  if (semver.lt(parsed, range.minVersion)) return 'older'
  if (semver.gte(parsed, range.maxVersionExclusive)) return 'newer'
  return 'supported'
}

export function formatClientRange(range: SupportedClientRange): string {
  return `>=${range.minVersion} <${range.maxVersionExclusive}`
}

export function compatibilityAdvice(
  client: unknown,
  serviceVersion: string,
  range: SupportedClientRange,
): string | undefined {
  const classification = classifyClient(client, range)
  const description = `service Autobuild ${serviceVersion} supports clients ${formatClientRange(range)}`
  if (classification === 'supported') return undefined
  if (classification === 'newer') {
    const version = stableVersion(client)!
    return `${description}; upgrade the service to at least ${version.major}.${version.minor}.0 before upgrading projects (service first)`
  }
  if (classification === 'older')
    return `${description}; upgrade the project's Autobuild into ${formatClientRange(range)}`
  return `${description}; supply a stable Autobuild client version`
}

/** Retain these wire identities and handlers until their lines leave the window.
 * Historical lines require explicit entries; the service's own line uses its
 * current protocol identity. Unknown historical protocols fail closed. */
export const RELEASE_LINE_PROTOCOLS: Readonly<Record<string, string>> = {
  '0.9': '3',
  '0.10': '3',
  '0.11': '3',
  '0.12': '3',
  // v0.13.0 shipped protocol 3. Protocol 4 requires the next minor line.
  '0.13': '3',
}

export function clientIdentityError(
  client: string | null,
  protocol: string | null,
  serviceVersion = AUTOBUILD_VERSION,
  serviceProtocol = REMOTE_STORE_PROTOCOL_VERSION,
): string | undefined {
  const range = supportedClientRange(serviceVersion)
  const service = stableVersion(serviceVersion)!
  const advice = compatibilityAdvice(client, serviceVersion, range)
  const parsed = stableVersion(client)
  const expected =
    parsed &&
    (parsed.major === service.major && parsed.minor === service.minor
      ? serviceProtocol
      : RELEASE_LINE_PROTOCOLS[`${parsed.major}.${parsed.minor}`])
  if (!advice && expected !== undefined && protocol === expected) return undefined
  return `remote store version mismatch: client Autobuild ${client ?? '(missing)'} protocol ${protocol ?? '(missing)'}; server Autobuild ${serviceVersion} protocol ${serviceProtocol}; ${advice ?? `supported clients ${formatClientRange(range)}; unsupported protocol identity`}`
}
