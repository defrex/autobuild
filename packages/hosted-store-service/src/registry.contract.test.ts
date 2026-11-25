import { temporaryDirectories as ownTempDirectories } from '@defrex/autobuild/testing'
import { testProjects } from './testing/projects'
import { afterEach, describe, expect, test } from 'bun:test'
import { parseConfig } from '@defrex/autobuild/testing'
import { DISPATCHER, KERNEL, humanActor } from '@defrex/autobuild/testing'
import { FakeTicketSource } from '@defrex/autobuild/plugin-sdk'
import { MemoryBuildStore } from '@defrex/autobuild/plugin-sdk'
import { mintToken } from '@defrex/autobuild/remote-store'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '@defrex/autobuild/remote-store'
import { OPERATOR_TOOL_ANNOTATIONS } from '@defrex/autobuild/operator'
import {
  buildRegistry,
  operatorToolTable,
  RegistryError,
  SandboxUnavailableError,
  TOOLS,
} from '@defrex/autobuild/operator'
import { createOperatorServer } from './operator-server'
import type { BuildStore } from '@defrex/autobuild/plugin-sdk'
import type { OperatorTicketBackend } from '@defrex/autobuild/operator'

const _mkdtemp = ownTempDirectories(afterEach)

const now = new Date('2026-09-02T00:00:00.000Z')
const clock = () => now
const secret = 'registry-contract-secret'
const repo = 'acme/widgets'

const CONFIG = parseConfig(`
capacity = 2
[tickets]
source = "hosted"
teamKey = "AUT"
triageState = "Backlog"
readyState = "Todo"
[verify]
steps = []
[finalize]
steps = []
`)

const TICKET_STATES = ['Backlog', 'Todo', 'Done']
const CONFORMING_SPEC =
  '# Replacement\n\n## Acceptance criteria\n\n- [ ] works\n\n## Out of scope\n\n- nothing\n'

interface World {
  store: MemoryBuildStore
  source: FakeTicketSource
  backend: OperatorTicketBackend
}

/** A clean running build with a pending pause (display "pausing"): the
 * cancel-pause and pause-pending-state parity cases need a build whose
 * lifecycle is running — the seeded "demo" build is blocked by its open
 * escalation, and effectiveStatus projects blocked over pausing. */
async function seedPausing(): Promise<World> {
  const world = await seedWorld()
  await world.store.createBuild({
    slug: 'pausing-b',
    repo,
    ticket: { source: 'fake', id: 'AUT-3' },
  })
  await world.store.append('pausing-b', {
    actor: DISPATCHER,
    type: 'build.created',
    payload: { ticket: { source: 'fake', id: 'AUT-3' }, repo, baseBranch: 'main' },
  })
  await world.store.append('pausing-b', {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'runner-2', host: 'host-2' },
  })
  await world.store.append('pausing-b', {
    actor: humanActor('earlier'),
    type: 'build.pause-requested',
    payload: {},
  })
  return world
}

/** One seeded world: config published, a running build with an open
 * escalation, a queued build, artifact revisions, and ticket-source seeds. */
async function seedWorld(): Promise<World> {
  const store = new MemoryBuildStore({ clock })
  const source = new FakeTicketSource(
    [
      {
        revision: 'fixture',
        ref: { source: 'fake', id: 'AUT-1', title: 'Seeded ticket' },
        title: 'Seeded ticket',
        body: 'seed body',
        state: 'Todo',
        resolved: false,
        labels: ['web'],
      },
      {
        revision: 'fixture',
        ref: { source: 'fake', id: 'AUT-2', title: 'Queued ticket' },
        title: 'Queued ticket',
        body: 'queued body',
        state: 'Backlog',
        resolved: false,
        labels: [],
      },
    ],
    { createState: 'Backlog', doneState: 'Done' },
  )
  Object.assign(source, {
    listStates: async () => TICKET_STATES.map((name) => ({ name, tickets: 0 })),
  })
  const backend: OperatorTicketBackend = {
    sourceFor: async () => source,
    statesFor: async () => TICKET_STATES,
  }
  await store.ensureRepo(repo)
  const { verify, finalize, ...root } = CONFIG
  const artifact = await store.putRepoArtifact(repo, {
    kind: 'dispatcher-effective-config',
    content: JSON.stringify({
      ...root,
      verify: { steps: verify.steps, ...verify.stepConfigs },
      finalize: { steps: finalize.steps, ...finalize.stepConfigs },
    }),
  })
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.run-started',
    payload: {
      run: 'dispatch-1',
      pid: 123,
      effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
      roleWarnings: [],
    },
  })
  await store.createBuild({ slug: 'demo', repo, ticket: { source: 'fake', id: 'AUT-1' } })
  await store.append('demo', {
    actor: DISPATCHER,
    type: 'build.created',
    payload: { ticket: { source: 'fake', id: 'AUT-1' }, repo, baseBranch: 'main' },
  })
  await store.append('demo', {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'runner-1', host: 'host-1' },
  })
  await store.append('demo', {
    actor: { kind: 'agent', role: 'implement', session: 's1' },
    type: 'escalation.raised',
    payload: {
      id: 'esc-1',
      phase: 'implement',
      round: 1,
      source: 'agent',
      question: 'which cut?',
      refs: [],
    },
  })
  await store.createBuild({ slug: 'queued-b', repo, ticket: { source: 'fake', id: 'AUT-2' } })
  await store.append('queued-b', {
    actor: DISPATCHER,
    type: 'build.created',
    payload: { ticket: { source: 'fake', id: 'AUT-2' }, repo, baseBranch: 'main' },
  })
  await store.putArtifact('demo', { kind: 'notes', content: 'revision zero' })
  await store.putArtifact('demo', { kind: 'notes', content: new Uint8Array([0, 1, 255, 128]) })
  return { store, source, backend }
}

const TOKEN = mintToken(secret, {
  version: 1,
  internalOperator: { user: 'Ada', repo },
  exp: now.getTime() + 60_000,
})

type ApiResult = { status: number; headers: Headers; body: object; bytes: Uint8Array }

