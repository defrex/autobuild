import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { VERIFY_BASE_ENV } from './verify-diff-base'
import { temporaryDirectories } from '../testing/temp-directories'
import { nodeRestackLog } from './generators/node-restack-log'
import { leafRestackLog } from './generators/leaf-restack-log'
import {
  attemptMeasurementLog,
  attemptLandingLog,
  optimizationLog,
  unmeasuredMergeLog,
  panelOptimizationLog,
} from './generators/optimization-log'
import { afterEach, describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import type { RegisteredReducer } from './reducer-registry'
import { randomSessionLog } from './generators/session-log'
import { EXCLUDED, REDUCERS } from './reducer-registry'
import {
  IDENTIFIED,
  LEGACY_REDUCER_VERSIONS,
  PARTS,
  canonicalJson,
  checkAgainstBase,
  checkIdentityRecords,
  deriveReducerVersion,
  evaluationCorpora,
  foldDigest,
  formatBaseRelativeSkipped,
  formatUnregeneratedCombination,
  parseLedgerSource,
  parseRecordFile,
  parseRevisions,
  planRegeneration,
  recordKey,
  revisionSet,
  unrevisedSinceBase,
  type CurrentIdentity,
  type IdentityRecord,
} from './reducer-identity'
import { REDUCER_REVISIONS } from './reducer-revisions'
import { randomBuildLog } from './generators/build-log'
import {
  randomHarvestJournal,
  randomSandboxJournal,
  randomSettingsJournal,
  randomStatusJournal,
} from './generators/repository-journals'

/** Adds the JSON key paths and value types in `value` to `out`. */
function collectPaths(value: unknown, path: string, out: Set<string>): void {
  if (Array.isArray(value)) {
    out.add(`${path}: array`)
    for (const item of value) collectPaths(item, `${path}[]`, out)
  } else if (value !== null && typeof value === 'object') {
    out.add(`${path}: object`)
    for (const [key, item] of Object.entries(value)) collectPaths(item, `${path}.${key}`, out)
  } else {
    out.add(`${path}: ${value === null ? 'null' : typeof value}`)
  }
}

/** The sorted set of JSON key paths and value types in an accumulator. */
function fingerprint(value: unknown): string[] {
  const out = new Set<string>()
  collectPaths(value, '$', out)
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
    {
      type: 'ticket-preparation.handback-selected',
      payload: { attempt: 'prep-1', ticket: preparationTicket, state: 'Triage', missing: ['a'] },
    },
    {
      type: 'ticket.handed-back',
      payload: {
        ticket: preparationTicket,
        attempt: 'prep-1',
        cause: 'spec-bounce',
        state: 'Triage',
        role: 'triage',
        missing: ['a'],
      },
    },
    {
      type: 'ticket.handed-back',
      payload: {
        ticket: preparationTicket,
        build: 'build',
        cause: 'abort',
        state: 'Ready',
        role: 'ready',
      },
    },
    {
      type: 'ticket.start-requested',
      actor: { kind: 'human', user: 'alice' },
      payload: { ticket: preparationTicket, priority: 'normal' },
    },
    {
      type: 'ticket.start-requested',
      actor: { kind: 'human', user: 'alice' },
      payload: { ticket: preparationTicket, priority: 'urgent' },
    },
    {
      type: 'ticket.start-settled',
      payload: {
        request: 9,
        ticket: preparationTicket,
        priority: 'urgent',
        outcome: 'started',
        slug: 'build',
        detail: 'claimed',
      },
    },
    {
      type: 'ticket.start-requested',
      actor: { kind: 'human', user: 'alice' },
      payload: { ticket: { source: 'fake', id: 'T-2' }, priority: 'manual' },
    },
    {
      type: 'ticket.identity-recorded',
      payload: {
        identities: [{ build: 'build', recorded: 'ticket-1', canonical: 'T-1' }],
        released: ['gone'],
      },
    },
  ].map((event, index) => ({
    seq: index + 1,
    ts: '2026-10-24T00:00:00.000Z',
    actor: { kind: 'dispatcher' },
    ...event,
  }))
  const rewrite = {
    type: 'target.rewritten',
    build: 'node',
    seq: 3,
    ts: '2026-10-24T00:00:00.000Z',
    actor: { kind: 'dispatcher' },
    payload: { branch: 'main', previousSha: 'a'.repeat(40), sha: 'b'.repeat(40) },
  }
  return [
    ...[{ hosted: true, origin: 'https://store.test' }, { hosted: false }].map((payload) => [
      {
        repo: 'repo',
        type: 'dispatcher.placement-set',
        payload,
        actor: { kind: 'kernel' },
        seq: 1,
        ts: '2026-10-30T00:00:00Z',
      },
    ]),
    [...leafRestackLog(), rewrite],
    [...nodeRestackLog(), rewrite],
    [rewrite],
    [
      {
        type: 'build.created',
        seq: 1,
        payload: {
          ticket: { source: 'fake', id: 'N' },
          repo: 'repo',
          baseBranch: 'main',
          kind: 'node',
        },
      },
      { type: 'node.opened', seq: 2, payload: { sha: 'a'.repeat(40) } },
      rewrite,
    ],
    [
      {
        type: 'account.credentials-unavailable',
        payload: {
          name: 'billing',
          descriptor: { kind: 'claude-subscription', credentialEnv: 'BILLING' },
          source: 'project-secrets',
          remedy: 'set BILLING',
        },
      },
    ],
    preparationCorpus,
    [
      {
        type: 'harvest.execution.authorized',
        payload: { execution: 'x1', run: 'h1', launch: 'started', leaseHolder: 'run-a' },
      },
      {
        type: 'harvest.execution.released',
        payload: { execution: 'x1', environmentId: 'env', snapshots: { outcome: 'confirmed' } },
      },
    ].map((event, index) => ({
      repo: 'repo',
      actor: { kind: 'dispatcher' },
      seq: index + 1,
      ts: '2026-11-11T00:00:00Z',
      ...event,
    })),
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
        type: 'target.rewritten',
        build: 'node',
        seq: 3,
        ts: '2026-10-24T00:00:00.000Z',
        actor: { kind: 'dispatcher' },
        payload: { branch: 'main', previousSha: 'a'.repeat(40), sha: 'b'.repeat(40) },
      },
      { type: 'target.rewrite-cleared', payload: { branch: 'main', sha: 'a'.repeat(40) } },

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
    [
      {
        type: 'build.created',
        payload: {
          ticket: { source: 'fake', id: 'P-1' },
          repo: 'repo',
          baseBranch: 'main',
          profile: 'deep',
        },
      },
      {
        type: 'session.started',
        payload: {
          session: 's_profile',
          role: 'plan',
          runner: 'test',
          phase: 'plan',
          round: 1,
          profile: { name: 'deep', configured: false },
        },
      },
    ].map((event, index) => ({
      ...event,
      build: 'profiled',
      actor: { kind: event.type === 'session.started' ? 'kernel' : 'dispatcher' },
      seq: index + 1,
      ts: '2026-11-12T00:00:00Z',
    })),
    [
      {
        type: 'build.created',
        payload: { ticket: { source: 'fake', id: 'C-1' }, repo: 'repo', baseBranch: 'main' },
      },
      {
        type: 'landing.decided',
        payload: {
          candidate: { head: 'aaa', parent: 'base', cycle: '1' },
          from: 'leaf',
          into: { kind: 'root' },
          labels: [],
          mode: 'consent',
          rule: { default: true },
        },
      },
      { type: 'build.land-requested', payload: { decisionSeq: 2 } },
    ].map((event, index) => ({
      ...event,
      build: 'consented',
      actor:
        event.type === 'build.land-requested'
          ? { kind: 'human', user: 'operator' }
          : { kind: 'dispatcher' },
      seq: index + 1,
      ts: '2026-11-16T00:00:00Z',
    })),
    [
      {
        type: 'build.created',
        payload: { ticket: { source: 'fake', id: 'M-1' }, repo: 'repo', baseBranch: 'main' },
      },
      {
        type: 'landing.decided',
        payload: {
          candidate: { head: 'aaa', parent: 'base', cycle: '1' },
          from: 'leaf',
          into: { kind: 'root' },
          labels: [],
          mode: 'auto',
          rule: { index: 1, snapshot: { within: ['docs/**'], paths: ['docs/a.md'], mode: 'auto' } },
          paths: { total: 1, preview: ['docs/a.md'] },
        },
      },
      {
        type: 'landing.deferred',
        payload: {
          candidate: { head: 'bbb', parent: 'base', cycle: '1' },
          reason: 'paths-unrecorded',
          rule: { index: 0, snapshot: { paths: ['autobuild.toml'], mode: 'consent' } },
          policy: 'sha256:policy',
        },
      },
    ].map((event, index) => ({
      ...event,
      build: 'path-ruled',
      actor: { kind: 'dispatcher' },
      seq: index + 1,
      ts: '2026-11-17T00:00:00Z',
    })),
    [
      {
        type: 'build.created',
        actor: { kind: 'dispatcher' },
        payload: { ticket: { source: 'fake', id: 'M-2' }, repo: 'repo', baseBranch: 'main' },
      },
      {
        type: 'landing.decided',
        actor: { kind: 'dispatcher' },
        payload: {
          candidate: { head: 'aaa', parent: 'base', cycle: '1' },
          from: 'leaf',
          into: { kind: 'root' },
          labels: [],
          mode: 'consent',
          rule: { index: 0, snapshot: { paths: ['autobuild.toml'], mode: 'consent' } },
          paths: { total: 1, preview: ['autobuild.toml'] },
        },
      },
      { type: 'build.land-requested', actor: { kind: 'human' }, payload: { decisionSeq: 2 } },
      {
        type: 'landing.consent-revoked',
        actor: { kind: 'kernel' },
        payload: {
          commandSeq: 3,
          source: 'reconcile',
          rule: { index: 0, snapshot: { paths: ['autobuild.toml'], mode: 'consent' } },
          previousHead: 'aaa',
          head: 'bbb',
          consentedHead: 'aaa',
          paths: { total: 1, preview: ['autobuild.toml'] },
        },
      },
      {
        type: 'landing.decided',
        actor: { kind: 'dispatcher' },
        payload: {
          candidate: { head: 'bbb', parent: 'base', cycle: '1' },
          from: 'leaf',
          into: { kind: 'root' },
          labels: [],
          mode: 'consent',
          rule: { index: 0, snapshot: { within: ['config/**'], mode: 'consent' } },
          paths: { total: 1, preview: ['config/a.toml'] },
        },
      },
      { type: 'build.land-requested', actor: { kind: 'human' }, payload: { decisionSeq: 5 } },
    ].map((event, index) => ({
      ...event,
      build: 'consent-revoked',
      seq: index + 1,
      ts: '2026-11-17T00:00:00Z',
    })),
    [
      {
        type: 'build.created',
        payload: { ticket: { source: 'fake', id: 'H-1' }, repo: 'repo', baseBranch: 'main' },
      },
      {
        type: 'head.paths-recorded',
        payload: {
          source: 'reconcile',
          head: 'a'.repeat(40),
          destination: 'b'.repeat(40),
          mergeBase: 'c'.repeat(40),
          total: 2,
          preview: ['a.ts', 'b.ts'],
          resolution: { total: 1, preview: ['a.ts'] },
          artifact: { kind: 'head-paths', rev: 0 },
        },
      },
      {
        type: 'node.writer-reserved',
        payload: {
          id: 'rw',
          operation: 'restack',
          expected: 'old-head',
          parent: 'parent',
          oldBase: 'old-base',
          archive: 'refs/autobuild/archive/x',
          changes: [{ sha: 'change', build: 'child' }],
          upstreamBuilds: [],
          merges: [],
        },
      },
      { type: 'node.item-prepared', payload: { id: 'rw', index: 0, base: 'parent' } },
      {
        type: 'node.item-conflicted',
        payload: { id: 'rw', index: 0, base: 'parent', files: ['a.ts'] },
      },
      {
        type: 'node.item-replayed',
        payload: { id: 'rw', index: 0, base: 'parent', head: 'resolved', dropped: false },
      },
    ].map((event, index) => ({
      ...event,
      build: 'head-paths',
      actor: { kind: 'kernel' },
      seq: index + 1,
      ts: '2026-11-16T00:00:00Z',
    })),
    optimizationLog(),
    panelOptimizationLog(),
    attemptMeasurementLog(),
    attemptLandingLog(),
    unmeasuredMergeLog(),
    ...SEEDS.map((seed) => randomBuildLog(seed, 150)),
    ...SEEDS.map((seed) => randomHarvestJournal(seed, 80)),
    ...SEEDS.map((seed) => randomSettingsJournal(seed, 30)),
    ...SEEDS.map((seed) => randomStatusJournal(seed, 60)),
    ...SEEDS.map((seed) => randomSandboxJournal(seed, 40)),
    ...SEEDS.map((seed) => randomSessionLog(seed, 50, seed % 2 === 0)),
  ]
}

