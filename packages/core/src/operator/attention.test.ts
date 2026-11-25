import { expect, test } from 'bun:test'
import { summarizeFrom } from '../cli/status'
import { projectRepositoryStatus, type RepositoryStatus } from '../cli/repository-status'
import { DISPATCHER, KERNEL, humanActor } from '../events/envelope'
import type { RepositoryEvent } from '../events/repository'
import { reportIntegrationFailures } from '../kernel/integration-attention'
import { REPOSITORY_TAIL_WINDOW } from '../store/event-reads'
import { MemoryBuildStore } from '../store/memory'
import { readBuildFacts } from '../store/reduced-reads'
import {
  dispatcherAttention,
  repositoryEventResolution,
  UNMAPPED_EVENT_NOTE,
  waitingReasons,
  type OperatorAttention,
} from './attention'
import { buildRegistry, RegistryError, TOOLS } from './registry'

const REPO = '/repo'
const now = new Date('2026-11-24T00:00:00.000Z')
const clock = () => now
const FAR = '2099-01-01T00:00:00.000Z'
const HEAD = 'a'.repeat(40)
const PARENT = 'b'.repeat(40)

async function dispatcherRun(store: MemoryBuildStore) {
  const artifact = await store.putRepoArtifact(REPO, {
    kind: 'dispatcher-effective-config',
    content: JSON.stringify({
      tickets: { source: 'file', readyState: 'ready' },
      verify: { steps: [] },
      finalize: { steps: [] },
    }),
  })
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'dispatcher.run-started',
    payload: {
      run: 'run-1',
      pid: 1,
      roleWarnings: [],
      effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
    },
  })
}

async function build(store: MemoryBuildStore, slug: string, kind: 'node' | 'work' = 'work') {
  const ticket = { source: 'file', id: slug.toUpperCase() }
  await store.createBuild({
    slug,
    repo: REPO,
    ticket,
    branch: `ab/${slug}`,
    created: {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { ticket, repo: REPO, baseBranch: 'main', kind },
    },
  })
}

async function escalate(store: MemoryBuildStore, slug: string, id: string) {
  await store.append(slug, {
    actor: KERNEL,
    type: 'escalation.raised',
    payload: {
      id,
      phase: 'plan',
      source: 'agent',
      question: `question ${id}?`,
    },
  })
}

async function consentReady(store: MemoryBuildStore, slug: string, hold = false) {
  await store.append(slug, {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'runner', host: 'host' },
  })
  await store.append(slug, {
    actor: KERNEL,
    type: 'workspace.provisioned',
    payload: {
      provider: 'local',
      ref: 'local',
      path: '/workspace',
      branch: `ab/${slug}`,
      base: { source: 'local', remoteError: 'offline', sha: 'base' },
    },
  })
  const finalized = await store.append(slug, {
    actor: KERNEL,
    type: 'finalize.completed',
    payload: { pr: { number: 7, url: 'https://forge/7', headSha: 'head' } },
  })
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'landing.decided',
    payload: {
      candidate: { head: 'head', parent: 'base', cycle: String(finalized.seq) },
      from: 'leaf',
      into: { kind: 'root' },
      labels: [],
      mode: 'consent',
      rule: { default: true },
    },
  })
  if (hold)
    await store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.hold-requested',
      payload: {},
    })
}

/** A node whose integration verification failed, from real events. */
async function failedNode(store: MemoryBuildStore) {
  await build(store, 'node', 'node')
  await cycle(store, 'first')
  await store.append('node', {
    actor: KERNEL,
    type: 'verify.completed',
    payload: {
      step: 'unit',
      attempt: 1,
      outcome: 'fail',
      restackId: 'first',
      headSha: HEAD,
      baseSha: PARENT,
    },
  })
}

async function cycle(store: MemoryBuildStore, id: string, head = HEAD) {
  await store.append('node', {
    actor: DISPATCHER,
    type: 'node.compared',
    payload: { headSha: head, parentSha: PARENT, ahead: 1 },
  })
  await store.append('node', {
    actor: DISPATCHER,
    type: 'integration.prepared',
    payload: {
      id,
      head,
      parent: PARENT,
      config: '{"verify":{"steps":["unit"]}}',
    },
  })
}

