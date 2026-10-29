import semver from 'semver'
import { z } from 'zod'
import { AUTOBUILD_VERSION, REMOTE_STORE_PROTOCOL_VERSION } from './version'
import { projectReducerValue, type ReducerValueCatalog } from '../reducer-value-validation'
import {
  RELEASED_CLIENTS,
  releaseLine,
  supportedPublishedLines,
  CLIENT_POLICY_FLOOR,
  CLIENT_SUPPORT_POLICY,
  type ReleasedClient,
} from './released-clients'
import { RELEASED_REDUCER_VALUES } from './released-reducer-values'

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

/** Capture time per decision, so retirement takes effect without a redeploy. */
export function supportedClientRange(
  serviceVersion = AUTOBUILD_VERSION,
  now = Date.now(),
  releases: readonly ReleasedClient[] = RELEASED_CLIENTS,
): SupportedClientRange {
  const version = releaseVersion(serviceVersion)
  if (!version) throw new Error('service must have a canonical release version')
  const lines = supportedPublishedLines(serviceVersion, now, releases)
  return {
    minVersion:
      lines[0] ??
      (semver.lt(releaseLine(serviceVersion), CLIENT_POLICY_FLOOR)
        ? CLIENT_POLICY_FLOOR
        : releaseLine(serviceVersion)),
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
export const RELEASE_LINE_PROTOCOLS: Readonly<Record<string, string>> = Object.fromEntries(
  RELEASED_CLIENTS.filter(
    (entry) => entry.protocol && semver.gte(releaseLine(entry.version), CLIENT_POLICY_FLOOR),
  ).map((entry) => [releaseLine(entry.version).split('.').slice(0, 2).join('.'), entry.protocol!]),
)

export function clientIdentityError(
  client: string | null,
  protocol: string | null,
  serviceVersion = AUTOBUILD_VERSION,
  serviceProtocol = REMOTE_STORE_PROTOCOL_VERSION,
  now = Date.now(),
  releases: readonly ReleasedClient[] = RELEASED_CLIENTS,
): string | undefined {
  const range = supportedClientRange(serviceVersion, now, releases)
  const service = releaseVersion(serviceVersion)!
  const advice = compatibilityAdvice(client, serviceVersion, range)
  const parsed = releaseVersion(client)
  const expected =
    parsed &&
    (parsed.major === service.major && parsed.minor === service.minor
      ? serviceProtocol
      : releases.find((entry) => releaseLine(entry.version) === releaseLine(parsed.version))
          ?.protocol)
  if (
    parsed &&
    semver.gte(releaseLine(parsed.version), CLIENT_POLICY_FLOOR) &&
    !advice &&
    expected !== undefined &&
    protocol === expected
  )
    return undefined
  return `remote store version mismatch: client Autobuild ${client ?? '(missing)'} protocol ${protocol ?? '(missing)'}; server Autobuild ${serviceVersion} protocol ${serviceProtocol}; ${advice ?? `supported clients ${formatClientRange(range)}; unsupported protocol identity`}; ${CLIENT_SUPPORT_POLICY}`
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

/** Answer a published client as its release can read: project the canonical
 * value onto the release's frozen shape and stamp the version it expects. A value
 * the release cannot represent is returned unchanged, so the client raises its
 * typed incompatibility error rather than misreading it. */
export function reducerValueForClient<T extends { version: number; value: unknown }>(
  client: { version: string | null; projects: boolean; catalogIdentity?: string | null },
  reducer: string,
  answer: T,
): T {
  // Source clients retain the package version between releases. Their catalog
  // can require fields absent from that version's published contract.
  if (client.projects && client.catalogIdentity) return answer
  const { version: release } = client
  if (release === null) return answer
  const published = RELEASED_CLIENTS.find((entry) => entry.version === release)
  if (!published?.contract) return answer
  const catalog = RELEASED_REDUCER_VALUES[published.contract]
  if (!catalog) return answer
  if (!Object.hasOwn(catalog.versions, reducer)) return answer
  const projected = projectReleasedValue(reducer, answer.value, catalog)
  if ('path' in projected) return answer
  return {
    ...answer,
    version: catalog.versions[reducer]!,
    value: (projected as { value: unknown }).value,
  }
}

/** Only the optional display event may be omitted when a release predates its
 * discriminant. Progress, sequence and required compatibility facts stay intact.
 * The catalog-directed walk covers nested build state without reading history. */
function projectReleasedValue(name: string, value: unknown, catalog: ReducerValueCatalog) {
  const root = catalog.roots[name]
  if (!root) return { path: '$', expected: 'known reducer' }
  function adapt(id: string, input: unknown): unknown {
    const shape = catalog.schemas[id]!
    if (shape.kind === 'union') {
      for (const member of shape.items as string[]) {
        const candidate = adapt(member, input)
        const result = projectReducerValue('candidate', candidate, {
          ...catalog,
          roots: { candidate: { value: member } },
        })
        if (!('path' in result)) return candidate
      }
      return input
    }
    if (shape.kind === 'array' && Array.isArray(input))
      return input.map((item) => adapt(shape.items as string, item))
    if (shape.kind !== 'object' || !input || typeof input !== 'object' || Array.isArray(input))
      return input
    const out = { ...input } as Record<string, unknown>
    for (const [key, prop] of Object.entries(shape.props ?? {})) {
      if (!(key in out)) continue
      if (key === 'lastEvent' && prop.optional) {
        const result = projectReducerValue('event', out[key], {
          ...catalog,
          roots: { event: { value: prop.type } },
        })
        const event = out[key]
        function knowsType(id: string): boolean {
          const variant = catalog.schemas[id]!
          if (variant.kind === 'union') return (variant.items as string[]).some(knowsType)
          const type = variant.props?.type
          if (!type || !event || typeof event !== 'object' || !('type' in event)) return false
          return !(
            'path' in
            projectReducerValue('type', event.type, {
              ...catalog,
              roots: { type: { value: type.type } },
            })
          )
        }
        if (
          'path' in result &&
          event &&
          typeof event === 'object' &&
          'type' in event &&
          typeof event.type === 'string' &&
          !knowsType(prop.type)
        ) {
          delete out[key]
          continue
        }
      }
      // seenTypes is the set of event types this reader can act on, rather
      // than an event history. Retain its known members; compatibility facts
      // and sequence/progress remain the server's canonical answer.
      if (key === 'seenTypes' && Array.isArray(out[key])) {
        const array = catalog.schemas[prop.type]!
        if (array.kind === 'array') {
          out[key] = (out[key] as unknown[]).filter(
            (type) =>
              typeof type !== 'string' ||
              !(
                'path' in
                projectReducerValue('type', type, {
                  ...catalog,
                  roots: { type: { value: array.items as string } },
                })
              ),
          )
          continue
        }
      }
      out[key] = adapt(prop.type, out[key])
    }
    if (shape.index)
      for (const key of Object.keys(out))
        if (!Object.hasOwn(shape.props ?? {}, key)) out[key] = adapt(shape.index, out[key])
    return out
  }
  return projectReducerValue(name, adapt(root.value, value), catalog)
}
