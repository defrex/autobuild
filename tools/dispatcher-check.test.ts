import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  capture,
  command,
  inspect,
  parseStat,
  procIdentity,
  canonicalRoot,
  validRecord,
  type Evidence,
  type LaunchRecord,
  type Status,
} from './dispatcher-check'
import { launch, prepareLaunch } from './dispatcher-start'

const sha = 'a'.repeat(40)
const head = 'b'.repeat(40)
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
    dispatcher: { state: 'held', holder: { run: 'run-1', pid: 11, host: 'local' } },
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
  test('correlates interactive child and displays both revisions', async () => {
    const { e } = fixture()
    const output = await inspect(e)
    expect(output).toContain(`Dispatcher starting SHA: ${sha}\nCheckout HEAD: ${sha}`)
    expect(output).toContain('Comparison: equal')
  })
  test('direct holder', async () => {
    const { e, status } = fixture()
    status.dispatcher.holder!.pid = 10
    expect(await inspect(e)).toContain('Comparison: equal')
  })
  test.each(['behind', 'divergent'])('%s history', async (relation) => {
    const { e } = fixture()
    e.git = async (args) => {
      if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? head : sha
      if (args[0] === 'merge-base' && relation === 'divergent') throw new Error('not ancestor')
      return ''
    }
    const output = await inspect(e)
    expect(output).toContain(relation === 'behind' ? 'dispatcher behind' : 'divergent history')
    expect(output).toContain('differs from checkout HEAD')
    expect(output).toContain(`git diff --name-only ${sha} ${head}`)
  })
  test.each([
    'dirty',
    'missing',
    'malformed',
    'foreign',
    'reuse',
    'boot',
    'disappeared',
    'object',
    'changed',
  ])('%s evidence stays unknown', async (reason) => {
    const { e, status } = fixture()
    if (reason === 'dirty') e.records = async () => [{ ...record, dirty: true }]
    if (reason === 'missing') e.records = async () => []
    if (reason === 'malformed') e.records = async () => [{ ...record, sha: 'invalid' }]
    if (reason === 'foreign') status.dispatcher.holder!.host = 'remote'
    if (reason === 'reuse') e.identity = async (pid) => ({ pid, parent: 0, ticks: '999' })
    if (reason === 'boot') e.boot = async () => 'other boot'
    if (reason === 'disappeared')
      e.identity = async () => {
        throw new Error('gone')
      }
    if (reason === 'object')
      e.git = async (args) => {
        if (args[0] === 'cat-file') throw new Error('missing object')
        return sha
      }
    if (reason === 'changed') {
      let reads = 0
      e.status = async () =>
        ++reads === 1
          ? status
          : {
              dispatcher: { state: 'held', holder: { ...status.dispatcher.holder!, run: 'run-2' } },
            }
    }
    const output = await inspect(e)
    expect(output).toContain('Comparison: unknown')
    expect(output).not.toContain('Comparison: equal')
    if (reason === 'dirty') expect(output).toContain('captured base only')
  })
  test.each(['absent', 'lost', 'stopped'])('%s holder', async (state) => {
    const { e, status } = fixture()
    status.dispatcher = { state, holder: null }
    expect(await inspect(e)).toContain('Comparison: unknown')
  })
  test.each(['identity', 'checkout'])('%s changes during collection', async (kind) => {
    const { e } = fixture()
    let reads = 0
    if (kind === 'identity')
      e.identity = async (pid) => ({
        pid,
        parent: pid === 11 ? 10 : 1,
        ticks: ++reads > 2 ? '999' : pid === 11 ? '110' : '100',
      })
    else e.git = async (args) => (args[0] === 'rev-parse' && ++reads > 2 ? head : sha)
    expect(await inspect(e)).toContain('Comparison: unknown')
  })
  test('launcher never loads dispatch after failed preparation', async () => {
    let loaded = false
    await expect(
      launch(
        [],
        async () => {
          throw new Error('capture failed')
        },
        async () => {
          loaded = true
          return async () => 0
        },
      ),
    ).rejects.toThrow('capture failed')
    expect(loaded).toBe(false)
  })
  test('status failure is visible', async () => {
    const { e } = fixture()
    e.status = async () => {
      throw new Error('status failed')
    }
    await expect(inspect(e)).rejects.toThrow('status failed')
  })
  test('validates records and proc stat including spaces in process name', () => {
    expect(validRecord(record)).toBe(true)
    expect(validRecord(null)).toBe(false)
    expect(parseStat(10, `10 (a name) S 1 ${Array(17).fill('0').join(' ')} 123`)).toEqual({
      pid: 10,
      parent: 1,
      ticks: '123',
    })
  })
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
            holder: { run: 'fixture', pid: child.pid, host: saved.host },
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
  test('launcher prepares before loading and preserves arguments and exit code', async () => {
    const calls: string[] = []
    const code = await launch(
      ['--plain', '--once'],
      async () => {
        calls.push('prepare')
      },
      async () => {
        calls.push('load')
        return async (args) => {
          expect(args).toEqual(['dispatch', '--plain', '--once'])
          return 7
        }
      },
    )
    expect(calls).toEqual(['prepare', 'load'])
    expect(code).toBe(7)
  })
})
