const READ = /^(get|list|read|load|count)/u

/**
 * Wrap a store so only reads pass. `ab web` holds the store through this
 * guard, so no endpoint can append an event or change build, ticket or
 * repository state, whatever a later view calls. Calls run with the real
 * store as `this`, so an adapter's internal bookkeeping inside a read (a
 * saved reduced value, for instance) stays internal.
 */
export function readOnlyStore<T extends object>(store: T): T {
  return new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof value !== 'function') return value
      const name = String(key)
      if (READ.test(name) || name === 'close')
        return (...args: unknown[]) => Reflect.apply(value, target, args)
      return () => {
        throw new Error(`ab web is read-only: ${name}`)
      }
    },
  })
}
