import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import { sequentialIds } from '../ids'
import { FakeForge, type FakeTreeFile } from '../ports/forge/fake'
import { FakeTicketSource } from '../ports/tickets/fake'
import { FakeWorkspaceProvider } from '../ports/workspace/fake'
import {
  AGENT_CONTEXT_ARTIFACT,
  AGENT_CONTEXT_HEAD_ARTIFACT,
  AGENT_CONTEXT_MAX_BYTES,
  readAgentContext,
  readAgentContextPointer,
} from '../store/agent-context'
import { AGENT_CONTEXT_CACHE_KIND_PREFIX } from '../store/retention'
import { MemoryBuildStore } from '../store/memory'
import {
  AGENT_CONTEXT_HEAD_POLL_MS,
  AGENT_CONTEXT_RETRY_MS,
  AgentContextCapture,
  type AgentContextBounds,
} from './agent-context'
import { Dispatcher } from './dispatcher'

const REPO = 'agent-context-repo'
const head = (n: number) => n.toString(16).padStart(40, '0')

const SKILLS: Record<string, FakeTreeFile> = {
  '.agents/skills/ab-guide/SKILL.md': '# guide',
  '.agents/skills/ab-guide/references/config.md': 'config reference',
  '.claude/skills/ab-guide': { symlink: '../../.agents/skills/ab-guide' },
  '.agents/skills/release/SKILL.md': '# release',
  'AGENTS.md': 'Read @docs/rules.md first.',
  'CLAUDE.md': { symlink: 'AGENTS.md' },
  'docs/rules.md': 'rules',
  'src/main.ts': 'code',
}

async function world(opts: { maxRevisions?: number; msPerBlob?: number } = {}) {
  const store = new MemoryBuildStore(
    opts.maxRevisions !== undefined ? { retention: { maxRevisions: opts.maxRevisions } } : {},
  )
  await store.ensureRepo(REPO)
  const forge = new FakeForge()
  let now = 1_000_000
  const readBlob = forge.readBlob.bind(forge)
  forge.readBlob = async (oid) => {
    now += opts.msPerBlob ?? 0
    return readBlob(oid)
  }
  // A new head lands at least one head-poll interval later.
  const at = (n: number, files: Record<string, FakeTreeFile>) => {
    forge.seedTree(head(n), files)
    forge.remoteBranches.set('main', head(n))
    now += AGENT_CONTEXT_HEAD_POLL_MS
  }
  const capture = (bounds?: Partial<AgentContextBounds>) =>
    new AgentContextCapture({
      store,
      repo: REPO,
      forge,
      now: () => now,
      elapsed: () => now,
      ...(bounds ? { bounds } : {}),
    })
  const revisions = async (kind = AGENT_CONTEXT_ARTIFACT) =>
    (await store.listRepoArtifacts(REPO, kind)).length
  const record = async () => (await readAgentContext(store, REPO))?.record
  return {
    store,
    forge,
    at,
    capture,
    revisions,
    record,
    clock: {
      now: () => now,
      advance: (ms: number) => {
        now += ms
      },
    },
  }
}