const handedBack = (id: string) =>
  ({
    actor: DISPATCHER,
    type: 'ticket.handed-back',
    payload: {
      ticket: { source: 'file', id },
      build: `b-${id}`,
      cause: 'abort',
      state: 'Ready',
      role: 'ready',
    },
  }) as const

const attention = (registry: ReturnType<typeof buildRegistry>, cursor?: number) =>
  registry.call('repository.attention', {
    repo: REPO,
    ...(cursor !== undefined ? { cursor } : {}),
  }) as Promise<OperatorAttention>

const allResolutions = (digest: OperatorAttention) => [
  ...digest.escalations.flatMap((item) => item.resolve),
  ...digest.merges.flatMap((item) => item.resolve),
  ...digest.events.items.flatMap((item) => item.resolve),
  ...digest.waiting.flatMap((item) => item.resolve),
  ...digest.dispatcher.flatMap((item) => item.resolve),
]

test('every section matches its dedicated tool at the registry seam', async () => {
  const store = new MemoryBuildStore({ clock })
  await store.ensureRepo(REPO)
  await dispatcherRun(store)
  await build(store, 'blocked')
  await escalate(store, 'blocked', 'esc-1')
  await escalate(store, 'blocked', 'esc-2')
  await build(store, 'waits')
  await store.append('waits', {
    actor: { kind: 'agent', role: 'implement', session: 's' },
    type: 'wait.requested',
    payload: {
      id: 'wait_1',
      phase: 'implement',
      round: 1,
      tickets: ['X'],
      reason: 'needs X',
    },
  })
  await store.append('waits', {
    actor: DISPATCHER,
    type: 'wait.entered',
    payload: {
      id: 'wait_1',
      escalation: 'esc_w',
      tickets: [{ source: 'file', id: 'X' }],
      reason: 'needs X',
      question: 'Waiting on X to complete: needs X.',
    },
  })
  await build(store, 'consent')
  await consentReady(store, 'consent')
  await build(store, 'held')
  await consentReady(store, 'held', true)
  await build(store, 'paused')
  await store.append('paused', {
    actor: KERNEL,
    type: 'build.paused',
    payload: {},
  })
  for (const slug of ['settled-1', 'settled-2']) {
    await build(store, slug)
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
  }
  const target = {
    mode: 'source' as const,
    key: 'target-key',
    source: 'origin/main',
  }
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'dispatcher.upgrade-failed',
    payload: {
      correlation: 'c',
      run: 'run-1',
      lineage: 'l',
      from: {
        version: '1.0.0',
        commit: 'unknown',
        source: { kind: 'source', location: '/x' },
      },
      target,
      reason: 'preflight failed',
    },
  })
  await store.appendRepo(REPO, {
    actor: KERNEL,
    type: 'dispatcher.forge-degraded',
    payload: {
      forge: 'github',
      message: 'rate limited',
      resetAt: FAR,
      firstFailureAt: FAR,
    },
  })
  const registry = buildRegistry({ store, clock })
  const baseline = await attention(registry)
  expect(baseline.events).toEqual({
    items: [],
    cursor: await store.getRepoHighWater(REPO),
    hasMore: false,
  })
  await store.appendRepo(REPO, handedBack('T-1'))
  const digest = await attention(registry, baseline.events.cursor)

  const open = ['blocked', 'consent', 'held', 'paused', 'waits']
  const answerable: string[] = []
  for (const slug of open) {
    const view = (await registry.call('builds.get', { repo: REPO, slug })) as {
      detail: { openEscalations: unknown[]; waitOnly?: true }
    }
    const listed = (
      (await registry.call('builds.list', { repo: REPO, scope: 'active' })) as {
        slug: string
        waitOnly?: true
      }[]
    ).find((summary) => summary.slug === slug)
    const item = digest.escalations.find((entry) => entry.slug === slug)
    if (view.detail.openEscalations.length > 0 && listed?.waitOnly !== true) {
      answerable.push(slug)
      expect(item?.escalations).toEqual(view.detail.openEscalations as never)
    }
  }
  expect(answerable).toEqual(['blocked'])
  expect(digest.escalations.map((item) => item.slug)).toEqual(answerable)
  expect(digest.escalations[0]!.escalations).toHaveLength(2)
  expect(digest.merges.map((item) => item.entry)).toEqual(
    (await registry.call('merges.list', { repo: REPO })) as never,
  )
  expect(digest.merges.map((item) => [item.slug, item.entry.reason, item.pr?.number])).toEqual([
    ['consent', 'consent required', 7],
    ['held', 'held', 7],
  ])
  expect(digest.merges[0]!.resolve[0]).toEqual({
    tool: 'builds.control',
    input: { repo: REPO, slug: 'consent', action: 'merge', head: 'head' },
    by: 'operator',
  })
  const events = (await registry.call('repository.events', {
    repo: REPO,
    cursor: baseline.events.cursor,
    filter: 'attention',
  })) as { events: unknown[]; cursor: number; hasMore: boolean }
  expect(digest.events.items.map((item) => item.event)).toEqual(events.events as never)
  expect(digest.events.cursor).toBe(events.cursor)
  expect(digest.events.hasMore).toBe(events.hasMore)
  expect(digest.events.items[0]!.resolve[0]).toMatchObject({
    tool: 'tickets.move',
    input: { repo: REPO, id: 'T-1' },
  })
  const status = (await registry.call('repository.status', {
    repo: REPO,
  })) as RepositoryStatus
  expect(digest.dispatcher).toEqual(dispatcherAttention(status, now))
  expect(digest.dispatcher.map((item) => item.kind)).toEqual([
    'no-holder',
    'upgrade-failed',
    'forge-cooldown',
  ])
  expect(digest.waiting.map((item) => [item.slug, item.reason])).toEqual([['paused', 'paused']])
  // No item names a settled build.
  expect(JSON.stringify(digest)).not.toContain('settled-')

  // Every item names a real resolving tool.
  const names = new Set(TOOLS.map((tool) => tool.name))
  for (const item of [
    ...digest.escalations,
    ...digest.merges,
    ...digest.events.items,
    ...digest.waiting,
    ...digest.dispatcher,
  ])
    expect(item.resolve.length).toBeGreaterThan(0)
  for (const resolution of allResolutions(digest)) expect(names.has(resolution.tool)).toBe(true)
})

