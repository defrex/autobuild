import { describe, expect, test } from 'bun:test'
import type { LandingRule } from '../config/schema'
import { HEAD_PATHS_ARTIFACT } from '../events/head-paths-limits'
import { consentRevocation, resolutionPathsFor, revocableConsent } from './consent-revocation'
import type { HeadPathsArtifact, HeadPathsSummary } from './head-paths'
import type { LandingState } from './landing-state'

const consent = (snapshot: LandingRule | undefined, extra: Partial<LandingState['command']> = {}) =>
  ({
    command: {
      kind: 'land',
      seq: 7,
      decisionSeq: 6,
      head: 'reviewed',
      ...(snapshot === undefined ? {} : { rule: { index: 2, snapshot } }),
      ...extra,
    },
  }) as LandingState
const input = (resolution: readonly string[]) => ({
  source: 'reconcile' as const,
  previousHead: 'old',
  head: 'new',
  resolution,
})

describe('consent revocation', () => {
  test('a paths rule revokes on matched resolution paths, sorted and bounded', () => {
    const resolution = [
      'src/x.ts',
      ...Array.from({ length: 25 }, (_, index) => `protected/${String(index).padStart(2, '0')}`),
      'protected/00',
    ].reverse()
    const payload = consentRevocation(
      consent({ paths: ['protected/**'], mode: 'consent' }),
      input(resolution),
    )
    expect(payload).toEqual({
      commandSeq: 7,
      source: 'reconcile',
      rule: { index: 2, snapshot: { paths: ['protected/**'], mode: 'consent' } },
      previousHead: 'old',
      head: 'new',
      consentedHead: 'reviewed',
      paths: {
        total: 25,
        preview: Array.from(
          { length: 20 },
          (_, index) => `protected/${String(index).padStart(2, '0')}`,
        ),
      },
    })
  })

  test('within selectors match per file, without the every-path condition', () => {
    const payload = consentRevocation(
      consent({ within: ['config/**'], mode: 'consent' }),
      input(['config/a.toml', 'src/x.ts']),
    )
    expect(payload?.paths).toEqual({ total: 1, preview: ['config/a.toml'] })
  })

  test('unprotected edits, clean restacks and non-path consent keep consent', () => {
    const rule: LandingRule = { paths: ['autobuild.toml'], mode: 'consent' }
    expect(consentRevocation(consent(rule), input(['src/x.ts']))).toBeUndefined()
    expect(consentRevocation(consent(rule), input([]))).toBeUndefined()
    expect(consentRevocation(consent(undefined), input(['autobuild.toml']))).toBeUndefined()
    expect(revocableConsent(consent(undefined))).toBe(false)
  })

  test('holds, legacy consent and absent commands are never revoked', () => {
    const rule: LandingRule = { paths: ['autobuild.toml'], mode: 'consent' }
    for (const landing of [
      consent(rule, { kind: 'hold' }),
      consent(rule, { legacy: true }),
      {} as LandingState,
      undefined,
    ]) {
      expect(revocableConsent(landing)).toBe(false)
      expect(consentRevocation(landing, input(['autobuild.toml']))).toBeUndefined()
    }
  })

  test('consentedHead is carried only when known', () => {
    const payload = consentRevocation(
      consent({ paths: ['a'], mode: 'consent' }, { head: undefined }),
      input(['a']),
    )
    expect(payload).toBeDefined()
    expect(payload).not.toHaveProperty('consentedHead')
  })
})

describe('resolution paths', () => {
  const record = (resolution?: { total: number; preview: string[] }): HeadPathsSummary => ({
    source: 'reconcile',
    head: 'new',
    destination: 'base',
    mergeBase: 'base',
    total: 0,
    preview: [],
    ...(resolution === undefined ? {} : { resolution }),
    artifact: { kind: HEAD_PATHS_ARTIFACT, rev: 3 },
    seq: 9,
  })
  const counting = (content?: HeadPathsArtifact) => {
    const store = {
      reads: 0,
      async getArtifact() {
        store.reads++
        return content === undefined
          ? null
          : ({ content: new TextEncoder().encode(JSON.stringify(content)) } as never)
      },
    }
    return store
  }

  test('uses deposited facts or a complete preview without reading the artifact', async () => {
    const store = counting()
    const facts: HeadPathsArtifact = {
      version: 1,
      head: 'new',
      destination: 'base',
      mergeBase: 'base',
      paths: [],
      resolution: { paths: ['a', 'b'] },
    }
    expect(
      await resolutionPathsFor(store, 'slug', {
        recorded: 'appended',
        event: {} as never,
        facts,
      }),
    ).toEqual(['a', 'b'])
    expect(
      await resolutionPathsFor(store, 'slug', {
        recorded: 'existing',
        record: record({ total: 1, preview: ['a'] }),
      }),
    ).toEqual(['a'])
    expect(
      await resolutionPathsFor(store, 'slug', { recorded: 'existing', record: record() }),
    ).toEqual([])
    expect(store.reads).toBe(0)
  })

  test('reads the artifact exactly once when the preview is incomplete', async () => {
    const paths = Array.from({ length: 150 }, (_, index) => `f${String(index).padStart(3, '0')}`)
    const store = counting({
      version: 1,
      head: 'new',
      destination: 'base',
      mergeBase: 'base',
      paths: [],
      resolution: { paths },
    })
    expect(
      await resolutionPathsFor(store, 'slug', {
        recorded: 'existing',
        record: record({ total: 150, preview: paths.slice(0, 100) }),
      }),
    ).toEqual(paths)
    expect(store.reads).toBe(1)
  })
})
