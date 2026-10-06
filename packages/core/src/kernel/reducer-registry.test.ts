import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import type { RegisteredReducer } from './reducer-registry'
import { randomSessionLog } from './generators/session-log'
import { EXCLUDED, REDUCERS } from './reducer-registry'
import { randomBuildLog } from './generators/build-log'
import {
  randomHarvestJournal,
  randomSandboxJournal,
  randomSettingsJournal,
  randomStatusJournal,
} from './generators/repository-journals'

/** The sorted set of JSON key paths and value types in an accumulator. */
function fingerprint(value: unknown, path = '$', out = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    out.add(`${path}: array`)
    for (const item of value) fingerprint(item, `${path}[]`, out)
  } else if (value !== null && typeof value === 'object') {
    out.add(`${path}: object`)
    for (const [key, item] of Object.entries(value)) fingerprint(item, `${path}.${key}`, out)
  } else {
    out.add(`${path}: ${value === null ? 'null' : typeof value}`)
  }
  return [...out].sort()
}

const SEEDS = [1, 2, 3, 4, 5, 6]

/** Event corpora the registered reducers are driven with. Each reducer ignores
 * the event types it does not read, so every reducer is fed every corpus and
 * the union of the shapes it reaches is fingerprinted. */
function corpora(): unknown[][] {
  return [
    ...SEEDS.map((seed) => randomBuildLog(seed, 150)),
    ...SEEDS.map((seed) => randomHarvestJournal(seed, 80)),
    ...SEEDS.map((seed) => randomSettingsJournal(seed, 30)),
    ...SEEDS.map((seed) => randomStatusJournal(seed, 60)),
    ...SEEDS.map((seed) => randomSandboxJournal(seed, 40)),
    ...SEEDS.map((seed) => randomSessionLog(seed, 50, seed % 2 === 0)),
  ]
}

const logs = corpora()
const CHUNK = 12
const fingerprints = new Map<string, string[]>()

/** Union of accumulator fingerprints after every chunk of every corpus, so
 * optional and variant fields are covered. A corpus a reducer cannot fold
 * (it throws on a malformed reference) contributes the chunks before. */
function unionFingerprint(name: string, reducer: RegisteredReducer['reducer']): string[] {
  const cached = fingerprints.get(name)
  if (cached !== undefined) return cached
  const paths = new Set<string>(fingerprint(reducer.initial()))
  for (const log of logs) {
    let acc = reducer.initial()
    try {
      for (let i = 0; i < log.length; i += CHUNK) {
        acc = reducer.advance(acc, log.slice(i, i + CHUNK))
        fingerprint(acc, '$', paths)
      }
    } catch {
      // A corpus for another domain; keep what was reached.
    }
  }
  const result = [...paths].sort()
  fingerprints.set(name, result)
  return result
}

/** Reducers whose empty accumulator already has every field, so the corpora
 * cannot add paths to it. */
const COMPLETE_WHEN_EMPTY = new Set(['dispatchSettings', 'lastExecutionOutcome'])

/** Names that are neither the in-place half of a registered reducer, covered
 * by a registered reducer, nor excluded with a reason. */
function unclassified(found: Iterable<string>, covered: ReadonlySet<string>): string[] {
  return [...found].filter(
    (name) => !name.startsWith('fold') && !covered.has(name) && !(name in EXCLUDED),
  )
}

