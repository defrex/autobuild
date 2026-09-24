/**
 * Lockstep pin between the drizzle schema (`schema.ts`, the source of truth)
 * and the inline bootstrap DDL (`store.ts`): the declared tables and the
 * DDL-created tables must agree on columns (presence, order, type, nullability,
 * primary-key shape) and indexes (name, columns, uniqueness, partiality), so
 * neither representation can silently drift from the other.
 *
 * The comparison helpers are parameterized on `(table, db)` rather than closing
 * over the real tree: the same code path that checks `schema.ts` against
 * `BOOTSTRAP_DDL` also checks deliberately divergent synthetic fixtures, which
 * is how the negative tests below prove the checks actually bite.
 */
import { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import { describe, expect, test } from 'bun:test'
import {
  getTableConfig,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
  type IndexColumn,
  type SQLiteTable,
} from 'drizzle-orm/sqlite-core'
import {
  artifacts,
  builds,
  events,
  repoArtifacts,
  repoEvents,
  repoStreams,
  sessionArtifacts,
  sessionEvents,
  sessions,
  streamChunks,
  streams,
} from './schema'
import { BOOTSTRAP_DDL } from './store'

const tables: Record<string, SQLiteTable> = {
  builds,
  events,
  artifacts,
  repo_streams: repoStreams,
  repo_events: repoEvents,
  repo_artifacts: repoArtifacts,
  sessions,
  session_events: sessionEvents,
  session_artifacts: sessionArtifacts,
  streams,
  stream_chunks: streamChunks,
}

interface DeclaredColumn {
  name: string
  /** `getSQLType()` uppercased — compared case-insensitively against the DDL. */
  type: string
  notNull: boolean
  /** Column-level `primaryKey()` or a composite `primaryKey()` member. */
  pk: boolean
}

interface DdlColumn {
  name: string
  type: string
  notnull: number
  /** 1-based position in the table's primary key, 0 when not part of it. */
  pk: number
}

interface IndexSpec {
  name: string
  /** Column names in index order, comma-joined. */
  columns: string
  unique: boolean
  partial: boolean
}

// ---------------------------------------------------------------- descriptors

/** Columns as the drizzle schema declares them, in declaration order. */
function declaredColumns(table: SQLiteTable): DeclaredColumn[] {
  const config = getTableConfig(table)
  const composite = new Set(config.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)))
  return config.columns.map((c) => ({
    name: c.name,
    type: c.getSQLType().toUpperCase(),
    notNull: c.notNull,
    pk: c.primary === true || composite.has(c.name),
  }))
}

/** The declared primary-key column sequence: the composite `primaryKey()`
 * config order when one exists, else the column-level `primaryKey()` columns
 * in declaration order. */
function declaredPrimaryKeySequence(table: SQLiteTable, declared: DeclaredColumn[]): string[] {
  const composite = getTableConfig(table).primaryKeys
  if (composite.length > 0) return composite.flatMap((pk) => pk.columns.map((c) => c.name))
  return declared.filter((c) => c.pk).map((c) => c.name)
}

/** Columns as `PRAGMA table_info` reports them for the applied DDL, in DDL
 * order. */
function ddlColumns(db: Database, tableName: string): DdlColumn[] {
  return db.query(`PRAGMA table_info('${tableName}')`).all() as DdlColumn[]
}

/** Index columns are plain column references in this schema; a SQL expression
 * would need different handling on the DDL side, so fail loudly instead of
 * comparing an empty name. */
function columnName(c: IndexColumn): string {
  if (!('name' in c)) throw new Error('index over a SQL expression is not parity-checked')
  return c.name
}

/** Indexes as the drizzle schema declares them. */
function declaredIndexes(table: SQLiteTable): IndexSpec[] {
  return getTableConfig(table).indexes.map((ix) => ({
    name: ix.config.name,
    columns: ix.config.columns.map(columnName).join(','),
    unique: ix.config.unique,
    partial: ix.config.where !== undefined,
  }))
}

