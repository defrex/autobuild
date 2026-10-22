import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { spawnExec } from '../ports/workspace/git-worktree'
import { seedStore, BUILD, makeEnv } from './testkit'
import { collectNodeVerificationProvenance } from './node-verification-provenance'
import { buildContext } from './context'

let workspace: string
let store: Awaited<ReturnType<typeof seedStore>>
async function git(...args: string[]) {
  const r = await spawnExec(['git', ...args], { cwd: workspace })
  if (r.exitCode) throw new Error(r.stderr)
  return r.stdout.trim()
}
async function commit(message: string) {
  await git('commit', '--allow-empty', '-m', message)
  return git('rev-parse', 'HEAD')
}
async function source(slug: string, repo = 'acme/app', kind: 'work' | 'node' = 'work') {
  const ticket = { source: 'linear', id: slug, title: slug }
  await store.createBuild({ slug, repo, ticket })
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: { ticket, repo, baseBranch: 'main', kind },
  })
  await store.putArtifact(slug, { kind: 'spec', content: `Authorize ${slug}` })
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'spec.imported',
    payload: { ticket, artifact: { kind: 'spec', rev: 0 } },
  })
}
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'node-provenance-'))
  store = await seedStore()
  await git('init')
  await git('config', 'user.email', 'test@example.com')
  await git('config', 'user.name', 'Test')
})
afterEach(async () => {
  await store.close()
  await rm(workspace, { recursive: true, force: true })
})

test('frozen all-commit range includes earlier and nested contributions, ignores stray deposits', async () => {
  await source('second')
  await source('unlanded')
  const base = await commit('base')
  const first = await commit(`first\n\nAutobuild-Build: ${BUILD}`)
  await git('checkout', '-b', 'side')
  const side = await commit('side\n\nAutobuild-Build: second')
  await git('checkout', '-')
  const repeated = await commit(`again\n\nAutobuild-Build: ${BUILD}`)
  await git('merge', '--no-ff', 'side', '-m', 'merge')
  const head = await git('rev-parse', 'HEAD')
  await commit('outside\n\nAutobuild-Build: unlanded')
  await store.putArtifact(BUILD, { kind: 'spec', content: 'unsanctioned' })
  const result = await collectNodeVerificationProvenance(
    store,
    'acme/app',
    { base, head },
    { exec: spawnExec, workspacePath: workspace },
  )
  expect(result.index.commits.map((c) => c.sha).sort()).toEqual(
    [first, side, repeated, head].sort(),
  )
  expect(result.index.contributions.map((c) => c.build)).toEqual([BUILD, 'second'])
  expect(result.index.contributions[0]!.commits).toEqual([first, repeated])
  expect(result.index.unattributedCommits).toEqual([head])
  expect(result.index.contributions[1]!.ticket).toEqual({
    source: 'linear',
    id: 'second',
    title: 'second',
  })
  expect(result.index.contributions[1]!.spec).toEqual({ kind: 'spec', rev: 0 })
  expect(result.specs.get('second')).toBe('Authorize second')
  expect(result.specs.get(BUILD)).toContain('auth rate limiting')
  await store.append(BUILD, {
    actor: KERNEL,
    type: 'spec.revised',
    payload: { escalation: 1, artifact: { kind: 'spec', rev: 1 } },
  })
  expect(
    (
      await collectNodeVerificationProvenance(
        store,
        'acme/app',
        { base, head },
        { exec: spawnExec, workspacePath: workspace },
      )
    ).specs.get(BUILD),
  ).toBe('unsanctioned')
})

for (const [message, diagnostic] of [
  ['Autobuild-Build: missing', 'unknown build'],
  ['Autobuild-Build: bad/slug', 'invalid build identity'],
  [`Autobuild-Build: ${BUILD}\nAutobuild-Build: ${BUILD}`, 'ambiguous build identity'],
  ['Autobuild-Build: foreign', 'different repository'],
] as const)
  test(diagnostic, async () => {
    await source('foreign', 'other/repo')
    const base = await commit('base')
    const head = await commit(`change\n\n${message}`)
    await expect(
      collectNodeVerificationProvenance(
        store,
        'acme/app',
        { base, head },
        { exec: spawnExec, workspacePath: workspace },
      ),
    ).rejects.toThrow(diagnostic)
  })

