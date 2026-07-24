/**
 * Cross-process dev-server control (SPEC §16.2 D10, surfaced as `ab server` —
 * §8.2). Every CLI invocation is a fresh process, so — unlike the kernel's
 * in-process `DevServerManager` (src/kernel/server.ts) — state lives on disk:
 * `.ab/server.pid` (the process-group id) and `.ab/server.log`. Any later
 * invocation can status/stop/log a server an earlier one started.
 *
 * Ownership mirrors the kernel manager's approach: the start command is
 * spawned via `['sh', '-c', …]`, detached into its own process group, and
 * every signal goes to the whole group via kill(-pid). The server is MEANT to
 * outlive the CLI process that started it — phase-end teardown is the
 * kernel's guarantee (D10), `ab server stop` is the agent's.
 *
 * Config declares, the kernel owns (§16.2): start refuses without a [server]
 * table in the workspace's autobuild.toml, and refuses in phases without
 * server access (`implement` and `verify` only — PHASE_SPECS, §8.2).
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { parseConfig } from '../config/load'
import type { ServerConfig } from '../config/schema'
import { phaseSpecFor } from '../kernel/phases'
import type { Phase } from '../ontology'

export interface ServerControlOptions {
  workspacePath: string
  phase: Phase
  /** Readiness-probe seam; defaults to global fetch (localhost — offline). */
  fetchFn?: typeof fetch
  /** Probe/liveness poll interval, default 250ms; injectable for fast tests. */
  pollIntervalMs?: number
  /** SIGTERM→SIGKILL grace on stop(), default 2000ms. */
  killGraceMs?: number
}

export interface ServerStatus {
  running: boolean
  pid?: number
}

export interface ServerStartResult {
  pid: number
  url: string
}

/** `ab server logs` default window. */
const DEFAULT_LOG_LINES = 100

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(-pgid, signal)
  } catch {
    // ESRCH: group already gone — teardown is idempotent.
  }
}

export class ServerControl {
  private readonly workspacePath: string
  private readonly phase: Phase
  private readonly fetchFn: typeof fetch
  private readonly pollIntervalMs: number
  private readonly killGraceMs: number
  private readonly abDir: string
  private readonly pidPath: string
  private readonly logPath: string

  constructor(opts: ServerControlOptions) {
    this.workspacePath = opts.workspacePath
    this.phase = opts.phase
    this.fetchFn = opts.fetchFn ?? fetch
    this.pollIntervalMs = opts.pollIntervalMs ?? 250
    this.killGraceMs = opts.killGraceMs ?? 2000
    this.abDir = join(this.workspacePath, '.ab')
    this.pidPath = join(this.abDir, 'server.pid')
    this.logPath = join(this.abDir, 'server.log')
  }

