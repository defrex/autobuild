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
 * re-preparing the statement fresh: appending a unique trailing comment to
 * the query text gives it a new statement name, so Bun parses and prepares it
 * again and the fresh plan sees the new schema. That is why the retry path
 * below marks statement text instead of merely re-executing it.
 */

/** The plan-invalidation failure class: SQLSTATE 0A000 naming the cached
 * plan's result-type change. Anything else is not a plan change. */
export function isPlanChangeError(error: unknown): boolean {
  return (
    error instanceof SQL.PostgresError &&
    error.errno === '0A000' &&
    /cached plan must not change result type/.test(error.message)
  )
}

/** Build the per-attempt executor for one pinned connection. With an empty
 * marker (first attempt) every call is forwarded verbatim, so normal-path
 * prepared-statement behavior is unchanged. With a marker, statement text
 * gains a unique trailing comment (see the module comment for why), forcing a
 * fresh prepare of the same statement. */
export function attemptExec(conn: SQL, marker: string): Exec {
  const exec = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (marker === '') return conn(strings, ...values)
    // Copy the template array and mark the last raw part. A plain array copy
    // drops the non-enumerable `raw` property — without it Bun treats the
    // array as a query *value*, not a template — so re-attach it, pointing at
    // the marked copy itself (comment-only changes make cooked and raw
    // identical).
    const parts: string[] = [...strings]
    parts[parts.length - 1] += marker
    Object.assign(parts, { raw: parts })
    return conn(parts as unknown as TemplateStringsArray, ...values)
  }) as unknown as Exec
  exec.unsafe = (text: string, params?: unknown[]) =>
    marker === '' ? conn.unsafe(text, params) : conn.unsafe(`${text}${marker}`, params)
  return exec
}
