/** Raw JSON text is essential: JSON.stringify would erase exponent overflow. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { experiment, root } from './fixture-core'

export const numericFixturePath = resolve(experiment, 'fixtures/protocol-numeric-validation.json')
export function numericFixtures() {
  const number = { type: 'number' }
  const string = { type: 'string' }
  const literal = { type: 'literal', values: [null] }
  const schemaCases: [string, z.ZodType, object][] = [
    ['number', z.number(), number],
    [
      'int',
      z.number().int(),
      { type: 'number', checks: [{ check: 'number_format', format: 'safeint' }] },
    ],
    [
      'positive',
      z.number().positive(),
      { type: 'number', checks: [{ check: 'greater_than', value: 0, inclusive: false }] },
    ],
    ['string', z.string(), string],
    ['boolean', z.boolean(), { type: 'boolean' }],
    ['object', z.object({}), { type: 'object', shape: {}, strict: false }],
    ['array', z.array(z.number()), { type: 'array', element: number }],
    [
      'record',
      z.record(z.string(), z.unknown()),
      { type: 'record', key: string, value: { type: 'unknown' } },
    ],
    ['null', z.literal(null), literal],
    ['literal', z.literal(1), { type: 'literal', values: [1] }],
    ['enum', z.enum(['a', 'b']), { type: 'enum', values: ['a', 'b'] }],
    ['nullable-number', z.number().nullable(), { type: 'nullable', inner: number }],
    ['optional-number', z.number().optional(), { type: 'optional', inner: number }],
    ['default-number', z.number().default(0), { type: 'default', inner: number, value: 0 }],
    [
      'union-number-string',
      z.union([z.number(), z.string()]),
      { type: 'union', options: [number, string] },
    ],
    [
      'union-null-number',
      z.union([z.literal(null), z.number()]),
      { type: 'union', options: [literal, number] },
    ],
    [
      'union-number-unknown',
      z.union([z.number(), z.unknown()]),
      { type: 'union', options: [number, { type: 'unknown' }] },
    ],
    ['unknown', z.unknown(), { type: 'unknown' }],
  ]
  const rawNumbers = [
    '1e400',
    '-1e400',
    '1e309',
    '-1e309',
    '1.7976931348623159e308',
    '-1.7976931348623159e308',
    '1e308',
    '9007199254740993',
    '-0',
    '0.1000000000000000055511151231257827021181583404541015625',
    '5e-324',
    '1e-324',
  ]
  const cases = schemaCases.flatMap(([name, schema, ir]) =>
    rawNumbers.map((raw) => {
      const result = schema.safeParse(JSON.parse(raw))
      return {
        id: `${name}/${raw}`,
        schema: ir,
        raw,
        oracle: result.success
          ? { accepted: JSON.parse(JSON.stringify(result.data)) }
          : { rejected: result.error.message },
      }
    }),
  )
  for (const raw of ['{"nested":1e400}', '{"nested":-1e400}']) {
    const schema = z.object({ nested: z.union([z.number(), z.string()]) })
    const result = schema.safeParse(JSON.parse(raw))
    cases.push({
      id: `nested/${raw}`,
      schema: {
        type: 'object',
        shape: { nested: { type: 'union', options: [number, string] } },
        strict: false,
      },
      raw,
      oracle: result.success ? { accepted: result.data } : { rejected: result.error.message },
    })
  }
  return {
    sources: Object.fromEntries(
      [
        'experiments/proa-server/tools/protocol-numeric-fixtures.ts',
        'node_modules/zod/package.json',
        'node_modules/zod/v4/core/schemas.js',
        'node_modules/zod/v4/locales/en.js',
      ].map((name) => [
        name,
        createHash('sha256')
          .update(readFileSync(resolve(root, name)))
          .digest('hex'),
      ]),
    ),
    cases,
  }
}
export function checkNumericFixtures() {
  if (!isDeepStrictEqual(numericFixtures(), JSON.parse(readFileSync(numericFixturePath, 'utf8'))))
    throw new Error(
      'Stale raw numeric schema fixtures; regenerate protocol-numeric-fixtures.ts --generate',
    )
}
if (import.meta.main) {
  if (process.argv.includes('--generate')) {
    const formatted = Bun.spawnSync(
      [resolve(root, 'node_modules/.bin/biome'), 'format', '--stdin-file-path', numericFixturePath],
      { stdin: Buffer.from(JSON.stringify(numericFixtures())), stdout: 'pipe', stderr: 'pipe' },
    )
    if (formatted.exitCode) throw new Error(formatted.stderr.toString())
    await Bun.write(numericFixturePath, formatted.stdout)
  } else checkNumericFixtures()
  console.log('Raw numeric schema fixture freshness passed')
}
