import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
// The registry loads first: it fills the identity graph and settles import order.
import { REDUCERS } from './reducer-registry'
import { setupStreakReducer } from './setup-streak'
import {
  readReducerValue,
  type ReducerValueStorage,
  type ValueCacheRow,
} from '../store/reducer-values'
import {
  BASE_RELATIVE_SKIPPED_PREFIX,
  LEDGER_PATH,
  LEGACY_REDUCER_VERSIONS,
  LEDGER_SENTINEL,
  REGENERATE_COMMAND,
  REVISION_GUARD_SKIPPED_PREFIX,
  UNREGENERATED_COMBINATION_PREFIX,
  appendRevision,
  canonicalJson,
  checkAgainstBase,
  checkIdentityRecords,
  checkRevisionsSinceBase,
  deriveReducerVersion,
  evaluationCorpora,
  foldDigest,
  formatBaseRelativeSkipped,
  formatRevisionGuardSkipped,
  formatUnregeneratedCombination,
  parseLedgerSource,
  parseRecordFile,
  parseRevisions,
  planRegeneration,
  recordKey,
  renderRecordFile,
  revisionSet,
  unrevisedSinceBase,
  type CurrentIdentity,
  type IdentityGraph,
  type IdentityRecord,
  type Ledger,
} from './reducer-identity'

const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex')
const BASE_SOURCE = `export const REDUCER_REVISIONS: Readonly<Record<string, string>> = {
  ${LEDGER_SENTINEL}: 'not a revision; append revisions below',
}
`
/** The ledger object a source declares: one `'key': 'value',` line per entry. */
function ledgerOf(source: string): Ledger {
  return Object.fromEntries(
    [...source.matchAll(/^ {2}'?([^':]+)'?: '([^']*)',$/gm)].map((m) => [m[1]!, m[2]!]),
  )
}
/** What `merge=union` keeps when two branches append different lines. */
function unionMerge(base: string, a: string, b: string): string {
  const added = (side: string) =>
    side.split('\n').filter((line) => !base.split('\n').includes(line))
  const lines = base.split('\n')
  const close = lines.lastIndexOf('}')
  return [...lines.slice(0, close), ...added(a), ...added(b), ...lines.slice(close)].join('\n')
}

const graph = new Map<string, readonly string[]>([['composite', ['build', 'harvest']]])

