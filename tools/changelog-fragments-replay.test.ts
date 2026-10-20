import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type NodeGit,
  prepareNodeReplay,
  replayNodeChange,
} from '../packages/core/src/kernel/node-restack'
import { renderReleasedChangelog } from './release'
import { collectPendingChangelog } from './changelog-fragments'

const roots: string[] = []
const historical = '## v1.0.0 — 2026-10-01\n\n- Historical entry.\n'
const original = `# Changelog\n\n## Unreleased\n\n- Existing entry.\n\n${historical}`

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(released = false) {
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
  await write('.changelog/1.md', '- [#1](https://example.test/1) — Older entry\n')
  await write('CHANGELOG.md', original)
  await write('ordinary.txt', 'Original line.\n')
  const oldBase = await commit('Common ancestor')
  await git('checkout', '-b', 'source')
  await write('.changelog/3.md', '- [#3](https://example.test/3) — Source entry\n')
  const oldHead = await commit('Source addition')
  await git('checkout', 'main')
  await write('.changelog/2.md', '- [#2](https://example.test/2) — Destination entry\n')
  let destination = original
  if (released) {
    const pending = await collectPendingChangelog(workspacePath, original)
    destination = renderReleasedChangelog(pending.content, 'v1.1.0', '2026-10-19').content
    await write('CHANGELOG.md', destination)
    for (const path of pending.paths) await rm(join(workspacePath, path))
  }
  const parent = await commit('Destination addition')
  const inputs = await prepareNodeReplay(deps, { oldBase, oldHead, parent })
  expect(inputs.changes).toHaveLength(1)
  const result = await replayNodeChange(deps, inputs, 0, parent)
  return {
    workspacePath,
    oldBase,
    destination,
    deps,
    git,
    result,
    changelog: await Bun.file(join(workspacePath, 'CHANGELOG.md')).text(),
  }
}

for (const released of [false, true]) {
  test(`fragment kernel replay onto ${released ? 'released' : 'pending'} destination`, async () => {
    const { workspacePath, destination, git, result, changelog } = await fixture(released)
    expect(result.kind).toBe('replayed')
    expect(await git('ls-files', '-u')).toBe('')
    expect(changelog).toBe(destination)
    expect(changelog).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m)
    expect(await Bun.file(join(workspacePath, '.changelog/3.md')).text()).toBe(
      '- [#3](https://example.test/3) — Source entry\n',
    )
    expect(await Bun.file(join(workspacePath, '.changelog/2.md')).exists()).toBe(!released)
    if (released) expect(changelog).not.toContain('[#3]')
  })
}

test('two independent fragments replay sequentially onto a released destination', async () => {
  const { workspacePath, oldBase, destination, deps, git } = await fixture(true)
  const first = await git('rev-parse', 'HEAD')
  await git('checkout', '-b', 'second', oldBase)
  const entry = '- [#4](url) — Second independent entry\n'
  await Bun.write(join(workspacePath, '.changelog/4.md'), entry)
  await git('add', '.')
  await git('commit', '-m', 'Second independent fragment')
  const oldHead = await git('rev-parse', 'HEAD')
  const inputs = await prepareNodeReplay(deps, { oldBase, oldHead, parent: first })
  expect((await replayNodeChange(deps, inputs, 0, first)).kind).toBe('replayed')
  expect(await git('ls-files', '-u')).toBe('')
  expect(await Bun.file(join(workspacePath, '.changelog/4.md')).text()).toBe(entry)
  expect(await Bun.file(join(workspacePath, '.changelog/3.md')).text()).toContain('[#3]')
  expect(await Bun.file(join(workspacePath, 'CHANGELOG.md')).text()).toBe(destination)
})
