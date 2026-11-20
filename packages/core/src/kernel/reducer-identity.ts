import { REDUCER_REVISIONS } from './reducer-revisions'

/**
 * Reducer identity. A reducer's published version is derived, never edited:
 *
 *   version = (LEGACY_REDUCER_VERSIONS[identity] ?? 1)
 *           + (ledger revisions naming identity)
 *           + Σ version(part) for its declared parts
 *
 * The ledger (`reducer-revisions.ts`) only grows and merges by union, so two
 * independent revisions of one reducer combine without a textual conflict and
 * the combined version exceeds either branch's. Versions stay small, monotone
 * integers on main, which the store's "no lower-version write replaces a
 * higher-version row" rule and released catalogs depend on.
 *
 * This module also holds the pure rules of the identity records that prove a
 * revision accompanies every accumulator change; the registry integration test
 * supplies the corpora, the digests and the files. Records alone cannot see a
 * fold-only change made after two branches' revisions combine and before the
 * combined record is regenerated; the base-relative clause closes that state
 * by comparing against the verify base (`AB_VERIFY_BASE`) when one is given.
 * It must stay free of IO and `node:` imports because the dashboard client
 * bundle reads it.
 */

/** Each identity's version before revisions were derived: the reducer's own
 * literal, or the literal a composite added to its parts. Frozen: never edit
 * it, and give a new reducer no entry (its base is 1). */
export const LEGACY_REDUCER_VERSIONS: Readonly<Record<string, number>> = Object.freeze({
  autoMergeDefault: 1,
  baseBranch: 2,
  build: 51,
  buildDelegation: 2,
  buildDigest: 17,
  buildReadFacts: 10,
  buildStreamSeed: 4,
  currentDeferralObservation: 1,
  currentPrAttachments: 1,
  dashboardFacts: 4,
  dispatchFailureBudget: 1,
  dispatchFrontend: 5,
  dispatchPlacement: 1,
  dispatchSettings: 1,
  dispatchStatus: 5,
  dispatchUpgrade: 7,
  dispatcherRunFacts: 3,
  effectiveConfig: 1,
  executionNoProgress: 7,
  forgeCredentialLimits: 1,
  forgeHealth: 1,
  frozenPrImageHost: 1,
  harvest: 4,
  harvestDelegation: 2,
  hostedHarvestAuthority: 1,
  hostedPrAttachments: 1,
  infrastructureFailureReset: 1,
  journalView: 9,
  kernelGitHealth: 1,
  lastExecutionOutcome: 2,
  leafRestack: 10,
  logIndex: 13,
  nodeRestack: 10,
  openBuildWorkspace: 2,
  openExecution: 1,
  openHarvestExecutions: 1,
  openTick: 1,
  openWorkspace: 1,
  optimization: 6,
  optimizationLedger: 2,
  pendingPrAttachmentReclaims: 1,
  phaseFailures: 3,
  pinnedAssets: 2,
  provisionMarker: 2,
  publicationState: 8,
  publishedBranchHead: 5,
  recordedBaseSha: 1,
  recoveryCheckpoint: 4,
  repositoryAttention: 2,
  repositoryReadFacts: 6,
  repositoryStateEvents: 8,
  sandboxStates: 1,
  session: 1,
  setupStreak: 1,
  summaryBoundary: 1,
  summaryRequests: 1,
  terminalGuard: 6,
  ticketHandbacks: 1,
  ticketMigrations: 1,
  ticketPreparation: 3,
  ticketSourceHealth: 2,
  verifyDiffBase: 3,
})

/** `<identity>/<shape|fold>/<10 random base36 characters>`. The random id keeps
 * two branches from ever appending an identical line, which a union merge
 * would collapse into one. */
