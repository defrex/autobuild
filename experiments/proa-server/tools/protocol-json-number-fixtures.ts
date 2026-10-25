import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { experiment, root } from './fixture-core'

export const jsonNumberFixturePath = resolve(experiment, 'fixtures/protocol-json-numbers.json')
function fingerprint(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { nonfinite: value < 0 ? '-Infinity' : 'Infinity' }
    const bytes = new ArrayBuffer(8)
    // Negative zero has no sign at the JSON.stringify/persistence boundary.
    new DataView(bytes).setFloat64(0, value === 0 ? 0 : value)
    return { bits: Buffer.from(bytes).toString('hex') }
  }
  if (Array.isArray(value)) return value.map(fingerprint)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, fingerprint(child)]),
    )
  return value
}
export function jsonNumberFixtures() {
  const numbers = [
    '0',
    '-0',
    '0.0',
    '-0.0',
    '1',
    '-1',
    '9007199254740991',
    '9007199254740992',
    '9007199254740993',
    '9007199254740994',
    '-9007199254740993',
    '9007199254740993.0',
    '9007199254740993e0',
    '9223372036854775807',
    '-9223372036854775808',
    '18446744073709551615',
    '1000000000000000100',
    '0.9999999999999999',
    '1.2345678901234567',
    '0.1',
    '0.1000000000000000055511151231257827021181583404541015625',
    '1e20',
    '1e21',
    '1e23',
    '1e-6',
    '1e-7',
    '1e308',
    '1.7976931348623157e308',
    '1.7976931348623159e308',
    '1e400',
    '-1e400',
    '1e999999999999999999',
    '-1e999999999999999999',
    '1e-400',
    '-1e-400',
    '5e-324',
    '2.2250738585072014e-308',
  ]
  const raws = numbers.flatMap((number) => [
    number,
    `{"metadata":{"n":${number},"array":[${number}]}}`,
  ])
  raws.push(
    '{"$serde_json::private::Number":"1"}',
    '{"$serde_json::private::Number":"ordinary text","other":1}',
    '{"$serde_json::private::Number":1,"other":2}',
    '{"other":1,"$serde_json::private::Number":"1"}',
    '{"array":[{"$serde_json::private::Number":"1"}],"nested":{"$serde_json::private::Number":"plain"}}',
    '{"repeated":1,"other":2,"repeated":3}',
    '{"2":1,"1":2,"a":3}',
    '{"z":0,"4294967295":1,"4294967294":2,"01":3,"0":4,"-0":5,"1":6,"a":7}',
    '{"outer":{"2":"second","1":"first","0":"zero","02":"leading"}}',
  )
  return {
    sources: {
      'experiments/proa-server/tools/protocol-json-number-fixtures.ts': createHash('sha256')
        .update(readFileSync(import.meta.filename))
        .digest('hex'),
    },
    cases: raws.map((raw, index) => {
      const parsed: unknown = JSON.parse(raw)
      const serialized: unknown = JSON.parse(JSON.stringify(parsed))
      return {
        id: `raw-number/${index}`,
        raw,
        parsed: fingerprint(parsed),
        serialized: fingerprint(serialized),
        serializedText: JSON.stringify(parsed),
      }
    }),
  }
}
export function checkJsonNumberFixtures() {
  if (
    !isDeepStrictEqual(
      JSON.parse(readFileSync(jsonNumberFixturePath, 'utf8')),
      jsonNumberFixtures(),
    )
  )
    throw new Error(
      'Stale raw JSON number fixtures; run bun tools/protocol-json-number-fixtures.ts --generate',
    )
}
if (import.meta.main) {
  if (process.argv.includes('--generate')) {
    const formatted = Bun.spawnSync(
      [
        resolve(root, 'node_modules/.bin/biome'),
        'format',
        '--stdin-file-path',
        jsonNumberFixturePath,
      ],
      { stdin: Buffer.from(JSON.stringify(jsonNumberFixtures())), stdout: 'pipe', stderr: 'pipe' },
    )
    if (formatted.exitCode !== 0) throw new Error('Cannot format raw JSON number fixtures')
    await Bun.write(jsonNumberFixturePath, formatted.stdout)
  } else checkJsonNumberFixtures()
  console.log('Raw JSON number fixtures match JavaScript parsing and serialization')
}
