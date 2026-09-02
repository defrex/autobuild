import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { expandIssues, forwardIssues } from './zod-issues'

/** The two shapes on the config and manifest surfaces: an untagged choice,
 * whose whole reason for rejecting lives in nested branch detail, and a tagged
 * one, which reports for itself. */
const untagged = z.union([
  z.custom<() => unknown>((value) => typeof value === 'function', 'must be a factory function'),
  z.strictObject({
    factory: z.custom<() => unknown>(
      (value) => typeof value === 'function',
      'must be a factory function',
    ),
  }),
])

const tagged = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('check'), command: z.string().min(1) }),
  z.strictObject({ kind: z.literal('agent'), skill: z.string().min(1) }),
])

function issuesOf(schema: z.ZodType, value: unknown): z.core.$ZodIssue[] {
  const parsed = schema.safeParse(value)
  if (parsed.success) throw new Error('expected the value to be rejected')
  return parsed.error.issues
}

describe('forwardIssues', () => {
  test('relays every issue whole, prefixing only its path', () => {
    const relayed: z.core.$ZodIssue[] = []
    const sink = { addIssue: (issue: unknown) => relayed.push(issue as z.core.$ZodIssue) }

    forwardIssues(issuesOf(z.strictObject({ a: z.string() }), { b: 1 }), sink, ['acme'])

    // The codes and their code-specific payloads are what re-encoding as
    // `{ code: 'custom', message }` used to discard.
    expect(relayed).toEqual([
      expect.objectContaining({
        code: 'invalid_type',
        expected: 'string',
        path: ['acme', 'a'],
      }),
      expect.objectContaining({
        code: 'unrecognized_keys',
        keys: ['b'],
        path: ['acme'],
      }),
    ])
  })

  test('an empty prefix leaves paths exactly as reported', () => {
    const relayed: z.core.$ZodIssue[] = []
    const sink = { addIssue: (issue: unknown) => relayed.push(issue as z.core.$ZodIssue) }

    forwardIssues(issuesOf(z.strictObject({ factory: z.string() }), { factory: 1 }), sink)

    expect(relayed.map((issue) => issue.path)).toEqual([['factory']])
  })
})

describe('expandIssues', () => {
  test('an untagged choice expands to one issue per branch leaf', () => {
    const expanded = expandIssues(issuesOf(untagged, { nope: 1 }))

    expect(expanded).toEqual([
      // The bare "Invalid input" the union itself reports is replaced by why
      // each alternative was rejected.
      expect.objectContaining({
        code: 'custom',
        path: [],
        message: 'option 1 of 2: must be a factory function',
      }),
      expect.objectContaining({
        code: 'custom',
        path: ['factory'],
        message: 'option 2 of 2: must be a factory function',
      }),
      expect.objectContaining({
        code: 'unrecognized_keys',
        keys: ['nope'],
        path: [],
        message: 'option 2 of 2: Unrecognized key: "nope"',
      }),
    ])
  })

  test("a leaf's path is the union's path followed by its own", () => {
    const expanded = expandIssues(
      issuesOf(z.strictObject({ acme: untagged }), { acme: { nope: 1 } }),
    )

    expect(expanded.map((issue) => issue.path)).toEqual([['acme'], ['acme', 'factory'], ['acme']])
  })

  test('a tagged choice that matches no tag passes through untouched', () => {
    const issues = issuesOf(tagged, { kind: 'nope' })

    // Asserted whole: this issue already names the expected tags, has no branch
    // detail to expand, and must render exactly as it did before expansion
    // existed.
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'invalid_union',
        errors: [],
        path: ['kind'],
        message: "Invalid discriminator value. Expected 'check' | 'agent'",
      }),
    ])
    expect(expandIssues(issues)).toEqual(issues)
  })

  test('a tagged choice with a matching tag and a bad body passes through untouched', () => {
    const issues = issuesOf(tagged, { kind: 'check', command: '' })

    expect(issues.map((issue) => issue.code)).toEqual(['too_small'])
    expect(expandIssues(issues)).toEqual(issues)
  })

  test('a union nested in a union expands recursively, carrying both markers', () => {
    const nested = z.union([z.string(), z.union([z.number(), z.boolean()])])

    expect(expandIssues(issuesOf(nested, {})).map((issue) => issue.message)).toEqual([
      'option 1 of 2: Invalid input: expected string, received object',
      'option 2 of 2: option 1 of 2: Invalid input: expected number, received object',
      'option 2 of 2: option 2 of 2: Invalid input: expected boolean, received object',
    ])
  })

  test('non-union issues pass through untouched', () => {
    const issues = issuesOf(z.strictObject({ a: z.string() }), { a: 1, b: 2 })

    expect(expandIssues(issues)).toEqual(issues)
  })
})
