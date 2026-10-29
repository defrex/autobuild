import { historicalEffectiveConfig } from '../config/effective-artifact.fixture'
import { describe, expect, test } from 'bun:test'
import { humanActor } from '../events/envelope'
import type { Exec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import type { BuildStore } from '../store/types'
import { describeStoreOpeningContract } from './store-opening.contract'
import {
  abRepositoryStatus,
  projectRepositoryStatus,
  renderRepositoryStatus,
  type RepositoryStatusOpts,
} from './repository-status'

const REPO = '/main/repo'
const noGit: Exec = async () => ({ stdout: '', stderr: 'not a git repository', exitCode: 128 })

function options(
  store: BuildStore,
  overrides: Partial<RepositoryStatusOpts> = {},
): RepositoryStatusOpts & { output: string[] } {
  const output: string[] = []
  return {
    targetRepo: REPO,
    env: {},
    exec: noGit,
    stdout: (line) => output.push(line),
    openStore: () => store,
    output,
    ...overrides,
  }
}

async function appendSetting(
  store: BuildStore,
  type: 'dispatcher.intake-set' | 'dispatcher.pause-set' | 'dispatcher.auto-merge-default-set',
  enabled: boolean,
): Promise<void> {
  await store.appendRepo(REPO, {
    actor: humanActor('operator'),
    type,
    payload: { enabled },
  })
}

describe('ab repository status', () => {
  test('projects reducer-owned defaults without creating a repository stream', async () => {
    const store = new MemoryBuildStore()
    let getRepoStateEvents = 0
    const readOnly = new Proxy(store, {
      get(target, property) {
        if (property === 'getRepoStateEvents') {
          return async (...args: Parameters<BuildStore['getRepoStateEvents']>) => {
            getRepoStateEvents += 1
            return target.getRepoStateEvents(...args)
          }
        }
        if (property === 'getRepo' || property === 'close' || property === 'listOperatorPresence') {
          const value = Reflect.get(target, property, target) as (...args: unknown[]) => unknown
          return value.bind(target)
        }
        const value = Reflect.get(target, property, target) as unknown
        if (typeof value === 'function') {
          return () => {
            throw new Error(`unexpected store operation ${String(property)}`)
          }
        }
        return value
      },
    }) as unknown as BuildStore
    const opts = options(readOnly, { json: true })

    await abRepositoryStatus(opts)

    expect(JSON.parse(opts.output.join('\n'))).toEqual({
      repo: REPO,
      intake: true,
      paused: false,
      defaultAutoMerge: false,
      dispatcher: {
        state: 'absent',
        holder: null,
        expiredHolder: null,
        latestRun: null,
        latestStoppedRun: null,
      },
      operator: { registrations: [] },
      sandboxes: [],
      upgrades: { runs: {}, holds: {}, lineages: {}, rollbackIds: [] },
      publications: [],
    })
    expect(getRepoStateEvents).toBe(0)
    expect(await store.getRepo(REPO)).toBeNull()
  })

  test('reports paused and unpaused journals through the same reducer projection', async () => {
    for (const paused of [false, true]) {
      const store = new MemoryBuildStore()
      await store.ensureRepo(REPO)
      await appendSetting(store, 'dispatcher.pause-set', !paused)
      await appendSetting(store, 'dispatcher.intake-set', false)
      await appendSetting(store, 'dispatcher.auto-merge-default-set', true)
      await appendSetting(store, 'dispatcher.pause-set', paused)
      const before = await store.getRepoEvents(REPO)
      const opts = options(store, { json: true })

      await abRepositoryStatus(opts)

      expect(JSON.parse(opts.output.join('\n'))).toEqual({
        repo: REPO,
        intake: false,
        paused,
        defaultAutoMerge: true,
        dispatcher: {
          state: 'absent',
          holder: null,
          expiredHolder: null,
          latestRun: null,
          latestStoppedRun: null,
        },
        operator: { registrations: [] },
        sandboxes: [],
        upgrades: { runs: {}, holds: {}, lineages: {}, rollbackIds: [] },
        publications: [],
      })
      expect(await store.getRepoEvents(REPO)).toEqual(before)
    }
  })

  test('human output labels the repository and every dispatcher setting', () => {
    const status = projectRepositoryStatus(REPO, [])
    expect(renderRepositoryStatus(status)).toEqual([
      'operator: absent',
      'forge requests: unavailable',
      `repository: ${REPO}`,
      'dispatcher: absent — no dispatcher holds the repository',
      'intake: ON',
      'repository pause: OFF',
      'default auto-merge: OFF',
    ])
  })

  test('operator sandboxes project from the journal; released environments are omitted', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo(REPO)
    await store.appendRepo(REPO, {
      actor: humanActor('ops'),
      type: 'orchestrator.sandbox.provisioned',
      payload: {
        operator: 'ops',
        environmentId: 'autobuild-sandbox-abc123',
        provider: 'vercel-sandbox',
        workspacePath: '/vercel/sandbox/workspace',
      },
    })
    await store.appendRepo(REPO, {
      actor: humanActor('other'),
      type: 'orchestrator.sandbox.provisioned',
      payload: {
        operator: 'other',
        environmentId: 'autobuild-sandbox-def456',
        provider: 'git-worktree',
        workspacePath: '/state/orchestrator-sandboxes/def456',
      },
    })
    await store.appendRepo(REPO, {
      actor: { kind: 'dispatcher' },
      type: 'orchestrator.sandbox.stopped',
      payload: { operator: 'other', environmentId: 'autobuild-sandbox-def456', reason: 'idle' },
    })
    const status = projectRepositoryStatus(REPO, await store.getRepoEvents(REPO))
    expect(status.sandboxes).toEqual([
      {
        operator: 'ops',
        environmentId: 'autobuild-sandbox-abc123',
        provider: 'vercel-sandbox',
        state: 'live',
        lastEvidenceAt: expect.any(String),
      },
      {
        operator: 'other',
        environmentId: 'autobuild-sandbox-def456',
        provider: 'git-worktree',
        state: 'stopped',
        lastEvidenceAt: expect.any(String),
      },
    ])
    const lines = renderRepositoryStatus(status)
    expect(lines).toContain(
      'operator sandbox autobuild-sandbox-abc123 (vercel-sandbox) — live, idle since ' +
        status.sandboxes[0]!.lastEvidenceAt,
    )
    await store.appendRepo(REPO, {
      actor: humanActor('ops'),
      type: 'orchestrator.sandbox.released',
      payload: {
        operator: 'ops',
        environmentId: 'autobuild-sandbox-abc123',
        snapshots: { outcome: 'confirmed' },
      },
    })
    const after = projectRepositoryStatus(REPO, await store.getRepoEvents(REPO))
    expect(after.sandboxes.map((sandbox) => sandbox.operator)).toEqual(['other'])
  })

  test('publications project from the journal: newest first, latest per (operator, branch)', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo(REPO)
    const publish = (operator: string, branch: string, sha: string, pr: number) =>
      store.appendRepo(REPO, {
        actor: humanActor(operator),
        type: 'orchestrator.sandbox.published',
        payload: {
          operator,
          environmentId: `autobuild-sandbox-${operator}`,
          branch,
          sha,
          pr: {
            number: pr,
            url: `https://github.com/acme/widgets/pull/${pr}`,
            headSha: sha,
          },
        },
      })
    await publish('ops', 'ab/orch-ops-11111111', 'a'.repeat(40), 1)
    await publish('ops', 'ab/orch-ops-11111111', 'b'.repeat(40), 1)
    await publish('other', 'ab/orch-other-22222222', 'c'.repeat(40), 2)
    await publish('other', 'ab/orch-other-33333333', 'd'.repeat(40), 3)
    const status = projectRepositoryStatus(REPO, await store.getRepoEvents(REPO))
    expect(status.publications).toEqual([
      {
        operator: 'other',
        branch: 'ab/orch-other-33333333',
        sha: 'd'.repeat(40),
        prNumber: 3,
        prUrl: 'https://github.com/acme/widgets/pull/3',
        at: expect.any(String),
      },
      {
        operator: 'other',
        branch: 'ab/orch-other-22222222',
        sha: 'c'.repeat(40),
        prNumber: 2,
        prUrl: 'https://github.com/acme/widgets/pull/2',
        at: expect.any(String),
      },
      {
        operator: 'ops',
        branch: 'ab/orch-ops-11111111',
        sha: 'b'.repeat(40),
        prNumber: 1,
        prUrl: 'https://github.com/acme/widgets/pull/1',
        at: expect.any(String),
      },
    ])

    // The session rides through when the fact carries one.
    await store.appendRepo(REPO, {
      actor: humanActor('ops'),
      type: 'orchestrator.sandbox.published',
      payload: {
        operator: 'ops',
        environmentId: 'autobuild-sandbox-ops',
        branch: 'ab/orch-ops-44444444',
        sha: 'e'.repeat(40),
        session: 'sess-1',
        pr: {
          number: 4,
          url: 'https://github.com/acme/widgets/pull/4',
          headSha: 'e'.repeat(40),
        },
      },
    })
    const updated = projectRepositoryStatus(REPO, await store.getRepoEvents(REPO))
    expect(updated.publications[0]).toMatchObject({ session: 'sess-1' })
    const lines = renderRepositoryStatus(updated)
    expect(
      lines.some((line) => line.includes('PR #4') && line.includes('ab/orch-ops-44444444')),
    ).toBe(true)
  })

  test('the query leaves repository events and unrelated build state unchanged', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo(REPO)
    await appendSetting(store, 'dispatcher.pause-set', true)
    await store.createBuild({ slug: 'unrelated', repo: REPO })
    const beforeEvents = await store.getRepoEvents(REPO)
    const beforeBuilds = await store.listBuilds()
    const opts = options(store)

    await abRepositoryStatus(opts)

    expect(opts.output).toContain('repository pause: ON')
    expect(await store.getRepoEvents(REPO)).toEqual(beforeEvents)
    expect(await store.listBuilds()).toEqual(beforeBuilds)
  })
})