describe('reducer identity derivation', () => {
  test('the frozen base and the empty ledger reproduce the published versions', () => {
    expect(deriveReducerVersion({ identity: 'build', ledger: ledgerOf(BASE_SOURCE) })).toBe(
      LEGACY_REDUCER_VERSIONS.build!,
    )
    expect(deriveReducerVersion({ identity: 'brandNew', ledger: {} })).toBe(1)
    expect(
      deriveReducerVersion({ identity: 'composite', ledger: {}, graph }) -
        (LEGACY_REDUCER_VERSIONS.build! + LEGACY_REDUCER_VERSIONS.harvest!),
    ).toBe(1)
  })

  test('independent revisions combine into a version distinct from either branch', () => {
    const a = appendRevision(BASE_SOURCE, {
      identity: 'build',
      kind: 'fold',
      reason: 'AUT-1 A',
      id: 'aaaaaaaaaa',
    })
    const b = appendRevision(BASE_SOURCE, {
      identity: 'build',
      kind: 'shape',
      reason: 'AUT-2 B',
      id: 'bbbbbbbbbb',
    })
    const merged = unionMerge(BASE_SOURCE, a, b)
    const version = (source: string) =>
      deriveReducerVersion({ identity: 'build', ledger: ledgerOf(source) })
    const base = version(BASE_SOURCE)
    expect([version(a), version(b), version(merged)]).toEqual([base + 1, base + 1, base + 2])
    expect(parseRevisions(ledgerOf(merged)).map((revision) => revision.id)).toEqual([
      'aaaaaaaaaa',
      'bbbbbbbbbb',
    ])
  })

  test('a part revision and a composite revision combine through the parts', () => {
    const partRevised = { 'build/fold/aaaaaaaaaa': 'part' }
    const compositeRevised = { 'composite/fold/bbbbbbbbbb': 'composite' }
    const v = (ledger: Ledger) => deriveReducerVersion({ identity: 'composite', ledger, graph })
    const base = v({})
    expect(v(partRevised)).toBe(base + 1)
    expect(v(compositeRevised)).toBe(base + 1)
    expect(v({ ...partRevised, ...compositeRevised })).toBe(base + 2)
    expect(revisionSet('composite', { ...partRevised, ...compositeRevised }, graph)).toEqual([
      'build/fold/aaaaaaaaaa',
      'composite/fold/bbbbbbbbbb',
    ])
  })

  test('parseRevisions skips the sentinel and rejects malformed keys', () => {
    expect(parseRevisions({ [LEDGER_SENTINEL]: 'x' })).toEqual([])
    expect(parseRevisions({ 'build/shape/0123456789': 'AUT-1 r' })).toEqual([
      {
        key: 'build/shape/0123456789',
        identity: 'build',
        kind: 'shape',
        id: '0123456789',
        reason: 'AUT-1 r',
      },
    ])
    for (const key of ['build/rename/0123456789', 'build/shape/short', 'build-shape-0123456789'])
      expect(() => parseRevisions({ [key]: 'r' })).toThrow('malformed reducer revision key')
  })

  test('appendRevision writes one line and refuses a reason that would break it', () => {
    const next = appendRevision(BASE_SOURCE, {
      identity: 'build',
      kind: 'fold',
      reason: 'AUT-1267 records X',
      id: 'k7x2q9ab3d',
    })
    expect(next).toBe(
      BASE_SOURCE.replace('\n}', "\n  'build/fold/k7x2q9ab3d': 'AUT-1267 records X',\n}"),
    )
    const revision = { identity: 'build', kind: 'fold', id: 'k7x2q9ab3d' } as const
    expect(() => appendRevision(BASE_SOURCE, { ...revision, reason: 'x'.repeat(80) })).toThrow(
      'too long',
    )
    expect(() => appendRevision(BASE_SOURCE, { ...revision, reason: "it's" })).toThrow('quotes')
    expect(() => appendRevision(BASE_SOURCE, { ...revision, reason: 'a\nb' })).toThrow('one')
    expect(() => appendRevision(BASE_SOURCE, { ...revision, reason: 'r', id: 'BAD' })).toThrow(
      'invalid',
    )
  })
})

describe('combined identities in the canonical store', () => {
  test('values saved under either branch are never served to the combined code', async () => {
    const entry = REDUCERS.setupStreak!.valueRead
    if ('excluded' in entry) throw new Error('setupStreak is a value reducer')
    const events = Array.from({ length: 20 }, (_, index) => ({
      type: 'build.paused',
      build: 'b',
      seq: index + 1,
      ts: '2026-11-20T00:00:00Z',
      actor: { kind: 'kernel' },
      payload: {},
    })) as unknown as AbEvent[]
    const rows = new Map<string, ValueCacheRow>()
    let eventRows = 0
    const storage: ReducerValueStorage = {
      highWater: async () => events.length,
      events: async (since, through) => {
        const delta = events.filter((event) => event.seq > since && event.seq <= through)
        eventRows += delta.length
        return structuredClone(delta)
      },
      read: async (key) => structuredClone(rows.get(key) ?? null),
      put: async (key, snapshot) => {
        rows.set(key, { snapshot: structuredClone(snapshot), token: JSON.stringify(snapshot) })
        return true
      },
      repair: async () => false,
    }
    const ledgers: Record<string, Ledger> = {
      a: { 'setupStreak/fold/aaaaaaaaaa': 'A' },
      b: { 'setupStreak/fold/bbbbbbbbbb': 'B' },
    }
    ledgers.combined = { ...ledgers.a, ...ledgers.b }
    const create = entry.create
    const read = async (ledger: Ledger) => {
      const version = deriveReducerVersion({ identity: 'setupStreak', ledger })
      entry.create = () => ({ ...setupStreakReducer, version })
      eventRows = 0
      const value = await readReducerValue(
        { kind: 'build', slug: 'b' },
        { reducer: 'setupStreak' },
        storage,
      )
      return { version: value.version, eventRows }
    }
    try {
      const a = await read(ledgers.a!)
      const b = await read(ledgers.b!)
      expect(a.version).toBe(b.version)
      const saved = structuredClone([...rows])
      const combined = await read(ledgers.combined)
      expect(combined.version).toBeGreaterThan(a.version)
      // A full reduction under a new key: neither branch's row was served or rewritten.
      expect(combined.eventRows).toBe(events.length)
      expect(rows.size).toBe(saved.length + 1)
      for (const [key, row] of saved) expect(rows.get(key)).toEqual(row)
      expect((await read(ledgers.combined)).eventRows).toBe(0)
    } finally {
      entry.create = create
    }
  })
})

