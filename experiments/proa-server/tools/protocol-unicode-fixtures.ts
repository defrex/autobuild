/** JavaScript JSON/UTF16 oracle. Lone surrogates appear only as escaped JSON text
 * or integer code units in this outer fixture, never as raw fixture strings. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { root, experiment } from './fixture-core'

export type JsonFingerprint =
  | { type: 'null' }
  | { type: 'boolean'; value: boolean }
  | { type: 'number'; json: string; negativeZero: boolean }
  | { type: 'string'; units: number[] }
  | { type: 'array'; items: JsonFingerprint[] }
  | { type: 'object'; entries: { keyUnits: number[]; value: JsonFingerprint }[] }
export function utf16Units(value: string) {
  return Array.from({ length: value.length }, (_, i) => value.charCodeAt(i))
}
export function jsonFingerprint(value: unknown): JsonFingerprint {
  if (value === null) return { type: 'null' }
  if (typeof value === 'boolean') return { type: 'boolean', value }
  if (typeof value === 'number')
    return { type: 'number', json: JSON.stringify(value), negativeZero: Object.is(value, -0) }
  if (typeof value === 'string') return { type: 'string', units: utf16Units(value) }
  if (Array.isArray(value)) return { type: 'array', items: value.map(jsonFingerprint) }
  if (typeof value === 'object')
    return {
      type: 'object',
      entries: Object.keys(value).map((key) => ({
        keyUnits: utf16Units(key),
        value: jsonFingerprint((value as Record<string, unknown>)[key]),
      })),
    }
  throw new Error('Fingerprint requires a JSON.parse result')
}
export function unicodeFixtures() {
  const inputs: [string, string][] = [
    ['null', 'null'],
    ['boolean', 'true'],
    ['empty', '""'],
    ['ascii', '"plain"'],
    ['bmp', '"雪é"'],
    ['astral', '"💩"'],
    ['escaped-pair', '"\\ud83d\\udca9"'],
    ['high', '"\\ud800"'],
    ['low', '"\\udfff"'],
    ['high-high', '"\\ud800\\ud800"'],
    ['low-high', '"\\udc00\\ud800"'],
    ['mixed', '"a\\ud800雪\\udfff💩"'],
    ['escape-controls', '"\\u0000\\b\\f\\n\\r\\t\\"\\\\\\/"'],
    ['line-separators', '"\u2028\u2029"'],
    ['nested-lones', '{"x":["\\ud800",{"\\udfff":"\\ud800"}]}'],
    ['duplicate-key', '{"a":1,"b":2,"a":3}'],
    ['duplicate-surrogate-key', '{"\\ud800":1,"x":2,"\\uD800":3}'],
    ['pair-key-equivalence', '{"💩":1,"\\ud83d\\udca9":2}'],
    ['distinct-replacement-key', '{"\\ud800":1,"�":2,"\\udfff":3}'],
    ['prototype-key', '{"__proto__":{"polluted":true},"constructor":1,"prototype":2}'],
    ['private-number-key', '{"$serde_json::private::Number":"1e999"}'],
    ['private-number-object', '{"$serde_json::private::Number":{"\\ud800":1}}'],
    ['index-order', '{"4294967295":1,"2":2,"01":3,"0":4,"4294967294":5,"1":6,"-0":7}'],
    ['duplicate-index-order', '{"2":1,"1":2,"a":3,"2":4,"0":5}'],
  ]
  for (const [i, n] of [
    '0',
    '-0',
    '0.0',
    '-0.0',
    '1',
    '-1',
    '1.5',
    '1e-7',
    '1e-6',
    '1e20',
    '1e21',
    '1e30',
    '-1e30',
    '1e308',
    '1e309',
    '-1e309',
    '5e-324',
    '1e-324',
    '2.2250738585072014e-308',
    '9007199254740991',
    '9007199254740992',
    '9007199254740993',
    '9223372036854775807',
    '18446744073709551615',
    '0.100000000000000005',
    '1.234567890123456789',
  ].entries())
    inputs.push([`number-${i}`, n])
  for (const unit of [
    0, 1, 31, 32, 127, 128, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xffff,
  ]) {
    const escaped = `\\u${unit.toString(16).padStart(4, '0')}`
    inputs.push([`unit-${unit}`, `"${escaped}"`], [`key-${unit}`, `{"${escaped}":"${escaped}"}`])
  }
  const valid = inputs.map(([name, input]) => {
    const parsed: unknown = JSON.parse(input)
    return {
      name,
      input,
      stringifyUnits: utf16Units(JSON.stringify(parsed)),
      fingerprint: jsonFingerprint(parsed),
    }
  })
  const invalid = [
    '',
    'undefined',
    'NaN',
    'Infinity',
    '01',
    '+1',
    '1.',
    '1e',
    '[1,]',
    '{"x":1,}',
    '{"x" 1}',
    '"\\uD80"',
    '"\\x41"',
    '"unclosed',
    '"a\nb"',
    'null false',
    '{',
    '[',
    '\ufeff{}',
  ].map((input, i) => {
    let rejected = false
    try {
      JSON.parse(input)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error(`Invalid oracle input accepted: ${i}`)
    return { name: `invalid-${i}`, inputUnits: utf16Units(input), rejected: true }
  })
  const utf8 = [
    ['ff', [255]],
    ['overlong', [192, 175]],
    ['surrogate', [237, 160, 128]],
    ['truncated', [226, 130]],
    ['replacement', [239, 191, 189]],
    ['astral', [240, 159, 146, 169]],
    ['bad-continuation', [226, 65, 130]],
    ['too-high', [244, 144, 128, 128]],
    ['stray-continuations', [128, 191]],
    ['bom', [239, 187, 191, 65]],
  ].map(([name, bytes]) => ({
    name: name as string,
    bytes: bytes as number[],
    units: utf16Units(new TextDecoder().decode(new Uint8Array(bytes as number[]))),
  }))
  return { format: 1, valid, invalid, utf8 }
}
export const unicodeFixturePath = resolve(experiment, 'fixtures/protocol-unicode.json')
export function checkUnicodeFixtures() {
  if (!isDeepStrictEqual(unicodeFixtures(), JSON.parse(readFileSync(unicodeFixturePath, 'utf8'))))
    throw new Error('Unicode fixtures stale; regenerate with --generate')
}
if (import.meta.main) {
  const fixture = unicodeFixtures()
  if (process.argv.includes('--generate')) {
    const formatted = Bun.spawnSync(
      [resolve(root, 'node_modules/.bin/biome'), 'format', '--stdin-file-path', unicodeFixturePath],
      { stdin: Buffer.from(JSON.stringify(fixture)), stdout: 'pipe', stderr: 'pipe' },
    )
    if (formatted.exitCode) throw new Error('Cannot format Unicode fixtures')
    await Bun.write(unicodeFixturePath, formatted.stdout)
  } else checkUnicodeFixtures()
  console.log(
    JSON.stringify({
      valid: fixture.valid.length,
      invalid: fixture.invalid.length,
      utf8: fixture.utf8.length,
    }),
  )
}
