import { temporaryDirectories as ownTempDirectories } from '../testing/temp-directories'
import { afterAll, expect, test } from 'bun:test'
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareRuntime } from '../cli/dispatch-runtime-cache'
import { releasePreparedRuntime } from '../cli/dispatch-runtime-use'
import { distributionRoot } from '../distribution'
import { spawnExec } from '../ports/workspace/git-worktree'
import { openLocalStore } from '../store/local/store'
import type { RepositoryEvent } from '../events/repository'

const mkdtempForFile = ownTempDirectories(afterAll)

let seed: Promise<{ root: string; layers: string }> | undefined
/** Prepares the unmodified distribution once per file and copies it into
 * `destination`, plus the dependency layer into `repo`'s runtime cache so the
 * launcher's own preparation reuses it, as a per-test preparation would. */
async function seedInstallation(repo: string, destination: string): Promise<void> {
  seed ??= (async () => {
    const checkout = join(await mkdtempForFile(join(tmpdir(), 'ab-hot-upgrade-seed-')), 'checkout')
    await mkdir(checkout)
    const prepared = await prepareRuntime(distributionRoot(), checkout)
    releasePreparedRuntime(prepared.root)
    return { root: prepared.root, layers: join(checkout, '.autobuild/runtime/layers') }
  })()
  const { root, layers } = await seed
  await cp(root, destination, { recursive: true, verbatimSymlinks: true })
  await cp(layers, join(repo, '.autobuild/runtime/layers'), {
    recursive: true,
    verbatimSymlinks: true,
  })
}

/** Real 60 s leases make a crashed successor's authority outlive it, so the
 * restored generation waits for expiry before it can tick or re-attach. The
 * rollback fixtures shorten that clock: the repository dispatch lease through
 * `FIXTURE_REPO_LEASE_POLICY` in their autobuild.toml, and the execution and
 * provisioning leases in their copied installation (each heartbeat at most a
 * fifth of its TTL); rollback still waits for and recovers from real expiry.
 * A renamed constant fails here instead of silently testing the 60 s clock
 * again. */
const FIXTURE_REPO_LEASE_POLICY =
  '[policy]\ndispatchLeaseTimeoutSeconds=15\ndispatchLeaseRenewalSeconds=3\n'
const FIXTURE_LEASES: [file: string, from: string, to: string][] = [
  [
    'packages/core/src/ports/workspace/build-execution.ts',
    'BUILD_EXECUTION_LEASE_TTL_MS = 60_000',
    'BUILD_EXECUTION_LEASE_TTL_MS = 15_000',
  ],
  [
    'packages/core/src/processes/build-runner.ts',
    'opts?.heartbeatMs ?? 15_000',
    'opts?.heartbeatMs ?? 3_000',
  ],
  [
    'packages/core/src/processes/dispatcher.ts',
    'PROVISION_HEARTBEAT_MS = 15_000',
    'PROVISION_HEARTBEAT_MS = 3_000',
  ],
]

async function shortenFixtureLeases(installation: string): Promise<void> {
  for (const [file, from, to] of FIXTURE_LEASES) {
    const path = join(installation, file)
    const text = await readFile(path, 'utf8')
    if (!text.includes(from)) throw new Error(`missing fixture lease constant: ${from}`)
    await writeFile(path, text.replace(from, to))
  }
}

/** Each settled upgrade-target check appends its run id to `log`. Checks run
 * strictly one after another (the next is scheduled from the previous one's
 * settlement), so N new lines prove N checks settled, and every line after the
 * first began after the reader looked. */
async function recordTargetChecks(installation: string, log: string): Promise<void> {
  const path = join(installation, 'packages/core/src/cli/dispatch-upgrade-controller.ts')
  const from = '      this.pending = this.check()\n'
  const text = await readFile(path, 'utf8')
  if (!text.includes(from)) throw new Error('missing upgrade check anchor')
  await writeFile(
    path,
    text.replace(
      from,
      `      this.pending = this.check().finally(() => require('node:fs').appendFileSync(${JSON.stringify(log)}, this.input.run + '\\n'))\n`,
    ),
  )
}

/** Each wait polls a durable signal (a repository event, repository tick state,
 * a settled upgrade check or child exit) and gives up after this long. Unloaded,
 * the longest single step is a runtime preparation (11–16 s) or a 15 s fixture
 * lease expiry. Under verify load (4 vCPU, integration alongside build) the same
 * children ran 2–4x slower (AUT-1167: 89.7 s vs 45 s alone; AUT-1027: >240 s vs
 * ~75 s), and two concurrent lanes add ~1.5x. 120 s is ~7x the longest unloaded
 * step, so the deadline is reached only when a signal never arrives. */
const SIGNAL_DEADLINE_MS = 120_000
/** A whole case, from lane acquisition. The worst unloaded case under two lanes
 * took ~160 s. Waits stop at least CLEANUP_GRACE_MS before this, so a stalled
 * case reports its own diagnostic rather than Bun's bare timeout. */
