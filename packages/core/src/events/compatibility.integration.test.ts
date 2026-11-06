import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { eventPayloadSchemas } from './payloads'
import { repositoryEventPayloadSchemas } from './repository'
import { buildEventPolicy, repositoryEventPolicy } from './policy'
import {
  catalogIdentity,
  projectPayload,
  decodeStoredEvent,
  initialCompatibility,
  advanceCompatibility,
} from './compatibility'
import { compatibilityDiagnostic, mixedVersionDeferred } from '../kernel/mixed-version'
import { newerFact } from '../testing/newer-writer'
import { AUTOBUILD_VERSION } from '../store/remote/version'

describe('mixed-version read catalog', () => {
  test('every build and repository type has an explicit classification', () => {
    expect(Object.keys(buildEventPolicy).sort()).toEqual(Object.keys(eventPayloadSchemas).sort())
    expect(Object.keys(repositoryEventPolicy).sort()).toEqual(
      Object.keys(repositoryEventPayloadSchemas).sort(),
    )
  })
  test('catalog identity is deterministic, classification-sensitive and independent of reducer versions', () => {
    expect(catalogIdentity({ b: 'decisive', a: 'advisory' }, {})).toBe(
      catalogIdentity({ a: 'advisory', b: 'decisive' }, {}),
    )
    expect(catalogIdentity({ ...buildEventPolicy, 'future.control': 'decisive' })).not.toBe(
      catalogIdentity(),
    )
    expect(catalogIdentity({ ...buildEventPolicy, 'build.created': 'advisory' })).not.toBe(
      catalogIdentity(),
    )
  })
  test('nested added fields are discarded while required fields, enums and refinements remain enforced', () => {
    const schema = z.strictObject({
      nested: z
        .strictObject({ n: z.number().positive(), mode: z.enum(['on', 'off']) })
        .refine((v) => v.mode !== 'on' || v.n > 2),
    })
    expect(
      projectPayload(schema, { nested: { n: 3, mode: 'on', future: true }, extra: 1 }),
    ).toEqual({ nested: { n: 3, mode: 'on' } })
    for (const nested of [
      { n: '3', mode: 'on' },
      { n: 1, mode: 'on' },
      { n: 3, mode: 'new' },
      { mode: 'on' },
    ])
      expect(() => projectPayload(schema, { nested, extra: true })).toThrow()
  })
  test('added fields inside union alternatives do not erase known keys from another branch', () => {
    const union = z.strictObject({
      value: z.union([z.strictObject({ foo: z.string() }), z.strictObject({ bar: z.number() })]),
    })
    expect(projectPayload(union, { value: { foo: 'known', future: true } })).toEqual({
      value: { foo: 'known' },
    })
    expect(() => projectPayload(union, { value: { foo: 123, future: true } })).toThrow()
  })
  test('decoding validates changed known fields on every call', () => {
    const event = {
      ...newerFact(1),
      type: 'observation.recorded',
      payload: { id: 'known', kind: 'followup', summary: 'valid' },
    }
    expect(decodeStoredEvent(event)).not.toBeNull()
    const changed = event.payload as Record<string, unknown>
    changed.id = 123
    expect(() => decodeStoredEvent(event)).toThrow()
  })
  test('opaque facts are preserved, counted incrementally, and legacy unknowns are decisive', () => {
    const advisory = newerFact(1, 'advisory')
    const decisive = newerFact(2, 'decisive')
    expect(decodeStoredEvent(advisory)).toBeNull()
    const before = structuredClone(advisory)
    const state = initialCompatibility()
    advanceCompatibility(state, [advisory])
    expect(state.unknownFacts).toBe(1)
    expect(state.decisiveFacts).toBe(0)
    advanceCompatibility(state, [decisive])
    expect(state.unknownFacts).toBe(2)
    expect(state.decisiveBoundary).toBe(2)
    expect(compatibilityDiagnostic(state)).toContain(decisive.type)
    expect(compatibilityDiagnostic(state)).toContain(AUTOBUILD_VERSION)
    expect(compatibilityDiagnostic(state)).toContain('restart with a build that understands')
    expect(advisory).toEqual(before)
    const legacy = { ...newerFact(3), compatibility: undefined }
    advanceCompatibility(state, [legacy])
    expect(state.decisiveFacts).toBe(2)
    expect(compatibilityDiagnostic(state)).toContain('writer version unavailable')
  })
})

