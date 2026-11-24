import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  capture,
  inspect,
  command,
  procIdentity,
  canonicalRoot,
  type Evidence,
  type LaunchRecord,
  type Status,
} from './dispatcher-check'
import { prepareLaunch } from './dispatcher-start'

const sha = 'a'.repeat(40)
const record: LaunchRecord = {
  version: 1,
  sha,
  dirty: false,
  host: 'local',
  pid: 10,
  ticks: '100',
  boot: '11111111-1111-1111-1111-111111111111',
}
function fixture() {
  const status: Status = {
    dispatcher: {
      state: 'held',
      holder: {
        run: 'run-1',
        pid: 11,
        host: 'local',
        runtime: { version: '1.0', commit: sha, source: { kind: 'source', location: '/cache' } },
      },
    },
  }
  const e: Evidence = {
    status: async () => status,
    host: 'local',
    boot: async () => record.boot,
    identity: async (pid) => ({
      pid,
      parent: pid === 11 ? 10 : 1,
      ticks: pid === 11 ? '110' : '100',
    }),
    records: async () => [record],
    git: async (args) => (args[0] === 'rev-parse' ? sha : ''),
  }
  return { e, status }
}
describe('dispatcher revision evidence', () => {
  test('capture retains original SHA after fixture advances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dispatcher-revision-'))
    try {
      const git = (...args: string[]) => command(root, ['git', ...args])
      await git('init', '-b', 'main')
      await git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'first',
      )
      const original = await git('rev-parse', 'HEAD')
      const saved = await capture(root)
      await git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'second',
      )
      const files = await readdir(join(root, '.autobuild/dispatcher-starts'))
      const persisted = JSON.parse(
        await readFile(join(root, '.autobuild/dispatcher-starts', files[0]!), 'utf8'),
      )
      expect(persisted.sha).toBe(original)
      expect(await canonicalRoot(root)).toBe(root)
      const worktree = join(root, '.autobuild', 'fixture-worktree')
      await git('worktree', 'add', '-b', 'fixture-worktree', worktree)
      expect(await canonicalRoot(worktree)).toBe(root)
      await expect(prepareLaunch(worktree)).rejects.toThrow('canonical repository root on main')
      await git('checkout', '-b', 'other')
      await expect(prepareLaunch(root)).rejects.toThrow('canonical repository root on main')
      await git('checkout', 'main')
      const child = Bun.spawn(['bun', '-e', 'setInterval(() => {}, 1000)'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      try {
        const { e } = fixture()
        e.host = saved.host
        e.boot = async () => saved.boot
        e.records = async () => [persisted]
        e.identity = procIdentity
        e.status = async () => ({
          dispatcher: {
            state: 'held',
            holder: {
              run: 'fixture',
              pid: child.pid,
              host: saved.host,
              runtime: {
                version: '1',
                commit: original,
                source: { kind: 'source', location: '/fixture' },
              },
            },
          },
        })
        e.git = (args) => git(...args)
        expect(await inspect(e)).toContain('dispatcher behind checkout HEAD')
      } finally {
        child.kill()
        await child.exited
      }
      expect(saved.sha).toBe(original)
      expect(saved.sha).not.toBe(await git('rev-parse', 'HEAD'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