const corpus = [
  { type: 'runner.attached', seq: 1, payload: { instance: 'r', host: 'h', resumedFromSeq: 0 } },
  { type: 'runner.setup-failed', seq: 2, payload: { error: 'x' } },
  { type: 'runner.setup-failed', seq: 3, payload: { error: 'y' } },
] as unknown as AbEvent[]
type Streak = typeof setupStreakReducer
const digest = (reducer: Pick<Streak, 'initial' | 'advance'>, log: readonly AbEvent[] = corpus) =>
  sha256(canonicalJson(reducer.advance(reducer.initial(), log))).slice(0, 32)
/** The same shape, a different fold: an attachment moves the boundary one further. */
const flipped: Pick<Streak, 'initial' | 'advance'> = {
  initial: setupStreakReducer.initial,
  advance(acc, events) {
    const next = setupStreakReducer.advance(acc, events)
    for (const event of events) if (event.type === 'runner.attached') next.boundary = event.seq + 1
    return next
  },
}
/** A behaviour-identical refactor: one event at a time. */
const refactored: Pick<Streak, 'initial' | 'advance'> = {
  initial: setupStreakReducer.initial,
  advance: (acc, events) =>
    events.reduce((next, event) => setupStreakReducer.advance(next, [event]), acc),
}

const IDENTITY = 'setupStreak'
function record(revisions: string[], entries: Record<string, string>): IdentityRecord {
  const rendered = renderRecordFile(
    [{ name: IDENTITY, identity: IDENTITY, revisions, entries }],
    sha256,
  )
  return parseRecordFile(rendered.file, rendered.content, sha256)[0]!
}
function current(revisions: string[], digests: Record<string, string>): CurrentIdentity {
  return { name: IDENTITY, identity: IDENTITY, revisions, digests }
}
const check = (
  now: CurrentIdentity,
  records: IdentityRecord[],
  currentCids = Object.keys(now.digests),
) => checkIdentityRecords({ current: [now], currentCids, records, hash: sha256 })
const A = 'setupStreak/fold/aaaaaaaaaa'
const B = 'setupStreak/shape/bbbbbbbbbb'

