import { projectTransaction } from './request-context'
import {
  hostedProjectContext,
  projectAdmission,
  rememberProjectGeneration,
} from './request-context'
import type { SQL } from 'bun'
import type { Exec } from './retry'
import { AccessError } from './organizations'

/** Lock order: legacy lifecycle shared/exclusive, generation row, access singleton, parent rows,
 * blob shared/exclusive. Never hold the access singleton over provider I/O. */
export const PROJECT_LIFECYCLE_LOCK = 470281942
export const PROJECT_BLOB_LOCK = 470281943

/** A hosted request captures this before asynchronous work. Standalone adapters
 * do not require registration. Revalidate inside every mutation transaction. */
export interface ProjectAdmission {
  repo: string
  generation: string
  registration?: string
}
export async function findProject(sql: SQL | Exec, repo: string): Promise<ProjectAdmission | null> {
  return projectAdmission(repo, async () => {
    const [row] = await sql`SELECT g.generation, r.seq AS registration FROM project_generations g
      JOIN LATERAL (SELECT seq, action FROM project_journal WHERE repo = g.repo ORDER BY seq DESC LIMIT 1) r ON r.action = 'added'
      WHERE g.repo = ${repo} AND NOT EXISTS (SELECT 1 FROM project_deletions d WHERE d.repo = g.repo)`
    if (!row) return null
    const admission = {
      repo,
      generation: String(row.generation),
      registration: String(row.registration),
    }
    rememberProjectGeneration(repo, admission.generation)
    return admission
  })
}
export async function captureProject(sql: SQL | Exec, repo: string): Promise<ProjectAdmission> {
  const admission = await findProject(sql, repo)
  if (!admission) throw new AccessError(403, 'project not registered')
  return admission
}

// Keys are transaction executors, never pools or request contexts. Each retry
// receives a new executor and must acquire its own transaction-scoped locks.
const boundaries = new WeakMap<object, Map<string, Promise<void>>>()
export async function admitProject(sql: SQL | Exec, admission: ProjectAdmission): Promise<void> {
  let entries = boundaries.get(sql)
  if (!entries) {
    entries = new Map()
    boundaries.set(sql, entries)
  }
  const key = JSON.stringify([admission.repo, admission.generation])
  let result = entries.get(key)
  if (!result) {
    result = (async () => {
      const [row] = await sql`SELECT generation FROM project_generations
        WHERE repo = ${admission.repo} AND generation = ${admission.generation} FOR SHARE`
      if (!row) throw new AccessError(403, 'project not registered')
      // Standalone callers have no request admission to consume. Preserve their
      // registration check inside the transaction after acquiring the row fence.
      if (!hostedProjectContext()) await captureProject(sql, admission.repo)
    })()
    entries.set(key, result)
  }
  await result
}

/** Ownership is committed before upload, separately from publication: an upload
 * whose publication rolls back must still be collected on project deletion. */
export async function reserveProjectBlobs(
  sql: SQL,
  admission: ProjectAdmission,
  refs: readonly string[],
): Promise<void> {
  await projectTransaction(sql, async (tx) => {
    await admitProject(tx as SQL, admission)
    await tx`SELECT pg_advisory_xact_lock_shared(${PROJECT_BLOB_LOCK})`
    for (const ref of new Set(refs))
      await tx`INSERT INTO project_blob_ownership (repo, blob_ref) VALUES (${admission.repo}, ${ref}) ON CONFLICT DO NOTHING`
  })
}

/** Validate captured request identities before taking any mutation row locks. */
export async function admitHostedRequest(sql: SQL | Exec): Promise<void> {
  const context = hostedProjectContext()
  if (!context) return
  for (const [repo, generation] of [...context].sort(([a], [b]) => a.localeCompare(b)))
    await admitProject(sql, { repo, generation })
}
