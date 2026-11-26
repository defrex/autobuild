#!/usr/bin/env bun
/**
 * Dispatcher boot time, the measurement command of this repository's
 * dispatcher-boot optimization node. It is that node's pinned harness:
 * attempts may read and run it, but cannot change what it counts.
 *
 * The value, in milliseconds, is the sum of two boots of a real source-mode
 * dispatcher in a throwaway copy of the tree under test:
 *
 * - cold: from spawning `ab dispatch` to its first completed tick.
 * - handoff: from `dispatcher.upgrade-detected`, when the running generation
 *   sees main move, to the successor generation's first completed tick.
 *
 * Setup is not timed. The tree's tracked and unignored files are copied into
 * a temporary repository that links the tree's `node_modules`; a file ticket
 * tracker, the repository-local store and the local-git forge keep it
 * offline. Each boot launches on a fresh commit while main already points
 * one commit past it, so the launcher prepares a new code runtime (as after a
 * pull) over a warm dependency layer (as when dependencies did not change),
 * and the generation's first upgrade check finds the newer main at once. The
 * two commits differ only in a marker file under `bin/`, inside the packaged
 * distribution; no product code is patched.
 *
 * One untimed warm-up boot fills the dependency layer, then RUNS measured
 * boots follow; the value is the median of their sums. Stdout carries
 * exactly one JSON object, `{"value": <ms>}`; per-stage timings go to stderr.
 * A boot that fails, stalls or exits uncleanly fails the measurement rather
 * than recording a number for broken behavior.
 */

import { Database } from 'bun:sqlite'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RUNS = 1
/** An unloaded boot takes seconds; a stage this slow is stuck. */
const STAGE_DEADLINE_MS = 180_000
const STOP_DEADLINE_MS = 120_000
const MARKER = 'bin/bench-generation'

const root = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '')

// A build runner exports AB_* session variables, and git may carry the
// operator's identity, hooks or signing; the fixture dispatcher starts as a
// fresh operator would, with none of them.
const env: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env)) {
  if (value === undefined || key.startsWith('AB_') || key.startsWith('GIT_')) continue
  env[key] = value
}
env.NO_COLOR = '1'
env.GIT_CONFIG_NOSYSTEM = '1'
env.GIT_CONFIG_GLOBAL = '/dev/null'

class BenchFailure extends Error {}

