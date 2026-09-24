import { SQL } from 'bun'

export type Row = Record<string, unknown>

/**
 * The executor handed to store operation bodies: a thin forwarder onto one
 * pinned pooled connection. Callable as a tagged template (the normal
 * parameterized path) plus `unsafe` for pre-built statement text.
 */
export type Exec = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>
  unsafe(text: string, params?: unknown[]): Promise<Row[]>
}

/**
 * When a migration adds a column to a table, PostgreSQL backends holding a
 * cached plan for a statement returning `*` from that table fail the next
 * execution with SQLSTATE 0A000, "cached plan must not change result type".
 * The server invalidates the plan, but Bun (1.4.x) names prepared statements
 * deterministically from the query text and reuses them for the connection's
 * lifetime — so every subsequent execution of the same text on that
 * connection is revalidated and rejected again; the plan is never silently
 * rebuilt. A bare same-connection retry therefore does not recover, and
 * `DEALLOCATE ALL` is unusable too: it clears the server-side statements but
 * Bun never evicts its client-side text→statement map, so the retried
 * statement (and every other one) then fails with 26000 forever.
 *
 * What does recover, deterministically and on the same connection, is
 * re-preparing the statement fresh: appending a marker comment to the query
 * text gives it a new statement name, so Bun parses and prepares it again
 * and the fresh plan sees the new schema.
 *
 * The marker must do more than make the one retry succeed, though. If every
 * retry invented a fresh unique marker, the *original* text would stay
 * poisoned forever: each later operation on the connection would first fail
 * 0A000 and then prepare yet another variant — a permanent failed round trip
 * per operation and an unbounded prepared-statement leak. So the marker is
 * also **memoized**: the first plan-change failure for a statement text
 * records a marked variant for that text, and every later execution — on any
 * pooled connection — skips the poisoned plan and goes straight to the
 * healed variant. The cost of a migration then stays what the incident
 * model predicts (one failed execution per connection per statement) and the
 * statement growth is bounded by the migration count, not request volume.
 *
 * The memo is per store instance and its markers are namespaced with a
 * per-instance id, so two stores sharing one pool never reuse each other's
 * prepared statement names (a fresh store's memo may lag; its own failure
 * then heals under its own namespace instead of colliding with a stale
 * variant another store prepared before a later migration).
 */

/** Distinguishes statement texts inside the memo. Raw parts joined by NUL —
 * NUL cannot appear in a PostgreSQL statement, so the join is collision-free,
 * and raw (not cooked) is what the server actually sees. */
export function statementKey(strings: TemplateStringsArray): string {
  return (strings.raw ?? strings).join('\u0000')
}

/** The plan-invalidation failure class: SQLSTATE 0A000 naming the cached
 * plan's result-type change. Anything else is not a plan change. */
export function isPlanChangeError(error: unknown): boolean {
  return (
    error instanceof SQL.PostgresError &&
    error.errno === '0A000' &&
    /cached plan must not change result type/.test(error.message)
  )
}

let memoSequence = 0

/** The per-store memo of poisoned statement texts (see the module comment). */
export class PlanInvalidations {
  private readonly id: string
  private counter = 0
  private readonly markers = new Map<string, string>()

  constructor() {
    this.id = `s${++memoSequence}`
  }

  /** The marker currently appended to `text`: `''` while the plain text is
   * still the right thing to execute, or the marked suffix once the text's
   * plan has been invalidated, so executions skip the poisoned plan. */
  markerFor(text: string): string {
    return this.markers.get(text) ?? ''
  }

  /** Record a plan invalidation for `text` and return its fresh marker —
   * unique per store instance and never prepared before, so the next
   * execution of the text re-prepares it under a brand-new name. */
  invalidate(text: string): string {
    const marker = ` /*ab-plan-retry-${this.id}-${++this.counter}*/`
    this.markers.set(text, marker)
    return marker
  }
}

/** One execution attempt on a connection (or transaction executor): the
 * executor store bodies run their statements through, plus attribution for
 * which statement was in flight when the attempt failed. */
export interface Attempt {
  exec: Exec
  /** The statement text most recently dispatched and not resolved
   * successfully — `null` after a clean statement, still set after a
   * rejection. The runner's catch reads it to attribute a plan-change
   * failure to the exact statement. Bodies execute statements sequentially,
   * so this is the failing statement; concurrent misattribution would at
   * worst over-mark a healthy text, which only costs one extra variant. */
  inFlight: string | null
}

/** Build the per-attempt executor for one connection. Unpoisoned texts are
 * forwarded verbatim, so normal-path prepared-statement behavior is
 * unchanged; poisoned texts get their memoized marker appended (see the
 * module comment), and `attempt.inFlight` tracks the statement text in
 * flight for failure attribution. */
export function attemptExec(target: SQL, plans: PlanInvalidations): Attempt {
  const attempt: Attempt = { exec: undefined as unknown as Exec, inFlight: null }
  /** Dispatch one call, keeping `inFlight` set while (and after) it fails,
   * clearing it once it succeeds. */
  const dispatch = (key: string, call: () => Promise<Row[]>): Promise<Row[]> => {
    attempt.inFlight = key
    return Promise.resolve(call()).then((rows) => {
      attempt.inFlight = null
      return rows
    })
  }
  const exec = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const key = statementKey(strings)
    const marker = plans.markerFor(key)
    return dispatch(key, () => {
      if (marker === '') return target(strings, ...values)
      // Copy the template array and mark the last raw part. A plain array
      // copy drops the non-enumerable `raw` property — without it Bun treats
      // the array as a query *value*, not a template — so re-attach it,
      // pointing at the marked copy itself (comment-only changes make cooked
      // and raw identical).
      const parts: string[] = [...strings]
      parts[parts.length - 1] += marker
      Object.assign(parts, { raw: parts })
      return target(parts as unknown as TemplateStringsArray, ...values)
    })
  }) as unknown as Exec
  exec.unsafe = (text: string, params?: unknown[]) => {
    const marker = plans.markerFor(text)
    return dispatch(text, () =>
      marker === '' ? target.unsafe(text, params) : target.unsafe(`${text}${marker}`, params),
    )
  }
  attempt.exec = exec
  return attempt
}
