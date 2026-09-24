/**
 * The acceptance evidence for the bounded repository-journal read (AUT-489):
 * after a long run of consecutive no-op hosted dispatcher invocations, the
 * number of journal events the stateless readers fetch is bounded by a
 * constant that does not depend on how many such invocations occurred, while
 * every reader still reports exactly what a full replay reports — including
 * a warning or failure the latest invocation raised.
 */
import { describe, expect, test } from 'bun:test'
import { DISPATCHER, humanActor, KERNEL } from '../events/envelope'
import { parseConfig } from '../config/load'
import { MemoryBuildStore } from '../store/memory'
import type { BuildStore, Clock } from '../store/types'
import type { RepositoryEvent } from '../events/repository'
import {
  effectiveConfig,
  getHarvestStatus,
  getOperatorDashboard,
  getRepositoryStatus,
} from './query'

const REPO = '/repo'
const now = new Date('2026-09-17T12:00:00.000Z')
const clock: Clock = () => now

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

function config() {
  return parseConfig(`
capacity = 2
[tickets]
source = "file"
readyState = "ready"
[policy]
harvestThreshold = 3
[verify]
steps = []
[finalize]
steps = []
`)
}

/** One no-op hosted dispatcher invocation: the ~4 facts an invocation appends
 * whether or not it did anything (lease held elsewhere → tick-yielded, or no
 * ready work → tick-completed). */
function noopInvocation(run: string, yielded: boolean) {
  return [
    {
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run,
        pid: 1,
        effectiveConfig: { kind: 'dispatcher-effective-config', rev: 0 },
        roleWarnings: [],
      },
    },
    yielded
      ? { actor: DISPATCHER, type: 'dispatcher.tick-yielded', payload: { run, holder: 'other' } }
      : {
          actor: DISPATCHER,
          type: 'dispatcher.tick-completed',
          payload: {
            run,
            queued: 0,
            counters,
            janitorDiagnostics: [],
            ticketDiagnostics: [],
            dependencyDiagnostics: [],
          },
        },
    {
      actor: DISPATCHER,
      type: 'dispatcher.run-stopped',
      payload: { run, outcome: 'normal' as const },
    },
  ]
}

/** Seed a repository with `invocations` no-op invocations plus the durable
 * signal: a settings toggle, a harvest run, a sandbox trail, and a final
 * invocation that failed its tick and raised a warning. */
async function seed(
  store: MemoryBuildStore,
  invocations: number,
  final: 'tick-failed' | 'operator-warning',
): Promise<void> {
  await store.ensureRepo(REPO)
  const artifact = await store.putRepoArtifact(REPO, {
    kind: 'dispatcher-effective-config',
    content: JSON.stringify({
      ...config(),
      verify: { steps: [] },
      finalize: { steps: [] },
    }),
  })
  for (let index = 0; index < invocations; index += 1) {
    for (const write of noopInvocation(`noop_${index}`, index % 2 === 0)) {
      await store.appendRepo(REPO, write as never)
    }
  }
  await store.appendRepo(REPO, {
    actor: humanActor('operator'),
    type: 'dispatcher.intake-set',
    payload: { enabled: false },
  })
  await store.appendRepo(REPO, {
    actor: KERNEL,
    type: 'harvest.started',
    payload: {
      run: 'h1',
      observations: [{ build: 'b1', seq: 1 }],
      scan: { kind: 'harvest-scan', rev: 0 },
    },
  })
  await store.appendRepo(REPO, {
    actor: KERNEL,
    type: 'harvest.step.started',
    payload: { run: 'h1', step: 'scan' },
  })
  await store.appendRepo(REPO, {
    actor: humanActor('operator'),
    type: 'orchestrator.sandbox.provisioned',
    payload: { operator: 'op', environmentId: 'env_1', provider: 'p', workspacePath: '/w' },
  })
  // The final invocation fails its tick and raises a standing warning: the
  // readers must keep surfacing both through the bounded read.
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'dispatcher.run-started',
    payload: {
      run: 'failed_1',
      pid: 2,
      effectiveConfig: { kind: 'dispatcher-effective-config', rev: artifact.revision },
      roleWarnings: ['role gap'],
    },
  })
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'dispatcher.tick-failed',
    payload: { run: 'failed_1', error: 'tick exploded' },
  })
  if (final === 'operator-warning') {
    await store.appendRepo(REPO, {
      actor: humanActor('operator'),
      type: 'dispatcher.operator-reported',
      payload: { run: 'failed_1', level: 'warning', message: 'check the dispatcher' },
    })
  }
}