describe('capture', () => {
  test('records the base head content and writes nothing while the head is unchanged', async () => {
    const w = await world()
    w.at(1, SKILLS)
    const capture = w.capture()
    expect(await capture.run({ baseBranch: 'main' })).toEqual([])
    const stored = await readAgentContext(w.store, REPO)
    expect(stored?.meta.metadata).toMatchObject({ schema: 1, commit: head(1) })
    expect(stored?.record.commit).toBe(head(1))
    expect(stored?.record.skills.map((skill) => skill.paths)).toEqual([
      ['.agents/skills/ab-guide', '.claude/skills/ab-guide'],
      ['.agents/skills/release'],
    ])
    expect(stored?.record.instructions.map((entry) => [entry.paths, entry.imports])).toEqual([
      [['AGENTS.md', 'CLAUDE.md'], ['docs/rules.md']],
    ])
    expect(stored?.record.imports.map((entry) => [entry.path, entry.text])).toEqual([
      ['docs/rules.md', 'rules'],
    ])
    const pointer = await readAgentContextPointer(w.store, REPO)
    expect(pointer).toMatchObject({
      observed: head(1),
      revision: 0,
      digest: stored?.meta.metadata.digest,
    })

    const reads = w.forge.blobReads.length
    expect(await capture.run({ baseBranch: 'main' })).toEqual([])
    expect(await w.capture().run({ baseBranch: 'main' })).toEqual([])
    expect(w.forge.treeReads).toEqual([head(1)])
    expect(w.forge.blobReads.length).toBe(reads)
    expect(await w.revisions()).toBe(1)
    expect(await w.revisions(AGENT_CONTEXT_HEAD_ARTIFACT)).toBe(1)
  })

  test('head changes: unrelated files and content-neutral changes add no revision; edits fetch only new blobs', async () => {
    const w = await world()
    const capture = w.capture()
    const files = { ...SKILLS, 'AGENTS.md': 'Read @docs/rules.md and @later.' }
    w.at(1, files)
    await capture.run({ baseBranch: 'main' })
    const blobReads = w.forge.blobReads.length

    w.at(2, { ...files, 'src/main.ts': 'changed' })
    await capture.run({ baseBranch: 'main' })
    expect(w.forge.blobReads.length).toBe(blobReads)
    expect(await readAgentContextPointer(w.store, REPO)).toMatchObject({ observed: head(2) })

    // `later` becomes a directory: the fingerprint moves, the content does not.
    w.at(3, { ...files, 'later/x.md': 'x' })
    await capture.run({ baseBranch: 'main' })
    expect(await w.revisions()).toBe(1)

    w.at(4, { ...files, '.agents/skills/release/SKILL.md': '# release v2' })
    await capture.run({ baseBranch: 'main' })
    expect(w.forge.blobReads.length).toBe(blobReads + 1)
    expect(await w.revisions()).toBe(2)
    expect((await w.record())?.commit).toBe(head(4))
  })

  test('oversize keeps the last good revision and is reported once', async () => {
    const w = await world()
    const capture = w.capture({ maxBytes: 600 })
    w.at(1, SKILLS)
    await capture.run({ baseBranch: 'main' })
    const big = Array.from({ length: 2000 }, (_, i) => `${i * 7919}`).join(' ')
    w.at(2, { ...SKILLS, '.agents/skills/release/SKILL.md': big })
    const [diagnostic] = await capture.run({ baseBranch: 'main' })
    expect(diagnostic).toMatchObject({ kind: 'oversize', commit: head(2), bound: 600 })
    if (diagnostic?.kind !== 'oversize') throw new Error('expected oversize')
    expect(diagnostic.bytes).toBeGreaterThan(600)
    expect(diagnostic.largest[0]).toEqual({ path: '.agents/skills/release', bytes: big.length })
    expect((await w.record())?.commit).toBe(head(1))
    expect(await readAgentContextPointer(w.store, REPO)).toMatchObject({ diagnostic })
    const treeReads = w.forge.treeReads.length
    expect(await w.capture({ maxBytes: 600 }).run({ baseBranch: 'main' })).toEqual([])
    expect(w.forge.treeReads.length).toBe(treeReads)
  })

  test('highly compressible input under the raw bound is accepted at the real bounds', async () => {
    const w = await world()
    const huge = 'all work and no play '.repeat(22_200_000 / 21)
    w.at(1, { ...SKILLS, '.agents/skills/release/references/huge.md': huge })
    expect(await w.capture().run({ baseBranch: 'main' })).toEqual([])
    const stored = await readAgentContext(w.store, REPO)
    expect(stored?.meta.metadata.bytes as number).toBeLessThan(AGENT_CONTEXT_MAX_BYTES)
    expect(stored?.meta.metadata.rawBytes as number).toBeGreaterThan(22_000_000)
  })

  test('the raw input bound is its own limit, checked before fetching and again with imports', async () => {
    const w = await world()
    w.at(1, SKILLS)
    await w.capture().run({ baseBranch: 'main' })
    const reads = w.forge.blobReads.length
    w.at(2, { ...SKILLS, '.agents/skills/release/big.md': 'x'.repeat(5000) })
    const [diagnostic] = await w.capture({ maxRawBytes: 4000 }).run({ baseBranch: 'main' })
    expect(diagnostic).toMatchObject({ kind: 'raw-oversize', rawBound: 4000, commit: head(2) })
    expect(w.forge.blobReads.length).toBe(reads)
    expect((await w.record())?.commit).toBe(head(1))

    // Under the bound from the tree alone; over it once the import is read.
    w.at(3, { ...SKILLS, 'docs/rules.md': 'y'.repeat(5000) })
    expect((await w.capture({ maxRawBytes: 4000 }).run({ baseBranch: 'main' }))[0]?.kind).toBe(
      'raw-oversize',
    )

    // Under the bound in file bytes, over it as the record's JSON.
    w.at(4, { ...SKILLS, '.agents/skills/release/quotes.md': '"'.repeat(3600) })
    expect((await w.capture({ maxRawBytes: 4000 }).run({ baseBranch: 'main' }))[0]).toMatchObject({
      kind: 'raw-oversize',
      rawBound: 4000,
      commit: head(4),
    })
    expect((await w.record())?.commit).toBe(head(1))
  })

  test('every published record is readable: escape-heavy content is stored as base64', async () => {
    const w = await world()
    w.at(1, { ...SKILLS, '.agents/skills/release/padding.bin': new Uint8Array(8 * 1024 * 1024) })
    expect(await w.capture().run({ baseBranch: 'main' })).toEqual([])
    const stored = await readAgentContext(w.store, REPO)
    expect(stored?.record.commit).toBe(head(1))
    const padding = stored?.record.skills
      .find((skill) => skill.name === 'release')
      ?.files.find((file) => file.path === 'padding.bin')
    expect(padding?.bytes).toBe(8 * 1024 * 1024)
    expect(padding?.text).toBeUndefined()
    expect(padding?.base64?.length).toBe(Math.ceil((8 * 1024 * 1024) / 3) * 4)
  })

  test('an unlistable tree, a forge failure and a missing capability are typed and contained', async () => {
    const w = await world()
    w.forge.unlistable.set(head(1), 'vendor')
    w.forge.remoteBranches.set('main', head(1))
    const capture = w.capture()
    expect(await capture.run({ baseBranch: 'main' })).toEqual([
      { kind: 'tree-unlistable', commit: head(1), directory: 'vendor' },
    ])
    w.clock.advance(AGENT_CONTEXT_HEAD_POLL_MS)
    expect(await capture.run({ baseBranch: 'main' })).toEqual([])
    expect(w.forge.treeReads).toEqual([head(1)])

    w.at(2, SKILLS)
    const readBlob = w.forge.readBlob
    w.forge.readBlob = async () => {
      throw new Error('blob read refused')
    }
    const [failed] = await capture.run({ baseBranch: 'main' })
    expect(failed).toMatchObject({ kind: 'capture-failed', commit: head(2) })
    w.forge.readBlob = readBlob
    // Retried at the same head only after the backoff: no per-tick reads.
    expect(await capture.run({ baseBranch: 'main' })).toEqual([])
    expect(w.forge.treeReads).toEqual([head(1), head(2)])
    w.clock.advance(AGENT_CONTEXT_RETRY_MS)
    expect(await capture.run({ baseBranch: 'main' })).toEqual([])
    expect((await w.record())?.commit).toBe(head(2))

    const bare = new AgentContextCapture({
      store: w.store,
      repo: REPO,
      forge: Object.assign(new FakeForge(), { readTree: undefined }),
    })
    expect((await bare.run({ baseBranch: 'main' }))[0]?.kind).toBe('unavailable')
    expect(await bare.run({ baseBranch: 'main' })).toEqual([])
    expect(await w.capture().run({ baseBranch: 'main', holdsAuthority: () => false })).toEqual([])
  })
})