function run(
  cmd: string[],
  cwd: string,
  opts: { env?: Record<string, string>; input?: string } = {},
) {
  const result = Bun.spawnSync(cmd, {
    cwd,
    env: { ...env, ...opts.env },
    stdin: opts.input === undefined ? 'ignore' : new TextEncoder().encode(opts.input),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0)
    throw new BenchFailure(`${cmd.join(' ')} failed (exit ${result.exitCode}): ${result.stderr}`)
  return result.stdout.toString().trim()
}

type Event = { seq: number; ts: number; type: string; payload: Record<string, unknown> }

/** Reads the fixture store's repository journal with SQLite directly, so the
 * ruler does not run the store code under improvement. */
class Journal {
  private db: Database | undefined
  private seen = 0
  private readonly events: Event[] = []
  constructor(private readonly file: string) {}

  read(): Event[] {
    this.db ??= new Database(this.file, { readonly: true })
    const rows = this.db
      .query('select seq, ts, type, payload from repo_events where seq > ? order by seq')
      .all(this.seen) as { seq: number; ts: string; type: string; payload: string }[]
    for (const row of rows) {
      this.events.push({
        seq: row.seq,
        ts: Date.parse(row.ts),
        type: row.type,
        payload: JSON.parse(row.payload),
      })
      this.seen = row.seq
    }
    return this.events
  }

  close(): void {
    this.db?.close()
  }
}

type Child = ReturnType<typeof Bun.spawn>

async function until<T>(what: string, child: Child, probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + STAGE_DEADLINE_MS
  for (;;) {
    let found: T | undefined
    try {
      found = probe()
    } catch (error) {
      // The warm-up boot creates the store: its file can be missing, or exist
      // before the dispatcher has created the journal table.
      const message = String(error)
      if (!message.includes('unable to open database') && !message.includes('no such table'))
        throw error
    }
    if (found !== undefined) return found
    if (child.exitCode !== null)
      throw new BenchFailure(`dispatcher exited (${child.exitCode}) before ${what}`)
    if (Date.now() > deadline) throw new BenchFailure(`timed out waiting for ${what}`)
    await Bun.sleep(20)
  }
}

const runOf = (event: Event) => String(event.payload.run ?? '')

const firstTick = (events: Event[], run: string, after = 0) =>
  events.find((e) => e.seq > after && e.type === 'dispatcher.tick-completed' && runOf(e) === run)

async function setup(base: string): Promise<string> {
  const repo = join(base, 'repo')
  await mkdir(repo)
  // Tracked and unignored files, as the measured tree has them now.
  const list = join(base, 'files')
  await writeFile(list, run(['git', 'ls-files', '-z', '-co', '--exclude-standard'], root))
  const tarball = join(base, 'tree.tar')
  run(['tar', '-C', root, '--null', '-T', list, '-cf', tarball], base)
  run(['tar', '-C', repo, '-xf', tarball], base)
  await rm(tarball)
  await symlink(join(root, 'node_modules'), join(repo, 'node_modules'))
  await writeFile(
    join(repo, 'autobuild.toml'),
    [
      'forge = "local-git"',
      '[roles.default]',
      'runtime = "claude"',
      '[tickets]',
      'source = "file"',
      'dir = "bench-tickets"',
      'readyState = "ready"',
      '',
    ].join('\n'),
  )
  await mkdir(join(repo, 'bench-tickets/ready'), { recursive: true })
  await writeFile(join(repo, 'bench-tickets/ready/.keep'), '')
  const git = (...args: string[]) => run(['git', ...args], repo)
  git('init', '-q', '-b', 'main')
  // The tree ignores `node_modules/`, which a symlink does not match.
  await writeFile(join(repo, '.git/info/exclude'), '/node_modules\n')
  git('config', 'user.name', 'Benchmark')
  git('config', 'user.email', 'bench@example.invalid')
  git('add', '-A')
  git('commit', '-q', '--no-verify', '-m', 'benchmark fixture')
  git('checkout', '-q', '-b', 'operator')
  return repo
}

/** Commits a fresh launch marker on the checkout, then moves main one commit
 * past it without touching the working tree, index or checked-out branch. */
async function stage(repo: string, nonce: string): Promise<string> {
  const git = (...args: string[]) => run(['git', ...args], repo)
  await writeFile(join(repo, MARKER), `launch ${nonce}\n`)
  git('add', MARKER)
  git('commit', '-q', '--no-verify', '-m', `launch ${nonce}`)
  const launch = git('rev-parse', 'HEAD')
  const index = { GIT_INDEX_FILE: join(repo, '.git/bench-index') }
  run(['git', 'read-tree', launch], repo, { env: index })
  const blob = run(['git', 'hash-object', '-w', '--stdin'], repo, { input: `advance ${nonce}\n` })
  run(['git', 'update-index', '--add', '--cacheinfo', `100644,${blob},${MARKER}`], repo, {
    env: index,
  })
  const tree = run(['git', 'write-tree'], repo, { env: index })
  const target = git('commit-tree', tree, '-p', launch, '-m', `advance ${nonce}`)
  git('update-ref', 'refs/heads/main', target)
  return target
}

async function stop(child: Child): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGINT')
  let timer: ReturnType<typeof setTimeout> | undefined
  const stopped = await Promise.race([
    child.exited.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), STOP_DEADLINE_MS)
    }),
  ])
  clearTimeout(timer)
  if (!stopped) throw new BenchFailure('dispatcher did not stop after SIGINT')
}

/** Removes the code runtimes a boot prepared, keeping the dependency layers,
 * so every boot prepares its own code runtime over a warm layer. */
async function dropCodeRuntimes(repo: string): Promise<void> {
  const cache = join(repo, '.autobuild/runtime')
  for (const entry of await readdir(cache).catch(() => [] as string[])) {
    if (entry !== 'layers') await rm(join(cache, entry), { recursive: true, force: true })
  }
}

type Boot = { cold: number; handoff: number; stages: [string, number][] }

