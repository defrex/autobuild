import type { SQL } from 'bun'
import {
  readReducerValue,
  resolveReducerValue,
  type SnapshotScope,
} from '@defrex/autobuild/store-adapter'
import { lockSeed, admitSeed, seedValueStorage, seedScopeKey } from './stream-seeds'
import { PlanRetryRunner } from './retry'

/** Explicit one-time migration only. Each transaction folds at most 256 rows;
 * its cache/checkpoints and migration position commit together. */
export async function bootstrapStreamSeeds(sql: SQL): Promise<void> {
  const retry = new PlanRetryRunner()
  while (
    await retry.tx(sql, async (q) => {
      await q`SELECT pg_advisory_xact_lock(470281941)`
      await q`SELECT pg_advisory_xact_lock(470281942)`
      const markers = await q`SELECT * FROM stream_seed_bootstrap WHERE singleton=true FOR UPDATE`
      const marker = markers[0]!
      if (marker.complete) return false
      let scope: SnapshotScope
      let boundary: number
      if (marker.boundary !== null) {
        scope =
          marker.scope_kind === 'build'
            ? { kind: 'build', slug: String(marker.scope_key) }
            : { kind: 'repo', repo: String(marker.scope_key) }
        boundary = Number(marker.boundary)
      } else {
        const rows =
          await q`SELECT kind,key FROM (SELECT 'build' AS kind,slug AS key FROM builds UNION ALL SELECT 'repo',repo FROM repo_streams) scopes WHERE (kind,key)>(${marker.scope_kind ?? ''},${marker.scope_key ?? ''}) ORDER BY kind,key LIMIT 1`
        const next = rows[0]
        if (!next) {
          await q`UPDATE stream_seed_bootstrap SET complete=true WHERE singleton=true`
          return false
        }
        scope =
          next.kind === 'build'
            ? { kind: 'build', slug: String(next.key) }
            : { kind: 'repo', repo: String(next.key) }
        await lockSeed(q, scope)
        boundary = await seedValueStorage(q, scope).highWater()
        await q`UPDATE stream_seed_bootstrap SET scope_kind=${scope.kind},scope_key=${seedScopeKey(scope)},boundary=${boundary} WHERE singleton=true`
      }
      await lockSeed(q, scope)
      const scopeKey = seedScopeKey(scope)
      const request = {
        reducer: scope.kind === 'build' ? 'buildStreamSeed' : 'repositoryAttention',
      }
      const { key } = resolveReducerValue(scope, request)
      await admitSeed(q, scope, key)
      const storage = seedValueStorage(q, scope)
      const row = await storage.read(key)
      let cursor = row?.snapshot.cursor ?? 0
      if (row && !(await storage.checkpoints.coverage(key, cursor))) {
        // Adoption only: legacy canonical rows predate rolling checkpoints.
        await q`DELETE FROM reducer_snapshots WHERE scope_kind=${scope.kind} AND scope_key=${scopeKey} AND reducer=${key}`
        cursor = 0
      }
      if (cursor <= boundary)
        await readReducerValue(
          scope,
          request,
          seedValueStorage(q, scope, Math.min(boundary, cursor + 256)),
        )
      if (cursor + 256 >= boundary)
        await q`UPDATE stream_seed_bootstrap SET boundary=NULL WHERE singleton=true`
      return true
    })
  ) {
    /* Persisted progress is the only resume authority. */
  }
}
