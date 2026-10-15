import { createHash, randomBytes } from 'node:crypto'
import type {
  CredentialMetadata,
  CredentialStore,
} from '@defrex/autobuild-postgres-store/credentials'
import { ProjectNotRegisteredError } from '@defrex/autobuild-postgres-store/credentials'
import type { ProjectRegistryReader } from '@defrex/autobuild-postgres-store/projects'

/** Mutable persistence seam; production authentication and routing remain real. */
export function testCredentials(
  projects: ProjectRegistryReader,
  _secret = 'secret',
  clock = () => new Date(),
) {
  const rows = new Map<string, { digest: string; meta: CredentialMetadata }>()
  const hash = (token: string) => createHash('sha256').update(token).digest('hex')
  const store: CredentialStore = {
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
    async close() {},
  }
  return { store }
}
