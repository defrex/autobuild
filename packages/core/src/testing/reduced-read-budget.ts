import { restoreReplay } from '../kernel/replay-retention'
import { reducerValueForClient } from '../store/remote/compatibility'
import { RELEASED_CLIENTS } from '../store/remote/released-clients'
import { missingAccountCredentials, reconcileMissingAccounts } from '../accounts/availability'
import { decideNextFromFacts } from '../kernel/engine'
import { proveTargetLineage } from '../kernel/target-lineage'
import { nodeRestackLog } from '../kernel/generators/node-restack-log'
import { REPLACED_HEADS_CAP } from '../kernel/read-facts'
import { observeTarget } from '../kernel/target-observation'
import { autoMergeDeferralObservation } from '../kernel/auto-merge'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DashboardBuildPollCache } from '../cli/dashboard/poll'
import { abDispatch } from '../cli/dispatch'
import { createTerminalModeController } from '../cli/terminal-restore'
import { randomUuids } from '../ids'
import { ScriptedAgentRunner, defaultTurnResult } from '../ports/runner/fake'
import { Dispatcher, defaultTriageState } from '../processes/dispatcher'
import { boundedStateCount } from '../ports/tickets/states'
import { FakeTicketSource } from '../ports/tickets/fake'
import { FakeWorkspaceProvider } from '../ports/workspace/fake'
import { FakeForge } from '../ports/forge/fake'
import { sequentialIds } from '../ids'
import { parseConfig } from '../config/load'
import {
  getOperatorDashboard,
  listOperatorBuilds,
  getOperatorBuild,
  getRepositoryStatus,
} from '../operator/query'
import { buildRegistry } from '../operator/registry'
import { expect } from 'bun:test'
import type { BuildStore } from '../store/types'
import type { TicketRef } from '../ontology'
import { KERNEL, DISPATCHER, humanActor } from '../events/envelope'
import {
  readBuildFacts,
  readBuildStreamSeed,
  readDispatchBudget,
  readRepositoryFacts,
  readForgeHealth,
  readRepositoryAttention,
  readBuildDigests,
  readDispatcherRunFacts,
  readOpenTick,
  readHostedHarvestAuthority,
} from '../store/reduced-reads'
import { decideHostedHarvestAuthority } from '../processes/harvest-execution-state'
import { RepoViewStore } from '../processes/repo-view'
import { settlePendingPublication } from '../cli/publication-settlement'
import {
  readLaunchFence,
  refreshSummaryBoundary,
  settleSummaryRequests,
  summaryHandoffPending,
} from '../cli/pr-summary-publication'
import { ForgeRequestDeferred } from '../ports/forge-request-context'
import { abWatch, decodeCursor } from '../cli/watch'
import { abWait } from '../cli/wait'
import { TRIAGE_COUNT_REFRESH_MS } from '../cli/triage-count-sampler'
import type { Exec } from '../ports/workspace/git-worktree'
export { syntheticPresenceObservation } from './presence-history'

export interface ReducedReadCosts {
  events: number
  metadata: number
  bytes: number
  historicalEvents: number
  history?: { repo: string; through: number }
}
const repo = '/reduced-read-budget'
const slug = 'reduced-budget'
const exec: Exec = async (args) =>
  args[1] === 'remote'
    ? { stdout: '', stderr: 'no origin', exitCode: 2 }
    : { stdout: `${repo}/.git\n${repo}/.git\n${repo}\n`, stderr: '', exitCode: 0 }

/** Shared actual-consumer scenario. Costs must instrument SQL statement results,
 * including private reducer storage, rather than just public getEvents calls. */
