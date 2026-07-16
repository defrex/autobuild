/**
 * Dev-server lifecycle (SPEC §16.2, D10): config declares, the kernel owns.
 *
 * One manager owns the server process for a build's workspace; agents in
 * `implement`/`verify` reach it only through `ab server
 * start|stop|restart|status|logs` (§8.2) — deterministic, config-driven
 * plumbing, no ad-hoc process hunting. Ownership is enforced with process
 * groups: the start command is spawned detached (its own group leader),
 * every signal goes to the whole group via kill(-pid), and a process-level
 * exit hook SIGKILLs any group still alive — a dead session can never
 * orphan a server (D10).
 *
 * Readiness is a probe (§16.2): any HTTP response from `config.url` counts;
 * `readyTimeout` (seconds — §16.1) bounds the wait, and failures carry the
 * log tail — the feedback loop agents actually need when e2e fails.
 *
 * Time here is physical (real processes, real sockets), so there is no
 * injected Clock; the nondeterministic seams are `fetchFn`, the poll
 * interval, and the kill grace period.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Subprocess } from 'bun'

export interface DevServerConfig {
  /** Shell command — autobuild.toml `[server].start` (§16.1). */
  start: string
  /** Readiness probe target — `[server].url`. */
  url: string
  /** Seconds until the probe gives up — `[server].readyTimeout`. */
  readyTimeout: number
}

export interface DevServerStatus {
  running: boolean
  pid?: number
  url: string
}

export interface DevServerManagerOptions {
  config: DevServerConfig
  cwd: string
  /** Defaults to `<cwd>/.ab/server.log`; appended across restarts. */
  logPath?: string
  /** Probe seam; defaults to global fetch (localhost — offline). */
  fetchFn?: typeof fetch
  /** Probe interval, default 250ms; injectable so tests stay fast. */
  pollIntervalMs?: number
  /** SIGTERM→SIGKILL grace on stop(), default 2000ms. */
  killGraceMs?: number
}

/** `ab server logs` default window; the retained tail is bounded at 500. */
const TAIL_LINES = 500

interface ServerProcess {
  child: Subprocess<'ignore', 'pipe', 'pipe'>
  exited: boolean
  exitCode: number | null
  pumps: Promise<void>[]
}

/**
 * Process groups still owned by some manager. The 'exit' hook is the D10
 * safety net: the kernel guarantees teardown at phase end even when nobody
 * called stop() — e.g. the kernel process itself dies mid-phase.
 */
const liveGroups = new Set<number>()
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  // 'exit' allows no awaiting — kill synchronously.
  process.on('exit', () => {
    for (const pgid of liveGroups) killGroup(pgid, 'SIGKILL')
  })
}

function killGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(-pgid, signal)
  } catch {
    // ESRCH: group already gone — teardown is idempotent.
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export class DevServerManager {
  private readonly config: DevServerConfig
  private readonly cwd: string
  private readonly logPath: string
  private readonly fetchFn: typeof fetch
  private readonly pollIntervalMs: number
  private readonly killGraceMs: number
  /** Bounded in-memory tail of the merged stdout+stderr log. */
  private readonly tail: string[] = []
  private current?: ServerProcess

  constructor(opts: DevServerManagerOptions) {
    this.config = opts.config
    this.cwd = opts.cwd
    this.logPath = opts.logPath ?? join(opts.cwd, '.ab', 'server.log')
    this.fetchFn = opts.fetchFn ?? fetch
    this.pollIntervalMs = opts.pollIntervalMs ?? 250
    this.killGraceMs = opts.killGraceMs ?? 2000
  }

  /**
   * Spawn `config.start` in its own process group and wait for readiness.
   * No-op returning current status when already running. On probe timeout
   * (or the command dying first) the group is killed and the error carries
   * the log tail.
   */
  async start(): Promise<DevServerStatus> {
    const status = this.status()
    if (status.running) return status
    this.reapStale()
    installExitHook()

    mkdirSync(dirname(this.logPath), { recursive: true })
    const child = Bun.spawn(['sh', '-c', this.config.start], {
      cwd: this.cwd,
      // Own process group, so teardown kills the whole tree (D10).
      detached: true,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const running: ServerProcess = { child, exited: false, exitCode: null, pumps: [] }
    running.pumps.push(this.pump(child.stdout), this.pump(child.stderr))
    void child.exited.then((code) => {
      running.exited = true
      running.exitCode = code
    })
    this.current = running
    liveGroups.add(child.pid)

    try {
      await this.probeReady(running)
    } catch (cause) {
      killGroup(child.pid, 'SIGKILL')
      await child.exited
      await this.settlePumps(running)
      liveGroups.delete(child.pid)
      this.current = undefined
      const message = cause instanceof Error ? cause.message : String(cause)
      throw new Error(`${message}\n--- server log tail ---\n${this.tail.join('\n')}`)
    }
    return this.status()
  }

  /** SIGTERM the group, escalate to SIGKILL after the grace period; idempotent. */
  async stop(): Promise<void> {
    const running = this.current
    if (running === undefined) return
    const pgid = running.child.pid
    if (!running.exited) {
      killGroup(pgid, 'SIGTERM')
      await Promise.race([running.child.exited, Bun.sleep(this.killGraceMs)])
    }
    // Sweep group members that outlived (or ignored) SIGTERM. Safe: while any
    // member survives, the pgid cannot be recycled; once all are gone this is
    // an ESRCH no-op.
    killGroup(pgid, 'SIGKILL')
    await running.child.exited
    await this.settlePumps(running)
    liveGroups.delete(pgid)
    this.current = undefined
  }

  async restart(): Promise<DevServerStatus> {
    await this.stop()
    return this.start()
  }

  /** `running` is verified against the real process, not internal state. */
  status(): DevServerStatus {
    const running = this.current
    if (running !== undefined && !running.exited && processAlive(running.child.pid)) {
      return { running: true, pid: running.child.pid, url: this.config.url }
    }
    return { running: false, url: this.config.url }
  }

  /** Last `lines` lines of the merged stdout+stderr tail (§16.2). */
  logs(lines = 100): string[] {
    return this.tail.slice(-lines)
  }

  /**
   * A leader that died without stop() (crash) may leave group members
   * behind; sweep them before spawning a replacement group.
   */
  private reapStale(): void {
    const stale = this.current
    if (stale === undefined) return
    killGroup(stale.child.pid, 'SIGKILL')
    liveGroups.delete(stale.child.pid)
    this.current = undefined
  }

  /** Any HTTP response counts as ready (§16.2); connection errors mean "not yet". */
  private async probeReady(running: ServerProcess): Promise<void> {
    const deadline = Date.now() + this.config.readyTimeout * 1000
    for (;;) {
      if (running.exited) {
        throw new Error(
          `dev server exited with code ${running.exitCode} before becoming ready: ${this.config.start}`,
        )
      }
      try {
        await this.fetchFn(this.config.url)
        return
      } catch {
        // Not listening yet.
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `dev server not ready after ${this.config.readyTimeout}s: no HTTP response from ${this.config.url}`,
        )
      }
      await Bun.sleep(this.pollIntervalMs)
    }
  }

  /** Wait (bounded) for output pumps so error tails include the final lines. */
  private async settlePumps(running: ServerProcess): Promise<void> {
    await Promise.race([Promise.all(running.pumps), Bun.sleep(1000)])
  }

  /** Append raw output to the log file and complete lines to the tail. */
  private async pump(stream: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<void> {
    const decoder = new TextDecoder()
    let partial = ''
    try {
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true })
        appendFileSync(this.logPath, text)
        partial += text
        const lines = partial.split('\n')
        partial = lines.pop() ?? ''
        for (const line of lines) this.pushLine(line)
      }
    } catch {
      // Stream torn down mid-read (group killed): the log has what it has.
    }
    const rest = partial + decoder.decode()
    if (rest.length > 0) this.pushLine(rest)
  }

  private pushLine(line: string): void {
    this.tail.push(line.endsWith('\r') ? line.slice(0, -1) : line)
    if (this.tail.length > TAIL_LINES) this.tail.splice(0, this.tail.length - TAIL_LINES)
  }
}
