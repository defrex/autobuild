/** Actual Bun JSON.parse oracle for persisted string-valued JSONB columns. */
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { utf16Units } from './protocol-unicode-fixtures'
export function readJsonFixtures() {
  const inputs = new Set<string>([
    '',
    ' ',
    '\t\n',
    '{',
    '[',
    '}',
    ']',
    ':',
    ',',
    '.',
    '-',
    '-0',
    '1.',
    '1e',
    '1e+',
    '00',
    '01',
    '-01',
    '1e400',
    'null',
    'false',
    'true',
    'nul',
    'tru',
    'fals',
    'NaN',
    'Infinity',
    'undefined',
    'x',
    '_',
    '$x',
    'truex',
    'null0',
    '0x1',
    '"',
    '"abc',
    '"\\',
    '"\\u',
    '"\\u0',
    '"\\u00',
    '"\\u000',
    '"\\u000g"',
    '"\\q"',
    '"\\x41"',
    '"\\v"',
    '"\\0"',
    '"\n"',
    '"\t"',
    '"\u0000"',
    '{a}',
    '{1}',
    '{true}',
    '{"a"}',
    '{"a":}',
    '{"a":',
    '{"a":1,}',
    '[,]',
    '[1,]',
    '[1,,2]',
    '[1 2]',
    '{"a" "b"}',
    '{"a":1 "b":2}',
    '{"a":1,,"b":2}',
    '[]x',
    '{}x',
    '1 2',
    'true false',
    '"\\ud800"',
    '"\ud800"',
    '"😀"',
    '"\\udfff"',
    '{"\\ud800":"\\udfff"}',
  ])
  const tokens = [
    '!',
    '@',
    '+',
    '/',
    '\\',
    '=',
    '\ufeff',
    '\u0085',
    '\u0000',
    '\ud800',
    '\udfff',
    '😀',
    'é',
    'x',
    '_',
    'null',
    'true',
    '1',
    '"a"',
    ']',
    '}',
    ':',
    ',',
    '.',
    '-',
    '',
  ]
  for (const token of tokens)
    for (const template of [
      '{}',
      '[{}]',
      '{{}}',
      '{"a":{}}',
      '[1 {}]',
      '{"a":1 {}}',
      '{"a" {}1}',
      '[1,{}]',
      '{"a":1, {}}',
      'null{}',
      '"a"{}',
    ])
      inputs.add(template.replace('{}', token))
  for (const token of ['null', 'true', 'false', '123', '-12.3e+4', '"hello"', '{"a":[1,2]}'])
    for (let i = 0; i <= token.length; i++) {
      inputs.add(token.slice(0, i))
      inputs.add(`${token.slice(0, i)}!${token.slice(i)}`)
    }
  for (let unit = 0; unit < 128; unit++) {
    const token = String.fromCharCode(unit)
    for (const template of [
      '{}',
      '[{}]',
      '{{}}',
      '{"a":{}}',
      '[1 {}]',
      '{"a":1, {}}',
      '"{}"',
      '"\\{}"',
    ])
      inputs.add(template.replace('{}', token))
  }
  for (const text of [
    '"\\u"',
    '"\\u0"',
    '"\\u00"',
    '"\\u000"',
    '"\\u00g0"',
    '"\\uD800\\q"',
    '[1e]',
    '{"a":1e}',
    '[00]',
    '"a"\n!',
    '{"a"\n!',
    '{"a":1,\n!',
    '{"a":1e!}',
  ])
    inputs.add(text)
  return {
    cases: [...inputs].map((input) => {
      const sourceUnits = utf16Units(input)
      try {
        return { sourceUnits, jsonUnits: utf16Units(JSON.stringify(JSON.parse(input))) }
      } catch (error) {
        return {
          sourceUnits,
          errorUnits: utf16Units(error instanceof Error ? error.message : String(error)),
        }
      }
    }),
  }
}
const path = resolve(import.meta.dir, '../fixtures/protocol-read-json.json')
if (import.meta.main) {
  const fixture = readJsonFixtures()
  if (process.argv.includes('--generate')) {
    const result = Bun.spawnSync(
      [
        resolve(import.meta.dir, '../../../node_modules/.bin/biome'),
        'format',
        '--stdin-file-path',
        path,
      ],
      { stdin: Buffer.from(JSON.stringify(fixture)) },
    )
    if (result.exitCode) throw Error(result.stderr.toString())
    await Bun.write(path, result.stdout)
  } else if (!isDeepStrictEqual(fixture, await Bun.file(path).json()))
    throw Error('Read JSON grammar oracle stale; regenerate --generate')
  console.log(`${fixture.cases.length} Bun persisted JSON string parsing cases`)
}