const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex')
/** Each corpus as canonical JSON, the bytes its id and archive file address.
 * Every fold reads the parsed canonical form, so a corpus folds identically
 * whether it is current or restored from the archive. */
const corpusTexts = new Map(
  corpora().map((log) => {
    const text = canonicalJson(log)
    return [sha256(text).slice(0, 16), text] as const
  }),
)
const currentCids = [...corpusTexts.keys()].sort()
const logs = new Map([...corpusTexts].map(([cid, text]) => [cid, JSON.parse(text) as unknown[]]))
const analyses = new Map<string, { paths: string[]; digests: Record<string, string> }>()

/** One corpus's accumulator digest; head and base code fold through it alike. */
function foldCorpus(
  reducer: RegisteredReducer['reducer'],
  log: readonly unknown[],
  visit?: (acc: unknown) => void,
): string {
  return foldDigest(reducer, log, sha256, visit)
}

/** One pass over the current corpora: the union of accumulator fingerprints
 * after every chunk (so optional and variant fields are covered) and each
 * corpus's accumulator digest for the identity records. */
function analyze(
  name: string,
  reducer: RegisteredReducer['reducer'],
): { paths: string[]; digests: Record<string, string> } {
  const cached = analyses.get(name)
  if (cached !== undefined) return cached
  const paths = new Set<string>()
  collectPaths(reducer.initial(), '$', paths)
  const digests: Record<string, string> = {}
  for (const [cid, log] of logs)
    digests[cid] = foldCorpus(reducer, log, (acc) => collectPaths(acc, '$', paths))
  const result = { paths: [...paths].sort(), digests }
  analyses.set(name, result)
  return result
}

