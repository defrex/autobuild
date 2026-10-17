import type { SQL } from 'bun'

/** Transparent tag/pool instrumentation, including reserved and transaction connections. */
export function countSql(sql: SQL, statements: string[]): SQL {
  const fragments = new WeakMap<object, string>()
  function wrap(target: SQL): SQL {
    return new Proxy(target, {
      apply(fn, receiver, args) {
        const [parts, ...values] = args
        const text = Array.isArray(parts)
          ? parts.map((part, i) => part + (fragments.get(values[i]) ?? '')).join('')
          : ''
        const result = Reflect.apply(fn, receiver, args)
        if (/^\s*(SELECT|INSERT|UPDATE|DELETE)/i.test(text)) statements.push(text)
        else if (result && typeof result === 'object') fragments.set(result, text)
        return result
      },
      get(fn, key) {
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
