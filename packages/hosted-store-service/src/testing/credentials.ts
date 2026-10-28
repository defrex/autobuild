import { createHash, randomBytes } from 'node:crypto'
import type {
  CredentialMetadata,
  DispatcherCredentialStore,
} from '@defrex/autobuild-postgres-store/credentials'
import {
  LAST_USE_INTERVAL_MS,
  ProjectNotRegisteredError,
} from '@defrex/autobuild-postgres-store/credentials'
import type { ProjectRegistryReader } from '@defrex/autobuild-postgres-store/projects'
import { createMachineAuth } from '../machine-auth'

/** Mutable persistence seam; production authentication and routing remain real. */
export function testCredentials(
  projects: ProjectRegistryReader,
  secret = 'secret',
  clock = () => new Date(),
) {
  const rows = new Map<string, { digest: string; meta: CredentialMetadata }>()
  const hash = (token: string) => createHash('sha256').update(token).digest('hex')
  const store: DispatcherCredentialStore = {
    async issue(repo, user, options = {}) {
      if (!(await projects.has(repo))) throw new ProjectNotRegisteredError()
      if (!user.trim()) throw new Error('credential creator must be nonblank')
      const id = randomBytes(16).toString('hex')
      const token = `abp_1_${id}_${randomBytes(32).toString('hex')}`
      const credential: CredentialMetadata = {
        id,
        repo,
        createdAt: clock().toISOString(),
        createdBy: user,
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: options.expiresAt?.toISOString() ?? null,
        purpose: options.purpose ?? 'project-owner',
      }
      rows.set(id, { digest: hash(token), meta: credential })
      return { token, credential: { ...credential } }
    },
    async authenticate(token, now) {
      const id = /^abp_1_([a-f0-9]{32})_/.exec(token)?.[1]
      const row = id ? rows.get(id) : undefined
      if (
        !row ||
        row.digest !== hash(token) ||
        row.meta.revokedAt ||
        (row.meta.expiresAt && Date.parse(row.meta.expiresAt) <= now.getTime())
      )
        return null
      if (!(await projects.has(row.meta.repo))) throw new ProjectNotRegisteredError()
      if (
        !row.meta.lastUsedAt ||
        now.getTime() - Date.parse(row.meta.lastUsedAt) >= LAST_USE_INTERVAL_MS
      )
        row.meta.lastUsedAt = now.toISOString()
      return { ...row.meta }
    },
    async list(repo) {
      return [...rows.values()]
        .filter((row) => row.meta.repo === repo)
        .map((row) => ({ ...row.meta }))
    },
    async revoke(repo, id, _user) {
      const row = rows.get(id)
      if (row?.meta.repo === repo) row.meta.revokedAt ??= clock().toISOString()
    },
    async deleteDispatcherCredential(repo, id) {
      const row = rows.get(id)
      if (row?.meta.repo !== repo || row.meta.purpose !== 'dispatcher') return 0
      rows.delete(id)
      return 1
    },
    async pruneDispatcherCredentials(repo, now) {
      let count = 0
      for (const [id, { meta }] of rows) {
        if (count === 100) break
        if (
          meta.repo === repo &&
          meta.purpose === 'dispatcher' &&
          ((meta.expiresAt && Date.parse(meta.expiresAt) <= now.getTime()) ||
            (meta.revokedAt && Date.parse(meta.revokedAt) <= now.getTime()))
        ) {
          rows.delete(id)
          count++
        }
      }
      return count
    },
    async close() {},
  }
  return { store, auth: createMachineAuth({ secret, projects, credentials: store, clock }) }
}
