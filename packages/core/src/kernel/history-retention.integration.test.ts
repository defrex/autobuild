import { temporaryDirectories } from '../testing/temp-directories'
import { afterEach, expect, test } from 'bun:test'
import { chmod, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedStore, BUILD, BRANCH } from '../cli/testkit'
import { bunExec } from '../ports/forge/github'
import { gitRewrite } from '../ports/forge/git-rewrite'
import { ArchiveConflictError, ForgeFailure } from '../ports/forge-failure'
import {
  archiveRef,
  recordRetention,
  restoreCommit,
  retainCommit,
  UNRETAINED_OBSERVATION,
  type RetentionContext,
} from './history-retention'
import { readRetainedPack } from './replay-retention'
import type { BuildStore } from '../store/types'

const mkdtemp = temporaryDirectories(afterEach)

async function git(args: string[], cwd: string) {
  const result = await bunExec(['git', ...args], { cwd })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

/** A bare origin that, when refusing, accepts branch pushes and rejects every
 * archive ref, like a proxy that allows only `refs/heads/*`. */
async function world(refuse: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'ab-history-'))
  const origin = join(root, 'origin.git')
  const seed = join(root, 'seed')
  await git(['init', '--bare', '-q', origin], root)
  if (refuse) {
    const hook = join(origin, 'hooks', 'update')
    await writeFile(
      hook,
      '#!/bin/sh\ncase "$1" in refs/autobuild/archive/*) echo "pushes of anything other than a branch are not allowed" >&2; exit 1;; esac\nexit 0\n',
    )
    await chmod(hook, 0o755)
  }
  await git(['init', '-q', '-b', 'main', seed], root)
  for (const [key, value] of [
    ['user.name', 'Test'],
    ['user.email', 'test@example.invalid'],
    ['commit.gpgsign', 'false'],
  ])
    await git(['config', key!, value!], seed)
  const commit = async (name: string) => {
    await writeFile(join(seed, name), `${name}\n`)
    await git(['add', name], seed)
    await git(['commit', '-qm', name], seed)
    return git(['rev-parse', 'HEAD'], seed)
  }
  const base = await commit('base')
  await git(['remote', 'add', 'origin', origin], seed)
  await git(['push', '-q', 'origin', 'main'], seed)
  await git(['checkout', '-qb', BRANCH], seed)
  const first = await commit('first')
  const head = await commit('head')
  await git(['push', '-q', 'origin', BRANCH], seed)
  // Never published: only a store copy can carry it to another host.
  const unpublished = await commit('unpublished')
  await git(['checkout', '-q', 'main'], seed)
  const target = await commit('target')
  await git(['push', '-q', 'origin', 'main'], seed)
  const clone = async (branch: string) => {
    const path = join(root, `clone-${Math.random().toString(36).slice(2)}`)
    await git(
      ['clone', '-q', '--single-branch', '--branch', branch, `file://${origin}`, path],
      root,
    )
    return path
  }
  const context = (store: BuildStore, workspacePath: string): RetentionContext => ({
    store,
    slug: BUILD,
    exec: bunExec,
    workspacePath,
    archive: gitRewrite(bunExec, false).archive,
    exclude: target,
    local: false,
    branch: BRANCH,
    targetBranch: 'main',
  })
  return { root, origin, seed, base, first, head, unpublished, target, clone, context }
}

const scope = { operation: 'restack' as const, id: 'rewrite-1', base: '' }

async function retainedFacts(store: BuildStore) {
  const events = await store.getEvents(BUILD)
  return {
    retained: events.filter((e) => e.type === 'history.retained').map((e) => e.payload),
    warnings: events.filter(
      (e) => e.type === 'observation.recorded' && e.payload.id === UNRETAINED_OBSERVATION,
    ),
  }
}

test('an accepting forge keeps the archive ref with exact readback and writes no store copy', async () => {
  const w = await world(false)
  const store = await seedStore()
  const outcome = await retainCommit(w.context(store, w.seed), w.head)
  expect(outcome).toEqual({ sha: w.head, in: 'forge', ref: archiveRef(BUILD, w.head) })
  expect(await git(['rev-parse', archiveRef(BUILD, w.head)], w.origin)).toBe(w.head)
  expect(await store.getArtifact(BUILD, `history-objects-${w.head}`)).toBeNull()
  await recordRetention(store, BUILD, { ...scope, base: w.target }, [outcome])
  expect(await retainedFacts(store)).toEqual({ retained: [], warnings: [] })
})

test('a refusing forge keeps a thin store copy of only the build-owned objects', async () => {
  const w = await world(true)
  const store = await seedStore()
  const outcome = await retainCommit(w.context(store, w.seed), w.unpublished)
  expect(outcome).toEqual({ sha: w.unpublished, in: 'store' })
  expect(
    (await bunExec(['git', 'rev-parse', archiveRef(BUILD, w.unpublished)], { cwd: w.origin }))
      .exitCode,
  ).not.toBe(0)
  const copy = await readRetainedPack(store, BUILD, w.unpublished)
  expect(copy?.base).toBe(w.target)
  // The pack header counts exactly the objects the target does not reach.
  const count = Buffer.from(copy!.pack).readUInt32BE(8)
  const owned = (await git(['rev-list', '--objects', w.unpublished, `^${w.target}`], w.seed))
    .split('\n')
    .filter(Boolean)
  expect(count).toBe(owned.length)
  await recordRetention(store, BUILD, { ...scope, base: w.target }, [outcome])
  await recordRetention(store, BUILD, { ...scope, base: w.target }, [outcome])
  expect((await retainedFacts(store)).retained).toEqual([
    {
      operation: 'restack',
      id: 'rewrite-1',
      base: w.target,
      store: [w.unpublished],
      target: [],
      unretained: [],
    },
  ])
})