/** A store wrapper that counts the journal rows each bounded read returns. */
function countingStore(store: BuildStore): { store: BuildStore; journalRows: () => number } {
  let rows = 0
  const target = store as unknown as Record<string, unknown>
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop === 'getRepoStateEvents') {
        return async (repo: string) => {
          const events = await (
            t.getRepoStateEvents as (repo: string) => Promise<RepositoryEvent[]>
          ).call(t, repo)
          rows += events.length
          return events
        }
      }
      if (prop === 'getRepoEvents') {
        return async (...args: unknown[]) => {
          const events = await (
            t.getRepoEvents as (...a: unknown[]) => Promise<RepositoryEvent[]>
          ).call(t, ...args)
          rows += events.length
          return events
        }
      }
      const value = Reflect.get(t, prop, t)
      return typeof value === 'function' ? value.bind(t) : value
    },
  })
  return { store: proxy as unknown as BuildStore, journalRows: () => rows }
}

/** The same store with the bounded read bypassed: every reader sees the full
 * journal, giving the full-replay ground truth for the equivalence assertion. */
function fullReplayStore(store: MemoryBuildStore): BuildStore {
  return new Proxy(store as unknown as Record<string, unknown>, {
    get(t, prop) {
      if (prop === 'getRepoStateEvents') {
        return async (repo: string) =>
          (t.getRepoEvents as (repo: string) => Promise<RepositoryEvent[]>).call(t, repo)
      }
      const value = Reflect.get(t, prop, t)
      return typeof value === 'function' ? value.bind(t) : value
    },
  }) as unknown as BuildStore
}

describe('bounded repository reads (AUT-489)', () => {
  test('the stateless readers fetch a bounded, invocation-count-independent number of journal events, and report the full-replay state', async () => {
    const measured: {
      invocations: number
      rows: number
      repositoryStatus: unknown
      harvestStatus: unknown
      dashboard: unknown
      config: unknown
    }[] = []
    for (const invocations of [1_000, 2_000]) {
      const store = new MemoryBuildStore({ clock })
      await seed(store, invocations, 'operator-warning')

      const counting = countingStore(store)
      const repositoryStatus = await getRepositoryStatus(counting.store, REPO)
      const harvestStatus = await getHarvestStatus(counting.store, REPO)
      const dashboard = await getOperatorDashboard({ store: counting.store, repo: REPO, clock })
      const config0 = await effectiveConfig(counting.store, REPO)
      const rows = counting.journalRows()

      // Every output equals the full-replay output over the same journal.
      const full = fullReplayStore(store)
      expect(repositoryStatus).toEqual(await getRepositoryStatus(full, REPO))
      expect(harvestStatus).toEqual(await getHarvestStatus(full, REPO))
      expect(dashboard).toEqual(await getOperatorDashboard({ store: full, repo: REPO, clock }))
      expect(config0.config).toEqual((await effectiveConfig(full, REPO)).config)

      measured.push({
        invocations,
        rows,
        repositoryStatus,
        harvestStatus,
        dashboard,
        config: config0,
      })
    }
    // The bound does not depend on the invocation count (both run lengths are
    // far past the 1,000 the acceptance criteria require).
    expect(measured[0]!.rows).toBe(measured[1]!.rows)
    expect(measured[0]!.rows).toBeGreaterThan(0)
  })

  test('a failed or warning-raising latest invocation stays visible through the bounded read', async () => {
    // A failed tick surfaces as the standing warning notice.
    const failed = new MemoryBuildStore({ clock })
    await seed(failed, 1_000, 'tick-failed')
    const failedDashboard = await getOperatorDashboard({ store: failed, repo: REPO, clock })
    expect(failedDashboard.model.warningLines).toContain('tick failed: tick exploded')

    // An operator-raised warning surfaces the same way.
    const warned = new MemoryBuildStore({ clock })
    await seed(warned, 1_000, 'operator-warning')
    const { config: config0 } = await effectiveConfig(warned, REPO)
    const dashboard = await getOperatorDashboard({ store: warned, repo: REPO, clock })
    expect(dashboard.model.warningLines).toContain('check the dispatcher')
    expect(config0.capacity).toBe(2)
    // And the durable settings from before the anchor still apply.
    expect(dashboard.settingsHeader.intake).toBe(false)
  })
})
