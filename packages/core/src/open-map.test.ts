/**
 * The entry-boundary half of the open-map contract, driven through
 * `openMap(...).safeParse(...)` rather than a hand-built record: the transform
 * IS the step that used to drop an entry or flatten what validation reported.
 *
 * Both behaviors here need value shapes no config or manifest schema produces
 * yet — a value that legitimately validates to `undefined`, and an untagged
 * choice — which is why they live in this file rather than in the surface tests.
 */
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { openMap } from './open-map'
import { expandIssues } from './zod-issues'

function parsed<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    throw new Error(`expected the map to parse: ${JSON.stringify(result.error.issues)}`)
  }
  return result.data
}

function rejected(schema: z.ZodType, input: unknown): z.core.$ZodIssue[] {
  const result = schema.safeParse(input)
  if (result.success) throw new Error('expected the map to be rejected')
  return result.error.issues
}

describe('openMap — a value that validates to nothing', () => {
  const optionalValues = openMap('[x]', z.string().optional())

  test('keeps the entry, with no issue reported', () => {
    const result = optionalValues.safeParse({ a: undefined, b: 'v' })

    // Success is the schema's answer, not something inferred from the value: an
    // entry that validated cleanly must never vanish.
    expect(result.success).toBe(true)
    const map = result.success ? result.data : {}
    expect(Object.hasOwn(map, 'a')).toBe(true)
    expect(map.a).toBeUndefined()
    expect(map.b).toBe('v')
    expect(Object.keys(map)).toEqual(['a', 'b'])
  })

  test('keeps it under a name that collides with an inherited member', () => {
    const map = parsed(optionalValues, { ['__proto__']: undefined, b: 'v' })

    expect(Object.hasOwn(map, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(map, '__proto__')?.value).toBeUndefined()
    expect(Object.getPrototypeOf(map)).toBeNull()
  })
})

describe('openMap — what a rejection reports', () => {
  const registration = openMap(
    '[x]',
    z.union([
      z.custom<() => unknown>((value) => typeof value === 'function', 'must be a factory function'),
      z.strictObject({
        factory: z.custom<() => unknown>(
          (value) => typeof value === 'function',
          'must be a factory function',
        ),
      }),
    ]),
  )

  test('an untagged choice says what was wrong, anchored under the entry key', () => {
    const expanded = expandIssues(rejected(registration, { acme: { nope: 1 } }))
    const rendered = expanded.map((issue) => `${issue.path.join('.')}: ${issue.message}`)

    // Every issue still addresses the entry that failed and where beneath it.
    expect(expanded.every((issue) => issue.path[0] === 'acme')).toBe(true)
    expect(rendered).toEqual([
      'acme: option 1 of 2: must be a factory function',
      'acme.factory: option 2 of 2: must be a factory function',
      'acme: option 2 of 2: Unrecognized key: "nope"',
    ])
  })

  test('a tagged choice is not degraded', () => {
    const steps = openMap(
      '[x]',
      z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('check'), command: z.string().min(1) }),
        z.strictObject({ kind: z.literal('agent'), skill: z.string().min(1) }),
      ]),
    )
    const issues = rejected(steps, { e2e: { kind: 'nope' } })

    expect(expandIssues(issues)).toEqual(issues)
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'invalid_union',
        path: ['e2e', 'kind'],
        message: "Invalid discriminator value. Expected 'check' | 'agent'",
      }),
    ])
  })

  test('a rejected entry keeps its issue code and payload', () => {
    const strict = openMap('[x]', z.strictObject({ runtime: z.string() }))

    expect(rejected(strict, { plan: { runtime: 'claude', bogus: 1 } })).toEqual([
      expect.objectContaining({
        code: 'unrecognized_keys',
        keys: ['bogus'],
        path: ['plan'],
      }),
    ])
  })

  test('a rejected entry is the only one dropped', () => {
    const strings = openMap('[x]', z.string())

    expect(rejected(strings, { good: 'v', bad: 1 })).toEqual([
      expect.objectContaining({ code: 'invalid_type', path: ['bad'] }),
    ])
  })
})

describe('openMap — key preservation still holds', () => {
  const strings = openMap('[x]', z.string())

  test('a declared hazardous name survives with its value; an undeclared one is absent', () => {
    const map = parsed(strings, { ['__proto__']: 'declared', ordinary: 'v' })

    expect(Object.getOwnPropertyDescriptor(map, '__proto__')?.value).toBe('declared')
    expect(map.ordinary).toBe('v')
    expect(map.constructor).toBeUndefined()
    expect(map.toString).toBeUndefined()
  })
})
