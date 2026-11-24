/**
 * The changed-builds feed and the paged build listing (RFC 0007 §8.4, §9.2):
 * the shared vocabulary every BuildStore adapter answers with.
 *
 * Repository change positions are ordered: a later build creation, build
 * event or repository event yields a strictly greater position, compared
 * numerically. Each build also carries its latest change position, recorded in
 * the same transaction as the write that moved it, so a consumer can ask which
 * builds changed since a position it saved and advance by only those.
 *
 * Browser-safe: no `Buffer` and no Bun APIs, because the operator web app
 * bundles the store contract and the remote protocol.
 */
import type { BuildRecord } from './types'

/** One build whose latest change position is after the requested position. */
export interface ChangedBuild {
  slug: string
  /** The build's latest change position, a canonical unsigned decimal. */
  position: string
}

/** `listBuildsChangedSince` answer. `position` is the repository head read in
 * the same snapshot as `builds`, so a caller may save it as its next
 * watermark without missing a change. */
export interface ChangedBuilds {
  position: string
  /** Ascending by position; each build at most once, at its latest position. */
  builds: ChangedBuild[]
}

/** One page of a repository's builds: newest first by creation, or most
 * recently updated first when the request carries `activeSince`. */
export interface BuildPage {
  builds: BuildRecord[]
  /** Opaque cursor for the next page; null on the last page. */
  next: string | null
}

/** A build's listing kind: a node build, or a leaf (any other kind). */
export type BuildPageKind = 'leaf' | 'node'

/**
 * The paged listing's optional filters. Each is answered from per-build facts
 * the store writes in the same transaction as the write that changes them,
 * never from a build's events or reduced values.
 */
export interface BuildPageFilters {
  /** `node` when the build's `build.created` kind is `node`; `leaf` otherwise. */
  kind?: BuildPageKind
  /** `merged`: the build's latest `build.completed` was merged and it has not
   * been reopened since. */
  outcome?: 'merged'
  /**
   * An ISO instant with a zone. Only builds whose `updatedAt` is at or after
   * it match, and the page is ordered by `updatedAt` descending, then slug
   * descending, instead of by creation. Every write to a build bumps its
   * `updatedAt`, and a build's span never ends later than its latest event, so
   * the matches are a superset of the builds whose span overlaps
   * `[activeSince, now]`. Because `updatedAt` moves, a build written between
   * two page requests may appear twice in one traversal, or be skipped once;
   * consumers dedupe by slug.
   */
  activeSince?: string
}

export interface BuildPageOptions extends BuildPageFilters {
  /** A `next` value from an earlier page of the same adapter, requested with
   * the same filters. */
  cursor?: string
  /** Page size, 1 to `BUILD_PAGE_MAX_LIMIT`; default `BUILD_PAGE_DEFAULT_LIMIT`. */
  limit?: number
}

/** The order a page walks: by creation, or by update under `activeSince`. */
export type BuildPageOrder = 'created' | 'updated'

/** The cursor's decoded sort key: the adapter's exact creation or update key
 * and slug, and which of the two orders it continues. */
export interface BuildPageCursor {
  order: BuildPageOrder
  at: string
  slug: string
}

/** A feed or page argument the store rejects before reading anything. */
export class BuildFeedValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BuildFeedValidationError'
  }
}

/** A remote server on the same release line that does not serve the feed or
 * the paged listing. The client never falls back to listing builds or reading
 * events to answer instead. */
export class BuildFeedUnsupportedError extends Error {
  constructor(readonly capability: 'changedBuilds' | 'buildPage' | 'buildPageFilters') {
    super(
      capability === 'buildPageFilters'
        ? 'the remote store does not filter the paged build listing'
        : `the remote store does not serve ${capability === 'changedBuilds' ? 'the changed-builds feed' : 'the paged build listing'}`,
    )
    this.name = 'BuildFeedUnsupportedError'
  }
}

export const CHANGE_POSITION_PATTERN = /^(0|[1-9][0-9]*)$/
/** The Postgres `bigint` ceiling; every adapter refuses positions above it. */
export const MAX_CHANGE_POSITION = 9223372036854775807n

/** Parse a canonical unsigned decimal change position. */
export function parseChangePosition(value: unknown): bigint {
  if (typeof value !== 'string' || !CHANGE_POSITION_PATTERN.test(value))
    throw new BuildFeedValidationError(
      `change position must be a canonical unsigned decimal, got ${JSON.stringify(value)}`,
    )
  const position = BigInt(value)
  if (position > MAX_CHANGE_POSITION)
    throw new BuildFeedValidationError(`change position ${value} exceeds the maximum`)
  return position
}

/** Numeric order of two canonical change positions. */
export function compareChangePositions(a: string, b: string): -1 | 0 | 1 {
  const left = parseChangePosition(a)
  const right = parseChangePosition(b)
  return left < right ? -1 : left > right ? 1 : 0
}

export const BUILD_PAGE_DEFAULT_LIMIT = 25
export const BUILD_PAGE_MAX_LIMIT = 100