function api(server: { fetch(req: Request): Promise<Response> }) {
  return async (method: string, path: string, body?: unknown): Promise<ApiResult> => {
    const response = await server.fetch(
      new Request(`http://operator.test${path}`, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        headers: {
          authorization: `Bearer ${TOKEN}`,
          [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
      }),
    )
    const bytes = new Uint8Array(await response.arrayBuffer())
    const text = new TextDecoder().decode(bytes)
    let parsed: object
    try {
      parsed = JSON.parse(text) as object
    } catch {
      // Binary route bodies (artifact downloads) stay bytes.
      parsed = text as unknown as object
    }
    return { status: response.status, headers: response.headers, body: parsed, bytes }
  }
}

/** Tool caller against one world, attributed as the route's operator token
 * (the token carries no via claim, so neither does the tool call). */
function toolFor(world: World) {
  const registry = buildRegistry({
    store: world.store,
    tickets: world.backend,
    clock,
  })
  return async (name: string, input: unknown): Promise<object> =>
    (await registry.call(name, input, { identity: 'Ada' })) as object
}

/** Tool failures surface as RegistryError; return the mapped failure body. */
async function toolFailure(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const error = await run().catch((caught) => caught)
  expect(error).toBeInstanceOf(RegistryError)
  return (error as RegistryError).body as unknown as Record<string, unknown>
}

/** Bun's expect().toEqual() overloads infer the expected type from the actual
 * value; every comparison here is between two unknowns, so one helper keeps
 * the contract assertions type-honest without per-site casts. */
function expectEqual(actual: unknown, expected: unknown): void {
  expect(actual).toEqual(expected)
}

/** Every successful tool result must be JSON-round-trip clean: a binding's
 * JSON.stringify can never silently corrupt bytes (registry invariant). */
function expectJsonClean(value: unknown): void {
  expectEqual(JSON.parse(JSON.stringify(value)), value)
}

describe('agent tool registry contract', () => {
  test('the table is closed: exactly the checked-in annotation names', () => {
    expectEqual(
      [...TOOLS].map((tool) => tool.name as string).sort(),
      Object.keys(OPERATOR_TOOL_ANNOTATIONS).sort(),
    )
    for (const tool of TOOLS) {
      const table = OPERATOR_TOOL_ANNOTATIONS[tool.name]
      expectEqual(tool.annotations, {
        readOnlyHint: table.readOnlyHint,
        destructiveHint: table.destructiveHint,
        idempotentHint: table.idempotentHint,
      })
      expect(tool.approval).toBe(table.approval)
      // Every input field is documented for the model.
      const described = tool.description.length > 0 && tool.outputDescription.length > 0
      expect(described).toBe(true)
    }
    expect(OPERATOR_TOOL_ANNOTATIONS['tickets.asset.remove'].destructiveHint).toBe(true)
  })

  test('builds.list matches the builds route for every scope', async () => {
    const world = await seedWorld()
    const server = createOperatorServer({
      projects: testProjects([repo]),
      store: world.store,
      secret,
      clock,
    })
    const call = api(server)
    const runTool = toolFor(world)
    for (const scope of ['active', 'queued', 'all', undefined]) {
      const route = await call(
        'GET',
        `/operator/v1/repos/${encodeURIComponent(repo)}/builds${scope === undefined ? '' : `?scope=${scope}`}`,
      )
      const tool = await runTool('builds.list', {
        repo,
        ...(scope !== undefined ? { scope } : {}),
      })
      expectEqual(tool, route.body)
      expectJsonClean(tool)
    }
  })

  test('builds.get matches the build detail route', async () => {
    const world = await seedWorld()
    const server = createOperatorServer({
      projects: testProjects([repo]),
      store: world.store,
      secret,
      clock,
    })
    const call = api(server)
    const tool = (await toolFor(world)('builds.get', { repo, slug: 'demo' })) as object
    const route = await call('GET', `/operator/v1/repos/${encodeURIComponent(repo)}/builds/demo`)
    expectEqual(tool, route.body)
    expectJsonClean(tool)
  })

  test('builds.artifact parity: decoded bytes equal the route body and its artifact headers', async () => {
    const world = await seedWorld()
    const server = createOperatorServer({
      projects: testProjects([repo]),
      store: world.store,
      secret,
      clock,
    })
    const call = api(server)
    const tool = (await toolFor(world)('builds.artifact', {
      repo,
      slug: 'demo',
      kind: 'notes',
    })) as { meta: Record<string, unknown>; contentBase64: string }
    const route = await call(
      'GET',
      `/operator/v1/repos/${encodeURIComponent(repo)}/builds/demo/artifacts/notes`,
    )
    expectEqual(
      Buffer.from(tool.contentBase64, 'base64').toString('hex'),
      Buffer.from(route.bytes).toString('hex'),
    )
    expect(tool.meta.kind).toBe(route.headers.get('x-autobuild-artifact-kind') ?? '')
    expect(String(tool.meta.revision)).toBe(
      route.headers.get('x-autobuild-artifact-revision') ?? '',
    )
    expect(tool.meta.blobRef).toBe(route.headers.get('x-autobuild-artifact-blob-ref') ?? '')
    // An exact revision selects the exact bytes, binary-safe.
    const zero = (await toolFor(world)('builds.artifact', {
      repo,
      slug: 'demo',
      kind: 'notes',
      rev: 0,
    })) as { meta: Record<string, unknown>; contentBase64: string }
    expect(new TextDecoder().decode(Buffer.from(zero.contentBase64, 'base64'))).toBe(
      'revision zero',
    )
  })

  test('builds.restack shares HTTP validation, durable receipt and repository isolation', async () => {
    const world = await seedWorld()
    await world.store.createBuild({ slug: 'node', repo, branch: 'ab-node/node' })
    await world.store.append('node', {
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        repo,
        ticket: { source: 'fake', id: 'NODE' },
        kind: 'node',
        baseBranch: 'main',
      },
    })
    await world.store.append('node', {
      actor: DISPATCHER,
      type: 'node.opened',
      payload: { sha: 'a'.repeat(40) },
    })
    const server = createOperatorServer({
      projects: testProjects([repo]),
      store: world.store,
      secret,
      clock,
    })
    const route = await api(server)(
      'POST',
      `/operator/v1/repos/${encodeURIComponent(repo)}/builds/node/restack`,
    )
    expect(route.status).toBe(200)
    const tool = (await toolFor(world)('builds.restack', { repo, slug: 'node' })) as {
      request: unknown
      coalesced: boolean
    }
    expect(tool.coalesced).toBe(true)
    expectEqual(tool.request, (route.body as { request: unknown }).request)
    const refusal = await api(server)(
      'POST',
      `/operator/v1/repos/${encodeURIComponent(repo)}/builds/demo/restack`,
    )
    expect(refusal.status).toBe(409)
    const error = await toolFor(world)('builds.restack', { repo, slug: 'demo' }).catch(
      (error) => error,
    )
    expectEqual((error as RegistryError).body, refusal.body)
    const missing = await api(server)(
      'POST',
      `/operator/v1/repos/${encodeURIComponent(repo)}/builds/missing/restack`,
    )
    expect(missing.status).toBe(404)
  })

  test('optimization.revise records a revision and refuses builds without an objective', async () => {
    const world = await seedWorld()
    await world.store.createBuild({ slug: 'opt', repo, branch: 'ab-node/opt' })
    await world.store.append('opt', {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { repo, ticket: { source: 'fake', id: 'OPT' }, kind: 'node', baseBranch: 'main' },
    })
    await world.store.append('opt', {
      actor: DISPATCHER,
      type: 'optimization.objective-accepted',
      payload: {
        objective: {
          purpose: 'faster',
          metric: {
            kind: 'command',
            command: 'bun bench.ts',
            direction: 'minimize',
            samples: 3,
            harness: ['bench/**'],
          },
          target: { epsilon: { absolute: 2 } },
          budget: { maxAttempts: 5 },
          stop: { mode: 'abort' },
          proposer: { concurrency: 1 },
        },
        revision: 1,
        harnessPin: 'a'.repeat(40),
        specRev: 0,
      },
    })
    const tool = await toolFor(world)('optimization.revise', {
      repo,
      slug: 'opt',
      threshold: 30,
      epsilon: { relative: 0.05 },
    })
    expectEqual(tool, {
      slug: 'opt',
      revision: 2,
      changes: { threshold: 30, epsilon: { relative: 0.05 } },
    })
    const events = await world.store.getEvents('opt')
    expect(events.at(-1)).toMatchObject({
      type: 'optimization.objective-revised',
      actor: { kind: 'human' },
      payload: { revision: 2 },
    })
    const error = await toolFor(world)('optimization.revise', {
      repo,
      slug: 'demo',
      plateau: 3,
    }).catch((error) => error)
    expect(error).toBeInstanceOf(RegistryError)
    expect((error as RegistryError).body.kind).toBe('conflict')
    const empty = await toolFor(world)('optimization.revise', { repo, slug: 'opt' }).catch((e) => e)
    expect((empty as RegistryError).body.kind).toBe('validation')
  })

  test('optimization.stop records an operator stop once and refuses builds without an objective', async () => {
    const world = await seedWorld()
    const node = async (slug: string) => {
      await world.store.createBuild({ slug, repo, branch: `ab-node/${slug}` })
      await world.store.append(slug, {
        actor: DISPATCHER,
        type: 'build.created',
        payload: { repo, ticket: { source: 'fake', id: slug }, kind: 'node', baseBranch: 'main' },
      })
      await world.store.append(slug, {
        actor: DISPATCHER,
        type: 'optimization.objective-accepted',
        payload: {
          objective: {
            purpose: 'faster',
            metric: {
              kind: 'command',
              command: 'bun bench.ts',
              direction: 'minimize',
              samples: 3,
              harness: ['bench/**'],
            },
            target: { epsilon: { absolute: 2 } },
            budget: { maxAttempts: 5 },
            stop: { mode: 'abort' },
            proposer: { concurrency: 1 },
          },
          revision: 1,
          harnessPin: 'a'.repeat(40),
          specRev: 0,
        },
      })
    }
    await node('opt')
    await node('opt-drain')
    expectEqual(await toolFor(world)('optimization.stop', { repo, slug: 'opt' }), {
      slug: 'opt',
      cause: 'operator',
      mode: 'abort',
    })
    expect((await world.store.getEvents('opt')).at(-1)).toMatchObject({
      type: 'optimization.stopped',
      actor: { kind: 'human' },
      payload: { cause: 'operator', mode: 'abort' },
    })
    expectEqual(
      await toolFor(world)('optimization.stop', { repo, slug: 'opt-drain', mode: 'drain' }),
      { slug: 'opt-drain', cause: 'operator', mode: 'drain' },
    )
    const again = await toolFor(world)('optimization.stop', { repo, slug: 'opt' }).catch((e) => e)
    expect(again).toBeInstanceOf(RegistryError)
    expect((again as RegistryError).body.kind).toBe('conflict')
    expect(String((again as RegistryError).body.error)).toContain(
      'already stopped (operator, abort)',
    )
    const plain = await toolFor(world)('optimization.stop', { repo, slug: 'demo' }).catch((e) => e)
    expect(plain).toBeInstanceOf(RegistryError)
    expect((plain as RegistryError).body.kind).toBe('conflict')
    expect(
      (await world.store.getEvents('opt')).filter((e) => e.type === 'optimization.stopped'),
    ).toHaveLength(1)
  })

  test('builds.control matches the control route for an accepted command', async () => {
    const [routeWorld, toolWorld] = await Promise.all([seedWorld(), seedWorld()])
    const route = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: routeWorld.store,
        secret,
        clock,
      }),
    )('POST', `/operator/v1/repos/${encodeURIComponent(repo)}/builds/demo/control`, {
      action: 'hold',
    })
    const tool = await toolFor(toolWorld)('builds.control', {
      repo,
      slug: 'demo',
      action: 'hold',
    })
    expectEqual(tool, route.body)
    expectJsonClean(tool)
    // Both worlds durably recorded the same attributed request.
    const routeEvent = (await routeWorld.store.getEvents('demo')).at(-1)
    const toolEvent = (await toolWorld.store.getEvents('demo')).at(-1)
    expectEqual(toolEvent, routeEvent)
    expectEqual(toolEvent?.actor, humanActor('Ada'))
  })

  test('builds.control cancel-pause matches the route on a pausing build', async () => {
    // The route maps cancel-pause to `dashboard-pause`, whose reducer-supersede
    // rule cancels a pending pause; a pausing build (pending pause, lifecycle
    // running) must therefore cancel the pause identically on both faces.
    const [routeWorld, toolWorld] = await Promise.all([seedPausing(), seedPausing()])
    const route = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: routeWorld.store,
        secret,
        clock,
      }),
    )('POST', `/operator/v1/repos/${encodeURIComponent(repo)}/builds/pausing-b/control`, {
      action: 'cancel-pause',
    })
    expect(route.status).toBe(200)
    const tool = await toolFor(toolWorld)('builds.control', {
      repo,
      slug: 'pausing-b',
      action: 'cancel-pause',
    })
    expectEqual(tool, route.body)
    expectJsonClean(tool)
    // Both faces appended the pause-canceling resume request.
    const routeEvent = (await routeWorld.store.getEvents('pausing-b')).at(-1)
    const toolEvent = (await toolWorld.store.getEvents('pausing-b')).at(-1)
    expectEqual(toolEvent, routeEvent)
    expectEqual(toolEvent?.type, 'build.resume-requested')
    expectEqual(toolEvent?.actor, humanActor('Ada'))
  })

  test('builds.answer matches the answer route for guidance and revise-spec', async () => {
    // Guidance.
    const [routeWorld, toolWorld] = await Promise.all([seedWorld(), seedWorld()])
    const route = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: routeWorld.store,
        secret,
        clock,
      }),
    )('POST', `/operator/v1/repos/${encodeURIComponent(repo)}/builds/demo/answer`, {
      resolution: 'guidance',
      text: 'take the smaller cut',
    })
    const tool = await toolFor(toolWorld)('builds.answer', {
      repo,
      slug: 'demo',
      resolution: 'guidance',
      text: 'take the smaller cut',
    })
    expectEqual(tool, route.body)
    expectJsonClean(tool)

    // A destructive spec revision restarts from plan on both faces.
    const [routeWorld2, toolWorld2] = await Promise.all([seedWorld(), seedWorld()])
    const route2 = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: routeWorld2.store,
        secret,
        clock,
      }),
    )('POST', `/operator/v1/repos/${encodeURIComponent(repo)}/builds/demo/answer`, {
      resolution: 'revise-spec',
      origin: 'body',
      body: CONFORMING_SPEC,
    })
    const tool2 = await toolFor(toolWorld2)('builds.answer', {
      repo,
      slug: 'demo',
      resolution: 'revise-spec',
      origin: 'body',
      body: CONFORMING_SPEC,
    })
    expectEqual(tool2, route2.body)
    expectJsonClean(tool2)
  })

  test('repository.status matches the status route', async () => {
    const world = await seedWorld()
    const route = await api(
      createOperatorServer({ projects: testProjects([repo]), store: world.store, secret, clock }),
    )('GET', `/operator/v1/repos/${encodeURIComponent(repo)}/status`)
    const tool = await toolFor(world)('repository.status', { repo })
    expectEqual(tool, route.body)
    expectJsonClean(tool)
  })

  test('repository.settings matches set and toggle on their routes', async () => {
    // Explicit set (PUT on the route).
    const [routeWorld, toolWorld] = await Promise.all([seedWorld(), seedWorld()])
    const route = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: routeWorld.store,
        secret,
        clock,
      }),
    )('PUT', `/operator/v1/repos/${encodeURIComponent(repo)}/settings/intake`, { enabled: false })
    const tool = await toolFor(toolWorld)('repository.settings', {
      repo,
      setting: 'intake',
      enabled: false,
    })
    expectEqual(tool, route.body)
    expectJsonClean(tool)

    // Toggle (POST …/toggle on the route).
    const [routeWorld2, toolWorld2] = await Promise.all([seedWorld(), seedWorld()])
    const route2 = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: routeWorld2.store,
        secret,
        clock,
      }),
    )('POST', `/operator/v1/repos/${encodeURIComponent(repo)}/settings/intake/toggle`)
    const tool2 = await toolFor(toolWorld2)('repository.settings', {
      repo,
      setting: 'intake',
    })
    expectEqual(tool2, route2.body)
    expectJsonClean(tool2)
  })

  test('repository.bulk_control matches the bulk-control route', async () => {
    const [routeWorld, toolWorld] = await Promise.all([seedWorld(), seedWorld()])
    const route = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: routeWorld.store,
        secret,
        clock,
      }),
    )('POST', `/operator/v1/repos/${encodeURIComponent(repo)}/bulk-control`, { action: 'pause' })
    const tool = await toolFor(toolWorld)('repository.bulk_control', { repo, action: 'pause' })
    expectEqual(tool, route.body)
    expectJsonClean(tool)
  })

  test('bulk-partial failure bodies match the route’s BulkWalkError mapping', async () => {
    // A store whose build listing explodes mid-walk produces the same
    // BulkWalkError body — including progress — on both faces.
    const breakWalk = (base: BuildStore): BuildStore =>
      new Proxy(base, {
        get(target, property, receiver) {
          if (property === 'listBuilds') {
            return async () => {
              throw new Error('walk failure injected by the contract suite')
            }
          }
          return Reflect.get(target, property, receiver)
        },
      })
    const [routeWorld, toolWorld] = await Promise.all([seedWorld(), seedWorld()])
    const route = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: breakWalk(routeWorld.store),
        secret,
        clock,
      }),
    )('POST', `/operator/v1/repos/${encodeURIComponent(repo)}/bulk-control`, { action: 'resume' })
    const registry = buildRegistry({
      store: breakWalk(toolWorld.store),
      tickets: toolWorld.backend,
      clock,
    })
    const failure = await toolFailure(() =>
      registry.call('repository.bulk_control', { repo, action: 'resume' }, { identity: 'Ada' }),
    )
    expectEqual(failure, route.body as Record<string, unknown>)
  })

  test('harvest.status matches the harvest status route', async () => {
    const world = await seedWorld()
    const route = await api(
      createOperatorServer({ projects: testProjects([repo]), store: world.store, secret, clock }),
    )('GET', `/operator/v1/repos/${encodeURIComponent(repo)}/harvest/status`)
    const tool = await toolFor(world)('harvest.status', { repo })
    expectEqual(tool, route.body)
    expectJsonClean(tool)
  })

  test('harvest.control matches the harvest control route', async () => {
    const [routeWorld, toolWorld] = await Promise.all([seedWorld(), seedWorld()])
    const route = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: routeWorld.store,
        secret,
        clock,
      }),
    )('POST', `/operator/v1/repos/${encodeURIComponent(repo)}/harvest/control`, {
      action: 'toggle-gate',
    })
    const tool = await toolFor(toolWorld)('harvest.control', { repo, action: 'toggle-gate' })
    expectEqual(tool, route.body)
    expectJsonClean(tool)
  })

  test('tickets.list matches the ticket queue route with filters', async () => {
    const world = await seedWorld()
    const server = createOperatorServer({
      projects: testProjects([repo]),
      store: world.store,
      secret,
      clock,
      ticketBackend: world.backend,
    })
    const call = api(server)
    const runTool = toolFor(world)
    const plain = await call('GET', `/operator/v1/repos/${encodeURIComponent(repo)}/tickets`)
    const toolPlain = await runTool('tickets.list', { repo })
    expectEqual(toolPlain, plain.body)
    expectJsonClean(toolPlain)
    const filtered = await call(
      'GET',
      `/operator/v1/repos/${encodeURIComponent(repo)}/tickets?state=Backlog&label=web`,
    )
    const toolFiltered = await runTool('tickets.list', { repo, state: 'Backlog', labels: ['web'] })
    expectEqual(toolFiltered, filtered.body)
    expectJsonClean(toolFiltered)
  })

  test('tickets.list uses native pages through the MCP registry', async () => {
    const world = await seedWorld()
    Object.assign(world.source, {
      async listPage(criteria: unknown, page: unknown) {
        expect(criteria).toEqual({ state: 'Backlog', labels: ['web'] })
        expect(page).toMatchObject({ limit: 0, offset: 7, order: 'newest' })
        return { tickets: [], diagnostics: ['native'], total: 42 }
      },
    })
    world.source.listReady = async () => {
      throw new Error('full read forbidden')
    }
    const result = await toolFor(world)('tickets.list', {
      repo,
      state: 'Backlog',
      labels: ['web'],
      limit: 0,
      offset: 7,
      order: 'newest',
    })
    expect(result).toMatchObject({ tickets: [], diagnostics: ['native'], total: 42 })
  })

  test('tickets.get matches the ticket detail route', async () => {
    const world = await seedWorld()
    const originalGet = world.source.get.bind(world.source)
    const comments = [
      { body: '  ☃\r\n\r\nnotice\n', createdAt: '2026-01-01T00:00:00.000Z', author: 'Ada' },
    ]
    world.source.get = async (id) => {
      const ticket = await originalGet(id)
      return ticket ? { ...ticket, comments } : null
    }
    await world.store.putTicketAsset(repo, 'AUT-1', {
      kind: 'design',
      name: 'canvas',
      layout: 'tree',
      entries: [
        { type: 'file', path: 'index.html', content: new TextEncoder().encode('<p>') },
        { type: 'dir', path: 'img' },
      ],
    })
    const route = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: world.store,
        secret,
        clock,
        ticketBackend: world.backend,
      }),
    )('GET', `/operator/v1/repos/${encodeURIComponent(repo)}/tickets/AUT-1`)
    const tool = await toolFor(world)('tickets.get', { repo, id: 'AUT-1' })
    expectEqual(tool, route.body)
    expect((tool as { ticket: { comments: unknown } }).ticket.comments).toEqual(comments)
    expectEqual((tool as { assets: unknown }).assets, [
      { kind: 'design', name: 'canvas', revision: 0, size: 3, layout: 'tree', fileCount: 1 },
    ])
    expectJsonClean(tool)
  })

  test('ticket asset tools round-trip exact bytes and follow the CLI rules', async () => {
    const world = await seedWorld()
    const tool = toolFor(world)
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
    const every = Uint8Array.from({ length: 256 }, (_, i) => i)
    const target = { repo, id: 'AUT-1' }
    const fileAsset = (content: Uint8Array) => ({
      ...target,
      kind: 'design',
      name: 'bytes.bin',
      layout: 'file',
      entries: [{ type: 'file', path: 'bytes.bin', contentBase64: b64(content) }],
    })
    const attached = (await tool('tickets.asset.attach', fileAsset(every))) as {
      asset: { revision: number }
      replaced: boolean
      activeBuilds: string[]
    }
    expect(attached.replaced).toBe(false)
    // The seeded demo build holds AUT-1 open.
    expect(attached.activeBuilds).toEqual(['demo'])
    expectJsonClean(attached)
    expect(world.source.comments.at(-1)?.body).toStartWith('Ticket asset attached')
    const got = (await tool('tickets.asset.get', {
      ...target,
      kind: 'design',
      name: 'bytes.bin',
    })) as { entries: { contentBase64: string; size: number }[] }
    expectJsonClean(got)
    expect(got.entries[0]?.size).toBe(256)
    expectEqual(new Uint8Array(Buffer.from(got.entries[0]!.contentBase64, 'base64')), every)

    const nested = Uint8Array.from([0, 255, 10, 13])
    const tree = [
      { type: 'file', path: 'index.html', contentBase64: b64(new TextEncoder().encode('<p>')) },
      { type: 'dir', path: 'empty' },
      { type: 'file', path: 'img/a.bin', contentBase64: b64(nested) },
      { type: 'file', path: 'zero', contentBase64: '' },
    ]
    await tool('tickets.asset.attach', {
      ...target,
      kind: 'design',
      name: 'site',
      layout: 'tree',
      entries: tree,
    })
    const site = (await tool('tickets.asset.get', { ...target, kind: 'design', name: 'site' })) as {
      entries: Record<string, unknown>[]
    }
    expectEqual(
      site.entries.map(({ size: _size, ...entry }) => entry),
      tree,
    )

    const again = (await tool('tickets.asset.attach', fileAsset(nested))) as {
      asset: { revision: number }
      replaced: boolean
    }
    expect(again.replaced).toBe(true)
    expect(again.asset.revision).toBeGreaterThan(attached.asset.revision)
    expect(world.source.comments.at(-1)?.body).toStartWith('Ticket asset replaced')
    const first = (await tool('tickets.asset.get', {
      ...target,
      kind: 'design',
      name: 'bytes.bin',
      rev: attached.asset.revision,
    })) as { entries: { contentBase64: string }[] }
    expect(first.entries[0]?.contentBase64).toBe(b64(every))
    const listed = async () =>
      ((await tool('tickets.get', target)) as { assets: { name: string }[] }).assets.map(
        (asset) => asset.name,
      )
    expect(await listed()).toEqual(['bytes.bin', 'site'])

    const removed = (await tool('tickets.asset.remove', {
      ...target,
      kind: 'design',
      name: 'bytes.bin',
    })) as { removed: { revision: number } }
    expect(removed.removed.revision).toBe(again.asset.revision)
    expect(world.source.comments.at(-1)?.body).toStartWith('Ticket asset removed')
    expect(await listed()).toEqual(['site'])
    const gone = { ...target, kind: 'design', name: 'bytes.bin' }
    expect((await toolFailure(() => tool('tickets.asset.get', gone))).kind).toBe('not-found')
    expect(
      (
        (await tool('tickets.asset.get', { ...gone, rev: attached.asset.revision })) as {
          entries: unknown[]
        }
      ).entries,
    ).toHaveLength(1)
    expect((await toolFailure(() => tool('tickets.asset.remove', gone))).kind).toBe('not-found')

    const unknown = { ...fileAsset(every), id: 'AUT-404' }
    expect((await toolFailure(() => tool('tickets.asset.attach', unknown))).kind).toBe('not-found')
    expect(await world.store.listTicketAssets(repo, 'AUT-404')).toEqual([])
  })

  test('the attach schema accepts base64 up to the default 25 MiB asset limit', () => {
    const schema = TOOLS.find((tool) => tool.name === 'tickets.asset.attach')!.inputSchema
    const input = (contentBase64: string) => ({
      repo,
      id: 'AUT-1',
      kind: 'design',
      name: 'big.bin',
      layout: 'file',
      entries: [{ type: 'file', path: 'big.bin', contentBase64 }],
    })
    const full = Buffer.alloc(25 * 1024 * 1024, 0xa5).toString('base64')
    for (const contentBase64 of [Buffer.alloc(7_500_000).toString('base64'), full])
      expect(schema.safeParse(input(contentBase64)).success).toBe(true)
    // A stray character deep inside a large payload is still refused.
    expect(
      schema.safeParse(input(`${full.slice(0, 4_000_000)}*${full.slice(4_000_001)}`)).success,
    ).toBe(false)
  })

  test('asset validation failures are typed, not internal', async () => {
    const world = await seedWorld()
    const tool = toolFor(world)
    const file = (path: string) => ({ type: 'file', path, contentBase64: 'AA==' })
    const invalid = [
      { kind: 'a/b', name: 'x', layout: 'file', entries: [file('x')] },
      { kind: 'design', name: 'x', layout: 'file', entries: [file('a'), file('b')] },
      { kind: 'design', name: 'x', layout: 'tree', entries: [file('../x')] },
      { kind: 'design', name: 'x', layout: 'tree', entries: [file('a'), file('a')] },
    ]
    for (const input of invalid) {
      const body = await toolFailure(() =>
        tool('tickets.asset.attach', { repo, id: 'AUT-1', ...input }),
      )
      expect(body.kind).toBe('validation')
      expect(body.code).toBe('ticket-asset-invalid')
    }
    world.store.ticketAssetLimits = async () => ({ maxBytes: 4, maxEntries: 1000 })
    const over = await toolFailure(() =>
      tool('tickets.asset.attach', {
        repo,
        id: 'AUT-1',
        kind: 'design',
        name: 'big',
        layout: 'file',
        entries: [{ type: 'file', path: 'big', contentBase64: 'AAAAAAA=' }],
      }),
    )
    expect(over).toMatchObject({ kind: 'validation', code: 'ticket-asset-invalid' })
    expect(String(over.error)).toContain('4 bytes')
    expect(await world.store.listTicketAssets(repo, 'AUT-1')).toEqual([])
    expect(world.source.comments).toEqual([])
  })

  test('tickets.create matches the create route', async () => {
    const [routeWorld, toolWorld] = await Promise.all([seedWorld(), seedWorld()])
    const request = { title: 'Fresh', body: 'fresh body', labels: ['web'], blockedBy: ['AUT-2'] }
    const route = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: routeWorld.store,
        secret,
        clock,
        ticketBackend: routeWorld.backend,
      }),
    )('POST', `/operator/v1/repos/${encodeURIComponent(repo)}/tickets`, request)
    expect(route.status).toBe(201)
    const tool = await toolFor(toolWorld)('tickets.create', { repo, ...request })
    expectEqual(tool, route.body)
    expectJsonClean(tool)
  })

  test('tickets.update matches the patch route', async () => {
    const [routeWorld, toolWorld] = await Promise.all([seedWorld(), seedWorld()])
    const route = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: routeWorld.store,
        secret,
        clock,
        ticketBackend: routeWorld.backend,
      }),
    )('PATCH', `/operator/v1/repos/${encodeURIComponent(repo)}/tickets/AUT-1`, { labels: [] })
    const tool = await toolFor(toolWorld)('tickets.update', { repo, id: 'AUT-1', labels: [] })
    expectEqual(tool, route.body)
    expectJsonClean(tool)
  })

  test('issue links default to closes and match their routes; unsupported sources refuse', async () => {
    const [routeWorld, toolWorld] = await Promise.all([seedWorld(), seedWorld()])
    const route = api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: routeWorld.store,
        secret,
        clock,
        ticketBackend: routeWorld.backend,
      }),
    )
    const tool = toolFor(toolWorld)
    const tickets = `/operator/v1/repos/${encodeURIComponent(repo)}/tickets`
    const request = {
      title: 'Linked',
      body: 'linked body',
      issueLinks: [{ issue: 824 }, { issue: 820, intent: 'refs' }],
    }
    const created = await route('POST', tickets, request)
    expect(created.status).toBe(201)
    const createdTool = (await tool('tickets.create', { repo, ...request })) as {
      ticket: { ref: { id: string }; issueLinks: unknown }
    }
    expectEqual(createdTool, created.body)
    expectEqual(createdTool.ticket.issueLinks, [
      { issue: 820, intent: 'refs' },
      { issue: 824, intent: 'closes' },
    ])
    const id = createdTool.ticket.ref.id
    const patch = { issueLinks: [{ issue: 5 }] }
    const updated = await route('PATCH', `${tickets}/${id}`, patch)
    expect(updated.status).toBe(200)
    expectEqual(await tool('tickets.update', { repo, id, ...patch }), updated.body)
    const shown = (await tool('tickets.get', { repo, id })) as { ticket: { issueLinks: unknown } }
    expectEqual(shown.ticket.issueLinks, [{ issue: 5, intent: 'closes' }])

    const duplicate = { issueLinks: [{ issue: 1 }, { issue: 1, intent: 'refs' }] }
    expect((await route('PATCH', `${tickets}/${id}`, duplicate)).status).toBe(400)
    expect(
      await toolFailure(() => tool('tickets.update', { repo, id, ...duplicate })),
    ).toMatchObject({ kind: 'validation' })
    expect(
      await toolFailure(() =>
        tool('tickets.create', { repo, title: 't', body: 'b', issueLinks: [{ issue: 0 }] }),
      ),
    ).toMatchObject({ kind: 'validation' })

    Object.assign(routeWorld.source, { issueLinks: false })
    Object.assign(toolWorld.source, { issueLinks: false })
    const refused = await route('PATCH', `${tickets}/AUT-1`, { issueLinks: [] })
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ kind: 'refusal', code: 'issue-links-unsupported' })
    const refusedTool = await toolFailure(() =>
      tool('tickets.update', { repo, id: 'AUT-1', issueLinks: [] }),
    )
    expectEqual(refusedTool, refused.body)
    expect(
      await toolFailure(() =>
        tool('tickets.create', { repo, title: 't', body: 'b', issueLinks: [{ issue: 1 }] }),
      ),
    ).toMatchObject({ kind: 'refusal', code: 'issue-links-unsupported' })
  })

  test('priority matches its routes; unsupported sources refuse urgent', async () => {
    const [routeWorld, toolWorld] = await Promise.all([seedWorld(), seedWorld()])
    const route = api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: routeWorld.store,
        secret,
        clock,
        ticketBackend: routeWorld.backend,
      }),
    )
    const tool = toolFor(toolWorld)
    const tickets = `/operator/v1/repos/${encodeURIComponent(repo)}/tickets`
    const request = { title: 'Hotfix', body: 'hotfix body', priority: 'urgent' }
    const created = await route('POST', tickets, request)
    expect(created.status).toBe(201)
    const createdTool = (await tool('tickets.create', { repo, ...request })) as {
      ticket: { ref: { id: string }; priority?: unknown }
    }
    expectEqual(createdTool, created.body)
    expect(createdTool.ticket.priority).toBe('urgent')
    const id = createdTool.ticket.ref.id
    const patch = { priority: 'normal' }
    const updated = await route('PATCH', `${tickets}/${id}`, patch)
    expect(updated.status).toBe(200)
    expectEqual(await tool('tickets.update', { repo, id, ...patch }), updated.body)
    const shown = (await tool('tickets.get', { repo, id })) as { ticket: object }
    expect('priority' in shown.ticket).toBe(false)

    expect((await route('PATCH', `${tickets}/${id}`, { priority: 'high' })).status).toBe(400)
    expect(
      await toolFailure(() => tool('tickets.update', { repo, id, priority: 'high' })),
    ).toMatchObject({ kind: 'validation' })

    Object.assign(routeWorld.source, { priority: false })
    Object.assign(toolWorld.source, { priority: false })
    const refused = await route('PATCH', `${tickets}/AUT-1`, { priority: 'urgent' })
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ kind: 'refusal', code: 'priority-unsupported' })
    const refusedTool = await toolFailure(() =>
      tool('tickets.update', { repo, id: 'AUT-1', priority: 'urgent' }),
    )
    expectEqual(refusedTool, refused.body)
    expect(
      await toolFailure(() =>
        tool('tickets.create', { repo, title: 't', body: 'b', priority: 'urgent' }),
      ),
    ).toMatchObject({ kind: 'refusal', code: 'priority-unsupported' })
    const normal = await route('PATCH', `${tickets}/AUT-1`, { priority: 'normal' })
    expect(normal.status).toBe(200)
    expectEqual(
      await tool('tickets.update', { repo, id: 'AUT-1', priority: 'normal' }),
      normal.body,
    )

    // A source without the assignees capability refuses them on both surfaces.
    const unassignable = await route('PATCH', `${tickets}/AUT-1`, { assignees: ['alice'] })
    expect(unassignable.status).toBe(409)
    expect(unassignable.body).toMatchObject({ kind: 'refusal', code: 'assignees-unsupported' })
    expectEqual(
      await toolFailure(() => tool('tickets.update', { repo, id: 'AUT-1', assignees: ['alice'] })),
      unassignable.body,
    )
    const unassignableCreate = await route('POST', tickets, {
      title: 't',
      body: 'b',
      assignees: [],
    })
    expect(unassignableCreate.body).toMatchObject({ code: 'assignees-unsupported' })
    expect(
      await toolFailure(() =>
        tool('tickets.create', { repo, title: 't', body: 'b', assignees: [] }),
      ),
    ).toMatchObject({ kind: 'refusal', code: 'assignees-unsupported' })
  })

  test('tickets.block and tickets.unblock match their routes', async () => {
    const [routeWorld, toolWorld] = await Promise.all([seedWorld(), seedWorld()])
    const route = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: routeWorld.store,
        secret,
        clock,
        ticketBackend: routeWorld.backend,
      }),
    )('POST', `/operator/v1/repos/${encodeURIComponent(repo)}/tickets/AUT-1/block`, {
      blockerIds: ['AUT-2'],
    })
    const tool = await toolFor(toolWorld)('tickets.block', {
      repo,
      id: 'AUT-1',
      blockerIds: ['AUT-2'],
    })
    expectEqual(tool, route.body)
    expectJsonClean(tool)
    // Unblock both ways.
    const [routeWorld2, toolWorld2] = await Promise.all([seedWorld(), seedWorld()])
    await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: routeWorld2.store,
        secret,
        clock,
        ticketBackend: routeWorld2.backend,
      }),
    )('POST', `/operator/v1/repos/${encodeURIComponent(repo)}/tickets/AUT-1/block`, {
      blockerIds: ['AUT-2'],
    })
    await toolFor(toolWorld2)('tickets.block', { repo, id: 'AUT-1', blockerIds: ['AUT-2'] })
    const route2 = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: routeWorld2.store,
        secret,
        clock,
        ticketBackend: routeWorld2.backend,
      }),
    )('POST', `/operator/v1/repos/${encodeURIComponent(repo)}/tickets/AUT-1/unblock`, {
      blockerIds: ['AUT-2'],
    })
    const tool2 = await toolFor(toolWorld2)('tickets.unblock', {
      repo,
      id: 'AUT-1',
      blockerIds: ['AUT-2'],
    })
    expectEqual(tool2, route2.body)
    expectJsonClean(tool2)
  })

  test('tickets.start matches the start and cancel routes', async () => {
    const [routeWorld, toolWorld] = await Promise.all([seedWorld(), seedWorld()])
    const call = api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: routeWorld.store,
        secret,
        clock,
        ticketBackend: routeWorld.backend,
      }),
    )
    const path = `/operator/v1/repos/${encodeURIComponent(repo)}/tickets/AUT-2/start`
    const tool = toolFor(toolWorld)
    for (const [route, input, body] of [
      [path, { repo, id: 'AUT-2' }, undefined],
      [path, { repo, id: 'AUT-2' }, undefined],
      // Another priority updates the pending request; the body carries it.
      [path, { repo, id: 'AUT-2', priority: 'urgent' }, { priority: 'urgent' }],
      [path, { repo, id: 'AUT-2', priority: 'urgent' }, { priority: 'urgent' }],
      [`${path}/cancel`, { repo, id: 'AUT-2', cancel: true }, undefined],
      [`${path}/cancel`, { repo, id: 'AUT-2', cancel: true }, undefined],
    ] as const) {
      const routed =
        body === undefined ? await call('POST', route) : await call('POST', route, body)
      expect(routed.status).toBe(200)
      const result = await tool('tickets.start', input)
      expectEqual(result, routed.body)
      expectJsonClean(result)
    }
    expect(await tool('tickets.start', { repo, id: 'AUT-2', priority: 'normal' })).toMatchObject({
      priority: 'normal',
      updated: false,
    })
    expect((await call('POST', path, { priority: 'high' })).status).toBe(400)
    const missing = await call(
      'POST',
      `/operator/v1/repos/${encodeURIComponent(repo)}/tickets/AUT-404/start`,
    )
    expect(missing.status).toBe(404)
  })

  test('tickets.move by state and by role matches the move route, and both refuse zero or two targets', async () => {
    const path = `/operator/v1/repos/${encodeURIComponent(repo)}/tickets/AUT-2/move`
    for (const target of [{ state: 'Todo' }, { role: 'ready' }]) {
      const [routeWorld, toolWorld] = await Promise.all([seedWorld(), seedWorld()])
      const call = api(
        createOperatorServer({
          projects: testProjects([repo]),
          store: routeWorld.store,
          secret,
          clock,
          ticketBackend: routeWorld.backend,
        }),
      )
      const route = await call('POST', path, target)
      const tool = await toolFor(toolWorld)('tickets.move', { repo, id: 'AUT-2', ...target })
      expectEqual(tool, route.body)
      expectJsonClean(tool)
      expect((tool as { ticket: { state: string } }).ticket.state).toBe('Todo')
      if ('role' in target)
        for (const body of [{}, { state: 'Todo', role: 'ready' }]) {
          const refused = await call('POST', path, body)
          expect(refused.status).toBe(400)
          expect(JSON.stringify(refused.body)).toContain('exactly one of state or role')
          const failure = await toolFailure(() =>
            toolFor(toolWorld)('tickets.move', { repo, id: 'AUT-2', ...body }),
          )
          expect(JSON.stringify(failure)).toContain('exactly one of state or role')
        }
    }
  })

  test('mapped failure bodies equal their routes, per tool', async () => {
    // Not-found build through the query service (OperatorQueryError path).
    const queryWorld = await seedWorld()
    const queryRoute = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: queryWorld.store,
        secret,
        clock,
      }),
    )('GET', `/operator/v1/repos/${encodeURIComponent(repo)}/builds/missing`)
    expect(queryRoute.status).toBe(404)
    const queryFailure = await toolFailure(() =>
      toolFor(queryWorld)('builds.get', { repo, slug: 'missing' }),
    )
    expectEqual(queryFailure, queryRoute.body as Record<string, unknown>)

    // Unknown build through the control glue (requireRouteBuild path, no code).
    const controlWorld = await seedWorld()
    const controlRoute = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: controlWorld.store,
        secret,
        clock,
      }),
    )('POST', `/operator/v1/repos/${encodeURIComponent(repo)}/builds/missing/control`, {
      action: 'pause',
    })
    expect(controlRoute.status).toBe(404)
    const controlFailure = await toolFailure(() =>
      toolFor(controlWorld)('builds.control', { repo, slug: 'missing', action: 'pause' }),
    )
    expectEqual(controlFailure, controlRoute.body)

    // Inapplicable control (BuildControlError path with code).
    const inactiveWorld = await seedWorld()
    const inactiveRoute = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: inactiveWorld.store,
        secret,
        clock,
      }),
    )('POST', `/operator/v1/repos/${encodeURIComponent(repo)}/builds/queued-b/control`, {
      action: 'pause',
    })
    expect(inactiveRoute.status).toBe(409)
    const inactiveFailure = await toolFailure(() =>
      toolFor(inactiveWorld)('builds.control', { repo, slug: 'queued-b', action: 'pause' }),
    )
    expectEqual(inactiveFailure, inactiveRoute.body)

    // The route's pending-state prechecks, both refusals (BuildControlError
    // before any controlBuild call): pause while a pause is already pending,
    // and cancel-pause without a pending pause.
    const [pausingRouteWorld, pausingToolWorld] = await Promise.all([seedPausing(), seedPausing()])
    const pausingRoute = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: pausingRouteWorld.store,
        secret,
        clock,
      }),
    )('POST', `/operator/v1/repos/${encodeURIComponent(repo)}/builds/pausing-b/control`, {
      action: 'pause',
    })
    expect(pausingRoute.status).toBe(409)
    const pausingFailure = await toolFailure(() =>
      toolFor(pausingToolWorld)('builds.control', { repo, slug: 'pausing-b', action: 'pause' }),
    )
    expectEqual(pausingFailure, pausingRoute.body)

    const [runningRouteWorld, runningToolWorld] = await Promise.all([seedWorld(), seedWorld()])
    const runningRoute = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: runningRouteWorld.store,
        secret,
        clock,
      }),
    )('POST', `/operator/v1/repos/${encodeURIComponent(repo)}/builds/demo/control`, {
      action: 'cancel-pause',
    })
    expect(runningRoute.status).toBe(409)
    const runningFailure = await toolFailure(() =>
      toolFor(runningToolWorld)('builds.control', { repo, slug: 'demo', action: 'cancel-pause' }),
    )
    expectEqual(runningFailure, runningRoute.body)

    // Answer with no open escalations.
    const answerWorld = await seedWorld()
    const answerRoute = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: answerWorld.store,
        secret,
        clock,
      }),
    )('POST', `/operator/v1/repos/${encodeURIComponent(repo)}/builds/queued-b/answer`, {
      resolution: 'guidance',
      text: 'no blockers here',
    })
    expect(answerRoute.status).toBe(409)
    const answerFailure = await toolFailure(() =>
      toolFor(answerWorld)('builds.answer', {
        repo,
        slug: 'queued-b',
        resolution: 'guidance',
        text: 'no blockers here',
      }),
    )
    expectEqual(answerFailure, answerRoute.body)

    // Missing artifact.
    const artifactWorld = await seedWorld()
    const artifactRoute = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: artifactWorld.store,
        secret,
        clock,
      }),
    )('GET', `/operator/v1/repos/${encodeURIComponent(repo)}/builds/demo/artifacts/missing-kind`)
    expect(artifactRoute.status).toBe(404)
    const artifactFailure = await toolFailure(() =>
      toolFor(artifactWorld)('builds.artifact', { repo, slug: 'demo', kind: 'missing-kind' }),
    )
    expectEqual(artifactFailure, artifactRoute.body)

    // Missing ticket (TicketOperationError path).
    const ticketWorld = await seedWorld()
    const ticketRoute = await api(
      createOperatorServer({
        projects: testProjects([repo]),
        store: ticketWorld.store,
        secret,
        clock,
        ticketBackend: ticketWorld.backend,
      }),
    )('GET', `/operator/v1/repos/${encodeURIComponent(repo)}/tickets/AUT-404`)
    expect(ticketRoute.status).toBe(404)
    const ticketFailure = await toolFailure(() =>
      toolFor(ticketWorld)('tickets.get', { repo, id: 'AUT-404' }),
    )
    expectEqual(ticketFailure, ticketRoute.body)
  })

  test('invalid input is rejected by the schema before any handler runs', async () => {
    const world = await seedWorld()
    const registry = buildRegistry({
      store: world.store,
      tickets: world.backend,
      clock,
    })
    const rejections: [string, unknown][] = [
      ['builds.list', { repo, scope: 'nope' }],
      ['builds.list', { slug: 'demo' }],
      ['builds.events', { repo, slug: 'demo', cursor: -1 }],
      ['builds.events', { repo, slug: 'demo', cursor: 0, waitSeconds: 31 }],
      ['builds.events', { repo, slug: 'demo', cursor: 0, waitSeconds: 1.5 }],
      ['repository.events', { repo, cursor: -1 }],
      ['repository.events', { repo, cursor: 0, waitSeconds: 31 }],
      ['repository.events', { repo, cursor: 0, filter: 'some' }],
      ['builds.control', { repo, slug: 'demo', action: 'abort', to: 'backlog' }],
      ['builds.artifact', { repo, slug: 'demo', kind: 'notes', rev: -3 }],
      ['builds.control', { repo, slug: 'demo', action: 'explode' }],
      ['builds.answer', { repo, slug: 'demo', resolution: 'guidance' }],
      ['repository.bulk_control', { repo, action: 'restart' }],
      ['tickets.block', { repo, id: 'AUT-1', blockerIds: [] }],
      ['tickets.update', { repo, id: 'AUT-1' }],
      ['notes.write', { repo }],
      ...['@@@', 'AAA', 'AA=A'].map((contentBase64): [string, unknown] => [
        'tickets.asset.attach',
        {
          repo,
          id: 'AUT-1',
          kind: 'design',
          name: 'x',
          layout: 'file',
          entries: [{ type: 'file', path: 'x', contentBase64 }],
        },
      ]),
      [
        'tickets.asset.attach',
        { repo, id: 'AUT-1', kind: 'design', name: 'x', layout: 'zip', entries: [] },
      ],
      ['tickets.asset.get', { repo, id: 'AUT-1', kind: 'design', name: 'x', rev: -1 }],
    ]
    const buildsBefore = (await world.store.getEvents('demo')).length
    const ticketsBefore = world.source.updates.length + world.source.blockerAdds.length
    for (const [name, input] of rejections) {
      const error = await registry.call(name, input, { identity: 'Ada' }).catch((e) => e)
      expect(error).toBeInstanceOf(RegistryError)
      expect((error as RegistryError).reason).toBe('validation')
      expect((error as RegistryError).body.kind).toBe('validation')
    }
    expect((await world.store.getEvents('demo')).length).toBe(buildsBefore)
    expect(world.source.updates.length + world.source.blockerAdds.length).toBe(ticketsBefore)
  })

  test('mutators refuse without an attributed identity; reads never do', async () => {
    const world = await seedWorld()
    const registry = buildRegistry({ store: world.store, tickets: world.backend, clock })
    const mutators = TOOLS.filter((tool) => tool.approval === 'default').map((tool) => tool.name)
    // One minimal valid input per mutator.
    const inputs: Record<string, unknown> = {
      'builds.restack': { repo, slug: 'demo' },
      'optimization.revise': { repo, slug: 'demo', threshold: 30 },
      'optimization.stop': { repo, slug: 'demo' },
      'optimization.settle-unmeasured': {
        repo,
        slug: 'demo',
        attempt: 'p1',
        policy: 'release-unmeasured',
      },
      'builds.control': { repo, slug: 'demo', action: 'hold' },
      'builds.answer': { repo, slug: 'demo', resolution: 'guidance', text: 'hi' },
      'builds.reopen': { repo, slug: 'demo', feedback: 'change it' },
      'repository.forge_clear': { repo, forge: 'github', reason: 'override' },
      'repository.settings': { repo, setting: 'intake', enabled: true },
      'repository.bulk_control': { repo, action: 'pause' },
      'harvest.control': { repo, action: 'toggle-gate' },
      'tickets.states': { repo },
      'tickets.state.create': { repo, name: 'icebox' },
      'tickets.list': { repo },
      'tickets.get': { repo, id: 'AUT-1' },
      'tickets.create': { repo, title: 't', body: 'b' },
      'tickets.update': { repo, id: 'AUT-1', title: 'new' },
      'tickets.block': { repo, id: 'AUT-1', blockerIds: ['AUT-2'] },
      'tickets.unblock': { repo, id: 'AUT-1', blockerIds: ['AUT-2'] },
      'tickets.move': { repo, id: 'AUT-2', state: 'Todo' },
      'tickets.start': { repo, id: 'AUT-2' },
      'tickets.asset.attach': {
        repo,
        id: 'AUT-1',
        kind: 'design',
        name: 'x',
        layout: 'file',
        entries: [{ type: 'file', path: 'x', contentBase64: '' }],
      },
      'tickets.asset.remove': { repo, id: 'AUT-1', kind: 'design', name: 'reference' },
      'notes.write': { repo, document: 'notes' },
      // Sandbox tools (absent from this registry without a backend) are
      // excluded by name so the unknown-tool refusal above is not hit first.
    }
    for (const name of mutators.filter((name) => !name.startsWith('sandbox.'))) {
      const error = await registry.call(name, inputs[name]).catch((e) => e)
      expect(error, `${name} must refuse without identity`).toBeInstanceOf(RegistryError)
      expect((error as RegistryError).reason).toBe('no-identity')
      // Reads are never gated.
    }
    const reads = TOOLS.filter((tool) => tool.approval === 'never').map((tool) => tool.name)
    const readInputs: Record<string, unknown> = {
      'builds.list': { repo },
      'merges.list': { repo },
      'landings.list': { repo },
      'tickets.tree': { repo },
      'builds.get': { repo, slug: 'demo' },
      'builds.events': { repo, slug: 'demo', cursor: 0 },
      'builds.artifact': { repo, slug: 'demo', kind: 'notes' },
      'repository.status': { repo },
      'repository.events': { repo },
      'harvest.status': { repo },
      'tickets.states': { repo },
      'tickets.state.create': { repo, name: 'icebox' },
      'tickets.list': { repo },
      'tickets.get': { repo, id: 'AUT-1' },
      'tickets.asset.get': { repo, id: 'AUT-1', kind: 'design', name: 'reference' },
      'notes.read': { repo },
    }
    await world.store.putTicketAsset(repo, 'AUT-1', {
      kind: 'design',
      name: 'reference',
      layout: 'file',
      entries: [{ type: 'file', path: 'reference', content: new Uint8Array([1]) }],
    })
    // sandbox.status is a read but, like every sandbox tool, absent here.
    for (const name of reads.filter((name) => !name.startsWith('sandbox.'))) {
      const outcome = await registry.call(name, readInputs[name]).then(
        () => 'ok',
        (caught: unknown) => `${(caught as Error).name}: ${(caught as Error).message}`,
      )
      expect(outcome, `${name} must run without identity`).toBe('ok')
    }
    // Ticket reads without a backend refuse with the route's exact
    // conflict, not an identity error.
    const backendless = buildRegistry({ store: world.store, clock })
    const noBackend = await backendless.call('tickets.list', { repo }).catch((e) => e)
    expectEqual((noBackend as RegistryError).body, {
      kind: 'conflict',
      error: 'ticket operator backend is not configured',
    })
  })

  test('attributed writes carry the caller’s identity, and notes.write records via', async () => {
    const world = await seedWorld()
    const registry = buildRegistry({ store: world.store, tickets: world.backend, clock })
    const via = { kind: 'mcp', client: 'claude' } as const
    await registry.call(
      'repository.settings',
      { repo, setting: 'intake', enabled: false },
      { identity: 'Grace', via },
    )
    const event = (await world.store.getRepoEvents(repo)).at(-1)
    expectEqual(event?.actor, humanActor('Grace', via))

    await registry.call(
      'notes.write',
      { repo, document: 'round 2 notes' },
      { identity: 'Grace', via },
    )
    const read = (await registry.call('notes.read', { repo }, { identity: 'Grace' })) as {
      document: string
      revision: number
      metadata: unknown
    }
    expect(read.document).toBe('round 2 notes')
    expectEqual(read.metadata, { user: 'Grace', via })
    expectJsonClean(read)
  })

  test('builds.events matches its documented seam, preserves failed-node attention and resumes after its sequence', async () => {
    const world = await seedWorld()
    const registry = buildRegistry({ store: world.store, clock })
    // The documented seam: store.getEvents after the cursor.
    const cursor = 2
    const page = (await registry.call('builds.events', {
      repo,
      slug: 'demo',
      cursor,
    })) as { events: unknown[]; cursor: number }
    const seam = await world.store.getEvents('demo', cursor)
    expectEqual(page.events, seam)
    expect(page.cursor).toBe(seam.at(-1)!.seq)
    expectJsonClean(page)

    const event = await world.store.append('demo', {
      actor: KERNEL,
      type: 'integration.verification-failed',
      payload: {
        id: 'cycle',
        head: 'head',
        parent: 'parent',
        steps: ['unit'],
        guidance: 'file a repair child targeting this node: demo',
      },
    })
    const result = (await registry.call('builds.events', {
      repo,
      slug: 'demo',
      cursor: event.seq - 1,
    })) as { events: unknown[]; cursor: number }
    expectEqual(result.events, [event])
    expect(result.cursor).toBe(event.seq)
    const resumed = (await registry.call('builds.events', {
      repo,
      slug: 'demo',
      cursor: result.cursor,
    })) as { events: unknown[]; cursor: number }
    expectEqual(resumed.events, [])
    expect(resumed.cursor).toBe(event.seq)
  })

  test('builds.control records an abort destination and refuses it on other actions', async () => {
    const world = await seedWorld()
    const registry = buildRegistry({ store: world.store, tickets: world.backend, clock })
    const refused = await registry
      .call(
        'builds.control',
        { repo, slug: 'demo', action: 'pause', to: 'ready' },
        { identity: 'Ada' },
      )
      .catch((error) => error)
    expect(refused).toBeInstanceOf(RegistryError)
    await registry.call(
      'builds.control',
      { repo, slug: 'demo', action: 'abort', to: 'ready', reason: 'waiting on AUT-2' },
      { identity: 'Ada' },
    )
    expect((await world.store.getEvents('demo')).at(-1)).toMatchObject({
      type: 'build.abort-requested',
      payload: { to: 'ready', reason: 'waiting on AUT-2' },
    })
  })

  test('notes.read and notes.write match their documented seams', async () => {
    const world = await seedWorld()
    const registry = buildRegistry({ store: world.store, clock })
    // No notes yet: the documented empty document.
    const empty = (await registry.call('notes.read', { repo })) as Record<string, unknown>
    expectEqual(empty, { document: '', revision: null, metadata: null })
    // After a direct deposit, notes.read IS getRepoArtifact.
    const direct = await world.store.putRepoArtifact(repo, {
      kind: 'operator-notes',
      content: 'operator notes v1',
      metadata: { user: 'Ada' },
    })
    const read = (await registry.call('notes.read', { repo })) as {
      document: string
      revision: number
      metadata: unknown
    }
    const seam = await world.store.getRepoArtifact(repo, 'operator-notes')
    expect(read.document).toBe(new TextDecoder().decode(seam!.content))
    expect(read.revision).toBe(direct.revision)
    expectEqual(read.metadata, seam!.meta.metadata)
    // An unknown repository reads as empty rather than throwing.
    const foreign = (await registry.call('notes.read', { repo: 'acme/other' })) as Record<
      string,
      unknown
    >
    expectEqual(foreign, { document: '', revision: null, metadata: null })
  })

  test('operator-notes revisions are retention-pruned (documented revision count)', async () => {
    const store = new MemoryBuildStore({ clock, retention: { maxRevisions: 2 } })
    await store.ensureRepo(repo)
    const registry = buildRegistry({ store, clock })
    for (const document of ['v0', 'v1', 'v2']) {
      await registry.call('notes.write', { repo, document }, { identity: 'Ada' })
    }
    const revisions = (await store.listRepoArtifacts(repo, 'operator-notes')).map(
      (meta) => meta.revision,
    )
    expectEqual(revisions, [1, 2])
    const read = (await registry.call('notes.read', { repo })) as { document: string }
    expect(read.document).toBe('v2')
  })

  test('repo-mismatch: a constrained binding refuses foreign targets', async () => {
    const world = await seedWorld()
    const registry = buildRegistry({
      store: world.store,
      clock,
      allowedRepo: repo,
    })
    const error = await registry
      .call('builds.get', { repo: 'acme/other', slug: 'demo' }, { identity: 'Ada' })
      .catch((e) => e)
    expect(error).toBeInstanceOf(RegistryError)
    expect((error as RegistryError).reason).toBe('repo-mismatch')
    const ok = await registry.call('builds.get', { repo, slug: 'demo' }, { identity: 'Ada' })
    expect(ok).toBeDefined()
  })

  test('unknown tools are refused, not improvised', async () => {
    const world = await seedWorld()
    const registry = buildRegistry({ store: world.store, clock })
    const error = await registry.call('sandbox.publish', {}).catch((e) => e)
    expect(error).toBeInstanceOf(RegistryError)
    expect((error as RegistryError).reason).toBe('unknown-tool')
  })

  test('the hosted sandbox mode serves the capability table and refuses per call with a typed reason', async () => {
    const world = await seedWorld()
    const sandboxNames = TOOLS.map((tool) => tool.name).filter((name) =>
      name.startsWith('sandbox.'),
    )
    const names = (table: readonly { name: string }[]) => table.map((tool) => tool.name)
    expect(sandboxNames).toHaveLength(11)
    expect(names(operatorToolTable()).filter((name) => name.startsWith('sandbox.'))).toEqual([])
    expect(names(operatorToolTable({ canPublish: false }))).toEqual(
      names(TOOLS).filter((name) => name !== 'sandbox.publish'),
    )
    expect(operatorToolTable({ canPublish: true })).toBe(TOOLS)

    const noPublish = buildRegistry({
      store: world.store,
      clock,
      sandboxResolution: { canPublish: false },
    })
    expect(noPublish.entries).toEqual(operatorToolTable({ canPublish: false }))
    const unpublished = await noPublish
      .call('sandbox.publish', { repo, title: 't' }, { identity: 'Ada' })
      .catch((e) => e)
    expect((unpublished as RegistryError).reason).toBe('unknown-tool')

    const hosted = buildRegistry({
      store: world.store,
      clock,
      sandboxResolution: { canPublish: true },
    })
    expect(hosted.entries).toBe(TOOLS)
    let resolved = 0
    const sandboxFor = async () => {
      resolved++
      throw new SandboxUnavailableError('orchestrator-disabled', 'repository disables it')
    }
    const refused = await hosted
      .call('sandbox.exec', { repo, command: 'ls' }, { identity: 'Ada', sandboxFor })
      .catch((e) => e)
    expect((refused as RegistryError).body).toEqual({
      kind: 'refusal',
      error: 'repository disables it',
      code: 'sandbox-orchestrator-disabled',
    })
    await hosted.call('builds.list', { repo }, { identity: 'Ada', sandboxFor })
    expect(resolved).toBe(1)
  })
})

