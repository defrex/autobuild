import type { OrganizationStore } from '@defrex/autobuild-postgres-store/organizations'
import type { ProjectRegistryReader } from '@defrex/autobuild-postgres-store/projects'
import { HumanAccess } from '../web/access'
import type { WebEnv } from '../web/config'

/** Explicit super-user fixture; production never falls back to registry-wide access. */
export function testAccess(env: WebEnv, projects?: ProjectRegistryReader): HumanAccess {
  const unsupported = async (): Promise<never> => {
    throw new Error('unexpected management operation')
  }
  const store: OrganizationStore = {
    admitted: async () => false,
    materialize: async () => {},
    canAccess: async (actor, repo) => actor.isSuperUser() && !!(await projects?.has(repo)),
    projects: async (actor) =>
      actor.isSuperUser() ? ((await projects?.list()) ?? []).map((p) => p.repo) : [],
    organizations: async () => [],
    unassigned: unsupported,
    create: unsupported,
    inspect: unsupported,
    members: unsupported,
    addMember: unsupported,
    removeMember: unsupported,
    setOwner: unsupported,
    assign: unsupported,
  }
  return new HumanAccess(async () => store, env)
}
