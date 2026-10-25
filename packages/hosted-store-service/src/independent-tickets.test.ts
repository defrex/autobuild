import { temporaryDirectories as ownTempDirectories } from '@defrex/autobuild/testing'
import { afterEach, expect, test } from 'bun:test'
import {
  MemoryBuildStore,
  FakeTicketSource,
  ScriptedAgentRunner,
} from '@defrex/autobuild/plugin-sdk'
import { MemoryTicketPolicyStore } from '@defrex/autobuild-postgres-store/ticket-policy'
import { HostedTicketSource } from '@defrex/autobuild/hosted-tickets'
import { createHostedStoreService } from './service'
import { testProjects } from './testing/projects'
import { testCredentials } from './testing/credentials'
import { OperatorApiClient } from './operator-client'

const repo = 'https://github.com/acme/local-builds'
const env = {
  AB_STORE_SECRET: 'secret',
  AB_POSTGRES_URL: 'postgres://unused/test',
  AB_BLOB_BACKEND: 's3',
  AB_S3_BUCKET: 'unused',
  AB_S3_REGION: 'us-east-1',
  AB_S3_ACCESS_KEY_ID: 'unused',
  AB_S3_SECRET_ACCESS_KEY: 'unused',
}

test('tickets and operator tools work before dispatch without service build history', async () => {
  const store = new MemoryBuildStore()
  const projects = testProjects([repo])
  const credentials = testCredentials(projects, 'secret').store
  const { token } = await credentials.issue(repo, 'owner')
  const policies = new MemoryTicketPolicyStore()
  const backend = new FakeTicketSource()
  const contexts: string[] = []
  const service = createHostedStoreService({
    env,
    openStore: async () => store,
    openProjectRegistry: async () => projects,
    openCredentials: async () => credentials,
    openTicketPolicy: async () => policies,
    sourceFor: (context) => {
      contexts.push(context.tickets.doneState!)
      return backend
    },
  })
  const server = Bun.serve({ port: 0, fetch: service.fetch })
  const client = new HostedTicketSource({ url: server.url.href, token, repo, teamKey: 'ENG' })
  try {
    await client.synchronizePolicy({
      version: 1,
      tickets: {
        source: 'hosted',
        teamKey: 'ENG',
        triageState: 'triage',
        readyState: 'ready',
        claimedState: 'doing',
        doneState: 'done',
        createState: 'triage',
        proposalState: 'triage',
      },
    })
    const ticket = await client.create(
      { title: 'Independent', body: 'Spec' },
      { state: 'triage', idempotencyKey: 'once' },
    )
    expect(
      (await client.create({ title: 'Retry', body: 'Spec' }, { idempotencyKey: 'once' })).ref.id,
    ).toBe(ticket.ref.id)
    await client.update(ticket.ref.id, { body: 'Updated' })
    await client.comment(ticket.ref.id, 'Comment')
    await client.transition(ticket.ref.id, 'ready')
    expect(await client.claim(ticket.ref.id)).toBe(true)
    expect((await client.get(ticket.ref.id))?.body).toBe('Updated')
    expect((await client.listStates()).map((state) => state.name)).toEqual([
      'triage',
      'ready',
      'doing',
      'done',
    ])
    const operator = new OperatorApiClient({ url: server.url.href, token })
    expect(await store.listBuilds()).toEqual([])
    expect(await store.getRepo(repo)).toBeNull()
    expect(contexts.every((state) => state === 'done')).toBe(true)
    expect((await operator.getTicket(repo, ticket.ref.id)).build).toBeNull()
    expect((await operator.listTickets(repo, { state: 'Doing' })).readyState).toBe('ready')
  } finally {
    server.stop(true)
    await store.close()
  }
})

import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HarvestRunner,
  parseConfig,
  sequentialIds,
  randomUuids,
  steppingClock,
  agentActor,
  buildHarvestContext,
  submitHarvestProposals,
  submitHarvestVerdict,
} from '@defrex/autobuild/testing'

const mkdtemp = ownTempDirectories(afterEach)