describeStoreOpeningContract('ab repository status', {
  run: (opts) => abRepositoryStatus({ ...opts, json: true }),
  canonicalMarker: (stdout) => (JSON.parse(stdout.join('\n')) as { repo?: string }).repo,
  expectedCanonicalMarker: REPO,
})

test('status and operator queries resolve a hidden holder with live heartbeat attribution', async () => {
  const { DISPATCHER } = await import('../events/envelope')
  const { manualClock } = await import('../testing/fixed')
  const { getRepositoryStatus } = await import('../operator/query')
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  await store.ensureRepo(REPO)
  const start = async (run: string) =>
    store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run,
        pid: 42,
        host: 'host',
        effectiveConfig: { kind: 'config', rev: 0 },
        roleWarnings: [],
      },
    })
  await start('old')
  await store.claimRepoLease(REPO, 'old', 1000)
  await store.heartbeatRepo(REPO, 'old')
  await store.releaseRepoLease(REPO, 'old')
  clock.advance(2000)
  await start('owner')
  await store.claimRepoLease(REPO, 'owner', 60000)
  await start('yielding')
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'dispatcher.run-stopped',
    payload: { run: 'yielding', outcome: 'normal' },
  })
  const opts = options(store, { json: true, now: clock })
  await abRepositoryStatus(opts)
  const status = JSON.parse(opts.output.join('\n'))
  expect(status.dispatcher.holder).toMatchObject({
    run: 'owner',
    pid: 42,
    host: 'host',
    heartbeatAt: null,
    heartbeatAgeMs: null,
  })
  expect(await getRepositoryStatus(store, REPO, clock())).toEqual(status)
  const human = options(store, { now: clock })
  await abRepositoryStatus(human)
  expect(human.output.join('\n')).toContain(
    'heartbeat unknown (no renewal attributable to this run)',
  )
  await store.heartbeatRepo(REPO, 'owner')
  clock.advance(500)
  expect((await getRepositoryStatus(store, REPO, clock())).dispatcher.holder?.heartbeatAgeMs).toBe(
    500,
  )
})