test('state tools and HTTP routes preserve full metadata and duplicate refusals', async () => {
  const world = await seedWorld()
  const states = [{ name: 'icebox', tickets: 0, about: 'Deferred' }]
  Object.assign(world.source, {
    listStates: async () => states,
    addState: async (name: string, opts: { about?: string } = {}) => {
      if (states.some((s) => s.name.toLowerCase() === name.toLowerCase()))
        throw new Error('state already exists')
      const state = { name, tickets: 0, about: opts.about ?? '' }
      states.push(state)
      return { state, created: true }
    },
  })
  const registry = buildRegistry({ store: world.store, tickets: world.backend, clock })
  expect(await registry.call('tickets.states', { repo })).toEqual(states)
  const server = createOperatorServer({
    store: world.store,
    secret,
    projects: testProjects([repo]),
    clock,
    ticketBackend: world.backend,
  })
  const http = api(server)
  expectEqual(
    (await http('GET', `/operator/v1/repos/${encodeURIComponent(repo)}/tickets/states`)).body,
    states,
  )
  const createdHttp = await http(
    'POST',
    `/operator/v1/repos/${encodeURIComponent(repo)}/tickets/states`,
    { name: 'http', about: 'Through HTTP' },
  )
  expect(createdHttp.status).toBe(201)
  expectEqual(createdHttp.body, {
    state: { name: 'http', tickets: 0, about: 'Through HTTP' },
    created: true,
  })

  const result = await registry.call(
    'tickets.state.create',
    { repo, name: 'later', about: 'Waiting' },
    { identity: 'Ada' },
  )
  expect(result).toEqual({ state: { name: 'later', tickets: 0, about: 'Waiting' }, created: true })
  const duplicate = await registry
    .call('tickets.state.create', { repo, name: 'later' }, { identity: 'Ada' })
    .catch((e) => e)
  expect(duplicate).toBeInstanceOf(RegistryError)
  expect((duplicate as RegistryError).body.error).toContain('already exists')
})

