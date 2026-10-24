import {
  openPostgresOrganizationStoreFromEnv,
  type HumanActor,
  type OrganizationStore,
} from '@defrex/autobuild-postgres-store/organizations'
import { isAllowedEmail, normalizeEmail, parseWebAuthEnv, type WebEnv } from './config'
import type { GatewaySession } from './gateway'

let singleton: Promise<OrganizationStore> | undefined
export function organizationStore(): Promise<OrganizationStore> {
  singleton ??= openPostgresOrganizationStoreFromEnv(process.env).catch((error) => {
    singleton = undefined
    throw error
  })
  return singleton
}
export class HumanAccess {
  constructor(
    readonly store: () => Promise<OrganizationStore>,
    readonly env: WebEnv = process.env,
  ) {}
  actor(email: string): HumanActor {
    const normalized = normalizeEmail(email)
    return {
      email: normalized,
      isSuperUser: () => isAllowedEmail(parseWebAuthEnv(this.env).superUserEmails, normalized),
    }
  }
  async principal(email: string): Promise<HumanActor | null> {
    const actor = this.actor(email)
    return actor.isSuperUser() || (await (await this.store()).admitted(actor.email)) ? actor : null
  }
  async session(session: GatewaySession | null, now = new Date()): Promise<HumanActor | null> {
    if (!validSession(session, now)) return null
    return this.principal(session!.user.email)
  }
  async canAccess(actor: HumanActor, repo: string): Promise<boolean> {
    return (await this.store()).canAccess(actor, repo)
  }
  async projects(actor: HumanActor): Promise<string[]> {
    return (await this.store()).projects(actor)
  }
}
export function validSession(session: GatewaySession | null, now = new Date()): boolean {
  if (!session || typeof session.user?.email !== 'string') return false
  const expiry = session.session?.expiresAt
  return (
    expiry !== undefined && Number.isFinite(new Date(expiry).getTime()) && new Date(expiry) > now
  )
}
export const humanAccess = new HumanAccess(organizationStore)

/** Explicit environment callers get their own lazy adapter; production shares one pool. */
export function accessForEnv(env: WebEnv): HumanAccess {
  if (env === process.env) return humanAccess
  let pending: Promise<OrganizationStore> | undefined
  return new HumanAccess(() => {
    pending ??= openPostgresOrganizationStoreFromEnv(env).catch((error) => {
      pending = undefined
      throw error
    })
    return pending
  }, env)
}
