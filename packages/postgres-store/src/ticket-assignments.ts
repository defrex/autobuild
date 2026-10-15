import { SQL } from 'bun'
import { normalizeProjectRepository, initializeProjectRegistryForRecovery } from './projects'
import { resolvePostgresUrl, type PostgresEnv } from './env'

export const TICKET_ASSIGNMENTS_DDL = `CREATE TABLE IF NOT EXISTS ticket_team_assignments (
  seq bigserial PRIMARY KEY, team text NOT NULL, repo text NOT NULL,
  actor text NOT NULL, ts timestamptz NOT NULL
)`
export interface TicketAssignments {
  assign(team: string, repo: string, actor: string): Promise<void>
  close(): Promise<void>
}
/** Deliberately independent of v2 ticket schema assertion: this is the recovery
 * path for a migration whose ownership preflight has stopped. */
export async function openTicketAssignmentsFromEnv(env: PostgresEnv): Promise<TicketAssignments> {
  const sql = new SQL(resolvePostgresUrl(env))
  try {
    await initializeProjectRegistryForRecovery(sql, env)
    await sql.unsafe(TICKET_ASSIGNMENTS_DDL)
    return {
      async assign(team, rawRepo, actor) {
        const repo = normalizeProjectRepository(rawRepo)
        if (!team.trim() || !actor.trim()) throw new Error('team and actor must be nonblank')
        await sql.begin(async (tx) => {
          await tx`LOCK TABLE project_journal, ticket_team_assignments IN SHARE ROW EXCLUSIVE MODE`
          const [entry] =
            await tx`SELECT action FROM project_journal WHERE repo = ${repo} ORDER BY seq DESC LIMIT 1`
          if (entry?.action !== 'added') throw new Error(`project not registered: ${repo}`)
          await tx`INSERT INTO ticket_team_assignments (team, repo, actor, ts)
            VALUES (${team}, ${repo}, ${actor.trim()}, ${new Date().toISOString()})`
        })
      },
      close: () => sql.close(),
    }
  } catch (error) {
    await sql.close()
    throw error
  }
}