/** Indexes as the applied DDL creates them. PK-backed autoindexes
 * (`origin = 'pk'`) are skipped — they restate the primary key, which the
 * column parity check already pins. UNIQUE-constraint autoindexes
 * (`origin = 'u'`) are excluded too — see the autoindex rationale below. */
function ddlIndexes(db: Database, tableName: string): IndexSpec[] {
  const indexList = db.query(`PRAGMA index_list('${tableName}')`).all() as Array<{
    name: string
    unique: number
    origin: string
    partial: number
  }>
  const out: IndexSpec[] = []
  for (const { name, unique, origin, partial } of indexList) {
    if (origin === 'pk' || origin === 'u') continue
    out.push({
      name,
      columns: (
        db.query(`PRAGMA index_info('${name}')`).all() as Array<{ name: string; seqno: number }>
      )
        .sort((a, b) => a.seqno - b.seqno)
        .map((c) => c.name)
        .join(','),
      unique: unique === 1,
      partial: partial === 1,
    })
  }
  return out
}

// ------------------------------------------------------------------ comparison

/**
 * SQLite quirk the not-null rule waives: in a rowid table, a column-level
 * `PRIMARY KEY` reports `notnull = 0` even though the primary key of course
 * forbids NULL and drizzle declares such columns `notNull`. Composite
 * table-level PK columns report `notnull = 1` as usual. A declared PK column
 * with `ddl.notnull = 0` is therefore not a divergence — and the PK-sequence
 * check below pins that the waived column really is the PK.
 *
 * Deliberately not compared: `dflt_value`/defaults (neither side declares
 * any), CHECK constraints, and FK shape — the DDL carries behavior drizzle
 * expresses elsewhere or not at all.
 */
function columnMismatches(declared: DeclaredColumn[], ddl: DdlColumn[]): string[] {
  const mismatches: string[] = []
  const ddlByName = new Map(ddl.map((c) => [c.name, c]))

  const declaredNames = declared.map((c) => c.name)
  const ddlNames = ddl.map((c) => c.name)
  if (declaredNames.join(',') !== ddlNames.join(',')) {
    mismatches.push(`column presence/order: declared [${declaredNames}] vs ddl [${ddlNames}]`)
  }

  for (const c of declared) {
    const d = ddlByName.get(c.name)
    if (!d) continue
    if (c.type !== d.type.toUpperCase()) {
      mismatches.push(`column ${c.name}: declared type ${c.type} vs ddl type ${d.type}`)
    }
    if (d.notnull === 1 && !c.notNull) {
      mismatches.push(`column ${c.name}: ddl NOT NULL but declared nullable`)
    }
    if (d.notnull === 0 && c.notNull && !c.pk) {
      mismatches.push(`column ${c.name}: declared NOT NULL but ddl nullable (and not a PK)`)
    }
  }

  return mismatches
}

/** PK-sequence comparison, kept separate so it can take the table object. */
function primaryKeyMismatches(table: SQLiteTable, ddl: DdlColumn[]): string[] {
  const declaredSeq = declaredPrimaryKeySequence(table, declaredColumns(table))
  const ddlSeq = ddl
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name)
  if (declaredSeq.join(',') !== ddlSeq.join(',')) {
    return [`primary key: declared [${declaredSeq}] vs ddl [${ddlSeq}]`]
  }
  return []
}

/** Indexes compared as keyed records keyed by `table/name`; every attribute
 * (columns, unique, partial) must agree. */
