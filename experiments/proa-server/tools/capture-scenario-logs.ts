/** Bun preload: observe actual successful MemoryBuildStore persistence without changing it. */
import { REDUCERS } from '../../../packages/core/src/kernel/reducer-registry'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { reducers } from './fixture-core'
import { afterAll } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { MemoryBuildStore } from '../../../packages/core/src/store/memory'

export type CapturedStream = {
  id: string
  scope: 'build' | 'repository' | 'session'
  events: unknown[]
}
const stores = new Map<object, number>()
const streams = new Map<string, CapturedStream>()
function capture(store: object) {
  if (!stores.has(store)) stores.set(store, stores.size + 1)
  const identity = stores.get(store)
  const internals = store as Record<string, unknown>
  for (const [field, scope] of [
    ['builds', 'build'],
    ['repos', 'repository'],
    ['sessions', 'session'],
  ] as const) {
    const states = internals[field] as Map<string, { events: unknown[] }> | undefined
    for (const [name, state] of states ?? []) {
      const id = `${identity}/${scope}/${name}`
      streams.set(id, { id, scope, events: state.events })
    }
  }
}
export function installCollector() {
  const restore: (() => void)[] = []
  // Real launcher scenarios use SQLite stores. Observe final committed rows before
  // their normal close/cleanup; no writes, migrations or behavior substitutions.
  const close = Database.prototype.close
  restore.push(() => {
    Database.prototype.close = close
  })
  Database.prototype.close = function (...args) {
    try {
      const tables = new Set(
        (
          this.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {
            name: string
          }[]
        ).map((row) => row.name),
      )
      for (const [table, owner, scope] of [
        ['events', 'build', 'build'],
        ['repo_events', 'repo', 'repository'],
        ['session_events', 'session', 'session'],
      ] as const) {
        if (!tables.has(table)) continue
        const rows = this.query(`SELECT * FROM ${table} ORDER BY ${owner}, seq`).all() as Record<
          string,
          unknown
        >[]
        const grouped = new Map<string, unknown[]>()
        for (const row of rows) {
          const event: Record<string, unknown> = {
            ...row,
            actor: JSON.parse(row.actor as string),
            payload: JSON.parse(row.payload as string),
          }
          if (row.compatibility === null || row.compatibility === undefined)
            delete event.compatibility
          else event.compatibility = JSON.parse(row.compatibility as string)
          const key = String(row[owner])
          if (!grouped.has(key)) grouped.set(key, [])
          grouped.get(key)!.push(event)
        }
        for (const [key, events] of grouped) {
          const id = `sqlite/${this.filename}/${scope}/${key}`
          streams.set(id, { id, scope, events })
        }
      }
    } catch (error) {
      // An unrelated non-BuildStore database is not part of the corpus.
      if (String(error).includes('closed')) return close.apply(this, args)
      throw error
    }
    return close.apply(this, args)
  }

  const observed = new Set<object>()
  const reducerGroups = [
    ...Object.entries(reducers),
    ...Object.values(REDUCERS)
      .filter((entry) => 'scope' in entry.valueRead)
      .map(
        (entry) =>
          [
            (entry.valueRead as { scope: string }).scope === 'repo' ? 'repository' : 'build',
            { reducer: entry.reducer },
          ] as const,
      ),
  ]
  for (const [scope, entries] of reducerGroups) {
    for (const reducer of Object.values(entries)) {
      if (observed.has(reducer)) continue
      observed.add(reducer)
      const original = reducer.reduce
      restore.push(() => {
        reducer.reduce = original
      })
      reducer.reduce = function (events: never) {
        const result = original.call(this, events)
        // Registry reducers can also accept digest fragments, which are not
        // event-log envelopes. Only their complete stored-log inputs are corpus logs.
        const owner = scope === 'repository' ? 'repo' : scope
        if (
          !(events as unknown[]).every(
            (event) =>
              event !== null &&
              typeof event === 'object' &&
              owner in event &&
              'actor' in event &&
              'ts' in event &&
              'payload' in event,
          )
        )
          return result
        const id = `reducer/${scope}/${createHash('sha256').update(JSON.stringify(events)).digest('hex')}`
        streams.set(id, {
          id,
          scope: scope as CapturedStream['scope'],
          events: structuredClone(events),
        })
        return result
      }
    }
  }

  const prototype = MemoryBuildStore.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >
  for (const name of [
    'createBuild',
    'ensureRepo',
    'createSession',
    'append',
    'appendIfCurrent',
    'appendWithArtifacts',
    'appendWithArtifactsIfCurrent',
    'appendRepo',
    'appendRepoWithArtifacts',
    'appendSessionEvent',
    'appendSessionEventIfCurrent',
    'appendSessionWithArtifacts',
    'finishRepoTick',
    'close',
  ]) {
    const original = prototype[name]
    if (!original) throw new Error(`collector persistence seam missing: ${name}`)
    restore.push(() => {
      prototype[name] = original
    })
    prototype[name] = async function (...args) {
      capture(this)
      const result = await original.apply(this, args)
      capture(this)
      return result
    }
  }
  return () => {
    for (const reset of restore.reverse()) reset()
    stores.clear()
    streams.clear()
  }
}
export function collectedStreams(): CapturedStream[] {
  return structuredClone([...streams.values()])
}
if (process.env.PROA_CAPTURE_FILE) {
  installCollector()
  afterAll(() => writeFileSync(process.env.PROA_CAPTURE_FILE!, JSON.stringify(collectedStreams())))
}
