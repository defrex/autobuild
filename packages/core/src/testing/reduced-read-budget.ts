import { restoreReplay } from '../kernel/replay-retention'
import { reducerValueForClient } from '../store/remote/compatibility'
import { RELEASED_CLIENTS } from '../store/remote/released-clients'
import { missingAccountCredentials, reconcileMissingAccounts } from '../accounts/availability'
import { decideNextFromFacts } from '../kernel/engine'
import { proveTargetLineage } from '../kernel/target-lineage'
import { nodeRestackLog } from '../kernel/generators/node-restack-log'
import { observeTarget } from '../kernel/target-observation'
import { autoMergeDeferralObservation } from '../kernel/auto-merge'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DashboardBuildPollCache } from '../cli/dashboard/poll'
import { abDispatch } from '../cli/dispatch'
import { createTerminalModeController } from '../cli/terminal-restore'
import { randomUuids } from '../ids'
import { ScriptedAgentRunner, defaultTurnResult } from '../ports/runner/fake'
import { Dispatcher } from '../processes/dispatcher'
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
import { KERNEL, DISPATCHER, humanActor } from '../events/envelope'
import {
  readBuildFacts,
  readBuildStreamSeed,
  readRepositoryFacts,
  readForgeHealth,
  readRepositoryAttention,
  readBuildDigests,
  readDispatcherRunFacts,
  readOpenTick,
} from '../store/reduced-reads'
import { RepoViewStore } from '../processes/repo-view'
import { abWatch, decodeCursor } from '../cli/watch'
import { abWait } from '../cli/wait'
import type { Exec } from '../ports/workspace/git-worktree'

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
        await readRepositoryFacts(cold, repo)
      }
      expect(costs.events).toBe(0)
      expect(costs.metadata).toBeLessThan(operations * 20)
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
    const scanSeq = (await readRepositoryFacts(cold, repo)).value.scanSeq
    let cadenceReads = 0
    let cadenceWrites = 0
    for (let interval = 0; interval < 3; interval++) {
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
      const observe = () =>
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
        }).observeReady()
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
    expect(cadenceReads).toBe(6)
    expect(cadenceWrites).toBe(3)
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
            return target.beginRepoTick(...args)
          }
        if (interactive && key === 'finishRepoTick')
          return (...args: Parameters<BuildStore['finishRepoTick']>) => {
            // Close the kernel window before the independent dashboard poll.
            tickAcquisitions = { ...acquisitions, facts: acquisitions.facts - ticketScanWrites }
            if (outage && ticks === 0) throw new Error('budget tick write refused')
            return target.finishRepoTick(...args)
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
      storeRef: '/budget',
      wire: () => ({
        store: checked,
        storeRef: '/budget',
        tickets: new FakeTicketSource([]),
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
  let seeded = 0
  for (const length of [100, 100_000]) {
    for (; seeded < length; seeded++) {
      await store.append(slugs[0]!, {
        actor: humanActor('budget'),
        type: 'build.auto-merge-cancelled',
        payload: {},
      })
    }
    // Instrument returned event rows, including getReducerValue's private
    // snapshot-tail reads (instrumenting getEvents alone would miss these).
    const build = Reflect.get(store, 'builds').get(slugs[0]!)
    const events = build.events as import('../events/catalog').AbEvent[]
    const historyTail = events.at(-1)!.seq
    const slice = Array.prototype.slice
    events.slice = function (start?: number, end?: number) {
      const result = slice.call(this, start, end) as typeof events
      metrics.historicalRows += result.filter((event) => event.seq <= historyTail).length
      return result
    }
    opts.advance()
    await opts.dispatcher().tick({ acceptNewWork: false }) // warm durable projections
    const dispatcher = opts.dispatcher()
    reset()
    for (let tick = 0; tick < 4; tick++) {
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

/** In-memory history seeding for preparation budgets; never used as a recurring read. */
export async function seedPreparationHistory(store: BuildStore, repo: string, facts: number) {
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
}) {
  const { store, slug } = opts
  const checkpoint = (await readBuildFacts(store, slug)).value.state.nodePolling!
  let seeded = 0
  let baseline: number[] | undefined
  for (const length of [100, 100_000]) {
    for (; seeded < length; seeded++)
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
      }
    } finally {
      Reflect.deleteProperty(events, 'slice')
      store.getReducerValue = getReduced
    }
    if (baseline) expect(costs).toEqual(baseline)
    baseline = costs
  }
}

/** Expired sampled owners resolve once through exact persisted run values. */
export async function stoppedOwnerWatchReadBudget() {
  const { MemoryBuildStore } = await import('../store/memory')
  const { manualClock } = await import('./fixed')
  let previousBytes: number | undefined
  for (const length of [100, 100_000]) {
    const clock = manualClock()
    const store = new MemoryBuildStore({ clock })
    await store.ensureRepo(repo)
    for (let i = 0; i < length; i++)
      await store.appendRepo(repo, {
        actor: humanActor('human'),
        type: 'dispatcher.intake-set',
        payload: { enabled: true },
      })
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
    await opts.store.appendRepo(repo, {
      actor: KERNEL,
      type: 'dispatcher.placement-set',
      payload: { hosted: true, origin: 'https://store.test' },
    })
    counter.reset()
    expect(await (await opts.fresh()).getDispatchPlacement(repo)).toEqual({
      status: 'known',
      placement: { hosted: true, origin: 'https://store.test' },
    })
    expect(counter.rows).toBe(1)
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
