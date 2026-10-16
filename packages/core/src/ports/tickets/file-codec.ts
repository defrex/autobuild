import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { z } from 'zod'

const frontmatterSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  labels: z.array(z.string()).default([]),
  /** Source-local blocker ids (§13). Absent ≡ no dependencies, which keeps
   * every pre-existing ticket file valid. */
  blockedBy: z.array(z.string()).optional(),
  /** Stable external-create adoption key. It travels with the ticket across
   * state-directory moves, so retries find it in any lifecycle state. */
  idempotencyKey: z.string().min(1).optional(),
})
export type Frontmatter = z.infer<typeof frontmatterSchema>

const OPEN_FENCE = '+++\n'
const CLOSE_FENCE = '\n+++\n'

/** A malformed record that a complete tracker scan may safely exclude. This is
 * deliberately narrower than ordinary Error: filesystem failures, layout
 * violations, duplicate ids, and unexpected exceptions must still abort the
 * listing. */
export class TicketFileValidationError extends Error {
  override readonly name = 'TicketFileValidationError'
}

export function parseTicketFile(path: string, raw: string): { front: Frontmatter; body: string } {
  if (!raw.startsWith(OPEN_FENCE)) {
    throw new TicketFileValidationError(
      `${path}: malformed ticket file — missing opening "+++" fence`,
    )
  }
  const close = raw.indexOf(CLOSE_FENCE, OPEN_FENCE.length)
  if (close === -1) {
    throw new TicketFileValidationError(
      `${path}: malformed ticket file — missing closing "+++" fence`,
    )
  }
  let parsed: unknown
  try {
    parsed = parseToml(raw.slice(OPEN_FENCE.length, close))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new TicketFileValidationError(`${path}: malformed TOML frontmatter — ${message}`)
  }
  const result = frontmatterSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new TicketFileValidationError(`${path}: invalid frontmatter — ${issues}`)
  }
  return { front: result.data, body: raw.slice(close + CLOSE_FENCE.length) }
}

export function serializeTicketFile(front: Frontmatter, body: string): string {
  const data: Record<string, unknown> = { id: front.id, title: front.title }
  if (front.labels.length > 0) data.labels = front.labels
  // Only when nonempty: a file that never declared blockers must round-trip
  // byte-identically rather than sprouting `blockedBy = []` on every write.
  if (front.blockedBy !== undefined && front.blockedBy.length > 0) {
    data.blockedBy = front.blockedBy
  }
  if (front.idempotencyKey !== undefined) {
    data.idempotencyKey = front.idempotencyKey
  }
  // smol-toml stringify ends with a newline; the closing fence follows it.
  return `${OPEN_FENCE}${stringifyToml(data)}+++\n${body}`
}
