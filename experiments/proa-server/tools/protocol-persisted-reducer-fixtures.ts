/** Executable named-value oracle over legacy persisted UTF-16 payloads. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { gzipSync, gunzipSync } from 'node:zlib'
import { resolveReducerValue } from '../../../packages/core/src/store/reducer-values'
import { encodeReducerValue } from '../../../packages/core/src/store/reducer-value-validation'
import { projectStoredEvents } from '../../../packages/core/src/events/compatibility'
import { supportedReducers } from './protocol-reducer-fixtures'
import { persistedUnicodeFixtures } from './protocol-persisted-unicode-fixtures'
import { experiment } from './fixture-core'
export function persistedReducerArgs(name: string): Record<string, string | number | boolean> {
  return name === 'dispatchFailureBudget'
    ? { infrastructureOwnsWorkspace: false }
    : name === 'phaseFailures'
      ? { phase: 'plan', round: 1 }
      : name === 'terminalGuard'
        ? { phase: 'plan', round: 1, session: '\ud800' }
        : ['dispatcherRunFacts', 'dispatchStatus', 'openTick'].includes(name)
          ? { run: '\ud800' }
          : {}
}
export function persistedReducerFixtures() {
  const storedCases = persistedUnicodeFixtures().cases
  const cases: {
    name: string
    scope: string
    reducer: string
    args: unknown
    input: string
    expected: string
  }[] = []
  for (const name of supportedReducers) {
    const args = persistedReducerArgs(name)
    for (const scope of ['build', 'repository'] as const) {
      let resolved: ReturnType<typeof resolveReducerValue>
      try {
        resolved = resolveReducerValue(
          scope === 'repository'
            ? { kind: 'repo', repo: 'witness' }
            : { kind: 'build', slug: 'witness' },
          { reducer: name, args },
        )
      } catch {
        continue
      }
      for (const row of storedCases) {
        if (
          row.scope !== scope ||
          row.expected === undefined ||
          !(
            row.name.endsWith('/witness') ||
            row.name.includes('"\\ud800"') ||
            row.name.includes('"\\udfff"')
          )
        )
          continue
        try {
          const events = [JSON.parse(row.input)]
          const output = resolved.reducer.reduce(
            resolved.entry.adapt(projectStoredEvents(events as never) as never),
          )
          cases.push({
            name: row.name,
            scope,
            reducer: name,
            args,
            input: row.input,
            expected: JSON.stringify(encodeReducerValue(output)),
          })
        } catch {
          /* Source reducers can require a coherent lifecycle prefix. */
        }
      }
    }
  }
  return { reducers: supportedReducers, cases }
}
const path = resolve(experiment, 'fixtures/protocol-persisted-reducers.json.gz')
export function checkPersistedReducerFixtures() {
  if (
    !isDeepStrictEqual(
      persistedReducerFixtures(),
      JSON.parse(gunzipSync(readFileSync(path)).toString()),
    )
  )
    throw new Error('Persisted reducer fixtures stale')
}
if (import.meta.main) {
  const fixture = persistedReducerFixtures()
  if (process.argv.includes('--generate'))
    await Bun.write(path, gzipSync(JSON.stringify(fixture), { level: 9 }))
  else checkPersistedReducerFixtures()
  console.log(
    JSON.stringify({
      cases: fixture.cases.length,
      reducers: new Set(fixture.cases.map((r) => r.reducer)).size,
    }),
  )
}