const CASE_BUDGET_MS = 600_000
const CLEANUP_GRACE_MS = 20_000
/** Two lanes: 537 s serial vs 369 s concurrent on a 4-vCPU sandbox, at ~2.3
 * cores. More lanes would crowd the build and unit steps sharing the sandbox. */
const LANES = 2
/** Bun's timer also counts time spent queued for a lane, so this is only a hang
 * backstop. CASE_BUDGET_MS is what bounds a case. */
const QUEUED_CASE_TIMEOUT_MS = 3_600_000

type Case = {
  mkdtemp: (prefix: string) => Promise<string>
  /** Absolute deadline: now + ms, clamped to the case budget minus cleanup grace. */
  deadline: (ms?: number) => number
}
let running = 0
const queued: (() => void)[] = []
/** A concurrent case holding one of LANES slots. Each case owns its temporary
 * directories, because a shared afterEach allocator would delete a sibling's. */
function scenario(name: string, body: (c: Case) => Promise<void>) {
  test.concurrent(
    name,
    async () => {
      if (running < LANES) running++
      else await new Promise<void>((resolve) => queued.push(resolve)) // slot handed over
      let cleanup: (() => Promise<void>) | undefined
      const mkdtemp = ownTempDirectories((fn) => {
        cleanup = fn
      })
      const end = Date.now() + CASE_BUDGET_MS - CLEANUP_GRACE_MS
      try {
        await body({
          mkdtemp,
          deadline: (ms = SIGNAL_DEADLINE_MS) => Math.min(Date.now() + ms, end),
        })
      } finally {
        try {
          await cleanup?.()
        } finally {
          const next = queued.shift()
          if (next) next()
          else running--
        }
      }
    },
    QUEUED_CASE_TIMEOUT_MS,
  )
}

type Child = {
  exitCode: number | null
  exited: Promise<number>
  kill(signal?: number | NodeJS.Signals): void
}
type Wait = (
  predicate: (events: RepositoryEvent[]) => boolean | Promise<boolean>,
) => Promise<RepositoryEvent[]>

/** Polls the repository log until `predicate` holds, failing with the case's
 * own diagnostic when the launcher exits first or the deadline passes. Exit is
 * sampled before the read, so a launcher that exits right after writing the
 * awaited event still satisfies the wait. */
function eventWaiter(o: {
  store: ReturnType<typeof openLocalStore>
  repo: string
  child: Child
  stderr: Promise<string>
  deadline: () => number
  exited: string
  timeout: (events: RepositoryEvent[]) => string
  poll: number
  inspect?: (events: RepositoryEvent[]) => void
}): Wait {
  return async (predicate) => {
    const at = o.deadline()
    for (;;) {
      const gone = o.child.exitCode !== null
      const events = await o.store.getRepoEvents(o.repo)
      o.inspect?.(events)
      if (await predicate(events)) return events
      if (gone) throw new Error(`${o.exited}: ${await o.stderr}`)
      if (Date.now() > at) throw new Error(o.timeout(events))
      await Bun.sleep(o.poll)
    }
  }
}

/** Joins `child` by the absolute time `at`, or throws `message`. */
async function exitWithin(child: Child, at: number, message: string): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(0, at - Date.now()))
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Cleanup join: interrupt, then SIGKILL if the child ignores it, so a hung
 * case neither holds its lane nor leaks a process into a sibling case. */
async function stopChild(child: Child, interrupt: () => void): Promise<void> {
  if (child.exitCode !== null) return
  interrupt()
  try {
    await exitWithin(child, Date.now() + CLEANUP_GRACE_MS / 2, 'child did not stop')
  } catch {
    child.kill('SIGKILL')
    await child.exited
  }
}

/** Counts `run`'s settled upgrade-target checks recorded by recordTargetChecks. */
async function settledChecks(log: string, run: string): Promise<number> {
  return (await readFile(log, 'utf8').catch(() => '')).split('\n').filter((line) => line === run)
    .length
}
/** Waits until `run` has settled `n` more target checks after this call. With
 * n = 5, at least four whole checks begin after the window opens. */
async function checksSettled(wait: Wait, log: string, run: string, n = 5): Promise<void> {
  const start = await settledChecks(log, run)
  await wait(async () => (await settledChecks(log, run)) >= start + n)
}