test('deferral summaries exclude advisory types and releases while retaining all unknown counts', () => {
  const state = initialCompatibility()
  const advisory = {
    ...newerFact(1, 'advisory'),
    type: 'future.advisory',
    compatibility: { classification: 'advisory' as const, writerVersion: 'advisory-release' },
  }
  const decisive = {
    ...newerFact(2),
    type: 'future.decisive',
    compatibility: { classification: 'decisive' as const, writerVersion: 'decisive-release' },
  }
  advanceCompatibility(state, [advisory])
  const resumed = structuredClone(state)
  advanceCompatibility(resumed, [decisive])
  expect(resumed.unknownFacts).toBe(2)
  expect(resumed.types).toEqual([advisory.type, decisive.type])
  expect(resumed.writerVersions).toEqual(['advisory-release', 'decisive-release'])
  expect(resumed.decisiveTypes).toEqual([decisive.type])
  expect(resumed.decisiveWriterVersions).toEqual(['decisive-release'])
  expect(compatibilityDiagnostic(resumed)).toContain('future.decisive')
  expect(compatibilityDiagnostic(resumed)).toContain('decisive-release')
  expect(compatibilityDiagnostic(resumed)).not.toContain('future.advisory')
  expect(compatibilityDiagnostic(resumed)).not.toContain('advisory-release')
})

test('pre-deferral reader decodes the complete protocol without new values in known payloads', () => {
  // Freeze the pre-change known escalation schema, including its closed enum.
  const oldRaise = z.strictObject({
    id: z.string().min(1),
    phase: z.string(),
    round: z.number().int().positive().optional(),
    source: z.enum(['agent', 'stall', 'policy']),
    policyCause: z
      .enum([
        'review-round-limit',
        'verify-failure-limit',
        'reconcile-no-progress',
        'dispatch-failure-limit',
        'execution-no-progress',
        'setup-failure-limit',
        'infrastructure-failure-limit',
        'phase-attempt-limit',
        'non-retryable-phase-failure',
      ])
      .optional(),
    question: z.string().min(1),
    refs: z.array(z.string()).optional(),
  })
  const oldSchemas = { ...eventPayloadSchemas, 'escalation.raised': oldRaise } as Record<
    string,
    z.ZodType
  >
  for (const type of ['session.build-read-failed', 'phase.deferred', 'phase.deferral-escalated'])
    delete oldSchemas[type]
  const payloads = [
    [
      'session.started',
      { session: 's_read', role: 'plan', runner: 'test', phase: 'plan', round: 1 },
    ],
    [
      'session.build-read-failed',
      {
        session: 's_read',
        phase: 'plan',
        round: 1,
        operation: 'context',
        reason: 'own-build-read',
        diagnostic: 'unreadable',
      },
    ],
    [
      'session.ended',
      {
        session: 's_read',
        outcome: 'reclaimed',
        reclaimedBy: { instance: 'old', resumedFromSeq: 0 },
      },
    ],
    [
      'phase.deferred',
      {
        session: 's_read',
        phase: 'plan',
        round: 1,
        reason: 'own-build-read',
        diagnostic: 'unreadable',
      },
    ],
    [
      'phase.deferral-escalated',
      {
        id: 'esc_read',
        session: 's_read',
        phase: 'plan',
        round: 1,
        evidenceSeq: 2,
        question: 'Repair access then retry',
        refs: ['own-build-read:2'],
      },
    ],
    ['escalation.answered', { id: 'esc_read', answer: 'repaired', resolution: 'guidance' }],
  ] as const
  const oldState = initialCompatibility()
  for (let i = 0; i < payloads.length; i++) {
    const [type, payload] = payloads[i]!
    const event = { ...newerFact(i + 1, 'decisive'), type, payload }
    const schema = oldSchemas[type]
    if (schema) expect(() => projectPayload(schema, payload)).not.toThrow()
    else {
      // The old catalog's unknown branch retains the original envelope as opaque
      // decisive evidence. Exercise that same branch in the current decoder.
      expect(event.compatibility).toMatchObject({ classification: 'decisive' })
      advanceCompatibility(oldState, [{ ...event, type: `pre-reader-unknown.${type}` }])
    }
    if (i >= 1) expect(compatibilityDiagnostic(oldState)).toContain('Kernel decisions deferred')
  }
  expect(oldState.decisiveFacts).toBe(3)
  expect(() =>
    projectPayload(oldRaise, {
      id: 'bad',
      phase: 'plan',
      source: 'policy',
      policyCause: 'own-build-read',
      question: 'bad enum',
    }),
  ).toThrow()
})

