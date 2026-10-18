import { expect, test } from 'bun:test'
import { MemoryBuildStore } from '../store/memory'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { listOperatorLandings } from './landings'
import { readBuildStreamSeed } from '../store/reduced-reads'
import { consentIdentity } from '../cli/attention'
import { decodeCursor, encodeCursor } from '../cli/watch'

async function ready(store: MemoryBuildStore, slug: string, repo = 'repo') {
  await store.createBuild({ slug, repo, branch: `branch/${slug}` })
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
  await store.append(slug, {
    actor: KERNEL,
    type: 'finalize.completed',
    payload: { pr: { number: 1, url: 'https://forge/1', headSha: 'head' } },
  })
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'landing.decided',
    payload: {
      candidate: { head: 'head', parent: 'base', cycle: '3' },
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