test('a local harvest files proposals and origin blockers through read/create ticket authority only', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'independent-harvest-'))
  const store = new MemoryBuildStore()
  const serviceStore = new MemoryBuildStore()
  const backend = new FakeTicketSource(
    [
      {
        revision: 'fixture-revision',
        ref: { source: 'hosted', id: 'origin' },
        title: 'Origin',
        body: 'Spec',
        state: 'doing',
        resolved: false,
        labels: [],
      },
    ],
    { createState: 'triage', doneState: 'done' },
  )
  const policies = new MemoryTicketPolicyStore()
  await policies.put(
    repo,
    {
      version: 1,
      tickets: {
        source: 'hosted',
        teamKey: 'ENG',
        triageState: 'triage',
        readyState: 'ready',
        claimedState: 'doing',
        doneState: 'done',
        createState: 'triage',
        proposalState: 'triage',
      },
    },
    'owner',
  )
  const grant = {
    id: 'runner',
    repo,
    execution: 'execution',
    kind: 'runner' as const,
    parent: null,
    expiresAt: '2099-01-01T00:00:00Z',
  }
  const paths: string[] = []
  const service = createHostedStoreService({
    env,
    openStore: async () => serviceStore,
    openProjectRegistry: async () => testProjects([repo]),
    openCredentials: async () => ({ authenticate: async () => null }),
    openTicketPolicy: async () => policies,
    sourceFor: () => backend,
    openTicketGrants: async () => ({
      authenticate: async (token) => (token === 'abt_runner' ? grant : null),
      issue: async () => {
        throw new Error('no agent turn expected')
      },
      revoke: async () => {},
      renew: async () => {},
    }),
  })
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      paths.push(new URL(request.url).pathname)
      return service.fetch(request)
    },
  })
  const tickets = new HostedTicketSource({
    url: server.url.origin,
    token: 'abt_runner',
    teamKey: 'ENG',
  })
  const ids = sequentialIds()
  const config = parseConfig(
    '[tickets]\nsource = "hosted"\nteamKey = "ENG"\n[roles.default]\nruntime = "scripted"\n[policy]\nharvestThreshold = 1',
  )
  const deps = {
    store,
    tickets,
    config,
    runtimes: {
      scripted: {
        runner: new ScriptedAgentRunner({
          script: async () => {
            throw new Error('no agent turn expected')
          },
        }),
        servesModels: [''],
      },
    },
    repo,
    workspacePath: workspace,
    ids,
    uuids: randomUuids(),
    clock: steppingClock(),
    instance: 'execution',
  }
  try {
    await store.createBuild({ slug: 'source', repo, ticket: { source: 'hosted', id: 'origin' } })
    await store.append('source', {
      actor: agentActor('implement', 'old'),
      type: 'observation.recorded',
      payload: { id: 'observation', kind: 'latent-bug', summary: 'A defect to harvest' },
    })
    const prepared = await new HarvestRunner(deps).run(true)
    if (prepared.outcome !== 'prepared') throw new Error('expected prepared local harvest')
    const phaseEnv = {
      store: 'local',
      repo,
      run: prepared.run,
      phase: 'synthesize' as const,
      round: 1,
      session: 'producer',
    }
    await buildHarvestContext({ store, workspacePath: workspace, ids, env: phaseEnv })
    const proposalPath = join(workspace, '.ab', 'proposal.json')
    await writeFile(
      proposalPath,
      JSON.stringify({
        proposals: [
          {
            action: 'create',
            title: 'Harvested defect',
            whatWhy: 'Fix the observed defect.',
            acceptanceCriteria: ['The defect no longer occurs.'],
            outOfScope: ['Unrelated changes.'],
            observations: [{ build: 'source', seq: 1 }],
          },
        ],
      }),
    )
    await submitHarvestProposals(
      { store, workspacePath: workspace, ids, env: phaseEnv },
      proposalPath,
    )
    const notes = join(workspace, '.ab', 'review.md')
    await writeFile(notes, 'Approved')
    await submitHarvestVerdict(
      {
        store,
        workspacePath: workspace,
        ids,
        env: { ...phaseEnv, phase: 'review', session: 'reviewer' },
      },
      { verdict: 'approve', notes },
    )
    expect((await new HarvestRunner(deps).run()).outcome).toBe('completed')
    const filed = (await tickets.listReady({ state: 'triage' })).tickets
    expect(filed).toHaveLength(1)
    expect(filed[0]?.blockedBy).toEqual(['origin'])
    expect(backend.claims).toEqual([])
    expect(backend.transitions).toEqual([])
    expect(backend.blockerAdds).toEqual([])
    expect(
      paths.every((path) =>
        [
          '/tickets/get',
          '/tickets/list-ready',
          '/tickets/dependency-states',
          '/tickets/create',
        ].includes(path),
      ),
    ).toBe(true)
    expect(await serviceStore.listBuilds()).toEqual([])
    expect(await serviceStore.getRepo(repo)).toBeNull()
    expect((await store.getRepoEvents(repo)).length).toBeGreaterThan(0)
  } finally {
    server.stop(true)
    await store.close()
    await serviceStore.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('policy publication uses named config existence, preserves decode errors and resets on run rollover', async () => {
  const { parseConfig, DISPATCHER } = await import('@defrex/autobuild/testing')
  const policy = {
    version: 1 as const,
    tickets: {
      source: 'hosted' as const,
      teamKey: 'ENG',
      triageState: 'Inbox',
      readyState: 'Ready',
      claimedState: 'Active',
      doneState: 'Done',
      createState: 'Inbox',
      proposalState: 'Inbox',
    },
  }
  for (const scenario of [
    'no-repo',
    'no-run',
    'missing-artifact',
    'invalid-artifact',
    'valid',
    'rollover',
    'prior-policy',
  ]) {
    const store = new MemoryBuildStore()
    const projects = testProjects([repo])
    const credentials = testCredentials(projects, 'secret').store
    const { token } = await credentials.issue(repo, 'owner')
    const policies = new MemoryTicketPolicyStore()
    if (scenario === 'prior-policy') await policies.put(repo, policy, 'owner')
    if (scenario !== 'no-repo' && scenario !== 'prior-policy') await store.ensureRepo(repo)
    if (['missing-artifact', 'invalid-artifact', 'valid', 'rollover'].includes(scenario)) {
      let reference: { kind: string; rev: number } | undefined
      if (scenario === 'missing-artifact')
        reference = { kind: 'dispatcher-effective-config', rev: 99 }
      if (['invalid-artifact', 'valid', 'rollover'].includes(scenario)) {
        const { verify, finalize, ...config } = parseConfig(
          '[tickets]\nsource="hosted"\nteamKey="ENG"\n[verify]\nsteps=[]\n[finalize]\nsteps=[]',
        )
        const artifact = await store.putRepoArtifact(repo, {
          kind: 'dispatcher-effective-config',
          content:
            scenario === 'invalid-artifact'
              ? 'invalid JSON'
              : JSON.stringify({
                  ...config,
                  verify: { steps: verify.steps },
                  finalize: { steps: finalize.steps },
                }),
        })
        reference = { kind: artifact.kind, rev: artifact.revision }
      }
      await store.appendRepo(repo, {
        actor: DISPATCHER,
        type: 'dispatcher.run-started',
        payload: { run: 'first', pid: 1, roleWarnings: [], effectiveConfig: reference! },
      })
      if (scenario === 'rollover')
        await store.appendRepo(repo, {
          actor: DISPATCHER,
          type: 'dispatcher.run-started',
          payload: {
            run: 'second',
            pid: 2,
            roleWarnings: [],
            effectiveConfig: { kind: 'new-run-config', rev: 0 },
          },
        })
    }
    store.getRepoEvents = async () => {
      throw new Error('raw journal reads are forbidden')
    }
    store.getRepoStateEvents = async () => {
      throw new Error('raw state reads are forbidden')
    }
    const service = createHostedStoreService({
      env,
      openStore: async () => store,
      openProjectRegistry: async () => projects,
      openCredentials: async () => credentials,
      openTicketPolicy: async () => policies,
      sourceFor: () => new FakeTicketSource(),
    })
    const fetchFn = async (input: string | URL | Request, init?: RequestInit) =>
      service.fetch(new Request(input, init))
    const client = new HostedTicketSource({
      url: 'http://test',
      token,
      repo,
      teamKey: 'ENG',
      fetchFn,
    })
    if (scenario === 'missing-artifact' || scenario === 'rollover')
      await expect(client.synchronizePolicy(policy)).rejects.toThrow('not retrievable')
    else if (scenario === 'invalid-artifact')
      await expect(client.synchronizePolicy(policy)).rejects.toThrow()
    else await client.synchronizePolicy(policy)
    await store.close()
  }
})