export async function reducedReadBudget(opts: {
  store: BuildStore
  costs: ReducedReadCosts
  fresh: () => Promise<BuildStore>
  storeRef?: string
}) {
  const { store, costs } = opts
  await store.ensureRepo(repo)
  const config = parseConfig(
    '[tickets]\nsource="file"\nreadyState="ready"\n[verify]\nsteps=[]\n[finalize]\nsteps=[]',
  )
  const { verify: _verify, finalize: _finalize, ...root } = config
  const configArtifact = await store.putRepoArtifact(repo, {
    kind: 'dispatcher-effective-config',
    content: JSON.stringify({ ...root, verify: { steps: [] }, finalize: { steps: [] } }),
  })
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.run-started',
    payload: {
      run: 'budget-run',
      pid: 1,
      roleWarnings: [],
      effectiveConfig: { kind: configArtifact.kind, rev: configArtifact.revision },
    },
  })
  await store.createBuild({ slug, repo })
  // Recovery artifacts must never be consulted for an already-present commit,
  // including through fresh adapter instances.
  for (const client of [store, await opts.fresh()]) {
    let replayReads = 0
    const recoveryStore = new Proxy(client, {
      get(target, property) {
        if (property === 'getArtifact')
          return async (...args: Parameters<BuildStore['getArtifact']>) => {
            replayReads++
            return target.getArtifact(...args)
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const recovery = {
      store: recoveryStore,
      slug,
      workspacePath: repo,
      forge: new FakeForge(),
      exec,
    }
    expect(await restoreReplay(recovery, 'a'.repeat(40))).toBe(true)
    expect(replayReads).toBe(0)
    expect(
      await restoreReplay(
        { ...recovery, exec: async () => ({ stdout: '', stderr: '', exitCode: 1 }) },
        'a'.repeat(40),
      ),
    ).toBe(false)
    expect(replayReads).toBe(1)
  }

  await store.append(slug, {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'budget', host: 'host' },
  })
  await store.append(slug, {
    actor: KERNEL,
    type: 'finalize.completed',
    payload: { pr: { number: 7, url: 'https://example.test/7', headSha: 'abc' } },
  })
  await store.append(slug, {
    actor: KERNEL,
    type: 'landing.decided',
    payload: {
      candidate: { head: 'abc', parent: 'base', cycle: '1' },
      from: 'leaf',
      into: { kind: 'root' },
      labels: [],
      mode: 'consent',
      rule: { default: true },
    },
  })
  const gateCommand = await store.append(slug, {
    actor: humanActor('human'),
    type: 'build.auto-merge-requested',
    payload: {},
  })
  await store.append(
    slug,
    autoMergeDeferralObservation(
      { code: 'repository-auto-merge-disabled', detail: 'disabled' },
      7,
      gateCommand.seq,
      'historical-gate',
    ),
  )
  const revisedSlug = 'revised-reconcile-budget'
  const revisedRepo = `${repo}/revised`
  await store.ensureRepo(revisedRepo)
  await store.createBuild({ slug: revisedSlug, repo: revisedRepo })
  await store.append(revisedSlug, {
    actor: DISPATCHER,
    type: 'spec.imported',
    payload: { artifact: { kind: 'spec', rev: 0 }, ticket: { source: 'file', id: revisedSlug } },
  })
  await store.append(revisedSlug, {
    actor: KERNEL,
    type: 'reconcile.started',
    payload: { attempt: 1, baseSha: 'base' },
  })
  const escalation = await store.append(revisedSlug, {
    actor: KERNEL,
    type: 'escalation.raised',
    payload: {
      id: 'revision',
      source: 'policy',
      policyCause: 'phase-attempt-limit',
      phase: 'reconcile',
      question: 'Revise?',
    },
  })
  await store.append(revisedSlug, {
    actor: humanActor('human'),
    type: 'escalation.answered',
    payload: { id: 'revision', answer: 'Revised', resolution: 'revise-spec' },
  })
  await store.append(revisedSlug, {
    actor: KERNEL,
    type: 'spec.revised',
    payload: { artifact: { kind: 'spec', rev: 1 }, escalation: escalation.seq },
  })
  const targetForge = new FakeForge()
  const target = 'a'.repeat(40)
  await observeTarget({
    store,
    forge: targetForge,
    slug,
    branch: 'main',
    sha: target,
    actor: KERNEL,
  })
  const reset = () => {
    costs.events = 0
    costs.metadata = 0
    costs.bytes = 0
  }
  let repositoryBytes: number | undefined
  let deferredScanProbe: { metadata: number; bytes: number } | undefined
  for (const length of [32, 256]) {
    for (let i = 0; i < length; i++) {
      await store.append(slug, {
        actor: humanActor('human'),
        type: 'build.auto-merge-requested',
        payload: {},
      })
      await store.append(revisedSlug, {
        actor: humanActor('human'),
        type: 'build.auto-merge-requested',
        payload: {},
      })
      await store.appendRepo(repo, {
        actor: humanActor('human'),
        type: 'dispatcher.intake-set',
        payload: { enabled: true },
      })
      const run = `old-${length}-${String(i).padStart(4, '0')}`
      await store.appendRepo(repo, {
        actor: DISPATCHER,
        type: 'dispatcher.run-started',
        payload: {
          run,
          pid: 1,
          roleWarnings: [],
          effectiveConfig: { kind: configArtifact.kind, rev: configArtifact.revision },
        },
      })
      await store.appendRepo(repo, {
        actor: DISPATCHER,
        type: 'dispatcher.run-stopped',
        payload: { run, outcome: 'normal' },
      })
    }
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run: 'budget-run',
        pid: 1,
        roleWarnings: [],
        effectiveConfig: { kind: configArtifact.kind, rev: configArtifact.revision },
      },
    })
    const {
      scan,
      scanSeq: _scanSeq,
      ...stableFacts
    } = (await readRepositoryFacts(store, repo)).value
    // The first iteration introduces a scan; its fixed payload is budgeted independently.
    expect(Buffer.byteLength(JSON.stringify(scan ?? null))).toBeLessThan(1_000_000)
    const factsBytes = Buffer.byteLength(JSON.stringify(stableFacts))
    if (repositoryBytes !== undefined) expect(factsBytes).toBeLessThan(repositoryBytes + 512)
    repositoryBytes = factsBytes
    // A credential limit seen outside the dispatcher joins the saved
    // repository value; it adds no read to the guarded-call health check.
    await store.appendRepo(repo, {
      actor: KERNEL,
      type: 'forge.credential-limited',
      payload: {
        forge: 'github',
        process: 'build-runner budget',
        credential: 'unauthenticated',
        missingCredential: 'GITHUB_TOKEN and GH_TOKEN are unset',
        message: 'API rate limit exceeded',
        resetAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + length * 1000).toISOString(),
      },
    })
    // Warm persisted values independently of any consumer instance.
    await readBuildStreamSeed(store, slug)
    await readBuildFacts(store, slug)
    await readBuildFacts(store, revisedSlug)
    await readRepositoryFacts(store, repo)
    await readForgeHealth(store, repo)
    await readBuildDigests(store, repo)
    await readRepositoryAttention(store, repo)
    const handle = await opts.fresh()
    const cold = new Proxy(handle, {
      get(target, key) {
        if (key === 'close') return async () => {}
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    // Explicit operation multiplication on fresh handles at both history sizes.
    // Unchanged reduced reads never acquire historical event rows.
    for (const operations of [1, 8]) {
      reset()
      for (let n = 0; n < operations; n++) {
        const canonical = await cold.getReducerValue(
          { kind: 'build', slug },
          { reducer: 'buildReadFacts' },
        )
        for (const release of RELEASED_CLIENTS) {
          const unknownLatest = structuredClone(canonical)
          if (
            unknownLatest.value &&
            typeof unknownLatest.value === 'object' &&
            'state' in unknownLatest.value
          ) {
            const state = unknownLatest.value.state as Record<string, unknown>
            state.lastEvent = {
              type: 'future.optional-display',
              seq: canonical.cursor,
              payload: {},
            }
          }
          const projected = reducerValueForClient(
            { version: release.version, projects: release.projects ?? false },
            'buildReadFacts',
            unknownLatest,
          )
          expect(projected.cursor).toBe(canonical.cursor)
        }
        await readBuildFacts(cold, slug)
        const revised = (await readBuildFacts(cold, revisedSlug)).value
        expect(decideNextFromFacts(revised.state, revised.log, config)).toEqual({
          kind: 'run-phase',
          phase: 'reconcile',
          round: 1,
          reconcile: { attempt: 1 },
        })
        expect(
          await observeTarget({
            store: cold,
            forge: targetForge,
            slug,
            branch: 'main',
            sha: target,
            actor: KERNEL,
          }),
        ).toBe('unchanged')
        // Latest per (forge, process): repeated limits replace, never accumulate.
        expect((await readRepositoryFacts(cold, repo)).value.forgeCredentialLimits).toHaveLength(1)
      }
      expect(costs.events).toBe(0)
      expect(costs.metadata).toBeLessThan(operations * 20)
    }
    // The guarded-call health check stays clear and flat per call beside
    // a saved credential limit.
    for (const operations of [1, 8]) {
      reset()
      for (let n = 0; n < operations; n++) {
        expect(await readForgeHealth(cold, repo)).toBeUndefined()
      }
      expect(costs.events).toBe(0)
      expect(costs.metadata).toBeLessThan(operations * 10)
    }
    // Account holds survive fresh consumers and reconcile without idle journal reads or writes.
    const missing = missingAccountCredentials(
      { billing: { kind: 'claude-subscription', credentialEnv: 'BILLING_TOKEN' } },
      {},
      'project-secrets',
    )
    await reconcileMissingAccounts(
      missing,
      (await readRepositoryFacts(store, repo)).value.missingAccounts,
      (event) => store.appendRepo(repo, event),
    )
    await readRepositoryFacts(store, repo) // durable reducer advances exactly once
    const heldPosition = await store.getRepoHighWater(repo)
    reset()
    for (let tick = 0; tick < 8; tick++) {
      const fresh = await opts.fresh()
      // The harness owns the shared connection; these are fresh adapter facades.
      const facts = (await readRepositoryFacts(fresh, repo)).value
      expect(Object.keys(facts.missingAccounts)).toEqual(['billing'])
      await reconcileMissingAccounts(missing, facts.missingAccounts, (event) =>
        fresh.appendRepo(repo, event),
      )
    }
    expect(costs.events).toBe(0)
    expect(await store.getRepoHighWater(repo)).toBe(heldPosition)
    await reconcileMissingAccounts(
      [],
      (await readRepositoryFacts(store, repo)).value.missingAccounts,
      (event) => store.appendRepo(repo, event),
    )
    await readRepositoryFacts(store, repo)
    await readRepositoryAttention(store, repo)
    reset()
    expect((await readRepositoryFacts(cold, repo)).value.missingAccounts).toEqual({})
    expect(costs.events).toBe(0)
    // A new dashboard on every invocation must use canonical persisted facts,
    // even after the build exceeds the hosted page cap. Warm and cold polls
    // select zero event rows at either history length.
    reset()
    for (let invocation = 0; invocation < 3; invocation++) {
      const dashboard = new DashboardBuildPollCache(cold, repo, config)
      expect((await dashboard.refresh()).states.get(slug)?.status).toBe('running')
      await dashboard.refresh()
    }
    expect(costs.events).toBe(0)
    expect(costs.metadata).toBeLessThan(100)
    await coldDispatchOnceBudget(store, cold, length, costs)
    await coldDispatchOnceBudget(store, cold, length, costs, true)
    await coldDispatchOnceBudget(store, cold, length, costs, true, true)
    reset()
    const view = new RepoViewStore(cold, { repo })
    await view.refresh()
    expect((await view.buildFacts(slug)).state.pr?.number).toBe(7)
    expect((await view.buildState(slug)).status).toBe('running')
    expect(costs.events).toBe(0)
    expect(costs.metadata).toBeLessThan(100)

    let scanTime = 1000
    const dispatcher = () =>
      new Dispatcher({
        store: cold,
        repo,
        config,
        tickets: new FakeTicketSource([]),
        workspaces: new FakeWorkspaceProvider({ root: '/budget-workspaces', mode: 'logical' }),
        forge: new FakeForge(),
        ids: sequentialIds(),
        clock: () => new Date(scanTime),
        exec,
        launchRunner: async () => 'scheduled',
      })
    await dispatcher().observeReady()
    // A fresh journal anchor per length keeps the cadence counts identical.
    const latest = (await readRepositoryFacts(cold, repo)).value.scan
    if (latest === undefined) throw new Error('missing ticket scan fact')
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.ticket-scan-completed',
      payload: { ...latest, startedAt: new Date(scanTime).toISOString() },
    })
    const scanSeq = (await readRepositoryFacts(cold, repo)).value.scanSeq
    let cadenceReads = 0
    let cadenceWrites = 0
    const countedHandle = async () => {
      const freshHandle = await opts.fresh()
      const counted = new Proxy(freshHandle, {
        get(target, key) {
          if (key === 'getScanCadence')
            return async (...args: Parameters<BuildStore['getScanCadence']>) => {
              cadenceReads++
              return target.getScanCadence(...args)
            }
          if (key === 'putScanCadence')
            return async (...args: Parameters<BuildStore['putScanCadence']>) => {
              cadenceWrites++
              return target.putScanCadence(...args)
            }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      return { freshHandle, counted }
    }
    const scanDispatcher = (counted: BuildStore) =>
      new Dispatcher({
        store: counted,
        repo,
        config,
        tickets: new FakeTicketSource([]),
        workspaces: new FakeWorkspaceProvider({ root: '/budget-workspaces', mode: 'logical' }),
        forge: new FakeForge(),
        ids: sequentialIds(),
        clock: () => new Date(scanTime),
        exec,
        launchRunner: async () => 'scheduled',
      })
    // While the journal measurement alone proves the scan is not due, fresh
    // processes make no cadence request and read no event rows.
    const anchorTime = scanTime
    let deferred: { metadata: number; bytes: number } | undefined
    for (let k = 1; k < 6; k++) {
      scanTime = anchorTime + k * 10_000
      const { freshHandle, counted } = await countedHandle()
      reset()
      await scanDispatcher(counted).observeReady()
      deferred ??= { metadata: costs.metadata, bytes: costs.bytes }
      expect(costs.events).toBe(0)
      expect(cadenceReads).toBe(0)
      expect((await readRepositoryFacts(freshHandle, repo)).value.scanSeq).toBe(scanSeq)
    }
    if (deferredScanProbe === undefined) deferredScanProbe = deferred
    else {
      // Flat with history: the repository facts value is bounded, as above.
      expect(deferred!.metadata).toBe(deferredScanProbe!.metadata)
      expect(deferred!.bytes).toBeLessThan(deferredScanProbe!.bytes + 512)
    }
    // At the interval the row is consulted; the unchanged scan advances only it.
    scanTime = anchorTime + 60_000
    {
      const { freshHandle, counted } = await countedHandle()
      reset()
      await scanDispatcher(counted).observeReady()
      expect(costs.events).toBe(0)
      expect(cadenceReads).toBe(1)
      expect(cadenceWrites).toBe(1)
      expect(deferred!.metadata).toBeLessThan(costs.metadata)
      expect((await readRepositoryFacts(freshHandle, repo)).value.scanSeq).toBe(scanSeq)
    }
    for (let interval = 0; interval < 3; interval++) {
      const { freshHandle, counted } = await countedHandle()
      const observe = () => scanDispatcher(counted).observeReady()
      scanTime += 30_000
      reset()
      await observe()
      expect(costs.events).toBe(0)
      expect(costs.metadata).toBeLessThan(100)
      scanTime += 30_000
      reset()
      await observe()
      expect(costs.events).toBe(0)
      expect(costs.metadata).toBeLessThan(100)
      expect((await readRepositoryFacts(freshHandle, repo)).value.scanSeq).toBe(scanSeq)
    }
    expect(cadenceReads).toBe(7)
    expect(cadenceWrites).toBe(4)
    await dispatcher().tick({ acceptNewWork: false })
    await getOperatorDashboard({ store: cold, repo, clock: () => new Date(1000) })
    reset()
    await dispatcher().tick({ acceptNewWork: false })
    await getOperatorDashboard({ store: cold, repo, clock: () => new Date(1000) })
    await listOperatorBuilds({ store: cold, repo, scope: 'all', now: new Date(1000) })
    await getOperatorBuild({ store: cold, repo, slug, now: new Date(1000) })
    await getRepositoryStatus(cold, repo, new Date(1000))
    await buildRegistry({ store: cold, clock: () => new Date(1000) }).call('builds.get', {
      repo,
      slug,
    })
    expect(costs.events).toBe(0)
    expect(costs.metadata).toBeLessThan(400)
    expect(costs.bytes).toBeLessThan(1_000_000)

    // A fresh watch must suppress historical gate attention despite armed
    // consent at registration, including its first event-bearing poll.
    reset()
    let ticks = 0
    let time = 0
    const out: string[] = []
    await abWatch({
      targetRepo: repo,
      env: {},
      exec,
      storeRef: opts.storeRef ?? '/budget',
      openStore: () => cold,
      slugs: [slug],
      json: true,
      timeout: '2',
      now: () => new Date(time),
      stdout: (line) => out.push(line),
      stderr: () => {},
      delay: async () => {
        time += 1000
        if (++ticks === 1)
          await store.append(slug, {
            actor: humanActor('human'),
            type: 'build.auto-merge-cancelled',
            payload: {},
          })
      },
    })
    expect(out).toHaveLength(1)
    const cursor = JSON.parse(out[0]!).cursor
    expect(
      decodeCursor(cursor, { store: opts.storeRef ?? '/budget', repo }).deliveredAttention,
    ).toEqual([JSON.stringify([slug, 7])])
    expect(costs.events).toBeLessThanOrEqual(4)
    expect(costs.metadata).toBeLessThan(100)

    await store.append(slug, {
      actor: humanActor('human'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    await readBuildStreamSeed(store, slug)
    reset()
    let discoveryTick = 0
    time = 0
    const discovered = new Proxy(cold, {
      get(target, key) {
        if (key === 'listBuilds')
          return async () => (discoveryTick === 0 ? [] : target.listBuilds())
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const discoveryOut: string[] = []
    await abWatch({
      targetRepo: repo,
      env: {},
      exec,
      storeRef: opts.storeRef ?? '/budget',
      openStore: () => discovered,
      json: true,
      timeout: '3',
      now: () => new Date(time),
      stdout: (line) => discoveryOut.push(line),
      stderr: () => {},
      delay: async () => {
        time += 1000
        if (++discoveryTick === 2)
          await store.append(slug, {
            actor: humanActor('human'),
            type: 'build.auto-merge-cancelled',
            payload: {},
          })
      },
    })
    expect(discoveryOut).toHaveLength(1)
    expect(costs.events).toBeLessThanOrEqual(6)
    expect(costs.metadata).toBeLessThan(180)

    // Wait applies its current gate-attention policy instead of watch suppression.
    const immediateCommand = await store.append(slug, {
      actor: humanActor('human'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    await store.append(
      slug,
      autoMergeDeferralObservation(
        { code: 'repository-auto-merge-disabled', detail: 'disabled' },
        7,
        immediateCommand.seq,
        `gate-wait-${length}`,
      ),
    )
    await readBuildStreamSeed(store, slug)
    reset()
    const waitOut: string[] = []
    const result = await abWait({
      targetRepo: repo,
      env: {},
      exec,
      storeRef: opts.storeRef ?? '/budget',
      openStore: () => cold,
      slugs: [slug],
      forValues: ['attention'],
      json: true,
      now: () => new Date(time),
      stdout: (line) => waitOut.push(line),
      stderr: () => {},
    })
    expect(result).toBe(0)
    expect(JSON.parse(waitOut[0]!).observation.pr.number).toBe(7)
    expect(costs.events).toBe(0)
    expect(costs.metadata).toBeLessThan(40)
    const waitCommand = await store.append(slug, {
      actor: humanActor('human'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    await readBuildStreamSeed(store, slug)
    reset()
    let waitTick = 0
    time = 0
    const polled: string[] = []
    const waited = await abWait({
      targetRepo: repo,
      env: {},
      exec,
      storeRef: opts.storeRef ?? '/budget',
      openStore: () => cold,
      slugs: [slug],
      forValues: ['attention'],
      json: true,
      timeout: '4',
      now: () => new Date(time),
      stdout: (line) => polled.push(line),
      stderr: () => {},
      delay: async () => {
        time += 1000
        // The first pass stays idle; the next delivers the first event batch.
        if (++waitTick === 1) {
          expect(costs.events).toBe(0)
          expect(costs.metadata).toBeLessThan(40)
        }
        if (waitTick === 2) {
          expect(costs.events).toBe(0)
          await store.append(
            slug,
            autoMergeDeferralObservation(
              { code: 'repository-auto-merge-disabled', detail: 'disabled' },
              7,
              waitCommand.seq,
              `gate-poll-${length}`,
            ),
          )
        }
      },
    })
    expect(waited).toBe(0)
    expect(waitTick).toBe(2)
    expect(JSON.parse(polled[0]!).observation.pr.number).toBe(7)
    expect(costs.events).toBeLessThanOrEqual(2)
    expect(costs.metadata).toBeLessThan(50)
  }
}

/** Same SQL-instrumented harness, with indexed receipt reads rather than a
 * growing reduced receipt map. Both warmed and fresh processes pay per gap. */
export async function targetLineageReadBudget(opts: {
  store: BuildStore
  costs: ReducedReadCosts
  fresh: () => Promise<BuildStore>
}) {
  const { store, costs } = opts
  const node = 'lineage-budget'
  const oid = (n: number) => n.toString(16).padStart(40, '0')
  await store.createBuild({ slug: node, repo, branch: 'ab-node/lineage-budget' })
  const log = nodeRestackLog()
  for (const event of log.slice(0, 2)) await store.append(node, event)
  for (let i = 1; i <= 3; i++)
    for (const event of log.slice(2)) {
      const payload = JSON.parse(
        JSON.stringify(event.payload)
          .replaceAll('node-tx', `tx-${i}`)
          .replaceAll('a'.repeat(40), oid(i))
          .replaceAll('c'.repeat(40), oid(i + 1)),
      )
      await store.append(node, { actor: event.actor, type: event.type, payload })
    }
  const forge = new FakeForge()
  for (let i = 1; i <= 4; i++) forge.seedCommit(oid(i))
  const bytes = new Map<number, number>()
  let paddingEvents = 0
  let paddingTransaction = 100
  for (const length of [100, 10_000]) {
    // Grow receipt count as well as journal length. Every padding publication
    // is a complete valid transaction with a disjoint previous-head key.
    while (paddingEvents < length) {
      const id = paddingTransaction++
      for (const event of log.slice(2)) {
        const payload = JSON.parse(
          JSON.stringify(event.payload)
            .replaceAll('node-tx', `padding-${id}`)
            .replaceAll('a'.repeat(40), oid(id * 2))
            .replaceAll('c'.repeat(40), oid(id * 2 + 1)),
        )
        await store.append(node, { actor: event.actor, type: event.type, payload })
        paddingEvents++
      }
    }
    const gapStart = 50_000 + length
    for (let i = 0; i < 3; i++) {
      for (const event of log.slice(2)) {
        const payload = JSON.parse(
          JSON.stringify(event.payload)
            .replaceAll('node-tx', `gap-${length}-${i}`)
            .replaceAll('a'.repeat(40), oid(gapStart + i * 2))
            .replaceAll('c'.repeat(40), oid(gapStart + i * 2 + 1)),
        )
        await store.append(node, { actor: event.actor, type: event.type, payload })
      }
      forge.seedCommit(oid(gapStart + i * 2))
      forge.seedCommit(oid(gapStart + i * 2 + 1))
      if (i > 0) forge.seedCommit(oid(gapStart + i * 2), [oid(gapStart + i * 2 - 1)])
    }
    for (const reader of [store, await opts.fresh()]) {
      costs.events = costs.metadata = costs.bytes = 0
      const proof = await proveTargetLineage({
        store: reader,
        forge,
        node,
        branch: 'ab-node/lineage-budget',
        from: oid(gapStart),
        sha: oid(gapStart + 5),
      })
      expect(proof?.receipts).toHaveLength(3)
      expect(costs.events).toBe(4) // exact first receipt, then three reverse cursor reads
      expect(costs.metadata).toBeLessThan(12)
      if (length === 100) bytes.set(0, costs.bytes)
      else expect(costs.bytes).toBeLessThanOrEqual(bytes.get(0)! + 100)
    }
    for (const reader of [store, await opts.fresh()])
      for (const gap of [1, 3]) {
        costs.events = costs.metadata = costs.bytes = 0
        const proof = await proveTargetLineage({
          store: reader,
          forge,
          node,
          branch: 'ab-node/lineage-budget',
          from: oid(4 - gap),
          sha: oid(4),
        })
        expect(proof?.receipts).toHaveLength(gap)
        expect(costs.events).toBe(gap)
        expect(costs.metadata).toBeLessThan(12)
        if (length === 100) bytes.set(gap, costs.bytes)
        else expect(costs.bytes).toBeLessThanOrEqual(bytes.get(gap)! + 100)
      }
  }
}

/** Exercise the real outer DispatchLoop with a new invocation identity, either
 * once or for cold and warmed interactive ticks. Only shared values are warmed:
 * no parameterized run value may hide a cold replay. */
/** A finalize request parked behind its forge-rejection escalation costs the
 * same at every journal length and reads no event rows while nothing changes:
 * no provider probe, description read or forge request per tick. */
export async function finalizePrRejectionReadBudget(opts: {
  store: BuildStore
  costs: ReducedReadCosts
  fresh: () => Promise<BuildStore>
}) {
  const { store, costs } = opts
  const build = 'finalize-rejection-budget'
  const branch = `ab/${build}`
  const sha = 'f'.repeat(40)
  await store.createBuild({ slug: build, repo, branch })
  await store.append(build, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: { ticket: { source: 'file', id: 'BUDGET-PR' }, repo, baseBranch: 'main' },
  })
  await store.append(build, {
    actor: KERNEL,
    type: 'workspace.provisioned',
    payload: {
      provider: 'vercel-sandbox',
      remote: true,
      ref: 'sandbox-budget',
      branch,
      base: { source: 'remote', sha: 'e'.repeat(40) },
    },
  })
  const description = await store.putArtifact(build, {
    kind: 'pr-description',
    content: '# Budget\n\nBody.\n',
  })
  await store.append(build, {
    actor: { kind: 'agent', role: 'finalize', session: 'budget-finalize' },
    type: 'publication.requested',
    payload: {
      operation: 'finalize',
      branch,
      sha,
      description: { kind: description.kind, rev: description.revision },
    },
  })
  const forge = new FakeForge()
  forge.setHeadSha(sha)
  forge.rejectNextOpenPr(422, 'Validation Failed: No commits between main and ab/x', 'GitHub')
  let probes = 0
  const settle = (reader: BuildStore) =>
    settlePendingPublication(
      {
        store: reader,
        storeRef: 'budget',
        publication: {
          isPublished: async () => {
            probes++
            return true
          },
          publish: async () => {},
        },
        forge,
        workspacePath: '/budget',
        checkoutless: true,
        exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        ids: sequentialIds(),
        runId: 'budget',
      },
      build,
    )
  await expect(settle(store)).rejects.toBeInstanceOf(ForgeRequestDeferred)
  const raised = async () =>
    (await store.getEvents(build)).filter((event) => event.type === 'escalation.raised').length
  expect(await raised()).toBe(1)
  const bytes = new Map<string, number>()
  let metadata: number | undefined
  let seeded = (await store.getEvents(build)).length
  for (const length of [100, 10_000]) {
    for (; seeded < length; seeded++)
      await store.append(build, {
        actor: humanActor('budget'),
        type: 'build.auto-merge-cancelled',
        payload: {},
      })
    for (const [name, reader] of [
      ['live', store],
      ['fresh', await opts.fresh()],
    ] as const) {
      // Catching up to the padded tail is allowed once per reader.
      await expect(settle(reader)).rejects.toBeInstanceOf(ForgeRequestDeferred)
      costs.events = costs.metadata = costs.bytes = 0
      probes = 0
      const attempts = forge.openPrAttempts
      for (let tick = 0; tick < 3; tick++)
        await expect(settle(reader)).rejects.toBeInstanceOf(ForgeRequestDeferred)
      expect(costs.events).toBe(0)
      expect(probes).toBe(0)
      expect(forge.openPrAttempts).toBe(attempts)
      if (length === 100) {
        metadata ??= costs.metadata
        expect(costs.metadata).toBeLessThan(20)
        bytes.set(name, costs.bytes)
      } else {
        // Seq digits grow in the saved value; allow 100 bytes per measured call.
        expect(costs.bytes).toBeLessThanOrEqual(bytes.get(name)! + 300)
      }
      expect(costs.metadata).toBe(metadata!)
    }
  }
  expect(forge.openPrAttempts).toBe(1)
  expect(await raised()).toBe(1)
}

/** Remote summary handoff: the dispatcher's launch fence and exit
 * classification plus the guest's coalescing boundary read reduced values
 * only, at constant cost in build length. */
export async function summaryHandoffReadBudget(opts: {
  store: BuildStore
  costs: ReducedReadCosts
  fresh: () => Promise<BuildStore>
}) {
  const { store, costs } = opts
  const build = 'summary-handoff-budget'
  const branch = `ab/${build}`
  await store.createBuild({ slug: build, repo, branch })
  await store.append(build, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: { ticket: { source: 'file', id: 'BUDGET-SUMMARY' }, repo, baseBranch: 'main' },
  })
  await store.append(build, {
    actor: KERNEL,
    type: 'workspace.provisioned',
    payload: {
      provider: 'vercel-sandbox',
      remote: true,
      ref: 'sandbox-summary',
      branch,
      base: { source: 'remote', sha: 'e'.repeat(40) },
    },
  })
  const forge = new FakeForge()
  const pr = await forge.openPr({
    workspacePath: '/budget',
    head: branch,
    base: 'main',
    title: 'Budget',
    body: '',
  })
  await store.append(build, { actor: KERNEL, type: 'finalize.completed', payload: { pr } })
  await store.append(build, {
    actor: KERNEL,
    type: 'verify.started',
    payload: { step: 'unit', attempt: 1 },
  })
  await store.append(build, {
    actor: KERNEL,
    type: 'verify.completed',
    payload: { step: 'unit', attempt: 1, outcome: 'pass' },
  })
  const deps = (reader: BuildStore) => ({
    store: reader,
    forge,
    slug: build,
    workspacePath: '/budget',
    storeRef: 'budget',
    clock: () => new Date(),
  })
  // Launch fence, then the guest writes its request and exits.
  const fence = await readLaunchFence(store, build)
  expect(await refreshSummaryBoundary(deps(store))).toBe(true)
  expect(summaryHandoffPending((await readBuildFacts(store, build)).value, fence)).toBe(true)
  await settleSummaryRequests({ ...deps(store), holder: 'budget-host' })
  expect(forge.comments).toHaveLength(1)
  // One launch and exit: fence, completion classification, guest boundary.
  const sequence = async (reader: BuildStore, launchFence: number) => {
    const next = await readLaunchFence(reader, build)
    const pending = summaryHandoffPending((await readBuildFacts(reader, build)).value, launchFence)
    const yielded = await refreshSummaryBoundary(deps(reader), {
      continuesVerifyCycle: true,
      reassert: true,
    })
    return { next, pending, yielded }
  }
  const bytes = new Map<string, number>()
  let metadata: number | undefined
  let seeded = (await store.getEvents(build)).length
  for (const length of [100, 10_000]) {
    for (; seeded < length; seeded++)
      await store.append(build, {
        actor: humanActor('budget'),
        type: 'build.auto-merge-cancelled',
        payload: {},
      })
    for (const [name, reader] of [
      ['live', store],
      ['fresh', await opts.fresh()],
    ] as const) {
      // Catching up to the padded tail is allowed once per reader.
      const launchFence = (await sequence(reader, fence)).next
      costs.events = costs.metadata = costs.bytes = 0
      for (let exit = 0; exit < 3; exit++)
        expect(await sequence(reader, launchFence)).toEqual({
          next: launchFence,
          pending: false,
          yielded: false,
        })
      expect(costs.events).toBe(0)
      if (length === 100) {
        metadata ??= costs.metadata
        expect(costs.metadata).toBeLessThan(20)
        bytes.set(name, costs.bytes)
      } else {
        // Seq digits grow in the saved value; allow 100 bytes per measured call.
        expect(costs.bytes).toBeLessThanOrEqual(bytes.get(name)! + 300)
      }
      expect(costs.metadata).toBe(metadata!)
    }
  }
  // A guest-written request is the only new tail the next exit reads.
  const launchFence = await readLaunchFence(store, build)
  const fresh = await opts.fresh()
  await sequence(fresh, launchFence)
  await store.append(build, {
    actor: KERNEL,
    type: 'pr-summary.requested',
    payload: (await readBuildFacts(store, build)).value.summaryBoundary!,
  })
  for (const reader of [store, fresh]) {
    costs.events = 0
    expect((await sequence(reader, launchFence)).pending).toBe(true)
    expect(costs.events).toBeLessThanOrEqual(3)
  }
  expect(forge.comments).toHaveLength(1)
}

async function coldDispatchOnceBudget(
  store: BuildStore,
  cold: BuildStore,
  length: number,
  costs: ReducedReadCosts,
  interactive = false,
  outage = false,
) {
  const onceRepo = outage
    ? 'https://github.com/budget/outage-ticks'
    : interactive
      ? 'https://github.com/budget/interactive-ticks'
      : 'https://github.com/budget/cold-once'
  await store.ensureRepo(onceRepo)
  for (let i = 0; i < length; i++)
    await store.appendRepo(onceRepo, {
      actor: humanActor('human'),
      type: 'dispatcher.intake-set',
      payload: { enabled: false },
    })
  const boundary = (await readRepositoryFacts(store, onceRepo)).cursor
  await readForgeHealth(store, onceRepo)
  const directory = await mkdtemp(join(tmpdir(), 'ab-cold-once-'))
  try {
    await writeFile(
      join(directory, 'autobuild.toml'),
      `[roles.default]
runtime = "claude"
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = []
[finalize]
steps = []
`,
    )
    const acquisitions = { facts: 0, digests: 0 }
    const stop = new AbortController()
    let ticks = 0
    let ticketScanWrites = 0
    let deferredAttempts = 0
    let tickAcquisitions = { facts: 0, digests: 0 }
    // The display-only triage sample is read only by a dispatcher that feeds
    // an interactive frontend, between ticks and at most once per
    // TRIAGE_COUNT_REFRESH_MS; no read ever lands inside a tick window.
    const startedAt = Date.now()
    let stateReads = 0
    let stateReadsInTick = 0
    let tickOpen = false
    const tickets = Object.assign(new FakeTicketSource([]), {
      countStates: async (names: readonly string[]) => {
        stateReads++
        if (tickOpen) stateReadsInTick++
        return names.map((name) => ({ name, tickets: 2 }))
      },
      listStates: async () => {
        throw new Error('the triage sample never lists ticket states')
      },
    })
    const checked = new Proxy(cold, {
      get(target, key) {
        if (interactive && key === 'beginRepoTick')
          return async (...args: Parameters<BuildStore['beginRepoTick']>) => {
            // Drain startup presentation before opening the kernel window.
            await new Promise((resolve) => setTimeout(resolve, 0))
            // Startup is outside the tick call budget, but must obey the same
            // no-history-replay rule after the prepared boundary.
            expect(costs.historicalEvents).toBe(0)
            acquisitions.facts = acquisitions.digests = ticketScanWrites = 0
            costs.events = costs.historicalEvents = 0
            tickOpen = true
            return target.beginRepoTick(...args)
          }
        if (interactive && key === 'finishRepoTick')
          return async (...args: Parameters<BuildStore['finishRepoTick']>) => {
            // Close the kernel window before the independent dashboard poll.
            tickAcquisitions = { ...acquisitions, facts: acquisitions.facts - ticketScanWrites }
            try {
              if (outage && ticks === 0) throw new Error('budget tick write refused')
              return await target.finishRepoTick(...args)
            } finally {
              tickOpen = false
            }
          }
        if (interactive && key === 'appendRepo')
          return (...args: Parameters<BuildStore['appendRepo']>) => {
            // Cold readiness publishes a scan and refreshes its committed facts;
            // this is separate from acquiring the shared tick inputs.
            if (args[1].type === 'dispatcher.ticket-scan-completed') ticketScanWrites++
            if (outage && args[1].type === 'dispatcher.tick-failed') {
              deferredAttempts++
              if (ticks === 1) throw new Error('budget report write refused')
            }
            return target.appendRepo(...args)
          }
        if (key === 'getRepoBuildDigests')
          return (...args: Parameters<BuildStore['getRepoBuildDigests']>) => {
            acquisitions.digests++
            return target.getRepoBuildDigests(...args)
          }
        if (key === 'getReducerValue')
          return (...args: Parameters<BuildStore['getReducerValue']>) => {
            expect(['dispatcherRunFacts', 'openTick']).not.toContain(args[1].reducer)
            if (args[1].reducer === 'repositoryReadFacts') acquisitions.facts++
            return target.getReducerValue(...args)
          }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    costs.events = 0
    costs.metadata = 0
    costs.bytes = 0
    costs.historicalEvents = 0
    costs.history = { repo: onceRepo, through: boundary }
    const run = `never-read-once-${length}`
    await abDispatch({
      targetRepo: directory,
      repo: onceRepo,
      env: {},
      exec: async (args) =>
        args[1] === 'remote'
          ? { stdout: `${onceRepo}.git\n`, stderr: '', exitCode: 0 }
          : {
              stdout: `${directory}/.git\n${directory}/.git\n${directory}\n`,
              stderr: '',
              exitCode: 0,
            },
      stdout: () => {},
      stderr: () => {},
      once: !interactive,
      plain: !interactive,
      signal: stop.signal,
      terminal: interactive
        ? {
            columns: 100,
            rows: 24,
            interactive: true,
            write: () => {},
            modes: createTerminalModeController(
              () => {},
              () => {},
            ),
          }
        : undefined,
      sleep: async (ms) => {
        if (outage && ticks < 2) expect(ms).toBeGreaterThanOrEqual(1000)
        // Drain the asynchronous launch gate before closing each tick window.
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(tickAcquisitions).toEqual({ facts: 1, digests: 1 })
        expect(stateReadsInTick).toBe(0)
        expect(stateReads).toBeLessThanOrEqual(
          interactive ? Math.ceil((Date.now() - startedAt) / TRIAGE_COUNT_REFRESH_MS) + 1 : 0,
        )
        if (interactive) expect(stateReads).toBeGreaterThan(0)
        expect(costs.historicalEvents).toBe(0)
        expect(costs.events).toBeLessThanOrEqual(32)
        // Prepare the newly written tick-completed tail, then prove an
        // unchanged read acquires zero rows.
        await readRepositoryFacts(cold, onceRepo)
        await readBuildDigests(cold, onceRepo)
        const rows = costs.events
        await readRepositoryFacts(cold, onceRepo)
        await readBuildDigests(cold, onceRepo)
        expect(costs.events).toBe(rows)
        if (++ticks === (outage ? 3 : 2)) stop.abort()
      },
      kernelRunId: run,
      ...(interactive ? { frontendStatus: true } : {}),
      storeRef: '/budget',
      wire: () => ({
        store: checked,
        storeRef: '/budget',
        tickets,
        forge: new FakeForge(),
        workspaces: new FakeWorkspaceProvider({ root: '/once-workspaces', mode: 'logical' }),
        buildExecution: {
          start: () => {
            throw new Error('no builds in once budget')
          },
        },
        runtimes: {
          claude: {
            runner: new ScriptedAgentRunner({ script: () => defaultTurnResult() }),
            servesModels: [],
          },
        },
        ids: sequentialIds(),
        uuids: randomUuids(),
        clock: () => new Date(1000),
      }),
    })
    if (interactive) expect(ticks).toBe(outage ? 3 : 2)
    if (outage) expect(deferredAttempts).toBe(2)
    const finished = (await readRepositoryFacts(checked, onceRepo)).value.recentRuns.find(
      ([id]) => id === run,
    )?.[1]
    expect(finished?.completed?.type).toBe('dispatcher.tick-completed')
    if (interactive) expect(finished?.completed?.payload).toMatchObject({ triage: 2 })
    else expect(finished?.completed?.payload).not.toHaveProperty('triage')
    expect(finished?.stop?.type).toBe('dispatcher.run-stopped')
    // The same fresh invocation may fail before writing its start fact.
    expect(
      (await readDispatcherRunFacts(checked, onceRepo, `never-started-${length}`, false)).value,
    ).toEqual({})
    expect(await readOpenTick(checked, onceRepo, `never-started-${length}`, false)).toBe(false)
    expect(costs.historicalEvents).toBe(0)
    expect(costs.events).toBeLessThanOrEqual(32)
    expect(costs.metadata).toBeLessThan(300)
    expect(costs.bytes).toBeLessThan(1_000_000)
  } finally {
    delete costs.history
    await rm(directory, { recursive: true, force: true })
  }
}

/** SQL result instrumentation handles both raw object rows and Drizzle values. */
export function countHistoricalRows(costs: ReducedReadCosts, rows: unknown): number {
  if (!costs.history || !Array.isArray(rows)) return 0
  return rows.filter((row) => {
    const repo = Array.isArray(row) ? row[0] : row?.repo
    const seq = Number(Array.isArray(row) ? row[1] : row?.seq)
    return repo === costs.history!.repo && seq <= costs.history!.through
  }).length
}

/** Fresh remote processes must never turn catalog skew into history reads.
 * Callers instrument backing storage (including private checkpoint reads). */
export async function catalogSkewReadBudget(opts: {
  backing: BuildStore
  fresh: () => BuildStore
  repo: string
  slug: string
  reset: () => void
  eventRows: () => number
}) {
  const reads = [
    [{ kind: 'repo', repo: opts.repo }, { reducer: 'dispatchUpgrade' }],
    [{ kind: 'build', slug: opts.slug }, { reducer: 'buildReadFacts' }],
    [
      { kind: 'build', slug: opts.slug },
      { reducer: 'phaseFailures', args: { phase: 'plan', round: 1 } },
    ],
    [
      { kind: 'build', slug: opts.slug },
      { reducer: 'phaseFailures', args: { phase: 'verify:unit', round: 1 } },
    ],
  ] as const
  const expected = []
  for (const [scope, request] of reads)
    expected.push(await opts.backing.getReducerValue(scope, request))
  const batch = await opts.backing.getRepoBuildDigests(opts.repo)
  opts.reset()
  for (let i = 0; i < 3; i++) {
    const client = opts.fresh()
    for (const [index, [scope, request]] of reads.entries()) {
      const { catalogIdentity: _, ...answer } = await client.getReducerValue(scope, request)
      const { catalogIdentity: __, ...canonical } = expected[index]!
      expect(answer).toEqual(canonical)
    }
    expect(await client.getRepoBuildDigests(opts.repo)).toEqual(batch)
    await client.close()
  }
  expect(opts.eventRows()).toBe(0)
}

/** Real parked ticks, with array-result instrumentation beneath MemoryBuildStore's
 * public and private reducer reads. History is seeded and projections warmed
 * outside the measured interval; fresh dispatchers retain no pin cache. */
export async function parkedSweepReadBudget(opts: {
  store: import('../store/memory').MemoryBuildStore
  slugs: string[]
  dispatcher: () => Dispatcher
  pin: (slug: string) => Promise<void>
  advance: () => void
  repairBoundary?: () => Promise<void>
}) {
  const { store, slugs } = opts
  const kind = 'build-runner-effective-config'
  const metrics = { meta: 0, bodies: 0, bytes: 0, historicalRows: 0 }
  const meta = store.getLatestArtifactMeta.bind(store)
  const get = store.getArtifact.bind(store)
  const pinBlobs = new Set(
    await Promise.all(slugs.map(async (slug) => (await get(slug, kind))!.meta.blobRef)),
  )
  const pinBytes = (await get(slugs[0]!, kind))!.content.byteLength
  let blobReads = 0
  const getBlob = store.blobs.get.bind(store.blobs)
  store.blobs.get = async (ref) => {
    if (pinBlobs.has(ref)) blobReads++
    return getBlob(ref)
  }
  store.getLatestArtifactMeta = async (...args) => {
    if (args[1] === kind) metrics.meta++
    return meta(...args)
  }
  store.getArtifact = async (...args) => {
    const result = await get(...args)
    if (args[1] === kind) {
      metrics.bodies++
      metrics.bytes += result?.content.byteLength ?? 0
    }
    return result
  }
  const reset = () => {
    metrics.meta = metrics.bodies = metrics.bytes = metrics.historicalRows = blobReads = 0
  }
  const recoverySlug = 'lost-candidate-read-budget'
  await store.ensureRepo('/lost-candidate-read-budget')
  await store.createBuild({ slug: recoverySlug, repo: '/lost-candidate-read-budget' })
  const missing = '9'.repeat(40)
  const transaction = {
    id: 'lost',
    attempt: 1,
    branch: `ab/${recoverySlug}`,
    oldHead: 'a'.repeat(40),
    oldBase: 'b'.repeat(40),
    targetBase: 'c'.repeat(40),
    changeSha: 'd'.repeat(40),
    workspaceHead: 'a'.repeat(40),
    localBranchHead: 'a'.repeat(40),
    conflicted: true,
  }
  const request = await store.append(recoverySlug, {
    actor: KERNEL,
    type: 'publication.requested',
    payload: {
      operation: 'reconcile',
      branch: transaction.branch,
      sha: missing,
      rewrite: transaction,
      artifact: { kind: 'reconcile-notes', rev: 0 },
    },
  })
  await store.append(recoverySlug, {
    actor: DISPATCHER,
    type: 'publication.lost',
    payload: {
      request: request.seq,
      operation: 'reconcile',
      branch: transaction.branch,
      sha: missing,
      reason: 'replacement',
    },
  })
  await store.append(recoverySlug, {
    actor: KERNEL,
    type: 'publication.candidate-retired',
    payload: {
      request: request.seq,
      operation: 'reconcile',
      id: transaction.id,
      sha: missing,
      replacementId: 'replacement',
    },
  })
  let seeded = 0
  const idleRequests: Record<string, number>[] = []
  for (const length of [100, 100_000]) {
    for (; seeded < length; seeded++) {
      await store.append(slugs[0]!, {
        actor: humanActor('budget'),
        type: 'build.auto-merge-cancelled',
        payload: {},
      })
    }
    const recoveryEvents = Reflect.get(store, 'builds').get(recoverySlug)
      .events as import('../events/catalog').AbEvent[]
    while (recoveryEvents.length < length)
      await store.append(recoverySlug, {
        actor: humanActor('budget'),
        type: 'build.auto-merge-cancelled',
        payload: {},
      })
    await readBuildFacts(store, recoverySlug)
    const recoverySlice = Array.prototype.slice
    const recoveryBoundary = recoveryEvents.at(-1)!.seq
    recoveryEvents.slice = function (start?: number, end?: number) {
      const result = recoverySlice.call(this, start, end) as typeof recoveryEvents
      metrics.historicalRows += result.filter((event) => event.seq <= recoveryBoundary).length
      return result
    }
    const seededTail = (await store.getEvents(slugs[0]!)).at(-1)!.seq
    // Materialize runner-only reducer keys once, before measuring the next
    // repair. Canonical first materialization is allowed; subsequent repairs
    // must advance those durable values over new tail rows only.
    await opts.repairBoundary?.()
    // Instrument returned event rows, including getReducerValue's private
    // snapshot-tail reads (instrumenting getEvents alone would miss these).
    const build = Reflect.get(store, 'builds').get(slugs[0]!)
    const events = build.events as import('../events/catalog').AbEvent[]
    const historyTail = seededTail
    const slice = Array.prototype.slice
    events.slice = function (start?: number, end?: number) {
      const result = slice.call(this, start, end) as typeof events
      metrics.historicalRows += result.filter((event) => event.seq <= historyTail).length
      return result
    }
    opts.advance()
    await opts.dispatcher().tick({ acceptNewWork: false }) // warm durable projections
    reset()
    await opts.repairBoundary?.()
    expect(metrics.historicalRows).toBe(0)
    const dispatcher = opts.dispatcher()
    reset()
    for (let tick = 0; tick < 4; tick++) {
      const { recoverLostCandidate } = await import('../kernel/reconcile-restack')
      expect(
        await recoverLostCandidate({
          store,
          slug: recoverySlug,
          workspacePath: '/unused',
          forge: new FakeForge(),
          exec: async () => {
            throw new Error('retired candidates must not be probed on idle reads')
          },
        }),
      ).toBe('none')
      expect(
        (await readBuildFacts(store, recoverySlug)).value.candidateRecoveries.reconcile?.sha,
      ).toBe(missing)
      await dispatcher.tick({ acceptNewWork: false })
    }
    expect(metrics).toEqual({
      meta: slugs.length * 4,
      bodies: slugs.length,
      bytes: pinBytes * slugs.length,
      historicalRows: 0,
    })
    expect(blobReads).toBe(slugs.length)
    const coldBytes = metrics.bytes
    await opts.pin(slugs[0]!)
    opts.advance()
    reset()
    await dispatcher.tick({ acceptNewWork: false })
    expect(metrics.meta).toBe(slugs.length)
    expect(metrics.bodies).toBe(1)
    expect(blobReads).toBe(1)
    expect(metrics.historicalRows).toBe(0)
    reset()
    await opts.dispatcher().tick({ acceptNewWork: false })
    expect(metrics.bodies).toBe(slugs.length)
    expect(blobReads).toBe(slugs.length)
    expect(metrics.historicalRows).toBe(0)
    // Idle admission ticks over settled parked builds: capacity adds no
    // recurring read and writes nothing, at either history length.
    reset()
    await dispatcher.tick({ acceptNewWork: false })
    const baseline = { meta: metrics.meta, bodies: metrics.bodies }
    const idle = opts.dispatcher()
    opts.advance()
    // Warm intake's own projections and persist their snapshots.
    for (const _ of [0, 1]) {
      await idle.tick({ acceptNewWork: true })
      opts.advance()
    }
    for (const _ of [0, 1]) {
      opts.advance()
      reset()
      const requests = await countStoreRequests(store, () =>
        idle.tick({ acceptNewWork: true }).then(() => undefined),
      )
      expect(requests.append ?? 0).toBe(0)
      expect(requests.appendIfCurrent ?? 0).toBe(0)
      expect(metrics.historicalRows).toBe(0)
      expect({ meta: metrics.meta, bodies: metrics.bodies }).toEqual(baseline)
      if (idleRequests.length) expect(requests).toEqual(idleRequests[0]!)
      idleRequests.push(requests)
    }
    console.log('parked sweep read budget', {
      history: length,
      builds: slugs.length,
      sweeps: 4,
      coldBodies: slugs.length,
      coldBytes,
      warmBodies: 0,
      metadata: slugs.length * 4,
      historicalRows: metrics.historicalRows,
    })
    Reflect.deleteProperty(events, 'slice')
  }
}

/** Ticket waits (SPEC §11 "Ticket waits"): idle dispatcher ticks over leaves
 * parked by a ticket wait — one open, one ended and waiting for a resume slot
 * behind an occupied slot — read zero historical rows, append nothing and
 * make no wait ticket-source call, at 100 and 100,000 events. `waitCalls`
 * counts ticket-source calls the wait stage could make (blocker reads,
 * completion checks and blocker writes). `surfaces` runs the status reads an
 * operator polls (`ab builds`, dashboard rows) inside the same measured window,
 * so showing a wait is held to the same bound. */
export async function ticketWaitIdleReadBudget(opts: {
  store: import('../store/memory').MemoryBuildStore
  slugs: string[]
  dispatcher: () => Dispatcher
  /** Per-request wait calls (`get`, `addBlocker`): none on idle ticks. */
  waitCalls: () => number
  /** Batched `dependencyStates` calls naming waited tickets: exactly one per
   * tick while some wait is open. */
  releaseBatches: () => number
  advance: () => void
  surfaces?: () => Promise<void>
}): Promise<void> {
  const { store, slugs } = opts
  let historicalRows = 0
  for (const length of [100, 100_000]) {
    for (const slug of slugs) await seedBuildFiller(store, slug, length)
    const restore: (() => void)[] = []
    for (const slug of slugs) {
      const events = buildEventRows(store, slug)
      const boundary = events.at(-1)!.seq
      const slice = Array.prototype.slice
      events.slice = function (start?: number, end?: number) {
        const result = slice.call(this, start, end) as typeof events
        historicalRows += result.filter((event) => event.seq <= boundary).length
        return result
      }
      restore.push(() => Reflect.deleteProperty(events, 'slice'))
    }
    const dispatcher = opts.dispatcher()
    // Warm durable projections over the new tail once.
    opts.advance()
    await dispatcher.tick()
    await opts.surfaces?.()
    const calls = opts.waitCalls()
    historicalRows = 0
    for (const _ of [0, 1]) {
      opts.advance()
      const batches = opts.releaseBatches()
      const requests = await countStoreRequests(store, async () => {
        await dispatcher.tick()
        await opts.surfaces?.()
      })
      expect(requests.append ?? 0).toBe(0)
      expect(requests.appendIfCurrent ?? 0).toBe(0)
      expect(requests.appendWithArtifactsIfCurrent ?? 0).toBe(0)
      expect(opts.releaseBatches() - batches).toBe(1)
    }
    expect(historicalRows).toBe(0)
    expect(opts.waitCalls()).toBe(calls)
    for (const undo of restore) undo()
    console.log('ticket wait idle read budget', { history: length, builds: slugs.length })
  }
}

/** Sampled attempt measurements (SPEC §13.1.1): the dispatcher decides each
 * parked attempt's sampled request with one reduced read of its node, once,
 * and idle ticks afterwards read the node no more often than before any
 * sample, append nothing and read zero historical event rows, at 100 and
 * 100,000 events on every attempt and on the node. `sample` appends a fresh
 * request and its samples to one attempt; `decided` names the fact the
 * dispatcher must have written for it. With `progress`, which appends the
 * request and partial sampling work (a judge panel's facts) first, ticks
 * while the samples are pending append nothing, read zero historical rows
 * and read the node equally often at every history length, and `sample`
 * then appends only the samples. */
export async function sampledMeasurementReadBudget(opts: {
  store: import('../store/memory').MemoryBuildStore
  node: string
  attempts: string[]
  dispatcher: () => Dispatcher
  progress?: (slug: string, request: string) => Promise<void>
  sample: (slug: string, request: string) => Promise<void>
  decided: (slug: string, request: string) => Promise<boolean>
  advance: () => void
}): Promise<void> {
  const { store, node, attempts } = opts
  let nodeReads = 0
  const getReducerValue = store.getReducerValue.bind(store)
  store.getReducerValue = (async (...args: Parameters<typeof store.getReducerValue>) => {
    const [scope] = args
    if (scope.kind === 'build' && scope.slug === node) nodeReads++
    return getReducerValue(...args)
  }) as typeof store.getReducerValue
  const metrics = { historicalRows: 0, tailRows: 0 }
  // Writes to the attempts only: the node's own polling facts are not this
  // stage's.
  let attemptWrites = 0
  const append = store.append.bind(store)
  const appendIfCurrent = store.appendIfCurrent.bind(store)
  store.append = ((slug: string, event: never) => {
    if (attempts.includes(slug)) attemptWrites++
    return append(slug, event)
  }) as typeof store.append
  store.appendIfCurrent = ((slug: string, expected: number, event: never) => {
    if (attempts.includes(slug)) attemptWrites++
    return appendIfCurrent(slug, expected, event)
  }) as typeof store.appendIfCurrent
  let pendingNodeReads: number | undefined
  try {
    for (const length of [100, 100_000]) {
      for (const slug of [node, ...attempts]) await seedBuildFiller(store, slug, length)
      const dispatcher = opts.dispatcher()
      // Warm durable projections over the new filler once.
      opts.advance()
      await dispatcher.tick({ acceptNewWork: false })
      opts.advance()
      await dispatcher.tick({ acceptNewWork: false })
      opts.advance()
      nodeReads = 0
      await dispatcher.tick({ acceptNewWork: false })
      const idleNodeReads = nodeReads
      // Rows up to here are history; the samples and decisions are the tail.
      const restore = [node, ...attempts].map((slug) => {
        const boundary = buildEventRows(store, slug).at(-1)!.seq
        return instrumentBuildRows(store, slug, () => boundary, metrics)
      })
      const request = `m-${length}`
      try {
        if (opts.progress !== undefined) {
          for (const slug of attempts) await opts.progress(slug, request)
          // Waiting for the samples: no decision, no write, no history.
          for (const make of [() => dispatcher, opts.dispatcher]) {
            const ticking = make()
            opts.advance()
            nodeReads = 0
            metrics.historicalRows = 0
            attemptWrites = 0
            await ticking.tick({ acceptNewWork: false })
            for (const slug of attempts) expect(await opts.decided(slug, request)).toBe(false)
            expect(attemptWrites).toBe(0)
            // The landing gate's per-child reads of a pending request: the
            // same on every tick, dispatcher and history length.
            pendingNodeReads ??= nodeReads
            expect(nodeReads).toBe(pendingNodeReads)
            expect(metrics.historicalRows).toBe(0)
          }
        }
        for (const slug of attempts) await opts.sample(slug, request)
        // The deciding tick: one node read per sampled request, once.
        opts.advance()
        nodeReads = 0
        metrics.historicalRows = 0
        attemptWrites = 0
        await dispatcher.tick({ acceptNewWork: false })
        for (const slug of attempts) expect(await opts.decided(slug, request)).toBe(true)
        expect(attemptWrites).toBe(attempts.length)
        expect(nodeReads - idleNodeReads).toBe(attempts.length)
        expect(metrics.historicalRows).toBe(0)
        // Idle ticks after the decisions, on this and on a fresh dispatcher.
        for (const make of [() => dispatcher, opts.dispatcher, () => dispatcher]) {
          const ticking = make()
          opts.advance()
          nodeReads = 0
          metrics.historicalRows = 0
          attemptWrites = 0
          await ticking.tick({ acceptNewWork: false })
          expect(attemptWrites).toBe(0)
          expect(nodeReads).toBeLessThanOrEqual(idleNodeReads)
          expect(metrics.historicalRows).toBe(0)
        }
      } finally {
        for (const undo of restore) undo()
      }
      console.log('sampled measurement read budget', {
        history: length,
        attempts: attempts.length,
        idleNodeReads,
      })
    }
  } finally {
    store.getReducerValue = getReducerValue
    store.append = append
    store.appendIfCurrent = appendIfCurrent
  }
}

/** Count every MemoryBuildStore method call made while `run` executes. */
export async function countStoreRequests(
  store: import('../store/memory').MemoryBuildStore,
  run: () => Promise<void>,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  const names = Object.getOwnPropertyNames(Object.getPrototypeOf(store)).filter(
    (name) => name !== 'constructor' && typeof Reflect.get(store, name) === 'function',
  )
  const restore: (() => void)[] = []
  for (const name of names) {
    const own = Object.getOwnPropertyDescriptor(store, name)
    const original = Reflect.get(store, name) as (...args: unknown[]) => unknown
    Reflect.set(store, name, (...args: unknown[]) => {
      counts[name] = (counts[name] ?? 0) + 1
      return original.apply(store, args)
    })
    restore.push(() =>
      own ? Object.defineProperty(store, name, own) : Reflect.deleteProperty(store, name),
    )
  }
  try {
    await run()
  } finally {
    for (const undo of restore) undo()
  }
  return counts
}

/** Append filler facts to one build until its log holds `length` events. */
async function seedBuildFiller(
  store: import('../store/memory').MemoryBuildStore,
  slug: string,
  length: number,
): Promise<void> {
  const events = buildEventRows(store, slug)
  while (events.length < length)
    await store.append(slug, {
      actor: humanActor('budget'),
      type: 'build.auto-merge-cancelled',
      payload: {},
    })
}

function buildEventRows(
  store: import('../store/memory').MemoryBuildStore,
  slug: string,
): import('../events/catalog').AbEvent[] {
  return Reflect.get(store, 'builds').get(slug).events
}

/** Count every event row MemoryBuildStore returns for one build, including
 * getReducerValue's private snapshot-tail reads, split at `boundary`. */
function instrumentBuildRows(
  store: import('../store/memory').MemoryBuildStore,
  slug: string,
  boundary: () => number,
  metrics: { historicalRows: number; tailRows: number },
): () => void {
  const events = buildEventRows(store, slug)
  const slice = Array.prototype.slice
  events.slice = function (start?: number, end?: number) {
    const result = slice.call(this, start, end) as typeof events
    const limit = boundary()
    for (const event of result) {
      if (event.seq <= limit) metrics.historicalRows++
      else metrics.tailRows++
    }
    return result
  }
  return () => Reflect.deleteProperty(events, 'slice')
}

/** A stale build whose open workspace is flagged `cleanup-required` and whose
 * preservation keeps failing re-enters the sweep's reap branch on every pass.
 * Each pass must read only the tail it appended itself, the same number of
 * reduced reads at 100 and 100,000 events, and nothing at all once the build
 * is healthy again. Fresh dispatchers retain no per-process cache. */
export async function flaggedWorkspaceSweepReadBudget(opts: {
  store: import('../store/memory').MemoryBuildStore
  slug: string
  dispatcher: () => Dispatcher
  advance: () => void
  effects: () => { reaps: number; launches: number }
}) {
  const { store, slug } = opts
  const sweeps = 4
  const metrics = { historicalRows: 0, tailRows: 0 }
  let reducerReads = 0
  const getReducerValue = store.getReducerValue.bind(store)
  store.getReducerValue = async (...args) => {
    reducerReads++
    return getReducerValue(...args)
  }
  const infrastructureFailures = async () =>
    (await readBuildFacts(store, slug)).value.infrastructureCount
  const perTick: Record<number, number[]> = {}
  for (const length of [100, 100_000]) {
    await seedBuildFiller(store, slug, length)
    opts.advance()
    // Rows the previous pass appended are the only tail a pass may read.
    let boundary = buildEventRows(store, slug).at(-1)!.seq
    await opts.dispatcher().tick({ acceptNewWork: false }) // warm durable projections
    const restore = instrumentBuildRows(store, slug, () => boundary, metrics)
    const before = opts.effects()
    perTick[length] = []
    for (let tick = 0; tick < sweeps; tick++) {
      const failures = await infrastructureFailures()
      const appendedBefore = buildEventRows(store, slug).at(-1)!.seq
      opts.advance()
      metrics.historicalRows = metrics.tailRows = reducerReads = 0
      await opts.dispatcher().tick({ acceptNewWork: false })
      perTick[length]!.push(reducerReads)
      expect(metrics.historicalRows).toBe(0)
      expect(await infrastructureFailures()).toBe(failures + 1)
      boundary = appendedBefore
    }
    expect(new Set(perTick[length]).size).toBe(1)
    expect(opts.effects()).toEqual(before)
    restore()
  }
  expect(perTick[100]).toEqual(perTick[100_000])
  // Unchanged path: a live lease makes the build healthy, so the sweep skips
  // it. After one settling pass, nothing changes and nothing is read.
  await store.claimLease(slug, 'budget-runner', 3_600_000)
  await opts.dispatcher().tick({ acceptNewWork: false })
  const restore = instrumentBuildRows(store, slug, () => Number.POSITIVE_INFINITY, metrics)
  metrics.historicalRows = metrics.tailRows = 0
  for (let tick = 0; tick < 2; tick++) await opts.dispatcher().tick({ acceptNewWork: false })
  expect(metrics).toEqual({ historicalRows: 0, tailRows: 0 })
  restore()
  Reflect.deleteProperty(store, 'getReducerValue')
  console.log('flagged workspace sweep read budget', {
    histories: [100, 100_000],
    sweeps,
    reducedReadsPerSweep: perTick[100_000]![0],
    historicalRows: 0,
    idleRows: 0,
  })
}

/** A provision continuation that reaches its launch for a build at the
 * no-progress limit applies the guard instead of starting a runner. Each
 * continuation is a recurring invocation (every re-provision, every remote
 * dispatch), so it must read no seeded history and the same reduced values,
 * artifacts and tail rows at 100 and 100,000 events, both in the whole tick
 * and in the guarded launch window after `workspace.provisioned`. */
export async function provisionContinuationGuardReadBudget(opts: {
  store: import('../store/memory').MemoryBuildStore
  /** Seeds a fresh build whose next tick kicks a remote provision
   * continuation with `tail`, and returns its slug. Called before filler. */
  seed: (tail: 'launch' | 'dispatch', length: number) => Promise<string>
  /** A fresh dispatcher per measured invocation: no per-process cache. */
  dispatcher: () => Dispatcher
  advance: () => void
  launches: () => number
}) {
  const { store } = opts
  const configKind = 'build-runner-effective-config'
  type Counts = { reduced: Record<string, number>; configReads: number; tailRows: number }
  const results: Record<string, { tick: Counts; launchWindow: Counts }> = {}
  for (const tail of ['launch', 'dispatch'] as const) {
    for (const length of [100, 100_000]) {
      const slug = await opts.seed(tail, length)
      // Filler is a progress fact, so it precedes the no-progress streak.
      await seedBuildFiller(store, slug, length)
      for (const instance of ['empty-a', 'empty-b', 'empty-c']) {
        await store.append(slug, {
          actor: DISPATCHER,
          type: 'execution.started',
          payload: { instance, provider: 'remote-test', workspaceRef: 'sandbox-g0' },
        })
        await store.append(slug, {
          actor: DISPATCHER,
          type: 'execution.ended',
          payload: { instance, workspaceRef: 'sandbox-g0', outcome: 'completed', exitCode: 0 },
        })
      }
      // Materialize every build-scoped value the tick reads once, without a
      // tick, which would itself kick the continuation being measured. A
      // first reduction per key is canonical; the measured tick must only
      // advance saved values over its own tail.
      expect((await readBuildFacts(store, slug)).value.executionNoProgress.count).toBe(3)
      for (const reducer of ['buildDigest', 'baseBranchValue', 'publishedBranchHeadValue'])
        await store.getReducerValue({ kind: 'build', slug }, { reducer })
      // The remote provider is recovery-capable, so it owns the workspace.
      await readDispatchBudget(store, slug, true)
      const boundary = buildEventRows(store, slug).at(-1)!.seq
      const rows = { historicalRows: 0, tailRows: 0 }
      const counts = (): Counts => ({ reduced: {}, configReads: 0, tailRows: 0 })
      const tick = counts()
      let atProvision: Counts | undefined
      const getReducerValue = store.getReducerValue.bind(store)
      store.getReducerValue = async (scope, request) => {
        if (scope.kind === 'build' && scope.slug === slug)
          tick.reduced[request.reducer] = (tick.reduced[request.reducer] ?? 0) + 1
        return getReducerValue(scope, request)
      }
      const getArtifact = store.getArtifact.bind(store)
      store.getArtifact = async (...args) => {
        if (args[0] === slug && args[1] === configKind) tick.configReads++
        return getArtifact(...args)
      }
      const append = store.append.bind(store)
      store.append = (async (...args: Parameters<typeof append>) => {
        const result = await append(...args)
        if (args[0] === slug && args[1].type === 'workspace.provisioned')
          atProvision = { ...structuredClone(tick), tailRows: rows.tailRows }
        return result
      }) as typeof store.append
      const restoreRows = instrumentBuildRows(store, slug, () => boundary, rows)
      const launchesBefore = opts.launches()
      try {
        opts.advance()
        const dispatcher = opts.dispatcher()
        await dispatcher.tick({ acceptNewWork: false })
        await dispatcher.drainProvisioning()
      } finally {
        restoreRows()
        Reflect.deleteProperty(store, 'getReducerValue')
        Reflect.deleteProperty(store, 'getArtifact')
        Reflect.deleteProperty(store, 'append')
      }
      tick.tailRows = rows.tailRows
      const appended = buildEventRows(store, slug).at(-1)!.seq - boundary
      expect(rows.historicalRows).toBe(0)
      expect(atProvision).toBeDefined()
      const launchWindow: Counts = {
        reduced: Object.fromEntries(
          Object.entries(tick.reduced).map(([reducer, n]) => [
            reducer,
            n - (atProvision!.reduced[reducer] ?? 0),
          ]),
        ),
        configReads: tick.configReads - atProvision!.configReads,
        tailRows: tick.tailRows - atProvision!.tailRows,
      }
      const events = buildEventRows(store, slug).filter((event) => event.seq > boundary)
      expect(
        events.filter(
          (event) =>
            event.type === 'escalation.raised' &&
            event.payload.policyCause === 'execution-no-progress',
        ),
      ).toHaveLength(1)
      expect(opts.launches()).toBe(launchesBefore)
      // The guarded launch window reads the reduced build facts twice on
      // either tail: the continuation's own queued check, and the guard's
      // read after its refresh. The dispatch tail's completion boundaries
      // already add three on main: the mixed-version check, the discard
      // check, and the pre-launch re-read. The guard's decision reads the
      // pinned config once (the fixture carries no verify pin).
      expect(launchWindow.reduced.buildReadFacts).toBe(tail === 'launch' ? 2 : 5)
      expect(launchWindow.configReads).toBe(1)
      // Tail rows are only rows this invocation appended (each read at most
      // once per reduced read that advances over it).
      expect(launchWindow.tailRows).toBeLessThanOrEqual(appended * tick.reduced.buildReadFacts!)
      results[`${tail}:${length}`] = { tick, launchWindow }
    }
    expect(results[`${tail}:100`]).toEqual(results[`${tail}:100000`]!)
  }
  console.log('provision continuation guard read budget', {
    histories: [100, 100_000],
    launch: results['launch:100000'],
    dispatch: results['dispatch:100000'],
    historicalRows: 0,
  })
}

/** In-memory history seeding for preparation budgets; never used as a recurring read. */
export async function seedPreparationHistory(
  store: BuildStore,
  repo: string,
  facts: number,
  /** Record the pending attempt's creation identity, keyed when `creationKey` is set. */
  creation?: { slug: string; creationKey?: string },
) {
  await store.ensureRepo(repo)
  for (let i = 0; i < facts / 2; i++) {
    const ticket = { source: 'fake', id: `old-${i}` }
    const attempt = `historical-${i}`
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'ticket-preparation.intended',
      payload: { attempt, ticket, readyState: 'Ready', claimedState: 'Doing' },
    })
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'ticket-preparation.resolved',
      payload: { attempt, ticket, outcome: 'handed-back' },
    })
  }
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'ticket-preparation.intended',
    payload: {
      attempt: 'pending',
      ticket: { source: 'fake', id: 'pending' },
      readyState: 'Ready',
      claimedState: 'Doing',
    },
  })
  if (creation)
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'ticket-preparation.creation-selected',
      payload: { attempt: 'pending', ticket: { source: 'fake', id: 'pending' }, ...creation },
    })
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'ticket-preparation.recovery-failed',
    payload: {
      attempt: 'pending',
      ticket: { source: 'fake', id: 'pending' },
      error: 'unknown claim outcome',
      retryAt: '2099-01-01T00:00:00.000Z',
    },
  })
}

/** Count the memory adapter's private reducer-storage event slices, in addition
 * to public history reads. This deliberately observes storage, not a selector. */
export function memoryRepositoryReadCounter(
  store: import('../store/memory').MemoryBuildStore,
  repo: string,
) {
  const repositories = Reflect.get(store, 'repos') as Map<string, { events: unknown[] }>
  const events = repositories.get(repo)?.events
  if (!events) throw new Error(`missing read-budget repository ${repo}`)
  const slice = events.slice.bind(events)
  let rows = 0
  Object.defineProperty(events, 'slice', {
    configurable: true,
    value: (start?: number, end?: number) => {
      const selected = slice(start, end)
      rows += selected.length
      return selected
    },
  })
  let buildRows = 0
  const buildRowsBySlug = new Map<string, number>()
  let reducedCalls = 0
  let buildFactsCalls = 0
  const builds = Reflect.get(store, 'builds') as Map<string, { events: unknown[] }>
  for (const [slug, build] of builds) {
    const original = build.events.slice.bind(build.events)
    Object.defineProperty(build.events, 'slice', {
      configurable: true,
      value: (start?: number, end?: number) => {
        const selected = original(start, end)
        buildRows += selected.length
        if (selected.length)
          buildRowsBySlug.set(slug, (buildRowsBySlug.get(slug) ?? 0) + selected.length)
        return selected
      },
    })
  }
  const getReducerValue = store.getReducerValue.bind(store)
  store.getReducerValue = async (scope, request) => {
    reducedCalls++
    if (scope.kind === 'build' && request.reducer === 'buildReadFacts') buildFactsCalls++
    return getReducerValue(scope, request)
  }
  return {
    get rows() {
      return rows
    },
    get buildRowsBySlug() {
      return new Map(buildRowsBySlug)
    },
    get buildRows() {
      return buildRows
    },
    get reducedCalls() {
      return reducedCalls
    },
    get buildFactsCalls() {
      return buildFactsCalls
    },
    reset() {
      rows = 0
      buildRows = 0
      buildRowsBySlug.clear()
      reducedCalls = 0
      buildFactsCalls = 0
    },
  }
}

/** Polling history proof uses private reducer slices, including on fresh consumers. */
export async function nodePollingReadBudget(opts: {
  store: import('../store/memory').MemoryBuildStore
  slug: string
  tick: () => Promise<unknown>
  advance: (ms: number) => void
  /** Seed every 10th event as a recorded child's issue links: 10 children at
   * 100 events and 10,000 at 100,000, over a bounded issue set. */
  issueLinkChildren?: boolean
  /** Proves the node still waits for a runner slot after each measured tick,
   * so the every-tick admission stage is measured on its waiting path. Its
   * own reads are excluded from the measurement. */
  slotWaiting?: () => Promise<boolean>
}) {
  const { store, slug } = opts
  const checkpoint = (await readBuildFacts(store, slug)).value.state.nodePolling!
  let seeded = 0
  let baseline: number[] | undefined
  for (const length of [100, 100_000]) {
    for (; seeded < length; seeded++)
      if (opts.issueLinkChildren && seeded % 10 === 0)
        await store.append(slug, {
          actor: DISPATCHER,
          type: 'node.issue-links-recorded',
          payload: {
            build: `child-${seeded}`,
            issueLinks: [
              {
                issue: (seeded % 50) + 1,
                intent: seeded % 7 ? 'closes' : 'refs',
                ...(seeded % 11 === 0 ? { downgraded: true as const } : {}),
              },
            ],
          },
        })
      else
        await store.append(slug, {
          actor: DISPATCHER,
          type: 'node.poll-checked',
          payload: {
            activityKey: checkpoint.activityKey,
            unchangedSince: checkpoint.unchangedSince,
            nodeIdleAfterSeconds: checkpoint.nodeIdleAfterSeconds,
            nodeIdlePollSeconds: checkpoint.nodeIdlePollSeconds,
          },
        })
    await store.append(slug, {
      actor: humanActor('budget'),
      type: 'build.hold-requested',
      payload: {},
    })
    await opts.tick()
    const events = Reflect.get(store, 'builds').get(slug)
      .events as import('../events/catalog').AbEvent[]
    const boundary = events.at(-1)!.seq
    const slice = events.slice.bind(events)
    let history = 0
    let rows = 0
    events.slice = (start, end) => {
      const selected = slice(start, end)
      rows += selected.length
      history += selected.filter((event) => event.seq <= boundary).length
      return selected
    }
    const costs: number[] = []
    let calls = 0
    const getReduced = store.getReducerValue.bind(store)
    store.getReducerValue = async (...args) => {
      calls++
      return getReduced(...args)
    }
    try {
      // Active, threshold, non-due idle and due idle, each with a fresh dispatcher.
      for (const elapsed of [10_000, 600_000, 10_000, 120_000]) {
        opts.advance(elapsed)
        rows = calls = 0
        await opts.tick()
        expect(history).toBe(0)
        expect(rows).toBeLessThanOrEqual(8)
        if (elapsed === 10_000) expect(rows).toBe(0)
        costs.push(rows, calls)
        if (opts.slotWaiting) expect(await opts.slotWaiting()).toBe(true)
        history = 0
      }
    } finally {
      Reflect.deleteProperty(events, 'slice')
      store.getReducerValue = getReduced
    }
    // A status-style read serves the saved reduced value without history.
    history = 0
    events.slice = (start, end) => {
      const selected = slice(start, end)
      history += selected.filter((event) => event.seq <= boundary).length
      return selected
    }
    try {
      const status = (await readBuildFacts(store, slug)).value.state
      if (opts.issueLinkChildren) expect(status.nodeIssueLinks?.builds).toHaveLength(length / 10)
      expect(history).toBe(0)
    } finally {
      Reflect.deleteProperty(events, 'slice')
    }
    if (baseline) expect(costs).toEqual(baseline)
    baseline = costs
  }
}

/** Node child discovery (AUT-1129) reads only the digest batch plus facts for
 * builds whose digest names the node. Fresh dispatchers (one per hosted
 * invocation) observing an open node spend the same store reads at 10 and at
 * 1,000 unrelated builds, never read an unrelated build outside the digest
 * batch, and read zero event rows on an unchanged tick. */
export async function nodeChildDiscoveryReadBudget(opts: {
  store: import('../store/memory').MemoryBuildStore
  repo: string
  /** One tick on a fresh dispatcher. */
  tick: () => Promise<unknown>
  advance: (ms: number) => void
  /** Exhaustive ticket listings so far: proves observation actually ran. */
  observed: () => number
}) {
  const { store, repo } = opts
  const ticket = { source: 'fake', id: 'UNRELATED' }
  const created = (target?: string, kind?: 'node') => ({
    actor: DISPATCHER,
    type: 'build.created' as const,
    payload: {
      ticket,
      repo,
      baseBranch: 'main',
      ...(kind ? { kind } : {}),
      ...(target ? { target: { ticket, build: target } } : {}),
    },
  })
  const terminal = async (slug: string, target?: string, kind?: 'node') => {
    await store.createBuild({ slug, repo, ticket, created: created(target, kind) })
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
  }
  // Half the unrelated builds target a different, finished node: the filter
  // is per node, not "has any target".
  await terminal('unrelated-node', undefined, 'node')
  const unrelated = new Set(['unrelated-node'])
  const methods = [
    'getReducerValue',
    'getEvents',
    'getBuild',
    'getArtifact',
    'getLatestArtifactMeta',
    'listArtifacts',
    'getRepoBuildDigests',
  ] as const
  let baseline: Record<string, number> | undefined
  for (const count of [10, 1000]) {
    while (unrelated.size <= count) {
      const slug = `unrelated-${unrelated.size}`
      await terminal(slug, unrelated.size % 2 ? 'unrelated-node' : undefined)
      unrelated.add(slug)
    }
    // Saved reduced values for the new builds settle once.
    await opts.tick()
    const calls: Record<string, number> = {}
    let strays = 0
    const originals = new Map<string, unknown>()
    for (const method of methods) {
      const original = Reflect.get(store, method) as (...args: unknown[]) => Promise<unknown>
      originals.set(method, original)
      Reflect.set(store, method, (...args: unknown[]) => {
        const [first, second] = args as [unknown, { reducer?: string } | undefined]
        // The per-key reads behind the digest batch are the listing every
        // tick already pays; they are not per-build discovery reads.
        if (method !== 'getReducerValue' || second?.reducer !== 'buildDigest') {
          calls[method] = (calls[method] ?? 0) + 1
          const slug =
            typeof first === 'string'
              ? first
              : first && typeof first === 'object' && 'slug' in first
                ? first.slug
                : undefined
          if (typeof slug === 'string' && unrelated.has(slug)) strays++
        }
        return original.apply(store, args)
      })
    }
    const logs = [
      ...(
        Reflect.get(store, 'builds') as Map<
          string,
          { events: import('../events/catalog').AbEvent[] }
        >
      ).values(),
    ]
    let rows = 0
    for (const { events } of logs) {
      const slice = events.slice.bind(events)
      events.slice = (start, end) => {
        const selected = slice(start, end)
        rows += selected.length
        return selected
      }
    }
    try {
      const listings = opts.observed()
      // Past the integration poll window, so the node observes its children.
      opts.advance(301_000)
      await opts.tick()
      expect(opts.observed()).toBeGreaterThan(listings)
      expect(strays).toBe(0)
      const costs = { ...calls }
      // Nothing changes: a fresh process reads no event rows.
      opts.advance(10_000)
      await opts.tick()
      rows = 0
      opts.advance(10_000)
      await opts.tick()
      expect(rows).toBe(0)
      expect(strays).toBe(0)
      if (baseline) expect(costs).toEqual(baseline)
      baseline = costs
    } finally {
      for (const { events } of logs) Reflect.deleteProperty(events, 'slice')
      for (const method of methods) Reflect.deleteProperty(store, method)
      for (const [method, original] of originals)
        if (Reflect.get(store, method) !== original) Reflect.set(store, method, original)
    }
  }
}

/** A kernel Git outage is one durable repository condition. Fresh
 * dispatchers (one per hosted invocation) read it from the saved repository
 * value: while nothing changes each tick spends at most one failed Git spawn
 * and reads zero event rows, at 100 and at 100,000 events. */
export async function kernelGitOutageReadBudget(opts: {
  store: import('../store/memory').MemoryBuildStore
  repo: string
  slug: string
  /** One tick on a fresh dispatcher whose kernel Git cannot execute. */
  tick: () => Promise<unknown>
  advance: (ms: number) => void
  /** Kernel Git spawns attempted so far. */
  spawns: () => number
}) {
  const { store, repo, slug } = opts
  const unavailable = async () =>
    (await store.getRepoEvents(repo)).filter(
      (event) => event.type === 'dispatcher.kernel-git-unavailable',
    ).length
  let seeded = 0
  let baseline: number[] | undefined
  for (const length of [100, 100_000]) {
    for (; seeded < length; seeded++) {
      await store.appendRepo(repo, {
        actor: humanActor('budget'),
        type: 'dispatcher.intake-set',
        payload: { enabled: true },
      })
      if (seeded % 10 === 0)
        await store.append(slug, {
          actor: KERNEL,
          type: 'observation.recorded',
          payload: { id: `obs-${seeded}`, kind: 'followup', summary: `budget padding ${seeded}` },
        })
    }
    // Warm up: the outage tick, then one fresh read that catches up its own
    // append. Nothing changes after that.
    for (let n = 0; n < 2; n++) {
      opts.advance(120_000)
      await opts.tick()
    }
    const counter = memoryRepositoryReadCounter(store, repo)
    const costs: number[] = []
    for (let n = 0; n < 3; n++) {
      opts.advance(120_000)
      counter.reset()
      const before = opts.spawns()
      await opts.tick()
      expect(counter.rows).toBe(0)
      expect(counter.buildRows).toBe(0)
      expect(opts.spawns() - before).toBeLessThanOrEqual(1)
      costs.push(counter.rows, counter.buildRows, counter.reducedCalls, opts.spawns() - before)
    }
    expect(await unavailable()).toBe(1)
    if (baseline) expect(costs).toEqual(baseline)
    baseline = costs
  }
}

/** Expired sampled owners resolve once through exact persisted run values;
 * historical abandoned preparations never replay and a new one reports once. */
export async function stoppedOwnerWatchReadBudget() {
  const { MemoryBuildStore } = await import('../store/memory')
  const { manualClock } = await import('./fixed')
  let previousBytes: number | undefined
  const abandon = (store: BuildStore, attempt: string) =>
    store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'ticket-preparation.resolved',
      payload: {
        attempt,
        ticket: { source: 'fake', id: attempt },
        outcome: 'abandoned',
        reason: 'Ticket no longer exists; ticket unchanged.',
        claimed: false,
      },
    })
  for (const length of [100, 100_000]) {
    const clock = manualClock()
    const store = new MemoryBuildStore({ clock })
    await store.ensureRepo(repo)
    for (let i = 0; i < length; i++) {
      if (i % 1000 === 50) {
        await abandon(store, `historical-${i}`)
        continue
      }
      await store.appendRepo(repo, {
        actor: humanActor('human'),
        type: 'dispatcher.intake-set',
        payload: { enabled: true },
      })
    }
    const start = async (run: string) => {
      await store.appendRepo(repo, {
        actor: DISPATCHER,
        type: 'dispatcher.run-started',
        payload: {
          run,
          pid: 1,
          roleWarnings: [],
          effectiveConfig: { kind: 'config', rev: 0 },
        },
      })
      await store.claimRepoLease(repo, run, 3000)
    }
    const stop = async (run: string) => {
      await store.appendRepo(repo, {
        actor: DISPATCHER,
        type: 'dispatcher.run-stopped',
        payload: { run, outcome: 'normal' },
      })
      await store.releaseRepoLease(repo, run)
    }
    await start('A')
    await readRepositoryFacts(store, repo)
    await readRepositoryAttention(store, repo)
    await readDispatcherRunFacts(store, repo, 'A')
    await readDispatcherRunFacts(store, repo, 'missing')
    const counter = memoryRepositoryReadCounter(store, repo)
    let tick = 0
    let quietCalls = 0
    const output: string[] = []
    await abWatch({
      targetRepo: repo,
      env: {},
      exec,
      storeRef: '/budget',
      openStore: () => store,
      repository: true,
      json: true,
      timeout: '8',
      now: clock,
      stdout: (line) => output.push(line),
      stderr: (line) => {
        throw new Error(line)
      },
      delay: async () => {
        clock.advance(1000)
        tick++
        if (tick === 1) {
          await stop('A')
          await start('B')
        }
        if (tick === 2) {
          await stop('B')
          await start('C')
        }
        if (tick === 3) await abandon(store, 'fresh')
        if (tick === 6) {
          counter.reset()
          quietCalls = counter.reducedCalls
        }
      },
    })
    expect(
      output
        .map((line) => JSON.parse(line))
        .filter((r) => r.observation)
        .map((r) => r.observation.run),
    ).toEqual(['C'])
    expect(
      output
        .map((line) => JSON.parse(line))
        .filter((r) => r.event?.type === 'ticket-preparation.resolved')
        .map((r) => r.event.payload.attempt),
    ).toEqual(['fresh'])
    expect(counter.rows).toBe(0)
    expect(counter.reducedCalls - quietCalls).toBeLessThan(20)
    await readDispatcherRunFacts(store, repo, 'missing')
    counter.reset()
    // Fresh reads, including a missing run, never reconstruct journal history.
    const values = await Promise.all(
      ['A', 'B', 'missing'].map((run) => readDispatcherRunFacts(store, repo, run)),
    )
    const bytes = Buffer.byteLength(JSON.stringify(values.map((value) => value.value)))
    expect(counter.rows).toBe(0)
    expect(counter.reducedCalls).toBe(4)
    if (previousBytes !== undefined) expect(bytes).toBeLessThan(previousBytes + 100)
    previousBytes = bytes
  }
}

/** Fresh operator backends must not turn canonical build history into ticket requests. */
export async function operatorTicketAssociationBudget() {
  const { MemoryBuildStore } = await import('../store/memory')
  const { getOperatorTicket, mutateOperatorTicket } = await import('../operator/tickets')
  const legacy = 'ticket-12345678-1234-1234-1234-123456789abc'
  const missing = 'ticket-87654321-4321-4321-4321-cba987654321'
  const config = parseConfig('[tickets]\nsource="hosted"\nteamKey="AUT"\nreadyState="Todo"')
  for (const size of [1, 200]) {
    for (const withLegacy of [false, true]) {
      let tick = 0
      const store = new MemoryBuildStore({ clock: () => new Date(++tick * 1000) })
      await store.ensureRepo(repo)
      for (let i = 0; i < size; i++)
        await store.createBuild({
          slug: `canonical-${i}`,
          repo,
          ticket: { source: 'hosted', id: i === 0 ? 'ticket-1' : `OLD-${i}` },
        })
      if (withLegacy) {
        for (const [slug, id] of [
          ['missing', missing],
          ['missing-again', missing],
          ['alias-old', legacy],
          ['alias-middle', legacy],
          ['alias-new', legacy],
        ])
          await store.createBuild({
            slug: slug!,
            repo,
            ticket: { source: 'hosted', id: id! },
          })
        await store.append('alias-old', {
          actor: DISPATCHER,
          type: 'build.completed',
          payload: { outcome: 'merged' },
        })
      }
      // Count actual public event reads, including reads made by reduced-value recovery.
      let eventReads = 0
      const checked = new Proxy(store, {
        get(target, key) {
          const value = Reflect.get(target, key, target)
          if (key === 'getEvents' || key === 'getRepoEvents')
            return (...args: unknown[]) => {
              eventReads++
              return value.apply(target, args)
            }
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      for (const operation of ['get', 'update', 'move'] as const) {
        // A new source and backend per call rules out cross-request caching.
        const source = new FakeTicketSource([
          {
            ref: { source: 'hosted', id: 'AUT-1' },
            revision: 'fixture',
            title: 'Undispatched',
            body: '',
            state: 'Triage',
            labels: [],
            resolved: false,
            blockedBy: [],
          },
        ])
        Object.defineProperty(source, 'name', { value: 'hosted' })
        const get = source.get.bind(source)
        const calls: string[] = []
        source.get = async (id) => {
          calls.push(id)
          return get(id === legacy ? 'AUT-1' : id)
        }
        const backend = {
          contextFor: async () => ({
            repo,
            tickets: config.tickets,
            teamKey: 'AUT',
          }),
          sourceFor: () => source,
          statesFor: () => ['Triage', 'Todo'],
        }
        const detail =
          operation === 'get'
            ? await getOperatorTicket({
                store: checked,
                repo,
                backend,
                id: 'AUT-1',
              })
            : await mutateOperatorTicket({
                store: checked,
                repo,
                backend,
                operation:
                  operation === 'update'
                    ? {
                        kind: 'update',
                        id: 'AUT-1',
                        patch: { title: 'Updated' },
                      }
                    : { kind: 'move', id: 'AUT-1', state: 'Todo' },
              })
        expect(detail.build?.slug ?? null).toBe(withLegacy ? 'alias-new' : null)
        expect(calls.filter((id) => id !== 'AUT-1').sort()).toEqual(
          withLegacy ? [missing, legacy].sort() : [],
        )
        expect(calls.filter((id) => id === 'AUT-1')).toHaveLength(
          operation === 'get' ? 1 : operation === 'update' ? 3 : 2,
        )
        expect(eventReads).toBe(0)
      }
    }
  }
}

/** Canonical placement stays warm across fresh consumers and long journals. */
export async function placementReadBudget(opts: {
  select?: (repo: string) => Promise<{ viewer: boolean; dispatchedBy?: string }>
  store: import('../store/memory').MemoryBuildStore
  fresh: () => Promise<{
    getDispatchPlacement(
      repo: string,
    ): Promise<import('../kernel/dispatch-placement').DispatchPlacement>
  }>
}) {
  const { readDispatchPlacement } = await import('../store/reduced-reads')
  const repo = 'https://github.com/acme/placement-budget'
  await opts.store.ensureRepo(repo)
  let seeded = 0
  for (const length of [100, 100_000]) {
    for (; seeded < length; seeded++)
      await opts.store.appendRepo(repo, {
        actor: humanActor('test'),
        type: 'dispatcher.intake-set',
        payload: { enabled: true },
      })
    await opts.store.appendRepo(repo, {
      actor: KERNEL,
      type: 'dispatcher.placement-set',
      payload: { hosted: false },
    })
    await readDispatchPlacement(opts.store, repo)
    const counter = memoryRepositoryReadCounter(opts.store, repo)
    counter.reset()
    for (let i = 0; i < 5; i++) {
      const fresh = await opts.fresh()
      expect(await fresh.getDispatchPlacement(repo)).toEqual({
        status: 'known',
        placement: { hosted: false },
      })
    }
    expect(counter.rows).toBe(0)
    expect(counter.reducedCalls).toBe(5)
    if (opts.select) {
      counter.reset()
      for (let i = 0; i < 5; i++) expect(await opts.select(repo)).toEqual({ viewer: false })
      expect(counter.rows).toBe(0)
      expect(counter.reducedCalls).toBe(5)
    }
    await opts.store.appendRepo(repo, {
      actor: KERNEL,
      type: 'dispatcher.placement-set',
      payload: { hosted: true, origin: 'https://store.test' },
    })
    counter.reset()
    if (opts.select) {
      expect(await opts.select(repo)).toEqual({ viewer: true, dispatchedBy: 'store.test' })
      expect(counter.rows).toBe(1)
      counter.reset()
    }
    expect(await (await opts.fresh()).getDispatchPlacement(repo)).toEqual({
      status: 'known',
      placement: { hosted: true, origin: 'https://store.test' },
    })
    expect(counter.rows).toBe(opts.select ? 0 : 1)
    counter.reset()
    if (opts.select) {
      expect(await opts.select(repo)).toEqual({ viewer: true, dispatchedBy: 'store.test' })
      expect(counter.rows).toBe(0)
    }
    counter.reset()
    await (await opts.fresh()).getDispatchPlacement(repo)
    expect(counter.rows).toBe(0)
  }
}

/** Hosted historical seeds: count underlying selections, including the private
 * canonical fold, rather than response lengths. Run at both exact history sizes. */
export async function hostedSeedReadBudget() {
  const { MemoryBuildStore } = await import('../store/memory')
  const { CursorTooOldError, RetiredSeedGenerationError, REPOSITORY_TAIL_WINDOW } = await import(
    '../store/event-reads'
  )
  const { REDUCERS } = await import('../kernel/reducer-registry')
  const { repositoryAttentionReducer } = await import('../kernel/repository-attention')
  const { buildStreamSeedReducer } = await import('../kernel/read-facts')
  const gapCosts: number[] = []
  for (const length of [100, 10_000]) {
    const store = new MemoryBuildStore()
    const repo = 'seed-budget',
      slug = 'seed-budget'
    await store.ensureRepo(repo)
    await store.createBuild({ slug, repo })
    for (let i = 0; i < length; i++) {
      await store.append(slug, { actor: KERNEL, type: 'build.paused', payload: {} })
      await store.appendRepo(repo, {
        actor: humanActor('budget'),
        type: 'dispatcher.intake-set',
        payload: { enabled: true },
      })
    }
    const counter = memoryRepositoryReadCounter(store, repo)
    const scopes = [
      { kind: 'build', slug },
      { kind: 'repo', repo },
    ] as const
    const requested = length - 7
    const { readReducerValue } = await import('../store/reducer-values')
    const canonicalControl = async (scope: (typeof scopes)[number], name: string) => {
      const events =
        scope.kind === 'build' ? await store.getEvents(slug) : await store.getRepoEvents(repo)
      let rows = 0
      const answer = await readReducerValue(
        scope,
        { reducer: name },
        {
          highWater: async () => length,
          read: async () => null,
          events: async (since, through) => {
            const selected = events.slice(since, through)
            rows += selected.length
            return selected
          },
          put: async () => true,
          repair: async () => true,
        },
      )
      expect(rows).toBe(length)
      return answer
    }
    for (const scope of scopes)
      await canonicalControl(
        scope,
        scope.kind === 'build' ? 'buildStreamSeed' : 'repositoryAttention',
      )
    await Promise.all(
      Array.from({ length: 8 }, () =>
        Promise.all(scopes.map((scope) => store.getStreamSeed(scope, requested))),
      ),
    )
    // One serialized durable canonical rebuild per scope, even with cold races.
    expect(counter.rows).toBe(length)
    expect(counter.buildRows).toBe(length)
    counter.reset()
    for (const scope of scopes) await store.getStreamSeed(scope, requested)
    const fresh = new RepoViewStore(store, { repo })
    for (const scope of scopes) await fresh.getStreamSeed!(scope, requested)
    expect(counter.rows + counter.buildRows).toBe(0)
    const build = await store.getBuildEventPage(slug, requested)
    const repository = await store.getRepositoryTail(repo, requested)
    expect(build.events).toHaveLength(7)
    expect(repository).toHaveLength(7)
    gapCosts.push(counter.rows + counter.buildRows)
    expect(gapCosts.at(-1)).toBe(14)
    counter.reset()
    await store.getRepositoryTail(repo, length)
    await store.getBuildEventPage(slug, length)
    expect(counter.rows + counter.buildRows).toBe(0)
    if (length > REPOSITORY_TAIL_WINDOW) {
      for (const scope of scopes)
        await expect(
          store.getStreamSeed(scope, length - REPOSITORY_TAIL_WINDOW - 1),
        ).rejects.toBeInstanceOf(CursorTooOldError)
      await expect(store.getRepositoryTail(repo, 0)).rejects.toBeInstanceOf(CursorTooOldError)
      expect(counter.rows + counter.buildRows).toBe(0)
      for (const scope of scopes)
        expect((await store.getStreamSeed(scope, length - REPOSITORY_TAIL_WINDOW)).cursor).toBe(
          length - REPOSITORY_TAIL_WINDOW,
        )
    }
    for (const [name, scope, control] of [
      ['buildStreamSeed', scopes[0], buildStreamSeedReducer],
      ['repositoryAttention', scopes[1], repositoryAttentionReducer],
    ] as const) {
      const entry = REDUCERS[name]!.valueRead
      if ('excluded' in entry) throw new Error('missing seed entry')
      const create = entry.create
      const validate = entry.validate
      entry.validate = (state) => {
        if (!state || typeof state !== 'object') return false
        const { addedByNewVersion, ...prior } = state as Record<string, unknown>
        return typeof addedByNewVersion === 'number' && validate(prior)
      }
      try {
        // A new reducer requires a field absent from the old accumulator. No
        // upgrader or old implementation is supplied to historical lookup.
        for (let generation = 1; generation <= 2; generation++) {
          const reducer = create({})
          entry.create = () => ({
            ...reducer,
            version: reducer.version + generation,
            initial: () => ({ ...reducer.initial(), addedByNewVersion: 0 }),
            finish: (acc) => ({ ...reducer.finish(acc), addedByNewVersion: acc.addedByNewVersion }),
            advance: (acc, events) => ({
              ...reducer.advance(acc, events),
              addedByNewVersion: (acc.addedByNewVersion ?? 0) + events.length,
            }),
          })
          const baseline = await canonicalControl(scope, name)
          counter.reset()
          const seed = await store.getStreamSeed(scope, requested)
          expect(counter.rows + counter.buildRows).toBe(length)
          const events =
            scope.kind === 'build' ? await store.getEvents(slug) : await store.getRepoEvents(repo)
          expect(seed.value).toMatchObject(
            JSON.parse(JSON.stringify(control.reduce(events.slice(0, requested) as never))),
          )
          expect(seed.value).toMatchObject({ addedByNewVersion: requested })
          expect((await store.getStreamSeed(scope, length)).value).toEqual(baseline.value)
          counter.reset()
          await store.getStreamSeed(scope, requested)
          expect(counter.rows + counter.buildRows).toBe(0)
        }
        entry.create = create
        counter.reset()
        await expect(store.getStreamSeed(scope, requested)).rejects.toBeInstanceOf(
          RetiredSeedGenerationError,
        )
        expect(counter.rows + counter.buildRows).toBe(0)
        const checkpoints = Reflect.get(store, 'seedCheckpoints') as Map<
          string,
          Map<number, unknown>
        >
        for (const values of checkpoints.values()) {
          expect(values.size).toBeLessThanOrEqual(REPOSITORY_TAIL_WINDOW + 1)
          // Representative fixture checkpoints contain state, never an event prefix.
          expect(Buffer.byteLength(JSON.stringify(values.values().next().value))).toBeLessThan(
            64_000,
          )
        }
      } finally {
        entry.create = create
        entry.validate = validate
      }
    }
  }
  expect(gapCosts).toEqual([14, 14])
}

/** The backlog and rejected roles ride the dispatcher's existing ticket reads:
 * a role-aware tick issues exactly as many ticket-source requests as a
 * role-free one, at 100 and at 100,000 repository events, and an unchanged
 * read after it costs zero event rows. `open` returns the source a project
 * with `config` dispatches over and a running count of its source requests.
 *
 * Each tick is followed by the interactive dispatcher's triage sample: exactly
 * `sampleRequests` source requests (one bounded count, or none for a source
 * without counts), never a listing, zero event rows, and the same cost at
 * every log length. */
export async function ticketRoleTickBudget(
  open: (
    config: import('../config/schema').Config,
  ) => Promise<{ tickets: import('../ports/types').TicketSource; requests: () => number }>,
  sampleRequests: 0 | 1,
) {
  const { MemoryBuildStore } = await import('../store/memory')
  const sha = 'a'.repeat(40)
  const perTick = new Map<string, number[]>()
  for (const roles of [false, true]) {
    for (const length of [100, 100_000]) {
      const config = parseConfig(
        `[tickets]\nsource = "hosted"\nteamKey = "ENG"\n${
          roles ? 'backlogState = "icebox"\nrejectedState = "rejected"\n' : ''
        }[verify]\nsteps = []\n[finalize]\nsteps = []\n`,
      )
      const { tickets, requests } = await open(config)
      // Every ready ticket is blocked, so ticks claim nothing and change nothing.
      const seed = async (title: string, state: string, blocker?: string) => {
        const ticket = await tickets.create({ title, body: 'Budget' })
        if (blocker !== undefined) await tickets.addBlocker(ticket.ref.id, blocker)
        await tickets.transition(ticket.ref.id, state)
        return ticket.ref.id
      }
      const rejected = await seed('Rejected blocker', 'rejected')
      const pending = await seed('Incomplete blocker', 'triage')
      await seed('Blocked by rejected', 'ready', rejected)
      await seed('Blocked by incomplete', 'ready', pending)
      await seed('Deferred', 'icebox')

      let now = 1_800_000_000_000
      const clock = () => new Date(now)
      const store = new MemoryBuildStore({ clock })
      const repo = `https://github.com/budget/ticket-roles-${roles}-${length}`
      await store.ensureRepo(repo)
      for (let i = 0; i < length; i++)
        await store.appendRepo(repo, {
          actor: humanActor('budget'),
          type: 'dispatcher.intake-set',
          payload: { enabled: true },
        })
      // The one serialized reduction per key happens before the measured ticks.
      await readRepositoryFacts(store, repo)
      await readBuildDigests(store, repo)
      const counter = memoryRepositoryReadCounter(store, repo)
      const costs: number[] = []
      for (let tick = 0; tick < 2; tick++) {
        now += 60_000
        const forge = new FakeForge()
        forge.seedBranch('main', sha)
        const dispatcher = new Dispatcher({
          store,
          tickets,
          workspaces: new FakeWorkspaceProvider({
            root: '/ticket-role-budget',
            mode: 'logical',
            base: { source: 'remote', sha },
          }),
          forge,
          config,
          repo,
          exec: async () => ({ stdout: `${sha}\trefs/heads/main\n`, stderr: '', exitCode: 0 }),
          launchRunner: async () => {
            throw new Error('no launches in the ticket role budget')
          },
          ids: sequentialIds(),
          clock,
        })
        const before = requests()
        counter.reset()
        const report = await dispatcher.tick()
        costs.push(requests() - before)
        expect(report.dispatched).toBe(0)
        expect(report.dependencyBlocked).toBe(2)
        expect(
          report.dependencyDiagnostics.some((line) => line.endsWith('which was rejected')),
        ).toBe(roles)
        expect(counter.rows).toBeLessThanOrEqual(32)
        // The interactive dispatcher's per-tick triage sample, exactly as it
        // calls it: one bounded count at most, never a listing or an event read.
        const listStates = Object.getOwnPropertyDescriptor(tickets, 'listStates')
        Object.defineProperty(tickets, 'listStates', {
          configurable: true,
          writable: true,
          value: async () => {
            throw new Error('the triage sample never lists ticket states')
          },
        })
        try {
          const sampleBefore = requests()
          counter.reset()
          const triage = await boundedStateCount(tickets, defaultTriageState(config))
          expect(requests() - sampleBefore).toBe(sampleRequests)
          expect(triage === undefined).toBe(sampleRequests === 0)
          expect(counter.rows).toBe(0)
        } finally {
          if (listStates === undefined) Reflect.deleteProperty(tickets, 'listStates')
          else Object.defineProperty(tickets, 'listStates', listStates)
        }
        // Prepare the tick's own tail, then prove an unchanged read costs zero rows.
        await readRepositoryFacts(store, repo)
        await readBuildDigests(store, repo)
        counter.reset()
        await readRepositoryFacts(store, repo)
        await readBuildDigests(store, repo)
        expect(counter.rows).toBe(0)
      }
      perTick.set(`${roles}:${length}`, costs)
      await store.close()
    }
  }
  const [baseline, ...rest] = [...perTick.values()]
  for (const costs of rest) expect(costs).toEqual(baseline!)
  return baseline!
}

/** Urgent intake order (AUT-1027) is an in-memory partition of the one ready
 * listing a due scan already reads: with and without an urgent ticket present,
 * a quiet intake tick makes the same source calls and the same store reads, at
 * 100 and 100,000 repository events, and an unchanged follow-up read costs zero
 * rows. Returns the per-method source calls of one tick. */
export async function urgentIntakeReadBudget() {
  const { MemoryBuildStore } = await import('../store/memory')
  const sha = 'a'.repeat(40)
  const plain =
    '[tickets]\nsource = "hosted"\nteamKey = "ENG"\n[verify]\nsteps = []\n[finalize]\nsteps = []\n'
  // Profile selection is pure label matching over the listing the scan
  // already holds (SPEC §9): one selected and one conflicting ticket must
  // cost no extra source request or store row.
  const profiled = `${plain}[profiles.deep]\nlabel = "deep"\n[profiles.cheap]\nlabel = "cheap"\n`
  const methods = ['listReady', 'get', 'dependencyStates', 'listAll'] as const
  const results = new Map<string, { calls: Record<string, number>[]; rows: number[] }>()
  const profileResults = new Map<string, { calls: Record<string, number>[]; rows: number[] }>()
  for (const [urgent, profiles] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const) {
    const config = parseConfig(profiles ? profiled : plain)
    for (const length of [100, 100_000]) {
      const source = new FakeTicketSource([], { createState: 'triage', doneState: 'done' })
      const calls: Record<string, number> = Object.fromEntries(methods.map((name) => [name, 0]))
      const tickets = new Proxy(source, {
        get(target, key) {
          const value = Reflect.get(target, key, target)
          if (typeof value !== 'function') return value
          return (...args: unknown[]) => {
            if (typeof key === 'string' && key in calls) calls[key]! += 1
            return value.apply(target, args)
          }
        },
      })
      // Every ready ticket is blocked by one unresolved ticket, so ticks claim nothing.
      const blocker = await source.create({ title: 'Unresolved blocker', body: 'Budget' })
      for (const [index, title] of ['N1', 'N2', 'U1'].entries()) {
        const ticket = await source.create({
          title,
          body: 'Budget',
          ...(urgent && index === 2 ? { priority: 'urgent' as const } : {}),
          ...(profiles
            ? { labels: index === 0 ? ['deep'] : index === 1 ? ['deep', 'cheap'] : [] }
            : {}),
        })
        await source.addBlocker(ticket.ref.id, blocker.ref.id)
        await source.transition(ticket.ref.id, 'ready')
      }

      let now = 1_800_000_000_000
      const clock = () => new Date(now)
      const store = new MemoryBuildStore({ clock })
      const repo = `https://github.com/budget/urgent-intake-${urgent}-${profiles}-${length}`
      await store.ensureRepo(repo)
      for (let i = 0; i < length; i++)
        await store.appendRepo(repo, {
          actor: humanActor('budget'),
          type: 'dispatcher.intake-set',
          payload: { enabled: true },
        })
      // The one serialized reduction per key happens before the measured ticks.
      await readRepositoryFacts(store, repo)
      await readBuildDigests(store, repo)
      const counter = memoryRepositoryReadCounter(store, repo)
      const perTick: Record<string, number>[] = []
      const rows: number[] = []
      for (let tick = 0; tick < 2; tick++) {
        now += 60_000
        const forge = new FakeForge()
        forge.seedBranch('main', sha)
        const dispatcher = new Dispatcher({
          store,
          tickets,
          workspaces: new FakeWorkspaceProvider({
            root: '/urgent-intake-budget',
            mode: 'logical',
            base: { source: 'remote', sha },
          }),
          forge,
          config,
          repo,
          exec: async () => ({ stdout: `${sha}\trefs/heads/main\n`, stderr: '', exitCode: 0 }),
          launchRunner: async () => {
            throw new Error('no launches in the urgent intake budget')
          },
          ids: sequentialIds(),
          clock,
        })
        const before = { ...calls }
        counter.reset()
        const report = await dispatcher.tick()
        perTick.push(
          Object.fromEntries(methods.map((name) => [name, calls[name]! - before[name]!])),
        )
        rows.push(counter.rows)
        expect(report.dispatched).toBe(0)
        // A conflicting ticket is withheld before dependency checks.
        expect(report.dependencyBlocked).toBe(profiles ? 2 : 3)
        expect(report.invalidTickets).toBe(profiles ? 1 : 0)
        expect(counter.rows).toBeLessThanOrEqual(32)
        // Prepare the tick's own tail, then prove an unchanged read costs zero rows.
        await readRepositoryFacts(store, repo)
        await readBuildDigests(store, repo)
        counter.reset()
        await readRepositoryFacts(store, repo)
        await readBuildDigests(store, repo)
        expect(counter.rows).toBe(0)
      }
      ;(profiles ? profileResults : results).set(`${urgent}:${length}`, {
        calls: perTick,
        rows,
      })
      await store.close()
    }
  }
  const [baseline, ...rest] = [...results.values()]
  for (const result of rest) expect(result).toEqual(baseline!)
  const [profileBaseline, ...profileRest] = [...profileResults.values()]
  for (const result of profileRest) expect(result).toEqual(profileBaseline!)
  // Profiles never add a request or a row; withholding a conflict can only save.
  profileBaseline!.calls.forEach((tick, index) => {
    for (const name of methods)
      expect(tick[name]).toBeLessThanOrEqual(baseline!.calls[index]![name]!)
    expect(profileBaseline!.rows[index]).toBeLessThanOrEqual(baseline!.rows[index]!)
  })
  return baseline!.calls[0]!
}

/** Native identity maintenance (SPEC §15.7) adds one forge identity read per
 * armed, eligible poll and nothing else: a fresh dispatcher's quiet
 * maintenance tick reads no history, spends exactly the store reads of the same
 * tick with the native block skipped, appends nothing, and costs the same at
 * 100 and 10,000 events. */
export async function nativeMaintenanceReadBudget(opts: {
  store: import('../store/memory').MemoryBuildStore
  slug: string
  forge: FakeForge
  tick: () => Promise<unknown>
}) {
  const { store, slug, forge } = opts
  const events = buildEventRows(store, slug)
  let baseline: number[] | undefined
  for (const length of [100, 10_000]) {
    let filler = 0
    while (events.length < length)
      await store.append(slug, {
        actor: KERNEL,
        type: 'observation.recorded',
        payload: { id: `obs_budget_${length}_${filler++}`, kind: 'followup', summary: 'filler' },
      })
    // Warm the saved reduced values past the filler before measuring.
    await opts.tick()
    const boundary = events.at(-1)!.seq
    const metrics = { historicalRows: 0, tailRows: 0 }
    let calls = 0
    const getReduced = store.getReducerValue.bind(store)
    store.getReducerValue = async (...args) => {
      calls++
      return getReduced(...args)
    }
    const restore = instrumentBuildRows(store, slug, () => boundary, metrics)
    const getPrState = forge.getPrState.bind(forge)
    const measure = async () => {
      metrics.historicalRows = metrics.tailRows = calls = 0
      const reads = forge.identityReads.length
      await opts.tick()
      expect(metrics.historicalRows).toBe(0)
      return {
        rows: metrics.tailRows,
        calls,
        identityReads: forge.identityReads.length - reads,
      }
    }
    try {
      const maintenance = await measure()
      forge.getPrState = async (...args) => {
        const { nativeAutoMerge: _omitted, ...state } = (await getPrState(...args)) as PrStateLike
        return state
      }
      const skipped = await measure()
      expect(maintenance.identityReads).toBe(1)
      expect(skipped.identityReads).toBe(0)
      expect(maintenance.calls).toBe(skipped.calls)
      expect(maintenance.rows).toBe(skipped.rows)
      expect(events.at(-1)!.seq).toBe(boundary)
      const costs = [maintenance.rows, maintenance.calls]
      if (baseline) expect(costs).toEqual(baseline)
      baseline = costs
    } finally {
      restore()
      store.getReducerValue = getReduced
      Reflect.deleteProperty(forge, 'getPrState')
    }
  }
}

type PrStateLike = Awaited<ReturnType<FakeForge['getPrState']>> & { nativeAutoMerge?: boolean }
/** The bounded replaced-head record rides in the saved build facts: a warm
 * read touches no event rows, and its size is fixed at any rewrite count. */
export async function replacedHeadsReadBudget(opts: {
  store: BuildStore
  costs: ReducedReadCosts
  fresh: () => Promise<BuildStore>
}) {
  const { store, costs } = opts
  const node = 'replaced-heads-budget'
  const oid = (n: number) => n.toString(16).padStart(40, '0')
  await store.createBuild({ slug: node, repo, branch: 'ab-node/replaced-heads-budget' })
  const log = nodeRestackLog()
  for (const event of log.slice(0, 2)) await store.append(node, event)
  const replaced: string[] = []
  let appended = 0
  let transaction = 0
  const sizes = new Map<number, number>()
  // Both journal lengths hold more rewrites than the record's capacity.
  for (const length of [1_000, 10_000]) {
    while (appended < length) {
      const id = transaction++
      for (const event of log.slice(2)) {
        const payload = JSON.parse(
          JSON.stringify(event.payload)
            .replaceAll('node-tx', `rewrite-${id}`)
            .replaceAll('a'.repeat(40), oid(id * 2 + 1))
            .replaceAll('c'.repeat(40), oid(id * 2 + 2)),
        )
        await store.append(node, { actor: event.actor, type: event.type, payload })
        appended++
      }
      replaced.push(oid(id * 2 + 1))
    }
    expect(replaced.length).toBeGreaterThan(REPLACED_HEADS_CAP)
    for (const reader of [store, await opts.fresh()]) {
      await readBuildFacts(reader, node)
      costs.events = costs.metadata = costs.bytes = 0
      const facts = (await readBuildFacts(reader, node)).value
      expect(costs.events).toBe(0)
      expect(facts.replacedHeads).toEqual(replaced.slice(-REPLACED_HEADS_CAP))
      const size = JSON.stringify(facts.replacedHeads).length
      if (length === 1_000) sizes.set(0, size)
      else expect(size).toBe(sizes.get(0)!)
    }
  }
}

/** A repository with no dispatcher run answers its dashboard poll from the
 * saved reduction: zero event rows once warm, at any journal length. */
export async function noDispatcherRunDashboardBudget() {
  const { MemoryBuildStore } = await import('../store/memory')
  for (const size of [10, 300]) {
    const store = new MemoryBuildStore({ clock: () => new Date(1000) })
    await store.ensureRepo(repo)
    const toggle = async (count: number) => {
      for (let i = 0; i < count; i++)
        await store.appendRepo(repo, {
          actor: humanActor('operator'),
          type: 'dispatcher.intake-set',
          payload: { enabled: i % 2 === 1 },
        })
    }
    await toggle(size)
    const counter = memoryRepositoryReadCounter(store, repo)
    const poll = () => getOperatorDashboard({ store, repo, clock: () => new Date(1000) })
    const warm = await poll()
    expect(warm.model.configuration).toBe('no-dispatcher-run')
    counter.reset()
    for (let i = 0; i < 3; i++) await poll()
    expect(counter.rows).toBe(0)
    // New facts advance the saved value by their delta only.
    await toggle(4)
    counter.reset()
    expect((await poll()).settingsHeader.intake).toBe(true)
    expect(counter.rows).toBeLessThanOrEqual(4)
    counter.reset()
    await poll()
    expect(counter.rows).toBe(0)
  }
}

/** Tally the store requests callers make, by method name: every
 * function-valued store method is counted when entered from outside the store,
 * never when the adapter calls its own methods. `restore` removes the
 * instrumentation. */
export function memoryStoreRequestCounter(store: BuildStore) {
  const inside = new AsyncLocalStorage<true>()
  const counts = new Map<string, number>()
  const names = new Set<string>()
  for (
    let proto: object | null = store;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  )
    for (const name of Object.getOwnPropertyNames(proto))
      if (name !== 'constructor' && typeof Reflect.get(store, name) === 'function') names.add(name)
  const wrapped = new Map<string, { own: boolean; original: (...args: unknown[]) => unknown }>()
  for (const name of names) {
    const original = Reflect.get(store, name) as (...args: unknown[]) => unknown
    wrapped.set(name, { own: Object.hasOwn(store, name), original })
    Reflect.set(store, name, (...args: unknown[]) => {
      if (inside.getStore()) return original.apply(store, args)
      counts.set(name, (counts.get(name) ?? 0) + 1)
      return inside.run(true, () => original.apply(store, args))
    })
  }
  return {
    /** Calls since the last reset, by method name, in sorted order. */
    vector(): Record<string, number> {
      return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)))
    },
    reset() {
      counts.clear()
    },
    restore() {
      for (const [name, { own, original }] of wrapped)
        if (own) Reflect.set(store, name, original)
        else Reflect.deleteProperty(store, name)
    },
  }
}

/** A janitor that keeps failing for one build costs every fresh-dispatcher tick
 * the same store requests at 100 and at 100,000 events. The vectors are
 * returned per tick class so a caller can pin them against an earlier
 * implementation: episode start, a failure before attention, the attention
 * failure, a failure before the escalation limit, the threshold failure, a
 * failure after it, and the recovering attempt. */
export async function janitorEscalationRequestBudget(opts: {
  store: import('../store/memory').MemoryBuildStore
  repo: string
  slug: string
  /** One tick on a fresh dispatcher. */
  tick: () => Promise<unknown>
  now: () => Date
  advance: (ms: number) => void
  /** Make the build's janitor work fail (true) or succeed (false). */
  failing: (value: boolean) => void
  /** Episode age at which the threshold failure is expected. */
  limitSeconds: number
  attentionSeconds: number
}) {
  const { store, repo, slug } = opts
  type Vectors = Record<
    'start' | 'preAttention' | 'attention' | 'preLimit' | 'threshold' | 'escalated' | 'recovery',
    Record<string, number>
  >
  const escalations = async () =>
    (await store.getEvents(slug)).filter(
      (event) => String(event.type) === 'build.janitor-escalated',
    ).length
  const results: { length: number; vectors: Vectors; escalations: number }[] = []
  await store.ensureRepo(repo)
  let seeded = 0
  for (const length of [100, 100_000]) {
    for (; seeded < length; seeded++) {
      await store.appendRepo(repo, {
        actor: humanActor('budget'),
        type: 'dispatcher.intake-set',
        payload: { enabled: true },
      })
      if (seeded % 10 === 0)
        await store.append(slug, {
          actor: KERNEL,
          type: 'observation.recorded',
          payload: { id: `obs-${seeded}`, kind: 'followup', summary: `budget padding ${seeded}` },
        })
    }
    // Warm up: a fresh dispatcher folds the padding once while nothing fails.
    opts.failing(false)
    await opts.tick()
    opts.failing(true)
    const before = await escalations()
    const counter = memoryStoreRequestCounter(store)
    const vectors: Partial<Vectors> = {}
    try {
      const measure = async () => {
        counter.reset()
        await opts.tick()
        return counter.vector()
      }
      const due = async () => {
        const { state } = (await readBuildFacts(store, slug)).value
        const next = state.janitor && Date.parse(state.janitor.nextAttemptAt)
        if (next) opts.advance(Math.max(0, next - opts.now().getTime()))
        return state.janitor ? Date.parse(state.janitor.firstFailureAt) : undefined
      }
      vectors.start = await measure()
      const first = (await due())!
      vectors.preAttention = await measure()
      for (;;) {
        await due()
        const age = opts.now().getTime() - first
        const vector = await measure()
        if (age >= opts.limitSeconds * 1000) {
          vectors.threshold = vector
          break
        }
        if (age >= opts.attentionSeconds * 1000 && !vectors.attention) vectors.attention = vector
        else if (vectors.attention) vectors.preLimit = vector
      }
      await due()
      vectors.escalated = await measure()
      opts.failing(false)
      await due()
      vectors.recovery = await measure()
    } finally {
      counter.restore()
    }
    expect((await readBuildFacts(store, slug)).value.state.janitor).toBeUndefined()
    results.push({
      length,
      vectors: vectors as Vectors,
      escalations: (await escalations()) - before,
    })
  }
  expect(results[1]!.vectors).toEqual(results[0]!.vectors)
  return { vectors: results[0]!.vectors, escalations: results.map((r) => r.escalations) }
}

/** AUT-1152: a prepared hosted guest re-reads its execution authority at its
 * durable boundaries. Proves the probe is one constant-size served value:
 * after the one-time reduction per key, an unchanged re-read issues the same
 * single request and reads zero event rows, and its response is the same size
 * whether the repository has had one harvest execution or a thousand; one new
 * fact costs exactly one row. */
export async function hostedHarvestAuthorityReadBudget() {
  const { MemoryBuildStore } = await import('../store/memory')
  const repo = '/repo'
  const guest = { execution: 'guest', run: 'h_guest', leaseHolder: 'inv-1' }
  const sizes = [
    { cycles: 1, filler: 100 },
    { cycles: 1_000, filler: 10_000 },
  ]
  const results: Array<{
    warmRows: number
    unchanged: { vector: Record<string, number>; rows: number; size: number }
    appended: { rows: number; size: number }
    replaced: { rows: number; decision: ReturnType<typeof decideHostedHarvestAuthority> }
  }> = []
  for (const { cycles, filler } of sizes) {
    const store = new MemoryBuildStore()
    await seedPreparationHistory(store, repo, filler)
    for (let i = 0; i < cycles; i++) {
      const run = `h_old_${i}`
      const execution = `old-${i}`
      await store.appendRepo(repo, {
        actor: KERNEL,
        type: 'harvest.started',
        payload: {
          run,
          observations: [{ build: `b-${i}`, seq: 1 }],
          scan: { kind: 'harvest-scan', rev: i },
        },
      })
      await store.appendRepo(repo, {
        actor: DISPATCHER,
        type: 'harvest.execution.authorized',
        payload: { execution, run, launch: 'started', leaseHolder: `inv-old-${i}` },
      })
      await store.appendRepo(repo, {
        actor: DISPATCHER,
        type: 'harvest.execution.started',
        payload: { execution, provider: 'p', environmentId: `env-${i}` },
      })
      await store.appendRepo(repo, {
        actor: DISPATCHER,
        type: 'harvest.execution.released',
        payload: { execution, environmentId: `env-${i}`, snapshots: { outcome: 'confirmed' } },
      })
    }
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'harvest.execution.authorized',
      payload: { ...guest, launch: 'started' },
    })
    const rows = memoryRepositoryReadCounter(store, repo)
    const requests = memoryStoreRequestCounter(store)
    try {
      const probe = async () => {
        rows.reset()
        requests.reset()
        const { value } = await readHostedHarvestAuthority(store, repo)
        return {
          vector: requests.vector(),
          rows: rows.rows,
          size: JSON.stringify(value).length,
          decision: decideHostedHarvestAuthority(value, guest),
        }
      }
      // The one-time reduction of this (repo, reducer) key.
      const warm = await probe()
      const unchanged = await probe()
      expect(unchanged.decision).toEqual({ kind: 'authorized' })
      await store.appendRepo(repo, {
        actor: humanActor('budget'),
        type: 'dispatcher.intake-set',
        payload: { enabled: true },
      })
      const appended = await probe()
      expect(appended.decision).toEqual({ kind: 'authorized' })
      await store.appendRepo(repo, {
        actor: DISPATCHER,
        type: 'harvest.execution.authorized',
        payload: {
          execution: 'successor',
          run: guest.run,
          launch: 'resumed',
          leaseHolder: 'inv-2',
        },
      })
      const replaced = await probe()
      results.push({
        warmRows: warm.rows,
        unchanged: { vector: unchanged.vector, rows: unchanged.rows, size: unchanged.size },
        appended: { rows: appended.rows, size: appended.size },
        replaced: { rows: replaced.rows, decision: replaced.decision },
      })
    } finally {
      requests.restore()
    }
  }
  const [small, large] = results as [(typeof results)[0], (typeof results)[0]]
  for (const result of results) {
    expect(result.unchanged.vector).toEqual({ getReducerValue: 1 })
    expect(result.unchanged.rows).toBe(0)
    expect(result.appended.rows).toBe(1)
    expect(result.replaced.rows).toBe(1)
    expect(result.replaced.decision).toEqual({ kind: 'fenced', reason: 'replaced' })
  }
  expect(large.unchanged.size).toBe(small.unchanged.size)
  expect(large.appended.size).toBe(small.appended.size)
  return { small, large }
}

/** Head path facts are recorded by producers, never derived on the landing
 * poll: an awaiting-PR leaf costs fresh-dispatcher ticks no path-deriving git
 * command, zero `head-paths` artifact reads and zero event rows once warm, and the
 * same store requests at 100 and 100,000 events. Returns the measured vector
 * so a caller can compare a recorded build against a pre-change one. */
export async function headPathsLandingReadBudget(opts: {
  store: import('../store/memory').MemoryBuildStore
  repo: string
  slug: string
  /** Whether the PR head carries a recorded fact. */
  recorded: boolean
  /** Path-predicate merge rules: warm-up must have appended exactly one of
   * these, reading a decided head's complete paths exactly once. */
  warm?: 'landing.decided' | 'landing.deferred'
  /** After a decided warm-up: consent to that decision, then a reconcile's
   * revocation of it, re-warmed once. Revoked consent adds no poll cost. */
  revokedConsent?: true
  /** One tick on a fresh dispatcher. */
  tick: () => Promise<unknown>
  advance: (ms: number) => void
  /** Git commands attempted so far. */
  git: () => readonly string[][]
}) {
  const { store, repo, slug } = opts
  /** The commands that derive a head's path facts. */
  const pathFact = /^(merge-base|diff|merge-tree|worktree|cherry-pick|write-tree)$/
  const { candidateHeadPaths, HEAD_PATHS_ARTIFACT, HEAD_PATHS_PREVIEW } = await import(
    '../kernel/head-paths'
  )
  let artifactReads = 0
  let totalArtifactReads = 0
  const getArtifact = store.getArtifact.bind(store)
  store.getArtifact = async (s, kind, rev) => {
    if (kind === HEAD_PATHS_ARTIFACT) {
      artifactReads++
      totalArtifactReads++
    }
    return getArtifact(s, kind, rev)
  }
  await store.ensureRepo(repo)
  let seeded = 0
  const vectors: Record<string, number>[] = []
  try {
    for (const length of [100, 100_000]) {
      for (; seeded < length; seeded++) {
        await store.appendRepo(repo, {
          actor: humanActor('budget'),
          type: 'dispatcher.intake-set',
          payload: { enabled: true },
        })
        if (seeded % 10 === 0)
          await store.append(slug, {
            actor: KERNEL,
            type: 'observation.recorded',
            payload: { id: `obs-${seeded}`, kind: 'followup', summary: `budget padding ${seeded}` },
          })
      }
      for (let n = 0; n < 2; n++) {
        opts.advance(120_000)
        await opts.tick()
      }
      if (opts.warm) {
        const landing = (await store.getEvents(slug)).filter(
          (event) => event.type === 'landing.decided' || event.type === 'landing.deferred',
        )
        expect(landing.map((event) => event.type)).toEqual([opts.warm])
        expect(totalArtifactReads).toBe(opts.warm === 'landing.decided' ? 1 : 0)
      }
      if (opts.revokedConsent && length === 100) {
        const decided = (await store.getEvents(slug)).findLast(
          (event) => event.type === 'landing.decided',
        )
        if (decided?.type !== 'landing.decided') throw new Error('revokedConsent needs a decision')
        const consent = await store.append(slug, {
          actor: humanActor('budget'),
          type: 'build.land-requested',
          payload: { decisionSeq: decided.seq },
        })
        expect((await readBuildFacts(store, slug)).value.state.landing?.command?.rule).toBeDefined()
        const rule = 'index' in decided.payload.rule ? decided.payload.rule : undefined
        if (rule?.snapshot.paths === undefined && rule?.snapshot.within === undefined)
          throw new Error('revokedConsent needs a decision under a path-predicate rule')
        await store.append(slug, {
          actor: KERNEL,
          type: 'landing.consent-revoked',
          payload: {
            commandSeq: consent.seq,
            source: 'reconcile',
            rule,
            previousHead: decided.payload.candidate.head,
            head: decided.payload.candidate.head,
            paths: { total: 1, preview: ['autobuild.toml'] },
          },
        })
        expect((await readBuildFacts(store, slug)).value.state.landing?.command).toBeUndefined()
        for (let n = 0; n < 2; n++) {
          opts.advance(120_000)
          await opts.tick()
        }
      }
      const rows = memoryRepositoryReadCounter(store, repo)
      const requests = memoryStoreRequestCounter(store)
      try {
        let vector: Record<string, number> | undefined
        for (let n = 0; n < 3; n++) {
          opts.advance(120_000)
          rows.reset()
          requests.reset()
          artifactReads = 0
          const before = opts.git().length
          await opts.tick()
          const spawned = opts.git().slice(before)
          expect(spawned.filter((cmd) => pathFact.test(cmd[1] ?? ''))).toEqual([])
          expect(artifactReads).toBe(0)
          expect(rows.rows).toBe(0)
          expect(rows.buildRows).toBe(0)
          const measured: Record<string, number> = {
            ...requests.vector(),
            gitSpawns: spawned.length,
          }
          if (vector) expect(measured).toEqual(vector)
          vector = measured
        }
        vectors.push(vector!)
      } finally {
        requests.restore()
      }
    }
  } finally {
    store.getArtifact = getArtifact
  }
  expect(vectors[1]).toEqual(vectors[0])
  const answer = candidateHeadPaths((await readBuildFacts(store, slug)).value.state)
  expect(answer.recorded).toBe(opts.recorded)
  if (answer.recorded) {
    expect(answer.record.total).toBeGreaterThan(HEAD_PATHS_PREVIEW)
    expect(answer.record.preview).toHaveLength(HEAD_PATHS_PREVIEW)
  }
  return vectors[0]!
}

/** Build state carries bounded head path summaries: past the record capacity,
 * with every complete set far beyond the preview, a fresh reader's warm build
 * facts read zero events and serve the same size at 1,000 and 10,000 events. */
export async function headPathsStateReadBudget(opts: {
  store: BuildStore
  costs: ReducedReadCosts
  fresh: () => Promise<BuildStore>
}) {
  const { store, costs } = opts
  const { headPathsWrite, readHeadPaths, HEAD_PATHS_RECORDS } = await import('../kernel/head-paths')
  const slug = 'head-paths-budget'
  const oid = (n: number) => n.toString(16).padStart(40, '0')
  const paths = Array.from({ length: 1_001 }, (_, i) => `src/f${String(i).padStart(5, '0')}.ts`)
  await store.createBuild({ slug, repo, branch: `ab/${slug}` })
  let appended = 0
  let facts = 0
  let size: number | undefined
  for (const length of [1_000, 10_000]) {
    while (appended < length) {
      if (appended % 100 === 0) {
        const { artifacts, makeEvent } = headPathsWrite(
          {
            version: 1,
            head: oid(++facts),
            destination: oid(0x10_0000 + facts),
            mergeBase: oid(0x20_0000 + facts),
            paths,
          },
          'finalize',
          KERNEL,
        )
        await store.appendWithArtifacts(slug, artifacts, makeEvent)
      } else
        await store.append(slug, {
          actor: KERNEL,
          type: 'observation.recorded',
          payload: { id: `obs-${appended}`, kind: 'followup', summary: `padding ${appended}` },
        })
      appended++
    }
    expect(facts).toBeGreaterThan(HEAD_PATHS_RECORDS)
    for (const reader of [store, await opts.fresh()]) {
      await readBuildFacts(reader, slug)
      costs.events = costs.metadata = costs.bytes = 0
      const { state } = (await readBuildFacts(reader, slug)).value
      expect(costs.events).toBe(0)
      const records = state.headPaths ?? []
      expect(records.map((record) => record.head)).toEqual(
        Array.from({ length: HEAD_PATHS_RECORDS }, (_, i) =>
          oid(facts - HEAD_PATHS_RECORDS + 1 + i),
        ),
      )
      // Seqs and revisions grow by a digit; the served summaries do not.
      const served = JSON.stringify(
        records.map(({ seq: _seq, artifact: _artifact, ...summary }) => summary),
      ).length
      if (size === undefined) size = served
      else expect(served).toBe(size)
      expect((await readHeadPaths(reader, slug, records.at(-1)!)).paths).toEqual(paths)
    }
  }
}

/** MCP `repository.events` pages a large backlog through the bounded tail
 * port: every call scans at most one page of disjoint, contiguous rows, the
 * whole backlog costs exactly its length, an unchanged cursor reads zero
 * rows, and nothing falls back to the unbounded journal read. */
export async function repositoryEventsReadBudget() {
  const { MemoryBuildStore } = await import('../store/memory')
  const { repositoryNeedsAttention } = await import('../cli/attention')
  const { REPOSITORY_EVENTS_PAGE } = await import('../operator/repository-events')
  const store = new MemoryBuildStore()
  const repo = 'repository-events-budget'
  await store.ensureRepo(repo)
  const total = 900
  for (let i = 1; i <= total; i++) {
    if (i % 200 === 0)
      await store.appendRepo(repo, {
        actor: DISPATCHER,
        type: 'ticket.handed-back',
        payload: {
          ticket: { source: 'fake', id: `T-${i}` },
          build: `b-${i}`,
          cause: 'abort',
          state: 'Ready',
          role: 'ready',
        },
      })
    else
      await store.appendRepo(repo, {
        actor: humanActor('budget'),
        type: 'dispatcher.intake-set',
        payload: { enabled: true },
      })
  }
  const counter = memoryRepositoryReadCounter(store, repo)
  const ranges: { since: number; through: number | undefined; rows: number }[] = []
  const tail = store.getRepositoryTail.bind(store)
  store.getRepositoryTail = async (r, since, opts) => {
    const before = counter.rows
    const events = await tail(r, since, opts)
    ranges.push({ since: since ?? 0, through: opts?.through, rows: counter.rows - before })
    return events
  }
  store.getRepoEvents = async () => {
    throw new Error('repository.events must never read the unbounded journal')
  }
  const registry = buildRegistry({ store })
  const delivered: unknown[] = []
  let cursor = 0
  for (;;) {
    const page = (await registry.call('repository.events', { repo, cursor })) as {
      events: { seq: number }[]
      cursor: number
      hasMore: boolean
    }
    delivered.push(...page.events)
    cursor = page.cursor
    if (!page.hasMore) break
  }
  const pages = ranges.length
  expect(cursor).toBe(total)
  expect(ranges.every((range) => range.rows <= REPOSITORY_EVENTS_PAGE)).toBe(true)
  expect(ranges.every((range) => range.through === range.since + REPOSITORY_EVENTS_PAGE)).toBe(true)
  ranges.forEach((range, index) => {
    if (index > 0) expect(range.since).toBe(ranges[index - 1]!.since + ranges[index - 1]!.rows)
  })
  expect(ranges.reduce((sum, range) => sum + range.rows, 0)).toBe(total)
  const all = (await tail(repo, 0)).filter(repositoryNeedsAttention)
  expect(delivered).toEqual(all)
  expect(all).toHaveLength(Math.floor(total / 200))
  // Idle polls at the head read zero event rows; a baseline reads none either.
  counter.reset()
  const idle = await registry.call('repository.events', { repo, cursor })
  expect(idle).toEqual({ events: [], cursor, hasMore: false })
  expect(await registry.call('repository.events', { repo })).toEqual({
    events: [],
    cursor: total,
    hasMore: false,
  })
  expect(counter.rows).toBe(0)
  return pages
}

/**
 * Configured hooks (`processes/hooks.ts`) cost the same at every growth
 * setting: journal length, this repository's historical terminal builds,
 * foreign-repository builds and records already delivered. With two active
 * builds and fixed new work, it measures
 *
 * 1. idle intervals — exactly one `getRepoChangePosition` per interval for
 *    every hook together, zero event rows and zero reduced reads;
 * 2. a changed pass — only the new rows;
 * 3. a fresh process resuming over the same store, discovering a build from
 *    the journal;
 * 4. a build announced, escalated and finished between two passes, which is
 *    delivered and then retires;
 * 5. a long non-matching interval followed by graceful and crashed resumes,
 *    which read none of the old interval; and
 * 6. a brand-new hook's first initialization while a preparation is in flight;
 *    and
 * 7. fresh one-shot invocations (the hosted cron's `drainOnce`, with a new
 *    supervisor each time and no shared change gate): zero event rows and an
 *    identical request vector while unchanged, only the new rows when
 *    changed, and no store request at all with no hooks configured.
 *
 * No measured path lists builds; only (6) reads the repository's digests.
 */
export async function hookReadBudget(): Promise<void> {
  const { MemoryBuildStore } = await import('../store/memory')
  const { manualClock } = await import('./fixed')
  const { HookSupervisor } = await import('../processes/hooks')
  const repo = '/budget/hooks'
  const storeRef = '/budget/hooks.store'
  const settings = [
    { journal: 100, history: 3, foreign: 0, delivered: 0 },
    { journal: 100_000, history: 1_000, foreign: 1_000, delivered: 50 },
  ]
  type Store = InstanceType<typeof MemoryBuildStore>
  const ticket = (attempt: string) => ({ source: 'fake', id: `T-${attempt}` })
  const announce = async (store: Store, slug: string, attempt: string, events = 1) => {
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'ticket-preparation.intended',
      payload: { attempt, ticket: ticket(attempt), readyState: 'ready', claimedState: 'claimed' },
    })
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'ticket-preparation.creation-selected',
      payload: { attempt, ticket: ticket(attempt), slug },
    })
    await store.createBuild({ slug, repo })
    for (let i = 0; i < events; i++) await attach(store, slug)
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'ticket-preparation.resolved',
      payload: { attempt, ticket: ticket(attempt), outcome: 'owned' },
    })
  }
  const attach = (store: Store, slug: string) =>
    store.append(slug, {
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: 'i', host: 'h', resumedFromSeq: 0 },
    })
  const escalate = (store: Store, slug: string, id: string) =>
    store.append(slug, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: { id, phase: 'implement', round: 1, source: 'agent', question: 'q?' },
    })
  const finish = (store: Store, slug: string) =>
    store.append(slug, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
  const filler = (store: Store) =>
    store.appendRepo(repo, {
      actor: humanActor('operator'),
      type: 'dispatcher.intake-set',
      payload: { enabled: true },
    })
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const supervisorFor = (
    store: Store,
    clock: ReturnType<typeof manualClock>,
    delivered: string[],
  ) =>
    new HookSupervisor({
      store,
      repo,
      storeRef,
      checkout: repo,
      clock,
      invoke: async (_hook, line) => {
        delivered.push(JSON.parse(line).id)
        return { ok: true }
      },
      warn: (line) => {
        throw new Error(`unexpected hook warning: ${line}`)
      },
      appendRepo: (event) => store.appendRepo(repo, event),
      intervalMs: 1000,
      interval: (signal) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
      backoff: async () => {},
    })
  const hooks = {
    notify: { command: 'true', timeoutSeconds: 30 },
    selective: { command: 'true', timeoutSeconds: 30, events: ['escalation.*', 'hook.*'] },
  }
  const quiet = { quiet: { command: 'true', timeoutSeconds: 30, events: ['pr.merged'] } }
  const pulse = async (supervisor: InstanceType<typeof HookSupervisor>) => {
    await settle()
    await supervisor.pulse()
    await settle()
  }
  const listing = (vector: Record<string, number>) => [
    vector.listBuilds ?? 0,
    vector.listBuildsForRepo ?? 0,
    vector.getRepoBuildDigests ?? 0,
  ]
  const measured: unknown[] = []
  for (const setting of settings) {
    const clock = manualClock()
    const store = new MemoryBuildStore({ clock })
    await store.ensureRepo(repo)
    for (let i = 0; i < setting.foreign; i++)
      await store.createBuild({ slug: `foreign-${i}`, repo: '/budget/foreign' })
    for (let i = 0; i < setting.history; i++) {
      await announce(store, `history-${i}`, `h${i}`)
      await finish(store, `history-${i}`)
    }
    const seeded = setting.history * 6
    for (let i = seeded; i < setting.journal; i++) await filler(store)
    await announce(store, 'active-a', 'aa')
    await announce(store, 'active-b', 'ab')
    // Canonical repository values exist before any hook runs, as they do
    // under a running dispatcher; reducing them is not hook cost.
    await readRepositoryFacts(store, repo)
    await readRepositoryAttention(store, repo)
    await readBuildDigests(store, repo)

    const delivered: string[] = []
    let supervisor = supervisorFor(store, clock, delivered)
    await supervisor.reconcile(hooks)
    await pulse(supervisor)
    for (let i = 0; i < setting.delivered; i++) await escalate(store, 'active-a', `warm-${i}`)
    await pulse(supervisor)
    await pulse(supervisor)
    expect(delivered).toHaveLength(2 * setting.delivered)

    // 1. Idle intervals.
    let rows = memoryRepositoryReadCounter(store, repo)
    let requests = memoryStoreRequestCounter(store)
    for (let i = 0; i < 5; i++) await pulse(supervisor)
    const idle = {
      rows: rows.rows,
      buildRows: rows.buildRows,
      reducedCalls: rows.reducedCalls,
      requests: requests.vector(),
    }
    expect(idle).toEqual({
      rows: 0,
      buildRows: 0,
      reducedCalls: 0,
      requests: { getRepoChangePosition: 5 },
    })
    requests.restore()

    // 2. A changed pass with fixed new work.
    const newWork = async (slug: string, attempt: string) => {
      await escalate(store, 'active-a', `${attempt}-escalation`)
      await filler(store)
      await announce(store, slug, attempt, 3)
    }
    const deliveredBefore = delivered.length
    await newWork('new-c', 'nc')
    rows = memoryRepositoryReadCounter(store, repo)
    requests = memoryStoreRequestCounter(store)
    await pulse(supervisor)
    await pulse(supervisor)
    const changed = {
      rows: rows.rows,
      bySlug: Object.fromEntries(rows.buildRowsBySlug),
      requests: requests.vector(),
    }
    expect(delivered.slice(deliveredBefore)).toHaveLength(2)
    // Each new row is read once per hook, plus once by the shared reduced
    // value's incremental advance.
    expect(changed.bySlug).toEqual({ 'active-a': 3, 'new-c': 9 })
    expect(listing(changed.requests)).toEqual([0, 0, 0])
    requests.restore()

    // 3. A fresh process discovers the same work from the journal.
    await supervisor.stop()
    await newWork('new-d', 'nd')
    rows = memoryRepositoryReadCounter(store, repo)
    requests = memoryStoreRequestCounter(store)
    supervisor = supervisorFor(store, clock, delivered)
    await supervisor.reconcile(hooks)
    await pulse(supervisor)
    const fresh = {
      rows: rows.rows,
      bySlug: Object.fromEntries(rows.buildRowsBySlug),
      requests: requests.vector(),
    }
    expect(listing(fresh.requests)).toEqual([0, 0, 0])
    expect(fresh.bySlug['new-d']).toBe(9)
    expect(Object.keys(fresh.bySlug).filter((slug) => slug.startsWith('history-'))).toEqual([])
    requests.restore()

    // 4. Announced, escalated and finished between two passes.
    const beforeQuick = delivered.length
    await announce(store, 'quick', 'q')
    await escalate(store, 'quick', 'quick-escalation')
    await finish(store, 'quick')
    await pulse(supervisor)
    await pulse(supervisor)
    expect(delivered.slice(beforeQuick)).toEqual(['build:quick:2', 'build:quick:2'])
    rows = memoryRepositoryReadCounter(store, repo)
    for (let i = 0; i < 3; i++) await pulse(supervisor)
    expect(rows.buildRowsBySlug.get('quick') ?? 0).toBe(0)
    expect(rows.rows + rows.buildRows).toBe(0)
    await supervisor.stop()

    // 5. A long non-matching interval, then graceful and crashed resumes.
    const longDelivered: string[] = []
    let selective = supervisorFor(store, clock, longDelivered)
    await selective.reconcile(quiet)
    await pulse(selective)
    const interval = Math.min(setting.journal, 20_000)
    for (let done = 0; done < interval; done += 500) {
      for (let i = 0; i < 500; i++) await filler(store)
      for (let i = 0; i < Math.ceil(setting.history / (interval / 500)); i++) {
        const slug = `interval-${done}-${i}`
        await announce(store, slug, `i${done}-${i}`)
        await finish(store, slug)
      }
      clock.advance(1000)
      await pulse(selective)
    }
    clock.advance(30_000)
    await filler(store)
    await pulse(selective)
    // Crash: abandon without a graceful stop; at most the tail after the
    // last checkpoint replays.
    const crashTail = 3
    for (let i = 0; i < crashTail; i++) await filler(store)
    await pulse(selective)
    const resume = async () => {
      // The running dispatcher keeps the canonical repository values current;
      // their shared incremental advance is not hook cost.
      await readRepositoryFacts(store, repo)
      await readRepositoryAttention(store, repo)
      rows = memoryRepositoryReadCounter(store, repo)
      requests = memoryStoreRequestCounter(store)
      const next = supervisorFor(store, clock, longDelivered)
      await next.reconcile(quiet)
      await pulse(next)
      const cost = {
        rows: rows.rows,
        buildRows: rows.buildRows,
        requests: requests.vector(),
      }
      requests.restore()
      return { next, cost }
    }
    const crashed = await resume()
    expect(crashed.cost.rows).toBeLessThanOrEqual(crashTail + 1)
    expect(crashed.cost.buildRows).toBe(0)
    expect(listing(crashed.cost.requests)).toEqual([0, 0, 0])
    await crashed.next.stop()
    selective = crashed.next
    const graceful = await resume()
    expect(graceful.cost.rows).toBe(0)
    expect(graceful.cost.buildRows).toBe(0)
    await graceful.next.stop()
    expect(longDelivered).toEqual([])

    // 6. A brand-new hook initializes while a preparation is in flight.
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'ticket-preparation.intended',
      payload: {
        attempt: 'np',
        ticket: ticket('np'),
        readyState: 'ready',
        claimedState: 'claimed',
      },
    })
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'ticket-preparation.creation-selected',
      payload: { attempt: 'np', ticket: ticket('np'), slug: 'pending' },
    })
    await readRepositoryFacts(store, repo)
    await readRepositoryAttention(store, repo)
    rows = memoryRepositoryReadCounter(store, repo)
    requests = memoryStoreRequestCounter(store)
    const firstDelivered: string[] = []
    const brandNew = supervisorFor(store, clock, firstDelivered)
    await brandNew.reconcile({ brandNew: hooks.notify })
    await pulse(brandNew)
    const initialization = {
      rows: rows.rows,
      buildRows: rows.buildRows,
      requests: requests.vector(),
    }
    requests.restore()
    expect(listing(initialization.requests)).toEqual([0, 0, 1])
    await store.createBuild({ slug: 'pending', repo })
    await escalate(store, 'pending', 'pending-escalation')
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'ticket-preparation.resolved',
      payload: { attempt: 'np', ticket: ticket('np'), outcome: 'owned' },
    })
    await pulse(brandNew)
    expect(firstDelivered).toEqual(['build:pending:1'])
    expect(
      (await store.getRepoEvents(repo)).filter((event) => event.type === 'hook.skipped'),
    ).toEqual([])
    await brandNew.stop()

    // 7. Fresh one-shot (hosted) invocations. Each cron run builds a new
    // supervisor, resumes from durable progress and makes one feed pass.
    const urlHooks = {
      relay: { url: 'https://hooks.example/x', secretEnv: 'HOOK_SECRET', timeoutSeconds: 30 },
    }
    const onceDelivered: string[] = []
    await supervisorFor(store, clock, onceDelivered).drainOnce(urlHooks)
    await supervisorFor(store, clock, onceDelivered).drainOnce(urlHooks)
    expect(onceDelivered).toEqual([])
    await readRepositoryFacts(store, repo)
    await readRepositoryAttention(store, repo)
    const unchangedOnce: { rows: number; buildRows: number; requests: Record<string, number> }[] =
      []
    for (let i = 0; i < 3; i++) {
      rows = memoryRepositoryReadCounter(store, repo)
      requests = memoryStoreRequestCounter(store)
      await supervisorFor(store, clock, onceDelivered).drainOnce(urlHooks)
      unchangedOnce.push({
        rows: rows.rows,
        buildRows: rows.buildRows,
        requests: requests.vector(),
      })
      requests.restore()
    }
    expect(onceDelivered).toEqual([])
    for (const cost of unchangedOnce) {
      expect(cost.rows).toBe(0)
      expect(cost.buildRows).toBe(0)
      expect(cost.requests).toEqual(unchangedOnce[0]!.requests)
      expect(listing(cost.requests)).toEqual([0, 0, 0])
    }
    await escalate(store, 'active-a', 'once-escalation')
    await filler(store)
    await announce(store, 'once-new', 'on', 3)
    rows = memoryRepositoryReadCounter(store, repo)
    requests = memoryStoreRequestCounter(store)
    await supervisorFor(store, clock, onceDelivered).drainOnce(urlHooks)
    const changedOnce = {
      rows: rows.rows,
      bySlug: Object.fromEntries(rows.buildRowsBySlug),
      requests: requests.vector(),
    }
    requests.restore()
    expect(onceDelivered).toHaveLength(1)
    expect(onceDelivered[0]).toStartWith('build:active-a:')
    expect(Object.keys(changedOnce.bySlug).sort()).toEqual(['active-a', 'once-new'])
    expect(listing(changedOnce.requests)).toEqual([0, 0, 0])
    requests = memoryStoreRequestCounter(store)
    await supervisorFor(store, clock, onceDelivered).drainOnce({})
    expect(requests.vector()).toEqual({})
    requests.restore()

    measured.push({
      changed: { rows: changed.rows, requests: changed.requests },
      fresh: { rows: fresh.rows, requests: fresh.requests },
      crashed: crashed.cost,
      graceful: graceful.cost,
      initialization: {
        rows: initialization.rows,
        buildRows: initialization.buildRows,
        // The one digest batch read is constant in calls; its internal
        // per-build reductions are not event rows.
        requests: initialization.requests,
      },
      once: { unchanged: unchangedOnce[0], changed: changedOnce },
    })
  }
  expect(measured[1]).toEqual(measured[0])
}

