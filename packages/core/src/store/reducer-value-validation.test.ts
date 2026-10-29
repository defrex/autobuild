import { expect, test } from 'bun:test'
import { repositoryReadFactsReducer } from '../kernel/read-facts'
import {
  diagnoseReducerValue,
  projectReducerValue,
  type ReducerValueCatalog,
  validateReducerValue,
} from './reducer-value-validation'

test('diagnostics locate nested, missing, unexpected and non-JSON fields without values', () => {
  const valid = () => repositoryReadFactsReducer.finish(repositoryReadFactsReducer.initial())
  expect(diagnoseReducerValue('repositoryReadFacts', valid())).toBeUndefined()
  for (const [mutate, path] of [
    [
      (value: Record<string, unknown>) => {
        value.settings = { intake: 'secret' }
      },
      '$.settings.intake',
    ],
    [
      (value: Record<string, unknown>) => {
        delete value.settings
      },
      '$.settings',
    ],
    [
      (value: Record<string, unknown>) => {
        value.extra = 'secret'
      },
      '$.extra',
    ],
    [
      (value: Record<string, unknown>) => {
        value.recentRuns = [NaN]
      },
      '$.recentRuns[0]',
    ],
  ] as const) {
    const value = valid() as unknown as Record<string, unknown>
    mutate(value)
    expect(validateReducerValue('repositoryReadFacts', value)).toBe(false)
    const failure = diagnoseReducerValue('repositoryReadFacts', value)
    expect(failure?.path).toBe(path)
    expect(JSON.stringify(failure)).not.toContain('secret')
  }
  expect(diagnoseReducerValue('missing', {})).toEqual({ path: '$', expected: 'known reducer' })
})

test('union diagnostics choose a nested branch deterministically', () => {
  const value = repositoryReadFactsReducer.finish(repositoryReadFactsReducer.initial())
  const event = {
    repo: 'repo',
    seq: 1,
    ts: '2026-10-20T19:00:00.000Z',
    actor: { kind: 'dispatcher' },
    type: 'dispatcher.ticket-source-degraded',
    payload: {
      source: 'linear',
      operation: 'ready-scan',
      cause: 'rate-limited',
      message: 'private',
      resetAt: 42,
    },
  }
  const broken = {
    ...value,
    attention: {
      ...value.attention,
      sources: [
        [
          'linear',
          {
            event,
            deadline: 42,
            dependencyLimited: false,
            requiresRetry: true,
            retryObserved: false,
          },
        ],
      ],
    },
  }
  const first = diagnoseReducerValue('repositoryReadFacts', broken)
  expect(first?.path).toContain('.event.payload.resetAt')
  expect(first).toEqual(diagnoseReducerValue('repositoryReadFacts', broken))
  expect(JSON.stringify(first)).not.toContain('private')
})

test('projection drops unknown properties and keeps every field the shape knows', () => {
  const valid = repositoryReadFactsReducer.finish(repositoryReadFactsReducer.initial())
  expect(projectReducerValue('repositoryReadFacts', valid)).toEqual({ value: valid })
  const newer = {
    ...structuredClone(valid),
    added: { secret: true },
    settings: { ...valid.settings, addedNested: 'secret' },
  }
  const projected = projectReducerValue('repositoryReadFacts', newer)
  expect(projected).toEqual({ value: valid })
  expect(validateReducerValue('repositoryReadFacts', (projected as { value: unknown }).value)).toBe(
    true,
  )
})

test('projection still fails for missing fields, unknown variants and unknown reducers', () => {
  const valid = () =>
    repositoryReadFactsReducer.finish(repositoryReadFactsReducer.initial()) as unknown as Record<
      string,
      unknown
    >
  const missing = valid()
  delete missing.settings
  expect(projectReducerValue('repositoryReadFacts', missing)).toMatchObject({ path: '$.settings' })
  const variant = valid()
  variant.settings = { intake: 'secret' }
  const failure = projectReducerValue('repositoryReadFacts', variant)
  expect(failure).toMatchObject({ path: '$.settings.intake' })
  expect(JSON.stringify(failure)).not.toContain('secret')
  expect(projectReducerValue('missing', {})).toEqual({ path: '$', expected: 'known reducer' })
})

test('projection onto a union picks the member that drops the fewest properties', () => {
  const catalog: ReducerValueCatalog = {
    roots: { pick: { value: 'u' } },
    schemas: {
      u: { kind: 'union', items: ['small', 'large'] },
      small: { kind: 'object', props: { a: { type: 'n', optional: false } } },
      large: {
        kind: 'object',
        props: { a: { type: 'n', optional: false }, b: { type: 'n', optional: false } },
      },
      n: { kind: 'number' },
    },
  }
  expect(projectReducerValue('pick', { a: 1, b: 2, c: 3 }, catalog)).toEqual({
    value: { a: 1, b: 2 },
  })
  expect(projectReducerValue('pick', { a: 1, c: 3 }, catalog)).toEqual({ value: { a: 1 } })
})