describe('identity records', () => {
  test('a fold-only change without a revision is a case-1 violation', () => {
    expect(digest(flipped)).not.toBe(digest(setupStreakReducer))
    const result = check(current([], { c1: digest(flipped) }), [
      record([], { c1: digest(setupStreakReducer) }),
    ])
    expect(result.violations.map((violation) => violation.kind)).toEqual(['changed'])
    expect(result.violations[0]!.message).toContain('bun tools/reducer-revision.ts')
    expect(result.unregeneratedCombinations).toEqual([])
  })

  test('a revision added without regeneration is a missing record', () => {
    const result = check(current([A], { c1: digest(setupStreakReducer) }), [
      record([], { c1: digest(setupStreakReducer) }),
    ])
    expect(result.violations.map((violation) => violation.kind)).toEqual(['missing-record'])
  })

  test('a deleted base record is a missing record', () => {
    const result = check(current([], { c1: digest(setupStreakReducer) }), [])
    expect(result.violations.map((violation) => violation.kind)).toEqual(['missing-record'])
  })

  test('a behaviour-identical refactor keeps every digest', () => {
    expect(digest(refactored)).toBe(digest(setupStreakReducer))
    expect(
      check(current([], { c1: digest(refactored) }), [
        record([], { c1: digest(setupStreakReducer) }),
      ]),
    ).toEqual({ violations: [], unregeneratedCombinations: [] })
  })

  test('a clean combination is reported, never silent', () => {
    const original = digest(setupStreakReducer)
    const records = [record([A], { c1: 'a-digest' }), record([B], { c1: 'b-digest' })]
    const result = check(current([A, B], { c1: original }), records)
    expect(result.violations).toEqual([])
    expect(result.unregeneratedCombinations).toEqual([
      {
        name: IDENTITY,
        identity: IDENTITY,
        revisions: [A, B],
        coveredBy: [recordKey(IDENTITY, [A], sha256), recordKey(IDENTITY, [B], sha256)].sort(),
      },
    ])
    const notice = formatUnregeneratedCombination(result.unregeneratedCombinations[0]!)
    expect(notice.startsWith(`${UNREGENERATED_COMBINATION_PREFIX}: setupStreak`)).toBe(true)
    expect(notice).toContain(REGENERATE_COMMAND)
    expect(notice).toContain('AB_VERIFY_BASE')
  })

  test('a fold change on an unregenerated combination is named until regeneration, then fails', () => {
    const records = [record([A], { c1: 'a-digest' }), record([B], { c1: 'b-digest' })]
    const changed = current([A, B], { c1: digest(flipped) })
    const before = check(changed, records)
    expect(before.violations).toEqual([])
    expect(before.unregeneratedCombinations.map((entry) => entry.name)).toEqual([IDENTITY])
    const regenerated = [...records, record([A, B], { c1: digest(setupStreakReducer) })]
    const after = check(changed, regenerated)
    expect(after.violations.map((violation) => violation.kind)).toEqual(['changed'])
    expect(after.unregeneratedCombinations).toEqual([])
  })

  test('an exact record reports no combination', () => {
    const result = check(current([A], { c1: digest(setupStreakReducer) }), [
      record([A], { c1: digest(setupStreakReducer) }),
    ])
    expect(result).toEqual({ violations: [], unregeneratedCombinations: [] })
  })

  const c1 = corpus.slice(0, 2)
  const c2 = corpus
  const c2Edited = [...corpus, { ...corpus[2]!, seq: 4 }] as AbEvent[]
  const c3 = corpus.slice(1)
  test('a fold change hidden behind a corpus change still fails on the archived corpus', () => {
    const base = record([], {
      c1: digest(setupStreakReducer, c1),
      c2: digest(setupStreakReducer, c2),
    })
    const key = recordKey(IDENTITY, [], sha256)
    const currentCids = ['c2e', 'c3']
    const toFold = evaluationCorpora({ name: IDENTITY, key, records: [base], currentCids })
    expect(toFold).toEqual(['c1', 'c2', 'c2e', 'c3'])
    const archive: Record<string, readonly AbEvent[]> = { c1, c2, c2e: c2Edited, c3 }
    const now = current(
      [],
      Object.fromEntries(toFold.map((cid) => [cid, digest(flipped, archive[cid])])),
    )
    const result = check(now, [base], currentCids)
    expect(
      result.violations.filter((violation) => violation.kind === 'changed').length,
    ).toBeGreaterThan(0)
    expect(
      planRegeneration({
        current: [now],
        currentCids,
        records: [base],
        archived: new Set(['c1', 'c2']),
        hash: sha256,
      }),
    ).toEqual({
      refused: expect.arrayContaining([expect.stringContaining('without a revision')]),
      archive: [],
    })
  })

  test('a corpus-only update adds entries under the unchanged identity', () => {
    const base = record([], {
      c1: digest(setupStreakReducer, c1),
      c2: digest(setupStreakReducer, c2),
    })
    const currentCids = ['c2e', 'c3']
    const archive: Record<string, readonly AbEvent[]> = { c1, c2, c2e: c2Edited, c3 }
    const now = current(
      [],
      Object.fromEntries(
        Object.entries(archive).map(([cid, log]) => [cid, digest(setupStreakReducer, log)]),
      ),
    )
    expect(check(now, [base], currentCids).violations.map((violation) => violation.kind)).toEqual([
      'unrecorded-corpus',
      'unrecorded-corpus',
    ])
    const plan = planRegeneration({
      current: [now],
      currentCids,
      records: [base],
      archived: new Set(['c1', 'c2']),
      hash: sha256,
    })
    expect(plan.refused).toEqual([])
    expect(plan.archive).toEqual(['c2e', 'c3'])
    // Only the new entries, in a new file beside the untouched base record.
    const added = parseRecordFile(plan.write!.file, plan.write!.content, sha256)
    expect(added.map((entry) => [entry.key, Object.keys(entry.entries)])).toEqual([
      [base.key, ['c2e', 'c3']],
    ])
    expect(added[0]!.file).not.toBe(base.file)
    expect(check(now, [base, ...added], currentCids)).toEqual({
      violations: [],
      unregeneratedCombinations: [],
    })
  })

  test('records for one key are unioned, and disagreeing records fail', () => {
    const d = digest(setupStreakReducer)
    const agree = check(current([], { c1: d, c2: d }), [
      record([], { c1: d }),
      record([], { c2: d }),
    ])
    expect(agree.violations).toEqual([])
    const disagree = check(current([], { c1: d }), [
      record([], { c1: d }),
      record([], { c1: 'other' }),
    ])
    expect(disagree.violations.map((violation) => violation.kind)).toEqual(['disagreeing-records'])
  })

  test('a missing archived corpus names its id', () => {
    const d = digest(setupStreakReducer)
    const result = check(current([], { c2: d }), [record([], { c1: d, c2: d })], ['c2'])
    expect(result.violations.map((violation) => violation.kind)).toEqual(['missing-archive'])
    expect(result.violations[0]!.message).toContain('c1')
  })

  test('a record whose name does not address its content is refused', () => {
    const rendered = renderRecordFile(
      [{ name: IDENTITY, identity: IDENTITY, revisions: [], entries: { c1: 'x' } }],
      sha256,
    )
    expect(() =>
      parseRecordFile(rendered.file, rendered.content.replace('"x"', '"y"'), sha256),
    ).toThrow('does not match its content')
  })

  test('records of removed reducers and superseded identities stay inert', () => {
    const d = digest(setupStreakReducer)
    const gone = renderRecordFile(
      [
        { name: 'gone', identity: 'gone', revisions: [], entries: { c1: 'x' } },
        { name: IDENTITY, identity: IDENTITY, revisions: [], entries: { c1: 'superseded' } },
      ],
      sha256,
    )
    const records = [record([A], { c1: d }), ...parseRecordFile(gone.file, gone.content, sha256)]
    expect(check(current([A], { c1: d }), records)).toEqual({
      violations: [],
      unregeneratedCombinations: [],
    })
    expect(
      planRegeneration({
        current: [current([A], { c1: d })],
        currentCids: ['c1'],
        records,
        archived: new Set(['c1']),
        hash: sha256,
      }),
    ).toEqual({ refused: [], archive: [] })
  })

  test('regeneration at a new identity records every current corpus and nothing else', () => {
    const d = digest(setupStreakReducer)
    const plan = planRegeneration({
      current: [current([A], { c1: d, c2: d })],
      currentCids: ['c1', 'c2'],
      records: [record([], { c0: 'old', c1: d })],
      archived: new Set(['c0', 'c1']),
      hash: sha256,
    })
    const added = parseRecordFile(plan.write!.file, plan.write!.content, sha256)
    expect(added.map((entry) => [entry.revisions, entry.entries])).toEqual([
      [[A], { c1: d, c2: d }],
    ])
    expect(plan.archive).toEqual(['c2'])
  })
})

