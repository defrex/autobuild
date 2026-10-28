import type { SQL } from 'bun'

/** Transparent tag/pool instrumentation, including reserved and transaction connections. */
export function countSql(sql: SQL, statements: string[] | (() => string[])): SQL {
  const record = (text: string) =>
    (typeof statements === 'function' ? statements() : statements).push(text)
  const fragments = new WeakMap<object, string>()
  function wrap(target: SQL): SQL {
    return new Proxy(target, {
      apply(fn, receiver, args) {
        const [parts, ...values] = args
        const text = Array.isArray(parts)
          ? parts
              .map(
                (part, i) =>
                  part +
                  (fragments.get(values[i]) ??
                    // Record only the public lock IDs, never credentials or query data.
                    (values[i] === 470281942 || values[i] === 470281943 ? String(values[i]) : '')),
              )
              .join('')
          : ''
        const result = Reflect.apply(fn, receiver, args)
        if (/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)/i.test(text)) record(text)
        else if (result && typeof result === 'object') fragments.set(result, text)
        return result
      },
      get(fn, key) {
        if (key === 'unsafe')
          return (text: string, params?: unknown[]) => {
            record(text)
            return fn.unsafe(text, params)
          }
        if (key === 'reserve') return async () => wrap(await fn.reserve())
        if (key === 'begin')
          return (work: (tx: SQL) => unknown) => fn.begin((tx) => work(wrap(tx as SQL)))
        const value = Reflect.get(fn, key)
        return typeof value === 'function' ? value.bind(fn) : value
      },
    })
  }
  return wrap(sql)
}

/** Full registration/deletion admission and transaction generation fences are
 * separate budgets: only the latter scale with mutation transaction count. */
export function projectQueryCounts(statements: readonly string[]) {
  return {
    admissions: statements.filter((s) => /\bproject_journal\b/i.test(s)).length,
    boundaries: statements.filter(
      (s) => /FROM project_generations\b/i.test(s) && /FOR SHARE\b/i.test(s),
    ).length,
    lifecycleLocks: statements.filter(
      (s) => /pg_advisory_xact_lock(?:_shared)?\(/i.test(s) && s.includes('470281942'),
    ).length,
  }
}
