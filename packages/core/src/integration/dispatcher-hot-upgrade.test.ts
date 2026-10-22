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
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
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
      const failure = events.findLast((e) => e.type === 'dispatcher.upgrade-failed')
      if (failure?.type === 'dispatcher.upgrade-failed') throw new Error(failure.payload.reason)
      if (predicate(events)) return events
      if (child.exitCode !== null) throw new Error(`launcher exited: ${await stderr}`)
      if (Date.now() > deadline)
        throw new Error(
          `handoff timeout: ${JSON.stringify(events.filter((e) => e.type.includes('upgrade') || e.type.includes('handoff')).slice(-8))}`,
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

test('real source launcher observes excluded commits and sequentially adopts same-version source changes', async () => {
  const { sourceCommand } = await import('../cli/dispatch-upgrade-source')
  const { projectRepositoryStatus, renderRepositoryStatus } = await import(
    '../cli/repository-status'
  )
  const root = await mkdtemp(join(tmpdir(), 'ab-source-upgrade-'))
  const repo = join(root, 'repo'),
    editor = join(root, 'editor')
  await mkdir(repo)
  const seed = await prepareRuntime(distributionRoot(), repo)
  await cp(seed.root, repo, { recursive: true, verbatimSymlinks: true })
  releasePreparedRuntime(seed.root)
  const sourceManifest = JSON.parse(
    await readFile(join(distributionRoot(), 'package.json'), 'utf8'),
  )
  sourceManifest.dependencies.semver = '^7.7.1'
  await writeFile(join(repo, 'package.json'), JSON.stringify(sourceManifest))
  await cp(join(distributionRoot(), 'bun.lock'), join(repo, 'bun.lock'))
  const lock = Bun.JSONC.parse(await readFile(join(repo, 'bun.lock'), 'utf8')) as {
    workspaces: Record<string, { dependencies?: Record<string, string> }>
  }
  lock.workspaces['']!.dependencies!.semver = '^7.7.1'
  await writeFile(join(repo, 'bun.lock'), JSON.stringify(lock))
  for (const path of Object.keys(lock.workspaces)) {
    if (!path) continue
    await mkdir(join(repo, path), { recursive: true })
    await cp(join(distributionRoot(), path, 'package.json'), join(repo, path, 'package.json'))
  }
  await writeFile(join(repo, '.gitignore'), 'node_modules\n.autobuild\n.ab\n')
  await mkdir(join(repo, 'tickets/ready'), { recursive: true })
  await writeFile(
    join(repo, 'autobuild.toml'),
    'forge = "local-git"\n[roles.default]\nruntime = "claude"\n[tickets]\nsource = "file"\ndir = "tickets"\nreadyState = "ready"\n',
  )
  const targetFile = join(repo, 'packages/core/src/cli/dispatch-upgrade-target.ts')
  await writeFile(targetFile, (await readFile(targetFile, 'utf8')).replace('60_000', '200'))
  const git = (...args: string[]) => sourceCommand(['git', ...args], repo)
  await git('init', '-b', 'main')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.com')
  await git('add', '.')
  await git('commit', '-m', 'source fixture')
  const initial = (await git('rev-parse', 'HEAD')).trim()
  await git('checkout', '-b', 'operator')
  await git('worktree', 'add', '-b', 'editor', editor)
  const editGit = (...args: string[]) => sourceCommand(['git', ...args], editor)
  const advance = async (path: string, bytes: string) => {
    await writeFile(join(editor, path), bytes)
    await editGit('add', path)
    await editGit('commit', '-m', 'advance')
    const sha = (await editGit('rev-parse', 'HEAD')).trim()
    await git('update-ref', 'refs/heads/main', sha)
    return sha
  }
  const statusBefore = await git('status', '--porcelain')
  const indexBefore = await git('write-tree')
  await writeFile(join(repo, 'untracked-sentinel'), 'operator bytes')
  await writeFile(join(editor, 'untracked-sentinel'), 'build bytes')
  const dependency = join(repo, 'node_modules/semver/package.json')
  const dependencyBefore = await readFile(dependency, 'utf8')
  const storePath = join(repo, '.autobuild/store'),
    store = openLocalStore(storePath)
  await store.ensureRepo(repo)
  const child = Bun.spawn(
    [
      process.execPath,
      join(repo, 'bin/ab.ts'),
      'dispatch',
      '--plain',
      '--interval',
      '0.05',
      '--store',
      storePath,
    ],
    {
      cwd: repo,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
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
      const failure = events.findLast((e) => e.type === 'dispatcher.upgrade-failed')
      if (failure?.type === 'dispatcher.upgrade-failed') throw new Error(failure.payload.reason)
      if (predicate(events)) return events
      if (child.exitCode !== null) throw new Error(`source launcher exited: ${await stderr}`)
      if (Date.now() > deadline)
        throw new Error(
          `source timeout: ${JSON.stringify(events.filter((e) => e.type.includes('upgrade') || e.type.includes('handoff')).slice(-8))}`,
        )
      await Bun.sleep(50)
    }
  }
  const resolved = (sha: string) =>
    wait((events) =>
      events.some(
        (e) => e.type === 'dispatcher.upgrade-target-resolved' && e.payload.target.sha === sha,
      ),
    )
  const complete = (sha: string) =>
    wait((events) =>
      events.some((e) => e.type === 'dispatcher.handoff-completed' && e.payload.target.sha === sha),
    )
  try {
    let events = await resolved(initial)
    expect(events.some((e) => e.type === 'dispatcher.upgrade-detected')).toBe(false)
    expect(renderRepositoryStatus(projectRepositoryStatus(repo, events)).join('\n')).toContain(
      `at ${initial}`,
    )
    const excluded = await advance('outside-distribution', 'excluded commit')
    events = await resolved(excluded)
    expect(JSON.stringify(projectRepositoryStatus(repo, events).upgrades)).toContain(excluded)
    expect(events.some((e) => e.type === 'dispatcher.upgrade-detected')).toBe(false)
    // A dev-only workspace can change declarations and lock records without
    // changing the packaged root or its production graph.
    const websiteManifest = join(editor, 'packages/website/package.json')
    const website = JSON.parse(await readFile(websiteManifest, 'utf8'))
    website.dependencies = { 'is-number': '7.0.0' }
    await writeFile(websiteManifest, JSON.stringify(website))
    await sourceCommand(
      [process.execPath, 'install', '--lockfile-only', '--ignore-scripts'],
      editor,
    )
    await editGit('add', 'packages/website/package.json', 'bun.lock')
    await editGit('commit', '-m', 'unrelated workspace lock change')
    const workspaceSha = (await editGit('rev-parse', 'HEAD')).trim()
    await git('update-ref', 'refs/heads/main', workspaceSha)
    events = await resolved(workspaceSha)
    expect(events.some((e) => e.type === 'dispatcher.upgrade-detected')).toBe(false)
    const resolutions = events.filter((e) => e.type === 'dispatcher.upgrade-target-resolved').length
    await Bun.sleep(600)
    expect(
      (await store.getRepoEvents(repo)).filter(
        (e) => e.type === 'dispatcher.upgrade-target-resolved',
      ),
    ).toHaveLength(resolutions)

    // Change only the root's reachable resolution, retaining its declared range.
    await sourceCommand(
      [process.execPath, 'add', 'semver@7.7.3', '--lockfile-only', '--ignore-scripts'],
      editor,
    )
    await writeFile(join(editor, 'package.json'), JSON.stringify(sourceManifest))
    await sourceCommand(
      [process.execPath, 'install', '--lockfile-only', '--ignore-scripts'],
      editor,
    )
    await editGit('add', 'bun.lock')
    await editGit('commit', '-m', 'production lock change')
    const productionSha = (await editGit('rev-parse', 'HEAD')).trim()
    await git('update-ref', 'refs/heads/main', productionSha)
    await complete(productionSha)

    const packagedPath = 'packages/core/src/cli/dispatch-upgrade-target.ts'
    const bytes = await readFile(join(editor, packagedPath), 'utf8')
    for (let i = 1; i <= 2; i++) {
      const sha = await advance(packagedPath, `${bytes}\n// packaged source advance ${i}\n`)
      events = await complete(sha)
      const completion = events.findLast((e) => e.type === 'dispatcher.handoff-completed')!
      if (completion.type !== 'dispatcher.handoff-completed') throw new Error('no completion')
      expect(completion.payload.to.commit).toBe(sha)
      expect(completion.payload.to.version).toBe(sourceManifest.version)
      expect(completion.payload.root).toContain('/.autobuild/runtime/')
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
    const latest = events.findLast((e) => e.type === 'dispatcher.handoff-completed')!
    if (latest.type !== 'dispatcher.handoff-completed') throw new Error('no final source runtime')
    const cachedFile = join(latest.payload.root, packagedPath)
    const cachedBytes = await readFile(cachedFile, 'utf8')
    await writeFile(
      targetFile,
      `${await readFile(targetFile, 'utf8')}\n// operator edits after startup\n`,
    )
    await Bun.sleep(600)
    expect(await readFile(cachedFile, 'utf8')).toBe(cachedBytes)
    const beforeDisable = (await store.getRepoEvents(repo)).at(-1)!.seq
    const configFile = join(repo, 'autobuild.toml')
    await writeFile(
      configFile,
      `${await readFile(configFile, 'utf8')}\n[upgrade]\nautomatic = false\n`,
    )
    await wait((events) =>
      events.some(
        (e) =>
          e.seq > beforeDisable &&
          e.type === 'dispatcher.config-reloaded' &&
          e.payload.effectiveChanged,
      ),
    )
    const disabledSha = await advance(packagedPath, `${bytes}\n// disabled source advance\n`)
    await Bun.sleep(600)
    const disabledEvents = await store.getRepoEvents(repo)
    expect(
      disabledEvents.some(
        (e) =>
          e.type === 'dispatcher.upgrade-target-resolved' && e.payload.target.sha === disabledSha,
      ),
    ).toBe(false)
    expect(disabledEvents.filter((e) => e.type === 'dispatcher.handoff-started')).toHaveLength(3)
    expect(await readFile(dependency, 'utf8')).toBe(dependencyBefore)
    expect(await readFile(targetFile, 'utf8')).not.toContain('packaged source advance')
    expect(await readFile(join(editor, 'outside-distribution'), 'utf8')).toBe('excluded commit')
    expect(statusBefore).toBe('')
    expect(await git('write-tree')).toBe(indexBefore)
    expect((await git('rev-parse', 'HEAD')).trim()).toBe(initial)
    expect((await editGit('rev-parse', 'HEAD')).trim()).toBe(disabledSha)
    expect(await readFile(join(repo, 'untracked-sentinel'), 'utf8')).toBe('operator bytes')
    expect(await readFile(join(editor, 'untracked-sentinel'), 'utf8')).toBe('build bytes')
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
