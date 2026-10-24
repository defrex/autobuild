import { SQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { resolvePostgresUrl, type PostgresEnv } from './env'
import { assertAuthSchema } from './auth-schema'
import { normalizeProjectRepository, PostgresProjectRegistry } from './projects'

export type MembershipRole = 'owner' | 'member'
export interface OrganizationMember {
  email: string
  role: MembershipRole
  name: string | null
  status: 'joined' | 'pending'
}
export interface HumanActor {
  email: string
  /** Evaluated inside the transaction so configuration removal takes effect. */
  isSuperUser(): boolean
}
export interface Organization {
  id: string
  name: string
  slug: string
  ownerEmail: string | null
  membershipRole: MembershipRole | null
}
export class AccessError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
export interface OrganizationStore {
  organizations(actor: HumanActor): Promise<Organization[]>
  admitted(email: string): Promise<boolean>
  canAccess(actor: HumanActor, repo: string): Promise<boolean>
  projects(actor: HumanActor): Promise<string[]>
  unassigned(actor: HumanActor): Promise<string[]>
  create(actor: HumanActor, name: string, slug: string): Promise<Organization>
  inspect(
    actor: HumanActor,
    id: string,
  ): Promise<{ organization: Organization; projects: string[] }>
  members(actor: HumanActor, id: string): Promise<OrganizationMember[]>
  addMember(
    actor: HumanActor,
    id: string,
    email: string,
  ): Promise<{ email: string; role: MembershipRole }>
  removeMember(actor: HumanActor, id: string, email: string): Promise<void>
  setOwner(actor: HumanActor, id: string, email: string | null): Promise<Organization>
  assign(
    actor: HumanActor,
    id: string,
    repo: string,
  ): Promise<{ repo: string; organizationId: string }>
  materialize(userId: string, email: string): Promise<void>
}
export function memberEmail(raw: string): string {
  const email = raw.trim().toLowerCase()
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new AccessError(400, 'invalid email')
  return email
}
export async function lockAccess(sql: SQL): Promise<void> {
  await sql`INSERT INTO project_registry_state (singleton, legacy_imported) VALUES (true, false) ON CONFLICT DO NOTHING`
  await sql`SELECT singleton FROM project_registry_state WHERE singleton = true FOR UPDATE`
}
export class PostgresOrganizationStore implements OrganizationStore {
  constructor(private readonly sql: SQL) {}
  private async locked<T>(work: (store: PostgresOrganizationStore) => Promise<T>): Promise<T> {
    try {
      return (await this.sql.begin(async (tx) => {
        await lockAccess(tx as SQL)
        return work(new PostgresOrganizationStore(tx as SQL))
      })) as T
    } catch (error) {
      if (
        (error as { errno?: string }).errno === '23505' ||
        (error as { code?: string }).code === '23505'
      )
        throw new AccessError(409, 'organization slug already exists')
      throw error
    }
  }
  private super(actor: HumanActor) {
    if (!actor.isSuperUser()) throw new AccessError(403, 'super user required')
  }
  async admitted(email: string): Promise<boolean> {
    const rows = await this.sql`SELECT 1 FROM organization_emails WHERE email = ${email} LIMIT 1`
    return rows.length > 0
  }
  async organizations(actor: HumanActor): Promise<Organization[]> {
    return (await this.sql`SELECT o.id, o.name, o.slug,
      (SELECT email FROM organization_emails WHERE organization_id = o.id AND role = 'owner') AS "ownerEmail",
      e.role AS "membershipRole"
      FROM organization o LEFT JOIN organization_emails e ON e.organization_id = o.id AND e.email = ${actor.email}
      WHERE ${actor.isSuperUser()} OR e.email IS NOT NULL ORDER BY o.slug, o.id`) as Organization[]
  }
  private async org(actor: HumanActor, id: string): Promise<Organization> {
    const [row] = await this.sql`SELECT id FROM organization WHERE id = ${id}`
    if (!row) throw new AccessError(404, 'unknown organization')
    const organization = (await this.organizations({ ...actor, isSuperUser: () => true })).find(
      (o) => o.id === id,
    )
    return organization!
  }
  private async manage(actor: HumanActor, id: string): Promise<Organization> {
    if (!actor.isSuperUser()) {
      const [row] = await this
        .sql`SELECT role FROM organization_emails WHERE organization_id = ${id} AND email = ${actor.email}`
      if (row?.role !== 'owner') throw new AccessError(403, 'organization owner required')
    }
    return this.org(actor, id)
  }
  async canAccess(actor: HumanActor, repo: string): Promise<boolean> {
    if (!(await new PostgresProjectRegistry(this.sql).has(repo))) return false
    if (actor.isSuperUser()) return true
    const rows = await this
      .sql`SELECT 1 FROM project_organizations p JOIN organization_emails e ON e.organization_id = p.organization_id
      WHERE p.repo = ${repo} AND e.email = ${actor.email}`
    return rows.length > 0
  }
  async projects(actor: HumanActor): Promise<string[]> {
    const rows = await this.sql`SELECT repo FROM (
      SELECT DISTINCT ON (repo) repo, action FROM project_journal ORDER BY repo, seq DESC
    ) latest WHERE action = 'added' AND (${actor.isSuperUser()} OR EXISTS (
      SELECT 1 FROM project_organizations p JOIN organization_emails e ON e.organization_id = p.organization_id
      WHERE p.repo = latest.repo AND e.email = ${actor.email})) ORDER BY repo`
    return rows.map((row: { repo: string }) => row.repo)
  }
  async unassigned(actor: HumanActor): Promise<string[]> {
    this.super(actor)
    const rows = await this.sql`SELECT repo FROM (
      SELECT DISTINCT ON (repo) repo, action FROM project_journal ORDER BY repo, seq DESC
    ) latest WHERE action = 'added' AND NOT EXISTS (SELECT 1 FROM project_organizations p WHERE p.repo = latest.repo) ORDER BY repo`
    return rows.map((row: { repo: string }) => row.repo)
  }
  async create(actor: HumanActor, name: string, slug: string): Promise<Organization> {
    if (
      !name.trim() ||
      name.trim().length > 100 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
      slug.length > 100
    )
      throw new AccessError(400, 'invalid organization name or slug')
    return this.locked(async (store) => {
      store.super(actor)
      const id = randomUUID()
      await store.sql`INSERT INTO organization (id, name, slug, "createdAt") VALUES (${id}, ${name.trim()}, ${slug}, ${new Date()})`
      return store.org(actor, id)
    })
  }
  private async read(actor: HumanActor, id: string): Promise<Organization> {
    if (!actor.isSuperUser()) {
      const [grant] = await this
        .sql`SELECT 1 FROM organization_emails WHERE organization_id = ${id} AND email = ${actor.email}`
      if (!grant) throw new AccessError(403, 'organization access required')
    }
    return this.org(actor, id)
  }
  async inspect(actor: HumanActor, id: string) {
    const organization = await this.read(actor, id)
    const rows = await this
      .sql`SELECT p.repo FROM project_organizations p WHERE organization_id = ${id}
      AND (SELECT action FROM project_journal WHERE repo = p.repo ORDER BY seq DESC LIMIT 1) = 'added' ORDER BY p.repo`
    return { organization, projects: rows.map((row: { repo: string }) => String(row.repo)) }
  }
  async members(actor: HumanActor, id: string): Promise<OrganizationMember[]> {
    await this.read(actor, id)
    return (await this.sql`SELECT e.email, e.role, u.name,
      CASE WHEN u.id IS NULL THEN 'pending' ELSE 'joined' END AS status
      FROM organization_emails e LEFT JOIN LATERAL (
        SELECT id, name FROM "user" WHERE lower(email) = e.email ORDER BY id LIMIT 1
      ) u ON true WHERE e.organization_id = ${id} ORDER BY e.email`) as OrganizationMember[]
  }
  private async sync(email: string) {
    await this
      .sql`DELETE FROM member m USING "user" u WHERE m."userId" = u.id AND lower(u.email) = ${email}
      AND NOT EXISTS (SELECT 1 FROM organization_emails e WHERE e.organization_id = m."organizationId" AND e.email = ${email})`
    await this.sql`INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
      SELECT gen_random_uuid()::text, e.organization_id, u.id, e.role, now() FROM organization_emails e JOIN "user" u ON lower(u.email) = e.email
      WHERE e.email = ${email} ON CONFLICT ("organizationId", "userId") DO UPDATE SET role = EXCLUDED.role`
  }
  async materialize(_userId: string, email: string) {
    await this.locked((store) => store.sync(memberEmail(email)))
  }
  async addMember(actor: HumanActor, id: string, raw: string) {
    const email = memberEmail(raw)
    return this.locked(async (store) => {
      await store.manage(actor, id)
      const [row] =
        await store.sql`INSERT INTO organization_emails (organization_id, email, role) VALUES (${id}, ${email}, 'member')
        ON CONFLICT (organization_id, email) DO UPDATE SET email = EXCLUDED.email RETURNING email, role`
      await store.sync(email)
      return row as { email: string; role: MembershipRole }
    })
  }
  async removeMember(actor: HumanActor, id: string, raw: string) {
    const email = memberEmail(raw)
    await this.locked(async (store) => {
      await store.manage(actor, id)
      if (!actor.isSuperUser() && actor.email === email)
        throw new AccessError(403, 'owners cannot remove themselves')
      await store.sql`DELETE FROM organization_emails WHERE organization_id = ${id} AND email = ${email}`
      await store.sync(email)
    })
  }
  async setOwner(actor: HumanActor, id: string, raw: string | null) {
    const email = raw === null ? null : memberEmail(raw)
    return this.locked(async (store) => {
      store.super(actor)
      await store.org(actor, id)
      if (email !== null) {
        const [row] =
          await store.sql`SELECT 1 FROM organization_emails WHERE organization_id = ${id} AND email = ${email}`
        if (!row) throw new AccessError(400, 'owner must be an existing member')
      }
      const previous =
        await store.sql`UPDATE organization_emails SET role = 'member' WHERE organization_id = ${id} AND role = 'owner' RETURNING email`
      if (email !== null)
        await store.sql`UPDATE organization_emails SET role = 'owner' WHERE organization_id = ${id} AND email = ${email}`
      for (const row of previous) await store.sync(row.email)
      if (email !== null) await store.sync(email)
      return store.org(actor, id)
    })
  }
  async assign(actor: HumanActor, id: string, raw: string) {
    let repo: string
    try {
      repo = normalizeProjectRepository(raw)
    } catch {
      throw new AccessError(400, 'invalid repository')
    }
    return this.locked(async (store) => {
      store.super(actor)
      await store.org(actor, id)
      if (!(await new PostgresProjectRegistry(store.sql).has(repo)))
        throw new AccessError(404, 'unknown repository')
      await store.sql`INSERT INTO project_organizations (repo, organization_id) VALUES (${repo}, ${id}) ON CONFLICT (repo) DO UPDATE SET organization_id = EXCLUDED.organization_id`
      return { repo, organizationId: id }
    })
  }
}
export async function openPostgresOrganizationStoreFromEnv(
  env: PostgresEnv,
): Promise<OrganizationStore> {
  const sql = new SQL(resolvePostgresUrl(env))
  try {
    await assertAuthSchema(sql)
    return new PostgresOrganizationStore(sql)
  } catch (error) {
    await sql.close()
    throw error
  }
}
