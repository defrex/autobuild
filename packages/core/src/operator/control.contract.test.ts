import { describe, expect, test } from 'bun:test'
import { abBuildControl, type BuildControlAction } from '../cli/build-control'
import { abBulkControl } from '../cli/bulk-control'
import { agentActor, DISPATCHER, KERNEL } from '../events/envelope'
import type { EscalationSource } from '../ontology'
import type { Exec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import type { BuildStore } from '../store/types'
import {
  controlHarvestRun,
  setRepositorySetting,
  toggleHarvestGate,
  toggleRepositorySetting,
} from './control'
import { OperatorApiClient } from './client'
import type { OperatorAnswerRequest, OperatorBuildControlRequest } from './protocol'
import { createOperatorServer } from './server'
import { mintToken } from '../store/remote/token'

const REPO = '/repo'
const SLUG = 'contract-build'
const USER = 'contract-operator'
const SECRET = 'contract-secret'
const NOW = new Date('2026-09-02T00:00:00.000Z')
const clock = () => NOW
const noGit: Exec = async () => ({ stdout: '', stderr: 'not a git repo', exitCode: 128 })
const CONFORMING_SPEC = [
  '# Replacement',
  '',
  '## Acceptance criteria',
  '- The replacement is used.',
  '',
  '## Out of scope',
  '- Nothing else.',
  '',
].join('\n')

function fetchFor(server: { fetch(req: Request): Promise<Response> }): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    server.fetch(
      input instanceof Request ? new Request(input, init) : new Request(String(input), init),
    )) as typeof fetch
}

function api(store: BuildStore): OperatorApiClient {
  return new OperatorApiClient({
    url: 'http://operator.test',
    token: mintToken(SECRET, {
      operator: { user: USER },
      exp: NOW.getTime() + 60_000,
    }),
    fetchFn: fetchFor(createOperatorServer({ store, secret: SECRET, clock })),
  })
}

async function makeStore(
  opts: { active?: boolean; ticket?: boolean } = {},
): Promise<MemoryBuildStore> {
  const store = new MemoryBuildStore({ clock })
  await store.createBuild({
    slug: SLUG,
    repo: REPO,
    ...(opts.ticket ? { ticket: { source: 'linear', id: 'AUT-1' } } : {}),
  })
  if (opts.active !== false) {
    await store.append(SLUG, {
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: 'runner-1', host: 'host-1' },
    })
  }
  return store
}

async function raise(
  store: MemoryBuildStore,
  id = 'esc-1',
  source: EscalationSource = 'agent',
  refs?: string[],
): Promise<void> {
  await store.append(SLUG, {
    actor: source === 'agent' ? agentActor('implement', `session-${id}`) : KERNEL,
    type: 'escalation.raised',
    payload: {
      id,
      phase: 'implement',
      round: 1,
      source,
      ...(source === 'policy' ? { policyCause: 'phase-attempt-limit' as const } : {}),
      question: `Question ${id}?`,
      ...(refs === undefined ? {} : { refs }),
    },
  })
}

async function seedSpec(store: MemoryBuildStore): Promise<void> {
  const artifact = await store.putArtifact(SLUG, { kind: 'spec', content: 'old spec' })
  await store.append(SLUG, {
    actor: agentActor('spec', 'session-spec'),
    type: 'spec.authored',
    payload: { artifact: { kind: 'spec', rev: artifact.revision }, session: 'session-spec' },
  })
}

function writes(events: Awaited<ReturnType<BuildStore['getEvents']>>, since: number) {
  return events.slice(since).map(({ actor, type, payload }) => ({ actor, type, payload }))
}
function repoWrites(events: Awaited<ReturnType<BuildStore['getRepoEvents']>>, since: number) {
  return events.slice(since).map(({ actor, type, payload }) => ({ actor, type, payload }))
}