test('a live latest holder never falls back to full history in CLI or operator status', async () => {
  const { DISPATCHER } = await import('../events/envelope')
  const { manualClock } = await import('../testing/fixed')
  const { getRepositoryStatus } = await import('../operator/query')
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  await store.ensureRepo(REPO)
  for (let i = 0; i < 100; i += 1) {
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run: `old-${i}`,
        pid: 1,
        effectiveConfig: { kind: 'config', rev: 0 },
        roleWarnings: [],
      },
    })
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.run-stopped',
      payload: { run: `old-${i}`, outcome: 'normal' },
    })
  }
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'dispatcher.run-started',
    payload: {
      run: 'live',
      pid: 42,
      host: 'host',
      effectiveConfig: { kind: 'config', rev: 0 },
      roleWarnings: [],
    },
  })
  await store.claimRepoLease(REPO, 'live', 60000)
  let boundedRows = 0
  const bounded = new Proxy(store, {
    get(target, prop) {
      if (prop === 'getRepoEvents')
        return async (repo: string, since?: number) => {
          if (since === undefined) throw new Error('unexpected full-history liveness read')
          return target.getRepoEvents(repo, since)
        }
      if (prop === 'getRepoStateEvents')
        return async (repo: string) => {
          const events = await target.getRepoStateEvents(repo)
          boundedRows += events.length
          return events
        }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  for (let i = 0; i < 2; i += 1) {
    const opts = options(bounded, { json: true, now: clock })
    await abRepositoryStatus(opts)
    const status = JSON.parse(opts.output.join('\n'))
    expect(status.dispatcher.holder.run).toBe('live')
    expect(await getRepositoryStatus(bounded, REPO, clock())).toEqual(status)
  }
  expect(boundedRows).toBeLessThan(10)
})

test('human repository status explains actual, configured and descendant-held capacity', () => {
  const status = projectRepositoryStatus(REPO, [])
  expect(status.capacity).toBeUndefined()
  status.capacity = { configured: 5, occupied: 6, effective: 6, borrowingNodes: ['website-node'] }
  expect(renderRepositoryStatus(status)).toContain(
    'capacity: 6/6 effective; 5 configured; 1 node using descendant-held slots: website-node',
  )
  expect(JSON.parse(JSON.stringify(status)).capacity).toEqual(status.capacity)
})

test.each([false, true])(
  'CLI JSON and operator status use the held dispatcher configuration and the same borrowed-slot projection (legacy enabled=%s)',
  async (enabled) => {
    const { DISPATCHER, KERNEL } = await import('../events/envelope')
    const { manualClock } = await import('../testing/fixed')
    const { getRepositoryStatus, getOperatorDashboard } = await import('../operator/query')
    const clock = manualClock()
    const store = new MemoryBuildStore({ clock })
    await store.ensureRepo(REPO)
    const config = {
      ...historicalEffectiveConfig(enabled),
      capacity: 1,
      tickets: { source: 'file', readyState: 'Ready' },
    }
    const artifact = await store.putRepoArtifact(REPO, {
      kind: 'config',
      content: JSON.stringify(config),
    })
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run: 'live',
        pid: 42,
        roleWarnings: [],
        effectiveConfig: { kind: 'config', rev: artifact.revision },
      },
    })
    await store.claimRepoLease(REPO, 'live', 60000)
    for (const slug of ['node', 'child']) {
      const ticket = { source: 'file', id: slug }
      await store.createBuild({
        slug,
        repo: REPO,
        ticket,
        created: {
          actor: DISPATCHER,
          type: 'build.created',
          payload: {
            repo: REPO,
            ticket,
            baseBranch: 'main',
            ...(slug === 'node'
              ? { kind: 'node' as const }
              : { target: { build: 'node', ticket: { source: 'file', id: 'node' } } }),
          },
        },
      })
    }
    await store.append('node', {
      actor: KERNEL,
      type: 'node.writer-reserved',
      payload: {
        id: 'restack',
        operation: 'restack',
        expected: 'head',
        parent: 'parent',
        oldBase: 'base',
        archive: 'archive',
        changes: [{ sha: 'change' }],
        upstreamBuilds: [],
        merges: [],
      },
    })
    await store.append('node', {
      actor: KERNEL,
      type: 'node.item-prepared',
      payload: { id: 'restack', index: 0, base: 'parent' },
    })
    await store.append('node', {
      actor: KERNEL,
      type: 'node.item-conflicted',
      payload: { id: 'restack', index: 0, base: 'parent' },
    })
    await store.append('node', {
      actor: DISPATCHER,
      type: 'workspace.provisioned',
      payload: {
        provider: 'local',
        ref: 'node-workspace',
        branch: 'node',
        base: { source: 'local', sha: 'head', remoteError: 'fixture' },
      },
    })
    await store.append('child', { actor: DISPATCHER, type: 'build.paused', payload: {} })
    const expected = { configured: 1, occupied: 2, effective: 2, borrowingNodes: ['node'] }
    const opts = options(store, { json: true, now: clock })
    await abRepositoryStatus(opts)
    expect(JSON.parse(opts.output.join('\n')).capacity).toEqual(expected)
    expect((await getRepositoryStatus(store, REPO, clock())).capacity).toEqual(expected)
    expect((await getOperatorDashboard({ store, repo: REPO, clock })).model.capacity).toEqual(
      expected,
    )
  },
)

