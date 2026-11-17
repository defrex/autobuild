/**
 * Revoking protected merge consent.
 *
 * Consent given under a `[[merge]]` rule with `paths` or `within` predicates
 * approved the protected change the operator read. When a reconcile's own
 * edits (its recorded resolution) touch a file those predicates match, the
 * change that would merge is no longer the reviewed one: the kernel appends
 * `landing.consent-revoked` where the reconcile records its head, never on a
 * poll. Clean restacks record no resolution and never revoke.
 */
import { compilePathSelectors } from '../config/path-selectors'
import type { EventPayload } from '../events/payloads'
import { LANDING_MATCHED_PATHS_PREVIEW } from '../events/head-paths-limits'
import { readHeadPaths, type RecordedHeadPaths } from './head-paths'
import type { LandingState } from './landing-state'
import type { BuildStore } from '../store/types'

export type ConsentRevocation = EventPayload<'landing.consent-revoked'>

/** Cheap guard: whether any reconcile edit could revoke the current consent. */
export function revocableConsent(landing: LandingState | undefined): boolean {
  const command = landing?.command
  return command?.kind === 'land' && !command.legacy && command.rule !== undefined
}

/** The revocation a reconcile's resolution causes, or undefined. Each
 * resolution path is matched against the union of the consent rule's `paths`
 * and `within` selectors; `within`'s every-path condition does not apply. */
export function consentRevocation(
  landing: LandingState | undefined,
  input: {
    source: ConsentRevocation['source']
    previousHead: string
    head: string
    resolution: readonly string[]
  },
): ConsentRevocation | undefined {
  const command = landing?.command
  if (!revocableConsent(landing) || command?.rule === undefined) return undefined
  const { paths, within } = command.rule.snapshot
  const protectedPath = compilePathSelectors(
    [...(paths ?? []), ...(within ?? [])],
    (selector, error) =>
      `invalid [[merge]] path selector ${JSON.stringify(selector)} in consent rule ${command.rule!.index}: ${error}`,
  )
  const matched = [...new Set(input.resolution)].sort().filter(protectedPath)
  if (matched.length === 0) return undefined
  return {
    commandSeq: command.seq,
    source: input.source,
    rule: { index: command.rule.index, snapshot: { ...command.rule.snapshot } },
    previousHead: input.previousHead,
    head: input.head,
    ...(command.head === undefined ? {} : { consentedHead: command.head }),
    paths: { total: matched.length, preview: matched.slice(0, LANDING_MATCHED_PATHS_PREVIEW) },
  }
}

/** The complete resolution paths behind a recorded head, without git: the
 * facts just deposited, else a complete summary preview, else one artifact
 * read (a retried terminal recording a resolution beyond the preview). */
export async function resolutionPathsFor(
  store: Pick<BuildStore, 'getArtifact'>,
  slug: string,
  recorded: RecordedHeadPaths,
): Promise<string[]> {
  if (recorded.recorded === 'appended') return recorded.facts.resolution?.paths ?? []
  const resolution = recorded.record.resolution
  if (resolution === undefined) return []
  if (resolution.total === resolution.preview.length) return [...resolution.preview]
  return (await readHeadPaths(store, slug, recorded.record)).resolution?.paths ?? []
}
