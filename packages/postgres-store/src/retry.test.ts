import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { attemptExec, isPlanChangeError, PlanInvalidations, statementKey } from './retry'

describe('isPlanChangeError', () => {
  test('accepts a 0A000 cached-plan result-type error', () => {
    const error = new SQL.PostgresError('cached plan must not change result type', {
      code: 'ERR_POSTGRES_SERVER_ERROR',
      errno: '0A000',
      file: 'plancache.c',
      routine: 'RevalidateCachedQuery',
    })
    expect(isPlanChangeError(error)).toBe(true)
  })

  test('rejects the same errno with an unrelated message', () => {
    const error = new SQL.PostgresError('feature not supported', {
      code: 'ERR_POSTGRES_SERVER_ERROR',
      errno: '0A000',
    })
    expect(isPlanChangeError(error)).toBe(false)
  })

  test('rejects other PostgreSQL errnos', () => {
    for (const errno of ['42P01', '26000', '23505']) {
      const error = new SQL.PostgresError('some other failure', {
        code: 'ERR_POSTGRES_SERVER_ERROR',
        errno,
      })
      expect(isPlanChangeError(error)).toBe(false)
    }
  })

  test('rejects plain errors and non-objects', () => {
    expect(isPlanChangeError(new Error('cached plan must not change result type'))).toBe(false)
    expect(isPlanChangeError('cached plan must not change result type')).toBe(false)
    expect(isPlanChangeError(null)).toBe(false)
    expect(isPlanChangeError(undefined)).toBe(false)
  })
})

describe('PlanInvalidations', () => {
  test('starts unpoisoned and hands out a fresh marker per invalidation', () => {
    const plans = new PlanInvalidations()
    expect(plans.markerFor('SELECT * FROM builds')).toBe('')
    const first = plans.invalidate('SELECT * FROM builds')
    expect(first).toMatch(/^ \/\*ab-plan-retry-s\d+-\d+\*\/$/)
    // Memoized: later executions of the same text skip the poisoned plan.
    expect(plans.markerFor('SELECT * FROM builds')).toBe(first)
    // A second invalidation of the same text (the next migration) yields a
    // different, never-before-prepared marker.
    const second = plans.invalidate('SELECT * FROM builds')
    expect(second).not.toBe(first)
    expect(plans.markerFor('SELECT * FROM builds')).toBe(second)
    // Other texts are unaffected.
    expect(plans.markerFor('SELECT * FROM streams')).toBe('')
  })

  test('markers from different store instances never collide', () => {
    const a = new PlanInvalidations().invalidate('SELECT 1')
    const b = new PlanInvalidations().invalidate('SELECT 1')
    // Two stores sharing a pool must not reuse each other's prepared
    // statement names: a stale variant poisoned by a later migration would
    // otherwise fail the fresh store's retry.
    expect(a).not.toBe(b)
  })
})