function indexMismatches(declared: IndexSpec[], ddl: IndexSpec[]): string[] {
  const mismatches: string[] = []
  const declaredByKey = new Map(declared.map((ix) => [ix.name, ix]))
  const ddlByKey = new Map(ddl.map((ix) => [ix.name, ix]))
  for (const [name, ix] of declaredByKey) {
    const d = ddlByKey.get(name)
    if (!d) {
      mismatches.push(`index ${name}: declared but absent from the ddl`)
      continue
    }
    if (ix.columns !== d.columns) {
      mismatches.push(`index ${name}: declared columns [${ix.columns}] vs ddl [${d.columns}]`)
    }
    if (ix.unique !== d.unique) {
      mismatches.push(`index ${name}: declared unique=${ix.unique} vs ddl unique=${d.unique}`)
    }
    if (ix.partial !== d.partial) {
      mismatches.push(`index ${name}: declared partial=${ix.partial} vs ddl partial=${d.partial}`)
    }
  }
  for (const name of ddlByKey.keys()) {
    if (!declaredByKey.has(name)) mismatches.push(`index ${name}: in the ddl but not declared`)
  }
  return mismatches
}

// ------------------------------------------------------------------- fixtures

/** A `:memory:` database with the given statements applied. */
function memoryDb(ddl: readonly string[]): Database {
  const db = new Database(':memory:')
  for (const statement of ddl) db.exec(statement)
  return db
}

// The real-tree parity assertions below run against `tables` + `BOOTSTRAP_DDL`.
// The fixture tests further down rebuild the same comparison over synthetic
// drizzle tables + synthetic DDL to prove each check fails on a deliberately
// introduced divergence.

describe('schema/DDL parity (real tree)', () => {
  // Guard so a new table can't silently fall out of both parity checks: every
  // table the DDL creates must be present in the test's table map.
  test('every table the DDL creates is covered by the parity check', () => {
    const db = memoryDb(BOOTSTRAP_DDL)
    try {
      const ddlTables = (
        db
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all() as Array<{
          name: string
        }>
      ).map((t) => t.name)
      expect([...ddlTables].sort()).toEqual(Object.keys(tables).sort())
    } finally {
      db.close()
    }
  })

  test('declared columns match the bootstrap DDL exactly', () => {
    const db = memoryDb(BOOTSTRAP_DDL)
    try {
      for (const [tableName, table] of Object.entries(tables)) {
        const declared = declaredColumns(table)
        const ddl = ddlColumns(db, tableName)
        expect(columnMismatches(declared, ddl).map((m) => `${tableName}: ${m}`)).toEqual([])
        expect(primaryKeyMismatches(table, ddl).map((m) => `${tableName}: ${m}`)).toEqual([])
      }
    } finally {
      db.close()
    }
  })

  test('declared indexes match the bootstrap DDL exactly (columns, unique, partial)', () => {
    const db = memoryDb(BOOTSTRAP_DDL)
    try {
      for (const [tableName, table] of Object.entries(tables)) {
        expect(
          indexMismatches(declaredIndexes(table), ddlIndexes(db, tableName)).map(
            (m) => `${tableName}: ${m}`,
          ),
        ).toEqual([])
      }
    } finally {
      db.close()
    }
  })

  test('the digest-scan index exists on both sides with matching attributes', () => {
    const db = memoryDb(BOOTSTRAP_DDL)
    try {
      const declared = declaredIndexes(events).find((ix) => ix.name === 'events_type_build_seq')
      expect(declared).toEqual({
        name: 'events_type_build_seq',
        columns: 'type,build,seq',
        unique: false,
        partial: false,
      })
      const ddl = ddlIndexes(db, 'events').find((ix) => ix.name === 'events_type_build_seq')
      expect(ddl).toEqual(declared)
    } finally {
      db.close()
    }
  })

  // Autoindex tripwires. `origin = 'u'` autoindexes (`sqlite_autoindex_*`)
  // come from UNIQUE constraints in the DDL, and drizzle table-level
  // `unique()` constraints produce `uniqueConstraints` entries — neither is
  // part of the compared surface above (see `ddlIndexes`). Both are excluded
  // deliberately: autoindex names/order (`sqlite_autoindex_<table>_<N>`) are
  // a SQLite implementation detail and drizzle table-level unique constraints
  // are unnamed in DDL, so any positional mapping would be brittle. Instead
  // of silently ignoring them — which would let a future UNIQUE constraint
  // drift un-pinned — these tripwires turn their appearance into a loud,
  // explained failure that forces the decision to extend the parity surface
  // or re-pin.
  test('no UNIQUE-constraint autoindex exists in the bootstrap DDL (tripwire)', () => {
    const db = memoryDb(BOOTSTRAP_DDL)
    try {
      const offenders: string[] = []
      for (const tableName of Object.keys(tables)) {
        const indexList = db.query(`PRAGMA index_list('${tableName}')`).all() as Array<{
          name: string
          origin: string
        }>
        for (const { name, origin } of indexList) {
          if (origin === 'u') offenders.push(`${tableName}/${name}`)
        }
      }
      expect(
        offenders.length === 0
          ? []
          : [
              `UNIQUE-constraint autoindex(es) ${offenders} found in the DDL — extend the parity surface or re-pin the autoindex exclusion (see the tripwire comment)`,
            ],
      ).toEqual([])
    } finally {
      db.close()
    }
  })

  test('no drizzle table-level unique() constraint is declared (tripwire)', () => {
    const offenders: string[] = []
    for (const [tableName, table] of Object.entries(tables)) {
      const constraints = getTableConfig(table).uniqueConstraints
      if (constraints.length > 0) offenders.push(tableName)
    }
    expect(
      offenders.length === 0
        ? []
        : [
            `table(s) ${offenders} declare drizzle unique() constraints — extend the parity surface or re-pin the autoindex exclusion (see the tripwire comment)`,
          ],
    ).toEqual([])
  })
})

