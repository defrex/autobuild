import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBuildFacts, readBuildStreamSeed, readRepositoryFacts } from '../store/reduced-reads'
import { newerFact } from '../testing/newer-writer'
import { MemoryBlobStore } from '../store/memory'
import { SqliteBuildStore } from '../store/local/store'
import { buildCreatedWrite, sampleBuildInput } from '../store/contract'
import { reduceBuild } from '../kernel/reducer'
import { decideNext } from '../kernel/engine'
import { deferMixedVersion } from '../kernel/mixed-version'
import { parseConfig } from '../config/load'
import { runCli } from '../cli/main'
import { makeEnv } from '../cli/testkit'
import { summarizeFrom, abBuildStatus } from '../cli/status'
import { BUILD_ATTENTION_EVENTS } from '../cli/watch'
import { Dispatcher } from '../processes/dispatcher'
import { FakeForge } from '../ports/forge/fake'
import { FakeTicketSource } from '../ports/tickets/fake'
import { FakeWorkspaceProvider } from '../ports/workspace/fake'
import { manualClock } from '../testing/fixed'
import { sequentialIds } from '../ids'
import { resolveReducerValue } from '../store/reducer-values'
import { READ_CATALOG_IDENTITY, catalogIdentity } from '../events/compatibility'
import { buildEventPolicy } from '../events/policy'
import {
  loadReducerSnapshot,
  persistReducerSnapshot,
  catalogSnapshotName,
} from '../store/snapshots'

const config = parseConfig(
  '[tickets]\nsource="file"\nreadyState="Ready"\n[verify]\nsteps=[]\n[finalize]\nsteps=[]',
)
function fixture() {
  const db = new Database(':memory:')
  const store = new SqliteBuildStore({ database: db, blobs: new MemoryBlobStore() })
  const seed = (
    seq: number,
    classification: 'advisory' | 'decisive' = 'decisive',
    build = 'mixed',
  ) => {
    const event = newerFact(seq, classification, build)
    db.query(
      'INSERT INTO events (build,seq,ts,actor,type,payload,compatibility) VALUES (?,?,?,?,?,?,?)',
    ).run(
      build,
      seq,
      event.ts,
      JSON.stringify(event.actor),
      event.type,
      JSON.stringify(event.payload),
      JSON.stringify(event.compatibility),
    )
  }
  return { db, store, seed }
}

