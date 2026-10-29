import {
  CheckpointIntegrityError,
  RetiredSeedGenerationError,
  REPOSITORY_TAIL_WINDOW,
  type ReducerSnapshot,
  type SnapshotScope,
} from '@defrex/autobuild/store-adapter'
import type { Exec } from './retry'

export const STREAM_SEED_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS stream_seed_generations (
 scope_kind text NOT NULL, scope_key text NOT NULL, identity text NOT NULL,
 admitted bigint GENERATED ALWAYS AS IDENTITY, retired boolean NOT NULL DEFAULT false,
 PRIMARY KEY(scope_kind,scope_key,identity)
);
CREATE INDEX IF NOT EXISTS stream_seed_live ON stream_seed_generations(scope_kind,scope_key,admitted) WHERE NOT retired;
CREATE TABLE IF NOT EXISTS stream_seed_checkpoints (
 scope_kind text NOT NULL, scope_key text NOT NULL, identity text NOT NULL,
 cursor bigint NOT NULL, snapshot jsonb NOT NULL,
 PRIMARY KEY(scope_kind,scope_key,identity,cursor)
);
CREATE TABLE IF NOT EXISTS stream_seed_bootstrap (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 scope_kind text, scope_key text, boundary bigint, complete boolean NOT NULL DEFAULT false
);
INSERT INTO stream_seed_bootstrap(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS repo_harvest_history ON repo_events(repo,seq) WHERE type LIKE 'harvest.%';
`
export function seedScopeKey(scope: SnapshotScope): string {
  return scope.kind === 'build' ? scope.slug : scope.repo
}
/** Held only by derived-value readers. Appends never acquire this lock. */
export async function lockSeed(q: Exec, scope: SnapshotScope): Promise<void> {
  await q`SELECT pg_advisory_xact_lock(hashtextextended(${`stream-seed:${scope.kind}:${seedScopeKey(scope)}`},0))`
}
export async function admitSeed(q: Exec, scope: SnapshotScope, identity: string): Promise<boolean> {
  const key = seedScopeKey(scope)
  const found =
    await q`SELECT retired FROM stream_seed_generations WHERE scope_kind=${scope.kind} AND scope_key=${key} AND identity=${identity}`
  if (found[0]?.retired) throw new RetiredSeedGenerationError()
  if (found.length) return false
  await q`INSERT INTO stream_seed_generations(scope_kind,scope_key,identity) VALUES(${scope.kind},${key},${identity})`
  // At most three live rows can exist while holding the scope lock. Tombstones
  // are never scanned, pruned or used to order deployments.
  const live =
    await q`SELECT identity FROM stream_seed_generations WHERE scope_kind=${scope.kind} AND scope_key=${key} AND NOT retired ORDER BY admitted LIMIT 3`
  if (live.length > 2) {
    const oldest = String(live[0]!.identity)
    await q`UPDATE stream_seed_generations SET retired=true WHERE scope_kind=${scope.kind} AND scope_key=${key} AND identity=${oldest}`
    await q`DELETE FROM stream_seed_checkpoints WHERE scope_kind=${scope.kind} AND scope_key=${key} AND identity=${oldest}`
    await q`DELETE FROM reducer_snapshots WHERE scope_kind=${scope.kind} AND scope_key=${key} AND reducer=${oldest}`
  }
  return true
}
export function seedStorage(q: Exec, scope: SnapshotScope) {
  const scopeKey = seedScopeKey(scope)
  return {
    async coverage(identity: string, cursor: number) {
      const rows =
        await q`SELECT 1 FROM stream_seed_checkpoints WHERE scope_kind=${scope.kind} AND scope_key=${scopeKey} AND identity=${identity} AND cursor=${cursor}`
      return rows.length === 1
    },
    async publish(identity: string, snapshot: ReducerSnapshot, checkpoints: ReducerSnapshot[]) {
      await q`INSERT INTO reducer_snapshots(scope_kind,scope_key,reducer,version,cursor,state,updated_at) VALUES(${scope.kind},${scopeKey},${identity},${snapshot.version},${snapshot.cursor},${JSON.stringify(snapshot.state)}::jsonb,now()) ON CONFLICT(scope_kind,scope_key,reducer) DO UPDATE SET version=EXCLUDED.version,cursor=EXCLUDED.cursor,state=EXCLUDED.state,updated_at=EXCLUDED.updated_at`
      for (const checkpoint of checkpoints)
        await q`INSERT INTO stream_seed_checkpoints(scope_kind,scope_key,identity,cursor,snapshot) VALUES(${scope.kind},${scopeKey},${identity},${checkpoint.cursor},${JSON.stringify(checkpoint)}::jsonb) ON CONFLICT DO NOTHING`
      await q`DELETE FROM stream_seed_checkpoints WHERE scope_kind=${scope.kind} AND scope_key=${scopeKey} AND identity=${identity} AND cursor<${Math.max(0, snapshot.cursor - REPOSITORY_TAIL_WINDOW)}`
    },
  }
}
export async function loadSeed(
  q: Exec,
  scope: SnapshotScope,
  identity: string,
  cursor: number,
): Promise<ReducerSnapshot> {
  const rows =
    await q`SELECT snapshot FROM stream_seed_checkpoints WHERE scope_kind=${scope.kind} AND scope_key=${seedScopeKey(scope)} AND identity=${identity} AND cursor=${cursor}`
  if (!rows[0]) throw new CheckpointIntegrityError('missing stream-seed checkpoint')
  const snapshot = rows[0].snapshot
  let value: unknown
  try {
    value = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot
  } catch (cause) {
    throw new CheckpointIntegrityError('corrupt stream-seed checkpoint', { cause })
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('cursor' in value) ||
    !Number.isSafeInteger(value.cursor) ||
    !('version' in value) ||
    !Number.isSafeInteger(value.version)
  )
    throw new CheckpointIntegrityError('corrupt stream-seed checkpoint')
  return value as ReducerSnapshot
}

/** Shared by ordinary seed catch-up and the migration's bounded resumable fold. */
export function seedValueStorage(q: Exec, scope: SnapshotScope, boundary?: number) {
  const scopeKey = seedScopeKey(scope)
  return {
    checkpoints: seedStorage(q, scope),
    async highWater() {
      const rows =
        scope.kind === 'build'
          ? await q`SELECT (SELECT COALESCE(MAX(seq),0) FROM events WHERE build=${scopeKey}) AS tail FROM builds WHERE slug=${scopeKey}`
          : await q`SELECT (SELECT COALESCE(MAX(seq),0) FROM repo_events WHERE repo=${scopeKey}) AS tail FROM repo_streams WHERE repo=${scopeKey}`
      if (!rows[0]) throw new Error('unknown reducer scope')
      return Math.min(Number(rows[0].tail), boundary ?? Number.MAX_SAFE_INTEGER)
    },
    async read(key: string) {
      const rows =
        await q`SELECT version,cursor,state FROM reducer_snapshots WHERE scope_kind=${scope.kind} AND scope_key=${scopeKey} AND reducer=${key}`
      const row = rows[0]
      return row
        ? {
            snapshot: {
              version: Number(row.version),
              cursor: Number(row.cursor),
              state: typeof row.state === 'string' ? JSON.parse(row.state) : row.state,
            },
            token: '',
          }
        : null
    },
    async events(since: number, through: number) {
      const rows =
        scope.kind === 'build'
          ? await q`SELECT * FROM events WHERE build=${scopeKey} AND seq>${since} AND seq<=${through} ORDER BY seq`
          : await q`SELECT * FROM repo_events WHERE repo=${scopeKey} AND seq>${since} AND seq<=${through} ORDER BY seq`
      return rows.map((row) => ({
        ...(scope.kind === 'build' ? { build: scopeKey } : { repo: scopeKey }),
        seq: Number(row.seq),
        ts: new Date(row.ts as string).toISOString(),
        actor: typeof row.actor === 'string' ? JSON.parse(row.actor) : row.actor,
        type: String(row.type),
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        ...(row.compatibility
          ? {
              compatibility:
                typeof row.compatibility === 'string'
                  ? JSON.parse(row.compatibility)
                  : row.compatibility,
            }
          : {}),
      })) as
        | import('@defrex/autobuild/plugin-sdk').AbEvent[]
        | import('@defrex/autobuild/plugin-sdk').RepositoryEvent[]
    },
    async put(): Promise<boolean> {
      throw new CheckpointIntegrityError('seed requires atomic publication')
    },
    async repair(): Promise<boolean> {
      throw new CheckpointIntegrityError('seed requires atomic publication')
    },
  }
}
