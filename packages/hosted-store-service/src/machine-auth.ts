import type { TicketGrant } from '@defrex/autobuild-postgres-store/ticket-grants'
import type { ProjectRegistryReader } from '@defrex/autobuild-postgres-store/projects'
import {
  ProjectNotRegisteredError,
  type CredentialReader,
  type CredentialMetadata,
} from '@defrex/autobuild-postgres-store/credentials'
import type { BuildStore } from '@defrex/autobuild/plugin-sdk'
import { delegationActive, type Delegation } from './delegated-authority'
import { verifyToken, type Via } from '@defrex/autobuild/remote-store'

export type MachinePrincipal =
  | { kind: 'ticket-grant'; repo: string; user: string; grant: TicketGrant }
  | { kind: 'delegated'; repo: string; user: string; delegation: Delegation }
  | { kind: 'project'; repo: string; user: string; credential: CredentialMetadata }
  | { kind: 'internal'; repo: string; user: string; via?: Via }
  | { kind: 'admin'; user: string }
export class MachineAuthError extends Error {
  readonly kind = 'auth'
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
export const RETIRED_CREDENTIAL_MESSAGE =
  'credential format changed; obtain a project credential from the owner using ab-hosted-store credentials issue REPOSITORY --user IDENTITY'
export interface MachineAuth {
  authenticate(request: Request): Promise<MachinePrincipal>
}
export function requireProject(principal: MachinePrincipal, repo: string): void {
  if (principal.kind !== 'admin' && principal.repo !== repo)
    throw new MachineAuthError(403, 'wrong project')
}
export function requireMachineAccess(principal: MachinePrincipal): void {
  if (principal.kind === 'internal' || principal.kind === 'ticket-grant')
    throw new MachineAuthError(403, 'internal operator credential may only access operator routes')
}
export function createMachineAuth(options: {
  secret: string
  credentials: CredentialReader
  projects: ProjectRegistryReader
  store?: BuildStore | (() => Promise<BuildStore>)
  clock?: () => Date
}): MachineAuth {
  return {
    async authenticate(request) {
      const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')
      if (!match) throw new MachineAuthError(401, 'missing bearer credential')
      const token = match[1]!
      const now = (options.clock ?? (() => new Date()))()
      if (token.startsWith('abp_')) {
        let credential: CredentialMetadata | null
        try {
          credential = await options.credentials.authenticate(token, now)
        } catch (error) {
          if (error instanceof ProjectNotRegisteredError)
            throw new MachineAuthError(403, 'project not registered')
          throw error
        }
        if (!credential) throw new MachineAuthError(401, 'unknown or revoked credential')
        return { kind: 'project', repo: credential.repo, user: credential.createdBy, credential }
      }
      const scope = verifyToken(options.secret, token, now)
      if (scope && 'delegation' in scope) {
        const claims = scope.delegation
        if (!(await options.projects.has(claims.repo)))
          throw new MachineAuthError(403, 'project not registered')
        const store = typeof options.store === 'function' ? await options.store() : options.store
        if (!store || !(await delegationActive(store, claims, now)))
          throw new MachineAuthError(401, 'delegated credential ended or unavailable')
        return { kind: 'delegated', repo: claims.repo, user: 'delegated', delegation: claims }
      }
      if (scope && 'ownerAdmin' in scope) return { kind: 'admin', user: scope.ownerAdmin.user }
      if (scope && 'internalOperator' in scope) {
        if (!(await options.projects.has(scope.internalOperator.repo)))
          throw new MachineAuthError(403, 'project not registered')
        return {
          kind: 'internal',
          repo: scope.internalOperator.repo,
          user: scope.internalOperator.user,
          ...(scope.via ? { via: scope.via } : {}),
        }
      }
      throw new MachineAuthError(401, RETIRED_CREDENTIAL_MESSAGE)
    },
  }
}

export function requireProjectOwner(
  principal: MachinePrincipal,
): Extract<MachinePrincipal, { kind: 'project' }> {
  if (principal.kind !== 'project' || principal.credential.purpose !== 'project-owner')
    throw new MachineAuthError(403, 'project owner credential required')
  return principal
}
