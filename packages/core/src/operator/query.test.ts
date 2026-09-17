import { describe, expect, test } from 'bun:test'
import { composeBuildConfig } from '../config/live'
import { parseConfig } from '../config/load'
import type { Config } from '../config/schema'
import { agentActor, DISPATCHER, humanActor, KERNEL } from '../events/envelope'
import { detail as projectDetail } from '../cli/status'
import { reduceBuild } from '../kernel/reducer'
import {
  BUILD_EFFECTIVE_CONFIG_ARTIFACT,
  effectiveBuildConfigContent,
  parseBuildConfigMetadata,
  parseEffectiveBuildConfig,
} from '../processes/build-execution-state'
import { scanUnclaimedObservations } from '../processes/harvest'
import { MemoryBuildStore } from '../store/memory'
import type { Artifact, BuildStore, Clock } from '../store/types'
import {
  buildDashboardFromProjected,
  projectBuild,
  type DashboardBuild,
} from '../cli/dashboard/model'
import type { PipelineSourceMeta } from '../config/pipeline-source'
import {
  effectiveConfig,
  getHarvestStatus,
  getOperatorBuild,
  getOperatorDashboard,
  getRepositoryStatus,
  listOperatorBuilds,
  OperatorQueryError,
  type OperatorDashboardSnapshot,
} from './query'

const REPO = '/repo'
let now = new Date('2026-09-02T00:00:00.000Z')
const clock = () => now
const counters = {
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
}

function config(capacity: number, harvestThreshold: number) {
  return parseConfig(`
capacity = ${capacity}
[tickets]
source = "file"
readyState = "ready"
[policy]
harvestThreshold = ${harvestThreshold}
[verify]
steps = []
[finalize]
steps = []
`)
}

function configContent(value: ReturnType<typeof config>): string {
  const { verify, finalize, ...root } = value
  return JSON.stringify({
    ...root,
    verify: { steps: verify.steps, ...verify.stepConfigs },
    finalize: { steps: finalize.steps, ...finalize.stepConfigs },
  })
}

async function publishRun(
  store: MemoryBuildStore,
  run: string,
  value: ReturnType<typeof config>,
  roleWarnings: string[] = [],
): Promise<void> {
  await store.ensureRepo(REPO)
  const artifact = await store.putRepoArtifact(REPO, {
    kind: 'dispatcher-effective-config',
    content: configContent(value),
  })
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'dispatcher.run-started',
    payload: {
      run,
      pid: run === 'old' ? 100 : 200,
      effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
      roleWarnings,
    },
  })
}

async function createBuild(
  store: MemoryBuildStore,
  slug: string,
  state: 'queued' | 'active' | 'done',
) {
  await store.createBuild({ slug, repo: REPO })
  if (state === 'queued') return
  await store.append(slug, {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: `${slug}-runner`, host: 'host' },
  })
  if (state === 'done') {
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
  }
}