test('actual builds.answer registry revises collecting nodes with body and ticket origin and operator attribution', async () => {
  for (const origin of ['body', 'ticket'] as const) {
    const world = await seedWorld()
    await world.store.createBuild({
      slug: 'node-revision',
      repo,
      ticket: { source: 'hosted', id: 'AUT-1' },
    })
    await world.store.append('node-revision', {
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        repo,
        ticket: { source: 'hosted', id: 'AUT-1' },
        baseBranch: 'main',
        kind: 'node',
      },
    })
    await world.store.append('node-revision', {
      actor: DISPATCHER,
      type: 'node.opened',
      payload: { sha: 'parent' },
    })
    const registry = buildRegistry({ store: world.store, tickets: world.backend, clock })
    const result = await registry.call(
      'builds.answer',
      {
        repo,
        slug: 'node-revision',
        resolution: 'revise-spec',
        origin,
        body: CONFORMING_SPEC,
      },
      { identity: 'Ada', via: { kind: 'mcp', client: 'contract' } },
    )
    expect(result).toMatchObject({ kind: 'answered', nodeRevision: true, count: 0, specRev: 0 })
    expect((await world.store.getEvents('node-revision')).at(-1)).toMatchObject({
      actor: KERNEL,
      type: 'spec.revised',
      payload: {
        operator: { user: 'Ada', via: { kind: 'mcp', client: 'contract' } },
      },
    })
    const refused = await toolFailure(() =>
      registry.call(
        'builds.answer',
        {
          repo: 'other/repo',
          slug: 'node-revision',
          resolution: 'revise-spec',
          origin,
          body: CONFORMING_SPEC,
        },
        { identity: 'Ada' },
      ),
    )
    expect(refused.kind).toBeDefined()
  }
})
