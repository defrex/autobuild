import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readVerifyPipeline } from '../config/pipeline-source'
import { parseConfig } from '../config/load'
import { KERNEL } from '../events/envelope'
import { reduceBuild } from '../kernel/reducer'
import { spawnExec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import {
  effectiveBuildConfigContent,
  BUILD_EFFECTIVE_CONFIG_ARTIFACT,
} from './build-execution-state'
import { capturedBuildConfig, refreshVerifyCycle } from './verify-cycle-config'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const toml = (step = 'web-dashboard') => `
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = ["${step}"]
[verify.${step}]
kind = "agent"
skill = "verify-${step}"
`
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'verify-cycle-'))
  roots.push(root)
  const git = async (...args: string[]) => {
    const result = await spawnExec(['git', ...args], { cwd: root })
    if (result.exitCode) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  await git('init', '-b', 'main')
  await git('config', 'user.email', 'test@example.com')
  await git('config', 'user.name', 'Test')
  const commit = async (content: string) => {
    await writeFile(join(root, 'autobuild.toml'), content)
    await git('add', 'autobuild.toml')
    await git('commit', '-m', 'config')
    return git('rev-parse', 'HEAD')
  }
  const head = await commit(toml())
  const full = new MemoryBuildStore()
  await full.createBuild({
    slug: 'test',
    repo: root,
    ticket: { source: 'file', id: 'T1', title: 'Test' },
  })
  const store = full.scopeBuild('test')
  const state = async () => reduceBuild(await store.getEvents('test'))
  const refresh = async (exec = spawnExec, retainCompletedVerification = false) =>
    refreshVerifyCycle({
      store,
      slug: 'test',
      state: await state(),
      deployment: parseConfig(toml()),
      read: () => readVerifyPipeline(root, spawnExec),
      exec,
      workspacePath: root,
      retainCompletedVerification,
    })
  return { root, git, commit, head, store, state, refresh }
}

test('rename supersedes the cycle and captures the exact checkout revision, without a failure', async () => {
  const f = await fixture()
  expect(await f.refresh()).toBe(true)
  const oldPin = (await f.state()).verify.configPin!
  await f.store.append('test', {
    actor: KERNEL,
    type: 'verify.completed',
    payload: { step: 'web-dashboard', attempt: 1, outcome: 'pass' },
  })
  const head = await f.commit(toml('ui-app'))
  expect(await f.refresh()).toBe(true)
  expect((await f.state()).verify.cycleSince).toBeGreaterThan(oldPin.seq)
  expect(await f.refresh()).toBe(true)
  expect(await f.refresh()).toBe(false)
  const state = await f.state()
  expect(state.verify.configPin).toMatchObject({ head, source: { commit: head } })
  expect(state.verify.results.filter((r) => r.seq > state.verify.cycleSince)).toEqual([])
  expect(
    (await capturedBuildConfig(f.store, 'test', state, parseConfig(toml()))).verify.steps,
  ).toEqual(['ui-app'])
  expect(
    (await f.store.getEvents('test')).filter(
      (e) =>
        e.type === 'verify.completed' && 'outcome' in e.payload && e.payload.outcome === 'fail',
    ),
  ).toHaveLength(0)
})

test('unchanged config on a descendant retains its capture; a non-ancestor equal-config rewrite supersedes', async () => {
  const f = await fixture()
  await f.refresh()
  await f.git('commit', '--allow-empty', '-m', 'descendant')
  expect(await f.refresh()).toBe(false)
  await f.git('checkout', '--orphan', 'replacement')
  await f.git('commit', '-m', 'replacement')
  expect(await f.refresh()).toBe(true)
})

test('dirty config has no committed provenance; parse and ancestry errors block', async () => {
  const f = await fixture()
  await f.refresh()
  await expect(
    f.refresh(async () => ({ exitCode: 128, stdout: '', stderr: 'missing object' })),
  ).rejects.toThrow('ancestry')
  await writeFile(join(f.root, 'autobuild.toml'), toml('ui-app'))
  await f.refresh()
  await f.refresh()
  expect((await f.state()).verify.configPin!.source).toEqual({ ref: 'worktree-dirty' })
  await writeFile(join(f.root, 'autobuild.toml'), 'not valid TOML')
  await expect(f.refresh()).rejects.toThrow()
})

test('a racing old reload cannot replace the captured build-owned config on resume', async () => {
  const f = await fixture()
  await f.refresh()
  await f.commit(toml('ui-app'))
  await f.refresh()
  await f.refresh()
  await f.store.putArtifact('test', {
    kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
    content: effectiveBuildConfigContent(parseConfig(toml())),
  })
  const state = await f.state()
  const restored = await capturedBuildConfig(f.store, 'test', state, parseConfig(toml()))
  expect(restored.verify.steps).toEqual(['ui-app'])
  expect(await f.refresh()).toBe(false)
})

test('artifact/append crash windows recover with one authoritative capture', async () => {
  const f = await fixture()
  const append = f.store.appendIfCurrent.bind(f.store)
  let failOnce = true
  f.store.appendIfCurrent = async (...args) => {
    if (failOnce) {
      failOnce = false
      throw new Error('crash after artifact deposit')
    }
    return append(...args)
  }
  await expect(f.refresh()).rejects.toThrow('crash')
  expect(await f.store.getArtifact('test', BUILD_EFFECTIVE_CONFIG_ARTIFACT)).toBeNull()
  expect((await f.state()).verify.configPin).toBeUndefined()
  await f.refresh()
  expect(await f.refresh()).toBe(false)
  expect(
    (await f.store.getEvents('test')).filter((e) => e.type === 'verify.config-captured'),
  ).toHaveLength(1)
  await f.commit(toml('ui-app'))
  await f.refresh() // Crash here: supersession persisted, capture not yet written.
  expect((await f.state()).verify.configPin!.cycle).toBeLessThan(
    (await f.state()).verify.cycleSince,
  )
  await f.refresh()
  expect(await f.refresh()).toBe(false)
  expect((await f.state()).verify.configPin!.cycle).toBe((await f.state()).verify.cycleSince)
})

test('a config absent from the committed tree is truthfully captured as dirty', async () => {
  const f = await fixture()
  await f.git('rm', 'autobuild.toml')
  await f.git('commit', '-m', 'remove config')
  await writeFile(join(f.root, 'autobuild.toml'), toml('ui-app'))
  await f.refresh()
  expect((await f.state()).verify.configPin!.source).toEqual({ ref: 'worktree-dirty' })
})

test('completed waiting leaves retain equal-config non-ancestor pins but still supersede changed config', async () => {
  const f = await fixture()
  await f.refresh()
  const pin = (await f.state()).verify.configPin!
  await f.git('checkout', '--orphan', 'waiting-rewrite')
  await f.git('commit', '-m', 'clean waiting rewrite')
  expect(await f.refresh(spawnExec, true)).toBe(false)
  expect((await f.state()).verify.configPin).toEqual(pin)
  // Waiting requires no ancestry evidence because it launches no step.
  expect(
    await f.refresh(async () => {
      throw new Error('ancestry must not be read')
    }, true),
  ).toBe(false)
  await f.commit(toml('ui-app'))
  expect(await f.refresh(spawnExec, true)).toBe(true)
  expect(
    (await f.store.getEvents('test')).filter((event) => event.type === 'verify.config-superseded'),
  ).toHaveLength(1)
})
