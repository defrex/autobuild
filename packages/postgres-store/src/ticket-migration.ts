import type { SQL } from 'bun'
import type { BlobStore, RepositoryEvent } from '@defrex/autobuild/plugin-sdk'
import { findEffectiveConfigRef, decodeEffectiveConfig } from '@defrex/autobuild/operator'
import { TICKET_ASSIGNMENTS_DDL } from './ticket-assignments'

/** Called only inside the schema migration transaction. Locks preserve the
 * registry/config/ownership snapshot across immutable blob reads and rekeying. */
export async function migrateLegacyTickets(
  sql: SQL,
  openBlobs?: () => BlobStore | Promise<BlobStore>,
): Promise<void> {
  await sql.unsafe(TICKET_ASSIGNMENTS_DDL)
  await sql`LOCK TABLE project_journal, repo_streams, repo_events, repo_artifacts,
    ticket_team_assignments, ab_tickets, ab_ticket_comments, ab_ticket_blockers,
    ticket_assets IN SHARE ROW EXCLUSIVE MODE`
  const teams: { team: string }[] = await sql`SELECT team FROM ab_tickets UNION
    SELECT team FROM ab_ticket_comments UNION SELECT team FROM ab_ticket_blockers`
  const assignments = new Map<string, string>()
  if (teams.length > 0) {
    if (!openBlobs)
      throw new Error(
        'Populated v1 ticket migration requires blob access; configure the service blob backend, credentials, access and prefix and rerun the environment-aware migration command.',
      )
    let blobs: BlobStore
    try {
      blobs = await openBlobs()
    } catch {
      throw new Error(
        'Ticket migration cannot open blob storage; configure the service blob backend, credentials, access and prefix.',
      )
    }
    const projects: { repo: string }[] = await sql`SELECT repo FROM (
      SELECT DISTINCT ON (repo) repo, action FROM project_journal ORDER BY repo, seq DESC
    ) latest WHERE action = 'added' ORDER BY repo`
    const overrides: { team: string; repo: string }[] =
      await sql`SELECT DISTINCT ON (team) team, repo FROM ticket_team_assignments ORDER BY team, seq DESC`
    const remaining = teams.filter(({ team }) => !overrides.some((item) => item.team === team))
    const configFailure = (detail: string) =>
      new Error(
        `Ticket migration stopped unchanged: ${detail}. Restore the selected effective configuration/blob, or explicitly assign every remaining legacy team (${remaining.map(({ team }) => team).join(', ')}) with ab-hosted-store tickets assign-team TEAM REPOSITORY --user IDENTITY, then rerun migration.`,
      )
    const claimants = new Map<string, string[]>()
    for (const { repo } of remaining.length > 0 ? projects : []) {
      const config = await loadTicketConfig(sql, blobs, repo, configFailure)
      if (!config) continue
      const team = config.tickets.teamKey
      if (team !== undefined) claimants.set(team, [...(claimants.get(team) ?? []), repo])
    }
    const errors: string[] = []
    for (const { team } of teams) {
      const override = overrides.find((item) => item.team === team)
      const candidates = claimants.get(team) ?? []
      if (override && projects.some((project) => project.repo === override.repo))
        assignments.set(team, override.repo)
      else if (!override && candidates.length === 1) assignments.set(team, candidates[0]!)
      else
        errors.push(
          `team "${team}": ${override ? `assignment project is not registered: ${override.repo}` : candidates.length ? `conflicting projects: ${candidates.join(', ')}` : 'no project claims this team'}`,
        )
    }
    if (errors.length)
      throw new Error(
        `Ticket migration stopped unchanged: ${errors.join('; ')}. Resolve ownership with ab-hosted-store tickets assign-team TEAM REPOSITORY --user IDENTITY, then rerun migration.`,
      )
    const assets: { repo: string; ticket_id: string; team: string }[] =
      await sql`SELECT DISTINCT a.repo, a.ticket_id, t.team FROM ticket_assets a JOIN ab_tickets t ON t.id = a.ticket_id`
    for (const asset of assets) {
      if (assignments.get(asset.team) !== asset.repo)
        throw new Error(
          `Ticket migration: asset ownership mismatch for ${asset.ticket_id}, team ${asset.team}, project ${asset.repo}`,
        )
    }
    // Reject collapsing distinct old teams onto a duplicate project id/key.
    const tickets: { team: string; id: string; creation_key: string | null }[] =
      await sql`SELECT team, id, creation_key FROM ab_tickets`
    const ids = new Set<string>(),
      keys = new Set<string>()
    for (const ticket of tickets) {
      const repo = assignments.get(ticket.team)!
      const id = JSON.stringify([repo, ticket.id]),
        key = JSON.stringify([repo, ticket.creation_key])
      if (ids.has(id) || (ticket.creation_key !== null && keys.has(key)))
        throw new Error(`Ticket migration: colliding ticket id or creation key in ${repo}`)
      ids.add(id)
      if (ticket.creation_key !== null) keys.add(key)
    }
  }
  // Drop FKs during the all-at-once partition rewrite; PKs/unique indexes stay
  // live. Temporary values avoid collisions with legacy team strings.
  await sql.unsafe(`ALTER TABLE ab_ticket_comments DROP CONSTRAINT ab_ticket_comments_team_ticket_id_fkey;
    ALTER TABLE ab_ticket_blockers DROP CONSTRAINT ab_ticket_blockers_team_ticket_id_fkey;
    ALTER TABLE ab_ticket_blockers DROP CONSTRAINT ab_ticket_blockers_team_blocker_id_fkey;`)
  const staged = [...assignments].map(([team, repo]) => ({
    team,
    repo,
    temporary: `migration-${crypto.randomUUID()}`,
  }))
  for (const item of staged) {
    await sql`UPDATE ab_tickets SET team = ${item.temporary} WHERE team = ${item.team}`
    await sql`UPDATE ab_ticket_comments SET team = ${item.temporary} WHERE team = ${item.team}`
    await sql`UPDATE ab_ticket_blockers SET team = ${item.temporary} WHERE team = ${item.team}`
  }
  for (const item of staged) {
    await sql`UPDATE ab_tickets SET team = ${item.repo} WHERE team = ${item.temporary}`
    await sql`UPDATE ab_ticket_comments SET team = ${item.repo} WHERE team = ${item.temporary}`
    await sql`UPDATE ab_ticket_blockers SET team = ${item.repo} WHERE team = ${item.temporary}`
  }
  await sql.unsafe(`ALTER TABLE ab_tickets RENAME COLUMN team TO repo;
    ALTER TABLE ab_ticket_comments RENAME COLUMN team TO repo;
    ALTER TABLE ab_ticket_blockers RENAME COLUMN team TO repo;
    ALTER TABLE ab_ticket_comments ADD FOREIGN KEY (repo,ticket_id) REFERENCES ab_tickets(repo,id) ON DELETE CASCADE;
    ALTER TABLE ab_ticket_blockers ADD FOREIGN KEY (repo,ticket_id) REFERENCES ab_tickets(repo,id) ON DELETE CASCADE;
    ALTER TABLE ab_ticket_blockers ADD FOREIGN KEY (repo,blocker_id) REFERENCES ab_tickets(repo,id) ON DELETE CASCADE;`)
}

