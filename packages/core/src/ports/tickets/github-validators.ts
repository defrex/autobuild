/**
 * Durable conditional-read validators for the `github` ticket source.
 *
 * A dispatcher tick re-reads the same GitHub resources (the ready listing,
 * each candidate's blockers) every few seconds. Sending the last response's
 * ETag as `If-None-Match` turns an unchanged read into a 304, which costs no
 * primary rate-limit budget. Keeping those validators under the local state
 * root lets restarts and fresh CLI processes stay at zero too. Nothing here
 * touches the BuildStore or the hosted service.
 *
 * Entries are evicted by age, never by count: a working set of any size
 * stays warm, and an entry unused for {@link VALIDATOR_MAX_AGE_MS} goes.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One remembered GET: the response's ETag, its JSON, and its `Link` header. */
export interface GitHubValidatorEntry {
  etag: string
  json: unknown
  link?: string
}

export interface GitHubValidatorStore {
  get(key: string): Promise<GitHubValidatorEntry | undefined>
  /** Save an entry; rewriting is skipped when the ETag did not change. */
  set(key: string, entry: GitHubValidatorEntry): Promise<void>
  /** Record a hit (a 304 or a reused entry) as a use. */
  touch(key: string): Promise<void>
}

/** An entry unused this long is evicted. */
export const VALIDATOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** A hit refreshes last-used at most this often, so hits rarely write. */
export const VALIDATOR_TOUCH_INTERVAL_MS = 60 * 60 * 1000
/** The file store lists its directory to evict at most this often. */
export const VALIDATOR_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

export class MemoryGitHubValidatorStore implements GitHubValidatorStore {
  private readonly entries = new Map<string, { entry: GitHubValidatorEntry; usedAt: number }>()
  private readonly now: () => number

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now
  }

  /** Number of live entries, for tests. */
  get size(): number {
    this.evict()
    return this.entries.size
  }

  async get(key: string): Promise<GitHubValidatorEntry | undefined> {
    this.evict()
    return this.entries.get(key)?.entry
  }

  async set(key: string, entry: GitHubValidatorEntry): Promise<void> {
    this.entries.set(key, { entry, usedAt: this.now() })
  }

  async touch(key: string): Promise<void> {
    const held = this.entries.get(key)
    if (held !== undefined && this.now() - held.usedAt > VALIDATOR_TOUCH_INTERVAL_MS)
      held.usedAt = this.now()
  }

  private evict(): void {
    const cutoff = this.now() - VALIDATOR_MAX_AGE_MS
    for (const [key, held] of this.entries) if (held.usedAt < cutoff) this.entries.delete(key)
  }
}

const SWEEP_MARKER = '.swept'

/**
 * One JSON file per entry, named by the sha256 of its key. Writes go through a
 * temp file and `rename`, so a dispatcher and concurrent CLI processes never
 * see a torn entry and need no lock; two writers of one key leave the last
 * write, which has the same meaning. A file's mtime is its last use. A
 * per-process map fronts the files, so a key costs at most one file read per
 * process. A corrupt or unreadable file is a miss and is overwritten.
 */
export class FileGitHubValidatorStore implements GitHubValidatorStore {
  private readonly front = new Map<string, { entry: GitHubValidatorEntry; usedAt: number }>()
  private readonly now: () => number
  private readonly touchFile: (path: string, at: Date) => Promise<void>
  private swept?: Promise<void>

  constructor(
    readonly dir: string,
    opts: {
      now?: () => number
      /** Last-used refresh seam; tests count calls through it. */
      utimes?: (path: string, at: Date) => Promise<void>
    } = {},
  ) {
    this.now = opts.now ?? Date.now
    this.touchFile = opts.utimes ?? ((path, at) => utimes(path, at, at))
  }

  private file(key: string): string {
    return join(this.dir, `${createHash('sha256').update(key).digest('hex')}.json`)
  }

  async get(key: string): Promise<GitHubValidatorEntry | undefined> {
    await this.sweep()
    const held = this.front.get(key)
    if (held !== undefined) return held.entry
    const path = this.file(key)
    try {
      const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
      if (this.now() - info.mtimeMs > VALIDATOR_MAX_AGE_MS) return undefined
      const parsed = JSON.parse(raw) as {
        key?: unknown
        etag?: unknown
        json?: unknown
        link?: unknown
      }
      if (parsed.key !== key || typeof parsed.etag !== 'string') return undefined
      const entry: GitHubValidatorEntry = {
        etag: parsed.etag,
        json: parsed.json,
        ...(typeof parsed.link === 'string' ? { link: parsed.link } : {}),
      }
      this.front.set(key, { entry, usedAt: info.mtimeMs })
      return entry
    } catch {
      return undefined
    }
  }

  async set(key: string, entry: GitHubValidatorEntry): Promise<void> {
    const held = this.front.get(key)
    if (held !== undefined && held.entry.etag === entry.etag) {
      held.entry = entry
      await this.touch(key)
      return
    }
    const path = this.file(key)
    const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await mkdir(this.dir, { recursive: true })
      await writeFile(temp, JSON.stringify({ key, ...entry }))
      await rename(temp, path)
      // The mtime is the entry's last use, on the store's clock.
      const at = new Date(this.now())
      await utimes(path, at, at)
      this.front.set(key, { entry, usedAt: at.getTime() })
    } catch {
      // A validator is an optimization; failing to save one costs only a
      // future unconditional read.
      await unlink(temp).catch(() => {})
    }
  }

  async touch(key: string): Promise<void> {
    const held = this.front.get(key)
    if (held === undefined || this.now() - held.usedAt <= VALIDATOR_TOUCH_INTERVAL_MS) return
    held.usedAt = this.now()
    await this.touchFile(this.file(key), new Date(held.usedAt)).catch(() => {})
  }

  /** Evict entries unused for the maximum age, at most once a day across
   * processes (gated by the marker file's mtime). Local disk only. */
  private sweep(): Promise<void> {
    this.swept ??= (async () => {
      const marker = join(this.dir, SWEEP_MARKER)
      try {
        const info = await stat(marker)
        if (this.now() - info.mtimeMs < VALIDATOR_SWEEP_INTERVAL_MS) return
      } catch {
        // No marker yet: sweep (an empty or missing directory costs nothing).
      }
      try {
        const cutoff = this.now() - VALIDATOR_MAX_AGE_MS
        for (const name of await readdir(this.dir)) {
          if (!name.endsWith('.json')) continue
          const path = join(this.dir, name)
          const info = await stat(path).catch(() => undefined)
          if (info !== undefined && info.mtimeMs < cutoff) await unlink(path).catch(() => {})
        }
        await mkdir(this.dir, { recursive: true })
        await writeFile(marker, '')
        const at = new Date(this.now())
        await utimes(marker, at, at)
      } catch {
        // Eviction is housekeeping; a failure leaves entries for the next day.
      }
    })()
    return this.swept
  }
}