async function boot(repo: string, nonce: string, handoff: boolean): Promise<Boot> {
  const target = await stage(repo, nonce)
  const journal = new Journal(join(repo, '.autobuild/autobuild.sqlite'))
  let after = 0
  try {
    after = journal.read().at(-1)?.seq ?? 0
  } catch {
    // No store yet: the warm-up boot creates it.
  }
  const spawned = Date.now()
  const child = Bun.spawn([process.execPath, join(repo, 'bin/ab.ts'), 'dispatch', '--plain'], {
    cwd: repo,
    env,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const stderr = new Response(child.stderr).text()
  let result: Boot | undefined
  try {
    result = await observe(journal, child, spawned, after, target, handoff)
  } finally {
    journal.close()
    await stop(child)
    if (result === undefined || child.exitCode !== 0)
      process.stderr.write((await stderr).slice(-4000))
  }
  if (child.exitCode !== 0)
    throw new BenchFailure(`dispatcher exited ${child.exitCode} after SIGINT`)
  await dropCodeRuntimes(repo)
  return result
}

async function observe(
  journal: Journal,
  child: Child,
  spawned: number,
  after: number,
  target: string,
  handoff: boolean,
): Promise<Boot> {
  const started = await until('the first run to start', child, () =>
    journal.read().find((e) => e.seq > after && e.type === 'dispatcher.run-started'),
  )
  const tick = await until('the first tick', child, () =>
    firstTick(journal.read(), runOf(started), started.seq),
  )
  const result: Boot = {
    cold: tick.ts - spawned,
    handoff: 0,
    stages: [
      ['spawn→run-started', started.ts - spawned],
      ['run-started→tick', tick.ts - started.ts],
    ],
  }
  if (!handoff) return result
  const detected = await until('the upgrade to be detected', child, () => {
    const events = journal.read()
    const failure = events.find((e) => e.seq > after && e.type === 'dispatcher.upgrade-failed')
    if (failure) throw new BenchFailure(`upgrade failed: ${JSON.stringify(failure.payload)}`)
    return events.find(
      (e) =>
        e.seq > tick.seq &&
        e.type === 'dispatcher.upgrade-detected' &&
        (e.payload.target as { sha?: unknown } | undefined)?.sha === target,
    )
  })
  const completed = await until('the handoff to complete', child, () =>
    journal.read().find((e) => e.seq > detected.seq && e.type === 'dispatcher.handoff-completed'),
  )
  const successor = String(completed.payload.successor ?? '')
  if (!successor) throw new BenchFailure('handoff-completed names no successor')
  const successorTick = await until('the successor first tick', child, () =>
    firstTick(journal.read(), successor),
  )
  const events = journal.read()
  const at = (type: string, run?: string) =>
    events.find((e) => e.seq > detected.seq && e.type === type && (!run || runOf(e) === run))?.ts
  const marks: [string, number | undefined][] = [
    ['detected', detected.ts],
    ['prepared', at('dispatcher.target-prepared')],
    ['yield', at('dispatcher.yield-requested')],
    ['handoff-started', at('dispatcher.handoff-started')],
    ['successor-started', at('dispatcher.run-started', successor)],
    ['tick', successorTick.ts],
  ]
  for (let i = 1; i < marks.length; i++) {
    const [from, start] = marks[i - 1]!
    const [to, end] = marks[i]!
    if (start !== undefined && end !== undefined) result.stages.push([`${from}→${to}`, end - start])
  }
  result.handoff = successorTick.ts - detected.ts
  return result
}

/** Last resort after a failure: no fixture dispatcher may outlive the run. */
function killStragglers(base: string): void {
  const found = Bun.spawnSync(['pgrep', '-f', base], { stdout: 'pipe', stderr: 'ignore' })
  for (const pid of found.stdout.toString().split('\n').filter(Boolean)) {
    if (Number(pid) !== process.pid) {
      try {
        process.kill(Number(pid), 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const upper = sorted[mid] ?? 0
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2
}

const base = await mkdtemp(join(tmpdir(), 'ab-bench-dispatcher-boot-'))
let code = 0
try {
  const repo = await setup(base)
  await boot(repo, `warm-up-${crypto.randomUUID()}`, false)
  const totals: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const result = await boot(repo, `run-${i}-${crypto.randomUUID()}`, true)
    totals.push(result.cold + result.handoff)
    const stages = result.stages.map(([name, ms]) => `${name} ${ms}`).join(', ')
    process.stderr.write(
      `boot ${i + 1}: cold ${result.cold} ms + handoff ${result.handoff} ms (${stages})\n`,
    )
  }
  process.stdout.write(`${JSON.stringify({ value: Math.round(median(totals)) })}\n`)
} catch (error) {
  process.stderr.write(`dispatcher boot: ${error instanceof Error ? error.message : error}\n`)
  code = 1
} finally {
  killStragglers(base)
  await rm(base, { recursive: true, force: true })
}
process.exit(code)
