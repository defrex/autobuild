import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  blockerBuild,
  missingChanges,
  observePresence,
  ownedContribution,
  type PresenceBuild,
} from './change-presence'
import type { NodeGit } from './node-restack'
import { MemoryBuildStore } from '../store/memory'
import { DISPATCHER } from '../events/envelope'
import { repositoryReadFactsReducer } from './read-facts'
import { readRepositoryFacts } from '../store/reduced-reads'
import { validateRepositoryEventWrite } from '../events/repository'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const workspacePath = await mkdtemp(join(tmpdir(), 'change-presence-'))
  roots.push(workspacePath)
  const deps: NodeGit = {
    workspacePath,
    exec: async (args, opts) => {
      const p = Bun.spawn(args, { cwd: opts.cwd, stdout: 'pipe', stderr: 'pipe' })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ])
      return { stdout, stderr, exitCode }
    },
  }
  const git = async (...args: string[]) => {
    const result = await deps.exec(['git', ...args], { cwd: workspacePath })
    if (result.exitCode !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  await git('init', '-b', 'main')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.test')
  const commit = async (message: string) => {
    await git('commit', '--allow-empty', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  const base = await commit('initial foreign history')
  return { deps, git, commit, base }
}

test('confirmed trailerless landings prove equality and ancestry, never a sibling', async () => {
  const { deps, git, commit, base } = await fixture()
  const sha = await commit('external merge queue squash without trailer')
  const landing = { slug: 'blocker', sha }
  expect(await observePresence(deps, sha, [landing])).toContain('build:blocker')
  const descendant = await commit('later')
  expect(await observePresence(deps, descendant, [landing])).toContain('build:blocker')
  await git('checkout', '--detach', base)
  const sibling = await commit('other line')
  expect(await observePresence(deps, sibling, [landing])).not.toContain('build:blocker')
  // A late merge fact changes proof even at an unchanged destination head.
  expect(await observePresence(deps, sha, [])).not.toContain('build:blocker')
  expect(await observePresence(deps, sha, [landing])).toContain('build:blocker')
})

test('node squash transports multiple children and foreign identities without inherited history', async () => {
  const { deps, git, commit, base } = await fixture()
  await commit('first\n\nAutobuild-Build: first')
  await commit('second\n\nAutobuild-Build: second')
  const foreign = await commit('owned foreign')
  const contribution = await ownedContribution(deps, base, foreign, [], new Map())
  expect(contribution).toEqual(['build:first', 'build:second', `foreign:${foreign}`])
  await git('checkout', '--detach', base)
  const squash = await commit('node squash without trailer')
  const present = await observePresence(deps, squash, [{ slug: 'node', sha: squash, contribution }])
  expect(missingChanges(contribution, present)).toEqual([])
  expect(await git('merge-base', squash, foreign)).toBe(base)
  expect(await observePresence(deps, squash, [])).not.toContain('build:first')
  expect(await ownedContribution(deps, base, base, [], new Map())).toEqual([])
})

test('rewritten foreign commits retain original identity', async () => {
  const { deps, commit, base } = await fixture()
  const rewritten = await commit('replayed foreign')
  const original = 'a'.repeat(40)
  const identities = await ownedContribution(
    deps,
    base,
    rewritten,
    [],
    new Map([[rewritten, original]]),
  )
  expect(identities).toEqual([`foreign:${original}`])
  expect(await observePresence(deps, rewritten, [], new Map([[rewritten, original]]))).toContain(
    `foreign:${original}`,
  )
})

test('build generations are source scoped, latest wins, ties fail closed', () => {
  const entry = (slug: string, createdAt: string, source = 'file'): PresenceBuild => ({
    record: {
      slug,
      repo: 'repo',
      createdAt,
      updatedAt: createdAt,
      ticket: { source, id: 'BLOCK' },
    },
    digest: { slug, observations: [] },
  })
  const old = entry('old', '2026-01-01')
  const latest = entry('latest', '2026-02-01')
  expect(
    blockerBuild([old, latest, entry('foreign', '2027-01-01', 'other')], 'file', 'BLOCK'),
  ).toBe(latest)
  expect(blockerBuild([old, latest, entry('tied', '2026-02-01')], 'file', 'BLOCK')).toContain(
    'ambiguous',
  )
  expect(blockerBuild([old], 'file', 'missing')).toBeUndefined()
})

test('head-keyed proof is strictly validated and survives a fresh durable reduction', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo('repo')
  const payload = {
    destination: 'root:main',
    branch: 'main',
    head: 'a'.repeat(40),
    evidence: 'merge-revision-1',
    identities: ['build:blocker'],
  }
  await store.appendRepo('repo', { actor: DISPATCHER, type: 'change-presence.observed', payload })
  const fresh = await readRepositoryFacts(store, 'repo')
  expect(fresh.value.presence['root:main']).toEqual(payload)
  expect(repositoryReadFactsReducer.finish(repositoryReadFactsReducer.initial()).presence).toEqual(
    {},
  )
  for (const identities of [['build:z', 'build:a'], ['build:a', 'build:a'], ['untyped']])
    expect(() =>
      validateRepositoryEventWrite({
        actor: DISPATCHER,
        type: 'change-presence.observed',
        payload: { ...payload, identities },
      }),
    ).toThrow()
})
