import { expect, test } from 'bun:test'
import { MemoryBuildStore } from '../store/memory'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { listOperatorLandings } from './landings'
import { readBuildStreamSeed } from '../store/reduced-reads'
import { consentIdentity, consentReady } from '../cli/attention'
import { decodeCursor, encodeCursor } from '../cli/watch'

async function ready(
  store: MemoryBuildStore,
  slug: string,
  repo = 'repo',
  ancestry?: {
    baseBranch: string
    target?: { ticket: { source: string; id: string }; build: string }
  },
) {
  await store.createBuild({
    slug,
    repo,
    branch: `branch/${slug}`,
    ...(ancestry
      ? {
          created: {
            actor: DISPATCHER,
            type: 'build.created',
            payload: { ticket: { source: 'file', id: slug }, repo, ...ancestry },
          } as const,
        }
      : {}),
  })
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
      branch: `branch/${slug}`,
      base: { source: 'local', remoteError: 'offline', sha: 'base' },
    },
  })
  const finalized = await store.append(slug, {
    actor: KERNEL,
    type: 'finalize.completed',
    payload: { pr: { number: 1, url: 'https://forge/1', headSha: 'head' } },
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
}
test('queue is sorted, repository scoped and carries recorded branches', async () => {
  const store = new MemoryBuildStore()
  await ready(store, 'z')
  await ready(store, 'a')
  await ready(store, 'foreign', 'other')
  const queue = await listOperatorLandings({ store, repo: 'repo' })
  expect(queue.map((entry) => entry.slug)).toEqual(['a', 'z'])
  expect(queue[0]!.branch).toBe('branch/a')
  await store.append('a', {
    actor: { kind: 'human', user: 'op' },
    type: 'build.land-requested',
    payload: { decisionSeq: 4 },
  })
  expect((await listOperatorLandings({ store, repo: 'repo' })).map((entry) => entry.slug)).toEqual([
    'z',
  ])
})
test('readiness episode survives snapshots and changes on exit/reentry', async () => {
  const store = new MemoryBuildStore()
  await ready(store, 'one')
  const first = (await readBuildStreamSeed(store, 'one')).value.consentEpisode!
  expect(first.seq).toBe(4)
  await store.append('one', {
    actor: { kind: 'human', user: 'op' },
    type: 'build.land-requested',
    payload: { decisionSeq: 4 },
  })
  expect((await readBuildStreamSeed(store, 'one')).value.consentEpisode).toBeUndefined()
  await store.append('one', {
    actor: { kind: 'human', user: 'op' },
    type: 'build.hold-requested',
    payload: {},
  })
  const second = (await readBuildStreamSeed(store, 'one')).value.consentEpisode!
  expect(second.seq).toBe(6)
  const id = consentIdentity('one', second.seq)
  const cursor = encodeCursor({
    v: 1,
    store: 'store',
    repo: 'repo',
    streams: { one: 6 },
    deliveredAttention: [id],
  })
  expect(decodeCursor(cursor, { store: 'store', repo: 'repo' }).deliveredAttention).toEqual([id])
})

test('CLI JSON is the operator queue and text names every selected entry', async () => {
  const { abLandings } = await import('../cli/landings')
  const store = new MemoryBuildStore()
  await ready(store, 'selected', '/repo')
  const expected = await listOperatorLandings({ store, repo: '/repo' })
  const out: string[] = []
  const opts = {
    targetRepo: '/repo',
    env: {},
    openStore: () => store,
    stdout: (line: string) => out.push(line),
    exec: async (cmd: readonly string[]) =>
      cmd[1] === 'remote'
        ? { stdout: '', stderr: 'no origin', exitCode: 2 }
        : { stdout: '/repo/.git\n/repo/.git\n/repo\n', stderr: '', exitCode: 0 },
  }
  await abLandings({ ...opts, json: true })
  expect(JSON.parse(out[0]!)).toEqual(JSON.parse(JSON.stringify(expected)))
  out.length = 0
  await abLandings(opts)
  expect(out.join('\n')).toContain('selected')
  expect(out.join('\n')).toContain('branch/selected')
})

test('terminal inventory is skipped without hydrating finished build facts', async () => {
  const store = new MemoryBuildStore()
  for (let i = 0; i < 12; i++) {
    const slug = `finished-${i}`
    await store.createBuild({ slug, repo: 'repo' })
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
  }
  const read = store.getReducerValue.bind(store)
  const buildReads: string[] = []
  store.getReducerValue = async (scope, ...args) => {
    if (scope.kind === 'build' && args[0].reducer === 'buildReadFacts') buildReads.push(scope.slug)
    return read(scope, ...args)
  }
  expect(await listOperatorLandings({ store, repo: 'repo' })).toEqual([])
  expect(buildReads).toEqual([])
})

test.each(['root', 'node'] as const)(
  'consent observations and queue entries share %s target shape',
  async (kind) => {
    const store = new MemoryBuildStore()
    await ready(
      store,
      'ready',
      'repo',
      kind === 'root'
        ? { baseBranch: 'main' }
        : {
            baseBranch: 'ab-node/recorded',
            target: { ticket: { source: 'file', id: 'NODE' }, build: 'frozen-node' },
          },
    )
    const [entry] = await listOperatorLandings({ store, repo: 'repo' })
    const observation = consentReady(
      (await readBuildStreamSeed(store, 'ready')).value,
      new Date(0),
    )!
    expect(observation.target).toEqual(entry!.target)
    expect(observation.target).toMatchObject({
      kind,
      branch: kind === 'root' ? 'main' : 'ab-node/recorded',
    })
    if (kind === 'node')
      expect(observation.target).toMatchObject({
        ticket: { source: 'file', id: 'NODE' },
        build: 'frozen-node',
      })
  },
)

test('CLI queue text takes its labels from the shared vocabulary', async () => {
  const { abLandings } = await import('../cli/landings')
  const { treeVocabulary } = await import('../cli/dashboard/tree')
  const original = { ...treeVocabulary }
  const store = new MemoryBuildStore()
  await ready(store, 'selected', '/repo')
  const out: string[] = []
  try {
    Object.assign(treeVocabulary, { verify: 'CHECK', root: 'ROOT' })
    await abLandings({
      targetRepo: '/repo',
      env: {},
      openStore: () => store,
      stdout: (line) => out.push(line),
      exec: async (cmd) =>
        cmd[1] === 'remote'
          ? { stdout: '', stderr: 'no origin', exitCode: 2 }
          : { stdout: '/repo/.git\n/repo/.git\n/repo\n', stderr: '', exitCode: 0 },
    })
    expect(out.join('\n')).toContain('→ ROOT')
    expect(out.join('\n')).toContain('CHECK no steps')
  } finally {
    Object.assign(treeVocabulary, original)
  }
})

test('CLI canonical merge commands and deprecated aliases share behavior and keep JSON stdout clean', async () => {
  const { runCli } = await import('../cli/main')
  const store = new MemoryBuildStore()
  for (const slug of ['modern', 'legacy']) await ready(store, slug, '/repo')
  const out: string[] = [],
    err: string[] = []
  const deps = {
    workspacePath: '/repo',
    processEnv: {},
    openStore: () => store,
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
    exec: async (cmd: readonly string[]) =>
      cmd[1] === 'remote'
        ? { stdout: '', stderr: 'no origin', exitCode: 2 }
        : { stdout: '/repo/.git\n/repo/.git\n/repo\n', stderr: '', exitCode: 0 },
  }
  expect(await runCli(['merges', '--json'], deps)).toBe(0)
  const listing = JSON.parse(out.pop()!)
  expect(err).toEqual([])
  expect(await runCli(['landings', '--json'], deps)).toBe(0)
  expect(JSON.parse(out.pop()!)).toEqual(listing)
  expect(err.splice(0)).toEqual(['ab landings is deprecated; use ab merges'])
  expect(await runCli(['merge', 'modern'], deps)).toBe(0)
  expect(err).toEqual([])
  expect(await runCli(['land', 'legacy'], deps)).toBe(0)
  expect(err).toEqual(['ab land is deprecated; use ab merge'])
  for (const slug of ['modern', 'legacy'])
    expect((await store.getEvents(slug)).at(-1)).toMatchObject({
      type: 'build.land-requested',
      payload: { decisionSeq: 4 },
    })
})
