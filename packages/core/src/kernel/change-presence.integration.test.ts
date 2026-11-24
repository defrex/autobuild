import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  presenceWitness,
  projectPresence,
  compactProbe,
  projectProbe,
  probeEvidence,
  missingChanges,
  observePresence,
  ownedContribution,
  type LandingEvidence,
} from './change-presence'
import type { NodeGit } from './node-restack'

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

test('confirmed trailerless merges prove equality and ancestry, never a sibling', async () => {
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

test('rewritten node trailers recursively transport leaf contributions into presence and ownership', async () => {
  const { deps, git, commit, base } = await fixture()
  const original = await commit('original node merge\n\nAutobuild-Build: node-beta')
  await git('checkout', '--detach', base)
  const parent = await commit('unrelated root movement')
  const rewritten = await commit('replayed node merge\n\nAutobuild-Build: node-beta')
  const landings = [
    { slug: 'node-beta', sha: original, contribution: ['build:node-inner' as const] },
    {
      slug: 'node-inner',
      sha: 'a'.repeat(40),
      contribution: ['build:leaf-one' as const, 'build:leaf-two' as const],
    },
  ]
  expect((await git('rev-list', rewritten)).split('\n')).not.toContain(original)
  for (const identities of [
    await observePresence(deps, rewritten, landings),
    await ownedContribution(deps, parent, rewritten, landings, new Map()),
  ]) {
    expect(identities).toContain('build:leaf-one')
    expect(identities).toContain('build:leaf-two')
  }
})

test('a rewritten trailerless merge resolves its build through the confirmed foreign alias', async () => {
  const { deps, git, commit, base } = await fixture()
  const original = await commit('trailerless work merge')
  await git('checkout', '--detach', base)
  const parent = await commit('root moved')
  const rewritten = await commit('trailerless work replay')
  const aliases = new Map([[rewritten, original]])
  const landings = [{ slug: 'leaf', sha: original }]
  expect(await observePresence(deps, rewritten, landings, aliases)).toContain('build:leaf')
  expect(await ownedContribution(deps, parent, rewritten, landings, aliases)).toContain(
    'build:leaf',
  )
  expect(await observePresence(deps, rewritten, landings)).not.toContain('build:leaf')
})

test('immutable witnesses reproject late, nested and withdrawn facts without Git', async () => {
  const { deps, commit, base } = await fixture()
  const head = await commit('direct identity\n\nAutobuild-Build: direct')
  const witness = await presenceWitness(deps, head)
  expect(witness.commits).toEqual([base, head].sort())
  expect(witness.identities).toEqual(['build:direct'])
  const original = 'a'.repeat(40)
  const aliases = new Map([[head, original]])
  const landings = [
    { slug: 'outer', sha: original, contribution: ['build:inner' as const] },
    { slug: 'inner', sha: 'b'.repeat(40), contribution: ['build:leaf' as const] },
  ]
  for (const includeForeign of [false, true])
    expect(projectPresence(witness, landings, aliases, includeForeign)).toEqual(
      await observePresence(deps, head, landings, aliases, includeForeign),
    )
  const before = projectPresence(witness, [])
  const pendingNested = projectPresence(witness, [landings[0]!], aliases)
  expect(pendingNested).toContain('build:inner')
  expect(pendingNested).not.toContain('build:leaf')
  const after = projectPresence(witness, landings, aliases)
  expect(after).toContain('build:leaf')
  expect(projectPresence(witness, landings)).not.toContain('build:leaf')
  expect(projectPresence(witness, [], aliases)).not.toContain('build:leaf')
  expect(projectPresence(witness, [{ slug: 'empty', sha: head, contribution: [] }])).toEqual(before)
  const questions = ['build:direct', 'build:leaf'] as const
  const answer = (facts: LandingEvidence[], factAliases = aliases) => {
    const probe = compactProbe(witness, questions, facts, factAliases)
    const identities = projectProbe(probe, facts, factAliases)
    return { probe, identities, evidence: probeEvidence(probe, identities) }
  }
  const compactBefore = answer([], new Map())
  const compactAfter = answer(landings)
  expect(compactBefore.identities).toEqual(['build:direct'])
  expect(compactAfter.identities).toEqual(['build:direct', 'build:leaf'])
  expect(compactAfter.probe.commits).toEqual([original, 'b'.repeat(40), head].sort())
  expect(compactBefore.evidence).toMatch(/^presence-v4:[a-f0-9]{64}$/)
  expect(compactAfter.evidence).not.toBe(compactBefore.evidence)
  expect(answer([...landings].reverse()).evidence).toBe(compactAfter.evidence)
  expect(answer([landings[0]!]).identities).toEqual(['build:direct'])
  expect(() =>
    projectPresence(
      witness,
      [],
      new Map([
        [head, original],
        [original, head],
      ]),
    ),
  ).toThrow('cyclic')
  for (const count of [10, 1000]) {
    const unrelated = Array.from({ length: count }, (_, i) => ({
      slug: `unrelated-${i}`,
      sha: (i + 100).toString(16).padStart(40, '0'),
    }))
    expect(projectPresence(witness, unrelated)).toEqual(before)
    const grown = answer([...landings, ...unrelated])
    expect(grown.evidence).toBe(compactAfter.evidence)
    expect(JSON.stringify(grown.probe)).toBe(JSON.stringify(compactAfter.probe))
  }
})