describe('attemptExec', () => {
  interface Call {
    strings: TemplateStringsArray
    values: unknown[]
  }

  const recordingConn = () => {
    const calls: Call[] = []
    const unsafeCalls: { text: string; params?: unknown[] }[] = []
    const arrayCalls: { values: unknown[]; type: unknown }[] = []
    const conn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ strings, values })
      return Promise.resolve([])
    }) as unknown as SQL
    ;(conn as { unsafe: unknown }).unsafe = (text: string, params?: unknown[]) => {
      unsafeCalls.push({ text, params })
      return Promise.resolve([])
    }
    ;(conn as { array: unknown }).array = (values: unknown[], type?: unknown) => {
      arrayCalls.push({ values, type })
      return { values, arrayType: type }
    }
    return { conn, calls, unsafeCalls, arrayCalls }
  }

  test('unpoisoned texts forward the template array untouched', async () => {
    const { conn, calls } = recordingConn()
    const { exec } = attemptExec(conn, new PlanInvalidations())
    await exec`SELECT * FROM builds WHERE slug = ${'x'}`
    expect(calls).toHaveLength(1)
    expect(calls[0]?.values).toEqual(['x'])
    // Identity, not equality: the original template object goes through
    // byte-identically, preserving Bun's prepared-statement behavior.
    expect(calls[0]?.strings[0]).toBe('SELECT * FROM builds WHERE slug = ')
    expect(calls[0]?.strings.raw?.[0]).toBe('SELECT * FROM builds WHERE slug = ')
  })

  test('poisoned texts carry the memoized marker on the last raw part, preserving raw', async () => {
    const { conn, calls } = recordingConn()
    const plans = new PlanInvalidations()
    const statement = (exec: ReturnType<typeof attemptExec>['exec']) =>
      exec`SELECT * FROM builds WHERE slug = ${'x'}`
    await statement(attemptExec(conn, plans).exec)
    expect(calls).toHaveLength(1)
    plans.invalidate(statementKey(calls[0]!.strings))

    // The next execution skips the poisoned plan: same values, marked text.
    await statement(attemptExec(conn, plans).exec)
    expect(calls).toHaveLength(2)
    const strings = calls[1]?.strings
    expect(strings).toBeDefined()
    // The raw property survives the copy — without it Bun treats the array
    // as a query value instead of a template.
    expect(strings?.raw).toBeDefined()
    expect(strings?.raw?.[strings.raw.length - 1]).toMatch(/^ \/\*ab-plan-retry-s\d+-\d+\*\/$/)
    expect(strings?.[strings.length - 1]).toBe(strings?.raw?.[strings.length - 1])
    expect(strings?.[0]).toBe('SELECT * FROM builds WHERE slug = ')
    expect(calls[1]?.values).toEqual(['x'])
  })

  test('exec.array forwards to the target and passes the built parameter through untouched', async () => {
    const { conn, calls, arrayCalls } = recordingConn()
    const { exec } = attemptExec(conn, new PlanInvalidations())

    const built = exec.array(['a', 'b'], 'text')
    expect(arrayCalls).toEqual([{ values: ['a', 'b'], type: 'text' }])

    // The built parameter flows into the tagged template as an ordinary
    // value — the `array` path adds no marking of its own (it builds a
    // parameter, not a statement), so the template's raw parts go through
    // untouched.
    const { exec: exec2 } = attemptExec(conn, new PlanInvalidations())
    await exec2`SELECT * FROM ab_tickets WHERE labels @> ${built}`
    expect(calls).toHaveLength(1)
    expect(calls[0]?.values).toEqual([built])
    expect(calls[0]?.strings?.raw?.[0]).toBe('SELECT * FROM ab_tickets WHERE labels @> ')
  })

  test('unsafe text gains the marker only once poisoned; params pass through', async () => {
    const { conn, unsafeCalls } = recordingConn()
    const plans = new PlanInvalidations()
    await attemptExec(conn, plans).exec.unsafe('SELECT * FROM t WHERE repo = $1', ['acme'])
    expect(unsafeCalls[0]).toEqual({ text: 'SELECT * FROM t WHERE repo = $1', params: ['acme'] })

    plans.invalidate('SELECT * FROM t WHERE repo = $1')
    await attemptExec(conn, plans).exec.unsafe('SELECT * FROM t WHERE repo = $1', ['acme'])
    expect(unsafeCalls[1]?.text).toMatch(
      /^SELECT \* FROM t WHERE repo = \$1 \/\*ab-plan-retry-s\d+-\d+\*\/$/,
    )
    expect(unsafeCalls[1]?.params).toEqual(['acme'])
  })

  test('inFlight attributes the failing statement and clears after success', async () => {
    const boom = new SQL.PostgresError('cached plan must not change result type', {
      code: 'ERR_POSTGRES_SERVER_ERROR',
      errno: '0A000',
    })
    const gate = new Promise<never>(() => {})
    let mode: 'gate' | 'boom' | 'ok' = 'ok'
    const conn = (() => {
      if (mode === 'gate') return gate
      if (mode === 'boom') return Promise.reject(boom)
      return Promise.resolve([])
    }) as unknown as SQL
    ;(conn as { unsafe: unknown }).unsafe = () => Promise.resolve([])
    const attempt = attemptExec(conn, new PlanInvalidations())

    // In flight while the statement is pending.
    mode = 'gate'
    void attempt.exec`SELECT * FROM builds`
    expect(attempt.inFlight).toBe('SELECT * FROM builds')

    // Still attributed after a rejection — that is what the runner's catch
    // reads to decide which text to invalidate.
    mode = 'boom'
    await attempt.exec`SELECT * FROM streams`.catch(() => {})
    expect(attempt.inFlight).toBe('SELECT * FROM streams')

    // Cleared once a statement resolves cleanly.
    mode = 'ok'
    await attempt.exec`SELECT 1`
    expect(attempt.inFlight).toBeNull()
  })

  test('retry mode freshly mints and memoizes a marker for every statement', async () => {
    const { conn, calls } = recordingConn()
    const plans = new PlanInvalidations()
    // Poison two texts before the retry (earlier migrations' variants, all
    // themselves stale now); a third text was never poisoned at all.
    const stale = plans.invalidate('SELECT * FROM builds')
    plans.invalidate('SELECT * FROM sessions')

    const retry = attemptExec(conn, plans, true)
    await retry.exec`SELECT * FROM builds`
    await retry.exec`SELECT * FROM streams`
    await retry.exec`SELECT * FROM sessions`

    expect(calls).toHaveLength(3)
    // No memoized marker is reused — each was minted before the migration
    // that triggered this retry, so its plan is poisoned too; fresh
    // variants are minted and memoized instead.
    expect(String(calls[0]?.strings?.raw?.[0])).toBe(
      `SELECT * FROM builds${plans.markerFor('SELECT * FROM builds')}`,
    )
    expect(plans.markerFor('SELECT * FROM builds')).not.toBe(stale)
    expect(String(calls[1]?.strings?.raw?.[0])).toBe(
      `SELECT * FROM streams${plans.markerFor('SELECT * FROM streams')}`,
    )
    // Every fresh variant is memoized, so later normal-path executions skip
    // the poisoned plans entirely.
    for (const text of [
      'SELECT * FROM builds',
      'SELECT * FROM streams',
      'SELECT * FROM sessions',
    ]) {
      expect(plans.markerFor(text)).toMatch(/^ \/\*ab-plan-retry-s\d+-\d+\*\/$/)
    }
  })

  test('retry mode marks unsafe texts the same way', async () => {
    const { conn, unsafeCalls } = recordingConn()
    const plans = new PlanInvalidations()
    await attemptExec(conn, plans, true).exec.unsafe('SELECT * FROM streams WHERE id = $1', [
      'st_x',
    ])
    expect(unsafeCalls[0]?.text).toBe(
      `SELECT * FROM streams WHERE id = $1${plans.markerFor('SELECT * FROM streams WHERE id = $1')}`,
    )
  })

  test('outside retry mode a memoized marker is reused, never re-minted', async () => {
    const { conn, calls } = recordingConn()
    const plans = new PlanInvalidations()
    const marker = plans.invalidate('SELECT * FROM builds')
    await attemptExec(conn, plans).exec`SELECT * FROM builds`
    expect(plans.markerFor('SELECT * FROM builds')).toBe(marker)
    expect(String(calls[0]?.strings?.raw?.[0])).toBe(`SELECT * FROM builds${marker}`)
  })
})