/**
 * Optimization node reads (SPEC §15.5, RFC 0005 §11.2). For a node with 10
 * and with 10,000 settled attempts, each attempt a build with its own log:
 *
 * 1. the stop and admission inputs come from the node's reduced digest in
 *    BuildState: an identical request vector and a digest of the same size at
 *    both histories;
 * 2. idle reads read zero event rows;
 * 3. one new `attempt.settled` costs exactly its own node row;
 * 4. the ledger advances with only the new node rows, through the store and
 *    through a fresh repository view over it;
 * 5. the objective row (RFC 0005 §12) on the terminal dashboard poll, in the
 *    status summary and from `builds.get` comes from that same digest: an
 *    idle poll reads zero event rows with an identical request vector, and a
 *    row of the same size, at both histories; and
 * 6. no measured read ever touches an attempt build's log; and
 * 7. once the node stops, the dispatcher's stop duty reads at most one
 *    reduced `buildFacts` per unmerged in-flight attempt build not mid-abort, zero
 *    event rows while idle, and never a settled or aborted attempt's build.
 */
export async function optimizationReadBudget(): Promise<void> {
  const { MemoryBuildStore } = await import('../store/memory')
  const { commandObjective } = await import('../kernel/generators/optimization-log')
  const {
    optimizationAdmission,
    optimizationProposerAdmissible,
    optimizationStopCause,
    optimizationStopEligibility,
  } = await import('../kernel/optimization')
  const { enforceOptimizationStop } = await import('../processes/optimization-stop')
  const { reconcileMergedAttempts } = await import('../processes/optimization-merges')
  const { readBuildDigests, readOptimizationLedger } = await import('../store/reduced-reads')
  const { readAttemptContext } = await import('../cli/attempt')
  const { objectiveSummary } = await import('../cli/dashboard/objective-row')
  const { summarizeFrom } = await import('../cli/status')
  const { getOperatorBuild } = await import('../operator/query')
  const repo = '/budget/optimization'
  const node = 'opt-node'
  const sha = (n: number) => n.toString(16).padStart(40, '0')
  const now = new Date('2026-11-18T00:00:00Z')
  const config = parseConfig(
    '[tickets]\nsource="fake"\nreadyState="ready"\n[verify]\nsteps=[]\n[finalize]\nsteps=[]',
  )
  const { verify: _verify, finalize: _finalize, ...root } = config
  const measured: {
    vector: Record<string, number>
    digest: number
    attempt: Record<string, number>
    migrated: Record<string, number>
    poll: Record<string, number>
    objectiveRow: number
    stopVector: Record<string, number>
    slotPoll: Record<string, number>
    slotDigest: number
    reconcileFirst: Record<string, number>
    reconcileIdle: Record<string, number>
  }[] = []
  for (const attempts of [10, 10_000]) {
    const store = new MemoryBuildStore()
    await store.ensureRepo(repo)
    const configArtifact = await store.putRepoArtifact(repo, {
      kind: 'dispatcher-effective-config',
      content: JSON.stringify({ ...root, verify: { steps: [] }, finalize: { steps: [] } }),
    })
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run: 'budget-run',
        pid: 1,
        roleWarnings: [],
        effectiveConfig: { kind: configArtifact.kind, rev: configArtifact.revision },
      },
    })
    await store.createBuild({ slug: node, repo, branch: 'ab-node/opt-node' })
    await store.append(node, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { repo, ticket: { source: 'fake', id: 'NODE' }, baseBranch: 'main', kind: 'node' },
    })
    await store.append(node, {
      actor: DISPATCHER,
      type: 'optimization.objective-accepted',
      payload: {
        objective: commandObjective({ budget: { maxAttempts: 20_000 } }),
        revision: 1,
        harnessPin: sha(1),
        specRev: 0,
      },
    })
    await store.append(node, { actor: DISPATCHER, type: 'node.opened', payload: { sha: sha(1) } })
    await store.append(node, {
      actor: KERNEL,
      type: 'optimization.baseline-measured',
      payload: { revision: 1, head: sha(1), harnessPin: sha(1), samples: 7, median: 50, spread: 1 },
    })
    const proposal = (i: number) => ({
      id: `p${i}`,
      ticket: { source: 'fake', id: `A-${i}` },
      title: `Attempt ${i}`,
      strategy: `strategy ${i}`,
    })
    for (let batch = 0; batch < attempts; batch += 4) {
      const ids = Array.from({ length: Math.min(4, attempts - batch) }, (_, k) => batch + k)
      await store.append(node, {
        actor: DISPATCHER,
        type: 'optimization.attempts-proposed',
        payload: { request: `r${batch}`, proposals: ids.map(proposal) },
      })
      for (const i of ids) {
        const slug = `attempt-${i}`
        await store.createBuild({ slug, repo, branch: `ab/${slug}` })
        await store.append(slug, {
          actor: DISPATCHER,
          type: 'build.created',
          payload: { repo, ticket: proposal(i).ticket, baseBranch: 'ab-node/opt-node' },
        })
        const accepted = i % 50 === 0
        const delta = accepted ? 1 : (i % 3) * 0.1
        await store.append(slug, {
          actor: KERNEL,
          type: 'attempt.measured',
          payload: {
            request: `m${i}`,
            candidate: sha(i + 2),
            baseline: sha(1),
            harnessPin: sha(1),
            revision: 1,
            samples: 7,
            medians: { candidate: 50 - delta, baseline: 50 },
            delta,
            decision: accepted ? 'improved' : 'no-improvement',
          },
        })
        await store.append(node, {
          actor: DISPATCHER,
          type: 'attempt.settled',
          payload: {
            attempt: { proposal: `p${i}`, ticket: proposal(i).ticket, build: slug },
            outcome: accepted ? 'accepted' : i % 2 ? 'declined' : 'no-improvement',
            ...(accepted || i % 2 === 0
              ? { measurement: { revision: 1, baseline: 50, candidate: 50 - delta, delta } }
              : {}),
          },
        })
        // The node sweep's committed rejected-role move.
        if (!accepted)
          await store.append(node, {
            actor: DISPATCHER,
            type: 'attempt.ticket-rejected',
            payload: { proposal: `p${i}`, ticket: proposal(i).ticket, state: 'Rejected' },
          })
      }
    }
    // Two in-flight attempts: one under the configured source, and one whose
    // proposal predates a recorded migration to the `hosted` source.
    const live = { source: 'fake', id: 'LIVE' }
    const moved = { source: 'old', id: 'OLD-1' }
    await store.append(node, {
      actor: DISPATCHER,
      type: 'optimization.attempts-proposed',
      payload: {
        request: 'live',
        proposals: [
          { id: 'p-live', ticket: live, title: 'Live', strategy: 'live' },
          { id: 'p-moved', ticket: moved, title: 'Moved', strategy: 'moved' },
        ],
      },
    })
    await store.appendRepo(repo, {
      actor: { kind: 'human', user: 'operator' },
      type: 'tickets.migration-recorded',
      payload: {
        identity: 'old-to-hosted',
        from: 'old',
        to: 'hosted',
        mapping: { 'OLD-1': 'H-1' },
      },
    })
    const child = async (slug: string, ticket: { source: string; id: string }, target = true) => {
      await store.createBuild({ slug, repo, branch: `ab/${slug}` })
      await store.append(slug, {
        actor: DISPATCHER,
        type: 'build.created',
        payload: {
          repo,
          ticket,
          baseBranch: 'ab-node/opt-node',
          ...(target ? { target: { ticket: { source: 'fake', id: 'NODE' }, build: node } } : {}),
        },
      })
      const state = (await readBuildFacts(store, slug)).value.state
      return { slug, state, repo, ticket }
    }
    const liveChild = await child('live-child', live)
    const movedChild = await child('moved-child', { source: 'hosted', id: 'H-1' })
    const plainChild = await child('plain-child', { source: 'fake', id: 'PLAIN' }, false)
    // Warm-up: each reduced key is computed once and saved.
    await readBuildFacts(store, node)
    await readOptimizationLedger(store, node)
    await readRepositoryFacts(store, repo)
    const rows = memoryRepositoryReadCounter(store, repo)
    const requests = memoryStoreRequestCounter(store)
    const attemptRows = () => [...rows.buildRowsBySlug].filter(([slug]) => slug !== node)
    try {
      // 1. The stop and admission inputs: one reduced read, from the digest.
      const state = (await readBuildFacts(store, node)).value.state
      const digest = state.optimization!
      expect(digest.attempts.filed).toBe(attempts + 2)
      expect(digest.inFlight.map((attempt) => attempt.proposal)).toEqual(['p-live', 'p-moved'])
      optimizationStopEligibility(digest, now)
      optimizationStopCause(digest, now)
      optimizationProposerAdmissible(digest, now)
      optimizationAdmission(digest, now)
      const vector = requests.vector()
      const digestSize = JSON.stringify(digest).length
      expect(rows.buildRows).toBe(0)

      // 1b. Attempt resolution (`ab context`, `ab done`) reads the node's
      // served value once, plus the repository's only for an optimization
      // node; a build without a target reads nothing. No event rows, and no
      // attempt log.
      requests.reset()
      const resolved = await readAttemptContext(store, {
        ...liveChild,
        ticketSource: async () => 'fake',
      })
      expect(resolved?.attempt.proposal).toBe('p-live')
      const attemptVector = requests.vector()
      expect(attemptVector).toEqual({ getRepo: 1, getReducerValue: 2 })
      requests.reset()
      const migrated = await readAttemptContext(store, {
        ...movedChild,
        ticketSource: async () => 'hosted',
      })
      expect(migrated?.attempt.proposal).toBe('p-moved')
      const migratedVector = requests.vector()
      requests.reset()
      expect(
        await readAttemptContext(store, { ...plainChild, ticketSource: async () => 'fake' }),
      ).toBeUndefined()
      expect(requests.vector()).toEqual({})
      expect(rows.buildRows).toBe(0)

      // 1c. The objective row. The dashboard reader lists only the node: the
      // live attempt builds are other rows, outside this surface's cost.
      const record = (await store.getBuild(node))!
      const nodeOnly = new Proxy(store, {
        get(target, property) {
          if (property === 'listBuildsForRepo') return async () => [record]
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as BuildStore
      const dashboard = new DashboardBuildPollCache(
        {
          listBuildsForRepo: async () => [record],
          getEvents: store.getEvents.bind(store),
          getReducerValue: store.getReducerValue.bind(store),
        },
        repo,
        config,
      )
      await dashboard.refresh()
      rows.reset()
      requests.reset()
      const polled = (await dashboard.refresh()).builds.find((build) => build.slug === node)
      const pollVector = requests.vector()
      expect(polled?.objectiveRow?.attempts.filed).toBe(attempts + 2)
      expect(polled?.objectiveRow?.attempts.running).toBe(2)
      expect(rows.buildRows).toBe(0)
      expect(summarizeFrom(record, state, now).objective).toEqual(objectiveSummary(state, now))
      await getOperatorBuild({ store: nodeOnly, repo, slug: node, now })
      rows.reset()
      const operator = await getOperatorBuild({ store: nodeOnly, repo, slug: node, now })
      expect(rows.buildRows).toBe(0)
      expect(operator.detail.objective).toEqual(objectiveSummary(state, now))
      expect(operator.dashboardRow?.objectiveRow).toEqual(polled!.objectiveRow!)

      // 1d. Slot-holding conditions ride on the same digest: an unmeasured
      // merge marked on an in-flight attempt, and a settled attempt's branch
      // obligation. The marker costs exactly its own node row; the poll and
      // the operator detail then read zero event rows and no attempt log.
      await store.append(node, {
        actor: DISPATCHER,
        type: 'optimization.attempts-proposed',
        payload: {
          request: 'cleanup',
          proposals: [
            {
              id: 'p-clean',
              ticket: { source: 'fake', id: 'CLEAN' },
              title: 'Clean',
              strategy: 'clean',
            },
          ],
        },
      })
      await store.append(node, {
        actor: DISPATCHER,
        type: 'attempt.settled',
        payload: {
          attempt: {
            proposal: 'p-clean',
            ticket: { source: 'fake', id: 'CLEAN' },
            build: 'clean-child',
            branch: 'ab/clean-child',
          },
          outcome: 'declined',
        },
      })
      await readBuildFacts(store, node)
      await store.append(node, {
        actor: DISPATCHER,
        type: 'attempt.merged-unmeasured',
        payload: {
          proposal: 'p-live',
          ticket: live,
          build: 'live-child',
          sha: sha(9),
          reason: 'absent',
        },
      })
      rows.reset()
      const slotState = (await readBuildFacts(store, node)).value.state
      expect(rows.buildRowsBySlug.get(node)).toBe(1)
      expect(rows.buildRows).toBe(1)
      await dashboard.refresh()
      rows.reset()
      requests.reset()
      const slotRow = (await dashboard.refresh()).builds.find((build) => build.slug === node)
      const slotPoll = requests.vector()
      expect(rows.buildRows).toBe(0)
      expect(slotRow?.objectiveRow?.unmeasuredMerges).toBe(1)
      await getOperatorBuild({ store: nodeOnly, repo, slug: node, now })
      rows.reset()
      const slotDetail = (await getOperatorBuild({ store: nodeOnly, repo, slug: node, now })).detail
      expect(rows.buildRows).toBe(0)
      expect(slotDetail.unmeasuredMerges?.map((merge) => merge.proposal)).toEqual(['p-live'])
      expect(slotDetail.pendingCleanups).toEqual([
        { proposal: 'p-clean', build: 'clean-child', branch: 'ab/clean-child' },
      ])
      const slotDigest = JSON.stringify(slotState.optimization).length
      expect(attemptRows()).toEqual([])
      await store.append(node, {
        actor: DISPATCHER,
        type: 'attempt.ticket-rejected',
        payload: {
          proposal: 'p-clean',
          ticket: { source: 'fake', id: 'CLEAN' },
          state: 'Rejected',
        },
      })
      await readBuildFacts(store, node)
      await readOptimizationLedger(store, node)

      // 2. Idle reads read zero event rows.
      rows.reset()
      for (let i = 0; i < 5; i++) {
        const idle = (await readBuildFacts(store, node)).value.state.optimization!
        optimizationAdmission(idle, now)
        await readOptimizationLedger(store, node)
      }
      expect(rows.buildRows).toBe(0)

      // 3. One new settlement costs exactly its own node row.
      await store.append(node, {
        actor: DISPATCHER,
        type: 'optimization.attempts-proposed',
        payload: { request: 'last', proposals: [proposal(attempts)] },
      })
      await readBuildFacts(store, node)
      await readOptimizationLedger(store, node)
      await store.append(node, {
        actor: DISPATCHER,
        type: 'attempt.settled',
        payload: {
          attempt: { proposal: `p${attempts}`, ticket: proposal(attempts).ticket },
          outcome: 'declined',
        },
      })
      rows.reset()
      const advanced = (await readBuildFacts(store, node)).value.state.optimization!
      expect(advanced.attempts.filed).toBe(attempts + 4)
      expect(rows.buildRowsBySlug.get(node)).toBe(1)

      // 4. The ledger advances with only the new node row, also through a
      // fresh repository view over the same store.
      rows.reset()
      const ledger = (await readOptimizationLedger(store, node)).value
      expect(ledger.entries).toHaveLength(attempts + 2)
      expect(rows.buildRowsBySlug.get(node)).toBe(1)
      rows.reset()
      const view = new RepoViewStore(store, { repo })
      expect((await readOptimizationLedger(view, node)).value.entries).toHaveLength(attempts + 2)
      expect(rows.buildRows).toBe(0)

      // 6. No attempt log was read at any point.
      expect(attemptRows()).toEqual([])

      // Settle the attempts used by the upstream context-read checks before
      // exercising the stop duty at its four-attempt concurrency bound.
      for (const attempt of [
        { proposal: 'p-live', ticket: live },
        { proposal: 'p-moved', ticket: moved },
      ]) {
        await store.append(node, {
          actor: DISPATCHER,
          type: 'attempt.settled',
          payload: { attempt, outcome: 'declined' },
        })
      }

      // 7. A stopped node with concurrency attempts in flight: one never
      // built, one aborted, two holding a pending abort. The stop duty reads
      // only the two non-terminal attempt builds.
      const inFlight = [1, 2, 3, 4].map((k) => attempts + k)
      await store.append(node, {
        actor: DISPATCHER,
        type: 'optimization.attempts-proposed',
        payload: { request: 'stopping', proposals: inFlight.map(proposal) },
      })
      for (const i of inFlight.slice(1)) {
        const slug = `attempt-${i}`
        await store.createBuild({ slug, repo, branch: `ab/${slug}`, ticket: proposal(i).ticket })
        await store.append(slug, {
          actor: DISPATCHER,
          type: 'build.created',
          payload: {
            repo,
            ticket: proposal(i).ticket,
            baseBranch: 'ab-node/opt-node',
            target: { ticket: { source: 'fake', id: 'NODE' }, build: node },
          },
        })
        await store.append(slug, {
          actor: humanActor('op'),
          type: 'build.abort-requested',
          payload: {},
        })
      }
      await store.append(`attempt-${inFlight[1]}`, {
        actor: DISPATCHER,
        type: 'build.aborted',
        payload: {},
      })
      await store.append(node, {
        actor: DISPATCHER,
        type: 'optimization.stopped',
        payload: { cause: 'operator', mode: 'abort' },
      })
      const repoView = new RepoViewStore(store, { repo })
      const deps = {
        store: repoView,
        clock: () => now,
        migrations: { migrations: [] },
        ticketSource: 'fake',
      }
      const listing = async () => {
        const digests = await readBuildDigests(store, repo)
        return (await store.listBuilds())
          .filter((record) => record.repo === repo)
          .map((record) => ({ record, digest: digests.get(record.slug)! }))
      }
      const stopTick = async () => {
        const builds = await listing()
        const before = (await readBuildFacts(store, node)).value.state
        rows.reset()
        requests.restore()
        const counted = memoryStoreRequestCounter(store)
        const wrote = await enforceOptimizationStop(
          deps,
          builds.find((b) => b.record.slug === node)!.record,
          before,
          builds,
        )
        const cost = { wrote, vector: counted.vector() }
        counted.restore()
        return cost
      }
      // The enforcer settles only the unbuilt attempt; cleanup owns the aborted one.
      expect((await stopTick()).wrote).toBe(true)
      const touched = attemptRows().map(([slug]) => slug)
      expect(
        touched.every((slug) =>
          [inFlight[2], inFlight[3]].map((i) => `attempt-${i}`).includes(slug),
        ),
      ).toBe(true)
      const settled = (await readBuildFacts(store, node)).value.state.optimization!
      expect(settled.inFlight.map((a) => a.proposal)).toEqual([
        `p${inFlight[1]}`,
        `p${inFlight[2]}`,
        `p${inFlight[3]}`,
      ])
      // Idle ticks: reduced reads of the two pending-abort attempts, no rows.
      await stopTick()
      const idle = await stopTick()
      expect(idle.wrote).toBe(false)
      expect(rows.buildRows).toBe(0)
      // One saved reduced value per non-terminal attempt build, nothing else.
      expect(idle.vector).toEqual({ getReducerValue: settled.inFlight.length - 1 })

      // 8. Reconciliation of a merged attempt no settlement or marker
      // recorded (an upgrade from before the marker): the first tick reads
      // that one child's reduced value and writes the marker; every later
      // tick is a pure scan of the listing it already has, with zero store
      // requests. Unmerged and aborted attempts are never read.
      const mergedTicket = { source: 'fake', id: 'MERGED' }
      await store.append(node, {
        actor: DISPATCHER,
        type: 'optimization.attempts-proposed',
        payload: {
          request: 'merged',
          proposals: [{ id: 'p-merged', ticket: mergedTicket, title: 'M', strategy: 'm' }],
        },
      })
      await store.createBuild({
        slug: 'merged-child',
        repo,
        branch: 'ab/merged-child',
        ticket: mergedTicket,
      })
      await store.append('merged-child', {
        actor: DISPATCHER,
        type: 'build.created',
        payload: {
          repo,
          ticket: mergedTicket,
          baseBranch: 'ab-node/opt-node',
          target: { ticket: { source: 'fake', id: 'NODE' }, build: node },
        },
      })
      await store.append('merged-child', {
        actor: DISPATCHER,
        type: 'pr.opened',
        payload: { pr: { number: 9, url: 'https://forge/9', headSha: sha(9) } },
      })
      await store.append('merged-child', {
        actor: DISPATCHER,
        type: 'pr.merged',
        payload: { sha: sha(9) },
      })
      await store.append('merged-child', {
        actor: DISPATCHER,
        type: 'build.completed',
        payload: { outcome: 'merged' },
      })
      await readBuildFacts(store, 'merged-child')
      const reconcileTick = async () => {
        const builds = await listing()
        const before = (await readBuildFacts(store, node)).value.state
        rows.reset()
        requests.restore()
        const counted = memoryStoreRequestCounter(store)
        const wrote = await reconcileMergedAttempts(
          deps,
          builds.find((b) => b.record.slug === node)!.record,
          before,
          builds,
        )
        const cost = { wrote, vector: counted.vector(), rows: rows.buildRows }
        counted.restore()
        return cost
      }
      const first = await reconcileTick()
      expect(first.wrote).toBe(true)
      expect(first.rows).toBe(0)
      const reconciled = (await readBuildFacts(store, node)).value.state.optimization!
      expect(
        reconciled.inFlight.find((a) => a.proposal === 'p-merged')?.unmeasuredMerge,
      ).toMatchObject({
        build: 'merged-child',
        sha: sha(9),
        reason: 'absent',
      })
      const reconcileIdle = await reconcileTick()
      expect(reconcileIdle).toEqual({ wrote: false, vector: {}, rows: 0 })
      expect((await reconcileTick()).vector).toEqual({})
      measured.push({
        vector,
        digest: digestSize,
        attempt: attemptVector,
        migrated: migratedVector,
        poll: pollVector,
        objectiveRow: JSON.stringify(polled!.objectiveRow).length,
        stopVector: idle.vector,
        slotPoll,
        slotDigest,
        reconcileFirst: first.vector,
        reconcileIdle: reconcileIdle.vector,
      })
    } finally {
      requests.restore()
    }
  }
  expect(measured[1]!.stopVector).toEqual(measured[0]!.stopVector)
  expect(measured[1]!.slotPoll).toEqual(measured[0]!.slotPoll)
  expect(Math.abs(measured[1]!.slotDigest - measured[0]!.slotDigest)).toBeLessThanOrEqual(16)
  expect(measured[1]!.reconcileFirst).toEqual(measured[0]!.reconcileFirst)
  expect(measured[1]!.reconcileIdle).toEqual(measured[0]!.reconcileIdle)
  expect(measured[1]!.vector).toEqual(measured[0]!.vector)
  expect(measured[1]!.attempt).toEqual(measured[0]!.attempt)
  expect(measured[1]!.migrated).toEqual(measured[0]!.migrated)
  expect(Math.abs(measured[1]!.digest - measured[0]!.digest)).toBeLessThanOrEqual(16)
  expect(measured[1]!.poll).toEqual(measured[0]!.poll)
  expect(Math.abs(measured[1]!.objectiveRow - measured[0]!.objectiveRow)).toBeLessThanOrEqual(16)
}

/**
 * Judge panel sessions (SPEC §13.1.1) on the build's session rows. With a
 * short and a padded build log, each holding a panel whose judges fell back
 * from their primary to an alternate:
 *
 * 1. an idle terminal dashboard poll and an operator build-detail read read
 *    zero event rows, with an identical request vector at both lengths;
 * 2. the reduced panel state counts a substituted failure as no failure; and
 * 3. the polled session rows carry each judge session with its phase and
 *    stream, and nothing that names the order a judge was given.
 */
export async function judgePanelSessionReadBudget(): Promise<void> {
  const { MemoryBuildStore } = await import('../store/memory')
  const { PanelLogBuilder, panelStarted } = await import('../kernel/generators/panel-log')
  const { countedFailures } = await import('../kernel/panel')
  const { getOperatorBuild } = await import('../operator/query')
  const repo = '/budget/judge-panel'
  const slug = 'attempt-panel'
  const now = new Date('2026-11-18T00:00:00Z')
  const config = parseConfig(
    '[tickets]\nsource="fake"\nreadyState="ready"\n[verify]\nsteps=[]\n[finalize]\nsteps=[]',
  )
  const { verify: _verify, finalize: _finalize, ...root } = config
  const measured: Array<{ poll: Record<string, number>; operator: Record<string, number> }> = []
  for (const padding of [10, 10_000]) {
    const store = new MemoryBuildStore()
    await store.ensureRepo(repo)
    const configArtifact = await store.putRepoArtifact(repo, {
      kind: 'dispatcher-effective-config',
      content: JSON.stringify({ ...root, verify: { steps: [] }, finalize: { steps: [] } }),
    })
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run: 'budget-run',
        pid: 1,
        roleWarnings: [],
        effectiveConfig: { kind: configArtifact.kind, rev: configArtifact.revision },
      },
    })
    await store.createBuild({ slug, repo, branch: `ab/${slug}` })
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { repo, ticket: { source: 'fake', id: 'PANEL' }, baseBranch: 'main' },
    })
    for (let i = 0; i < padding; i++)
      await store.append(slug, {
        actor: KERNEL,
        type: 'observation.recorded',
        payload: { id: `obs-${i}`, kind: 'followup', summary: `budget padding ${i}` },
      })
    const log = new PanelLogBuilder(slug).started(panelStarted({ judges: 2 }))
    for (const judge of [1, 2]) {
      const primary = `s_${judge}a`
      const alternate = `s_${judge}b`
      log
        .judgeStarted(judge, primary, 'candidate-first', 'panel-1', {
          runner: 'codex',
          stream: `st_${primary}`,
        })
        .ended(judge, primary, 'failed')
        .substituted(
          judge,
          alternate,
          'candidate-first',
          { session: primary, index: 0, runner: 'codex' },
          { runner: 'claude', stream: `st_${alternate}` },
        )
        .ended(judge, alternate, 'failed')
    }
    for (const event of log.events) await store.append(slug, event)

    const record = (await store.getBuild(slug))!
    const single = new Proxy(store, {
      get(target, property) {
        if (property === 'listBuildsForRepo') return async () => [record]
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as BuildStore
    const dashboard = new DashboardBuildPollCache(
      {
        listBuildsForRepo: async () => [record],
        getEvents: store.getEvents.bind(store),
        getReducerValue: store.getReducerValue.bind(store),
      },
      repo,
      config,
    )
    // Warm-up: each reduced key is computed once and saved.
    await dashboard.refresh()
    await getOperatorBuild({ store: single, repo, slug, now })
    const rows = memoryRepositoryReadCounter(store, repo)
    const requests = memoryStoreRequestCounter(store)
    try {
      // 1. Idle reads: zero event rows.
      rows.reset()
      requests.reset()
      const polled = (await dashboard.refresh()).builds.find((build) => build.slug === slug)
      const poll = requests.vector()
      expect(rows.buildRows).toBe(0)
      rows.reset()
      requests.reset()
      const operator = await getOperatorBuild({ store: single, repo, slug, now })
      const operatorVector = requests.vector()
      expect(rows.buildRows).toBe(0)
      expect(operator.detail.slug).toBe(slug)

      // 2. Each launch fell back once and exhausted: one counted failure.
      rows.reset()
      const panel = (await readBuildFacts(store, slug)).value.state.panel!
      expect(rows.buildRows).toBe(0)
      expect(countedFailures(panel, 1)).toEqual(['failed'])
      expect(countedFailures(panel, 2)).toEqual(['failed'])

      // 3. The session rows name each judge session's target and stream.
      const sessions = polled!.sessions ?? []
      expect(
        sessions.map((session) => [session.id, session.phase, session.runtime, session.stream]),
      ).toEqual([
        ['s_1a', 'judge:panel-1:1', 'codex', 'st_s_1a'],
        ['s_1b', 'judge:panel-1:1', 'claude', 'st_s_1b'],
        ['s_2a', 'judge:panel-1:2', 'codex', 'st_s_2a'],
        ['s_2b', 'judge:panel-1:2', 'claude', 'st_s_2b'],
      ])
      expect(JSON.stringify(sessions)).not.toContain('first')
      measured.push({ poll, operator: operatorVector })
    } finally {
      requests.restore()
    }
  }
  expect(measured[1]).toEqual(measured[0])
}

/**
 * The measurement landing gate and the rejected-role sweep (AUT-1226) have
 * bounded read cost, at 10 and at 1,000 settled attempts plus 2,000 terminal
 * builds in the repository, each poll from a fresh dispatcher:
 *
 * 1. with no pending rejection, the sweep makes zero store requests;
 * 2. with pending rejections and a tracker that refuses the move, every poll
 *    costs the same requests, never lists builds or reads repository digests,
 *    reads at most `concurrency` build facts and zero event rows; the pending
 *    entries stay within `concurrency` and admission reports no slot;
 * 3. once the move succeeds the entry clears and its slot returns;
 * 4. the gate, with a would-be request waiting behind another attempt's
 *    landing turn, reads zero event rows while nothing changes, never lists
 *    builds or reads repository digests (its turn candidates come from the
 *    janitor's listing), and reads at most one reduced value per in-flight
 *    attempt plus the node;
 * 5. a completed node without pending rejections leaves the janitor's work
 *    set; a late settlement re-arms it through its incremental digest, which
 *    reads only the new row, never the node's history.
 */
export async function optimizationLandingReadBudget(): Promise<void> {
  const { MemoryBuildStore } = await import('../store/memory')
  const { commandObjective } = await import('../kernel/generators/optimization-log')
  const { optimizationAdmission } = await import('../kernel/optimization')
  const { isWorkDigest } = await import('../processes/repo-view')
  const repo = '/budget/optimization-landing'
  const node = 'opt-node'
  const concurrency = 3
  const sha = 'a'.repeat(40)
  const config = parseConfig(
    '[tickets]\nsource = "file"\nreadyState = "Ready"\nrejectedState = "Rejected"\n[verify]\nsteps = []\n[finalize]\nsteps = []\n',
  )
  const vectors: Record<string, Record<string, number>[]>[] = []
  for (const history of [10, 1_000]) {
    const store = new MemoryBuildStore()
    const tickets = new FakeTicketSource()
    await store.ensureRepo(repo)
    const created = async (slug: string, kind?: 'node', target?: string, ticket?: TicketRef) => {
      const ref = ticket ?? { source: 'fake', id: slug.toUpperCase() }
      await store.createBuild({ slug, repo, branch: `ab/${slug}`, ticket: ref })
      await store.append(slug, {
        actor: DISPATCHER,
        type: 'build.created',
        payload: {
          repo,
          ticket: ref,
          baseBranch: 'main',
          ...(kind ? { kind } : {}),
          ...(target ? { target: { build: target, ticket: { source: 'fake', id: 'NODE' } } } : {}),
        },
      })
    }
    const completed = (slug: string) =>
      store.append(slug, {
        actor: DISPATCHER,
        type: 'build.completed',
        payload: { outcome: 'abandoned' },
      })
    for (let i = 0; i < 2 * history; i++) {
      await created(`old-${i}`)
      await completed(`old-${i}`)
    }
    await created(node, 'node')
    await store.append(node, {
      actor: DISPATCHER,
      type: 'optimization.objective-accepted',
      payload: {
        objective: commandObjective({
          budget: { maxAttempts: 100_000 },
          proposer: { concurrency },
        }),
        revision: 1,
        harnessPin: sha,
        specRev: 0,
      },
    })
    const propose = async (id: string) => {
      const ticket = await tickets.create({ title: id, body: 'Attempt' })
      await store.append(node, {
        actor: DISPATCHER,
        type: 'optimization.attempts-proposed',
        payload: {
          request: `r-${id}`,
          proposals: [{ id, ticket: ticket.ref, title: id, strategy: id }],
        },
      })
      return ticket.ref
    }
    const settle = (
      id: string,
      ticket: TicketRef,
      build: string,
      outcome: 'declined' | 'aborted',
    ) =>
      store.append(node, {
        actor: DISPATCHER,
        type: 'attempt.settled',
        payload: { attempt: { proposal: id, ticket, build }, outcome },
      })
    // Settled history, every ticket already moved.
    for (let i = 0; i < history; i++) {
      const ticket = await propose(`h${i}`)
      await settle(`h${i}`, ticket, `old-${i}`, 'declined')
      await store.append(node, {
        actor: DISPATCHER,
        type: 'attempt.ticket-rejected',
        payload: { proposal: `h${i}`, ticket, state: 'Rejected' },
      })
    }
    // Live: two settled attempts whose moves are pending (one build done, one
    // still cleaning up), and one in flight.
    const live: TicketRef[] = []
    for (let i = 0; i < concurrency; i++) {
      live.push(await propose(`p${i}`))
      await created(`attempt-${i}`, undefined, node, live[i])
    }
    await completed('attempt-0')
    await settle('p0', live[0]!, 'attempt-0', 'declined')
    await settle('p1', live[1]!, 'attempt-1', 'aborted')

    const forge = new FakeForge()
    const dispatcher = () =>
      new Dispatcher({
        store,
        tickets,
        workspaces: new FakeWorkspaceProvider({
          root: '/optimization-landing-budget',
          mode: 'logical',
          base: { source: 'remote', sha },
        }),
        forge,
        config,
        repo,
        exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        launchRunner: async () => {
          throw new Error('no launches in the optimization landing budget')
        },
        ids: sequentialIds(),
        clock: () => new Date('2026-11-18T00:00:00Z'),
      })
    const call = <T>(d: Dispatcher, name: string, ...args: unknown[]): Promise<T> =>
      (Reflect.get(d, name) as (...a: unknown[]) => Promise<T>).apply(d, args)
    const nodeState = async () => (await readBuildFacts(store, node)).value.state
    // Warm-up: each reduced key is computed once and saved.
    await nodeState()
    for (let i = 0; i < concurrency; i++) await readBuildFacts(store, `attempt-${i}`)
    await readBuildDigests(store, repo)
    const nodeRecord = (await store.getBuild(node))!
    const rows = memoryRepositoryReadCounter(store, repo)
    const requests = memoryStoreRequestCounter(store)
    const measured: Record<string, Record<string, number>[]> = {
      refused: [],
      gate: [],
      cleanup: [],
    }
    try {
      // 1. Nothing pending: zero requests.
      const idle = { ...(await nodeState()) }
      idle.optimization = { ...idle.optimization!, rejections: [] }
      requests.reset()
      expect(await call<boolean>(dispatcher(), 'sweepAttemptRejections', nodeRecord, idle)).toBe(
        false,
      )
      expect(requests.vector()).toEqual({})

      // 2. A refusing tracker: constant cost, bounded entries, no slot.
      const transition = tickets.transition.bind(tickets)
      tickets.transition = async () => {
        throw new Error('tracker refused the move')
      }
      for (let poll = 0; poll < 3; poll++) {
        const state = await nodeState()
        expect(state.optimization!.rejections.length).toBeLessThanOrEqual(concurrency)
        expect(optimizationAdmission(state.optimization!, new Date()).slots).toBe(0)
        rows.reset()
        requests.reset()
        await expect(
          call(dispatcher(), 'sweepAttemptRejections', nodeRecord, state),
        ).rejects.toThrow('tracker refused the move')
        const vector = requests.vector()
        expect(vector.listBuilds).toBeUndefined()
        expect(vector.getRepoBuildDigests).toBeUndefined()
        expect(rows.buildFactsCalls).toBeLessThanOrEqual(concurrency)
        expect(rows.buildRows).toBe(0)
        measured.refused!.push(vector)
      }
      expect(new Set(measured.refused!.map((v) => JSON.stringify(v))).size).toBe(1)

      // 3. The move succeeds: the done attempt's entry clears; the other waits
      // for its build to finish.
      tickets.transition = transition
      expect(
        await call<boolean>(dispatcher(), 'sweepAttemptRejections', nodeRecord, await nodeState()),
      ).toBe(true)
      let state = await nodeState()
      expect(state.optimization!.rejections.map((entry) => entry.proposal)).toEqual(['p1'])
      expect(optimizationAdmission(state.optimization!, new Date()).slots).toBe(1)
      expect((await tickets.get(live[0]!.id))?.state).toBe('Rejected')
      expect((await tickets.get(live[1]!.id))?.state).not.toBe('Rejected')

      // 4. The gate and its landing turn: attempt-2 has a known pair and
      // would request a measurement, but attempt-3, overtaken three times,
      // holds the turn. Zero event rows while unchanged, no listing or digest
      // read beyond the janitor's own, and one reduced read per in-flight
      // attempt plus the node.
      const turnTicket = await propose('p3')
      await created('attempt-3', undefined, node, turnTicket)
      for (let i = 0; i < 4; i++)
        await store.append('attempt-3', {
          actor: DISPATCHER,
          type: 'attempt.measurement-requested',
          payload: {
            id: `m${i}`,
            node,
            candidate: 'c'.repeat(40),
            baseline: String(i).repeat(40),
            harnessPin: sha,
            revision: 1,
          },
        })
      await store.append('attempt-2', {
        actor: KERNEL,
        type: 'workspace.provisioned',
        payload: {
          provider: 'fake',
          remote: false,
          ref: 'attempt-2',
          branch: 'ab/attempt-2',
          base: { source: 'remote', sha },
        },
      })
      await store.append('attempt-2', {
        actor: DISPATCHER,
        type: 'target.moved',
        payload: { branch: 'main', sha },
      })
      await store.append('attempt-2', {
        actor: DISPATCHER,
        type: 'pr.opened',
        payload: { pr: { number: 2, url: 'https://forge/2', headSha: 'b'.repeat(40) } },
      })
      await nodeState()
      for (const slug of ['attempt-2', 'attempt-3']) await readBuildFacts(store, slug)
      await readBuildDigests(store, repo)
      const record = (await store.getBuild('attempt-2'))!
      const tick = async () => {
        const d = dispatcher()
        // The janitor's one listing per tick, which the gate reuses.
        Reflect.set(d, 'janitorEntries', await call(d, 'repoBuildDigests'))
        // A cached view would hide a second listing from the store counters;
        // the gate must not scan the repository's builds even in memory.
        let listings = 0
        Reflect.set(d, 'repoBuildDigests', async () => {
          listings += 1
          return []
        })
        return { d, listings: () => listings }
      }
      await call((await tick()).d, 'landingVerdict', record, node)
      for (let poll = 0; poll < 3; poll++) {
        const { d, listings } = await tick()
        rows.reset()
        requests.reset()
        const verdict = await call<{ verdict: string }>(d, 'landingVerdict', record, node)
        expect(verdict.verdict).toBe('wait-turn')
        expect(listings()).toBe(0)
        expect(rows.buildRows).toBe(0)
        expect(rows.buildFactsCalls).toBeLessThanOrEqual(concurrency + 1)
        const vector = requests.vector()
        expect(vector.listBuilds).toBeUndefined()
        expect(vector.getRepoBuildDigests).toBeUndefined()
        measured.gate!.push(vector)
      }
      expect(new Set(measured.gate!.map((v) => JSON.stringify(v))).size).toBe(1)

      // 5. The node completes; its last pending move then clears it from the
      // work set, and a late settlement re-arms it incrementally.
      await completed(node)
      await completed('attempt-1')
      await call(dispatcher(), 'sweepAttemptRejections', nodeRecord, await nodeState())
      state = await nodeState()
      expect(state.optimization!.rejections).toEqual([])
      rows.reset()
      let digest = (await readBuildDigests(store, repo)).get(node)!
      expect(digest.terminal).toBe('done')
      expect(digest.rejectionsPending).toBeUndefined()
      expect(isWorkDigest(digest)).toBe(false)
      await settle('p2', live[2]!, 'attempt-2', 'aborted')
      rows.reset()
      digest = (await readBuildDigests(store, repo)).get(node)!
      expect(digest.rejectionsPending).toBe(true)
      expect(isWorkDigest(digest)).toBe(true)
      expect(rows.buildRowsBySlug.get(node)).toBe(1)
      expect(rows.buildRows).toBe(1)

      // 6. A declined attempt that published: its branch obligation is one
      // forge delete per poll while failing, with the same request vector
      // each poll and one failure fact per distinct error; then the delete
      // and the move clear it. No listing, digest or event-row read.
      const cleanupTicket = await propose('p4')
      await created('attempt-4', undefined, node, cleanupTicket)
      await completed('attempt-4')
      await store.append(node, {
        actor: DISPATCHER,
        type: 'attempt.settled',
        payload: {
          attempt: {
            proposal: 'p4',
            ticket: cleanupTicket,
            build: 'attempt-4',
            branch: 'ab/attempt-4',
          },
          outcome: 'declined',
        },
      })
      for (let poll = 0; poll < 3; poll++) forge.failNextDeleteBranch('forge refused the delete')
      const failures = async () =>
        (await store.getEvents(node)).filter((e) => e.type === 'attempt.branch-cleanup-failed')
      for (let poll = 0; poll < 3; poll++) {
        const current = await nodeState()
        rows.reset()
        requests.reset()
        await call(dispatcher(), 'sweepAttemptRejections', nodeRecord, current)
        const vector = requests.vector()
        expect(vector.listBuilds).toBeUndefined()
        expect(vector.getRepoBuildDigests).toBeUndefined()
        expect(rows.buildRows).toBe(0)
        expect(rows.buildFactsCalls).toBeLessThanOrEqual(concurrency)
        // The first poll records the failure; the next ones repeat only the delete.
        if (poll > 0) measured.cleanup!.push(vector)
      }
      expect(new Set(measured.cleanup!.map((v) => JSON.stringify(v))).size).toBe(1)
      expect(await failures()).toHaveLength(1)
      expect(forge.deleteBranchCalls.map((c) => c.branch)).toEqual(Array(3).fill('ab/attempt-4'))
      expect((await tickets.get(cleanupTicket.id))?.state).not.toBe('Rejected')
      await call(dispatcher(), 'sweepAttemptRejections', nodeRecord, await nodeState())
      state = await nodeState()
      expect(state.optimization!.rejections.map((entry) => entry.proposal)).toEqual(['p2'])
      expect((await tickets.get(cleanupTicket.id))?.state).toBe('Rejected')
      expect(forge.deleteBranchCalls.map((c) => c.branch)).toEqual(Array(4).fill('ab/attempt-4'))
    } finally {
      requests.restore()
    }
    vectors.push(measured)
    await store.close()
  }
  expect(vectors[1]).toEqual(vectors[0]!)
}