/** Load exactly the durable effective config selected by the repository log. */
async function loadTicketConfig(
  sql: SQL,
  blobs: BlobStore,
  repo: string,
  configFailure: (detail: string) => Error,
) {
  const rows: { seq: number; ts: string; actor: unknown; type: string; payload: unknown }[] =
    await sql`SELECT seq, ts, actor, type, payload FROM repo_events WHERE repo = ${repo} ORDER BY seq`
  const events = rows.map((row) => ({
    ...row,
    repo,
    seq: Number(row.seq),
    ts: new Date(row.ts).toISOString(),
  })) as RepositoryEvent[]
  const ref = findEffectiveConfigRef(events)
  // Registration/onboarding alone makes no team claim.
  if (ref === undefined) return undefined
  const [artifact] =
    await sql`SELECT blob_ref FROM repo_artifacts WHERE repo = ${repo} AND kind = ${ref.kind} AND revision = ${ref.rev}`
  if (!artifact)
    throw configFailure(`effective config ${ref.kind}@${ref.rev} unavailable for ${repo}`)
  let bytes: Uint8Array | null
  try {
    bytes = await blobs.get(artifact.blob_ref)
  } catch {
    throw configFailure(
      `cannot read effective configuration blob for ${repo}; check blob access and prefix`,
    )
  }
  if (bytes === null)
    throw configFailure(
      `missing effective configuration blob for ${repo}; check blob backend and prefix`,
    )
  let config: ReturnType<typeof decodeEffectiveConfig>
  try {
    config = decodeEffectiveConfig(bytes, `${repo} ${ref.kind}@${ref.rev}`)
  } catch {
    throw configFailure(`selected effective config ${ref.kind}@${ref.rev} for ${repo} is invalid`)
  }
  return config
}

