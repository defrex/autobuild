import { MemoryTicketPolicyStore } from '@defrex/autobuild-postgres-store/ticket-policy'
import { expect, test } from 'bun:test'
import { MemoryBuildStore, FakeTicketSource } from '@defrex/autobuild/plugin-sdk'
import { DISPATCHER, parseConfig } from '@defrex/autobuild/testing'
import { HostedTicketSource } from '@defrex/autobuild/hosted-tickets'
import { mintToken } from '@defrex/autobuild/remote-store'
import { createHostedStoreService } from './service'
import { testProjects } from './testing/projects'
import { OperatorApiClient } from './operator-client'

const repos = ['https://github.com/acme/one', 'https://github.com/acme/two']
const env = {
  AB_STORE_SECRET: 'secret',
  AB_POSTGRES_URL: 'postgres://unused/test',
  AB_BLOB_BACKEND: 's3',
  AB_S3_BUCKET: 'unused',
  AB_S3_REGION: 'us-east-1',
  AB_S3_ACCESS_KEY_ID: 'unused',
  AB_S3_SECRET_ACCESS_KEY: 'unused',
}
async function publish(store: MemoryBuildStore, repo: string, source = 'hosted') {
  await store.ensureRepo(repo)
  const config = parseConfig(
    `[tickets]\nsource = "${source}"\n${source === 'file' ? '' : 'teamKey = "SAME"\n'}readyState = "Todo"\ndoneState = "Complete"\n[verify]\nsteps = []\n[finalize]\nsteps = []`,
  )
  const { verify, finalize, ...root } = config
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
      run: `run-${crypto.randomUUID()}`,
      pid: 1,
      effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
      roleWarnings: [],
    },
  })
}
async function setup(extra: Record<string, string | undefined> = {}, publishConfigs = true) {
  const store = new MemoryBuildStore()
  if (publishConfigs) for (const repo of repos) await publish(store, repo)
  const sources = new Map(repos.map((repo) => [repo, new FakeTicketSource()]))
  const diagnostics: string[] = []
  const contexts: unknown[] = []
  const service = createHostedStoreService({
    openTicketPolicy: async () => new MemoryTicketPolicyStore(),
    env: { ...env, ...extra },
    diagnostic: (message) => diagnostics.push(message),
    openStore: async () => store,
    openProjectRegistry: async () => testProjects(repos),
    openCredentials: async () => ({
      authenticate: async (token) => {
        const index = ['abp_one', 'abp_two'].indexOf(token)
        return index < 0
          ? null
          : {
              id: token,
              repo: repos[index]!,
              createdBy: 'fixture',
              createdAt: new Date().toISOString(),
              lastUsedAt: null,
              revokedAt: null,
              expiresAt: null,
              purpose: 'project-owner' as const,
            }
      },
    }),
    sourceFor: (context) => {
      contexts.push(context)
      return sources.get(context.repo)!
    },
  })
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) =>
    service.fetch(new Request(input, init))
  const client = (token: string, repo?: string) =>
    new HostedTicketSource({
      url: 'http://test',
      token,
      teamKey: 'FORGED',
      claimedState: 'FORGED',
      createState: 'FORGED',
      ...(repo ? { repo } : {}),
      fetchFn,
    })
  return { store, sources, diagnostics, contexts, service, fetchFn, client }
}

test('machine ticket authority is credential-derived; admin selection is explicit', async () => {
  const world = await setup()
  const one = world.client('abp_one'),
    two = world.client('abp_two')
  const first = await one.create({ title: 'First', body: 'Body' }, { idempotencyKey: 'same' })
  expect((await one.get(first.ref.id))?.title).toBe('First')
  expect(await two.get(first.ref.id)).toBeNull()
  await expect(two.comment(first.ref.id, 'foreign')).rejects.toThrow()
  await expect(world.client('abp_one', repos[1]).listReady({})).rejects.toThrow('wrong project')
  expect(world.contexts[0]).toMatchObject({
    repo: repos[0],
    teamKey: 'SAME',
    tickets: { source: 'hosted', doneState: 'Complete' },
  })
  const admin = mintToken(env.AB_STORE_SECRET, {
    version: 1,
    ownerAdmin: { user: 'owner' },
    exp: Date.now() + 60000,
  })
  await expect(world.client(admin).listReady({})).rejects.toThrow('context.repo')
  expect((await world.client(admin, repos[0]).get(first.ref.id))?.title).toBe('First')
})

test('external source and missing effective configuration refuse machine and operator reads', async () => {
  const world = await setup()
  for (const source of ['linear', 'file']) {
    await publish(world.store, repos[0]!, source)
    await expect(world.client('abp_one').listReady({})).rejects.toThrow(
      `own "${source}" ticket source`,
    )
    const client = new OperatorApiClient({
      url: 'http://test',
      token: 'abp_one',
      fetchFn: world.fetchFn as typeof fetch,
    })
    await expect(client.listTickets(repos[0]!)).rejects.toThrow(`own "${source}" ticket source`)
  }
})

test('retired settings boot and emit one safe diagnostic at composition, before requests', async () => {
  for (const extra of [
    { AB_TICKET_BACKEND: 'linear', LINEAR_API_KEY: 'never-print-me' },
    { AB_TICKET_BACKEND: 'database' },
    { AB_TICKET_BACKEND: 'linear' },
    { LINEAR_API_KEY: 'never-print-me' },
    { AB_TICKET_BACKEND: '', LINEAR_API_KEY: '' },
    { AB_TICKET_BACKEND: 'unknown' },
    { AB_TICKET_BACKEND: '' },
    { LINEAR_API_KEY: '' },
  ]) {
    const world = await setup({ ...extra, AB_TICKET_READY_STATE: ' ', AB_TICKET_DONE_STATE: '' })
    expect(world.diagnostics).toHaveLength(1)
    expect(world.diagnostics[0]).toContain('no longer contacts Linear')
    expect(world.diagnostics[0]).not.toContain('never-print-me')
    await world.client('abp_one').listReady({})
    await world.client('abp_one').listReady({})
    expect(world.diagnostics).toHaveLength(1)
  }
  expect((await setup()).diagnostics).toEqual([])
})

test('missing project configuration refuses before source construction with no team or environment fallback', async () => {
  const world = await setup({}, false)
  await expect(world.client('abp_one').listReady({})).rejects.toThrow(
    'effective config unavailable',
  )
  expect(world.contexts).toEqual([])
  const admin = mintToken(env.AB_STORE_SECRET, {
    version: 1,
    ownerAdmin: { user: 'owner' },
    exp: Date.now() + 60000,
  })
  await expect(
    world.client(admin, 'https://github.com/acme/unregistered').listReady({}),
  ).rejects.toThrow('project not registered')
  await expect(world.client(admin, '/tmp/wrong').listReady({})).rejects.toThrow('context.repo')
  expect(world.contexts).toEqual([])
})