scenario(
  'real launcher adopts two replacements of the original installation',
  async ({ mkdtemp, deadline }) => {
    const root = await mkdtemp(join(tmpdir(), 'ab-hot-upgrade-'))
    const repo = join(root, 'repo'),
      original = join(root, 'installation')
    await mkdir(repo)
    await mkdir(join(repo, 'tickets/ready'), { recursive: true })
    await seedInstallation(repo, original)
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
    const wait = eventWaiter({
      store,
      repo,
      child,
      stderr,
      deadline,
      exited: 'launcher exited',
      timeout: (events) =>
        `handoff timeout: ${JSON.stringify(events.filter((e) => e.type.includes('upgrade') || e.type.includes('handoff')).slice(-8))}`,
      poll: 50,
    })
    try {
      await wait((events) => events.some((e) => e.type === 'dispatcher.runtime-recorded'))
      for (const version of ['2.0.0', '3.0.0']) {
        await replace(version)
        const events = await wait((events) =>
          events.some(
            (e) =>
              e.type === 'dispatcher.handoff-completed' &&
              e.payload.to.version === version &&
              events.some(
                (start) =>
                  start.type === 'dispatcher.run-started' &&
                  start.payload.run === e.payload.successor,
              ),
          ),
        )
        const completion = events.findLast((e) => e.type === 'dispatcher.handoff-completed')!
        if (completion.type !== 'dispatcher.handoff-completed')
          throw new Error('missing completion')
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
        const accepted = events.find(
          (e) =>
            e.type === 'dispatcher.handoff-started' && e.payload.run === completion.payload.run,
        )!
        const released = events.find(
          (e) =>
            e.type === 'dispatcher.terminal-released' && e.payload.run === completion.payload.run,
        )!
        const takeover = events.find(
          (e) => e.type === 'dispatcher.takeover' && e.payload.run === completion.payload.run,
        )!
        expect(released.seq).toBeLessThan(takeover.seq)
        expect(takeover.seq).toBeLessThan(start.seq)
        if (accepted.type === 'dispatcher.handoff-started' && accepted.payload.mode === 'cutover')
          expect(stop.seq).toBeLessThan(start.seq)
        expect(
          events.filter(
            (e) =>
              e.type === 'dispatcher.tick-started' &&
              e.payload.run === completion.payload.run &&
              e.seq > accepted.seq,
          ),
        ).toHaveLength(0)
        expect((await store.getRepo(repo))!.lease?.holder).toBe(completion.payload.successor)
      }
      const beforeFailure = (await store.getRepo(repo))!.lease!.holder
      const validConfig = await readFile(join(repo, 'autobuild.toml'), 'utf8')
      await writeFile(join(repo, 'autobuild.toml'), 'store = [invalid TOML')
      await replace('4.0.0')
      const failed = await wait((events) =>
        events.some(
          (event) =>
            event.type === 'dispatcher.upgrade-failed' && event.payload.target.version === '4.0.0',
        ),
      )
      const failure = failed.findLast((event) => event.type === 'dispatcher.upgrade-failed')!
      expect(
        failed.some(
          (event) =>
            event.type === 'dispatcher.handoff-started' && event.payload.to.version === '4.0.0',
        ),
      ).toBe(false)
      expect((await store.getRepo(repo))!.lease!.holder).toBe(beforeFailure)
      await wait(async () => {
        const finished = (await store.getRepo(repo))!.tick?.finished
        return (
          finished?.run === beforeFailure &&
          Date.parse(finished.completedAt) > Date.parse(failure.ts)
        )
      })
      await writeFile(join(repo, 'autobuild.toml'), validConfig)
      child.kill('SIGINT')
      await exitWithin(child, deadline(), 'launcher did not stop after interrupt')
      expect(child.exitCode).toBe(0)
      expect(await stderr).toContain('config reload rejected')
    } finally {
      await stopChild(child, () => child.kill('SIGINT'))
      await stdout
      await store.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)

scenario(
  'real source launcher observes excluded commits and adopts same-version source changes',
  async ({ mkdtemp, deadline }) => {
    const { sourceCommand } = await import('../cli/dispatch-upgrade-source')
    const { projectRepositoryStatus, renderRepositoryStatus } = await import(
      '../cli/repository-status'
    )
    const root = await mkdtemp(join(tmpdir(), 'ab-source-upgrade-'))
    const repo = join(root, 'repo'),
      editor = join(root, 'editor')
    await mkdir(repo)
    await seedInstallation(repo, repo)
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
    // Committed with the fixture, so every source generation records its checks.
    const checks = join(root, 'target-checks')
    await recordTargetChecks(repo, checks)
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
    const wait = eventWaiter({
      store,
      repo,
      child,
      stderr,
      deadline,
      exited: 'source launcher exited',
      timeout: (events) =>
        `source timeout: ${JSON.stringify(events.filter((e) => e.type.includes('upgrade') || e.type.includes('handoff')).slice(-8))}`,
      poll: 50,
      inspect: (events) => {
        const failure = events.findLast((e) => e.type === 'dispatcher.upgrade-failed')
        if (failure?.type === 'dispatcher.upgrade-failed') throw new Error(failure.payload.reason)
      },
    })
    const holder = async () => (await store.getRepo(repo))!.lease!.holder
    const resolved = (sha: string) =>
      wait((events) =>
        events.some(
          (e) => e.type === 'dispatcher.upgrade-target-resolved' && e.payload.target.sha === sha,
        ),
      )
    const complete = (sha: string) =>
      wait((events) =>
        events.some(
          (e) =>
            e.type === 'dispatcher.handoff-completed' &&
            e.payload.target.sha === sha &&
            events.some(
              (start) =>
                start.type === 'dispatcher.run-started' &&
                start.payload.run === e.payload.successor,
            ) &&
            events.some(
              (takeover) =>
                takeover.type === 'dispatcher.takeover' && takeover.payload.run === e.payload.run,
            ),
        ),
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
      const resolutions = events.filter(
        (e) => e.type === 'dispatcher.upgrade-target-resolved',
      ).length
      await checksSettled(wait, checks, await holder())
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
      events = await complete(productionSha)
      const workspaceResolutions = events.filter(
        (e) =>
          e.type === 'dispatcher.upgrade-target-resolved' && e.payload.target.sha === workspaceSha,
      )
      expect(workspaceResolutions).toHaveLength(1)
      const productionResolution = events.find(
        (e) =>
          e.type === 'dispatcher.upgrade-target-resolved' && e.payload.target.sha === productionSha,
      )!
      expect(
        events.filter(
          (e) =>
            e.type === 'dispatcher.upgrade-detected' &&
            e.seq > workspaceResolutions[0]!.seq &&
            e.seq < productionResolution.seq,
        ),
      ).toHaveLength(0)

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
        const released = events.find(
          (e) =>
            e.type === 'dispatcher.terminal-released' && e.payload.run === completion.payload.run,
        )!
        const takeover = events.find(
          (e) => e.type === 'dispatcher.takeover' && e.payload.run === completion.payload.run,
        )!
        expect(released.seq).toBeLessThan(takeover.seq)
        expect(takeover.seq).toBeLessThan(start.seq)
        if (completion.payload.mode === 'cutover') expect(stop.seq).toBeLessThan(start.seq)
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
      await checksSettled(wait, checks, await holder())
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
      await checksSettled(wait, checks, await holder())
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
      expect(await readFile(cachedFile, 'utf8')).toBe(cachedBytes)
      child.kill('SIGINT')
      await exitWithin(child, deadline(), 'source launcher did not stop after interrupt')
      expect(child.exitCode).toBe(0)
      expect(await stderr).toBe('')
    } finally {
      await stopChild(child, () => child.kill('SIGINT'))
      await stdout
      await store.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)

for (const crashed of process.platform === 'linux' ? [false, true, 'successor'] : [false])
  scenario(
    `PTY successor keeps descriptors and input after ${crashed === true ? 'predecessor death' : crashed === 'successor' ? 'successor preflight death' : 'terminal release'}`,
    async ({ mkdtemp, deadline }) => {
      const root = await mkdtemp(join(tmpdir(), 'ab-handoff-pty-'))
      const repo = join(root, 'repo'),
        original = join(root, 'installation')
      await mkdir(repo)
      await mkdir(join(repo, 'tickets/ready'), { recursive: true })
      await seedInstallation(repo, original)
      const manifest = JSON.parse(await readFile(join(original, 'package.json'), 'utf8'))
      await writeFile(
        join(original, 'package.json'),
        JSON.stringify({ ...manifest, version: '1.0.0' }),
      )
      const releaseGate = join(root, 'release-presentation')
      if (crashed) {
        const frontend = join(original, 'packages/core/src/cli/dispatch-frontend.ts')
        await writeFile(
          frontend,
          (await readFile(frontend, 'utf8')).replace(
            'await this.finishPresentation()',
            `if (!launchContext(this.opts.env)?.predecessor) while (!await Bun.file(${JSON.stringify(releaseGate)}).exists()) await new Promise<void>(resolve => setTimeout(resolve, 25));\n        await this.finishPresentation()`,
          ),
        )
      }

      const targetFile = join(original, 'packages/core/src/cli/dispatch-upgrade-target.ts')
      await writeFile(targetFile, (await readFile(targetFile, 'utf8')).replace('60_000', '100'))
      await writeFile(join(repo, 'package.json'), '{}')
      await writeFile(
        join(repo, 'autobuild.toml'),
        'forge="local-git"\n[roles.default]\nruntime="claude"\n[tickets]\nsource="file"\ndir="tickets"\nreadyState="ready"\n',
      )
      for (const args of [
        ['init', '-b', 'main'],
        ['config', 'user.name', 'Test'],
        ['config', 'user.email', 'test@example.com'],
        ['add', '.'],
        ['commit', '-m', 'fixture'],
      ]) {
        const result = await spawnExec(['git', ...args], { cwd: repo })
        if (result.exitCode) throw new Error(result.stderr)
      }
      const storePath = join(repo, '.autobuild/store')
      const store = openLocalStore(storePath)
      await store.ensureRepo(repo)
      const terminalLog = join(root, 'terminal.log')
      const script = `
import os, pty, select, sys, json
pid, fd = pty.fork()
if pid == 0:
 os.chdir(sys.argv[1]); os.environ['TERM']='xterm-256color'
 os.execv(sys.argv[2], [sys.argv[2], sys.argv[3], 'dispatch', '--interval', '0.05', '--store', sys.argv[4]])
buffer=b''
with open(sys.argv[5], 'wb') as output:
 while True:
  ready,_,_=select.select([fd,sys.stdin.buffer],[],[],.1)
  if sys.stdin.buffer in ready:
   data=os.read(sys.stdin.fileno(),65536)
   if not data: break
   buffer+=data
   while b'\\n' in buffer:
    line,buffer=buffer.split(b'\\n',1); os.write(fd,json.loads(line).encode())
  if fd in ready:
   try: data=os.read(fd,65536)
   except OSError: break
   if not data: break
   output.write(data); output.flush()
_,status=os.waitpid(pid,0)
sys.exit(os.waitstatus_to_exitcode(status))
`
      const child = Bun.spawn(
        [
          'python3',
          '-c',
          script,
          repo,
          process.execPath,
          join(original, 'bin/ab.ts'),
          storePath,
          terminalLog,
        ],
        {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
        },
      )
      const stderr = new Response(child.stderr).text(),
        stdout = new Response(child.stdout).text()
      const wait = eventWaiter({
        store,
        repo,
        child,
        stderr,
        deadline,
        exited: 'PTY launcher exited',
        timeout: (events) =>
          `PTY handoff timeout: ${JSON.stringify(events.filter((e) => /upgrade|handoff|yield|takeover|released/.test(e.type)))}`,
        poll: 25,
      })
      try {
        await wait((events) => events.some((e) => e.type === 'dispatcher.tick-completed'))
        await writeFile(
          join(original, 'package.json'),
          JSON.stringify({ ...manifest, version: '2.0.0' }),
        )
        if (crashed) {
          const accepted = await wait((events) =>
            events.some((event) => event.type === 'dispatcher.handoff-started'),
          )
          const predecessor = accepted.find((event) => event.type === 'dispatcher.handoff-started')!
            .payload.run
          const started = accepted.find(
            (event) => event.type === 'dispatcher.run-started' && event.payload.run === predecessor,
          )!
          if (started.type !== 'dispatcher.run-started')
            throw new Error('missing predecessor kernel')
          const stat = await readFile(`/proc/${started.payload.pid}/stat`, 'utf8')
          const presentationPid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
          if (crashed === true) process.kill(presentationPid, 'SIGKILL')
          else {
            const presentationStat = await readFile(`/proc/${presentationPid}/stat`, 'utf8')
            const launcherPid = Number(
              presentationStat.slice(presentationStat.lastIndexOf(')') + 2).split(' ')[1],
            )
            const children = (
              await readFile(`/proc/${launcherPid}/task/${launcherPid}/children`, 'utf8')
            )
              .trim()
              .split(/\s+/)
            let successorPid: number | undefined
            for (const child of children) {
              try {
                if (
                  (await readFile(`/proc/${child}/cmdline`, 'utf8'))
                    .split('\0')
                    .includes('--preflight')
                )
                  successorPid = Number(child)
              } catch {}
            }
            if (!successorPid) throw new Error('missing gated preflight process')
            process.kill(successorPid, 'SIGKILL')
            await writeFile(releaseGate, 'release')
          }
        }
        const events = await wait(
          (events) =>
            events.some((e) => e.type === 'dispatcher.takeover') &&
            events
              .filter((e) => e.type === 'dispatcher.tick-completed')
              .some(
                (e) =>
                  e.payload.run ===
                  events.find((e) => e.type === 'dispatcher.takeover')!.payload.successor,
              ),
        )
        const released = events.find((e) => e.type === 'dispatcher.terminal-released')!
        const takeover = events.find((e) => e.type === 'dispatcher.takeover')!
        expect(released.seq).toBeLessThan(takeover.seq)
        const before = (await readFile(terminalLog)).length
        child.stdin.write(`${JSON.stringify('i')}\n`)
        await wait((events) =>
          events.some((e) => e.type === 'dispatcher.intake-set' && e.seq > takeover.seq),
        )
        await wait(async () => (await readFile(terminalLog)).length > before)
        expect((await readFile(terminalLog)).length).toBeGreaterThan(before)
        child.stdin.write(`${JSON.stringify('\x03')}\n`)
        expect(
          await exitWithin(child, deadline(), 'PTY launcher did not stop after interrupt'),
        ).toBe(0)
        expect(await stderr).toBe('')
        expect(await readFile(terminalLog, 'utf8')).toContain('\x1b[?25h')
      } finally {
        await writeFile(releaseGate, 'release').catch(() => {})
        await stopChild(child, () => child.stdin.write(`${JSON.stringify('\x03')}\n`))
        await stdout
        await store.close()
        await rm(root, { recursive: true, force: true })
      }
    },
  )

for (const crash of ['immediate', 'phases', 'legacy', 'expired-reader'])
  scenario(
    `real launcher supervises post-takeover crashes (${crash})`,
    async ({ mkdtemp, deadline }) => {
      const phaseWork = crash === 'phases'
      const root = await mkdtemp(join(tmpdir(), 'ab-rollback-'))
      const repo = join(root, 'repo'),
        original = join(root, 'installation')
      await mkdir(join(repo, 'tickets/ready'), { recursive: true })
      await seedInstallation(repo, original)
      const manifest = JSON.parse(await readFile(join(original, 'package.json'), 'utf8'))
      const replace = (version: string) =>
        writeFile(join(original, 'package.json'), JSON.stringify({ ...manifest, version }))
      await replace('1.0.0')
      const target = join(original, 'packages/core/src/cli/dispatch-upgrade-target.ts')
      await writeFile(target, (await readFile(target, 'utf8')).replace('60_000', '100'))
      await shortenFixtureLeases(original)
      const checks = join(root, 'target-checks')
      await recordTargetChecks(original, checks)
      const entry = join(original, 'bin/ab-dispatch-generation.ts')
      const bytes = await readFile(entry, 'utf8')
      const broken = `JSON.parse(await Bun.file(new URL('../package.json', import.meta.url)).text()).version === '2.0.0'`
      const crashGate = join(root, 'crash-now'),
        reviewGate = join(root, 'review-now')
      const expiredReader = crash === 'expired-reader'
      // The cached predecessor remains healthy. Every new process of B dies after
      // preflight has committed takeover; B's upgrade reader cannot import either.
      await writeFile(
        entry,
        bytes
          // Legacy peers ignore the optional conditional request and return full v1.
          .replace('{ condition }', crash === 'legacy' ? '{}' : '{ condition }')
          .replace(
            "  if (process.argv[2] === '--read-upgrade') {",
            `  if (process.argv[2] === '--read-upgrade' && (${broken} || (${expiredReader} && await Bun.file(${JSON.stringify(crashGate)}).exists()))) throw new Error('broken reader');\n  if (process.argv[2] === '--read-upgrade') {`,
          )
          .replace(
            '  process.env[DISPATCH_LAUNCH_CONTEXT_ENV]',
            expiredReader
              ? `  if (${broken}) setInterval(async () => { if (await Bun.file(${JSON.stringify(crashGate)}).exists()) process.exit(82) }, 25);\n  process.env[DISPATCH_LAUNCH_CONTEXT_ENV]`
              : phaseWork
                ? `  if (${broken}) setInterval(async () => { if (await Bun.file(${JSON.stringify(crashGate)}).exists()) process.exit(82) }, 25);\n  process.env[DISPATCH_LAUNCH_CONTEXT_ENV]`
                : `  if (${broken}) process.exit(82);\n  process.env[DISPATCH_LAUNCH_CONTEXT_ENV]`,
          ),
      )
      if (crash === 'legacy') {
        const handoff = join(original, 'packages/core/src/cli/dispatch-handoff.ts')
        await writeFile(
          handoff,
          (await readFile(handoff, 'utf8')).replaceAll('rollbackVersion: 1,', ''),
        )
      } else if (expiredReader) {
        const launcher = join(original, 'packages/core/src/cli/dispatch-launcher.ts')
        await writeFile(
          launcher,
          (await readFile(launcher, 'utf8')).replace(
            'new DispatchCrashBudget(projection.takeoverAt)',
            `new DispatchCrashBudget((await Bun.write(${JSON.stringify(crashGate)}, 'takeover observed'), new Date(Date.now() - 600_001).toISOString()))`,
          ),
        )
      } else {
        // Fail one actual store operation during restored-generation initialization.
        // The same process must retry, publish rollback once, and still adopt C.
        const handoff = join(original, 'packages/core/src/cli/dispatch-handoff.ts')
        const operation = phaseWork ? 'appendRepo' : 'getRepo'
        await writeFile(
          handoff,
          'let injectedRollbackFailure = false;\n' +
            (await readFile(handoff, 'utf8')).replace(
              '  const context = launch.rollback',
              `  if (launch.rollback) store = new Proxy(store, { get(target, key) {
              const value = Reflect.get(target, key);
              if (key === '${operation}') return (...args) => {
                if (!injectedRollbackFailure) { injectedRollbackFailure = true; throw new Error('injected rollback ${operation} failure'); }
                return value.apply(target, args);
              };
              return typeof value === 'function' ? value.bind(target) : value;
            }});\n  const context = launch.rollback`,
            ),
        )
      }
      await writeFile(join(repo, 'package.json'), '{}')
      await writeFile(
        join(repo, 'autobuild.toml'),
        `forge="local-git"\n[roles.default]\nruntime="claude"\n[tickets]\nsource="file"\ndir="tickets"\nreadyState="ready"\n${FIXTURE_REPO_LEASE_POLICY}`,
      )
      if (phaseWork) {
        await writeFile(join(repo, '.gitignore'), '.autobuild/\ntickets/\n')
        await writeFile(
          join(repo, 'autobuild.toml'),
          `forge="local-git"\ncapacity=2\nticketScanIntervalSeconds=1\nplugins=["./fixture-plugin.ts"]\n[roles.default]\nruntime="proof"\n[tickets]\nsource="file"\ndir="tickets"\nreadyState="ready"\n${FIXTURE_REPO_LEASE_POLICY}`,
        )
        await writeFile(
          join(repo, 'fixture-plugin.ts'),
          `
import {ScriptedAgentRunner,defaultTurnResult} from '@defrex/autobuild/plugin-sdk';
export default {name:'proof',apiVersion:'^1.0.0',agentRuntimes:{proof:()=>({servesModels:[],runner:new ScriptedAgentRunner({script:async ctx=>{
  const run = async (...args) => {
    const c=Bun.spawn(['ab',...args],{cwd:ctx.opts.workspacePath,env:ctx.opts.env,stdout:'pipe',stderr:'pipe'});
    const out=new Response(c.stdout).text(), err=new Response(c.stderr).text();
    if(await c.exited !== 0) throw new Error(await err); return await out;
  };
  if(ctx.opts.env.AB_PHASE.split('@')[0] === 'plan') {
    await run('context');
    await Bun.write(ctx.opts.workspacePath+'/.ab/plan.md','# Plan\\n1. Verify runtime boundary.\\n');
    await run('artifact','put','plan','.ab/plan.md'); await run('done');
    // Keep B at the completed phase boundary until the injected crash. Returning
    // here races the parent test and can start plan-review on B before rollback.
    await new Promise(() => {});
  } else {
    while(!await Bun.file(${JSON.stringify(reviewGate)}).exists()) await Bun.sleep(25);
    await run('context'); await run('escalate','restored phase reached');
  }
  return defaultTurnResult('phase boundary proof');
}})})}};
`,
        )
      }
      for (const args of [
        ['init', '-b', 'main'],
        ['config', 'user.name', 'Test'],
        ['config', 'user.email', 'test@example.com'],
        ['add', '.'],
        ['commit', '-m', 'fixture'],
      ]) {
        const result = await spawnExec(['git', ...args], { cwd: repo })
        if (result.exitCode) throw new Error(result.stderr)
      }
      const storePath = join(repo, '.autobuild/store'),
        store = openLocalStore(storePath)
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
      const wait = eventWaiter({
        store,
        repo,
        child,
        stderr,
        deadline,
        exited: 'rollback launcher exited',
        timeout: (events) => `rollback timeout: ${JSON.stringify(events.slice(-8))}`,
        poll: 25,
      })
      try {
        await wait((events) => events.some((e) => e.type === 'dispatcher.runtime-recorded'))
        await replace('2.0.0')
        if (expiredReader) {
          // Preparing B can take tens of seconds under load; wait on the durable
          // takeover rather than racing it.
          await wait((events) => events.some((e) => e.type === 'dispatcher.takeover'))
          // Both readers fail after B exits, beyond the original crash window.
          // After takeover the launcher needs only B's crash and a few reader
          // spawns. The regression this guards spins readers forever, so a
          // bounded join still fails it with this diagnostic.
          const code = await exitWithin(child, deadline(), 'expired recovery did not exit')
          expect(code).toBe(1)
          const events = await store.getRepoEvents(repo)
          expect(events.filter((e) => e.type === 'dispatcher.takeover')).toHaveLength(1)
          expect(events.filter((e) => e.type === 'dispatcher.runtime-rolled-back')).toHaveLength(0)
          return
        }
        let proofSlug: string | undefined, futureSlug: string | undefined
        if (phaseWork) {
          await wait((events) =>
            events.some(
              (e) =>
                e.type === 'dispatcher.runtime-recorded' && e.payload.runtime.version === '2.0.0',
            ),
          )
          for (const name of ['proof', 'future'])
            await writeFile(
              join(repo, 'tickets/ready', `${name}.md`),
              '+++\nid="' +
                name +
                '"\ntitle="' +
                name +
                ' boundary recovery"\n+++\nHat: product.\n## What\nProve cached boundary recovery.\n## Acceptance criteria\n- Record restored phase evidence.\n## Out of scope\n- External services.\n## Evidence\n- Disposable integration fixture.\n',
            )
          await wait(async () => {
            const builds = await store.listBuilds()
            proofSlug = builds.find((b) => b.ticket?.id === 'proof')?.slug
            futureSlug = builds.find((b) => b.ticket?.id === 'future')?.slug
            return (
              !!proofSlug &&
              !!futureSlug &&
              (
                await Promise.all([proofSlug, futureSlug].map((slug) => store.getEvents(slug)))
              ).every((events) => events.some((e) => e.type === 'plan.completed'))
            )
          })
          const { Database } = await import('bun:sqlite')
          const db = new Database(join(storePath, 'autobuild.sqlite'))
          try {
            // The live dispatcher still writes heartbeats and session facts. Wait
            // for its writer and allocate the sequence in the same atomic write.
            db.exec('PRAGMA busy_timeout = 5000')
            db.query(
              'INSERT INTO events (build,seq,ts,actor,type,payload,compatibility) SELECT ?,MAX(seq)+1,?,?,?,?,? FROM events WHERE build=?',
            ).run(
              futureSlug!,
              new Date().toISOString(),
              JSON.stringify({ kind: 'kernel' }),
              'future.runtime-decision',
              '{}',
              JSON.stringify({ classification: 'decisive', writerVersion: '2.0.0' }),
              futureSlug!,
            )
          } finally {
            db.close()
          }
          await writeFile(crashGate, 'crash')
        }
        if (crash === 'legacy') {
          await wait((events) => events.some((e) => e.type === 'dispatcher.takeover'))
          expect(await exitWithin(child, deadline(), 'legacy launcher did not exit')).toBe(1)
          const events = await store.getRepoEvents(repo)
          expect(events.filter((e) => e.type === 'dispatcher.takeover')).toHaveLength(1)
          expect(events.filter((e) => e.type === 'dispatcher.runtime-rolled-back')).toHaveLength(0)
          expect(await stderr).toContain('automatic runtime rollback requires rollback-capable')
          return
        }
        const events = await wait((events) =>
          events.some((e) => e.type === 'dispatcher.runtime-rolled-back'),
        )
        const rollback = events.find((e) => e.type === 'dispatcher.runtime-rolled-back')!
        if (rollback.type !== 'dispatcher.runtime-rolled-back') throw new Error('missing rollback')
        expect(rollback.payload).toMatchObject({
          failures: 3,
          failed: { version: '2.0.0' },
          restored: { version: '1.0.0' },
        })
        await wait((events) =>
          events.some(
            (e) =>
              e.type === 'dispatcher.upgrade-target-resolved' &&
              e.payload.run === rollback.payload.run,
          ),
        )
        await checksSettled(wait, checks, rollback.payload.run)
        const held = await store.getRepoEvents(repo)
        expect(held.filter((e) => e.type === 'dispatcher.runtime-rolled-back')).toHaveLength(1)
        expect(held.filter((e) => e.type === 'dispatcher.takeover')).toHaveLength(1)
        expect(
          held.some(
            (e) =>
              e.type === 'dispatcher.upgrade-detected' && e.payload.run === rollback.payload.run,
          ),
        ).toBe(false)
        const { cachedRuntime } = await import('../cli/dispatch-runtime-cache')
        expect(await cachedRuntime(rollback.payload.failedRoot)).toBeDefined()
        expect(await cachedRuntime(rollback.payload.restoredRoot)).toBeDefined()
        if (phaseWork) {
          await writeFile(reviewGate, 'continue')
          await wait(async () =>
            (await store.getEvents(proofSlug!)).some(
              (e) =>
                e.type === 'escalation.raised' && e.payload.question === 'restored phase reached',
            ),
          )
          const proof = await store.getEvents(proofSlug!)
          expect(
            proof
              .filter((e) => e.type === 'runner.runtime-recorded')
              .map((e) => e.payload.runtime.version),
          ).toEqual(expect.arrayContaining(['2.0.0', '1.0.0']))
          await wait(async () =>
            (await store.getEvents(futureSlug!)).some(
              (e) => e.type === 'build.compatibility-deferred',
            ),
          )
          const future = await store.getEvents(futureSlug!)
          const boundary = future.find((e) => (e.type as string) === 'future.runtime-decision')!.seq
          expect(
            future.filter(
              (e) =>
                e.seq > boundary &&
                [
                  'plan-review.completed',
                  'implement.completed',
                  'session.started',
                  'publication.requested',
                ].includes(e.type),
            ),
          ).toEqual([])
        }
        await replace('3.0.0')
        await wait((events) =>
          events.some((e) => e.type === 'dispatcher.takeover' && e.payload.to.version === '3.0.0'),
        )
        expect(
          (await store.getRepoEvents(repo)).some(
            (e) =>
              e.type === 'dispatcher.upgrade-detected' &&
              e.payload.run === rollback.payload.run &&
              e.payload.target.version === '2.0.0',
          ),
        ).toBe(false)
        expect(
          (await store.getRepoEvents(repo)).filter(
            (e) => e.type === 'dispatcher.rollback-hold-cleared',
          ),
        ).toHaveLength(1)
        child.kill('SIGINT')
        expect(
          await exitWithin(child, deadline(), 'rollback launcher did not stop after interrupt'),
        ).toBe(0)
        expect(await stderr).toContain(
          `injected rollback ${phaseWork ? 'appendRepo' : 'getRepo'} failure`,
        )
        expect(
          (await store.getRepoEvents(repo)).filter(
            (e) => e.type === 'dispatcher.runtime-rolled-back',
          ),
        ).toHaveLength(1)
      } finally {
        await stopChild(child, () => child.kill('SIGINT'))
        await stdout
        await store.close()
        await rm(root, { recursive: true, force: true })
      }
    },
  )
