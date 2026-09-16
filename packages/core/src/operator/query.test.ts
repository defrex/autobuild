import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import { agentActor, DISPATCHER, humanActor, KERNEL } from '../events/envelope'
import { reduceBuild } from '../kernel/reducer'
import {
  BUILD_EFFECTIVE_CONFIG_ARTIFACT,
  effectiveBuildConfigContent,
} from '../processes/build-execution-state'
import { MemoryBuildStore } from '../store/memory'
import { projectBuild } from '../cli/dashboard/model'
import {
  getHarvestStatus,
  getOperatorBuild,
  getOperatorDashboard,
  getRepositoryStatus,
  listOperatorBuilds,
  OperatorQueryError,
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

    const view = await getOperatorBuild({ store, repo: REPO, slug: 'active', now })
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
