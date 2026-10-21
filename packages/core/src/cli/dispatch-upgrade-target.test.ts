import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnExec } from '../ports/workspace/git-worktree'
import { resolveUpgradeTarget } from './dispatch-upgrade-target'
import type { Forge } from '../ports/types'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ab-upgrade-target-'))
  roots.push(root)
  const repo = join(root, 'repo'),
    remote = join(root, 'remote.git'),
    install = join(root, 'install')
  await mkdir(repo)
  await mkdir(install)
  await writeFile(
    join(install, 'package.json'),
    JSON.stringify({ name: '@defrex/autobuild', version: '1.0.0', bin: 'bin/ab.ts' }),
  )
  const git = async (...args: string[]) => {
    const r = await spawnExec(['git', ...args], { cwd: repo })
    if (r.exitCode) throw new Error(r.stderr)
    return r.stdout.trim()
  }
  await git('init', '-b', 'main')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.com')
  await git('init', '--bare', remote)
  await git('remote', 'add', 'origin', remote)
  const pin = async (version: string) => {
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ devDependencies: { '@defrex/autobuild': version } }),
    )
    await writeFile(
      join(repo, 'bun.lock'),
      JSON.stringify({
        lockfileVersion: 1,
        workspaces: { '': { devDependencies: { '@defrex/autobuild': version } } },
        packages: { '@defrex/autobuild': [`@defrex/autobuild@${version}`, '', {}, 'sha512-test'] },
      }),
    )
    await git('add', 'package.json', 'bun.lock')
    await git('commit', '-m', version)
  }
  const input = {
    checkout: repo,
    base: 'main',
    originalInstall: install,
    exec: spawnExec,
    forge: { kernelExec: spawnExec } as Forge,
  }
  return { root, repo, install, git, pin, input }
}
test('remote base wins over feature branch, working tree and stale local main/tracking refs', async () => {
  const h = await fixture()
  await h.pin('1.0.0')
  await h.git('push', 'origin', 'main')
  const initial = await resolveUpgradeTarget(h.input)
  await h.git('checkout', '-b', 'feature')
  await h.pin('2.0.0')
  await h.git('push', 'origin', 'feature')
  await writeFile(join(h.repo, 'package.json'), '{"devDependencies":{"@defrex/autobuild":"3.0.0"}}')
  expect((await resolveUpgradeTarget(h.input)).version).toBe('1.0.0')
  await h.git('push', 'origin', 'feature:main')
  const target = await resolveUpgradeTarget(h.input)
  expect(target.version).toBe('2.0.0')
  expect(target.sha).not.toBe(initial.sha!)
  expect(await h.git('rev-parse', 'main')).toBe(initial.sha!)
  await h.git('update-ref', 'refs/remotes/origin/main', initial.sha!)
  expect((await resolveUpgradeTarget(h.input)).version).toBe('2.0.0')
})
test('manifest/lock disagreement refuses pinned resolution; absence alone permits installed mode', async () => {
  const h = await fixture()
  await h.pin('1.0.0')
  await h.git('push', 'origin', 'main')
  await h.git('rm', 'bun.lock')
  await h.git('commit', '-m', 'missing lock')
  await h.git('push', 'origin', 'main')
  await expect(resolveUpgradeTarget(h.input)).rejects.toThrow('authoritative bun.lock')
  await writeFile(join(h.repo, 'package.json'), '{}')
  await h.git('add', 'package.json')
  await h.git('commit', '-m', 'unpin')
  await h.git('push', 'origin', 'main')
  const first = await resolveUpgradeTarget(h.input)
  expect(first.mode).toBe('installed')
  expect(first.version).toBe('1.0.0')
  await writeFile(
    join(h.install, 'package.json'),
    '{"name":"@defrex/autobuild","version":"2.0.0","bin":"bin/ab.ts"}',
  )
  const next = await resolveUpgradeTarget(h.input)
  expect(next.version).toBe('2.0.0')
  expect(next.key).not.toBe(first.key)
})
test('unrelated base advances retain a failed target identity; corrected metadata changes it', async () => {
  const h = await fixture()
  await h.pin('1.0.0')
  await h.git('push', 'origin', 'main')
  const first = await resolveUpgradeTarget(h.input)
  await writeFile(join(h.repo, 'other'), 'x')
  await h.git('add', 'other')
  await h.git('commit', '-m', 'unrelated')
  await h.git('push', 'origin', 'main')
  expect((await resolveUpgradeTarget(h.input)).key).toBe(first.key)
  await h.pin('0.9.0')
  await h.git('push', 'origin', 'main')
  expect((await resolveUpgradeTarget(h.input)).version).toBe('0.9.0')
})

test('existing Bun forge lock records with abbreviated commits remain supported', async () => {
  const h = await fixture()
  await h.pin('1.0.0')
  const dependency = 'github:fork-owner/repo-name#main'
  const record = [
    '@defrex/autobuild@github:fork-owner/repo-name#a1b2c3d',
    {},
    'fork-owner-repo-name-a1b2c3d',
  ]
  await writeFile(
    join(h.repo, 'package.json'),
    JSON.stringify({ devDependencies: { '@defrex/autobuild': dependency } }),
  )
  await writeFile(
    join(h.repo, 'bun.lock'),
    JSON.stringify({
      lockfileVersion: 1,
      workspaces: { '': { devDependencies: { '@defrex/autobuild': dependency } } },
      packages: { '@defrex/autobuild': record },
    }),
  )
  await h.git('add', 'package.json', 'bun.lock')
  await h.git('commit', '-m', 'forge pin')
  await h.git('push', 'origin', 'main')
  const target = await resolveUpgradeTarget(h.input)
  expect(target.mode).toBe('pinned')
  expect(target.record).toEqual(record)
})