describe('identity changes relative to the verify base', () => {
  const BASE = 'b'.repeat(40)
  const baseDigests = (digests: Record<string, string>) => new Map([[IDENTITY, digests]])
  const againstBase = (now: CurrentIdentity, digests: Record<string, string>) =>
    checkAgainstBase({ current: [now], base: BASE, baseDigests: baseDigests(digests) })
  const ledgerSource = (keys: string[]) =>
    keys.reduce((source, key) => {
      const [identity, kind, id] = key.split('/') as [string, 'shape' | 'fold', string]
      return appendRevision(source, { identity, kind, id, reason: 'why' })
    }, BASE_SOURCE)

  test('parseLedgerSource reads the keys, skips the sentinel and rejects malformed keys', () => {
    expect(parseLedgerSource(ledgerSource([A, B]))).toEqual(new Set([A, B]))
    expect(parseLedgerSource(BASE_SOURCE)).toEqual(new Set())
    expect(() =>
      parseLedgerSource(BASE_SOURCE.replace('}', "  'setupStreak/fold/short': 'why',\n}")),
    ).toThrow('malformed reducer revision key')
  })

  test('a fold change after a clean combination fails against the base, though the records accept it', () => {
    // Base: {a} and {b} merged into the ledger; records only at {a} and {b}.
    const records = [record([A], { c1: 'a-digest' }), record([B], { c1: 'b-digest' })]
    const changed = current([A, B], { c1: foldDigest(flipped, corpus, sha256) })
    const byRecords = check(changed, records)
    expect(byRecords.violations).toEqual([])
    expect(byRecords.unregeneratedCombinations.map((entry) => entry.name)).toEqual([IDENTITY])
    const targets = unrevisedSinceBase([changed], parseLedgerSource(ledgerSource([A, B])))
    expect(targets.map((entry) => entry.name)).toEqual([IDENTITY])
    // The base had no {a,b} record, so its digest comes from folding its own code.
    const violations = againstBase(targets[0]!, {
      c1: foldDigest(setupStreakReducer, corpus, sha256),
    })
    expect(violations.map((violation) => violation.kind)).toEqual(['changed-since-base'])
    expect(violations[0]!.message).toContain(`${IDENTITY}: identity ${IDENTITY} folds corpus c1`)
    expect(violations[0]!.message).toContain(BASE.slice(0, 12))
    expect(violations[0]!.message).toContain('bun tools/reducer-revision.ts')
  })

  test('regenerating the changed digest at the head still fails against the base', () => {
    const changedDigest = foldDigest(flipped, corpus, sha256)
    const records = [
      record([A], { c1: 'a-digest' }),
      record([B], { c1: 'b-digest' }),
      record([A, B], { c1: changedDigest }),
    ]
    const changed = current([A, B], { c1: changedDigest })
    expect(check(changed, records)).toEqual({ violations: [], unregeneratedCombinations: [] })
    expect(
      againstBase(changed, { c1: foldDigest(setupStreakReducer, corpus, sha256) }).map(
        (violation) => violation.kind,
      ),
    ).toEqual(['changed-since-base'])
  })

  test('a head that adds a revision over the base is exempt, so a restack needs no regeneration', () => {
    const restacked = current([A, B], { c1: foldDigest(setupStreakReducer, corpus, sha256) })
    expect(unrevisedSinceBase([restacked], parseLedgerSource(ledgerSource([B])))).toEqual([])
  })

  test('a behaviour-identical edit folds to the base digest and passes', () => {
    const edited = current([A, B], { c1: foldDigest(refactored, corpus, sha256) })
    expect(againstBase(edited, { c1: foldDigest(setupStreakReducer, corpus, sha256) })).toEqual([])
  })

  test('only corpus ids both sides hold are compared, and a reducer new at the head is skipped', () => {
    const now = current([], { c1: 'same', headOnly: 'x' })
    expect(againstBase(now, { c1: 'same', baseOnly: 'y' })).toEqual([])
    expect(checkAgainstBase({ current: [now], base: BASE, baseDigests: new Map() })).toEqual([])
  })

  test('foldDigest stops at the chunk that throws and digests the accumulator it reached', () => {
    const log = Array.from({ length: 30 }, (_, seq) => ({ seq }))
    const throwing = {
      initial: () => ({ n: 0 }),
      advance(acc: { n: number }, events: readonly { seq: number }[]) {
        if (events.some((event) => event.seq >= 24)) throw new Error('other domain')
        return { n: acc.n + events.length }
      },
    }
    const visited: unknown[] = []
    const value = foldDigest(throwing, log, sha256, (acc) => visited.push(acc))
    expect(visited).toEqual([{ n: 12 }, { n: 24 }])
    expect(value).toBe(sha256(canonicalJson({ acc: { n: 24 }, threwAtChunk: 2 })).slice(0, 32))
  })

  test('a skipped base-relative clause is named, never silent', () => {
    const notice = formatBaseRelativeSkipped('AB_VERIFY_BASE is not set')
    expect(notice.startsWith(`${BASE_RELATIVE_SKIPPED_PREFIX}: AB_VERIFY_BASE is not set`)).toBe(
      true,
    )
  })
})