test('newer persisted facts survive raw reads, incremental resume, tick/status/context and per-build deferral', async () => {
  const { db, store, seed } = fixture()
  const workspace = await mkdtemp(join(tmpdir(), 'ab-mixed-'))
  try {
    await store.createBuild(sampleBuildInput('mixed'))
    await store.append('mixed', buildCreatedWrite())
    const spec = await store.putArtifact('mixed', { kind: 'spec', content: '# Approved spec' })
    await store.append('mixed', {
      actor: { kind: 'dispatcher' },
      type: 'spec.imported',
      payload: {
        artifact: { kind: 'spec', rev: spec.revision },
        ticket: sampleBuildInput('mixed').ticket!,
      },
    })
    // Model a newer writer adding nested and top-level advisory payload fields.
    const row = db.query('SELECT payload FROM events WHERE seq=1').get() as { payload: string }
    const payload = JSON.parse(row.payload)
    payload.future = true
    payload.ticket.future = { value: true }
    db.query('UPDATE events SET payload=? WHERE seq=1').run(JSON.stringify(payload))
    seed(3, 'advisory')
    let facts = (await readBuildFacts(store, 'mixed')).value
    expect(facts.state.compatibility.unknownFacts).toBe(1)
    expect(facts.state.compatibility.decisiveFacts).toBe(0)
    expect(decideNext(await store.getEvents('mixed'), config).kind).toBe('run-phase')
    seed(4)
    facts = (await readBuildFacts(store, 'mixed')).value
    expect(facts.state.lastSeq).toBe(4)
    expect(facts.state.compatibility.unknownFacts).toBe(2)
    expect(facts.state.compatibility.decisiveFacts).toBe(1)
    expect((await readBuildStreamSeed(store, 'mixed')).value.build.compatibility).toEqual(
      facts.state.compatibility,
    )
    const raw = await store.getEvents('mixed')
    expect(raw[0]!.payload).toEqual(payload)
    expect(raw[3]!.payload as unknown).toEqual(newerFact(4).payload)
    expect(reduceBuild(raw).compatibility).toEqual(facts.state.compatibility)
    expect(decideNext(raw, config)).toEqual({ kind: 'wait', reason: 'mixed-version' })
    const summary = summarizeFrom((await store.getBuild('mixed'))!, facts.state, new Date())
    expect(summary.compatibilityDiagnostic).toContain(newerFact(4).type)
    const contextLines: string[] = []
    expect(
      await runCli(['context', '--json'], {
        store,
        env: makeEnv({ build: 'mixed', phase: 'plan' }),
        workspacePath: workspace,
        forge: new FakeForge(),
        exec: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
        ids: sequentialIds(),
        clock: manualClock(),
        stdout: (line) => contextLines.push(line),
        stderr: (line) => {
          throw new Error(line)
        },
      }),
    ).toBe(0)
    const manifest = JSON.parse(contextLines.join('\n'))
    const statusLines: string[] = []
    const close = store.close.bind(store)
    store.close = async () => {}
    try {
      await abBuildStatus({
        slug: 'mixed',
        targetRepo: workspace,
        json: true,
        events: 10,
        env: {
          AB_STORE: '/tmp/ab-store',
          AB_BUILD: 'mixed',
          AB_PHASE: 'plan',
          AB_ROUND: '1',
          AB_SESSION: 's_test',
        },
        exec: async () => ({ stdout: workspace, stderr: '', exitCode: 0 }),
        openStore: () => store,
        stdout: (line) => statusLines.push(line),
      })
    } finally {
      store.close = close
    }
    expect(JSON.parse(statusLines.join('\n')).compatibility.decisiveFacts).toBe(1)
    expect(manifest.compatibility?.decisiveFacts).toBe(1)
    expect(await Bun.file(join(workspace, '.ab/plan/spec.md')).text()).toBe('# Approved spec')
    await Promise.all([deferMixedVersion(store, 'mixed'), deferMixedVersion(store, 'mixed')])
    const attention = (await store.getEvents('mixed')).filter(
      (e) => e.type === 'build.compatibility-deferred',
    )
    expect(attention).toHaveLength(1)
    expect(BUILD_ATTENTION_EVENTS).toContain('build.compatibility-deferred')
    expect((await store.getBuild('mixed'))!.lease).toBeUndefined()
    await store.createBuild(sampleBuildInput('sibling'))
    await store.append('sibling', buildCreatedWrite())
    const launches: string[] = []
    const dispatcher = new Dispatcher({
      store,
      config,
      repo: sampleBuildInput('mixed').repo,
      tickets: new FakeTicketSource(),
      workspaces: new FakeWorkspaceProvider(),
      forge: new FakeForge(),
      clock: manualClock(),
      ids: sequentialIds(),
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      launchRunner: async (slug) => {
        launches.push(slug)
        return 'scheduled'
      },
    })
    await dispatcher.tick()
    expect(launches).not.toContain('mixed')
    expect(
      (await store.getEvents('mixed')).filter((e) => e.type === 'build.compatibility-deferred'),
    ).toHaveLength(1)
    expect((await store.getEvents('sibling')).length).toBeGreaterThan(1)
    // The older writer still rejects the persisted newer type and extra fields.
    await expect(
      store.append('mixed', newerFact(6) as unknown as Parameters<typeof store.append>[1]),
    ).rejects.toThrow('unknown event type')
    await expect(
      store.append('mixed', { ...buildCreatedWrite(), payload } as Parameters<
        typeof store.append
      >[1]),
    ).rejects.toThrow()
  } finally {
    await store.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('equal reducer versions isolate catalog caches and snapshots; foreign rows survive later cursors', async () => {
  const { db, store, seed } = fixture()
  try {
    await store.createBuild(sampleBuildInput('mixed'))
    await store.append('mixed', buildCreatedWrite())
    seed(2)
    const scope = { kind: 'build', slug: 'mixed' } as const
    const futureIdentity = catalogIdentity({ ...buildEventPolicy, [newerFact(2).type]: 'decisive' })
    expect(futureIdentity).not.toBe(READ_CATALOG_IDENTITY)
    // Model a newer catalog's fully reduced cache, with the same numeric
    // reducer version and zero unknown counts: the synthetic type is known there.
    const foreign = resolveReducerValue(scope, { reducer: 'buildReadFacts' }, futureIdentity)
    expect(foreign.reducer.version).toBe(
      resolveReducerValue(scope, { reducer: 'buildReadFacts' }).reducer.version,
    )
    db.query('INSERT INTO reducer_snapshots VALUES (?,?,?,?,?,?,?)').run(
      'build',
      'mixed',
      foreign.key,
      foreign.reducer.version,
      2,
      JSON.stringify({ identity: foreign.identity, acc: foreign.reducer.initial() }),
      new Date().toISOString(),
    )
    const before = db.query('SELECT * FROM reducer_snapshots WHERE reducer=?').get(foreign.key)
    expect((await readBuildFacts(store, 'mixed')).value.state.compatibility.decisiveFacts).toBe(1)
    seed(3, 'advisory')
    expect((await readBuildFacts(store, 'mixed')).value.state.compatibility.unknownFacts).toBe(2)
    expect(db.query('SELECT * FROM reducer_snapshots WHERE reducer=?').get(foreign.key)).toEqual(
      before,
    )
    const named = resolveReducerValue(scope, { reducer: 'buildReadFacts' })
    const newer = {
      version: named.reducer.version + 1,
      cursor: 3,
      state: { identity: named.identity, acc: {} },
    }
    db.query('UPDATE reducer_snapshots SET version=?, state=? WHERE reducer=?').run(
      newer.version,
      JSON.stringify(newer.state),
      named.key,
    )
    seed(4)
    expect((await readBuildFacts(store, 'mixed')).value.state.compatibility.decisiveFacts).toBe(2)
    expect(
      (
        db.query('SELECT version, state FROM reducer_snapshots WHERE reducer=?').get(named.key) as {
          version: number
        }
      ).version,
    ).toBe(newer.version)
    const foreignSnapshot = catalogSnapshotName('legacy', futureIdentity)
    await store.putReducerSnapshot(scope, foreignSnapshot, {
      version: 1,
      cursor: 2,
      state: { catalogIdentity: futureIdentity, acc: { foreign: true } },
    })
    const foreignBytes = await store.getReducerSnapshot(scope, foreignSnapshot, 1)
    await store.putReducerSnapshot(scope, 'legacy', {
      version: 1,
      cursor: 2,
      state: { foreign: true },
    })
    expect(await loadReducerSnapshot(store, scope, 'legacy', { version: 1 })).toBeNull()
    await persistReducerSnapshot(store, scope, 'legacy', {
      version: 1,
      cursor: 4,
      state: { local: true },
    })
    expect((await store.getReducerSnapshot(scope, 'legacy', 1))?.state).toEqual({ foreign: true })
    expect(await store.getReducerSnapshot(scope, foreignSnapshot, 1)).toEqual(foreignBytes)
    expect(catalogSnapshotName('x'.repeat(64)).length).toBeLessThanOrEqual(64)
    expect((await loadReducerSnapshot(store, scope, 'legacy', { version: 1 }))?.state).toEqual({
      local: true,
    })
    await store.ensureRepo('repo')
    const unknown = { ...newerFact(1), repo: 'repo' }
    db.query(
      'INSERT INTO repo_events (repo,seq,ts,actor,type,payload,compatibility) VALUES (?,?,?,?,?,?,?)',
    ).run(
      'repo',
      1,
      unknown.ts,
      JSON.stringify(unknown.actor),
      unknown.type,
      JSON.stringify(unknown.payload),
      JSON.stringify(unknown.compatibility),
    )
    expect((await store.getRepoEvents('repo'))[0]!.type as string).toBe(unknown.type)
    expect((await readRepositoryFacts(store, 'repo')).value.compatibility.decisiveFacts).toBe(1)
  } finally {
    await store.close()
  }
})

test('running runners and pending publication recovery defer before leases, sessions or forge work', async () => {
  const { BuildRunner } = await import('../processes/build-runner')
  const { settlePendingPublication } = await import('../cli/publication-settlement')
  const { ScriptedAgentRunner } = await import('../ports/runner/fake')
  const { suspendNativeLanding } = await import('../kernel/landing-publication')
  const { landIntegrationRoot } = await import('../kernel/integration-landing')
  const { landIntoNode } = await import('../kernel/node-landing')
  const { db, store, seed } = fixture()
  try {
    await store.createBuild(sampleBuildInput('mixed'))
    await store.append('mixed', buildCreatedWrite())
    await store.append('mixed', {
      actor: { kind: 'kernel' },
      type: 'runner.attached',
      payload: { instance: 'existing', host: 'test' },
    })
    await store.claimLease('mixed', 'existing', 60_000)
    await store.append('mixed', {
      actor: { kind: 'kernel' },
      type: 'publication.requested',
      payload: {
        operation: 'implement',
        branch: 'ab/mixed',
        sha: 'a'.repeat(40),
        round: 1,
        base: 'b'.repeat(40),
        artifact: { kind: 'implement-notes', rev: 0 },
      },
    })
    seed(4)
    let claims = 0
    const claim = store.claimLease.bind(store)
    store.claimLease = async (...args) => {
      claims++
      return claim(...args)
    }
    const forgeCalls: string[] = []
    const forge = new Proxy(new FakeForge(), {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver)
        return typeof value === 'function'
          ? (...args: unknown[]) => {
              forgeCalls.push(String(key))
              return Reflect.apply(value, target, args)
            }
          : value
      },
    })
    const exec = async () => {
      throw new Error('must not execute git or commands')
    }
    const runner = new BuildRunner({
      store: store.scopeBuild('mixed'),
      config: { ...config, roles: { ...config.roles, default: { runtime: 'scripted' } } },
      runtimes: {
        scripted: {
          runner: new ScriptedAgentRunner({
            script: () => {
              throw new Error('must not start an agent')
            },
          }),
          servesModels: [],
        },
      },
      workspacePath: '/unused',
      branch: 'ab/mixed',
      slug: 'mixed',
      exec,
      forge,
      ids: sequentialIds(),
      clock: manualClock(),
      instance: 'existing',
      host: 'test',
    })
    expect(await runner.step()).toEqual({ kind: 'wait', reason: 'mixed-version' })
    expect((await runner.run()).compatibility.decisiveFacts).toBe(1)
    expect(await runner.attach()).toEqual({ kind: 'compatibility-deferred' })
    await expect(
      suspendNativeLanding(
        { store, slug: 'mixed', forge, workspacePath: '/unused' },
        'replacement',
      ),
    ).rejects.toThrow('kernel decisions deferred')
    await landIntegrationRoot({
      store,
      forge,
      exec,
      workspacePath: '/unused',
      slug: 'mixed',
      branch: 'ab/mixed',
      destination: 'main',
      pr: 1,
      holder: 'existing',
      id: 'root',
      head: 'a'.repeat(40),
      parent: 'b'.repeat(40),
      cycle: 'cycle',
      eligible: async () => true,
    })
    await landIntoNode({
      store,
      forge,
      exec,
      workspacePath: '/unused',
      slug: 'mixed',
      node: 'mixed',
      branch: 'ab/mixed',
      destination: 'main',
      pr: 1,
      holder: 'existing',
      id: 'child',
      eligible: async () => true,
    })
    await settlePendingPublication(
      {
        store,
        storeRef: 'local',
        forge,
        exec,
        workspacePath: '/unused',
        ids: sequentialIds(),
        runId: 'recovery',
        publication: {
          publish: async () => {
            throw new Error('must not publish')
          },
        },
      },
      'mixed',
    )
    expect(claims).toBe(0)
    expect(forgeCalls).toEqual([])
    expect(
      (await store.getEvents('mixed')).filter((e) => e.type === 'publication.requested'),
    ).toHaveLength(1)
    expect(
      (await store.getEvents('mixed')).filter((e) => e.type === 'build.compatibility-deferred'),
    ).toHaveLength(1)
    expect(db.query('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 5 })
  } finally {
    await store.close()
  }
})

for (const order of ['older-first', 'newer-first'])
  for (const classification of ['advisory', 'decisive'] as const) {
    test(`a supported reader clears a frozen older catalog's cached counts (${order}, ${classification})`, async () => {
      const { store, db } = fixture()
      try {
        await store.createBuild(sampleBuildInput('mixed'))
        await store.append('mixed', buildCreatedWrite())
        const scope = { kind: 'build', slug: 'mixed' } as const
        const request = { reducer: 'buildReadFacts' }
        const current = resolveReducerValue(scope, request)
        const known = await store.getEvents('mixed')
        const type =
          classification === 'decisive' ? 'build.pause-requested' : 'observation.recorded'
        const frozen = Object.fromEntries(
          Object.entries(buildEventPolicy).filter(([name]) => name !== type),
        )
        const older = resolveReducerValue(scope, request, catalogIdentity(frozen))
        expect(older.reducer.version).toBe(current.reducer.version)
        expect(older.key).not.toBe(current.key)
        const event =
          classification === 'decisive'
            ? await store.append('mixed', {
                actor: { kind: 'human', user: 'fixture' },
                type,
                payload: {},
              })
            : await store.append('mixed', {
                actor: { kind: 'kernel' },
                type,
                payload: { id: 'new-advisory', kind: 'followup', summary: 'new advisory' },
              })
        // The independent older fixture catalog cannot interpret the last type.
        // Its functional accumulator skips it, but preserves exact raw counters.
        const olderAcc = older.reducer.advance(older.reducer.initial(), known)
        olderAcc.build.compatibility = {
          unknownFacts: 1,
          decisiveFacts: classification === 'decisive' ? 1 : 0,
          lastSeq: event.seq,
          decisiveBoundary: classification === 'decisive' ? event.seq : 0,
          types: [type],
          writerVersions: [event.compatibility!.writerVersion],
          legacyVersionUnavailable: false,
          decisiveTypes: classification === 'decisive' ? [type] : [],
          decisiveWriterVersions:
            classification === 'decisive' ? [event.compatibility!.writerVersion] : [],
          decisiveLegacyVersionUnavailable: false,
        }
        expect(older.entry.validate(olderAcc)).toBe(true)
        const installOlder = () =>
          db
            .query('INSERT INTO reducer_snapshots VALUES (?,?,?,?,?,?,?)')
            .run(
              'build',
              'mixed',
              older.key,
              older.reducer.version,
              2,
              JSON.stringify({ identity: older.identity, acc: olderAcc }),
              new Date().toISOString(),
            )
        if (order === 'older-first') installOlder()
        let facts = (await readBuildFacts(store, 'mixed')).value
        expect(facts.state.compatibility.unknownFacts).toBe(0)
        if (order === 'newer-first') installOlder()
        const before = db.query('SELECT * FROM reducer_snapshots WHERE reducer=?').get(older.key)
        facts = (await readBuildFacts(store, 'mixed')).value
        expect(facts.state.compatibility.decisiveFacts).toBe(0)
        expect(await deferMixedVersion(store, 'mixed')).toBe(false)
        expect(db.query('SELECT * FROM reducer_snapshots WHERE reducer=?').get(older.key)).toEqual(
          before,
        )
        expect(
          (
            db
              .query('SELECT COUNT(*) AS n FROM reducer_snapshots WHERE reducer IN (?,?)')
              .get(older.key, current.key) as { n: number }
          ).n,
        ).toBe(2)
      } finally {
        await store.close()
      }
    })
  }

test('deferring a claimed build preserves its capacity reservation', async () => {
  const { store, seed } = fixture()
  try {
    await store.createBuild(sampleBuildInput('mixed'))
    await store.append('mixed', buildCreatedWrite())
    seed(2)
    const ref = { source: 'fake', id: 'NEXT', title: 'Next build' }
    const tickets = new FakeTicketSource([
      {
        ref,
        revision: 'fixture',
        title: ref.title,
        body: 'Improve the next feature.\n\n## Acceptance criteria\n- the feature works\n\n## Out of scope\n- other work',
        state: 'Ready',
        resolved: false,
        labels: [],
      },
    ])
    const launches: string[] = []
    const dispatcher = new Dispatcher({
      store,
      config: { ...config, capacity: 1 },
      repo: sampleBuildInput('mixed').repo,
      tickets,
      forge: new FakeForge(),
      workspaces: new FakeWorkspaceProvider(),
      clock: manualClock(),
      ids: sequentialIds(),
      exec: async () => ({
        exitCode: 0,
        stdout: `${'a'.repeat(40)}\trefs/heads/main\n`,
        stderr: '',
      }),
      launchRunner: async (slug) => {
        launches.push(slug)
        return 'scheduled'
      },
    })
    await dispatcher.tick()
    expect((await store.listBuilds()).map((record) => record.slug)).toEqual(['mixed'])
    expect(launches).toEqual([])
  } finally {
    await store.close()
  }
})

test('durable deferral attention names only decisive unknown types and releases', async () => {
  const { store, db, seed } = fixture()
  try {
    await store.createBuild(sampleBuildInput('mixed'))
    await store.append('mixed', buildCreatedWrite())
    seed(2, 'advisory')
    db.query('UPDATE events SET type=?, compatibility=? WHERE build=? AND seq=2').run(
      'future.advisory',
      JSON.stringify({ classification: 'advisory', writerVersion: 'advisory-release' }),
      'mixed',
    )
    await readBuildFacts(store, 'mixed') // Persist before the decisive delta.
    seed(3)
    expect(await deferMixedVersion(store, 'mixed')).toBe(true)
    const events = await store.getEvents('mixed')
    const attention = events.find((event) => event.type === 'build.compatibility-deferred')!
    expect(attention.payload).toMatchObject({
      types: [newerFact(3).type],
      writerVersions: [newerFact(3).compatibility!.writerVersion],
      legacyVersionUnavailable: false,
      boundary: 3,
    })
    expect(JSON.stringify(attention.payload)).not.toContain('future.advisory')
    expect(JSON.stringify(attention.payload)).not.toContain('advisory-release')
    expect((await readBuildFacts(store, 'mixed')).value.state.compatibility.unknownFacts).toBe(2)
  } finally {
    await store.close()
  }
})

test('a frozen pre-runtime catalog skips advisory companions while preserving start and attach positions', async () => {
  // Separate process: mutating this fixture catalog must not affect other tests.
  const script = `
    import { MemoryBuildStore } from './packages/core/src/store/memory';
    import { eventPayloadSchemas } from './packages/core/src/events/payloads';
    import { repositoryEventPayloadSchemas } from './packages/core/src/events/repository';
    import { buildEventPolicy, repositoryEventPolicy } from './packages/core/src/events/policy';
    import { reduceBuild } from './packages/core/src/kernel/reducer';
    import { decodeStoredEvent, initialCompatibility, advanceCompatibility } from './packages/core/src/events/compatibility';
    const store = new MemoryBuildStore();
    const runtime = {version:'1',commit:'unknown',source:{kind:'package',location:'/runtime'}};
    await store.createBuild({slug:'old-reader',repo:'/repo'});
    const attach = await store.append('old-reader',{actor:{kind:'kernel'},type:'runner.attached',payload:{instance:'i',host:'h'}});
    await store.append('old-reader',{actor:{kind:'kernel'},type:'runner.runtime-recorded',payload:{instance:'i',attachedSeq:attach.seq,runtime}});
    await store.ensureRepo('/repo');
    const start = await store.appendRepo('/repo',{actor:{kind:'dispatcher'},type:'dispatcher.run-started',payload:{run:'r',pid:1,effectiveConfig:{kind:'config',rev:0},roleWarnings:[]}});
    await store.appendRepo('/repo',{actor:{kind:'dispatcher'},type:'dispatcher.runtime-recorded',payload:{run:'r',startedSeq:start.seq,runtime}});
    const builds = await store.getEvents('old-reader');
    const repository = await store.getRepoEvents('/repo');
    delete eventPayloadSchemas['runner.runtime-recorded'];
    delete repositoryEventPayloadSchemas['dispatcher.runtime-recorded'];
    delete buildEventPolicy['runner.runtime-recorded'];
    delete repositoryEventPolicy['dispatcher.runtime-recorded'];
    const b = initialCompatibility(), r = initialCompatibility();
    advanceCompatibility(b,builds); advanceCompatibility(r,repository);
    console.log(JSON.stringify({b,r,buildKnown:builds.filter(e=>decodeStoredEvent(e)).map(e=>[e.type,e.seq]),repoKnown:repository.filter(e=>decodeStoredEvent(e)).map(e=>[e.type,e.seq]),status:reduceBuild(builds).status,raw:builds.map(e=>e.seq)}));
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: join(import.meta.dir, '../../../..'),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, error).toBe(0)
  const result = JSON.parse(output)
  expect(result.b).toMatchObject({ unknownFacts: 1, decisiveFacts: 0, lastSeq: 2 })
  expect(result.r).toMatchObject({ unknownFacts: 1, decisiveFacts: 0, lastSeq: 2 })
  expect(result.buildKnown).toEqual([['runner.attached', 1]])
  expect(result.repoKnown).toEqual([['dispatcher.run-started', 1]])
  expect(result.raw).toEqual([1, 2])
  expect(result.status).toBe('running')
})

test('only matching unsettled build-log drain authorization suppresses restart attention', async () => {
  const { store, seed } = fixture()
  const { withDrainingExecution } = await import('../kernel/mixed-version')
  const runtime = {
    version: '1.0.0',
    commit: 'unknown',
    source: { kind: 'package' as const, location: '/old' },
  }
  try {
    await store.createBuild(sampleBuildInput('mixed'))
    await store.append('mixed', buildCreatedWrite())
    await store.append('mixed', {
      actor: { kind: 'dispatcher' },
      type: 'execution.drain-authorized',
      payload: { correlation: 'handoff', run: 'old-run', instance: 'old-execution', runtime },
    })
    seed(3)
    const old = withDrainingExecution(store.scopeBuild('mixed'), 'old-execution', runtime)
    expect(await deferMixedVersion(old, 'mixed')).toBe(true)
    expect(
      (await store.getEvents('mixed')).some(
        (event) => event.type === 'build.compatibility-deferred',
      ),
    ).toBe(false)
    const unrelated = withDrainingExecution(store.scopeBuild('mixed'), 'new-execution', runtime)
    expect(await deferMixedVersion(unrelated, 'mixed')).toBe(true)
    expect(
      (await store.getEvents('mixed')).filter(
        (event) => event.type === 'build.compatibility-deferred',
      ),
    ).toHaveLength(1)
    await store.append('mixed', {
      actor: { kind: 'dispatcher' },
      type: 'execution.drain-settled',
      payload: { correlation: 'handoff', instance: 'old-execution' },
    })
    seed(6)
    expect(await deferMixedVersion(old, 'mixed')).toBe(true)
    expect(
      (await store.getEvents('mixed')).filter(
        (event) => event.type === 'build.compatibility-deferred',
      ),
    ).toHaveLength(2)
  } finally {
    await store.close()
  }
})

test('an execution end fences drain authorization in either write order', async () => {
  const { withDrainingExecution } = await import('../kernel/mixed-version')
  const runtime = {
    version: '1.0.0',
    commit: 'unknown',
    source: { kind: 'package' as const, location: '/old' },
  }
  for (const endedFirst of [true, false]) {
    const { store, seed } = fixture()
    try {
      await store.createBuild(sampleBuildInput('mixed'))
      await store.append('mixed', buildCreatedWrite())
      const authorized = {
        actor: { kind: 'dispatcher' as const },
        type: 'execution.drain-authorized' as const,
        payload: { correlation: 'drain', run: 'old', runtime, instance: 'execution' },
      }
      const ended = {
        actor: { kind: 'dispatcher' as const },
        type: 'execution.ended' as const,
        payload: { instance: 'execution', workspaceRef: 'ws', outcome: 'completed' as const },
      }
      for (const event of endedFirst ? [ended, authorized] : [authorized, ended])
        await store.append('mixed', event)
      seed(4)
      expect(
        await deferMixedVersion(
          withDrainingExecution(store.scopeBuild('mixed'), 'execution', runtime),
          'mixed',
        ),
      ).toBe(true)
      expect(
        (await store.getEvents('mixed')).filter(
          (event) => event.type === 'build.compatibility-deferred',
        ),
      ).toHaveLength(1)
    } finally {
      await store.close()
    }
  }
})