test('a commit the published target reaches needs no copy', async () => {
  const w = await world(true)
  const store = await seedStore()
  expect(await retainCommit(w.context(store, w.seed), w.base)).toEqual({
    sha: w.base,
    in: 'target',
  })
  expect(await store.getArtifact(BUILD, `history-objects-${w.base}`)).toBeNull()
})

test('history retained nowhere warns once per build and the rewrite proceeds', async () => {
  const w = await world(true)
  const store = await seedStore()
  const put = store.putArtifact.bind(store)
  store.putArtifact = async () => {
    throw new Error('store write refused')
  }
  const ctx = w.context(store, w.seed)
  const first = await retainCommit(ctx, w.head)
  expect(first).toMatchObject({ sha: w.head, in: 'none' })
  expect(first.in === 'none' && first.reason).toContain('store write refused')
  await recordRetention(store, BUILD, { ...scope, base: w.target }, [first])
  let facts = await retainedFacts(store)
  expect(facts.warnings).toHaveLength(1)
  expect(facts.warnings[0]!.payload).toMatchObject({ kind: 'followup', refs: [w.head] })
  // A later attempt with a different unretained commit adds no warning.
  const second = await retainCommit(ctx, w.first)
  await recordRetention(store, BUILD, { ...scope, id: 'rewrite-2', base: w.target }, [second])
  await recordRetention(store, BUILD, { ...scope, id: 'rewrite-2', base: w.target }, [second])
  facts = await retainedFacts(store)
  expect(facts.warnings).toHaveLength(1)
  expect(facts.retained.map((payload) => payload.unretained)).toEqual([[w.head], [w.first]])
  store.putArtifact = put
})

test('immutable-ref conflicts and transient failures are never absorbed', async () => {
  const w = await world(true)
  const store = await seedStore()
  for (const failure of [
    new ArchiveConflictError('immutable archive names another commit'),
    new ForgeFailure('connection reset', { kind: 'transient', retry: 'retryable' }),
  ]) {
    const ctx = {
      ...w.context(store, w.seed),
      archive: async () => {
        throw failure
      },
    }
    await expect(retainCommit(ctx, w.head)).rejects.toBe(failure)
  }
  expect(await store.getArtifact(BUILD, `history-objects-${w.head}`)).toBeNull()
})

test('another host restores retained history from the forge ref, the store copy or the published branch', async () => {
  const accepting = await world(false)
  const forgeStore = await seedStore()
  await retainCommit(accepting.context(forgeStore, accepting.seed), accepting.unpublished)
  const fromForge = await accepting.clone('main')
  expect(await restoreCommit(accepting.context(forgeStore, fromForge), accepting.unpublished)).toBe(
    true,
  )

  const refusing = await world(true)
  const store = await seedStore()
  expect(await retainCommit(refusing.context(store, refusing.seed), refusing.unpublished)).toEqual({
    sha: refusing.unpublished,
    in: 'store',
  })
  // The build-branch clone lacks the copy's exclusion base until the
  // published target is fetched.
  const fromStore = await refusing.clone(BRANCH)
  expect(
    (await bunExec(['git', 'cat-file', '-e', `${refusing.target}^{commit}`], { cwd: fromStore }))
      .exitCode,
  ).not.toBe(0)
  expect(await restoreCommit(refusing.context(store, fromStore), refusing.unpublished)).toBe(true)
  expect(await git(['rev-list', '--objects', refusing.unpublished], fromStore)).toContain(
    refusing.unpublished,
  )

  const empty = await seedStore()
  const fromBranch = await refusing.clone('main')
  expect(await restoreCommit(refusing.context(empty, fromBranch), refusing.head)).toBe(true)
  expect(await restoreCommit(refusing.context(empty, fromBranch), refusing.unpublished)).toBe(false)
})

test('a store-only prepared change is restored and archived on an accepting forge', async () => {
  const w = await world(false)
  const store = await seedStore()
  // A prepared reconcile change that never reached the forge: its tree and
  // parent are published, the commit itself survives only in the store.
  const change = await git(
    ['commit-tree', `${w.head}^{tree}`, '-p', w.base, '-m', 'prepared change'],
    w.seed,
  )
  await store.putArtifact(BUILD, {
    kind: `reconcile-change-${change}`,
    content: await git(['cat-file', 'commit', change], w.seed).then((text) => `${text}\n`),
  })
  const host = await w.clone(BRANCH)
  await git(['fetch', '-q', 'origin', 'main'], host)
  expect((await bunExec(['git', 'cat-file', '-e', change], { cwd: host })).exitCode).not.toBe(0)
  const outcome = await retainCommit(w.context(store, host), change)
  expect(outcome).toEqual({ sha: change, in: 'forge', ref: archiveRef(BUILD, change) })
  expect(await git(['rev-parse', archiveRef(BUILD, change)], w.origin)).toBe(change)
  expect(await store.getArtifact(BUILD, `history-objects-${change}`)).toBeNull()
})