test('repository status renders available outcome categories on failed tick telemetry', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(REPO)
  await store.claimRepoLease(REPO, 'run', 60_000)
  await store.beginRepoTick(REPO, 'run')
  await store.finishRepoTick(
    REPO,
    'run',
    {
      outcome: 'failed',
      error: 'offline',
      forgeRequests: {
        total: 5,
        restPrimary: 1,
        restNotModified: 2,
        graphql: 1,
        unattributed: 5,
        builds: [],
        complete: true,
      },
    },
    [
      {
        actor: { kind: 'dispatcher' },
        type: 'dispatcher.tick-started',
        payload: { run: 'run', startedAt: new Date().toISOString() },
      },
      {
        actor: { kind: 'dispatcher' },
        type: 'dispatcher.tick-failed',
        payload: { run: 'run', error: 'offline' },
      },
    ],
  )
  const { getRepositoryStatus } = await import('../operator/query')
  const status = await getRepositoryStatus(store, REPO, new Date())
  expect(renderRepositoryStatus(status)[1]).toBe(
    'forge requests: 5; REST primary 1; REST 304 2; GraphQL 1 (5 unattributed)',
  )
})

test('human and JSON repository status expose the held runtime and legacy unrecorded state', async () => {
  const clock = () => new Date('2026-10-21T12:00:00Z')
  const store = new MemoryBuildStore({ clock })
  await store.ensureRepo(REPO)
  const start = await store.appendRepo(REPO, {
    actor: { kind: 'dispatcher' },
    type: 'dispatcher.run-started',
    payload: {
      run: 'owner',
      pid: 123,
      host: 'host',
      effectiveConfig: { kind: 'config', rev: 0 },
      roleWarnings: [],
    },
  })
  await store.claimRepoLease(REPO, 'owner', 60000)
  const legacy = options(store, { now: clock })
  await abRepositoryStatus(legacy)
  expect(legacy.output.join('\n')).toContain('runtime unrecorded')
  const runtime = {
    version: '1.0.0',
    commit: 'a'.repeat(40),
    source: { kind: 'source' as const, location: '/distribution' },
  }
  await store.appendRepo(REPO, {
    actor: { kind: 'dispatcher' },
    type: 'dispatcher.runtime-recorded',
    payload: { run: 'owner', startedSeq: start.seq, runtime },
  })
  const human = options(store, { now: clock })
  await abRepositoryStatus(human)
  expect(human.output.join('\n')).toContain(
    `autobuild 1.0.0; commit ${runtime.commit}; source /distribution`,
  )
  const json = options(store, { now: clock, json: true })
  await abRepositoryStatus(json)
  expect(JSON.parse(json.output.join('\n')).dispatcher.holder.runtime).toEqual(runtime)
})

