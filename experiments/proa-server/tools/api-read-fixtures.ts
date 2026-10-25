/** Exact API read oracle. Production Rust never executes TypeScript queries. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { MemoryBuildStore } from '../../../packages/core/src/store/memory'
import type {
  ArtifactMeta,
  BuildRecord,
  RepositoryArtifactMeta,
  RepositoryRecord,
} from '../../../packages/core/src/store/types'
import { validateEventWrite, type AbEvent } from '../../../packages/core/src/events/catalog'
import {
  validateRepositoryEventWrite,
  type RepositoryEvent,
} from '../../../packages/core/src/events/repository'
import { configSchema } from '../../../packages/core/src/config/schema'
import { effectiveBuildConfigContent } from '../../../packages/core/src/processes/build-execution-state'
import {
  getOperatorBuild,
  getOperatorDashboard,
  getRepositoryStatus,
  getHarvestStatus,
  OperatorQueryError,
} from '../../../packages/core/src/operator/query'
import { operatorClock } from './operator-fixtures'
import { sources } from './fixture-core'

export const apiReadRepo = 'api-read/repository'
export const apiReadSlug = 'api-read-build'
export const apiReadForeignRepo = 'api-read/foreign'
const fixturePath = resolve(import.meta.dir, '../fixtures/api-read-corpus.json')
type Seed =
  | 'absent'
  | 'configured'
  | 'no-config'
  | 'missing-config'
  | 'malformed-config'
  | 'invalid-config'
  | 'running'
  | 'sessions'
  | 'verify-cycle'
  | 'done'
  | 'cleaning'
  | 'pinned'
  | 'bad-pin'
  | 'integration'
  | 'held'
  | 'expired'
  | 'stopped'
  | 'older-holder'
  | 'harvest-paused'
  | 'harvest-failed'
  | 'harvest-exhausted'
  | 'harvest-multi'
  | 'harvest-suspended'
  | 'foreign'
export interface ApiReadScenario {
  id: string
  seed: Seed
  path: string
}
export interface ApiReadArtifact {
  meta: ArtifactMeta | RepositoryArtifactMeta
  base64: string
}
export interface ApiReadSeed {
  builds: { record: BuildRecord; events: AbEvent[]; artifacts: ApiReadArtifact[] }[]
  repository: {
    record: RepositoryRecord | null
    events: RepositoryEvent[]
    artifacts: ApiReadArtifact[]
  }
}
export interface ApiReadFixture {
  scenario: ApiReadScenario
  seed: ApiReadSeed
  status: number
  headers: { 'content-type': string }
  body: unknown
}
export interface ApiReadCorpus {
  source: Record<string, string>
  now: string
  fixtures: ApiReadFixture[]
}
export function apiReadScenarios(): ApiReadScenario[] {
  const cases: ApiReadScenario[] = []
  for (const seed of [
    'configured',
    'no-config',
    'missing-config',
    'malformed-config',
    'invalid-config',
    'running',
    'sessions',
    'verify-cycle',
    'done',
    'cleaning',
    'pinned',
    'bad-pin',
    'integration',
    'foreign',
  ] as Seed[])
    cases.push({ id: `detail-${seed}`, seed, path: `builds/${apiReadSlug}` })
  cases.push({ id: 'detail-missing', seed: 'configured', path: 'builds/absent-build' })
  for (const seed of [
    'absent',
    'configured',
    'no-config',
    'missing-config',
    'malformed-config',
    'invalid-config',
    'running',
    'done',
    'cleaning',
    'pinned',
    'bad-pin',
    'integration',
    'harvest-multi',
  ] as Seed[])
    cases.push({ id: `dashboard-${seed}`, seed, path: 'dashboard' })
  for (const seed of [
    'absent',
    'configured',
    'held',
    'expired',
    'stopped',
    'older-holder',
    'harvest-multi',
  ] as Seed[])
    cases.push({ id: `status-${seed}`, seed, path: 'status' })
  for (const seed of [
    'absent',
    'configured',
    'harvest-paused',
    'harvest-failed',
    'harvest-exhausted',
    'harvest-multi',
    'harvest-suspended',
  ] as Seed[])
    cases.push({ id: `harvest-${seed}`, seed, path: 'harvest/status' })
  return cases
}
function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
export async function replayApiReadScenario(scenario: ApiReadScenario): Promise<ApiReadFixture> {
  let clockAt = Date.parse(operatorClock)
  const now = new Date(operatorClock),
    clock = () => new Date(clockAt),
    store = new MemoryBuildStore({ clock })
  const config = configSchema.parse({
    commands: { unit: 'bun test', smoke: 'true' },
    capacity: 2,
    tickets: { source: 'hosted', teamKey: 'ENG', readyState: 'ready' },
    verify: {
      steps: ['unit', 'smoke'],
      unit: { kind: 'check', command: 'unit' },
      smoke: { kind: 'check', command: 'smoke' },
    },
  })
  const runtime = {
    version: '1.0.0',
    commit: 'a'.repeat(40),
    source: { kind: 'source', location: '/test/immutable-runtime' },
  }
  const append = (
    slug: string,
    type: string,
    payload: unknown,
    actor: unknown = { kind: 'kernel' },
  ) => store.append(slug, validateEventWrite({ actor, type, payload }))
  const repository = (type: string, payload: unknown, actor: unknown = { kind: 'dispatcher' }) =>
    store.appendRepo(apiReadRepo, validateRepositoryEventWrite({ actor, type, payload }))
  const seed = scenario.seed
  if (seed !== 'absent') await store.ensureRepo(apiReadRepo)
  if (!['absent', 'no-config'].includes(seed)) {
    if (seed !== 'missing-config')
      await store.putRepoArtifact(apiReadRepo, {
        kind: 'dispatcher-effective-config',
        content:
          seed === 'malformed-config'
            ? '{'
            : seed === 'invalid-config'
              ? '{}'
              : effectiveBuildConfigContent(config),
      })
    const start = await repository('dispatcher.run-started', {
      run: 'read-run',
      pid: 1234,
      host: 'test-host',
      effectiveConfig: { kind: 'dispatcher-effective-config', rev: 0 },
      roleWarnings: [],
    })
    await repository('dispatcher.runtime-recorded', {
      run: 'read-run',
      startedSeq: start.seq,
      runtime,
    })
    await repository('dispatcher.tick-completed', {
      run: 'read-run',
      queued: 3,
      counters: {
        merged: 0,
        closed: 0,
        conflicted: 0,
        abandoned: 0,
        discarded: 0,
        janitorFailed: 0,
        recovered: 0,
        dispatchFailed: 0,
        resumed: 0,
        swept: 0,
        dispatched: 0,
        authored: 0,
        bounced: 0,
        claimRaces: 0,
        invalidTickets: 0,
        dependencyBlocked: 0,
        harvestStarted: 0,
        harvestResumed: 0,
        harvestCompleted: 0,
        harvestEscalated: 0,
        harvestFailed: 0,
        forgeRequests: {
          total: 7,
          unattributed: 1,
          builds: [{ build: apiReadSlug, requests: 6 }],
          complete: true,
          restPrimary: 6,
          restNotModified: 1,
          graphql: 0,
        },
      },
      janitorDiagnostics: [],
      ticketDiagnostics: [],
      dependencyDiagnostics: [],
    })
  }
  const hasBuild = ![
    'absent',
    'configured',
    'held',
    'expired',
    'stopped',
    'older-holder',
    'harvest-paused',
    'harvest-failed',
    'harvest-exhausted',
    'harvest-multi',
    'harvest-suspended',
  ].includes(seed)
  if (hasBuild) {
    const repo = seed === 'foreign' ? apiReadForeignRepo : apiReadRepo
    const ticket = { source: 'hosted', id: 'ENG-1', title: 'API read seed' }
    await store.createBuild({
      slug: apiReadSlug,
      repo,
      ticket,
      branch: `ab/${apiReadSlug}`,
      created: {
        actor: { kind: 'dispatcher' },
        type: 'build.created',
        payload: {
          repo,
          ticket,
          baseBranch: 'main',
          ...(seed === 'integration' ? { kind: 'node' as const } : {}),
        },
      },
    })
    if (
      !['no-config', 'missing-config', 'malformed-config', 'invalid-config', 'foreign'].includes(
        seed,
      )
    ) {
      await append(apiReadSlug, 'runner.attached', {
        instance: 'read-instance',
        host: 'runner-host',
        resumedFromSeq: 1,
      })
      await append(apiReadSlug, 'runner.runtime-recorded', {
        instance: 'read-instance',
        attachedSeq: 2,
        runtime,
      })
      await append(apiReadSlug, 'workspace.provisioned', {
        provider: 'test',
        ref: 'workspace',
        branch: `ab/${apiReadSlug}`,
        base: { source: 'remote', sha: 'b'.repeat(40) },
      })
      await append(
        apiReadSlug,
        'spec.imported',
        { artifact: { kind: 'spec', rev: 0 }, ticket },
        { kind: 'dispatcher' },
      )
      await append(apiReadSlug, 'plan.started', { round: 1 })
    }
    if (seed === 'sessions') {
      await append(apiReadSlug, 'session.started', {
        session: 'read-session',
        role: 'plan',
        runner: 'test',
        model: 'fixture-model',
        phase: 'plan',
        round: 1,
        stream: 'stream-read',
        budgetMs: 60000,
      })
      await append(
        apiReadSlug,
        'observation.recorded',
        {
          id: 'read-observation',
          kind: 'followup',
          summary: 'Exact observation bytes',
          files: ['src/example.ts'],
          refs: ['fixture'],
        },
        { kind: 'agent', role: 'plan', session: 'read-session' },
      )
      await append(
        apiReadSlug,
        'execution.started',
        {
          provider: 'test',
          workspaceRef: 'workspace',
          instance: 'read-instance',
          environmentId: 'test-environment',
          commandId: 'test-command',
        },
        { kind: 'dispatcher' },
      )
    }
    if (seed === 'verify-cycle') {
      await append(apiReadSlug, 'verify.started', { step: 'unit', attempt: 2 })
      await append(apiReadSlug, 'verify.completed', { step: 'unit', attempt: 2, outcome: 'fail' })
      await append(
        apiReadSlug,
        'code-review.verdict',
        { round: 1, verdict: 'approve', findings: [], artifact: { kind: 'code-review', rev: 0 } },
        { kind: 'agent', role: 'code-review', session: 'review-session' },
      )
      await append(apiReadSlug, 'verify.started', { step: 'smoke', attempt: 3 })
      await append(apiReadSlug, 'verify.completed', { step: 'smoke', attempt: 3, outcome: 'pass' })
    }
    if (seed === 'done')
      await append(apiReadSlug, 'build.completed', { outcome: 'merged' }, { kind: 'dispatcher' })
    if (seed === 'cleaning') await append(apiReadSlug, 'build.aborted', {})
    if (seed === 'pinned' || seed === 'bad-pin')
      await store.putArtifact(apiReadSlug, {
        kind: 'build-runner-effective-config',
        content:
          seed === 'bad-pin'
            ? '{'
            : effectiveBuildConfigContent(
                configSchema.parse({
                  commands: { pinned: 'true' },
                  tickets: { source: 'hosted', teamKey: 'ENG', readyState: 'ready' },
                  verify: { steps: ['pinned'], pinned: { kind: 'check', command: 'pinned' } },
                }),
              ),
        metadata: { revision: 7, pipelineSource: { ref: 'branch-head', commit: 'c'.repeat(40) } },
      })
    if (seed === 'integration') {
      await append(
        apiReadSlug,
        'node.opening',
        { branch: `ab/${apiReadSlug}`, parent: 'main', sha: 'node-opening' },
        { kind: 'dispatcher' },
      )
      await append(apiReadSlug, 'node.opened', { sha: 'node-opening' }, { kind: 'dispatcher' })
      const child = `${apiReadSlug}-child`,
        childTicket = { source: 'hosted', id: 'ENG-2', title: 'Child under integration' }
      await store.createBuild({
        slug: child,
        repo: apiReadRepo,
        ticket: childTicket,
        branch: `ab/${child}`,
        created: {
          actor: { kind: 'dispatcher' },
          type: 'build.created',
          payload: {
            repo: apiReadRepo,
            ticket: childTicket,
            baseBranch: `ab/${apiReadSlug}`,
            target: { ticket, build: apiReadSlug },
          },
        },
      })
      await append(child, 'runner.attached', { instance: 'child-instance', host: 'runner-host' })
    }
  }
  if (['held', 'expired', 'stopped', 'older-holder'].includes(seed)) {
    if (seed === 'expired') clockAt -= 60000
    await store.claimRepoLease(apiReadRepo, 'read-run', 30000)
    await store.heartbeatRepo(apiReadRepo, 'read-run')
    clockAt = now.getTime()
    if (seed === 'stopped')
      await repository('dispatcher.run-stopped', {
        run: 'read-run',
        outcome: 'normal',
        exitCode: 0,
      })
    if (seed === 'older-holder')
      await repository('dispatcher.run-started', {
        run: 'newer-run',
        pid: 2345,
        host: 'new-host',
        effectiveConfig: { kind: 'dispatcher-effective-config', rev: 0 },
        roleWarnings: [],
      })
  }
  if (seed.startsWith('harvest-')) {
    if (seed === 'harvest-paused') {
      await repository(
        'harvest.pause-requested',
        {},
        { kind: 'human', user: 'operator@example.com' },
      )
      await repository('harvest.paused', {}, { kind: 'kernel' })
    } else {
      const runs = seed === 'harvest-multi' ? ['first-run', 'second-run'] : ['first-run']
      for (const run of runs) {
        await repository('harvest.started', {
          run,
          observations: [{ build: apiReadSlug, seq: run === 'first-run' ? 7 : 8 }],
          scan: { kind: 'harvest-scan', rev: 0 },
          trigger: 'count',
        })
        if (seed !== 'harvest-suspended' && run === 'first-run')
          await repository(
            'harvest.failed',
            {
              run,
              step: 'synthesize',
              round: 1,
              attempt: 1,
              error: 'provider unavailable',
              willRetry: false,
            },
            { kind: 'kernel' },
          )
        if (seed === 'harvest-suspended') {
          await repository(
            'harvest.session.started',
            {
              run,
              session: 'harvest-session',
              role: 'harvest',
              runner: 'test',
              step: 'synthesize',
              round: 1,
            },
            { kind: 'kernel' },
          )
          await repository(
            'harvest.session.suspended',
            {
              run,
              session: 'harvest-session',
              cause: 'shutdown',
              transcript: { kind: 'harvest-transcript', rev: 0 },
            },
            { kind: 'kernel' },
          )
        }
        if (seed === 'harvest-exhausted') {
          for (const attempt of [1, 2]) {
            await repository(
              'harvest.recovery-requested',
              { run, attempt, limit: 2 },
              { kind: 'kernel' },
            )
            await repository('harvest.resumed', {}, { kind: 'kernel' })
            await repository(
              'harvest.failed',
              {
                run,
                step: 'synthesize',
                round: 1,
                attempt: attempt + 1,
                error: 'provider unavailable',
                willRetry: false,
              },
              { kind: 'kernel' },
            )
          }
        }
        if (seed === 'harvest-exhausted')
          await repository(
            'harvest.recovery-exhausted',
            {
              run,
              step: 'synthesize',
              round: 1,
              error: 'provider unavailable',
              attempts: 2,
              limit: 2,
              releasedObservations: [{ build: apiReadSlug, seq: 7 }],
              committedDispositions: [],
              pendingProposals: [],
            },
            { kind: 'kernel' },
          )
      }
    }
  }
  const builds = []
  for (const record of await store.listBuilds()) {
    const artifacts = []
    for (const meta of await store.listArtifacts(record.slug)) {
      const artifact = await store.getArtifact(record.slug, meta.kind, meta.revision)
      artifacts.push({ meta, base64: Buffer.from(artifact!.content).toString('base64') })
    }
    builds.push({ record, events: await store.getEvents(record.slug), artifacts })
  }
  const repoArtifacts = []
  if (await store.getRepo(apiReadRepo))
    for (const meta of await store.listRepoArtifacts(apiReadRepo)) {
      const artifact = await store.getRepoArtifact(apiReadRepo, meta.kind, meta.revision)
      repoArtifacts.push({ meta, base64: Buffer.from(artifact!.content).toString('base64') })
    }
  const snapshot: ApiReadSeed = {
    builds,
    repository: {
      record: await store.getRepo(apiReadRepo),
      events: (await store.getRepo(apiReadRepo)) ? await store.getRepoEvents(apiReadRepo) : [],
      artifacts: repoArtifacts,
    },
  }
  let status = 200,
    body: unknown
  try {
    if (scenario.path === 'dashboard')
      body = await getOperatorDashboard({ store, repo: apiReadRepo, clock: () => now })
    else if (scenario.path === 'status') body = await getRepositoryStatus(store, apiReadRepo, now)
    else if (scenario.path === 'harvest/status') body = await getHarvestStatus(store, apiReadRepo)
    else
      body = await getOperatorBuild({
        store,
        repo: apiReadRepo,
        slug: scenario.path.slice('builds/'.length),
        now,
      })
  } catch (error) {
    if (error instanceof OperatorQueryError) {
      status = error.code === 'not-found' ? 404 : 409
      body = {
        kind: error.code === 'not-found' ? 'not-found' : 'conflict',
        error: error.message,
        code: error.code,
      }
    } else {
      status = 500
      body = { kind: 'internal', error: 'operator API is unavailable' }
    }
  }
  return json({
    scenario,
    seed: snapshot,
    status,
    headers: { 'content-type': 'application/json;charset=utf-8' },
    body,
  })
}
export async function generateApiReadCorpus(): Promise<ApiReadCorpus> {
  return {
    source: {
      ...sources(),
      'experiments/proa-server/tools/api-read-fixtures.ts': createHash('sha256')
        .update(readFileSync(import.meta.filename))
        .digest('hex'),
    },
    now: operatorClock,
    fixtures: await Promise.all(apiReadScenarios().map(replayApiReadScenario)),
  }
}
export async function checkApiReadCorpus(): Promise<ApiReadCorpus> {
  const current = await generateApiReadCorpus(),
    saved = (await Bun.file(fixturePath).json()) as ApiReadCorpus
  if (!isDeepStrictEqual(saved, current))
    throw new Error('API read corpus drifted; regenerate api-read-fixtures.ts --write')
  return saved
}
if (import.meta.main) {
  if (process.argv.includes('--write'))
    await Bun.write(fixturePath, `${JSON.stringify(await generateApiReadCorpus(), null, 2)}\n`)
  else await checkApiReadCorpus()
}