function unionFingerprint(name: string, reducer: RegisteredReducer['reducer']): string[] {
  return analyze(name, reducer).paths
}

const RECORDS = new URL('./__snapshots__/reducer-identity-records/', import.meta.url)
const ARCHIVE = new URL('./__snapshots__/reducer-identity-corpora/', import.meta.url)
/** The canonical JSON of `LEGACY_REDUCER_VERSIONS`. It never changes. */
const LEGACY_DIGEST = 'a1e5f19749ef9d59c12e764b9dde42cefe8b67b7ef7d75a394f41b7c9d73b4bb'

function readRecords(): IdentityRecord[] {
  if (!existsSync(RECORDS)) return []
  return readdirSync(RECORDS)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .flatMap((file) => parseRecordFile(file, readFileSync(new URL(file, RECORDS), 'utf8'), sha256))
}

function archivedCids(): Set<string> {
  if (!existsSync(ARCHIVE)) return new Set()
  return new Set(
    readdirSync(ARCHIVE)
      .filter((file) => file.endsWith('.json.gz'))
      .map((file) => file.slice(0, -'.json.gz'.length)),
  )
}

const archivedLogs = new Map<string, unknown[] | null>()
/** A retired corpus restored from the archive, or null when it is missing. */
function archivedLog(cid: string): unknown[] | null {
  if (archivedLogs.has(cid)) return archivedLogs.get(cid)!
  const file = new URL(`${cid}.json.gz`, ARCHIVE)
  let log: unknown[] | null = null
  if (existsSync(file)) {
    const text = new TextDecoder().decode(Bun.gunzipSync(readFileSync(file)))
    if (sha256(text).slice(0, 16) !== cid)
      throw new Error(`archived corpus ${cid} does not match its content`)
    log = JSON.parse(text)
  }
  archivedLogs.set(cid, log)
  return log
}