test('operator status reports live registrations, ages and exactly one human line', async () => {
  let instant = Date.parse('2026-10-24T12:00:00.000Z')
  const now = () => new Date(instant)
  const store = new MemoryBuildStore({ clock: now })
  const identity = { id: 'a', host: 'one', pid: 10, startedAt: now().toISOString() }
  await store.upsertOperatorPresence(REPO, identity)
  instant += 1000
  await store.upsertOperatorPresence(REPO, { ...identity, id: 'b', host: 'two', pid: 20 })
  const opts = options(store, { json: true, now })
  await abRepositoryStatus(opts)
  const projection = JSON.parse(opts.output.join('\n'))
  expect(
    projection.operator.registrations.map((row: { heartbeatAgeMs: number }) => row.heartbeatAgeMs),
  ).toEqual([1000, 0])
  expect(renderRepositoryStatus(projection).filter((line) => line.startsWith('operator:'))).toEqual(
    ['operator: present (2 registrations)'],
  )
  instant += 299_000
  const expired = options(store, { json: true, now })
  await abRepositoryStatus(expired)
  expect(
    JSON.parse(expired.output.join('\n')).operator.registrations.map(
      (row: { id: string }) => row.id,
    ),
  ).toEqual(['b'])
  instant += 1000
  const absent = options(store, { now })
  await abRepositoryStatus(absent)
  expect(absent.output.filter((line) => line.startsWith('operator:'))).toEqual(['operator: absent'])
})

for (const outcome of ['normal', 'abnormal'] as const) {
  test(`status correlates a hidden ${outcome} stopped holder before and after expiry`, async () => {
    const { DISPATCHER } = await import('../events/envelope')
    const { manualClock } = await import('../testing/fixed')
    const clock = manualClock()
    const store = new MemoryBuildStore({ clock })
    await store.ensureRepo(REPO)
    for (const run of ['holder', 'yielding']) {
      await store.appendRepo(REPO, {
        actor: DISPATCHER,
        type: 'dispatcher.run-started',
        payload: {
          run,
          pid: 42,
          roleWarnings: [],
          effectiveConfig: { kind: 'config', rev: 0 },
        },
      })
      if (run === 'holder') await store.claimRepoLease(REPO, run, 1000)
      await store.appendRepo(REPO, {
        actor: DISPATCHER,
        type: 'dispatcher.run-stopped',
        payload: { run, outcome },
      })
    }
    for (const advance of [0, 2000]) {
      clock.advance(advance)
      const opts = options(store, { json: true, now: clock })
      await abRepositoryStatus(opts)
      expect(JSON.parse(opts.output.join('\n')).dispatcher).toMatchObject({
        state: 'stopped',
        expiredHolder: null,
        holder: null,
      })
    }
  })
}