  /**
   * Spawn `[server].start` in its own process group, record the pidfile, and
   * probe `[server].url` until ready or `readyTimeout` (kill group + throw
   * with the log tail on timeout). No-op when already running.
   */
  async start(): Promise<ServerStartResult> {
    // Phase gate first (§8.2): a plan-phase agent gets the policy error even
    // in a workspace with no autobuild.toml at all.
    const spec = phaseSpecFor(this.phase)
    if (!spec.serverAccess) {
      throw new Error(
        `'ab server' is not available in phase "${this.phase}" — only implement ` +
          'and verify phases control the dev server (SPEC §8.2, §16.2)',
      )
    }
    const config = await this.loadServerConfig()

    const current = this.status()
    if (current.running && current.pid !== undefined) {
      return { pid: current.pid, url: config.url }
    }
    // A pidfile whose pid is dead is stale — treated as not running and
    // overwritten below.

    mkdirSync(this.abDir, { recursive: true })
    // `.ab/` is gitignored scratch (§7, §8.3): self-exclude on creation so a
    // server started before any `ab context` never dirties the worktree —
    // buildContext (src/cli/context.ts) writes the same file on every
    // hydration.
    const excludePath = join(this.abDir, '.gitignore')
    if (!existsSync(excludePath)) writeFileSync(excludePath, '*\n')
    // Output goes straight to an appended fd, not a pipe: the CLI process
    // exits while the server keeps writing to .ab/server.log.
    const fd = openSync(this.logPath, 'a')
    let child: ReturnType<typeof Bun.spawn>
    try {
      child = Bun.spawn(['sh', '-c', config.start], {
        cwd: this.workspacePath,
        // Own process group, so teardown kills the whole tree (D10).
        detached: true,
        stdin: 'ignore',
        stdout: fd,
        stderr: fd,
      })
    } finally {
      // The child holds its own copy of the fd.
      closeSync(fd)
    }
    writeFileSync(this.pidPath, `${child.pid}\n`)
    let exited = false
    void child.exited.then(() => {
      exited = true
    })
    // The server outlives this CLI process by design (pidfile semantics).
    child.unref()

    // Readiness is a probe (§16.2): any HTTP response counts.
    const deadline = Date.now() + config.readyTimeout * 1000
    for (;;) {
      if (exited || !processAlive(child.pid)) {
        killGroup(child.pid, 'SIGKILL')
        rmSync(this.pidPath, { force: true })
        throw this.failWithLogTail(`dev server exited before becoming ready: ${config.start}`)
      }
      try {
        await this.fetchFn(config.url)
        return { pid: child.pid, url: config.url }
      } catch {
        // Not listening yet.
      }
      if (Date.now() >= deadline) {
        killGroup(child.pid, 'SIGKILL')
        rmSync(this.pidPath, { force: true })
        throw this.failWithLogTail(
          `dev server not ready after ${config.readyTimeout}s: no HTTP response from ${config.url}`,
        )
      }
      await Bun.sleep(this.pollIntervalMs)
    }
  }

  /**
   * SIGTERM the group, wait out the grace period, SIGKILL, remove the
   * pidfile. Idempotent: no pidfile or a stale one is already "stopped".
   */
  async stop(): Promise<void> {
    const pid = this.readPid()
    if (pid === null) return
    if (processAlive(pid)) {
      killGroup(pid, 'SIGTERM')
      await this.waitDead(pid, this.killGraceMs)
      killGroup(pid, 'SIGKILL')
      await this.waitDead(pid, this.killGraceMs)
    }
    rmSync(this.pidPath, { force: true })
  }

  async restart(): Promise<ServerStartResult> {
    await this.stop()
    return this.start()
  }

  /** Pidfile pid, liveness-checked; a stale pidfile reads as not running. */
  status(): ServerStatus {
    const pid = this.readPid()
    if (pid !== null && processAlive(pid)) return { running: true, pid }
    return { running: false }
  }

  /** Last `lines` lines of `.ab/server.log`; empty when it does not exist. */
  logs(lines = DEFAULT_LOG_LINES): string[] {
    if (!existsSync(this.logPath)) return []
    const all = readFileSync(this.logPath, 'utf8').split('\n')
    if (all[all.length - 1] === '') all.pop()
    return all.slice(-lines)
  }

  private readPid(): number | null {
    let raw: string
    try {
      raw = readFileSync(this.pidPath, 'utf8')
    } catch {
      return null
    }
    const pid = Number(raw.trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  }

  private async waitDead(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (processAlive(pid) && Date.now() < deadline) {
      await Bun.sleep(Math.min(this.pollIntervalMs, 50))
    }
  }

  private async loadServerConfig(): Promise<ServerConfig> {
    const tomlPath = join(this.workspacePath, 'autobuild.toml')
    const file = Bun.file(tomlPath)
    if (!(await file.exists())) {
      throw new Error(
        `'ab server' is config-driven (§16.2) but ${tomlPath} does not exist — ` +
          'declare a [server] table with start and url (SPEC §16.1)',
      )
    }
    const config = parseConfig(await file.text(), tomlPath)
    if (config.server === undefined) {
      throw new Error(
        "autobuild.toml has no [server] table — 'ab server' refuses without one " +
          '(§16.2). Add [server] with start (shell command) and url (readiness probe).',
      )
    }
    return config.server
  }

  /** Failures carry the log tail — the feedback loop agents need (§16.2). */
  private failWithLogTail(message: string): Error {
    const tail = this.logs(50)
    return new Error(`${message}\n--- server log tail ---\n${tail.join('\n')}`)
  }
}
