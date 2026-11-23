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

/** One page of a repository's builds, newest first by creation. */
export interface BuildPage {
  builds: BuildRecord[]
  /** Opaque cursor for the next page; null on the last page. */
  next: string | null
}

export interface BuildPageOptions {
  /** A `next` value from an earlier page of the same adapter. */
  cursor?: string
  /** Page size, 1 to `BUILD_PAGE_MAX_LIMIT`; default `BUILD_PAGE_DEFAULT_LIMIT`. */
  limit?: number
}

/** The cursor's decoded sort key: the adapter's exact creation key and slug. */
export interface BuildPageCursor {
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
  constructor(readonly capability: 'changedBuilds' | 'buildPage') {
    super(
      `the remote store does not serve ${capability === 'changedBuilds' ? 'the changed-builds feed' : 'the paged build listing'}`,
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

const CURSOR_VERSION = 1
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
  return toBase64Url(JSON.stringify({ v: CURSOR_VERSION, at: cursor.at, slug: cursor.slug }))
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
  if (v !== CURSOR_VERSION || typeof at !== 'string' || typeof slug !== 'string' || at === '')
    throw invalid()
  return { at, slug }
}
