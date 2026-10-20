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
import { compatibilityDiagnostic } from '../kernel/mixed-version'
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