describe('durable continuation', () => {
  const many = (count: number, size = 10): Record<string, FakeTreeFile> => {
    const files: Record<string, FakeTreeFile> = { '.agents/skills/big/SKILL.md': '# big' }
    for (let i = 1; i < count; i++)
      files[`.agents/skills/big/f${String(i).padStart(3, '0')}.md`] = `${i}:`.padEnd(size, '.')
    return files
  }
  /** Run fresh instances (one per hosted invocation) until the record lands. */
  async function drive(
    w: Awaited<ReturnType<typeof world>>,
    bounds: Partial<AgentContextBounds> | undefined,
    budgetMs: (invocation: number) => number,
  ) {
    let invocations = 0
    while (
      (await readAgentContextPointer(w.store, REPO))?.observed !==
      w.forge.remoteBranches.get('main')
    ) {
      invocations++
      if (invocations > 60) throw new Error('capture never completed')
      expect(
        await w.capture(bounds).run({
          baseBranch: 'main',
          deadlineAt: w.clock.now() + 2_000 + budgetMs(invocations),
        }),
      ).toEqual([])
    }
    return invocations
  }

  test('interrupted invocations resume without refetching and match an uninterrupted capture', async () => {
    const w = await world({ msPerBlob: 100 })
    const files = many(40)
    w.at(1, files)
    // Two batches of 8 per invocation: the third would start inside the reserve.
    expect(await drive(w, undefined, () => 1_500)).toBe(3)
    expect(new Set(w.forge.blobReads).size).toBe(w.forge.blobReads.length)
    expect(w.forge.blobReads.length).toBe(40)
    const reference = await world()
    reference.at(1, files)
    await reference.capture().run({ baseBranch: 'main' })
    expect(await w.record()).toEqual(await reference.record())

    // Settled: the next tick reads no slot and no blob.
    const slotReads: string[] = []
    const get = w.store.getRepoArtifact.bind(w.store)
    w.store.getRepoArtifact = async (repo, kind, rev) => {
      slotReads.push(kind)
      return get(repo, kind, rev)
    }
    await w.capture().run({ baseBranch: 'main' })
    expect(slotReads).toEqual([AGENT_CONTEXT_HEAD_ARTIFACT])
    expect(w.forge.blobReads.length).toBe(40)
  })

  test('a head that moves while pending reuses what it still needs and repacks from slot 0', async () => {
    const w = await world({ msPerBlob: 100 })
    const files = many(40)
    w.at(1, files)
    await w.capture().run({ baseBranch: 'main', deadlineAt: w.clock.now() + 3_500 })
    const first = await readAgentContextPointer(w.store, REPO)
    expect(first?.pending).toMatchObject({ head: head(1) })
    const fetched = new Set(w.forge.blobReads)
    // Drop one fetched file: the selection changed, so a fresh capture starts.
    const dropped = Object.keys(files).find((path) => {
      const entry = w.forge.trees.get(head(1))!.find((candidate) => candidate.path === path)
      return path !== '.agents/skills/big/SKILL.md' && fetched.has(entry!.oid)
    })!
    const { [dropped]: _gone, ...moved } = files
    w.at(2, moved)
    await w.capture().run({ baseBranch: 'main', deadlineAt: w.clock.now() + 3_500 })
    const second = await readAgentContextPointer(w.store, REPO)
    expect(second?.pending?.captureId).not.toBe(first?.pending?.captureId)
    await drive(w, undefined, () => 1_500)
    expect(new Set(w.forge.blobReads).size).toBe(w.forge.blobReads.length)
    expect((await w.record())?.skills[0]?.files.length).toBe(39)
  })

  test('maxRevisions 1, slot rollover, split blobs and many short invocations', async () => {
    const w = await world({ maxRevisions: 1, msPerBlob: 100 })
    const payload = 1_000
    const files = many(120, 60)
    files['.agents/skills/big/large.bin'] = new Uint8Array(2_500).map((_, i) => (i * 31) % 251)
    w.at(1, files)
    const bounds = { slotPayload: payload, maxBytes: 8_000, slots: 64 }
    const maxSlots: number[] = []
    const put = w.store.putRepoArtifact.bind(w.store)
    w.store.putRepoArtifact = async (repo, artifact) => {
      if (artifact.kind.startsWith(AGENT_CONTEXT_CACHE_KIND_PREFIX))
        expect((artifact.content as Uint8Array).byteLength).toBeLessThanOrEqual(2.5 * 1024 * 1024)
      const meta = await put(repo, artifact)
      const pending = (await readAgentContextPointer(w.store, REPO))?.pending
      if (pending) maxSlots.push(pending.slots)
      return meta
    }
    // Mostly one-batch invocations, with an occasional two-batch one.
    const invocations = await drive(w, bounds, (n) => (n % 4 === 0 ? 1_500 : 50))
    expect(invocations).toBeGreaterThan(10)
    expect(new Set(w.forge.blobReads).size).toBe(w.forge.blobReads.length)
    const reference = await world()
    reference.at(1, files)
    await reference.capture(bounds).run({ baseBranch: 'main' })
    expect(await w.record()).toEqual(await reference.record())
    // Live slots follow the bytes, never the invocation count.
    let live = 0
    for (const entry of w.forge.trees.get(head(1))!)
      if (entry.type === 'blob') live += Math.ceil((entry.size ?? 0) / 3) * 4 + 128
    expect(Math.max(...maxSlots)).toBeLessThanOrEqual(Math.ceil((live + 3 * 128) / (payload - 132)))
    const kinds = await w.store.listRepoArtifacts(REPO)
    const perKind = new Map<string, number>()
    for (const meta of kinds) perKind.set(meta.kind, (perKind.get(meta.kind) ?? 0) + 1)
    expect(Math.max(...perKind.values())).toBe(1)
  })

  test('a crash between the slot writes and the pointer write still completes', async () => {
    const w = await world({ msPerBlob: 100 })
    const files = many(40)
    w.at(1, files)
    await w.capture().run({ baseBranch: 'main', deadlineAt: w.clock.now() + 3_500 })
    const put = w.store.putRepoArtifact.bind(w.store)
    let fail = true
    w.store.putRepoArtifact = async (repo, artifact) => {
      if (fail && artifact.kind === AGENT_CONTEXT_HEAD_ARTIFACT) {
        fail = false
        throw new Error('store unavailable')
      }
      return put(repo, artifact)
    }
    const [failed] = await w
      .capture()
      .run({ baseBranch: 'main', deadlineAt: w.clock.now() + 3_500 })
    expect(failed?.kind).toBe('capture-failed')
    await drive(w, undefined, () => 1_500)
    const reference = await world()
    reference.at(1, files)
    await reference.capture().run({ baseBranch: 'main' })
    expect(await w.record()).toEqual(await reference.record())
  })
})

