import { MemoryTicketPolicyStore } from '@defrex/autobuild-postgres-store/ticket-policy'
import { MemoryBuildStore } from '@defrex/autobuild/plugin-sdk'
import { DISPATCHER, parseConfig } from '@defrex/autobuild/testing'
import { testProjects } from './projects'
import { testCredentials } from './credentials'

/** A registered hosted project with durable configuration and a project token. */
export async function ticketProject(repo: string, secret: string, clock = () => new Date()) {
  const store = new MemoryBuildStore({ clock })
  const projects = testProjects([repo])
  const credentials = testCredentials(projects, secret, clock).store
  const { token } = await credentials.issue(repo, 'fixture')
  const config = parseConfig(
    '[tickets]\nsource = "hosted"\nteamKey = "ENG"\nreadyState = "Ready"\n[verify]\nsteps = []\n[finalize]\nsteps = []',
  )
  const { verify, finalize, ...root } = config
  await store.ensureRepo(repo)
  const artifact = await store.putRepoArtifact(repo, {
    kind: 'dispatcher-effective-config',
    content: JSON.stringify({
      ...root,
      verify: { steps: verify.steps },
      finalize: { steps: finalize.steps },
    }),
  })
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.run-started',
    payload: {
      run: 'fixture',
      pid: 1,
      effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
      roleWarnings: [],
    },
  })
  return {
    store,
    projects,
    credentials,
    token,
    openTicketPolicy: async () => new MemoryTicketPolicyStore(),
    openStore: async () => store,
    openProjectRegistry: async () => projects,
    openCredentials: async () => credentials,
  }
}
