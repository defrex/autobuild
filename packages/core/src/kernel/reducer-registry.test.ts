import { readFileSync, writeFileSync } from 'node:fs'
import { nodeRestackLog } from './generators/node-restack-log'
import { leafRestackLog } from './generators/leaf-restack-log'
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
  const identity = {
    correlation: 'upgrade',
    run: 'run-a',
    lineage: 'launcher',
    from: { version: '1', commit: 'unknown', source: { kind: 'package', location: '/old' } },
    target: {
      mode: 'pinned',
      key: 'target',
      version: '2',
      source: 'main',
      base: 'main',
      sha: 'a'.repeat(40),
    },
  }
  const handoff = {
    ...identity,
    to: { ...identity.from, version: '2' },
    root: '/cache',
    cacheId: 'id',
  }
  const draining = { ...handoff, run: 'run-drain', correlation: 'drain' }
  const drainCorpus = [
    { type: 'dispatcher.target-prepared', payload: draining },
    {
      type: 'dispatcher.yield-requested',
      payload: { ...draining, successor: 'next', mode: 'drain', evidence: 'same schema' },
    },
    {
      type: 'dispatcher.handoff-started',
      payload: {
        ...draining,
        successor: 'next',
        mode: 'drain',
        startedAt: '2026-10-21T00:00:00Z',
        deadline: '2026-10-21T00:15:00Z',
        builds: [{ slug: 'build', instance: 'execution' }],
      },
    },
    { type: 'dispatcher.terminal-released', payload: draining },
    { type: 'dispatcher.takeover', payload: { ...draining, successor: 'next' } },
    {
      type: 'dispatcher.drain-deadline',
      payload: { ...draining, deadline: '2026-10-21T00:10:00Z' },
    },
    {
      type: 'dispatcher.drain-settled',
      payload: { ...draining, slug: 'build', instance: 'execution', outcome: 'suspended' },
    },
    {
      type: 'dispatcher.handoff-completed',
      payload: {
        ...draining,
        successor: 'next',
        mode: 'drain',
        startedAt: '2026-10-21T00:00:00Z',
        endedAt: '2026-10-21T00:10:00Z',
        drained: 0,
        suspended: 1,
      },
    },
  ].map((event, index) => ({ ...event, seq: index + 1, ts: '2026-10-21T00:00:00Z' }))
  const buildDrain = [
    {
      type: 'execution.drain-authorized',
      payload: {
        correlation: 'drain',
        run: 'run-drain',
        runtime: identity.from,
        targetRuntime: handoff.to,
        instance: 'execution',
      },
    },
    {
      type: 'execution.relaunch-requested',
      payload: {
        instance: 'execution',
        correlation: 'drain',
        from: identity.from,
        to: handoff.to,
      },
    },
    {
      type: 'session.suspended',
      payload: {
        session: 'session',
        phase: 'implement',
        round: 1,
        activeMs: 1,
        cause: 'shutdown',
        transcript: { kind: 'transcript', rev: 0 },
      },
    },
    {
      type: 'execution.ended',
      payload: { instance: 'execution', workspaceRef: 'ws', outcome: 'relaunch' },
    },
    { type: 'execution.drain-settled', payload: { correlation: 'drain', instance: 'execution' } },
  ].map((event, index) => ({
    ...event,
    build: 'build',
    actor: { kind: event.type === 'session.suspended' ? 'kernel' : 'dispatcher' },
    seq: index + 1,
    ts: '2026-10-21T00:00:00Z',
  }))
  const rollbackCorpus = [
    {
      type: 'dispatcher.runtime-rolled-back',
      payload: {
        correlation: 'rollback',
        run: 'restored',
        lineage: 'launcher',
        predecessor: 'run-drain',
        successor: 'next',
        handoff: 'drain',
        takeoverAt: '2026-10-21T00:00:00Z',
        failures: 3,
        failed: handoff.to,
        restored: handoff.from,
        failedRoot: '/cache/failed',
        restoredRoot: '/cache/restored',
        target: identity.target,
        reason: 'three failed exits',
      },
    },
    {
      type: 'dispatcher.rollback-hold-cleared',
      payload: {
        correlation: 'rollback',
        run: 'restored',
        lineage: 'launcher',
        target: { ...identity.target, key: 'changed' },
      },
    },
  ].map((event, index) => ({
    ...event,
    repo: 'repo',
    actor: { kind: 'dispatcher' },
    seq: index + 1,
    ts: '2026-10-21T00:00:00Z',
  }))
  const verifyStageCorpus = [
    {
      type: 'execution.started',
      payload: { instance: 'old', provider: 'test', workspaceRef: '/stage' },
    },
    { type: 'verify.started', payload: { step: 'types', attempt: 1 } },
    { type: 'verify.started', payload: { step: 'unit', attempt: 1 } },
    {
      type: 'session.started',
      payload: { session: 's_stage', role: 'unit', runner: 'test', phase: 'verify:unit', round: 1 },
    },
    {
      type: 'escalation.raised',
      actor: { kind: 'agent', role: 'unit', session: 's_stage' },
      payload: {
        id: 'stage-question',
        source: 'agent',
        phase: 'verify:unit',
        round: 1,
        question: 'question',
      },
    },
    {
      type: 'escalation.answered',
      actor: { kind: 'human', user: 'operator' },
      payload: { id: 'stage-question', resolution: 'guidance', answer: 'retry' },
    },
    {
      type: 'verify.completed',
      payload: {
        step: 'types',
        attempt: 1,
        outcome: 'fail',
        report: { kind: 'verify-report:types', rev: 0 },
      },
    },
    { type: 'verify.cancelled', payload: { step: 'unit', attempt: 1, cause: { step: 'types' } } },
    {
      type: 'verify.stage-failed',
      payload: {
        attempt: 1,
        cycle: 0,
        stage: ['types', 'unit'],
        failed: [{ step: 'types', report: { kind: 'verify-report:types', rev: 0 } }],
        cancelled: [{ step: 'unit', cause: { step: 'types' } }],
      },
    },
    {
      type: 'implement.started',
      payload: {
        round: 2,
        verifyStageFailure: 9,
        feedback: { verify: { step: 'types', report: { kind: 'verify-report:types', rev: 0 } } },
      },
    },
    {
      type: 'execution.started',
      payload: { instance: 'new', provider: 'test', workspaceRef: '/stage' },
    },
    {
      type: 'escalation.raised',
      actor: { kind: 'agent', role: 'unit', session: 's_stage' },
      payload: {
        id: 'late-stage-question',
        source: 'agent',
        phase: 'verify:unit',
        round: 1,
        question: 'late question',
      },
    },
    {
      type: 'escalation.answered',
      actor: { kind: 'human', user: 'operator' },
      payload: { id: 'late-stage-question', resolution: 'abort', answer: 'stale' },
    },
  ].map((event, index) => ({
    build: 'stage-fixture',
    actor: { kind: 'kernel' },
    seq: index + 1,
    ts: '2026-10-24T00:00:00Z',
    ...event,
  }))
  const preparationTicket = { source: 'fake', id: 'T-1' }
  const preparationCorpus = [
    {
      type: 'ticket-preparation.intended',
      payload: {
        attempt: 'prep-1',
        ticket: preparationTicket,
        readyState: 'Ready',
        claimedState: 'Doing',
      },
    },
    {
      type: 'ticket-preparation.claimed',
      payload: { attempt: 'prep-1', ticket: preparationTicket },
    },
    {
      type: 'ticket-preparation.creation-selected',
      payload: { attempt: 'prep-1', ticket: preparationTicket, slug: 'build' },
    },
    {
      type: 'ticket-preparation.failed',
      payload: {
        attempt: 'prep-1',
        ticket: preparationTicket,
        stage: 'create-build',
        claimed: true,
        handback: 'Ready',
        error: 'offline',
      },
    },
    {
      type: 'ticket-preparation.recovery-failed',
      payload: {
        attempt: 'prep-1',
        ticket: preparationTicket,
        error: 'readback offline',
        retryAt: '2026-10-24T00:00:30.000Z',
      },
    },
  ].map((event, index) => ({
    seq: index + 1,
    ts: '2026-10-24T00:00:00.000Z',
    actor: { kind: 'dispatcher' },
    ...event,
  }))
  return [
    preparationCorpus,
    verifyStageCorpus,
    rollbackCorpus.slice(0, 1),
    rollbackCorpus,
    drainCorpus,
    buildDrain.slice(0, 1),
    buildDrain,
    [
      {
        type: 'tickets.migration-recorded',
        payload: { identity: 'migration', from: 'linear', to: 'file', mapping: { N: 'NODE' } },
        seq: 1,
      },
    ],
    [
      {
        type: 'dispatcher.upgrade-target-resolved',
        seq: 0,
        ts: '2026-10-20T23:59:59Z',
        payload: { run: identity.run, lineage: identity.lineage, target: identity.target },
      },
      {
        type: 'dispatcher.upgrade-detected',
        seq: 1,
        ts: '2026-10-21T00:00:00Z',
        payload: identity,
      },
      {
        type: 'dispatcher.upgrade-failed',
        seq: 2,
        ts: '2026-10-21T00:00:01Z',
        payload: { ...identity, reason: 'unavailable' },
      },
      { type: 'dispatcher.handoff-started', seq: 3, ts: '2026-10-21T00:00:02Z', payload: handoff },
      {
        type: 'dispatcher.handoff-completed',
        seq: 4,
        ts: '2026-10-21T00:00:03Z',
        payload: { ...handoff, successor: 'run-b' },
      },
    ],
    [
      {
        type: 'runner.attached',
        seq: 1,
        ts: '2026-10-21T00:00:00Z',
        payload: { instance: 'runner', host: 'host', resumedFromSeq: 0 },
      },
      {
        type: 'runner.runtime-recorded',
        seq: 2,
        payload: {
          instance: 'runner',
          attachedSeq: 1,
          runtime: {
            version: '1',
            commit: 'unknown',
            source: { kind: 'package', location: '/runtime' },
          },
        },
      },
      {
        type: 'dispatcher.run-started',
        seq: 3,
        payload: {
          run: 'run-a',
          pid: 1,
          effectiveConfig: { kind: 'config', rev: 0 },
          roleWarnings: [],
        },
      },
      {
        type: 'dispatcher.runtime-recorded',
        seq: 4,
        payload: {
          run: 'run-a',
          startedSeq: 3,
          runtime: {
            version: '1',
            commit: 'unknown',
            source: { kind: 'package', location: '/runtime' },
          },
        },
      },
    ],
    [
      {
        type: 'publication.retry-scheduled',
        seq: 1,
        actor: { kind: 'kernel' },
        build: 'retry-fixture',
        ts: '2026-10-25T00:00:00.000Z',
        payload: {
          operation: 'restack',
          rewriteId: 'r',
          round: 1,
          anchor: 0,
          failure: 1,
          error: 'HTTP 503',
          retryAt: '2026-10-25T00:00:30.000Z',
        },
      },
      {
        type: 'publication.retry-exhausted',
        seq: 2,
        actor: { kind: 'dispatcher' },
        build: 'retry-fixture',
        ts: '2026-10-25T01:00:00.000Z',
        payload: {
          operation: 'restack',
          rewriteId: 'r',
          round: 1,
          anchor: 0,
          failure: 7,
          error: 'HTTP 503',
        },
      },
    ],
    leafRestackLog(),
    [
      {
        type: 'finalize.step-completed',
        seq: 1,
        payload: { step: 'post', ok: true, headSha: 'a'.repeat(40) },
      },
    ],
    nodeRestackLog(),
    [
      {
        type: 'build.created',
        payload: {
          ticket: { source: 'fake', id: 'N' },
          repo: 'repo',
          baseBranch: 'ab-node/parent',
          kind: 'node',
          target: { ticket: { source: 'fake', id: 'P' }, build: 'parent' },
        },
      },
      {
        type: 'node.opening',
        payload: { branch: 'ab-node/n', parent: 'ab-node/parent', sha: 'opening' },
      },
      { type: 'node.opened', payload: { sha: 'opening' } },
      {
        type: 'node.restack-requested',
        payload: {
          id: 'request',
          reason: 'presence',
          branch: 'main',
          parent: 'parent',
          dependent: { source: 'fake', id: 'D' },
          identities: ['build:source'],
        },
      },
      {
        type: 'node.parent-distance',
        payload: { base: 'opening', parent: 'parent', branch: 'main', count: 3 },
      },
      { type: 'node.compared', payload: { parentSha: 'opening', headSha: 'child', ahead: 1 } },
      {
        type: 'node.poll-checked',
        ts: '2026-10-22T12:00:00.000Z',
        payload: {
          activityKey: 'activity',
          unchangedSince: '2026-10-22T11:50:00.000Z',
          nodeIdleAfterSeconds: 600,
          nodeIdlePollSeconds: 120,
        },
      },
      {
        type: 'pr.opened',
        payload: { pr: { number: 1, url: 'https://example/pr/1', headSha: 'child' } },
      },
    ],
    [
      {
        type: 'dispatcher.ticket-source-degraded',
        payload: {
          source: 'fake',
          cause: 'rate-limited',
          operation: 'dependency-check',
          message: 'limited',
          resetAt: '2026-10-14T12:00:00.000Z',
        },
      },
    ],
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
const COMPLETE_WHEN_EMPTY = new Set([
  'dispatchSettings',
  'lastExecutionOutcome',
  'buildDelegation',
  'harvestDelegation',
])

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
        "baseBranch": 2,
        "baseBranchValue": 2,
        "build": 27,
        "buildDelegation": 1,
        "buildDigest": 10,
        "buildReadFacts": 75,
        "buildStreamSeed": 39,
        "currentDeferralObservation": 1,
        "currentPrAttachments": 1,
        "dashboardFacts": 3,
        "dispatchFailureBudget": 1,
        "dispatchFrontend": 4,
        "dispatchSettings": 1,
        "dispatchStatus": 4,
        "dispatchUpgrade": 6,
        "dispatcherRunFacts": 3,
        "effectiveConfig": 1,
        "executionNoProgress": 6,
        "forgeHealthValue": 1,
        "frozenPrImageHost": 1,
        "harvest": 3,
        "harvestDelegation": 2,
        "hostedPrAttachments": 1,
        "infrastructureFailureReset": 1,
        "journalView": 8,
        "lastExecutionOutcome": 2,
        "leafRestack": 6,
        "logIndex": 6,
        "nodeRestack": 8,
        "openBuildWorkspace": 2,
        "openExecution": 1,
        "openHarvestExecutions": 1,
        "openTick": 1,
        "openWorkspace": 1,
        "pendingPrAttachmentReclaims": 1,
        "phaseFailures": 3,
        "pinnedAssets": 2,
        "provisionMarker": 1,
        "publicationState": 7,
        "publishedBranchHead": 4,
        "publishedBranchHeadValue": 4,
        "recordedBaseSha": 1,
        "recordedBaseShaValue": 1,
        "recoveryCheckpoint": 4,
        "repositoryAttention": 2,
        "repositoryReadFacts": 33,
        "repositoryStateEvents": 7,
        "sandboxStates": 1,
        "session": 1,
        "setupStreak": 1,
        "summaryBoundary": 1,
        "summaryRequests": 1,
        "terminalGuard": 3,
        "ticketMigrations": 1,
        "ticketPreparation": 1,
        "ticketSourceHealth": 2,
        "verifyDiffBase": 2,
        "verifyDiffBaseValue": 2,
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
    // Direct JSON equality preserves the complete shape guard. Bun's external
    // snapshot assertion fails after module mocks load, even for identical shapes.
    // Regenerate using these same deterministic corpora after reviewing the
    // version bumps: AB_UPDATE_REDUCER_SHAPES=1 bun test <this file> --update-snapshots.
    if (process.env.AB_UPDATE_REDUCER_SHAPES === '1')
      writeFileSync(
        new URL('./__snapshots__/reducer-accumulator-shapes.json', import.meta.url),
        `${JSON.stringify(shapes, null, 2)}\n`,
      )
    const expected = JSON.parse(
      readFileSync(
        new URL('./__snapshots__/reducer-accumulator-shapes.json', import.meta.url),
        'utf8',
      ),
    )
    expect(shapes).toEqual(expected)
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