/** The page size to read: an integer from 1 to the max. Never clamps. */
export function resolveBuildPageLimit(limit?: unknown): number {
  if (limit === undefined) return BUILD_PAGE_DEFAULT_LIMIT
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > BUILD_PAGE_MAX_LIMIT
  )
    throw new BuildFeedValidationError(
      `page limit must be an integer from 1 to ${BUILD_PAGE_MAX_LIMIT}, got ${JSON.stringify(limit)}`,
    )
  return limit
}

/** Parse a decimal page-limit query parameter; absent means the default. */
export function parseBuildPageLimitParam(value: string | null): number {
  if (value === null) return BUILD_PAGE_DEFAULT_LIMIT
  if (!/^[1-9][0-9]{0,2}$/.test(value))
    throw new BuildFeedValidationError(
      `page limit must be an integer from 1 to ${BUILD_PAGE_MAX_LIMIT}, got ${JSON.stringify(value)}`,
    )
  return resolveBuildPageLimit(Number(value))
}

/** Cursor format versions: v1 continues creation order (its bytes predate
 * filters and stay unchanged); v2 continues update order. */
const CURSOR_VERSIONS: Record<BuildPageOrder, number> = { created: 1, updated: 2 }
const MAX_CURSOR_LENGTH = 2048

function toBase64Url(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): string {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/** Encode an adapter's sort key as an opaque cursor. */
export function encodeBuildPageCursor(cursor: BuildPageCursor): string {
  return toBase64Url(
    JSON.stringify({ v: CURSOR_VERSIONS[cursor.order], at: cursor.at, slug: cursor.slug }),
  )
}

/** Decode a cursor from `encodeBuildPageCursor`; malformed input rejects. */
export function decodeBuildPageCursor(cursor: unknown): BuildPageCursor {
  const invalid = () => new BuildFeedValidationError('malformed build page cursor')
  if (
    typeof cursor !== 'string' ||
    cursor.length === 0 ||
    cursor.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  )
    throw invalid()
  let parsed: unknown
  try {
    parsed = JSON.parse(fromBase64Url(cursor))
  } catch {
    throw invalid()
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 3
  )
    throw invalid()
  const { v, at, slug } = parsed as Record<string, unknown>
  const order = v === 1 ? 'created' : v === 2 ? 'updated' : undefined
  if (order === undefined || typeof at !== 'string' || typeof slug !== 'string' || at === '')
    throw invalid()
  return { order, at, slug }
}

/** The order a request with these filters walks. */
export function buildPageOrder(filters: BuildPageFilters): BuildPageOrder {
  return filters.activeSince === undefined ? 'created' : 'updated'
}

/** Reject a cursor issued for the other order: an `activeSince` request needs
 * an update-order cursor, any other request a creation-order cursor. */
export function requireBuildPageCursorOrder(
  cursor: BuildPageCursor,
  filters: BuildPageFilters,
): BuildPageCursor {
  if (cursor.order !== buildPageOrder(filters))
    throw new BuildFeedValidationError('build page cursor belongs to a different ordering')
  return cursor
}

const ACTIVE_SINCE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/

/**
 * Validate and normalize a request's filters. `activeSince` becomes its
 * `toISOString()` form, which is how every adapter writes `updatedAt`. Only
 * present filters are returned; an invalid one rejects.
 */
export function resolveBuildPageFilters(opts: BuildPageFilters = {}): BuildPageFilters {
  const filters: BuildPageFilters = {}
  if (opts.kind !== undefined) {
    if (opts.kind !== 'leaf' && opts.kind !== 'node')
      throw new BuildFeedValidationError(
        `build page kind must be leaf or node, got ${JSON.stringify(opts.kind)}`,
      )
    filters.kind = opts.kind
  }
  if (opts.outcome !== undefined) {
    if (opts.outcome !== 'merged')
      throw new BuildFeedValidationError(
        `build page outcome must be merged, got ${JSON.stringify(opts.outcome)}`,
      )
    filters.outcome = opts.outcome
  }
  if (opts.activeSince !== undefined) {
    const value: unknown = opts.activeSince
    const time =
      typeof value === 'string' && ACTIVE_SINCE_PATTERN.test(value) ? Date.parse(value) : NaN
    if (!Number.isFinite(time))
      throw new BuildFeedValidationError(
        `build page activeSince must be an ISO instant with a zone, got ${JSON.stringify(value)}`,
      )
    filters.activeSince = new Date(time).toISOString()
  }
  return filters
}

const FILTER_PARAMS = ['kind', 'outcome', 'activeSince'] as const

/** Parse filter query parameters; an absent parameter is no filter, and an
 * empty or invalid value rejects. */
export function parseBuildPageFilterParams(params: URLSearchParams): BuildPageFilters {
  const raw: Record<string, string> = {}
  for (const name of FILTER_PARAMS) {
    const value = params.get(name)
    if (value !== null) raw[name] = value
  }
  return resolveBuildPageFilters(raw as BuildPageFilters)
}

/** True when any filter is present. */
export function hasBuildPageFilters(filters: BuildPageFilters | undefined): boolean {
  return filters !== undefined && FILTER_PARAMS.some((name) => filters[name] !== undefined)
}

/** True when two normalized filter sets are equal, absent keys included. */
export function sameBuildPageFilters(
  a: BuildPageFilters | undefined,
  b: BuildPageFilters | undefined,
): boolean {
  return FILTER_PARAMS.every((name) => a?.[name] === b?.[name])
}
