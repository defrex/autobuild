/**
 * File-based TicketSource (SPEC §3.2, §13): a directory of `<id>.md` files,
 * TOML frontmatter between `+++` fences, then the ticket body — where the
 * spec lives pre-build (§6.3). This adapter is the policy's proof: a source
 * with nowhere to put blobs must be fully workable, because the tracker
 * initiates and receives projections only — never consulted mid-build,
 * never artifact storage.
 *
 * Concurrency: claim (and every other write) is read-check-write, not a
 * filesystem lock. That is atomic *enough* by design — the dispatcher is the
 * single writer (SPEC §12 single-writer discipline), so the guard defends
 * against re-dispatch across runs, not against concurrent writers.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { z } from 'zod'
import { systemClock, type Clock } from '../../store/types'
import type { Ticket, TicketDraft, TicketSource } from '../types'

const frontmatterSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  state: z.string().min(1),
  labels: z.array(z.string()),
  claimedBy: z.string().optional(),
})
type Frontmatter = z.infer<typeof frontmatterSchema>

const OPEN_FENCE = '+++\n'
const CLOSE_FENCE = '\n+++\n'

function parseTicketFile(
  path: string,
  raw: string,
): { front: Frontmatter; body: string } {
  if (!raw.startsWith(OPEN_FENCE)) {
    throw new Error(`${path}: malformed ticket file — missing opening "+++" fence`)
  }
  const close = raw.indexOf(CLOSE_FENCE, OPEN_FENCE.length)
  if (close === -1) {
    throw new Error(`${path}: malformed ticket file — missing closing "+++" fence`)
  }
  let parsed: unknown
  try {
    parsed = parseToml(raw.slice(OPEN_FENCE.length, close))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${path}: malformed TOML frontmatter — ${message}`)
  }
  const result = frontmatterSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new Error(`${path}: invalid frontmatter — ${issues}`)
  }
  return { front: result.data, body: raw.slice(close + CLOSE_FENCE.length) }
}

function serializeTicketFile(front: Frontmatter, body: string): string {
  const data: Record<string, unknown> = {
    id: front.id,
    title: front.title,
    state: front.state,
    labels: front.labels,
  }
  if (front.claimedBy !== undefined) data.claimedBy = front.claimedBy
  // smol-toml stringify ends with a newline; the closing fence follows it.
  return `${OPEN_FENCE}${stringifyToml(data)}+++\n${body}`
}

export class FileTicketSource implements TicketSource {
  readonly name = 'file'

  private readonly dir: string
  private readonly clock: Clock
  private readonly claimant: string
  private readonly createState: string

  constructor(opts: {
    dir: string
    /** Injectable for deterministic comment timestamps. */
    clock?: Clock
    /** Value written to `claimedBy` on claim (e.g. a dispatcher instance id). */
    claimant?: string
    /** State assigned by create — proposals land in Triage (SPEC §12). */
    createState?: string
  }) {
    this.dir = opts.dir
    this.clock = opts.clock ?? systemClock
    this.claimant = opts.claimant ?? 'dispatcher'
    this.createState = opts.createState ?? 'Triage'
  }

  async listReady(criteria: {
    labels?: string[]
    state?: string
  }): Promise<Ticket[]> {
    const labels = criteria.labels ?? []
    const tickets = await this.listAll()
    return tickets.filter(
      (ticket) =>
        (criteria.state === undefined || ticket.state === criteria.state) &&
        labels.every((label) => ticket.labels.includes(label)),
    )
  }

  async get(id: string): Promise<Ticket | null> {
    const loaded = await this.load(id)
    return loaded ? this.toTicket(loaded.front, loaded.body) : null
  }

  /**
   * Claim-before-launch (SPEC §12): read-check-write on `claimedBy`. See the
   * module comment for why no stronger atomicity is needed.
   */
  async claim(id: string): Promise<boolean> {
    const loaded = await this.load(id)
    if (!loaded || loaded.front.claimedBy !== undefined) return false
    await this.write(id, { ...loaded.front, claimedBy: this.claimant }, loaded.body)
    return true
  }

  /**
   * Projections flow outward only (SPEC §13): the comment is appended below
   * the existing content, which is preserved byte-exactly — the spec in the
   * body (§6.3) is never rewritten.
   */
  async comment(id: string, body: string): Promise<void> {
    const path = this.path(id)
    const raw = await this.read(path)
    if (raw === null) {
      throw new Error(`file ticket source: comment on unknown ticket "${id}"`)
    }
    parseTicketFile(path, raw) // surface malformed files before appending
    const separator = raw.endsWith('\n') ? '\n' : '\n\n'
    const stamp = this.clock().toISOString()
    await writeFile(path, `${raw}${separator}## Comment (${stamp})\n\n${body}\n`)
  }

  async transition(id: string, state: string): Promise<void> {
    const loaded = await this.load(id)
    if (!loaded) {
      throw new Error(`file ticket source: transition on unknown ticket "${id}"`)
    }
    await this.write(id, { ...loaded.front, state }, loaded.body)
  }

  /** Writes `file-<n>.md` with the next free n (gaps are reused). */
  async create(draft: TicketDraft): Promise<Ticket> {
    await mkdir(this.dir, { recursive: true })
    const existing = new Set(await readdir(this.dir))
    let n = 1
    while (existing.has(`file-${n}.md`)) n += 1
    const front: Frontmatter = {
      id: `file-${n}`,
      title: draft.title,
      state: this.createState,
      labels: [...(draft.labels ?? [])],
    }
    await this.write(front.id, front, draft.body)
    return this.toTicket(front, draft.body)
  }

  private path(id: string): string {
    if (id.includes('/') || id.includes('\\') || id.includes('..')) {
      throw new Error(`file ticket source: invalid ticket id "${id}"`)
    }
    return join(this.dir, `${id}.md`)
  }

  private async read(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async load(
    id: string,
  ): Promise<{ front: Frontmatter; body: string } | null> {
    const path = this.path(id)
    const raw = await this.read(path)
    if (raw === null) return null
    const loaded = parseTicketFile(path, raw)
    if (loaded.front.id !== id) {
      throw new Error(
        `${path}: frontmatter id "${loaded.front.id}" does not match filename`,
      )
    }
    return loaded
  }

  private async write(id: string, front: Frontmatter, body: string): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.path(id), serializeTicketFile(front, body))
  }

  private async listAll(): Promise<Ticket[]> {
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const tickets: Ticket[] = []
    for (const entry of entries.filter((e) => e.endsWith('.md')).sort()) {
      const id = entry.slice(0, -'.md'.length)
      const loaded = await this.load(id)
      if (loaded) tickets.push(this.toTicket(loaded.front, loaded.body))
    }
    return tickets
  }

  private toTicket(front: Frontmatter, body: string): Ticket {
    return {
      ref: { source: this.name, id: front.id, title: front.title },
      title: front.title,
      body,
      state: front.state,
      labels: [...front.labels],
    }
  }
}
