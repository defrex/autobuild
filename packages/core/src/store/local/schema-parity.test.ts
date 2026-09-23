/**
 * Lockstep pin between the drizzle schema (`schema.ts`, the source of truth)
 * and the inline bootstrap DDL (`store.ts`): the declared indexes and the
 * DDL-created indexes must agree exactly — name, table, and column order —
 * so neither representation can silently drift from the other.
 */
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core'
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

/** (table, indexName, columnList) as the drizzle schema declares them. */
function declaredIndexes(): Set<string> {
  const out = new Set<string>()
  for (const [tableName, table] of Object.entries(tables)) {
    for (const ix of getTableConfig(table).indexes) {
      const columns = ix.config.columns.map((c) => c.name).join(',')
      out.add(`${tableName}/${ix.config.name}/${columns}`)
    }
  }
  return out
}

/** (table, indexName, columnList) as the applied BOOTSTRAP_DDL creates them,
 * excluding PK-backed autoindexes (`origin = 'pk'`). */
function ddlIndexes(): Set<string> {
  const db = new Database(':memory:')
  try {
    for (const ddl of BOOTSTRAP_DDL) db.exec(ddl)
    const out = new Set<string>()
    for (const [tableName, _table] of Object.entries(tables)) {
      const indexList = db.query(`PRAGMA index_list('${tableName}')`).all() as Array<{
        name: string
        origin: string
      }>
      for (const { name, origin } of indexList) {
        if (origin === 'pk') continue
        const columns = (
          db.query(`PRAGMA index_info('${name}')`).all() as Array<{ name: string; seqno: number }>
        )
          .sort((a, b) => a.seqno - b.seqno)
          .map((c) => c.name)
          .join(',')
        out.add(`${tableName}/${name}/${columns}`)
      }
    }
    return out
  } finally {
    db.close()
  }
}

describe('schema/DDL index parity', () => {
  test('declared indexes match the bootstrap DDL exactly', () => {
    const declared = declaredIndexes()
    const ddl = ddlIndexes()
    expect([...declared].sort()).toEqual([...ddl].sort())
  })

  test('the digest-scan index exists on both sides with matching columns', () => {
    expect(declaredIndexes().has('events/events_type_build_seq/type,build,seq')).toBe(true)
    expect(ddlIndexes().has('events/events_type_build_seq/type,build,seq')).toBe(true)
  })
})