async function rejectedMessage(call: () => Promise<unknown>): Promise<string> {
  try {
    await call()
    throw new Error('expected operation to reject')
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function cliBuild(store: BuildStore, action: BuildControlAction) {
  return abBuildControl({
    targetRepo: REPO,
    env: { USER },
    exec: noGit,
    slug: SLUG,
    action,
    openStore: () => store,
  })
}

async function assertBuildParity(
  seed: (store: MemoryBuildStore) => Promise<void>,
  direct: (store: MemoryBuildStore) => Promise<unknown>,
  request: (client: OperatorApiClient) => Promise<unknown>,
): Promise<void> {
  const cliStore = await makeStore()
  const apiStore = await makeStore()
  await seed(cliStore)
  await seed(apiStore)
  const cliSince = (await cliStore.getEvents(SLUG)).length
  const apiSince = (await apiStore.getEvents(SLUG)).length
  await direct(cliStore)
  await request(api(apiStore))
  expect(writes(await apiStore.getEvents(SLUG), apiSince)).toEqual(
    writes(await cliStore.getEvents(SLUG), cliSince),
  )
}

describe('operator behavioral parity contract', () => {
  const buildCases: Array<{
    name: string
    seed: (store: MemoryBuildStore) => Promise<void>
    direct: BuildControlAction
    request: OperatorBuildControlRequest
  }> = [
    {
      name: 'pause',
      seed: async () => {},
      direct: { kind: 'pause' },
      request: { action: 'pause' },
    },
    {
      name: 'cancel pause',
      seed: async (store) => {
        await store.append(SLUG, {
          actor: { kind: 'human', user: 'earlier' },
          type: 'build.pause-requested',
          payload: {},
        })
      },
      direct: { kind: 'dashboard-pause' },
      request: { action: 'cancel-pause' },
    },
    {
      name: 'resume',
      seed: async (store) => {
        await store.append(SLUG, { actor: KERNEL, type: 'build.paused', payload: {} })
      },
      direct: { kind: 'resume' },
      request: { action: 'resume' },
    },
    {
      name: 'abort',
      seed: async () => {},
      direct: { kind: 'abort' },
      request: { action: 'abort' },
    },
    {
      name: 'auto merge on',
      seed: async () => {},
      direct: { kind: 'auto-merge-on' },
      request: { action: 'auto-merge-on' },
    },
    {
      name: 'auto merge off',
      seed: async () => {},
      direct: { kind: 'auto-merge-off' },
      request: { action: 'auto-merge-off' },
    },
  ]

  for (const item of buildCases) {
    test(`build control: ${item.name}`, async () => {
      await assertBuildParity(
        item.seed,
        (store) => cliBuild(store, item.direct),
        (client) => client.controlBuild(REPO, SLUG, item.request),
      )
    })
  }

  test('blocked resume returns answer-required and writes nothing on both surfaces', async () => {
    const stores = [await makeStore(), await makeStore()]
    for (const store of stores) await raise(store)
    const before = await Promise.all(
      stores.map((store) => store.getEvents(SLUG).then((e) => e.length)),
    )
    const direct = await cliBuild(stores[0]!, { kind: 'dashboard-resume' })
    const remote = await api(stores[1]!).controlBuild(REPO, SLUG, { action: 'resume' })
    expect(remote).toEqual(direct)
    expect((await stores[0]!.getEvents(SLUG)).length).toBe(before[0]!)
    expect((await stores[1]!.getEvents(SLUG)).length).toBe(before[1]!)
  })

  test('queued discard', async () => {
    const cliStore = await makeStore({ active: false })
    const apiStore = await makeStore({ active: false })
    await cliBuild(cliStore, { kind: 'discard' })
    await api(apiStore).controlBuild(REPO, SLUG, { action: 'discard' })
    expect(writes(await apiStore.getEvents(SLUG), 0)).toEqual(
      writes(await cliStore.getEvents(SLUG), 0),
    )
  })

  const answerCases: Array<{
    name: string
    seed: (store: MemoryBuildStore) => Promise<void>
    direct: BuildControlAction
    request: OperatorAnswerRequest
  }> = [
    {
      name: 'guidance',
      seed: (store) => raise(store),
      direct: { kind: 'answer', text: 'Take the safe path.' },
      request: { resolution: 'guidance', text: 'Take the safe path.' },
    },
    {
      name: 'bare retry',
      seed: (store) => raise(store),
      direct: { kind: 'answer' },
      request: { resolution: 'retry' },
    },
    {
      name: 'review-round ceiling',
      seed: async (store) => {
        await store.append(SLUG, {
          actor: KERNEL,
          type: 'escalation.raised',
          payload: {
            id: 'round-limit',
            phase: 'plan-review',
            round: 6,
            source: 'policy',
            policyCause: 'review-round-limit',
            question: 'round limit',
          },
        })
      },
      direct: { kind: 'answer', text: 'continue', reviewRoundCeiling: 12 },
      request: { resolution: 'review-round-ceiling', text: 'continue', ceiling: 12 },
    },
    {
      name: 'dismiss finding',
      seed: async (store) => {
        await store.append(SLUG, {
          actor: agentActor('code-review', 'review-1'),
          type: 'code-review.verdict',
          payload: {
            round: 1,
            verdict: 'revise',
            findings: [{ id: 'f-real', severity: 'blocking', summary: 'real issue', persists: [] }],
            artifact: { kind: 'code-review', rev: 0 },
          },
        })
        await raise(store, 'finding-escalation', 'stall', ['f-real'])
      },
      direct: { kind: 'answer', resolve: { kind: 'dismiss-finding' } },
      request: { resolution: 'dismiss' },
    },
    {
      name: 'spec revision from body',
      seed: async (store) => {
        await seedSpec(store)
        await raise(store)
      },
      direct: {
        kind: 'answer',
        resolve: {
          kind: 'revise-spec',
          body: {
            kind: 'supplied',
            origin: 'operator API body',
            read: async () => CONFORMING_SPEC,
          },
        },
      },
      request: { resolution: 'revise-spec', origin: 'body', body: CONFORMING_SPEC },
    },
  ]

  for (const item of answerCases) {
    test(`answer: ${item.name}`, async () => {
      await assertBuildParity(
        item.seed,
        (store) => cliBuild(store, item.direct),
        (client) => client.answer(REPO, SLUG, item.request),
      )
    })
  }

  test('answer: spec revision from ticket', async () => {
    const stores = [await makeStore({ ticket: true }), await makeStore({ ticket: true })]
    for (const store of stores) {
      await seedSpec(store)
      await raise(store)
    }
    const before = await Promise.all(
      stores.map((store) => store.getEvents(SLUG).then((e) => e.length)),
    )
    await abBuildControl({
      targetRepo: REPO,
      env: { USER },
      exec: noGit,
      slug: SLUG,
      action: { kind: 'answer', resolve: { kind: 'revise-spec', body: { kind: 'ticket' } } },
      readTicketBody: async () => CONFORMING_SPEC,
      openStore: () => stores[0]!,
    })
    await api(stores[1]!).answer(REPO, SLUG, {
      resolution: 'revise-spec',
      origin: 'ticket',
      body: CONFORMING_SPEC,
    })
    expect(writes(await stores[1]!.getEvents(SLUG), before[1]!)).toEqual(
      writes(await stores[0]!.getEvents(SLUG), before[0]!),
    )
    const artifacts = await Promise.all(stores.map((store) => store.getArtifact(SLUG, 'spec', 1)))
    expect(artifacts[1]?.content).toEqual(artifacts[0]?.content)
    expect(artifacts[1]?.meta.metadata).toEqual(artifacts[0]?.meta.metadata)
  })

  test('repository settings, toggles, and harvest gate', async () => {
    const operations = [
      async (store: MemoryBuildStore, throughApi: boolean) =>
        throughApi
          ? api(store).setIntake(REPO, false)
          : setRepositorySetting({
              store,
              repo: REPO,
              user: USER,
              setting: 'intake',
              enabled: false,
            }),
      async (store: MemoryBuildStore, throughApi: boolean) =>
        throughApi
          ? api(store).toggleIntake(REPO)
          : toggleRepositorySetting({ store, repo: REPO, user: USER, setting: 'intake' }),
      async (store: MemoryBuildStore, throughApi: boolean) =>
        throughApi
          ? api(store).setAutoMergeDefault(REPO, true)
          : setRepositorySetting({
              store,
              repo: REPO,
              user: USER,
              setting: 'auto-merge-default',
              enabled: true,
            }),
      async (store: MemoryBuildStore, throughApi: boolean) =>
        throughApi
          ? api(store).toggleAutoMergeDefault(REPO)
          : toggleRepositorySetting({
              store,
              repo: REPO,
              user: USER,
              setting: 'auto-merge-default',
            }),
      async (store: MemoryBuildStore, throughApi: boolean) => {
        if (throughApi) {
          await api(store).toggleHarvest(REPO)
          await api(store).toggleHarvest(REPO)
        } else {
          await toggleHarvestGate({ store, repo: REPO, user: USER })
          await toggleHarvestGate({ store, repo: REPO, user: USER })
        }
      },
    ]
    for (const operation of operations) {
      const cliStore = await makeStore()
      const apiStore = await makeStore()
      await operation(cliStore, false)
      await operation(apiStore, true)
      expect(repoWrites(await apiStore.getRepoEvents(REPO), 0)).toEqual(
        repoWrites(await cliStore.getRepoEvents(REPO), 0),
      )
    }
  })

  for (const direction of ['pause', 'resume'] as const) {
    test(`bulk ${direction}`, async () => {
      const cliStore = await makeStore()
      const apiStore = await makeStore()
      if (direction === 'resume') {
        for (const store of [cliStore, apiStore]) {
          await store.append(SLUG, { actor: KERNEL, type: 'build.paused', payload: {} })
        }
      }
      const cliBuildSince = (await cliStore.getEvents(SLUG)).length
      const apiBuildSince = (await apiStore.getEvents(SLUG)).length
      await abBulkControl({
        targetRepo: REPO,
        env: { USER },
        exec: noGit,
        direction,
        openStore: () => cliStore,
      })
      await api(apiStore).bulkControl(REPO, direction)
      expect(repoWrites(await apiStore.getRepoEvents(REPO), 0)).toEqual(
        repoWrites(await cliStore.getRepoEvents(REPO), 0),
      )
      expect(writes(await apiStore.getEvents(SLUG), apiBuildSince)).toEqual(
        writes(await cliStore.getEvents(SLUG), cliBuildSince),
      )
    })
  }

  test('concrete failed harvest run action', async () => {
    const stores = [await makeStore(), await makeStore()]
    for (const store of stores) {
      await store.ensureRepo(REPO)
      await store.appendRepo(REPO, {
        actor: KERNEL,
        type: 'harvest.started',
        payload: {
          run: 'harvest-1',
          observations: [{ build: SLUG, seq: 1 }],
          scan: { kind: 'harvest-scan', rev: 0 },
        },
      })
      await store.appendRepo(REPO, {
        actor: KERNEL,
        type: 'harvest.failed',
        payload: {
          run: 'harvest-1',
          step: 'scan',
          attempt: 1,
          error: 'network stopped',
          willRetry: false,
        },
      })
    }
    const before = await Promise.all(
      stores.map((store) => store.getRepoEvents(REPO).then((e) => e.length)),
    )
    await controlHarvestRun({ store: stores[0]!, repo: REPO, user: USER, run: 'harvest-1' })
    await api(stores[1]!).controlHarvestRun(REPO, 'harvest-1')
    expect(repoWrites(await stores[1]!.getRepoEvents(REPO), before[1]!)).toEqual(
      repoWrites(await stores[0]!.getRepoEvents(REPO), before[0]!),
    )
  })

  test('shared refusal messages survive HTTP for all guarded families', async () => {
    const cases: Array<{
      seed: (store: MemoryBuildStore) => Promise<void>
      direct: (store: MemoryBuildStore) => Promise<unknown>
      remote: (client: OperatorApiClient) => Promise<unknown>
    }> = [
      {
        seed: async () => {},
        direct: (store) => cliBuild(store, { kind: 'answer' }),
        remote: (client) => client.answer(REPO, SLUG, { resolution: 'retry' }),
      },
      {
        seed: (store) => raise(store),
        direct: (store) => cliBuild(store, { kind: 'answer', reviewRoundCeiling: 2 }),
        remote: (client) =>
          client.answer(REPO, SLUG, { resolution: 'review-round-ceiling', ceiling: 2 }),
      },
      {
        seed: async (store) => {
          await store.append(SLUG, {
            actor: DISPATCHER,
            type: 'build.completed',
            payload: { outcome: 'merged' },
          })
        },
        direct: (store) => cliBuild(store, { kind: 'pause' }),
        remote: (client) => client.controlBuild(REPO, SLUG, { action: 'pause' }),
      },
      {
        seed: async (store) => {
          await raise(store)
        },
        direct: (store) =>
          cliBuild(store, {
            kind: 'answer',
            reviewRoundCeiling: 2,
            resolve: {
              kind: 'revise-spec',
              body: { kind: 'supplied', origin: 'body', read: async () => CONFORMING_SPEC },
            },
          }),
        remote: (client) =>
          client.answer(REPO, SLUG, {
            resolution: 'revise-spec',
            origin: 'body',
            body: CONFORMING_SPEC,
            ceiling: 2,
          }),
      },
    ]
    for (const item of cases) {
      const stores = [await makeStore(), await makeStore()]
      await item.seed(stores[0]!)
      await item.seed(stores[1]!)
      const directError = await rejectedMessage(() => item.direct(stores[0]!))
      const apiError = await rejectedMessage(() => item.remote(api(stores[1]!)))
      expect(apiError).toBe(directError)
    }

    const staleStores = [await makeStore(), await makeStore()]
    const directStale = await rejectedMessage(() =>
      controlHarvestRun({
        store: staleStores[0]!,
        repo: REPO,
        user: USER,
        run: 'gone',
      }),
    )
    const apiStale = await rejectedMessage(() =>
      api(staleStores[1]!).controlHarvestRun(REPO, 'gone'),
    )
    expect(apiStale).toBe(directStale)
  })
})