test('a failed node reports its failure, not an empty escalation (f_d56a43e0)', async () => {
  const store = new MemoryBuildStore({ clock })
  await store.ensureRepo(REPO)
  await dispatcherRun(store)
  await failedNode(store)
  const registry = buildRegistry({ store, clock })
  const view = (await registry.call('builds.get', {
    repo: REPO,
    slug: 'node',
  })) as {
    detail: { status: string; openEscalations: unknown[] }
  }
  expect(view.detail.status).toBe('blocked')
  expect(view.detail.openEscalations).toEqual([])

  const failure = (digest: OperatorAttention) =>
    digest.waiting.filter((item) => item.slug === 'node' && item.reason === 'verification-failed')
  let digest = await attention(registry)
  expect(digest.escalations).toEqual([])
  expect(failure(digest)).toHaveLength(1)
  const item = failure(digest)[0]!
  expect(item.detail).toEqual({
    cycle: 'first',
    head: HEAD,
    parent: PARENT,
    steps: ['unit'],
    guidance: 'file a repair child targeting this node: node',
  })
  expect(item.resolve.map((entry) => [entry.tool, entry.input])).toEqual([
    ['tickets.create', { repo: REPO, kind: 'work', target: 'NODE' }],
    ['builds.answer', { repo: REPO, slug: 'node' }],
  ])

  await reportIntegrationFailures(store, 'node')
  const reported = (await store.getEvents('node')).findLast(
    (event) => event.type === 'integration.verification-failed',
  )!
  digest = await attention(registry, await store.getRepoHighWater(REPO))
  expect(failure(digest)[0]!.detail).toEqual(item.detail)
  expect((failure(digest)[0]!.detail as { guidance: string }).guidance).toBe(
    (reported.payload as { guidance: string }).guidance,
  )
  expect(digest.events.items).toEqual([])

  await escalate(store, 'node', 'esc-node')
  digest = await attention(registry)
  const detail = (await registry.call('builds.get', {
    repo: REPO,
    slug: 'node',
  })) as {
    detail: { openEscalations: unknown[] }
  }
  expect(digest.escalations.map((entry) => entry.slug)).toEqual(['node'])
  expect(digest.escalations[0]!.escalations).toEqual(detail.detail.openEscalations as never)
  expect(failure(digest)).toHaveLength(1)

  await store.append('node', {
    actor: KERNEL,
    type: 'build.paused',
    payload: {},
  })
  digest = await attention(registry)
  expect(digest.waiting.map((entry) => entry.reason)).toEqual(['paused', 'verification-failed'])

  await cycle(store, 'repair', 'f'.repeat(40))
  await store.append('node', {
    actor: KERNEL,
    type: 'verify.completed',
    payload: {
      step: 'unit',
      attempt: 1,
      outcome: 'pass',
      restackId: 'repair',
      headSha: 'f'.repeat(40),
      baseSha: PARENT,
    },
  })
  digest = await attention(registry)
  expect(failure(digest)).toEqual([])
})