describe('revision guard', () => {
  const BASE = 'c'.repeat(40)
  const keysOf = (ledger: Ledger) => new Set(parseRevisions(ledger).map((r) => r.key))
  /** Versions as each side's code derives them through the real formula. */
  const versions = (input: {
    identities: readonly string[]
    ledger: Ledger
    legacy?: Readonly<Record<string, number>>
    graph?: IdentityGraph
  }) =>
    new Map(
      input.identities.map((identity) => [
        identity,
        deriveReducerVersion({
          identity,
          ledger: input.ledger,
          legacy: input.legacy ?? {},
          graph: input.graph ?? new Map(),
        }),
      ]),
    )
  const guard = (input: {
    identities: readonly string[]
    base: { ledger: Ledger; legacy?: Record<string, number>; graph?: IdentityGraph }
    head: {
      ledger: Ledger
      legacy?: Record<string, number>
      graph?: IdentityGraph
      identities?: readonly string[]
    }
  }) =>
    checkRevisionsSinceBase({
      base: BASE,
      baseLedger: keysOf(input.base.ledger),
      headLedger: keysOf(input.head.ledger),
      baseVersions: versions({ identities: input.identities, ...input.base }),
      headVersions: versions({
        ...input.head,
        identities: input.head.identities ?? input.identities,
      }),
    })
  const A = 'build/fold/aaaaaaaaaa'
  const B = 'build/fold/bbbbbbbbbb'

  test('a removed revision fails, naming the key, its identity and the lowered version', () => {
    const violations = guard({
      identities: ['build'],
      base: { ledger: { [A]: 'why' }, legacy: { build: 51 } },
      head: { ledger: {}, legacy: { build: 51 } },
    })
    expect(violations.map((v) => v.kind)).toEqual(['removed-revision', 'lowered-version'])
    expect(violations.map((v) => v.name)).toEqual(['build', 'build'])
    expect(violations[0]!.message).toContain(`reducer revision ${A} (identity build)`)
    expect(violations[0]!.message).toContain(BASE.slice(0, 12))
    expect(violations[1]!.message).toContain(
      'reducer identity build derives version 51 at HEAD, below version 52',
    )
  })

  test('a lowered frozen legacy version fails', () => {
    const violations = guard({
      identities: ['build'],
      base: { ledger: { [A]: 'why' }, legacy: { build: 51 } },
      head: { ledger: { [A]: 'why' }, legacy: { build: 50 } },
    })
    expect(violations.map((v) => v.kind)).toEqual(['lowered-version'])
    expect(violations[0]!.message).toContain('version 51 at HEAD, below version 52')
  })

  test('a version lowered through a part fails for the part and the composite', () => {
    const graph = new Map([['composite', ['part']]])
    const violations = guard({
      identities: ['composite', 'part'],
      base: { ledger: {}, legacy: { part: 3 }, graph },
      head: { ledger: {}, legacy: { part: 2 }, graph },
    })
    expect(violations.map((v) => [v.kind, v.name])).toEqual([
      ['lowered-version', 'composite'],
      ['lowered-version', 'part'],
    ])
  })

  test('a composite that drops a declared part fails', () => {
    const violations = guard({
      identities: ['composite', 'part', 'other'],
      base: { ledger: {}, graph: new Map([['composite', ['part', 'other']]]) },
      head: { ledger: {}, graph: new Map([['composite', ['part']]]) },
    })
    expect(violations.map((v) => [v.kind, v.name])).toEqual([['lowered-version', 'composite']])
    expect(violations[0]!.message).toContain('version 2 at HEAD, below version 3')
  })

  test('an added revision passes', () => {
    expect(
      guard({
        identities: ['build', 'harvest'],
        base: { ledger: { [A]: 'why' } },
        head: { ledger: { [A]: 'why', 'harvest/shape/cccccccccc': 'why' } },
      }),
    ).toEqual([])
  })

  test('a revert by revision keeps the base line, adds one, and passes', () => {
    expect(
      guard({
        identities: ['build'],
        base: { ledger: { [A]: 'why' } },
        head: { ledger: { [A]: 'why', [B]: 'revert' } },
      }),
    ).toEqual([])
  })

  test('a deregistered reducer that keeps its ledger lines passes, and a new one is ignored', () => {
    const ledger = { [A]: 'why', 'gone/fold/dddddddddd': 'why' }
    expect(
      guard({
        identities: ['build', 'gone'],
        base: { ledger },
        head: { ledger, identities: ['build', 'fresh'] },
      }),
    ).toEqual([])
  })

  test('every message states the remedy without suggesting a ledger edit or deletion', () => {
    const violations = guard({
      identities: ['build'],
      base: { ledger: { [A]: 'why' }, legacy: { build: 51 } },
      head: { ledger: {}, legacy: { build: 50 } },
    })
    expect(violations).toHaveLength(2)
    for (const { message } of violations) {
      expect(message).toContain('bun tools/reducer-revision.ts')
      expect(message).toContain('restore')
      expect(message).toContain(LEDGER_PATH)
      expect(message).not.toMatch(/delete/i)
      expect(message).not.toMatch(/\bedit/i)
    }
  })

  test('a skipped revision guard is named, never silent', () => {
    expect(formatRevisionGuardSkipped('x').startsWith(`${REVISION_GUARD_SKIPPED_PREFIX}: x`)).toBe(
      true,
    )
  })

  test('the legacy input defaults to the frozen versions', () => {
    expect(deriveReducerVersion({ identity: 'build' })).toBe(
      deriveReducerVersion({ identity: 'build', legacy: LEGACY_REDUCER_VERSIONS }),
    )
    expect(deriveReducerVersion({ identity: 'build', ledger: {}, graph: new Map() })).toBe(
      LEGACY_REDUCER_VERSIONS.build!,
    )
  })
})
