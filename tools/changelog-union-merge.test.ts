import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type NodeGit,
  prepareNodeReplay,
  replayNodeChange,
} from '../packages/core/src/kernel/node-restack'
import { repoRoot } from './git-tracked'
import { renderReleasedChangelog } from './release'

const roots: string[] = []
const historical = '## v1.0.0 — 2026-10-01\n\n- Historical entry.\n'
const original = `# Changelog\n\n## Unreleased\n\n- Existing entry.\n\n${historical}`
const sourceEntry = '- Source addition.'
const destinationEntry = '- Destination addition.'

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture({ policy = true, ordinaryConflict = false } = {}) {
  const workspacePath = await mkdtemp(join(tmpdir(), 'changelog-union-'))
  roots.push(workspacePath)
  const deps: NodeGit = {
    workspacePath,
    exec: async (args, options) => {
      const process = Bun.spawn(args, { cwd: options.cwd, stdout: 'pipe', stderr: 'pipe' })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ])
      return { stdout, stderr, exitCode }
    },
  }
  const git = async (...args: string[]) => {
    const result = await deps.exec(['git', ...args], { cwd: workspacePath })
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
    return result.stdout.trim()
  }
  const write = (path: string, contents: string) => Bun.write(join(workspacePath, path), contents)
  const commit = async (message: string) => {
    await git('add', '.')
    await git('commit', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  await git('init', '-b', 'main')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.test')
  await git('config', 'commit.gpgsign', 'false')
  if (policy) await write('.gitattributes', await Bun.file(join(repoRoot, '.gitattributes')).text())
  await write('CHANGELOG.md', original)
  await write('ordinary.txt', 'Original line.\n')
  const oldBase = await commit('Common ancestor')
  await git('checkout', '-b', 'source')
  await write(
    'CHANGELOG.md',
    original.replace('## Unreleased\n', `## Unreleased\n\n${sourceEntry}`),
  )
  if (ordinaryConflict) await write('ordinary.txt', 'Source replacement.\n')
  const oldHead = await commit('Source addition')
  await git('checkout', 'main')
  await write(
    'CHANGELOG.md',
    original.replace('## Unreleased\n', `## Unreleased\n\n${destinationEntry}`),
  )
  if (ordinaryConflict) await write('ordinary.txt', 'Destination replacement.\n')
  const parent = await commit('Destination addition')
  const inputs = await prepareNodeReplay(deps, { oldBase, oldHead, parent })
  expect(inputs.changes).toHaveLength(1)
  const result = await replayNodeChange(deps, inputs, 0, parent)
  return { git, result, changelog: await Bun.file(join(workspacePath, 'CHANGELOG.md')).text() }
}

function expectEntries(section: string) {
  for (const entry of [sourceEntry, destinationEntry, '- Existing entry.']) {
    expect(section.split(entry)).toHaveLength(2)
  }
}

test('repository union policy preserves concurrent additions through kernel replay and stable release', async () => {
  const { git, result, changelog } = await fixture()
  expect(result.kind).toBe('replayed')
  expect(await git('ls-files', '-u')).toBe('')
  expect(
    await git('check-attr', 'merge', '--', 'CHANGELOG.md', 'ordinary.txt', 'nested/CHANGELOG.md'),
  ).toBe(
    'CHANGELOG.md: merge: union\nordinary.txt: merge: unspecified\nnested/CHANGELOG.md: merge: unspecified',
  )
  expectEntries(changelog.split(historical)[0]!)
  expect(changelog.endsWith(historical)).toBe(true)
  expect(changelog).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m)

  const { content: released } = renderReleasedChangelog(changelog, 'v1.1.0', '2026-10-19')
  expect(released.match(/^## Unreleased$/gm)).toHaveLength(1)
  expect(released).toMatch(/## Unreleased\n\n## v1\.1\.0/)
  const stableSection = released.split('## v1.1.0')[1]!.split(historical)[0]!
  expectEntries(stableSection)
  expect(released.endsWith(historical)).toBe(true)
})

test('ordinary file conflicts still surface while changelog additions merge', async () => {
  const { git, result, changelog } = await fixture({ ordinaryConflict: true })
  expect(result.kind).toBe('conflict')
  expect(await git('diff', '--name-only', '--diff-filter=U')).toBe('ordinary.txt')
  const unmerged = await git('ls-files', '-u')
  expect(unmerged).toContain('\tordinary.txt')
  expect(unmerged).not.toContain('\tCHANGELOG.md')
  expectEntries(changelog)
  expect(changelog).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m)
})

test('identical concurrent insertion fixture conflicts without the repository policy', async () => {
  const { git, result } = await fixture({ policy: false })
  expect(result.kind).toBe('conflict')
  expect(await git('diff', '--name-only', '--diff-filter=U')).toBe('CHANGELOG.md')
})