test('every repository attention type resolves through a specific tool', () => {
  const ticket = { source: 'file', id: 'T-9' }
  const cases: [Partial<RepositoryEvent>, string][] = [
    [{ type: 'ticket.handed-back', payload: { ticket } as never }, 'tickets.move'],
    [
      {
        type: 'ticket-preparation.resolved',
        payload: { ticket, outcome: 'abandoned' } as never,
      },
      'tickets.move',
    ],
    [
      {
        type: 'ticket.start-settled',
        payload: { ticket, outcome: 'started', slug: 's' } as never,
      },
      'builds.get',
    ],
    [
      {
        type: 'ticket.start-settled',
        payload: { ticket, outcome: 'refused' } as never,
      },
      'tickets.start',
    ],
    [{ type: 'harvest.escalated', payload: {} as never }, 'harvest.status'],
    [{ type: 'harvest.recovery-exhausted', payload: {} as never }, 'harvest.status'],
    [
      {
        type: 'dispatcher.forge-degraded',
        payload: { forge: 'github' } as never,
      },
      'repository.forge_clear',
    ],
    ...(
      [
        'dispatcher.config-rejected',
        'dispatcher.runtime-rolled-back',
        'dispatcher.upgrade-failed',
        'dispatcher.kernel-git-unavailable',
        'dispatcher.forge-readiness-failed',
        'dispatcher.config-reloaded',
        'dispatcher.run-stopped',
        'hook.failing',
        'hook.recovered',
        'hook.skipped',
        'account.credentials-unavailable',
        'forge.credential-limited',
      ] as const
    ).map(
      (type) =>
        [{ type, payload: {} as never }, 'repository.status'] as [Partial<RepositoryEvent>, string],
    ),
  ]
  for (const [event, tool] of cases) {
    const resolve = repositoryEventResolution(event as RepositoryEvent, REPO)
    expect({ type: event.type, tool: resolve[0]!.tool }).toEqual({
      type: event.type,
      tool,
    })
    expect(resolve[0]!.note).not.toBe(UNMAPPED_EVENT_NOTE)
  }
})

test('waitingReasons checks each reason on its own', async () => {
  const store = new MemoryBuildStore({ clock })
  await failedNode(store)
  await build(store, 'leaf')
  await escalate(store, 'leaf', 'esc')
  const input = async (slug: string) => {
    const record = (await store.getBuild(slug))!
    const state = (await readBuildFacts(store, slug)).value.state
    return {
      repo: REPO,
      slug,
      summary: summarizeFrom(record, state, now),
      state,
      now,
    }
  }
  const reasons = (value: Parameters<typeof waitingReasons>[0]) =>
    waitingReasons(value).map((item) => item.reason)

  const node = await input('node')
  expect(node.state.status).toBe('blocked')
  expect(reasons(node)).toEqual(['verification-failed'])

  const leaf = await input('leaf')
  expect(leaf.state.status).toBe('blocked')
  expect(reasons(leaf)).toEqual([])
  expect(reasons({ ...leaf, summary: { ...leaf.summary, status: 'paused' } })).toEqual(['paused'])
  const ciFailure = {
    head: 'h',
    buildHead: 'h',
    checks: [],
    total: 1,
    text: 'ci: 1 failing',
  }
  expect(reasons({ ...leaf, summary: { ...leaf.summary, ciFailure } })).toEqual(['ci-failing'])
  const progress = {
    lastEventAt: '2026-11-23T20:00:00.000Z',
    heartbeatAt: '2026-11-23T21:00:00.000Z',
    leaseExpiresAt: '2026-11-24T01:00:00.000Z',
    terminal: false,
  }
  expect(reasons({ ...leaf, summary: { ...leaf.summary, progress } })).toEqual(['stalled'])
  const recent = { ...progress, heartbeatAt: '2026-11-23T20:30:00.000Z' }
  expect(reasons({ ...leaf, summary: { ...leaf.summary, progress: recent } })).toEqual([])
})