export const READABLE_TICKET_CONSTRAINTS = `
ALTER TABLE ab_tickets ALTER COLUMN readable_id SET NOT NULL;
ALTER TABLE ab_tickets ALTER COLUMN ticket_number SET NOT NULL;
ALTER TABLE ab_tickets ADD CONSTRAINT ab_tickets_ticket_number_check CHECK (ticket_number > 0);
ALTER TABLE ab_tickets ADD CONSTRAINT ab_tickets_repo_ticket_number_key UNIQUE (repo, ticket_number);
CREATE UNIQUE INDEX ab_tickets_readable_id_key ON ab_tickets (repo, lower(readable_id));
`

/** Runs once, under the schema marker transaction; no historical foreign keys move. */
export async function migrateReadableTickets(
  sql: SQL,
  openBlobs?: () => BlobStore | Promise<BlobStore>,
): Promise<void> {
  await sql`LOCK TABLE ab_tickets, ab_ticket_comments, ab_ticket_blockers, ticket_assets,
    repo_events, repo_artifacts IN SHARE ROW EXCLUSIVE MODE`
  await sql.unsafe(`ALTER TABLE ab_tickets ADD COLUMN readable_id text;
    ALTER TABLE ab_tickets ADD COLUMN ticket_number bigint;
    CREATE TABLE ab_ticket_counters (repo text PRIMARY KEY, last_number bigint NOT NULL CHECK (last_number >= 0));`)
  const projects: { repo: string }[] = await sql`SELECT DISTINCT repo FROM ab_tickets ORDER BY repo`
  const fail = (detail: string) =>
    new Error(
      `Readable ticket migration stopped unchanged: ${detail}. Restore the project's effective configuration and blob access, then rerun migration.`,
    )
  let blobs: BlobStore | undefined
  if (projects.length) {
    if (!openBlobs) throw fail('populated projects require blob access')
    try {
      blobs = await openBlobs()
    } catch {
      throw fail('cannot open blob storage')
    }
  }
  for (const { repo } of projects) {
    const config = await loadTicketConfig(sql, blobs!, repo, fail)
    const prefix = config?.tickets.teamKey
    if (!prefix?.trim()) throw fail(`project ${repo} has no nonblank effective tickets.teamKey`)
    await sql`WITH numbered AS (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM ab_tickets WHERE repo = ${repo})
      UPDATE ab_tickets t SET ticket_number = numbered.n, readable_id = ${prefix} || '-' || numbered.n::text
      FROM numbered WHERE t.repo = ${repo} AND t.id = numbered.id`
    await sql`INSERT INTO ab_ticket_counters (repo, last_number) SELECT ${repo}, max(ticket_number) FROM ab_tickets WHERE repo = ${repo}`
  }
  await sql.unsafe(READABLE_TICKET_CONSTRAINTS)
}