test('the dispatcher runs the stage last and surfaces its diagnostics', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(REPO)
  const calls: string[] = []
  const dispatcher = new Dispatcher({
    store,
    tickets: new FakeTicketSource(),
    workspaces: new FakeWorkspaceProvider({ root: '/agent-context', mode: 'logical' }),
    forge: new FakeForge(),
    config: parseConfig(
      '[tickets]\nsource = "fake"\nreadyState = "Ready"\n[verify]\nsteps = []\n[finalize]\nsteps = []\n',
    ),
    repo: REPO,
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    launchRunner: async () => 'scheduled',
    ids: sequentialIds(),
    clock: () => new Date('2026-11-24T00:00:00Z'),
    agentContext: {
      run: async (opts) => {
        calls.push(opts.baseBranch)
        return [{ kind: 'unavailable', message: 'test' }]
      },
    },
  })
  const report = await dispatcher.tick()
  expect(report.agentContextDiagnostics).toEqual([{ kind: 'unavailable', message: 'test' }])
  expect(calls).toEqual(['main'])
  const late = await dispatcher.tick({ deadlineAt: Date.parse('2026-11-24T00:00:00Z') })
  expect(late.agentContextDiagnostics).toEqual([])
  expect(calls).toEqual(['main'])
})

test('agent-context recurring reads are bounded (read-budget harness)', async () => {
  const { agentContextReadBudget } = await import('../testing/reduced-read-budget')
  await agentContextReadBudget()
})
