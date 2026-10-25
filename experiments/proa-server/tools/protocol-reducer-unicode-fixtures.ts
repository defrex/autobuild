/** Independent source catalog argument and replay oracles in UTF16 units. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  reducerValueRequestSchema,
  resolveReducerValue,
} from '../../../packages/core/src/store/reducer-values'
import { projectStoredEvents } from '../../../packages/core/src/events/compatibility'
import { encodeReducerValue } from '../../../packages/core/src/store/reducer-value-validation'
import { root, experiment } from './fixture-core'
import { utf16Units } from './protocol-unicode-fixtures'
export function reducerUnicodeFixtures() {
  const cases: { name: string; scope: 'build' | 'repo'; input: string; expectedUnits: number[] }[] =
      [],
    replay: {
      name: string
      scope: 'build' | 'repo'
      input: string
      events: unknown[]
      valueUnits: number[]
    }[] = []
  const add = (scope: 'build' | 'repo', input: string, name: string) => {
    try {
      const parsed = reducerValueRequestSchema.parse(JSON.parse(input)),
        resolved = resolveReducerValue(
          scope === 'repo' ? { kind: 'repo', repo: 'fixture' } : { kind: 'build', slug: 'fixture' },
          parsed,
        ),
        args = resolved.entry.args.parse(parsed.args ?? {})
      cases.push({
        name,
        scope,
        input,
        expectedUnits: utf16Units(
          JSON.stringify({
            accepted: { name: resolved.name, args, version: resolved.reducer.version },
          }),
        ),
      })
      for (const events of [
        [],
        [
          {
            build: 'fixture',
            seq: 1,
            ts: '2030-01-01T00:00:00.000Z',
            actor: { kind: 'kernel' },
            type: 'session.started',
            payload: { session: '�', phase: 'implement', round: 1 },
          },
          {
            build: 'fixture',
            seq: 2,
            ts: '2030-01-01T00:00:00.000Z',
            actor: { kind: 'kernel' },
            type: 'session.ended',
            payload: { session: '�', exitCode: 0, stdoutTail: '' },
          },
          {
            build: 'fixture',
            seq: 3,
            ts: '2030-01-01T00:00:00.000Z',
            actor: { kind: 'agent', role: 'implement', session: '�' },
            type: 'implement.completed',
            payload: { round: 1, summary: 'done' },
          },
        ],
      ]) {
        try {
          const value = encodeReducerValue(
            resolved.reducer.reduce(
              resolved.entry.adapt(projectStoredEvents(events as never) as never),
            ),
          )
          replay.push({
            name: `${name}/${events.length}`,
            scope,
            input,
            events,
            valueUnits: utf16Units(JSON.stringify(value)),
          })
        } catch {}
      }
    } catch (error) {
      cases.push({
        name,
        scope,
        input,
        expectedUnits: utf16Units(JSON.stringify({ rejected: String(error) })),
      })
    }
  }
  for (const [tag, value] of [
    ['high', '\ud800'],
    ['low', '\udfff'],
    ['replacement', '�'],
    ['pair', '💩'],
  ] as const) {
    for (const reducer of ['dispatchStatus', 'dispatcherRunFacts', 'openTick'])
      add('repo', JSON.stringify({ reducer, args: { run: value } }), `${reducer}/${tag}`)
    for (const reducer of ['terminalGuard', 'phaseFailures'])
      for (const phase of ['implement', `verify:${value}`])
        add(
          'build',
          JSON.stringify({
            reducer,
            args: { phase, round: 1, ...(reducer === 'terminalGuard' ? { session: value } : {}) },
          }),
          `${reducer}/${phase === 'implement' ? 'implement' : 'verify'}/${tag}`,
        )
    add(
      'build',
      JSON.stringify({
        reducer: 'terminalGuard',
        args: { phase: `verify:${value}`, round: 1, session: '�' },
      }),
      `terminalGuard/mixed-session/${tag}`,
    )
    for (const scope of ['build', 'repo'] as const) {
      add(scope, JSON.stringify({ reducer: value }), `unknown/${scope}/${tag}`)
      add(
        scope,
        JSON.stringify({ reducer: 'build', args: { [value]: 'x' } }),
        `extra-arg/${scope}/${tag}`,
      )
      add(scope, JSON.stringify({ reducer: 'build', [value]: 1 }), `extra-top/${scope}/${tag}`)
    }
    add(
      'repo',
      `{"reducer":"openTick","args":{"run":"ok","${tag}":{"\\ud800":1e400}}}`,
      `json-union/${tag}`,
    )
  }
  for (const input of [
    '{"reducer":"openTick","args":{"run":1e400}}',
    '{"reducer":"openTick","args":{"\\ud800":[1e400]}}',
    '{"reducer":"openTick","args":{"__proto__":1e400,"run":"x"}}',
    '{"reducer":"phaseFailures","args":{"phase":"implement","round":-0}}',
  ])
    add(input.includes('phaseFailures') ? 'build' : 'repo', input, `number/${cases.length}`)
  const syntax = [
    '{"reducer":"\\ud800",}',
    '{"reducer":"\\ud800" "args":{}}',
    '{"reducer":"openTick","args":{"run":"\\ud800"},"x":[1,]}',
    '{"\\udfff":1',
    '{"x":"\\ud800","y" 2}',
    '{"reducer":"\\ud83d\\udca9",}',
    '{"\\ud800":"x","y":}',
    '{"x":"\\ud800\\uZZZZ"}',
    '{"x":"\\ud800\\q"}',
  ].map((input) => {
    try {
      JSON.parse(input)
      throw new Error('expected syntax refusal')
    } catch (error) {
      return { input, expectedUnits: utf16Units(String(error)) }
    }
  })
  return { cases, replay, syntax }
}
const path = resolve(experiment, 'fixtures/protocol-reducer-unicode.json')
export function checkReducerUnicodeFixtures() {
  if (!isDeepStrictEqual(reducerUnicodeFixtures(), JSON.parse(readFileSync(path, 'utf8'))))
    throw new Error('Reducer Unicode fixtures stale')
}
if (import.meta.main) {
  const fixture = reducerUnicodeFixtures()
  if (process.argv.includes('--generate')) {
    const p = Bun.spawnSync(
      [resolve(root, 'node_modules/.bin/biome'), 'format', '--stdin-file-path', path],
      { stdin: Buffer.from(JSON.stringify(fixture)), stdout: 'pipe', stderr: 'pipe' },
    )
    if (p.exitCode) throw new Error('Cannot format reducer Unicode fixture')
    await Bun.write(path, p.stdout)
  } else checkReducerUnicodeFixtures()
  console.log(
    JSON.stringify({
      validation: fixture.cases.length,
      replay: fixture.replay.length,
      syntax: fixture.syntax.length,
    }),
  )
}
