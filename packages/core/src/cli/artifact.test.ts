import { describe, expect, test } from 'bun:test'
import { parseArtifactSpec } from './artifact'

describe('parseArtifactSpec', () => {
  test('parses bare kinds, @rev suffixes, and kinds containing colons', () => {
    expect(parseArtifactSpec('plan')).toEqual({ kind: 'plan' })
    expect(parseArtifactSpec('plan@2')).toEqual({ kind: 'plan', rev: 2 })
    expect(parseArtifactSpec('verify-report:e2e@0')).toEqual({
      kind: 'verify-report:e2e',
      rev: 0,
    })
  })

  test('rejects malformed refs with the expected format', () => {
    expect(() => parseArtifactSpec('plan@latest')).toThrow(/'<kind>@<rev>'/)
    expect(() => parseArtifactSpec('@2')).toThrow(/invalid artifact ref/)
  })
})
