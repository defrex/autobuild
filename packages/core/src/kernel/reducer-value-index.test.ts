/** Selective value registrations are the catalog's: same identity, version,
 * scope, arguments, key and served value, so a reader resolving through the
 * index reads and advances the same saved row as every other reader. */
import { expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import type { RepositoryEvent } from '../events/repository'
import { reducerValueRequestSchema, resolveRegisteredValue } from '../store/reducer-value-read'
import { takeoverJournal, yieldedNewcomerJournal } from '../testing/dispatch-journals'
import { upgradeGenerationWrites } from '../testing/upgrade-generations'
import { REDUCERS } from './reducer-registry'
import { loadValueRegistration, SELECTIVE_VALUE_REGISTRATIONS } from './reducer-value-index'

const scope = { kind: 'repo' as const, repo: '/repo' }
const outcome = (run: () => unknown) => {
  try {
    return { ok: run() }
  } catch (error) {
    return { error: String(error) }
  }
}
const corpus: RepositoryEvent[] = [...takeoverJournal(), ...yieldedNewcomerJournal()]
for (const write of [...upgradeGenerationWrites(0), ...upgradeGenerationWrites(1)])
  corpus.push({
    ...write,
    actor: DISPATCHER,
    repo: '/repo',
    ts: '2026-01-01T00:00:00.000Z',
  } as RepositoryEvent)
for (const [index, event] of corpus.entries()) Object.assign(event, { seq: index + 1 })

test.each(SELECTIVE_VALUE_REGISTRATIONS.map((name) => [name]))(
  '%s resolves selectively exactly as the catalog does',
  async (name) => {
    const catalog = REDUCERS[name]!
    const selective = (await loadValueRegistration(name))!
    expect(selective).not.toBe(catalog)
    const [entry, expected] = [selective.valueRead, catalog.valueRead]
    if ('excluded' in entry || 'excluded' in expected) throw new Error(`${name} is excluded`)
    expect(selective.reducer.identity).toBe(catalog.reducer.identity)
    expect(selective.reducer.version).toBe(catalog.reducer.version)
    expect(selective.covers).toEqual(catalog.covers)
    expect(entry.scope).toBe(expected.scope)
    const argsCases = [{}, { run: 'x' }, { run: 'x', extra: 1 }, { run: '' }]
    for (const args of argsCases)
      expect(outcome(() => entry.args.parse(args))).toEqual(
        outcome(() => expected.args.parse(args)),
      )
    const request = reducerValueRequestSchema.parse({
      reducer: name,
      ...(name === 'dispatcherRunFacts' ? { args: { run: 'run-a' } } : {}),
    })
    const mine = resolveRegisteredValue(scope, request, selective)
    const theirs = resolveRegisteredValue(scope, request, catalog)
    expect(mine.identity).toBe(theirs.identity)
    expect(mine.key).toBe(theirs.key)
    expect(mine.reducer.version).toBe(theirs.reducer.version)
    const fold = (resolved: typeof mine) => {
      const acc = resolved.reducer.advance(resolved.reducer.initial(), resolved.entry.adapt(corpus))
      return {
        valid: resolved.entry.validate(structuredClone(acc)),
        value: resolved.entry.value(resolved.reducer.finish(acc)),
      }
    }
    const folded = fold(mine)
    expect(folded.valid).toBe(true)
    expect(folded).toEqual(fold(theirs))
  },
)

test('other names resolve through the catalog with its errors', async () => {
  expect(await loadValueRegistration('build')).toBe(REDUCERS.build!)
  expect(await loadValueRegistration('noSuchReducer')).toBeUndefined()
  for (const reducer of ['noSuchReducer', 'journalView', 'build']) {
    const request = reducerValueRequestSchema.parse({ reducer })
    const loaded = await loadValueRegistration(reducer)
    const registration = Object.hasOwn(REDUCERS, reducer) ? REDUCERS[reducer] : undefined
    const selective = outcome(() => resolveRegisteredValue(scope, request, loaded))
    expect(selective).toHaveProperty('error')
    expect(selective).toEqual(outcome(() => resolveRegisteredValue(scope, request, registration)))
  }
})