// ------------------------------------------------------- negative fixtures
// Each fixture deliberately diverges in exactly one attribute and must be
// flagged by the same helpers that check the real tree. Unique-divergence
// fixtures use `CREATE UNIQUE INDEX` (origin `c`), never a UNIQUE *constraint*,
// so they stay inside the compared surface.

const fixtureTables = {
  mutatedType: {
    table: sqliteTable('fx_type', { a: text('a'), b: integer('b') }),
    ddl: 'CREATE TABLE fx_type (a TEXT, b TEXT)',
  },
  wellFormed: {
    table: sqliteTable('fx_ok', { a: text('a').notNull(), b: integer('b') }),
    ddl: 'CREATE TABLE fx_ok (a TEXT NOT NULL, b INTEGER)',
  },
  missingColumn: {
    table: sqliteTable('fx_missing', { a: text('a'), b: integer('b') }),
    ddl: 'CREATE TABLE fx_missing (a TEXT)',
  },
  notNullDivergence: {
    table: sqliteTable('fx_notnull', { a: text('a') }),
    ddl: 'CREATE TABLE fx_notnull (a TEXT NOT NULL)',
  },
  pkOrder: {
    table: sqliteTable('fx_pk', { a: text('a').notNull(), b: text('b').notNull() }, (t) => [
      primaryKey({ columns: [t.a, t.b] }),
    ]),
    ddl: 'CREATE TABLE fx_pk (a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (b, a))',
  },
  pkQuirk: {
    // Column-level PK: drizzle says notNull, SQLite reports notnull=0 — the
    // quirk the waiver exists for; must NOT be flagged.
    table: sqliteTable('fx_pkq', { id: text('id').primaryKey(), a: text('a') }),
    ddl: 'CREATE TABLE fx_pkq (id TEXT PRIMARY KEY, a TEXT)',
  },
  declaredUnique: {
    table: sqliteTable('fx_uniq', { a: text('a'), b: text('b') }, (t) => [
      uniqueIndex('fx_uniq_ix').on(t.a, t.b),
    ]),
    ddl: 'CREATE TABLE fx_uniq (a TEXT, b TEXT); CREATE INDEX fx_uniq_ix ON fx_uniq (a, b)',
  },
  ddlUnique: {
    table: sqliteTable('fx_uniq2', { a: text('a'), b: text('b') }, (t) => [
      index('fx_uniq2_ix').on(t.a, t.b),
    ]),
    ddl: 'CREATE TABLE fx_uniq2 (a TEXT, b TEXT); CREATE UNIQUE INDEX fx_uniq2_ix ON fx_uniq2 (a, b)',
  },
  declaredPartial: {
    table: sqliteTable('fx_partial', { a: text('a'), b: integer('b') }, (t) => [
      index('fx_partial_ix').on(t.a).where(sql`${t.b} > 0`),
    ]),
    ddl: 'CREATE TABLE fx_partial (a TEXT, b INTEGER); CREATE INDEX fx_partial_ix ON fx_partial (a)',
  },
  ddlPartial: {
    table: sqliteTable('fx_partial2', { a: text('a'), b: integer('b') }, (t) => [
      index('fx_partial2_ix').on(t.a),
    ]),
    ddl: 'CREATE TABLE fx_partial2 (a TEXT, b INTEGER); CREATE INDEX fx_partial2_ix ON fx_partial2 (a) WHERE b > 0',
  },
  uniqueConstraintDdl: {
    // A UNIQUE *constraint* in the DDL — outside the compared surface; the
    // tripwire detector must fire instead of the parity checks.
    table: sqliteTable('fx_ucon', { a: text('a') }),
    ddl: 'CREATE TABLE fx_ucon (a TEXT UNIQUE)',
  },
  uniqueConstraintDeclared: {
    // A drizzle table-level unique() — the declared-side twin of the tripwire.
    table: sqliteTable('fx_ucon2', { a: text('a') }, (t) => [unique().on(t.a)]),
    ddl: 'CREATE TABLE fx_ucon2 (a TEXT)',
  },
} satisfies Record<string, { table: SQLiteTable; ddl: string }>

