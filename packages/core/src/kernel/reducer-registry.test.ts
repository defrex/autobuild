import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import { sandboxStatesReducer } from '../processes/sandbox-state'
import { sessionReducer } from '../store/session-reducer'
import { randomSessionLog } from './generators/session-log'
import { EXCLUDED, REDUCERS } from './reducer-registry'
import { buildReducer } from './reducer'
import { randomBuildLog } from './generators/build-log'
import {
  randomHarvestJournal,
  randomSandboxJournal,
  randomSettingsJournal,
  randomStatusJournal,
} from './generators/repository-journals'
import { dispatchSettingsReducer } from './dispatch-settings'
import { dispatchStatusReducer } from './dispatch-status'
import { harvestReducer } from './harvest'

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

/** Accumulators populated from generated logs, so optional and nested fields
 * show up in the fingerprint; the rest fingerprint their empty accumulator. */
const SAMPLES: Record<string, () => unknown> = {
  build: () => buildReducer.advance(buildReducer.initial(), randomBuildLog(1, 80)),
  harvest: () => harvestReducer.advance(harvestReducer.initial(), randomHarvestJournal(1, 60)),
  dispatchSettings: () =>
    dispatchSettingsReducer.advance(
      dispatchSettingsReducer.initial(),
      randomSettingsJournal(1, 20),
    ),
  dispatchStatus: () => {
    const reducer = dispatchStatusReducer('run-a')
    return reducer.advance(reducer.initial(), randomStatusJournal(1, 40))
  },
  session: () => sessionReducer.advance(sessionReducer.initial(), randomSessionLog(1, 40, false)),
  sandboxStates: () =>
    sandboxStatesReducer.advance(sandboxStatesReducer.initial(), randomSandboxJournal(1, 30)),
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
        "buildDigest": 1,
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
      Object.entries(REDUCERS).map(([name, r]) => [
        name,
        fingerprint((SAMPLES[name] ?? (() => r.reducer.initial()))()),
      ]),
    )
    expect(shapes).toMatchSnapshot()
  })

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
    // Internal fold helpers and the whole-array wrappers' names are covered
    // through `covers`; `fold*` are the in-place halves of registered reducers.
    const unclassified = [...found].filter(
      (name) =>
        !name.startsWith('fold') &&
        !name.startsWith('reduce') &&
        !covered.has(name) &&
        !(name in EXCLUDED),
    )
    expect(unclassified).toEqual([])
    for (const reason of Object.values(EXCLUDED)) expect(reason.length).toBeGreaterThan(10)
  })
})