test('node context materializes allocated paths and removes stale contributions', async () => {
  await source('node', 'acme/app', 'node')
  const base = await commit('base')
  const head = await commit(`change\n\nAutobuild-Build: ${BUILD}`)
  await writeFile(
    join(workspace, 'autobuild.toml'),
    '[tickets]\nsource = "file"\nreadyState = "ready"\n[verify]\nsteps = ["visual"]\n[verify.visual]\nkind = "agent"\nskill = "visual"\n',
  )
  await mkdir(join(workspace, '.ab', 'contributions', BUILD), { recursive: true })
  await writeFile(join(workspace, '.ab', 'contributions', BUILD, 'spec.md'), 'tracked spec')
  await writeFile(join(workspace, '.ab', 'node-verification.json'), 'tracked index')
  await git('add', '.ab')
  await git('add', 'autobuild.toml')
  await git('commit', '-m', 'config')
  await store.append('node', {
    actor: KERNEL,
    type: 'integration.prepared',
    payload: { id: 'cycle-1', parent: base, head, config: 'config' },
  })
  const deps = {
    store,
    env: makeEnv({ build: 'node', phase: 'verify:visual' }),
    workspacePath: workspace,
    exec: spawnExec,
  }
  const manifest = await buildContext(deps)
  const contribution = manifest.nodeVerification!.contributions[0]!
  expect(contribution.specPath).not.toBe(`.ab/contributions/${BUILD}/spec.md`)
  expect(await readFile(join(workspace, '.ab', 'contributions', BUILD, 'spec.md'), 'utf8')).toBe(
    'tracked spec',
  )
  expect(await readFile(join(workspace, contribution.specPath), 'utf8')).toContain(
    'auth rate limiting',
  )
  expect(manifest.materialized[contribution.specPath.slice(4)]).toBe('derived')
  expect(
    JSON.parse(await readFile(join(workspace, manifest.nodeVerification!.indexPath), 'utf8'))
      .commits,
  ).toEqual([{ sha: head, build: BUILD }])
  await store.append('node', {
    actor: KERNEL,
    type: 'integration.prepared',
    payload: { id: 'cycle-2', parent: head, head, config: 'config' },
  })
  expect((await buildContext(deps)).nodeVerification!.contributions).toEqual([])
  expect(await Bun.file(join(workspace, contribution.specPath)).exists()).toBe(false)
})

test('missing specs and rejected reads fail without publishing a partial manifest', async () => {
  await source('node', 'acme/app', 'node')
  const base = await commit('base')
  const head = await commit(`change\n\nAutobuild-Build: ${BUILD}`)
  await store.append('node', {
    actor: KERNEL,
    type: 'integration.prepared',
    payload: { id: 'cycle', parent: base, head, config: 'config' },
  })
  const original = store.getArtifact.bind(store)
  store.getArtifact = async (build, kind, rev) =>
    build === BUILD ? null : original(build, kind, rev)
  const deps = {
    store,
    env: makeEnv({ build: 'node', phase: 'verify:visual' }),
    workspacePath: workspace,
    exec: spawnExec,
  }
  await expect(buildContext(deps)).rejects.toThrow('missing spec@0')
  expect(await Bun.file(join(workspace, '.ab/context.json')).exists()).toBe(false)
  store.getArtifact = async (build, kind, rev) => {
    if (build === BUILD) throw new Error('store unavailable')
    return original(build, kind, rev)
  }
  await expect(buildContext(deps)).rejects.toThrow('store unavailable')
  expect(await Bun.file(join(workspace, '.ab/context.json')).exists()).toBe(false)
})

test('self identity retains own spec, and leaf context has no provenance reads', async () => {
  await source('node', 'acme/app', 'node')
  const base = await commit('base')
  const head = await commit('self\n\nAutobuild-Build: node')
  await writeFile(
    join(workspace, 'autobuild.toml'),
    '[tickets]\nsource = "file"\nreadyState = "ready"\n[verify]\nsteps = ["visual"]\n[verify.visual]\nkind = "agent"\nskill = "visual"\n',
  )
  await store.append('node', {
    actor: KERNEL,
    type: 'integration.prepared',
    payload: { id: 'cycle', parent: base, head, config: 'config' },
  })
  await buildContext({
    store,
    env: makeEnv({ build: 'node', phase: 'verify:visual' }),
    workspacePath: workspace,
    exec: spawnExec,
  })
  expect(await readFile(join(workspace, '.ab/spec.md'), 'utf8')).toBe('Authorize node')
  store.getBuild = async () => {
    throw new Error('unexpected record read')
  }
  const leaf = await buildContext({
    store,
    env: makeEnv({ phase: 'verify:visual' }),
    workspacePath: workspace,
    exec: spawnExec,
  })
  expect(leaf.nodeVerification).toBeUndefined()
  expect(await Bun.file(join(workspace, '.ab/node-verification.json')).exists()).toBe(false)
})