function transitiveParts(identity: string): string[] {
  const out = new Set<string>()
  const visit = (name: string) => {
    for (const part of PARTS.get(name) ?? []) {
      out.add(part)
      visit(part)
    }
  }
  visit(identity)
  return [...out].sort()
}

/** Every registered reducer as it folds today, over the current corpora and
 * every archived corpus its records at the current identity cover. */
function currentIdentities(records: readonly IdentityRecord[]): CurrentIdentity[] {
  return Object.entries(REDUCERS).map(([name, r]) => {
    const identity = r.reducer.identity!
    const revisions = revisionSet(identity)
    const key = recordKey(identity, revisions, sha256)
    const digests = { ...analyze(name, r.reducer).digests }
    for (const cid of evaluationCorpora({ name, key, records, currentCids })) {
      if (digests[cid] !== undefined) continue
      const log = archivedLog(cid)
      if (log !== null) digests[cid] = foldCorpus(r.reducer, log)
    }
    return { name, identity, parts: transitiveParts(identity), revisions, digests }
  })
}

const directory = temporaryDirectories(afterEach)
const LEDGER_PATH = 'packages/core/src/kernel/reducer-revisions.ts'
const RECORDS_PATH = 'packages/core/src/kernel/__snapshots__/reducer-identity-records'
const REGISTRY_PATH = 'packages/core/src/kernel/reducer-registry.ts'
/** The trees base code needs to load; corpora and records stay behind. */
const BASE_CODE_PATHS = [
  'packages/core/src',
  'packages/core/package.json',
  'package.json',
  'tsconfig.json',
]

