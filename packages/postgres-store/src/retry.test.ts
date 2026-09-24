import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { attemptExec, isPlanChangeError } from './retry'

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

describe('attemptExec', () => {
  interface Call {
    strings: TemplateStringsArray
    values: unknown[]
  }

  const recordingConn = () => {
    const calls: Call[] = []
    const unsafeCalls: { text: string; params?: unknown[] }[] = []
    const conn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ strings, values })
      return Promise.resolve([])
    }) as unknown as SQL
    ;(conn as { unsafe: unknown }).unsafe = (text: string, params?: unknown[]) => {
      unsafeCalls.push({ text, params })
      return Promise.resolve([])
    }
    return { conn, calls, unsafeCalls }
  }

  test('first attempt forwards the template array untouched', async () => {
    const { conn, calls } = recordingConn()
    const exec = attemptExec(conn, '')
    await exec`SELECT * FROM builds WHERE slug = ${'x'}`
    expect(calls).toHaveLength(1)
    expect(calls[0]?.values).toEqual(['x'])
    // Identity, not equality: the original template object goes through
    // byte-identically, preserving Bun's prepared-statement behavior.
    expect(calls[0]?.strings[0]).toBe('SELECT * FROM builds WHERE slug = ')
    expect(calls[0]?.strings.raw?.[0]).toBe('SELECT * FROM builds WHERE slug = ')
  })

  test('retry attempt appends the marker to the last raw part and preserves raw', async () => {
    const { conn, calls } = recordingConn()
    const exec = attemptExec(conn, ' /*ab-plan-retry-1*/')
    await exec`SELECT * FROM builds WHERE slug = ${'x'}`
    const strings = calls[0]?.strings
    expect(strings).toBeDefined()
    // The raw property survives the copy — without it Bun treats the array
    // as a query value instead of a template.
    expect(strings?.raw).toBeDefined()
    expect(strings?.raw?.[strings.raw.length - 1]).toBe(' /*ab-plan-retry-1*/')
    expect(strings?.[strings.length - 1]).toBe(' /*ab-plan-retry-1*/')
    expect(strings?.[0]).toBe('SELECT * FROM builds WHERE slug = ')
    expect(calls[0]?.values).toEqual(['x'])
  })

  test('retry attempt appends the marker to unsafe text and passes params through', async () => {
    const { conn, unsafeCalls } = recordingConn()
    const first = attemptExec(conn, '')
    await first.unsafe('SELECT * FROM t WHERE repo = $1', ['acme'])
    expect(unsafeCalls[0]).toEqual({ text: 'SELECT * FROM t WHERE repo = $1', params: ['acme'] })
    const retry = attemptExec(conn, ' /*ab-plan-retry-2*/')
    await retry.unsafe('SELECT * FROM t WHERE repo = $1', ['acme'])
    expect(unsafeCalls[1]).toEqual({
      text: 'SELECT * FROM t WHERE repo = $1 /*ab-plan-retry-2*/',
      params: ['acme'],
    })
  })
})