export const REVISION_KEY = /^([A-Za-z][A-Za-z0-9]*)\/(shape|fold)\/([0-9a-z]{10})$/
/** The ledger's first entry: keeps the object literal expanded, not a revision. */
export const LEDGER_SENTINEL = '__ledger__'
export const REGENERATE_COMMAND =
  'AB_UPDATE_REDUCER_SHAPES=1 bun test packages/core/src/kernel/reducer-registry.integration.test.ts'
export const UNREGENERATED_COMBINATION_PREFIX = 'reducer identity: unregenerated combination'
export const BASE_RELATIVE_SKIPPED_PREFIX = 'reducer identity: base-relative clause skipped'

export type Ledger = Readonly<Record<string, string>>
export interface Revision {
  key: string
  identity: string
  kind: 'shape' | 'fold'
  id: string
  reason: string
}

const LEDGER_LINE = /^\s*'([^']*)':\s*'[^']*',?\s*$/

/** The revision keys of a ledger file's source text, as another commit holds
 * it. Throws on a malformed key: a hand edit. */
export function parseLedgerSource(source: string): Set<string> {
  const keys = new Set<string>()
  for (const line of source.split('\n')) {
    const match = LEDGER_LINE.exec(line)
    if (!match || match[1] === LEDGER_SENTINEL) continue
    if (!REVISION_KEY.test(match[1]!))
      throw new Error(`malformed reducer revision key ${JSON.stringify(match[1])}`)
    keys.add(match[1]!)
  }
  return keys
}

/** Every ledger revision. Throws on a malformed key: a hand edit. */
export function parseRevisions(ledger: Ledger): Revision[] {
  const revisions: Revision[] = []
  for (const [key, reason] of Object.entries(ledger)) {
    if (key === LEDGER_SENTINEL) continue
    const match = REVISION_KEY.exec(key)
    if (!match) throw new Error(`malformed reducer revision key ${JSON.stringify(key)}`)
    revisions.push({
      key,
      identity: match[1]!,
      kind: match[2] as Revision['kind'],
      id: match[3]!,
      reason,
    })
  }
  return revisions
}

const parsed = new WeakMap<Ledger, Map<string, string[]>>()
/** The ledger keys naming each identity, parsed once per ledger object. */
function revisionsByIdentity(ledger: Ledger): Map<string, string[]> {
  let byIdentity = parsed.get(ledger)
  if (byIdentity) return byIdentity
  byIdentity = new Map()
  for (const revision of parseRevisions(ledger)) {
    const keys = byIdentity.get(revision.identity) ?? []
    keys.push(revision.key)
    byIdentity.set(revision.identity, keys)
  }
  parsed.set(ledger, byIdentity)
  return byIdentity
}

/** Identities constructed in this process, filled as reducer modules load. */
export const IDENTIFIED = new Set<string>()
/** Each composite identity's declared part identities. */
export const PARTS = new Map<string, readonly string[]>()

export type IdentityGraph = ReadonlyMap<string, readonly string[]>

/** The pure version formula over a ledger. `parts` defaults to the identity's
 * declared parts in `graph`; parts derive recursively over the same ledger. */
export function deriveReducerVersion(input: {
  identity: string
  parts?: readonly string[]
  ledger?: Ledger
  graph?: IdentityGraph
}): number {
  const ledger = input.ledger ?? REDUCER_REVISIONS
  const graph = input.graph ?? PARTS
  const own =
    (LEGACY_REDUCER_VERSIONS[input.identity] ?? 1) +
    (revisionsByIdentity(ledger).get(input.identity)?.length ?? 0)
  return (input.parts ?? graph.get(input.identity) ?? []).reduce(
    (sum, part) => sum + deriveReducerVersion({ identity: part, ledger, graph }),
    own,
  )
}

/** The runtime form: records the identity and its parts, then derives. */
export function reducerVersion(
  identity: string,
  parts: readonly { readonly identity?: string }[] = [],
): number {
  const names = parts.map((part) => {
    if (part.identity === undefined)
      throw new Error(`reducer ${identity} declares a part without an identity`)
    return part.identity
  })
  const known = PARTS.get(identity) ?? []
  if (IDENTIFIED.has(identity) && known.join('\0') !== names.join('\0'))
    throw new Error(`reducer identity ${identity} is declared with different parts`)
  IDENTIFIED.add(identity)
  if (names.length) PARTS.set(identity, names)
  return deriveReducerVersion({ identity, parts: names })
}

/** The sorted ledger keys revising `identity` or, transitively, its parts. */
export function revisionSet(
  identity: string,
  ledger: Ledger = REDUCER_REVISIONS,
  graph: IdentityGraph = PARTS,
): string[] {
  const keys = new Set<string>()
  const visit = (name: string) => {
    for (const key of revisionsByIdentity(ledger).get(name) ?? []) keys.add(key)
    for (const part of graph.get(name) ?? []) visit(part)
  }
  visit(identity)
  return [...keys].sort()
}

/** JSON with object keys sorted at every depth. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  )
}

/** A hex digest of text; the caller supplies sha256 so this module needs no IO. */
export type Hash = (text: string) => string

/** The record key of one identity at one revision set. Corpora never enter it. */
export function recordKey(identity: string, revisions: readonly string[], hash: Hash): string {
  return hash(canonicalJson({ identity, revisions: [...revisions].sort() })).slice(0, 16)
}

/** One reducer's entries at one identity, as read from a record file. A
 * file holds the entries one regeneration added for any number of reducers. */
export interface IdentityRecord {
  name: string
  key: string
  /** The record file that holds it. */
  file: string
  identity: string
  revisions: readonly string[]
  /** Corpus id → accumulator digest. */
  entries: Readonly<Record<string, string>>
}

/** One registered reducer as it folds today. `digests` covers every corpus it
 * could fold: the current corpora and every archived one its records name. */
export interface CurrentIdentity {
  name: string
  identity: string
  /** Transitive part identities, named in messages. */
  parts?: readonly string[]
  revisions: readonly string[]
  digests: Readonly<Record<string, string>>
}

export type IdentityViolationKind =
  | 'changed'
  | 'changed-since-base'
  | 'disagreeing-records'
  | 'missing-archive'
  | 'unrecorded-corpus'
  | 'missing-record'

export interface IdentityViolation {
  name: string
  kind: IdentityViolationKind
  message: string
}

export interface UnregeneratedCombination {
  name: string
  identity: string
  revisions: readonly string[]
  /** Keys of the records whose revision sets union to `revisions`. */
  coveredBy: readonly string[]
}

type RecordBody = Pick<IdentityRecord, 'name' | 'identity' | 'revisions' | 'entries'>
const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** A record file's bytes and its content-addressed name. Files are only ever
 * added, never rewritten or deleted: two branches that each delete a file and
 * add a similar one would meet as a rename/rename conflict. */
export function renderRecordFile(
  records: readonly RecordBody[],
  hash: Hash,
): { file: string; content: string } {
  const body = {
    records: [...records]
      .sort((a, b) => byString(a.name, b.name) || byString(a.identity, b.identity))
      .map((record) => ({
        name: record.name,
        identity: record.identity,
        revisions: [...record.revisions].sort(),
        entries: Object.fromEntries(
          Object.entries(record.entries).sort(([a], [b]) => byString(a, b)),
        ),
      })),
  }
  const content = `${JSON.stringify(body, null, 2)}\n`
  return { file: `${hash(content).slice(0, 16)}.json`, content }
}

const RECORD_FILE = /^[0-9a-f]{16}\.json$/
const NAME = /^[A-Za-z][A-Za-z0-9]*$/

/** Parse one record file, proving its name addresses its content. */
export function parseRecordFile(file: string, content: string, hash: Hash): IdentityRecord[] {
  if (!RECORD_FILE.test(file)) throw new Error(`identity record ${file} is not named <hash>.json`)
  const body = JSON.parse(content) as { records?: unknown }
  const records = Array.isArray(body.records) ? (body.records as Partial<RecordBody>[]) : null
  if (
    !records?.every(
      (record) =>
        typeof record.name === 'string' &&
        NAME.test(record.name) &&
        typeof record.identity === 'string' &&
        Array.isArray(record.revisions) &&
        record.revisions.every((item) => typeof item === 'string') &&
        record.entries !== null &&
        typeof record.entries === 'object' &&
        Object.values(record.entries).every((item) => typeof item === 'string'),
    )
  )
    throw new Error(`identity record ${file} is malformed`)
  const parsed = (records as RecordBody[]).map((record) => ({
    ...record,
    key: recordKey(record.identity, record.revisions, hash),
    file,
  }))
  if (renderRecordFile(parsed, hash).file !== file)
    throw new Error(
      `identity record ${file} does not match its content; never edit a record by hand, regenerate with ${REGENERATE_COMMAND}`,
    )
  return parsed
}

/** The corpus ids the caller must fold for `name` at `key`: every corpus its
 * records at that key cover, archived ones included, plus the current ones. */
export function evaluationCorpora(input: {
  name: string
  key: string
  records: readonly IdentityRecord[]
  currentCids: readonly string[]
}): string[] {
  const cids = new Set(input.currentCids)
  for (const record of input.records)
    if (record.name === input.name && record.key === input.key)
      for (const cid of Object.keys(record.entries)) cids.add(cid)
  return [...cids].sort()
}

function mergeEntries(records: readonly IdentityRecord[]): {
  entries: Record<string, string>
  conflicts: string[]
} {
  const entries: Record<string, string> = {}
  const conflicts = new Set<string>()
  for (const record of records)
    for (const [cid, digest] of Object.entries(record.entries)) {
      if (entries[cid] !== undefined && entries[cid] !== digest) conflicts.add(cid)
      entries[cid] ??= digest
    }
  return { entries, conflicts: [...conflicts].sort() }
}

function reviseHint(current: CurrentIdentity): string {
  const parts = current.parts?.length
    ? ` (or the changed part among ${current.parts.join(', ')})`
    : ''
  return `add a revision with bun tools/reducer-revision.ts <shape|fold> ${current.identity}${parts} --reason "…", then regenerate with ${REGENERATE_COMMAND}`
}

/** Prove every registered reducer's accumulator still matches the records for
 * its identity. With no record for the current identity, a set of records whose
 * revision sets union to it is the accepted unregenerated combination: reported,
 * never silent. */
export function checkIdentityRecords(input: {
  current: readonly CurrentIdentity[]
  currentCids: readonly string[]
  records: readonly IdentityRecord[]
  hash: Hash
}): { violations: IdentityViolation[]; unregeneratedCombinations: UnregeneratedCombination[] } {
  const violations: IdentityViolation[] = []
  const unregeneratedCombinations: UnregeneratedCombination[] = []
  for (const current of input.current) {
    const { name, identity } = current
    const key = recordKey(identity, current.revisions, input.hash)
    const mine = input.records.filter((record) => record.name === name)
    const own = mine.filter((record) => record.key === key)
    if (own.length) {
      const { entries, conflicts } = mergeEntries(own)
      for (const cid of conflicts)
        violations.push({
          name,
          kind: 'disagreeing-records',
          message: `${name}: two identity records for ${identity} at ${key} disagree on corpus ${cid}`,
        })
      for (const [cid, digest] of Object.entries(entries)) {
        const actual = current.digests[cid]
        if (actual === undefined)
          violations.push({
            name,
            kind: 'missing-archive',
            message: `${name}: archived corpus ${cid} recorded for ${identity} is missing; restore reducer-identity-corpora/${cid}.json.gz from git history`,
          })
        else if (actual !== digest && !conflicts.includes(cid))
          violations.push({
            name,
            kind: 'changed',
            message: `${name}: identity ${identity} folds corpus ${cid} to a different accumulator than its record, so its shape or fold changed without a revision; ${reviseHint(current)}`,
          })
      }
      for (const cid of input.currentCids)
        if (entries[cid] === undefined)
          violations.push({
            name,
            kind: 'unrecorded-corpus',
            message: `${name}: corpus ${cid} not recorded; regenerate with ${REGENERATE_COMMAND}`,
          })
      continue
    }
    const revisions = new Set(current.revisions)
    const covering = mine.filter(
      (record) =>
        record.identity === identity && record.revisions.every((item) => revisions.has(item)),
    )
    const covered = new Set(covering.flatMap((record) => record.revisions))
    if (covering.length && covered.size === revisions.size)
      unregeneratedCombinations.push({
        name,
        identity,
        revisions: [...current.revisions].sort(),
        coveredBy: [...new Set(covering.map((record) => record.key))].sort(),
      })
    else
      violations.push({
        name,
        kind: 'missing-record',
        message: `${name}: identity record missing for ${identity} at revisions [${[...current.revisions].sort().join(', ')}]; regenerate with ${REGENERATE_COMMAND}`,
      })
  }
  return { violations, unregeneratedCombinations }
}

/** The record file that brings the records up to date: for each reducer, the
 * entries of current corpora its identity has not recorded, or every current
 * corpus at an identity with no record. Refuses, writing nothing, when any
 * recorded corpus folds differently under an unchanged identity: that change
 * needs a revision, not a record. Records are only ever added; records of
 * superseded identities and removed reducers stay inert. */
export function planRegeneration(input: {
  current: readonly CurrentIdentity[]
  currentCids: readonly string[]
  records: readonly IdentityRecord[]
  /** Corpus ids already in the archive. */
  archived: ReadonlySet<string>
  hash: Hash
}): { refused: string[]; write?: { file: string; content: string }; archive: string[] } {
  const { violations } = checkIdentityRecords(input)
  const refused = violations
    .filter((violation) =>
      ['changed', 'disagreeing-records', 'missing-archive'].includes(violation.kind),
    )
    .map((violation) => violation.message)
  if (refused.length) return { refused, archive: [] }
  const added: RecordBody[] = []
  for (const current of input.current) {
    const key = recordKey(current.identity, current.revisions, input.hash)
    const recorded = mergeEntries(
      input.records.filter((record) => record.name === current.name && record.key === key),
    ).entries
    const entries: Record<string, string> = {}
    for (const cid of input.currentCids) {
      if (recorded[cid] !== undefined) continue
      const digest = current.digests[cid]
      if (digest === undefined) throw new Error(`${current.name}: corpus ${cid} was not folded`)
      entries[cid] = digest
    }
    if (Object.keys(entries).length) added.push({ ...current, entries })
  }
  return {
    refused,
    ...(added.length ? { write: renderRecordFile(added, input.hash) } : {}),
    archive: input.currentCids.filter((cid) => !input.archived.has(cid)),
  }
}

/** The notice the registry test prints for the accepted AC3 state. */
export function formatUnregeneratedCombination(entry: UnregeneratedCombination): string {
  return `${UNREGENERATED_COMBINATION_PREFIX}: ${entry.name} (${entry.identity}) at revisions [${entry.revisions.join(', ')}] is covered only by the records ${entry.coveredBy.join(', ')} of its combined revisions. A fold-only change without a revision is caught only against the verify base (AB_VERIFY_BASE), and otherwise not until the combined record is regenerated with ${REGENERATE_COMMAND}.`
}

/** The notice the registry test prints when it cannot compare against a base. */
export function formatBaseRelativeSkipped(reason: string): string {
  return `${BASE_RELATIVE_SKIPPED_PREFIX}: ${reason}. Changes since the verify base are checked only against the identity records.`
}

/** The entries whose every revision already exists in the base's ledger: the
 * change adds no revision for them, so their digests must equal the base's. */
export function unrevisedSinceBase(
  current: readonly CurrentIdentity[],
  baseLedger: ReadonlySet<string>,
): CurrentIdentity[] {
  return current.filter((entry) => entry.revisions.every((key) => baseLedger.has(key)))
}

/** Every corpus the head folds differently from the base for a reducer that
 * adds no revision relative to it. `baseDigests` holds, per reducer name, the
 * base's digests; only corpus ids both sides hold are compared, and a reducer
 * absent from it is new at the head. */
export function checkAgainstBase(input: {
  current: readonly CurrentIdentity[]
  base: string
  baseDigests: ReadonlyMap<string, Readonly<Record<string, string>>>
}): IdentityViolation[] {
  const violations: IdentityViolation[] = []
  for (const current of input.current) {
    const base = input.baseDigests.get(current.name)
    if (base === undefined) continue
    for (const cid of Object.keys(current.digests).sort()) {
      const digest = base[cid]
      if (digest === undefined || digest === current.digests[cid]) continue
      violations.push({
        name: current.name,
        kind: 'changed-since-base',
        message: `${current.name}: identity ${current.identity} folds corpus ${cid} differently from the verify base ${input.base.slice(0, 12)} but adds no revision relative to it; ${reviseHint(current)}`,
      })
    }
  }
  return violations
}

/** A reducer as the identity digest folds it; structural, so a reducer
 * imported from another commit's code folds through the same function.
 * Method syntax keeps the parameters bivariant for any accumulator type. */
export interface DigestReducer {
  initial(): unknown
  advance(acc: unknown, events: readonly unknown[]): unknown
}
/** The chunk size every identity digest folds a corpus in. */
export const DIGEST_CHUNK = 12

/** Fold one corpus in DIGEST_CHUNK-sized chunks, stopping at the first chunk
 * that throws (a corpus for another domain), and digest the accumulator
 * reached. `visit` sees the accumulator after every chunk. */
export function foldDigest(
  reducer: DigestReducer,
  log: readonly unknown[],
  hash: Hash,
  visit: (acc: unknown) => void = () => {},
): string {
  let acc = reducer.initial()
  let threwAtChunk: number | null = null
  for (let i = 0; i < log.length; i += DIGEST_CHUNK) {
    try {
      acc = reducer.advance(acc, log.slice(i, i + DIGEST_CHUNK))
    } catch {
      threwAtChunk = i / DIGEST_CHUNK
      break
    }
    visit(acc)
  }
  return hash(canonicalJson({ acc, threwAtChunk })).slice(0, 32)
}

/** Biome's line width; a ledger line must never wrap. */
const LEDGER_LINE_WIDTH = 100

/** Insert one revision line before the ledger's closing brace. Throws on an
 * invalid identity, kind or id, or a reason that is not one short line without
 * quotes or backslashes. */
export function appendRevision(
  source: string,
  revision: { identity: string; kind: 'shape' | 'fold'; reason: string; id: string },
): string {
  const key = `${revision.identity}/${revision.kind}/${revision.id}`
  if (!REVISION_KEY.test(key)) throw new Error(`invalid reducer revision key ${key}`)
  const reason = revision.reason.trim()
  if (!reason || /['"`\\\r\n]/.test(reason))
    throw new Error('the reason must be one nonblank line without quotes or backslashes')
  const line = `  '${key}': '${reason}',`
  if (line.length > LEDGER_LINE_WIDTH)
    throw new Error(
      `the reason is too long: shorten it by ${line.length - LEDGER_LINE_WIDTH} characters`,
    )
  const close = source.lastIndexOf('\n}')
  if (close < 0 || !source.includes(`${LEDGER_SENTINEL}:`))
    throw new Error('not a reducer revision ledger')
  return `${source.slice(0, close)}\n${line}${source.slice(close)}`
}