/** Run git in `root`; throws naming the command when it fails. */
function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.join(' ')} exited ${result.exitCode}: ${result.stderr.toString().trim() || '(no output)'}`,
    )
  return result.stdout.toString()
}

function gitHas(root: string, object: string): boolean {
  return (
    Bun.spawnSync(['git', 'cat-file', '-e', object], {
      cwd: root,
      stdout: 'ignore',
      stderr: 'ignore',
    }).exitCode === 0
  )
}

function repoRoot(): string {
  return git(import.meta.dir, ['rev-parse', '--show-toplevel']).trim()
}

/** The base's ledger keys, or null when the base predates the ledger. Fails
 * closed when the base itself does not resolve. */
function readBaseLedger(root: string, base: string): Set<string> | null {
  git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
  if (!gitHas(root, `${base}:${LEDGER_PATH}`)) return null
  return parseLedgerSource(git(root, ['show', `${base}:${LEDGER_PATH}`]))
}

/** Every identity record the base holds. */
function readBaseRecords(root: string, base: string): IdentityRecord[] {
  if (!gitHas(root, `${base}:${RECORDS_PATH}`)) return []
  return git(root, ['ls-tree', '--name-only', `${base}:${RECORDS_PATH}`])
    .split('\n')
    .filter((file) => file.endsWith('.json'))
    .sort()
    .flatMap((file) =>
      parseRecordFile(file, git(root, ['show', `${base}:${RECORDS_PATH}/${file}`]), sha256),
    )
}

/** Fold `logs` through the base's own reducer code for each named reducer.
 * The base's code tree is extracted into a temporary directory that resolves
 * packages through this checkout's `node_modules`, imported in-process, and
 * removed. A name the base does not register, or registers under another
 * identity, is new at the head and gets no entry. */
async function foldAtBase(input: {
  root: string
  base: string
  names: ReadonlyMap<string, string>
  logs: ReadonlyMap<string, readonly unknown[]>
  /** Receives the extraction directory, so a test can prove its removal. */
  onExtract?: (dir: string) => void
}): Promise<Map<string, Record<string, string>>> {
  const dir = await mkdtemp(join(tmpdir(), 'ab-identity-base-'))
  input.onExtract?.(dir)
  try {
    const paths = BASE_CODE_PATHS.filter((path) => gitHas(input.root, `${input.base}:${path}`))
    const archive = Bun.spawnSync(['git', 'archive', '--format=tar', input.base, '--', ...paths], {
      cwd: input.root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (archive.exitCode !== 0)
      throw new Error(
        `git archive ${input.base} exited ${archive.exitCode}: ${archive.stderr.toString().trim()}`,
      )
    const extract = Bun.spawnSync(['tar', '-x', '-C', dir], {
      stdin: archive.stdout,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (extract.exitCode !== 0)
      throw new Error(`extracting ${input.base} failed: ${extract.stderr.toString().trim()}`)
    const checkout = repoRoot()
    for (const modules of ['node_modules', 'packages/core/node_modules']) {
      const target = join(dir, modules)
      if (existsSync(join(checkout, modules)) && !existsSync(target)) {
        mkdirSync(dirname(target), { recursive: true })
        symlinkSync(join(checkout, modules), target)
      }
    }
    let registry: { REDUCERS?: Record<string, { reducer: RegisteredReducer['reducer'] }> }
    try {
      registry = await import(join(dir, REGISTRY_PATH))
    } catch (error) {
      throw new Error(
        `importing the reducer registry at verify base ${input.base} failed: ${(error as Error).message}`,
      )
    }
    const out = new Map<string, Record<string, string>>()
    for (const [name, identity] of input.names) {
      const reducer = registry.REDUCERS?.[name]?.reducer
      if (reducer?.identity !== identity) continue
      out.set(
        name,
        Object.fromEntries([...input.logs].map(([cid, log]) => [cid, foldCorpus(reducer, log)])),
      )
    }
    return out
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Each unrevised reducer's digests at the base: from the base's records at the
 * head's record key when they share a corpus with the head, otherwise from
 * folding the current corpora through the base's code. */
async function baseDigestsFor(input: {
  root: string
  base: string
  targets: readonly CurrentIdentity[]
}): Promise<Map<string, Readonly<Record<string, string>>>> {
  const records = readBaseRecords(input.root, input.base)
  const out = new Map<string, Readonly<Record<string, string>>>()
  const unrecorded = new Map<string, string>()
  for (const target of input.targets) {
    const key = recordKey(target.identity, target.revisions, sha256)
    const entries: Record<string, string> = {}
    for (const record of records)
      if (record.name === target.name && record.key === key)
        for (const [cid, digest] of Object.entries(record.entries))
          if (target.digests[cid] !== undefined) entries[cid] ??= digest
    if (Object.keys(entries).length) out.set(target.name, entries)
    else unrecorded.set(target.name, target.identity)
  }
  if (unrecorded.size) {
    const folded = await foldAtBase({ root: input.root, base: input.base, names: unrecorded, logs })
    for (const [name, digests] of folded) out.set(name, digests)
  }
  return out
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
  test('reducer identities derive from the frozen base and the revision ledger', () => {
    // A version is never edited: it counts ledger revisions over a frozen base
    // and adds its parts. Change a reducer's accumulator shape or fold with
    // bun tools/reducer-revision.ts <shape|fold> <identity> --reason "…".
    for (const [name, r] of Object.entries(REDUCERS)) {
      const identity = r.reducer.identity
      expect({ name, identity: typeof identity }).toEqual({ name, identity: 'string' })
      expect(Number.isSafeInteger(r.reducer.version)).toBe(true)
      expect(r.reducer.version).toBeGreaterThanOrEqual(1)
      expect(r.reducer.version).toBeLessThanOrEqual(2 ** 31 - 1)
      expect({ name, version: r.reducer.version }).toEqual({
        name,
        version: deriveReducerVersion({ identity: identity! }),
      })
    }
    const revisions = parseRevisions(REDUCER_REVISIONS)
    for (const revision of revisions) expect(IDENTIFIED).toContain(revision.identity)
    expect(new Set(revisions.map((revision) => revision.id)).size).toBe(revisions.length)
    for (const identity of Object.keys(LEGACY_REDUCER_VERSIONS))
      expect(IDENTIFIED).toContain(identity)
    expect(sha256(canonicalJson(LEGACY_REDUCER_VERSIONS))).toBe(LEGACY_DIGEST)
  })

  test("identity records cover every reducer's accumulator behaviour", () => {
    // Each record pins, per corpus, the accumulator digest of one reducer at
    // one revision set. A digest that changes under an unchanged identity is a
    // shape or fold change without a ledger revision. Record files and
    // archived corpora are immutable, content-addressed and only ever added,
    // so concurrent branches merge them cleanly; regenerate them, never edit
    // or delete them, with AB_UPDATE_REDUCER_SHAPES=1 bun test <this file>.
    let records = readRecords()
    if (process.env.AB_UPDATE_REDUCER_SHAPES === '1') {
      const plan = planRegeneration({
        current: currentIdentities(records),
        currentCids,
        records,
        archived: archivedCids(),
        hash: sha256,
      })
      expect(plan.refused).toEqual([])
      mkdirSync(RECORDS, { recursive: true })
      mkdirSync(ARCHIVE, { recursive: true })
      for (const cid of plan.archive)
        writeFileSync(new URL(`${cid}.json.gz`, ARCHIVE), Bun.gzipSync(corpusTexts.get(cid)!))
      if (plan.write) writeFileSync(new URL(plan.write.file, RECORDS), plan.write.content)
      records = readRecords()
    }
    const current = currentIdentities(records)
    const { violations, unregeneratedCombinations } = checkIdentityRecords({
      current,
      currentCids,
      records,
      hash: sha256,
    })
    // The accepted unregenerated-combination state is named on every run.
    for (const entry of unregeneratedCombinations)
      console.warn(formatUnregeneratedCombination(entry))
    expect(violations.map((violation) => violation.message)).toEqual([])
    // Accumulator digests are deterministic: a second, uncached fold agrees.
    const again = Object.fromEntries(
      Object.entries(REDUCERS).map(([name, r]) => [
        name,
        Object.fromEntries(currentCids.map((cid) => [cid, foldCorpus(r.reducer, logs.get(cid)!)])),
      ]),
    )
    expect(again).toEqual(
      Object.fromEntries(Object.keys(REDUCERS).map((name) => [name, analyses.get(name)!.digests])),
    )
  }, 120_000)

  test('identity changes relative to the verify base carry a revision', async () => {
    // Records cannot see a fold-only change made after two branches' revisions
    // combine and before the combined record is regenerated. Against the verify
    // base the kernel supplies, a reducer whose change adds no revision must
    // fold every shared corpus exactly as the base did.
    const base = process.env[VERIFY_BASE_ENV]?.trim()
    if (!base) {
      console.warn(
        formatBaseRelativeSkipped(
          `${VERIFY_BASE_ENV} is not set (outside a build or under an older runtime)`,
        ),
      )
      return
    }
    const root = repoRoot()
    const baseLedger = readBaseLedger(root, base)
    if (baseLedger === null) {
      console.warn(
        formatBaseRelativeSkipped(`the verify base ${base} predates the revision ledger`),
      )
      return
    }
    const targets = unrevisedSinceBase(currentIdentities(readRecords()), baseLedger)
    const baseDigests = await baseDigestsFor({ root, base, targets })
    const violations = checkAgainstBase({ current: targets, base, baseDigests })
    console.warn(
      `reducer identity: compared ${baseDigests.size} unrevised identities against the verify base ${base}`,
    )
    expect(violations.map((violation) => violation.message)).toEqual([])
  }, 120_000)

  test('base code folds through the same digest as head code', async () => {
    const root = await directory(join(tmpdir(), 'ab-identity-fixture-'))
    const toy = (step: number) => `export const REDUCERS = {
  toy: {
    reducer: {
      identity: 'toy',
      initial: () => ({ n: 0 }),
      advance: (acc, events) => ({ n: acc.n + events.length * ${step} }),
    },
  },
}
`
    const commit = (step: number) => {
      mkdirSync(join(root, dirname(REGISTRY_PATH)), { recursive: true })
      writeFileSync(join(root, REGISTRY_PATH), toy(step))
      git(root, ['add', '-A'])
      git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', `step ${step}`])
      return git(root, ['rev-parse', 'HEAD']).trim()
    }
    git(root, ['init', '-q'])
    const first = commit(1)
    const second = commit(2)
    const fixtureLogs = new Map([['corpus', Array.from({ length: 30 }, (_, seq) => ({ seq }))]])
    const extracted: string[] = []
    const fold = (base: string) =>
      foldAtBase({
        root,
        base,
        names: new Map([
          ['toy', 'toy'],
          ['other', 'other'],
        ]),
        logs: fixtureLogs,
        onExtract: (dir) => extracted.push(dir),
      })
    const atFirst = await fold(first)
    const reference = {
      initial: () => ({ n: 0 }),
      advance: (acc: { n: number }, events: readonly unknown[]) => ({ n: acc.n + events.length }),
    }
    expect([...atFirst.keys()]).toEqual(['toy'])
    expect(atFirst.get('toy')).toEqual({
      corpus: foldDigest(reference, fixtureLogs.get('corpus')!, sha256),
    })
    const atSecond = await fold(second)
    expect(atSecond.get('toy')!.corpus).not.toBe(atFirst.get('toy')!.corpus)
    expect(extracted).toHaveLength(2)
    for (const dir of extracted) expect(existsSync(dir)).toBe(false)
  })

  test('accumulator shapes', () => {
    // If this snapshot changed, the accumulator shape changed: add a revision
    // with bun tools/reducer-revision.ts shape <identity> --reason "…", then
    // regenerate, rather than only re-snapshotting. Cached accumulators are
    // valid per version.
    const shapes = Object.fromEntries(
      Object.entries(REDUCERS).map(([name, r]) => [name, unionFingerprint(name, r.reducer)]),
    )
    // Direct JSON equality preserves the complete shape guard. Bun's external
    // snapshot assertion fails after module mocks load, even for identical shapes.
    // Regenerate using these same deterministic corpora after adding the
    // revisions: AB_UPDATE_REDUCER_SHAPES=1 bun test <this file>.
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