test('pre-stage readers validate the entire failure log and defer on the new decisive receipt', () => {
  const ref = z.strictObject({ kind: z.string(), rev: z.number().int().nonnegative() })
  // Frozen pre-stage wire schema: verify is an object, never an array.
  const oldImplement = z.strictObject({
    round: z.number().int().positive(),
    feedback: z
      .union([
        z.strictObject({ findings: z.array(z.string()) }),
        z.strictObject({ verify: z.strictObject({ step: z.string(), report: ref }) }),
        z.strictObject({
          guidance: z.strictObject({ escalation: z.string(), answer: z.string() }),
        }),
      ])
      .optional(),
  })
  const schemas = { ...eventPayloadSchemas, 'implement.started': oldImplement } as Record<
    string,
    z.ZodType
  >
  delete schemas['verify.cancelled']
  delete schemas['verify.stage-failed']
  for (const cancelled of [false, true]) {
    const report = { kind: 'verify-report:a', rev: 0 }
    const payloads: Array<[string, unknown]> = [
      ['verify.started', { step: 'a', attempt: 1 }],
      ['verify.started', { step: 'b', attempt: 1 }],
      ['verify.completed', { step: 'a', attempt: 1, outcome: 'fail', report }],
      cancelled
        ? ['verify.cancelled', { step: 'b', attempt: 1, cause: { step: 'a' } }]
        : [
            'verify.completed',
            { step: 'b', attempt: 1, outcome: 'fail', report: { kind: 'verify-report:b', rev: 0 } },
          ],
      [
        'verify.stage-failed',
        {
          attempt: 1,
          cycle: 0,
          stage: ['a', 'b'],
          failed: [{ step: 'a', report }],
          cancelled: cancelled ? [{ step: 'b', cause: { step: 'a' } }] : [],
        },
      ],
      [
        'implement.started',
        { round: 2, feedback: { verify: { step: 'a', report } }, verifyStageFailure: 5 },
      ],
    ]
    const opaque = []
    const oldCompatibility = initialCompatibility()
    // Frozen old catalog read: project every known payload first, retaining
    // unknown envelopes as opaque decisive evidence before any routing.
    const decoded: Array<{ type: string; payload: unknown }> = []
    for (const [type, payload] of payloads) {
      if (schemas[type]) {
        expect(() => projectPayload(schemas[type]!, payload)).not.toThrow()
        decoded.push({ type, payload: projectPayload(schemas[type]!, payload) })
      } else {
        expect(buildEventPolicy[type as keyof typeof buildEventPolicy]).toBe('decisive')
        opaque.push(type)
        decoded.push({ type, payload })
        oldCompatibility.unknownFacts += 1
        oldCompatibility.decisiveFacts += 1
        oldCompatibility.decisiveTypes.push(type)
      }
    }
    expect(opaque).toContain('verify.stage-failed')
    expect(decoded).toHaveLength(payloads.length)
    expect(mixedVersionDeferred({ compatibility: oldCompatibility })).toBe(true)
    expect(compatibilityDiagnostic(oldCompatibility)).toContain('Kernel decisions deferred')
    expect(projectPayload(oldImplement, payloads.at(-1)![1])).not.toHaveProperty(
      'verifyStageFailure',
    )
  }
})

test('persisted polling checkpoints remain advisory for a reader without the type', async () => {
  const { MemoryBuildStore } = await import('../store/memory')
  const { DISPATCHER } = await import('./envelope')
  const store = new MemoryBuildStore()
  await store.ensureRepo('/poll-compat')
  await store.createBuild({ slug: 'poll-compat', repo: '/poll-compat' })
  const event = await store.append('poll-compat', {
    actor: DISPATCHER,
    type: 'node.poll-checked',
    payload: {
      activityKey: 'key',
      unchangedSince: new Date().toISOString(),
      nodeIdleAfterSeconds: 600,
      nodeIdlePollSeconds: 120,
    },
  })
  expect(buildEventPolicy['node.poll-checked']).toBe('advisory')
  expect(event.compatibility?.classification).toBe('advisory')
  // Model the missing catalog entry at the same unknown-type seam as the
  // older-reader fixtures above, retaining the actual producer metadata.
  const opaque = { ...event, type: 'old-reader-unknown.node.poll-checked' }
  const before = structuredClone(opaque)
  expect(decodeStoredEvent(opaque)).toBeNull()
  const state = initialCompatibility()
  advanceCompatibility(state, [opaque])
  expect(state.decisiveFacts).toBe(0)
  expect(compatibilityDiagnostic(state)).toBeUndefined()
  expect(opaque).toEqual(before)
  advanceCompatibility(state, [newerFact(event.seq + 1, 'decisive')])
  expect(state.decisiveFacts).toBe(1)
  advanceCompatibility(state, [{ ...newerFact(event.seq + 2), compatibility: undefined }])
  expect(state.decisiveFacts).toBe(2)
})
