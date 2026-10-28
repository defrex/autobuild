import semver from 'semver'
import { z } from 'zod'
import { AUTOBUILD_VERSION, REMOTE_STORE_PROTOCOL_VERSION } from './version'

/** Stable releases only: prefixes, whitespace, prereleases and build suffixes are not identities. */
export function stableVersion(value: unknown): semver.SemVer | undefined {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) return undefined
  const parsed = semver.parse(value)
  return parsed && parsed.version === value ? parsed : undefined
}

/** Canonical release identities exclude build metadata, prefixes and whitespace. */
export function releaseVersion(value: unknown): semver.SemVer | undefined {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value))
    return undefined
  const parsed = semver.parse(value)
  return parsed && parsed.version === value ? parsed : undefined
}

/** Capability history, independent of admission: the audit signal arrived in 0.14. */
export function clientSupportsIntegrationAuditPending(version: unknown): boolean {
  const parsed = releaseVersion(version)
  return parsed !== undefined && (parsed.major > 0 || parsed.minor >= 14)
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
  const version = releaseVersion(serviceVersion)
  if (!version) throw new Error('service must have a canonical release version')
  return {
    minVersion: `${version.major}.${Math.max(0, version.minor - 2)}.0`,
    maxVersionExclusive: `${version.major}.${version.minor + 1}.0`,
  }
}

export function classifyClient(
  version: unknown,
  range: SupportedClientRange,
): 'supported' | 'older' | 'newer' | 'invalid' {
  const parsed = releaseVersion(version)
  if (!parsed) return 'invalid'
  if (semver.lt(`${parsed.major}.${parsed.minor}.0`, range.minVersion)) return 'older'
  if (semver.gte(`${parsed.major}.${parsed.minor}.0`, range.maxVersionExclusive)) return 'newer'
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
    const version = releaseVersion(client)!
    return `${description}; upgrade the service to at least ${version.major}.${version.minor}.0 before upgrading projects (service first)`
  }
  if (classification === 'older')
    return `${description}; upgrade the project's Autobuild into ${formatClientRange(range)}`
  return `${description}; supply a canonical Autobuild client version`
}

/** Retain these wire identities and handlers until their lines leave the window.
 * Historical lines require explicit entries; the service's own line uses its
 * current protocol identity. Unknown historical protocols fail closed. */
export const RELEASE_LINE_PROTOCOLS: Readonly<Record<string, string>> = {
  // v1.0.x shipped protocol 4; protocol 5+ requires the next minor line.
  '1.0': '4',
  '0.9': '3',
  '0.10': '3',
  '0.11': '3',
  '0.12': '3',
  // v0.13.0 shipped protocol 3. Protocol 4 requires the next minor line.
  '0.13': '3',
  // v0.14.0 introduced protocol 4; retain it when this line becomes historical.
  '0.14': '4',
}

export function clientIdentityError(
  client: string | null,
  protocol: string | null,
  serviceVersion = AUTOBUILD_VERSION,
  serviceProtocol = REMOTE_STORE_PROTOCOL_VERSION,
): string | undefined {
  const range = supportedClientRange(serviceVersion)
  const service = releaseVersion(serviceVersion)!
  const advice = compatibilityAdvice(client, serviceVersion, range)
  const parsed = releaseVersion(client)
  const expected =
    parsed &&
    (parsed.major === service.major && parsed.minor === service.minor
      ? serviceProtocol
      : RELEASE_LINE_PROTOCOLS[`${parsed.major}.${parsed.minor}`])
  if (!advice && expected !== undefined && protocol === expected) return undefined
  return `remote store version mismatch: client Autobuild ${client ?? '(missing)'} protocol ${protocol ?? '(missing)'}; server Autobuild ${serviceVersion} protocol ${serviceProtocol}; ${advice ?? `supported clients ${formatClientRange(range)}; unsupported protocol identity`}`
}

/** A successful server answer cannot be represented by this client's reducer. */
export class ReducerValueIncompatibilityError extends Error {
  override readonly name = 'ReducerValueIncompatibilityError'
  constructor(
    readonly reducer: string,
    readonly scope: import('../snapshots').SnapshotScope,
    readonly clientVersion: number,
    readonly serverVersion: number | undefined,
    readonly reason: string,
  ) {
    super(
      `incompatible reducer ${reducer}: client version ${clientVersion}, server version ${serverVersion ?? '(unavailable)'}; ${reason}`,
    )
  }
}