describe('operator query wiring', () => {
  test('build scopes match CLI semantics and sort by updatedAt descending', async () => {
    const store = new MemoryBuildStore({ clock })
    now = new Date('2026-09-02T00:00:01.000Z')
    await createBuild(store, 'queued', 'queued')
    now = new Date('2026-09-02T00:00:02.000Z')
    await createBuild(store, 'active', 'active')
    now = new Date('2026-09-02T00:00:03.000Z')
    await createBuild(store, 'done', 'done')

    expect(
      (await listOperatorBuilds({ store, repo: REPO, scope: 'active', now })).map((b) => b.slug),
    ).toEqual(['active'])
    expect(
      (await listOperatorBuilds({ store, repo: REPO, scope: 'queued', now })).map((b) => b.slug),
    ).toEqual(['active', 'queued'])
    expect(
      (await listOperatorBuilds({ store, repo: REPO, scope: 'all', now })).map((b) => b.slug),
    ).toEqual(['done', 'active', 'queued'])
  })

  test('empty repository status and Harvest status are read-only defaults', async () => {
    const store = new MemoryBuildStore({ clock })
    expect(await getRepositoryStatus(store, REPO)).toEqual({
      repo: REPO,
      intake: true,
      paused: false,
      defaultAutoMerge: false,
      sandboxes: [],
    })
    expect(await getHarvestStatus(store, REPO)).toMatchObject({
      repo: REPO,
      status: 'idle',
      paused: false,
      runs: [],
      observations: 0,
    })
    expect(await store.getRepo(REPO)).toBeNull()
  })

  test('Harvest status projects gate and concrete run state', async () => {
    const store = new MemoryBuildStore({ clock })
    await store.ensureRepo(REPO)
    await store.appendRepo(REPO, {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'harvest-1',
        observations: [{ build: 'source', seq: 3 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    await store.appendRepo(REPO, {
      actor: humanActor('operator'),
      type: 'harvest.pause-requested',
      payload: {},
    })
    await store.appendRepo(REPO, { actor: KERNEL, type: 'harvest.paused', payload: {} })
    expect(await getHarvestStatus(store, REPO)).toMatchObject({
      repo: REPO,
      run: 'harvest-1',
      status: 'paused',
      runStatus: 'running',
      paused: true,
      observations: 1,
      runs: [{ run: 'harvest-1', status: 'running' }],
    })
  })

  test('dashboard selects the newest run config and mirrors rows, timing, Harvest, settings, and headers', async () => {
    const store = new MemoryBuildStore({ clock })
    await publishRun(store, 'old', config(1, 2), ['old warning'])
    await publishRun(store, 'new', config(7, 11), ['role warning'])
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.tick-completed',
      payload: {
        run: 'new',
        queued: 4,
        counters,
        janitorDiagnostics: [],
        ticketDiagnostics: [],
        creationDiagnostics: [],
        dependencyDiagnostics: [],
      },
    })
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.upgrade-available',
      payload: { run: 'new', version: '9.9.9' },
    })
    await store.appendRepo(REPO, {
      actor: humanActor('operator'),
      type: 'dispatcher.operator-reported',
      payload: { run: 'new', level: 'warning', message: 'operator warning' },
    })
    for (const [type, enabled] of [
      ['dispatcher.intake-set', false],
      ['dispatcher.pause-set', true],
      ['dispatcher.auto-merge-default-set', true],
    ] as const) {
      await store.appendRepo(REPO, { actor: humanActor('operator'), type, payload: { enabled } })
    }
    await store.appendRepo(REPO, {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'harvest-1',
        observations: [{ build: 'claimed-elsewhere', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    await store.appendRepo(REPO, {
      actor: humanActor('operator'),
      type: 'harvest.pause-requested',
      payload: {},
    })
    await store.appendRepo(REPO, { actor: KERNEL, type: 'harvest.paused', payload: {} })

    await createBuild(store, 'active', 'active')
    now = new Date('2026-09-02T00:00:10.000Z')
    await store.append('active', { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
    await store.append('active', {
      actor: agentActor('implement', 'observation-session'),
      type: 'observation.recorded',
      payload: { id: 'obs-1', kind: 'followup', summary: 'one unclaimed observation' },
    })
    await createBuild(store, 'queued', 'queued')
    await createBuild(store, 'done', 'done')

    now = new Date('2026-09-02T00:00:20.000Z')
    const snapshot = await getOperatorDashboard({ store, repo: REPO, clock })
    expect(snapshot.generatedAt).toBe(now.toISOString())
    expect(snapshot.model).toMatchObject({
      repo: REPO,
      queued: 4,
      active: { current: 2, limit: 7 },
      observations: { current: 1, limit: 11 },
      drained: true,
      repositoryPaused: true,
      defaultAutoMerge: true,
      harvestPaused: true,
      availableUpgrade: '9.9.9',
      warningLines: ['role warning', 'operator warning'],
      harvest: { run: 'harvest-1', status: 'paused', observations: 1 },
    })
    expect(snapshot.settingsHeader).toEqual({
      intake: false,
      repositoryPaused: true,
      defaultAutoMerge: true,
      harvestPaused: true,
    })
    expect(snapshot.model.builds.map((build) => build.slug)).toEqual(['active', 'queued'])
    const events = await store.getEvents('active')
    const expected = projectBuild(
      (await store.getBuild('active'))!,
      reduceBuild(events),
      config(7, 11),
      events,
    )
    expect(expected).not.toBeNull()
    expect(snapshot.model.builds[0]).toEqual(expected!)
    expect(snapshot.model.builds[0]?.steps[0]?.timing).toEqual({
      accumulatedMs: 0,
      runningSince: Date.parse('2026-09-02T00:00:10.000Z'),
    })
  })

  test('a pinned build projects its own pipeline and carries pipeline-source metadata', async () => {
    // AUT-366 on the hosted surface: the live base-branch snapshot has an
    // empty verify universe, but the build's artifact pins a pipeline with an
    // always-on step. The row's steps must come from the pinned pipeline, and
    // the row must say which autobuild.toml it runs under (SPEC §16.1).
    const store = new MemoryBuildStore({ clock })
    await publishRun(store, 'new', config(7, 11))
    await createBuild(store, 'active', 'active')
    const pinnedConfig = parseConfig(`
[tickets]
source = "file"
readyState = "ready"

[commands]
postgres = "pg-ready"

[verify]
steps = ["postgres"]

[verify.postgres]
kind = "check"
command = "postgres"
`)
    await store.putArtifact('active', {
      kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
      content: effectiveBuildConfigContent(pinnedConfig),
      metadata: {
        revision: 3,
        run: 'new',
        pipelineSource: { ref: 'branch-head', commit: 'a'.repeat(40) },
      },
    })

    now = new Date('2026-09-02T00:00:20.000Z')
    const snapshot = await getOperatorDashboard({ store, repo: REPO, clock })
    const row = snapshot.model.builds[0]!
    expect(row.steps.map((step) => step.label)).toContain('verify:postgres')
    expect(row.effectiveConfigRev).toBe(3)
    expect(row.pipelineSource).toEqual({ ref: 'branch-head', commit: 'a'.repeat(40) })

    // AUT-496: one getOperatorBuild call on a row-rendering build reads the
    // pinned artifact exactly once.
    const counting = countingStore(store)
    const view = await getOperatorBuild({ store: counting.store, repo: REPO, slug: 'active', now })
    expect(counting.counts.get('getArtifact')).toBe(1)
    expect(counting.artifactSlugs).toEqual(['active'])
    expect(view.dashboardRow!.steps.map((step) => step.label)).toContain('verify:postgres')
    expect(view.dashboardRow!.effectiveConfigRev).toBe(3)
    expect(view.dashboardRow!.pipelineSource).toEqual({
      ref: 'branch-head',
      commit: 'a'.repeat(40),
    })
  })

  test('a malformed pinned artifact degrades to the live config but keeps its metadata', async () => {
    const store = new MemoryBuildStore({ clock })
    await publishRun(store, 'new', config(7, 11))
    await createBuild(store, 'active', 'active')
    await store.putArtifact('active', {
      kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
      content: '{not json',
      metadata: {
        revision: 2,
        run: 'new',
        pipelineSource: { ref: 'base', commit: 'b'.repeat(40) },
      },
    })

    now = new Date('2026-09-02T00:00:20.000Z')
    const snapshot = await getOperatorDashboard({ store, repo: REPO, clock })
    const row = snapshot.model.builds[0]!
    // The unparsable pipeline cannot be projected; the live snapshot's (empty)
    // verify universe is the pre-pin degradation, but the metadata still says
    // which source the build is pinned to.
    expect(row.steps.map((step) => step.label)).not.toContain('verify:postgres')
    expect(row.effectiveConfigRev).toBe(2)
    expect(row.pipelineSource).toEqual({ ref: 'base', commit: 'b'.repeat(40) })
  })

  // ── AUT-486 characterization fixtures ────────────────────────────────────
  //
  // `legacySnapshot` below is a verbatim copy of today's `getOperatorDashboard`
  // body (and of its module-private `readPinnedConfig`/`decorateWithPinnedMeta`
  // helpers): the legacy algorithm whose output the snapshot rewrite must not
  // change. It reads the same exported seams the real query reads
  // (`effectiveConfig`, `scanUnclaimedObservations`, `projectBuild`,
  // `buildDashboardFromProjected`) so the differential test survives the
  // refactor unchanged.
  // ── AUT-486 counting fixtures ───────────────────────────────────────
  //
  // A Proxy that counts every invoked method of the memory store. Each method
  // is applied bound to the raw instance, so internal adapter calls are not
  // double-counted and the counts name exactly the store calls one snapshot
  // makes (ACs 2–5).
  const MUTATING_STORE_METHODS = [
    'ensureRepo',
    'createBuild',
    'append',
    'appendIfCurrent',
    'appendWithArtifacts',
    'putArtifact',
    'claimLease',
    'heartbeat',
    'releaseLease',
    'appendRepo',
    'appendRepoWithArtifacts',
    'putRepoArtifact',
    'claimRepoLease',
    'heartbeatRepo',
    'releaseRepoLease',
    'createSession',
    'appendSessionEvent',
    'appendSessionWithArtifacts',
    'putSessionArtifact',
    'createStream',
    'appendStreamParts',
    'closeStream',
  ] as const

  function countingStore(store: MemoryBuildStore): {
    store: BuildStore
    counts: Map<string, number>
    eventSlugs: string[]
    artifactSlugs: string[]
  } {
    const counts = new Map<string, number>()
    const eventSlugs: string[] = []
    const artifactSlugs: string[] = []
    const target = store as unknown as Record<string, unknown>
    const proxy = new Proxy(target, {
      get(t, prop) {
        if (typeof prop === 'symbol') return Reflect.get(t, prop, t)
        const value = t[prop]
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          counts.set(prop, (counts.get(prop) ?? 0) + 1)
          if (prop === 'getEvents') eventSlugs.push(args[0] as string)
          if (prop === 'getArtifact') artifactSlugs.push(args[0] as string)
          return (value as (...a: unknown[]) => unknown).apply(t, args)
        }
      },
    })
    return { store: proxy as unknown as BuildStore, counts, eventSlugs, artifactSlugs }
  }

  interface PinnedProjection {
    config: Config
    revision?: number
    pipelineSource?: PipelineSourceMeta
  }

  async function legacyReadPinnedConfig(
    store: BuildStore,
    slug: string,
    live: Config,
  ): Promise<PinnedProjection> {
    let artifact: Artifact | null
    try {
      artifact = await store.getArtifact(slug, BUILD_EFFECTIVE_CONFIG_ARTIFACT)
    } catch {
      artifact = null
    }
    if (artifact === null) return { config: live }
    let config: Config
    try {
      config = composeBuildConfig(parseEffectiveBuildConfig(artifact), live)
    } catch {
      config = live
    }
    return { config, ...parseBuildConfigMetadata(artifact) }
  }

  function legacyDecorate(row: DashboardBuild, pinned: PinnedProjection): DashboardBuild {
    if (pinned.revision !== undefined) row.effectiveConfigRev = pinned.revision
    if (pinned.pipelineSource !== undefined) row.pipelineSource = pinned.pipelineSource
    return row
  }

  async function legacySnapshot(opts: {
    store: BuildStore
    repo: string
    clock: Clock
  }): Promise<OperatorDashboardSnapshot> {
    const { config, repositoryEvents, status } = await effectiveConfig(opts.store, opts.repo)
    const projected: DashboardBuild[] = []
    let activeCount = 0
    for (const record of await opts.store.listBuilds()) {
      if (record.repo !== opts.repo) continue
      const events = await opts.store.getEvents(record.slug)
      const state = reduceBuild(events)
      if (state.status !== 'done' && state.status !== 'aborted') activeCount += 1
      const pinned = await legacyReadPinnedConfig(opts.store, record.slug, config)
      const row = projectBuild(record, state, config, events, undefined, pinned.config)
      if (row !== null) projected.push(legacyDecorate(row, pinned))
    }
    const scan = await scanUnclaimedObservations(opts.store, opts.repo)
    const warningLines = [
      ...status.roleWarnings,
      ...(status.warningNotice !== undefined ? [status.warningNotice] : []),
    ]
    const model = buildDashboardFromProjected(
      projected,
      {
        repo: opts.repo,
        queued: status.queued ?? 0,
        activeCount,
        capacity: config.capacity,
        observationCount: scan.observations.length,
        observationLimit: config.policy.harvestThreshold,
        ...(status.availableUpgrade !== undefined
          ? { availableUpgrade: status.availableUpgrade }
          : {}),
        ...(warningLines.length > 0 ? { warningLines } : {}),
      },
      repositoryEvents,
    )
    return {
      generatedAt: opts.clock().toISOString(),
      model,
      settingsHeader: {
        intake: !model.drained,
        repositoryPaused: model.repositoryPaused,
        defaultAutoMerge: model.defaultAutoMerge,
        harvestPaused: model.harvestPaused,
      },
    }
  }

  function pinnedPipelineConfig() {
    return parseConfig(`
[tickets]
source = "file"
readyState = "ready"

[commands]
postgres = "pg-ready"

[verify]
steps = ["postgres"]

[verify.postgres]
kind = "check"
command = "postgres"
`)
  }

  async function recordObservation(
    store: MemoryBuildStore,
    slug: string,
    id: string,
    summary: string,
  ): Promise<number> {
    await store.append(slug, {
      actor: agentActor('implement', `observation-${id}`),
      type: 'observation.recorded',
      payload: { id, kind: 'followup', summary },
    })
    const events = await store.getEvents(slug)
    return events.findLast((event) => event.type === 'observation.recorded')!.seq
  }

  /** Running, blocked, queued, merged (terminal, no row), and aborted builds
   * with claimed and unclaimed observations, a pinned pipeline, journal
   * warnings, and settings facts: every lifecycle shape the snapshot's store
   * traffic touches. The open harvest run claims one observation. */
  async function seedDashboardStore(extraDoneBuilds = 0): Promise<MemoryBuildStore> {
    const store = new MemoryBuildStore({ clock })
    await publishRun(store, 'new', config(7, 11), ['role warning'])
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.tick-completed',
      payload: {
        run: 'new',
        queued: 2,
        counters,
        janitorDiagnostics: [],
        ticketDiagnostics: [],
        creationDiagnostics: [],
        dependencyDiagnostics: [],
      },
    })
    await store.appendRepo(REPO, {
      actor: humanActor('operator'),
      type: 'dispatcher.operator-reported',
      payload: { run: 'new', level: 'warning', message: 'operator warning' },
    })
    await store.appendRepo(REPO, {
      actor: humanActor('operator'),
      type: 'dispatcher.auto-merge-default-set',
      payload: { enabled: true },
    })

    // Running build: one unclaimed observation, and a pinned effective-config
    // artifact so a rendered row carries pinned pipeline metadata.
    await createBuild(store, 'running', 'active')
    await store.putArtifact('running', {
      kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
      content: effectiveBuildConfigContent(pinnedPipelineConfig()),
      metadata: {
        revision: 3,
        run: 'new',
        pipelineSource: { ref: 'branch-head', commit: 'a'.repeat(40) },
      },
    })
    await store.append('running', { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
    await recordObservation(store, 'running', 'obs-running', 'unclaimed on the running build')

    // Blocked build: its observation is claimed by the open harvest run below.
    await createBuild(store, 'blocked', 'active')
    await store.append('blocked', {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: { id: 'esc-1', phase: 'plan', source: 'agent', question: 'which spec scope?' },
    })
    const claimedSeq = await recordObservation(
      store,
      'blocked',
      'obs-claimed',
      'claimed by the open run',
    )

    // Queued build: one unclaimed observation.
    await createBuild(store, 'queued', 'queued')
    await recordObservation(store, 'queued', 'obs-queued', 'unclaimed on the queued build')

    // Merged build: terminal `done`, renders no row.
    await createBuild(store, 'merged', 'done')

    // Aborted build: renders as `cleaning`, carries an unclaimed observation.
    await createBuild(store, 'aborted', 'active')
    await store.append('aborted', { actor: KERNEL, type: 'build.aborted', payload: {} })
    await recordObservation(store, 'aborted', 'obs-aborted', 'unclaimed after abort')

    for (let index = 1; index <= extraDoneBuilds; index += 1) {
      const slug = `finished-${index}`
      await createBuild(store, slug, 'done')
    }

    await store.appendRepo(REPO, {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'harvest-1',
        observations: [{ build: 'blocked', seq: claimedSeq }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    return store
  }

  test('the dashboard snapshot is byte-identical to the legacy algorithm over every lifecycle shape', async () => {
    const store = await seedDashboardStore()
    const legacy = await legacySnapshot({ store, repo: REPO, clock })
    const snapshot = await getOperatorDashboard({ store, repo: REPO, clock })
    expect(snapshot).toEqual(legacy)

    // Explicit assertions on the snapshot's shape, so a future change that
    // makes BOTH paths drift together still fails here (AC 1).
    expect(snapshot.generatedAt).toBe(now.toISOString())
    expect(snapshot.settingsHeader).toEqual({
      intake: true,
      repositoryPaused: false,
      defaultAutoMerge: true,
      harvestPaused: false,
    })
    expect(snapshot.model.builds.map((build) => build.slug)).toEqual([
      'aborted',
      'blocked',
      'queued',
      'running',
    ])
    expect(snapshot.model.queued).toBe(2)
    expect(snapshot.model.active).toEqual({ current: 3, limit: 7 })
    expect(snapshot.model.observations).toEqual({ current: 3, limit: 11 })
    expect(snapshot.model.warningLines).toEqual(['role warning', 'operator warning'])
    const statuses = new Map(snapshot.model.builds.map((build) => [build.slug, build.status]))
    expect(statuses.get('running')).toBe('running')
    expect(statuses.get('blocked')).toBe('blocked')
    expect(statuses.get('queued')).toBe('queued')
    expect(statuses.get('aborted')).toBe('cleaning')
    const pinnedRow = snapshot.model.builds.find((build) => build.slug === 'running')!
    expect(pinnedRow.effectiveConfigRev).toBe(3)
    expect(pinnedRow.pipelineSource).toEqual({ ref: 'branch-head', commit: 'a'.repeat(40) })
    expect(pinnedRow.steps.map((step) => step.label)).toContain('verify:postgres')
    expect(snapshot.model.builds.find((build) => build.slug === 'blocked')?.blockers).toEqual([
      'which spec scope?',
    ])
    expect(snapshot.model.builds.find((build) => build.slug === 'merged')).toBeUndefined()
  })

  test('one snapshot reads each history once, the journal once, and writes nothing', async () => {
    // More finished builds than rendered rows: five `done` builds, one of them
    // carrying a pinned artifact that must NOT be fetched.
    const raw = await seedDashboardStore(4)
    await raw.putArtifact('finished-1', {
      kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
      content: effectiveBuildConfigContent(pinnedPipelineConfig()),
      metadata: { revision: 5, run: 'new' },
    })
    const repoBuilds = [
      'aborted',
      'blocked',
      'finished-1',
      'finished-2',
      'finished-3',
      'finished-4',
      'merged',
      'queued',
      'running',
    ]
    const rowBuilds = ['aborted', 'blocked', 'queued', 'running']

    const counting = countingStore(raw)
    counting.counts.clear() // seeding used the raw store; count the snapshot only
    const snapshot = await getOperatorDashboard({ store: counting.store, repo: REPO, clock })
    expect(snapshot.model.builds.map((build) => build.slug)).toEqual(rowBuilds)

    // Read bounds: one journal read, one listing, one history read per repo
    // build (each slug exactly once), and pinned-config reads only for builds
    // that render a row (ACs 2–4).
    expect(counting.counts.get('listBuilds')).toBe(1)
    expect(counting.counts.get('getRepo')).toBe(1)
    expect(counting.counts.get('getRepoEvents')).toBe(1)
    expect(counting.counts.get('getRepoArtifact')).toBe(1)
    expect(counting.eventSlugs).toHaveLength(repoBuilds.length)
    expect([...counting.eventSlugs].sort()).toEqual(repoBuilds)
    expect(counting.counts.get('getArtifact')).toBe(rowBuilds.length)
    expect([...counting.artifactSlugs].sort()).toEqual(rowBuilds)
    // The done build's pinned artifact is never fetched.
    expect(counting.artifactSlugs).not.toContain('finished-1')

    // No store writes, including creating or locking the repository record (AC 5).
    for (const method of MUTATING_STORE_METHODS) {
      expect(counting.counts.get(method) ?? 0).toBe(0)
    }
  })

  test('a terminal done build skips the pinned effective-config read in getOperatorBuild', async () => {
    // AUT-496 (AC 1): a terminal build whose dashboardRow is null must not
    // read its pinned effective-config artifact — the read's result could
    // never be surfaced. The visible result (detail) is identical to today's.
    const raw = await seedDashboardStore()
    await raw.putArtifact('merged', {
      kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
      content: effectiveBuildConfigContent(pinnedPipelineConfig()),
      metadata: { revision: 5, run: 'new' },
    })
    const counting = countingStore(raw) // seeding used the raw store; counts start empty

    const view = await getOperatorBuild({ store: counting.store, repo: REPO, slug: 'merged', now })
    expect(view.dashboardRow).toBeNull()

    // The pinned artifact is never fetched.
    expect(counting.counts.get('getArtifact') ?? 0).toBe(0)
    expect(counting.artifactSlugs).not.toContain('merged')

    // The visible result is identical to the legacy projection: the detail is
    // the plain status projection, and nothing else about it changed.
    const record = (await raw.getBuild('merged'))!
    const events = await raw.getEvents('merged')
    expect(view.detail).toEqual(projectDetail(record, events, now))

    // Full read budget for one getOperatorBuild call on a done build.
    expect(counting.counts.get('getBuild')).toBe(1)
    expect(counting.counts.get('getEvents')).toBe(1)
    expect(counting.counts.get('getRepo')).toBe(1)
    expect(counting.counts.get('getRepoEvents')).toBe(1)
    expect(counting.counts.get('getRepoArtifact')).toBe(1)
    for (const method of MUTATING_STORE_METHODS) {
      expect(counting.counts.get(method) ?? 0).toBe(0)
    }
  })

  test('a terminal aborted build still reads and surfaces its pinned config in getOperatorBuild', async () => {
    // AUT-496 (AC 2 boundary): aborted builds are terminal but project a
    // non-null `cleaning` row, so the gate must NOT skip their pinned read.
    const raw = await seedDashboardStore()
    await raw.putArtifact('aborted', {
      kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
      content: effectiveBuildConfigContent(pinnedPipelineConfig()),
      metadata: {
        revision: 5,
        run: 'new',
        pipelineSource: { ref: 'base', commit: 'b'.repeat(40) },
      },
    })
    const counting = countingStore(raw)

    const view = await getOperatorBuild({ store: counting.store, repo: REPO, slug: 'aborted', now })
    // An aborted build renders a cleaning row with no steps at all
    // (`projectBuild`'s abortProgress early return), so a pinned-step
    // assertion here can never pass — the decoration is the visible proof.
    expect(view.dashboardRow).not.toBeNull()
    expect(view.dashboardRow!.status).toBe('cleaning')
    expect(view.dashboardRow!.steps).toEqual([])
    expect(view.dashboardRow!.effectiveConfigRev).toBe(5)
    expect(view.dashboardRow!.pipelineSource).toEqual({ ref: 'base', commit: 'b'.repeat(40) })

    // The boundary guard: the pinned artifact was read exactly once.
    expect(counting.counts.get('getArtifact')).toBe(1)
    expect(counting.artifactSlugs).toEqual(['aborted'])
  })

  test('a snapshot for a repository the store has never seen answers as today and writes nothing', async () => {
    const raw = new MemoryBuildStore({ clock })
    const counting = countingStore(raw)
    await expect(
      getOperatorDashboard({ store: counting.store, repo: REPO, clock }),
    ).rejects.toMatchObject({ code: 'effective-config-unavailable' })
    for (const method of MUTATING_STORE_METHODS) {
      expect(counting.counts.get(method) ?? 0).toBe(0)
    }
    expect(await raw.getRepo(REPO)).toBeNull()
  })

  test('dashboard reports every durable effective-config failure as a typed query error', async () => {
    const noRun = new MemoryBuildStore({ clock })
    await expect(getOperatorDashboard({ store: noRun, repo: REPO, clock })).rejects.toMatchObject({
      code: 'effective-config-unavailable',
    })

    for (const content of [undefined, '{not json', JSON.stringify({ capacity: 'wrong' })]) {
      const store = new MemoryBuildStore({ clock })
      await store.ensureRepo(REPO)
      if (content !== undefined) {
        await store.putRepoArtifact(REPO, { kind: 'dispatcher-effective-config', content })
      }
      await store.appendRepo(REPO, {
        actor: DISPATCHER,
        type: 'dispatcher.run-started',
        payload: {
          run: 'new',
          pid: 200,
          effectiveConfig: { kind: 'dispatcher-effective-config', rev: 0 },
          roleWarnings: [],
        },
      })
      const error = await getOperatorDashboard({ store, repo: REPO, clock }).catch(
        (caught) => caught,
      )
      expect(error).toBeInstanceOf(OperatorQueryError)
      expect(error).toMatchObject({ code: 'effective-config-unavailable' })
    }
  })
})