test('dispatcherAttention reports each dispatcher condition', () => {
  const healthy = projectRepositoryStatus(REPO, [])
  const held = {
    ...healthy,
    dispatcher: { ...healthy.dispatcher, state: 'held' as const },
  } as RepositoryStatus
  expect(dispatcherAttention(held, now)).toEqual([])
  for (const state of ['lost', 'stopped', 'absent'] as const)
    expect(
      dispatcherAttention({ ...held, dispatcher: { ...held.dispatcher, state } }, now).map(
        (item) => [item.kind, item.resolve[0]!.by],
      ),
    ).toEqual([['no-holder', 'human']])
  const failed = {
    type: 'dispatcher.upgrade-failed',
    payload: { target: { key: 'k' }, reason: 'r' },
  } as never
  const upgrade = (superseded: boolean) =>
    dispatcherAttention(
      {
        ...held,
        upgradeStatus: {
          current: {
            run: 'r',
            outcome: failed,
            ...(superseded ? { superseded: true } : {}),
          },
          previous: { run: 'p', outcome: failed, superseded: true },
        },
      },
      now,
    ).map((item) => item.kind)
  expect(upgrade(false)).toEqual(['upgrade-failed'])
  expect(upgrade(true)).toEqual([])
  const rollback = {
    payload: { failed: { version: '2.0.0' }, target: { key: 'k' } },
  } as RepositoryStatus['rollbackHold']
  expect(
    dispatcherAttention({ ...held, rollbackHold: rollback }, now).map((item) => item.kind),
  ).toEqual(['rollback'])
  const cooldown = dispatcherAttention(
    {
      ...held,
      forgeRateLimit: { limits: [], paused: true, pausedUntil: FAR },
      forgeDegradation: {
        forge: 'github',
        message: 'm',
        resetAt: FAR,
        firstFailureAt: FAR,
      },
    },
    now,
  )
  expect(cooldown.map((item) => [item.kind, item.resolve[0]])).toEqual([
    [
      'forge-cooldown',
      expect.objectContaining({
        tool: 'repository.forge_clear',
        input: { repo: REPO, forge: 'github' },
        by: 'operator',
      }),
    ],
  ])
})

test('cursor: baseline without one, typed conflict once expired, empty for an unknown repository', async () => {
  const store = new MemoryBuildStore({ clock })
  const registry = buildRegistry({ store, clock })
  const unknown = await attention(registry)
  expect([unknown.escalations, unknown.merges, unknown.waiting, unknown.events.items]).toEqual([
    [],
    [],
    [],
    [],
  ])
  await store.ensureRepo(REPO)
  await dispatcherRun(store)
  await build(store, 'blocked')
  await escalate(store, 'blocked', 'esc')
  await store.appendRepo(REPO, handedBack('T-1'))
  const baseline = await attention(registry)
  expect(baseline.events.items).toEqual([])
  expect(baseline.events.cursor).toBe(await store.getRepoHighWater(REPO))
  expect(baseline.escalations.map((item) => item.slug)).toEqual(['blocked'])
  for (let i = 0; i < REPOSITORY_TAIL_WINDOW + 1; i++)
    await store.appendRepo(REPO, {
      actor: humanActor('operator'),
      type: 'dispatcher.intake-set',
      payload: { enabled: true },
    })
  const expired = await attention(registry, 0).catch((error) => error)
  expect(expired).toBeInstanceOf(RegistryError)
  expect((expired as RegistryError).body).toMatchObject({
    kind: 'conflict',
    code: 'cursor-too-old',
  })
})