describe('schema/DDL parity (divergence fixtures)', () => {
  test('sanity: a well-formed fixture raises no mismatch', () => {
    const f = fixtureTables.wellFormed
    const db = memoryDb([f.ddl])
    try {
      expect(columnMismatches(declaredColumns(f.table), ddlColumns(db, 'fx_ok'))).toEqual([])
      expect(primaryKeyMismatches(f.table, ddlColumns(db, 'fx_ok'))).toEqual([])
      expect(indexMismatches(declaredIndexes(f.table), ddlIndexes(db, 'fx_ok'))).toEqual([])
    } finally {
      db.close()
    }
  })

  test('a mutated column type is flagged', () => {
    const f = fixtureTables.mutatedType
    const db = memoryDb([f.ddl])
    try {
      expect(columnMismatches(declaredColumns(f.table), ddlColumns(db, 'fx_type'))).toEqual([
        'column b: declared type INTEGER vs ddl type TEXT',
      ])
    } finally {
      db.close()
    }
  })

  test('a column missing on one side is flagged', () => {
    const f = fixtureTables.missingColumn
    const db = memoryDb([f.ddl])
    try {
      const mismatches = columnMismatches(declaredColumns(f.table), ddlColumns(db, 'fx_missing'))
      expect(mismatches).toHaveLength(1)
      expect(mismatches[0]).toContain('column presence/order')
    } finally {
      db.close()
    }
  })

  test('a not-null divergence on a non-PK column is flagged', () => {
    const f = fixtureTables.notNullDivergence
    const db = memoryDb([f.ddl])
    try {
      expect(columnMismatches(declaredColumns(f.table), ddlColumns(db, 'fx_notnull'))).toEqual([
        'column a: ddl NOT NULL but declared nullable',
      ])
    } finally {
      db.close()
    }
  })

  test('a column-level PK with the SQLite notnull=0 quirk is NOT flagged (waiver pin)', () => {
    const f = fixtureTables.pkQuirk
    const db = memoryDb([f.ddl])
    try {
      expect(columnMismatches(declaredColumns(f.table), ddlColumns(db, 'fx_pkq'))).toEqual([])
      expect(primaryKeyMismatches(f.table, ddlColumns(db, 'fx_pkq'))).toEqual([])
    } finally {
      db.close()
    }
  })

  test('a primary-key order divergence is flagged', () => {
    const f = fixtureTables.pkOrder
    const db = memoryDb([f.ddl])
    try {
      expect(primaryKeyMismatches(f.table, ddlColumns(db, 'fx_pk'))).toEqual([
        'primary key: declared [a,b] vs ddl [b,a]',
      ])
    } finally {
      db.close()
    }
  })

  test('a declared uniqueIndex over a plain DDL index is flagged', () => {
    const f = fixtureTables.declaredUnique
    const db = memoryDb(f.ddl.split('; '))
    try {
      expect(indexMismatches(declaredIndexes(f.table), ddlIndexes(db, 'fx_uniq'))).toEqual([
        'index fx_uniq_ix: declared unique=true vs ddl unique=false',
      ])
    } finally {
      db.close()
    }
  })

  test('a plain declared index over a unique DDL index is flagged', () => {
    const f = fixtureTables.ddlUnique
    const db = memoryDb(f.ddl.split('; '))
    try {
      expect(indexMismatches(declaredIndexes(f.table), ddlIndexes(db, 'fx_uniq2'))).toEqual([
        'index fx_uniq2_ix: declared unique=false vs ddl unique=true',
      ])
    } finally {
      db.close()
    }
  })

  test('a declared partial index over a plain DDL index is flagged', () => {
    const f = fixtureTables.declaredPartial
    const db = memoryDb(f.ddl.split('; '))
    try {
      expect(indexMismatches(declaredIndexes(f.table), ddlIndexes(db, 'fx_partial'))).toEqual([
        'index fx_partial_ix: declared partial=true vs ddl partial=false',
      ])
    } finally {
      db.close()
    }
  })

  test('a plain declared index over a partial DDL index is flagged', () => {
    const f = fixtureTables.ddlPartial
    const db = memoryDb(f.ddl.split('; '))
    try {
      expect(indexMismatches(declaredIndexes(f.table), ddlIndexes(db, 'fx_partial2'))).toEqual([
        'index fx_partial2_ix: declared partial=false vs ddl partial=true',
      ])
    } finally {
      db.close()
    }
  })

  test('a UNIQUE column constraint trips the DDL-side autoindex tripwire, not the parity checks', () => {
    const f = fixtureTables.uniqueConstraintDdl
    const db = memoryDb([f.ddl])
    try {
      // No divergence in the compared surface itself.
      expect(columnMismatches(declaredColumns(f.table), ddlColumns(db, 'fx_ucon'))).toEqual([])
      expect(indexMismatches(declaredIndexes(f.table), ddlIndexes(db, 'fx_ucon'))).toEqual([])
      // The tripwire detector fires: the UNIQUE constraint creates an
      // origin='u' autoindex.
      const indexList = db.query("PRAGMA index_list('fx_ucon')").all() as Array<{ origin: string }>
      expect(indexList.some((ix) => ix.origin === 'u')).toBe(true)
    } finally {
      db.close()
    }
  })

  test('a drizzle table-level unique() constraint trips the declared-side tripwire, not the parity checks', () => {
    const f = fixtureTables.uniqueConstraintDeclared
    const db = memoryDb([f.ddl])
    try {
      expect(columnMismatches(declaredColumns(f.table), ddlColumns(db, 'fx_ucon2'))).toEqual([])
      expect(indexMismatches(declaredIndexes(f.table), ddlIndexes(db, 'fx_ucon2'))).toEqual([])
      expect(getTableConfig(f.table).uniqueConstraints.length > 0).toBe(true)
    } finally {
      db.close()
    }
  })
})