describe('reducer registry', () => {
  test('published versions', () => {
    // Changing a reducer's accumulator shape or fold semantics requires
    // bumping its version; a changed number here is that bump under review.
    expect(
      Object.fromEntries(Object.entries(REDUCERS).map(([name, r]) => [name, r.reducer.version])),
    ).toMatchInlineSnapshot(`
      {
        "autoMergeDefault": 1,
        "baseBranch": 1,
        "build": 1,
        "buildDigest": 2,
        "currentDeferralObservation": 1,
        "currentPrAttachments": 1,
        "dispatchSettings": 1,
        "dispatchStatus": 1,
        "frozenPrImageHost": 1,
        "harvest": 1,
        "hostedPrAttachments": 1,
        "infrastructureFailureReset": 1,
        "lastExecutionOutcome": 1,
        "logIndex": 1,
        "openBuildWorkspace": 1,
        "openExecution": 1,
        "openHarvestExecutions": 1,
        "openTick": 1,
        "openWorkspace": 1,
        "pendingPrAttachmentReclaims": 1,
        "phaseFailures": 1,
        "pinnedAssets": 1,
        "provisionMarker": 1,
        "publicationState": 1,
        "publishedBranchHead": 1,
        "recordedBaseSha": 1,
        "recoveryCheckpoint": 1,
        "repositoryStateEvents": 1,
        "sandboxStates": 1,
        "session": 1,
        "setupStreak": 1,
        "verifyDiffBase": 1,
      }
    `)
  })

  test('accumulator shapes', () => {
    // If this snapshot changed, the accumulator shape changed: BUMP THE
    // REDUCER'S VERSION (and the 'published versions' snapshot above) rather
    // than only re-snapshotting. Cached accumulators are valid per version.
    const shapes = Object.fromEntries(
      Object.entries(REDUCERS).map(([name, r]) => [name, unionFingerprint(name, r.reducer)]),
    )
    expect(shapes).toMatchSnapshot()
  }, 120_000)

  test('every reducer is populated by the corpora (its fingerprint is not just the empty accumulator)', () => {
    const thin = Object.entries(REDUCERS)
      .filter(([name]) => !COMPLETE_WHEN_EMPTY.has(name))
      .filter(
        ([name, r]) =>
          unionFingerprint(name, r.reducer).length <= fingerprint(r.reducer.initial()).length,
      )
      .map(([name]) => name)
    expect(thin).toEqual([])
  }, 120_000)

  test('every event-array projection is registered or excluded with a reason', async () => {
    const covered = new Set(Object.values(REDUCERS).flatMap((r) => r.covers))
    const found = new Set<string>()
    const re =
      /(?:function\s+|^\s+(?:private\s+|public\s+|async\s+|static\s+)*)(\w+)\s*(?:<[^>]*>)?\(([^)]*)\)/gm
    const eventArray =
      /\b(?:AbEvent|RepositoryEvent|SessionEvent|DigestEvent|EventEnvelope\w*)(?:<[^>]*>)?\s*\[\]|Pick<AbEvent[^>]*>\[\]/
    for (const dir of ['kernel', 'store', 'processes']) {
      for (const file of new Glob(`${dir}/**/*.ts`).scanSync(`${import.meta.dir}/..`)) {
        if (file.endsWith('.test.ts') || file.includes('incremental')) continue
        const src = await Bun.file(`${import.meta.dir}/../${file}`).text()
        for (const m of src.matchAll(re)) {
          const name = m[1]!
          if (['if', 'for', 'while', 'switch'].includes(name)) continue
          if (eventArray.test(m[2]!)) found.add(name)
        }
      }
    }
    // `fold*` are the in-place halves of registered reducers; every other
    // projection, `reduce*` wrappers included, must be registered or excluded.
    expect(unclassified(found, covered)).toEqual([])
    for (const reason of Object.values(EXCLUDED)) expect(reason.length).toBeGreaterThan(10)
  })

  test('the guard rejects an unregistered reduce-prefixed projection', () => {
    const covered = new Set(Object.values(REDUCERS).flatMap((r) => r.covers))
    expect(unclassified(['reduceNewProjection', 'reduceBuild'], covered)).toEqual([
      'reduceNewProjection',
    ])
    const withoutBuild = new Set([...covered].filter((name) => name !== 'reduceBuild'))
    expect(unclassified(['reduceBuild'], withoutBuild)).toEqual(['reduceBuild'])
  })
})
