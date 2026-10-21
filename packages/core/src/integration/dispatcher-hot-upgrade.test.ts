import { expect, test } from 'bun:test'
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareRuntime } from '../cli/dispatch-runtime-cache'
import { releasePreparedRuntime } from '../cli/dispatch-runtime-use'
import { distributionRoot } from '../distribution'
import { spawnExec } from '../ports/workspace/git-worktree'
import { openLocalStore } from '../store/local/store'
import type { RepositoryEvent } from '../events/repository'

test('real launcher sequentially adopts two replacements of the original installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ab-hot-upgrade-'))
  const repo = join(root, 'repo'),
    original = join(root, 'installation')
  await mkdir(repo)
  await mkdir(join(repo, 'tickets/ready'), { recursive: true })
  const seed = await prepareRuntime(distributionRoot(), repo)
  await cp(seed.root, original, { recursive: true, verbatimSymlinks: true })
  releasePreparedRuntime(seed.root)
  const manifest = JSON.parse(await readFile(join(original, 'package.json'), 'utf8'))
  const replace = async (version: string) =>
    writeFile(join(original, 'package.json'), JSON.stringify({ ...manifest, version }))
  await replace('1.0.0')
  const targetFile = join(original, 'packages/core/src/cli/dispatch-upgrade-target.ts')
  await writeFile(targetFile, (await readFile(targetFile, 'utf8')).replace('60_000', '100'))
  await writeFile(join(repo, 'package.json'), '{}')
  await writeFile(
    join(repo, 'autobuild.toml'),
    'forge = "local-git"\n[roles.default]\nruntime = "claude"\n[tickets]\nsource = "file"\ndir = "tickets"\nreadyState = "ready"\n',
  )
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Test'],
    ['config', 'user.email', 'test@example.com'],
    ['add', 'package.json', 'autobuild.toml'],
    ['commit', '-m', 'fixture'],
  ]) {
    const result = await spawnExec(['git', ...args], { cwd: repo })
    if (result.exitCode) throw new Error(result.stderr)
  }
  const storePath = join(repo, '.autobuild/store')
  const store = openLocalStore(storePath)
  await store.ensureRepo(repo)
  const child = Bun.spawn(
    [
      process.execPath,
      join(original, 'bin/ab.ts'),
      'dispatch',
      '--plain',
      '--interval',
      '0.05',
      '--store',
      storePath,
    ],
    {
      cwd: repo,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const stdout = new Response(child.stdout).text(),
    stderr = new Response(child.stderr).text()
  const wait = async (predicate: (events: RepositoryEvent[]) => boolean) => {
    const deadline = Date.now() + 120_000
    for (;;) {
      const events = await store.getRepoEvents(repo)
      if (predicate(events)) return events
      if (child.exitCode !== null) throw new Error(`launcher exited: ${await stderr}`)
      if (Date.now() > deadline)
        throw new Error(
          `handoff timeout: ${JSON.stringify(events.filter((e) => e.type.includes('upgrade') || e.type.includes('handoff')))}`,
        )
      await Bun.sleep(50)
    }
  }
  try {
    await wait((events) => events.some((e) => e.type === 'dispatcher.runtime-recorded'))
    for (const version of ['2.0.0', '3.0.0']) {
      await replace(version)
      const events = await wait((events) =>
        events.some(
          (e) => e.type === 'dispatcher.handoff-completed' && e.payload.to.version === version,
        ),
      )
      const completion = events.findLast((e) => e.type === 'dispatcher.handoff-completed')!
      if (completion.type !== 'dispatcher.handoff-completed') throw new Error('missing completion')
      expect(completion.payload.target).toMatchObject({
        mode: 'installed',
        source: original,
        version,
      })
      const stop = events.find(
        (e) => e.type === 'dispatcher.run-stopped' && e.payload.run === completion.payload.run,
      )!
      const start = events.find(
        (e) =>
          e.type === 'dispatcher.run-started' && e.payload.run === completion.payload.successor,
      )!
      expect(stop.seq).toBeLessThan(start.seq)
      expect((await store.getRepo(repo))!.lease?.holder).toBe(completion.payload.successor)
    }
    child.kill('SIGINT')
    await child.exited
    expect(child.exitCode).toBe(0)
    expect(await stderr).toBe('')
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGINT')
      await child.exited
    }
    await stdout
    await store.close()
    await rm(root, { recursive: true, force: true })
  }
}, 300_000)
