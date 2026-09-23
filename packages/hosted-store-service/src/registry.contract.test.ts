import { describe, expect, test } from 'bun:test'
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
import { buildRegistry, RegistryError, TOOLS } from '@defrex/autobuild/operator'
import { createOperatorServer } from './operator-server'
import type { BuildStore } from '@defrex/autobuild/plugin-sdk'
import type { OperatorTicketBackend } from '@defrex/autobuild/operator'

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
        ref: { source: 'fake', id: 'AUT-1', title: 'Seeded ticket' },
        title: 'Seeded ticket',
        body: 'seed body',
        state: 'Todo',
        labels: ['web'],
      },
      {
        ref: { source: 'fake', id: 'AUT-2', title: 'Queued ticket' },
        title: 'Queued ticket',
        body: 'queued body',
        state: 'Backlog',
        labels: [],
      },
    ],
    { createState: 'Backlog', doneState: 'Done' },
  )
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

const TOKEN = mintToken(secret, { operator: { user: 'Ada' }, exp: now.getTime() + 60_000 })

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
  })

  test('builds.list matches the builds route for every scope', async () => {
    const world = await seedWorld()
    const server = createOperatorServer({ store: world.store, secret, clock })
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
    const server = createOperatorServer({ store: world.store, secret, clock })
    const call = api(server)
    const tool = (await toolFor(world)('builds.get', { repo, slug: 'demo' })) as object
    const route = await call('GET', `/operator/v1/repos/${encodeURIComponent(repo)}/builds/demo`)
    expectEqual(tool, route.body)
    expectJsonClean(tool)
  })

  test('builds.artifact parity: decoded bytes equal the route body and its artifact headers', async () => {
    const world = await seedWorld()
    const server = createOperatorServer({ store: world.store, secret, clock })
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

  test('builds.control matches the control route for an accepted command', async () => {
    const [routeWorld, toolWorld] = await Promise.all([seedWorld(), seedWorld()])
    const route = await api(createOperatorServer({ store: routeWorld.store, secret, clock }))(
      'POST',
      `/operator/v1/repos/${encodeURIComponent(repo)}/builds/demo/control`,
      { action: 'auto-merge-on' },
    )
    const tool = await toolFor(toolWorld)('builds.control', {
      repo,
      slug: 'demo',
      action: 'auto-merge-on',
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
    const route = await api(createOperatorServer({ store: routeWorld.store, secret, clock }))(
      'POST',
      `/operator/v1/repos/${encodeURIComponent(repo)}/builds/pausing-b/control`,
      { action: 'cancel-pause' },
    )
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
    const route = await api(createOperatorServer({ store: routeWorld.store, secret, clock }))(
      'POST',
      `/operator/v1/repos/${encodeURIComponent(repo)}/builds/demo/answer`,
      { resolution: 'guidance', text: 'take the smaller cut' },
    )
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
    const route2 = await api(createOperatorServer({ store: routeWorld2.store, secret, clock }))(
      'POST',
      `/operator/v1/repos/${encodeURIComponent(repo)}/builds/demo/answer`,
      { resolution: 'revise-spec', origin: 'body', body: CONFORMING_SPEC },
    )
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
    const route = await api(createOperatorServer({ store: world.store, secret, clock }))(
      'GET',
      `/operator/v1/repos/${encodeURIComponent(repo)}/status`,
    )
    const tool = await toolFor(world)('repository.status', { repo })
    expectEqual(tool, route.body)
    expectJsonClean(tool)
  })

  test('repository.settings matches set and toggle on their routes', async () => {
    // Explicit set (PUT on the route).
    const [routeWorld, toolWorld] = await Promise.all([seedWorld(), seedWorld()])
    const route = await api(createOperatorServer({ store: routeWorld.store, secret, clock }))(
      'PUT',
      `/operator/v1/repos/${encodeURIComponent(repo)}/settings/intake`,
      { enabled: false },
    )
    const tool = await toolFor(toolWorld)('repository.settings', {
      repo,
      setting: 'intake',
      enabled: false,
    })
    expectEqual(tool, route.body)
    expectJsonClean(tool)

    // Toggle (POST …/toggle on the route).
    const [routeWorld2, toolWorld2] = await Promise.all([seedWorld(), seedWorld()])
    const route2 = await api(createOperatorServer({ store: routeWorld2.store, secret, clock }))(
      'POST',
      `/operator/v1/repos/${encodeURIComponent(repo)}/settings/auto-merge-default/toggle`,
    )
    const tool2 = await toolFor(toolWorld2)('repository.settings', {
      repo,
      setting: 'auto-merge-default',
    })
    expectEqual(tool2, route2.body)
    expectJsonClean(tool2)
  })

  test('repository.bulk_control matches the bulk-control route', async () => {
    const [routeWorld, toolWorld] = await Promise.all([seedWorld(), seedWorld()])
    const route = await api(createOperatorServer({ store: routeWorld.store, secret, clock }))(
      'POST',
      `/operator/v1/repos/${encodeURIComponent(repo)}/bulk-control`,
      { action: 'pause' },
    )
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
      createOperatorServer({ store: breakWalk(routeWorld.store), secret, clock }),
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
    const route = await api(createOperatorServer({ store: world.store, secret, clock }))(
      'GET',
      `/operator/v1/repos/${encodeURIComponent(repo)}/harvest/status`,
    )
    const tool = await toolFor(world)('harvest.status', { repo })
    expectEqual(tool, route.body)
    expectJsonClean(tool)
  })

  test('harvest.control matches the harvest control route', async () => {
    const [routeWorld, toolWorld] = await Promise.all([seedWorld(), seedWorld()])
    const route = await api(createOperatorServer({ store: routeWorld.store, secret, clock }))(
      'POST',
      `/operator/v1/repos/${encodeURIComponent(repo)}/harvest/control`,
      { action: 'toggle-gate' },
    )
    const tool = await toolFor(toolWorld)('harvest.control', { repo, action: 'toggle-gate' })
    expectEqual(tool, route.body)
    expectJsonClean(tool)
  })

  test('tickets.list matches the ticket queue route with filters', async () => {
    const world = await seedWorld()
    const server = createOperatorServer({
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

  test('tickets.get matches the ticket detail route', async () => {
    const world = await seedWorld()
    const route = await api(
      createOperatorServer({ store: world.store, secret, clock, ticketBackend: world.backend }),
    )('GET', `/operator/v1/repos/${encodeURIComponent(repo)}/tickets/AUT-1`)
    const tool = await toolFor(world)('tickets.get', { repo, id: 'AUT-1' })
    expectEqual(tool, route.body)
    expectJsonClean(tool)
  })

  test('tickets.create matches the create route', async () => {
    const [routeWorld, toolWorld] = await Promise.all([seedWorld(), seedWorld()])
    const request = { title: 'Fresh', body: 'fresh body', labels: ['web'], blockedBy: ['AUT-2'] }
    const route = await api(
      createOperatorServer({
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

  test('tickets.block and tickets.unblock match their routes', async () => {
    const [routeWorld, toolWorld] = await Promise.all([seedWorld(), seedWorld()])
    const route = await api(
      createOperatorServer({
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

  test('tickets.move matches the move route', async () => {
    const [routeWorld, toolWorld] = await Promise.all([seedWorld(), seedWorld()])
    const route = await api(
      createOperatorServer({
        store: routeWorld.store,
        secret,
        clock,
        ticketBackend: routeWorld.backend,
      }),
    )('POST', `/operator/v1/repos/${encodeURIComponent(repo)}/tickets/AUT-2/move`, {
      state: 'Todo',
    })
    const tool = await toolFor(toolWorld)('tickets.move', { repo, id: 'AUT-2', state: 'Todo' })
    expectEqual(tool, route.body)
    expectJsonClean(tool)
  })

  test('mapped failure bodies equal their routes, per tool', async () => {
    // Not-found build through the query service (OperatorQueryError path).
    const queryWorld = await seedWorld()
    const queryRoute = await api(createOperatorServer({ store: queryWorld.store, secret, clock }))(
      'GET',
      `/operator/v1/repos/${encodeURIComponent(repo)}/builds/missing`,
    )
    expect(queryRoute.status).toBe(404)
    const queryFailure = await toolFailure(() =>
      toolFor(queryWorld)('builds.get', { repo, slug: 'missing' }),
    )
    expectEqual(queryFailure, queryRoute.body as Record<string, unknown>)

    // Unknown build through the control glue (requireRouteBuild path, no code).
    const controlWorld = await seedWorld()
    const controlRoute = await api(
      createOperatorServer({ store: controlWorld.store, secret, clock }),
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
      createOperatorServer({ store: inactiveWorld.store, secret, clock }),
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
      createOperatorServer({ store: pausingRouteWorld.store, secret, clock }),
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
      createOperatorServer({ store: runningRouteWorld.store, secret, clock }),
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
      createOperatorServer({ store: answerWorld.store, secret, clock }),
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
      createOperatorServer({ store: artifactWorld.store, secret, clock }),
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
      ['builds.artifact', { repo, slug: 'demo', kind: 'notes', rev: -3 }],
      ['builds.control', { repo, slug: 'demo', action: 'explode' }],
      ['builds.answer', { repo, slug: 'demo', resolution: 'guidance' }],
      ['repository.bulk_control', { repo, action: 'restart' }],
      ['tickets.block', { repo, id: 'AUT-1', blockerIds: [] }],
      ['tickets.update', { repo, id: 'AUT-1' }],
      ['notes.write', { repo }],
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
      'builds.control': { repo, slug: 'demo', action: 'auto-merge-on' },
      'builds.answer': { repo, slug: 'demo', resolution: 'guidance', text: 'hi' },
      'repository.settings': { repo, setting: 'intake', enabled: true },
      'repository.bulk_control': { repo, action: 'pause' },
      'harvest.control': { repo, action: 'toggle-gate' },
      'tickets.list': { repo },
      'tickets.get': { repo, id: 'AUT-1' },
      'tickets.create': { repo, title: 't', body: 'b' },
      'tickets.update': { repo, id: 'AUT-1', title: 'new' },
      'tickets.block': { repo, id: 'AUT-1', blockerIds: ['AUT-2'] },
      'tickets.unblock': { repo, id: 'AUT-1', blockerIds: ['AUT-2'] },
      'tickets.move': { repo, id: 'AUT-2', state: 'Todo' },
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
      'builds.get': { repo, slug: 'demo' },
      'builds.events': { repo, slug: 'demo', cursor: 0 },
      'builds.artifact': { repo, slug: 'demo', kind: 'notes' },
      'repository.status': { repo },
      'harvest.status': { repo },
      'tickets.list': { repo },
      'tickets.get': { repo, id: 'AUT-1' },
      'notes.read': { repo },
    }
    for (const name of reads) {
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

  test('builds.events matches its documented seam: store.getEvents after the cursor', async () => {
    const world = await seedWorld()
    const registry = buildRegistry({ store: world.store, clock })
    const cursor = 2
    const result = (await registry.call('builds.events', {
      repo,
      slug: 'demo',
      cursor,
    })) as { events: unknown[]; cursor: number }
    const seam = await world.store.getEvents('demo', cursor)
    expectEqual(result.events, seam)
    expect(result.cursor).toBe(seam.at(-1)!.seq)
    expectJsonClean(result)
  })

  test('builds.events bounded wait: a new event ends the wait, silence returns empty at the deadline', async () => {
    const world = await seedWorld()
    const registry = buildRegistry({ store: world.store, clock })
    const latest = (await world.store.getEvents('demo')).at(-1)!.seq
    // A wait that lands on silence returns an empty page after the bounded
    // wait (minimum schema granularity: one second).
    const started = Date.now()
    const empty = (await registry.call('builds.events', {
      repo,
      slug: 'demo',
      cursor: latest,
      waitSeconds: 1,
    })) as { events: unknown[]; cursor: number }
    expectEqual(empty.events, [])
    expect(empty.cursor).toBe(latest)
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000)

    // A wait that lands on a new event returns it immediately.
    const waiting = registry.call('builds.events', {
      repo,
      slug: 'demo',
      cursor: latest,
      waitSeconds: 10,
    }) as Promise<{ events: { type: string }[] }>
    await new Promise((resolve) => setTimeout(resolve, 750))
    await world.store.append('demo', {
      actor: humanActor('Ada'),
      type: 'build.pause-requested',
      payload: {},
    })
    const page = await waiting
    expectEqual(
      page.events.map((event) => event.type),
      ['build.pause-requested'],
    )
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
})

describe('sandbox registry tools (AUT-340)', () => {
  async function sandboxWorld() {
    const world = await seedWorld()
    const { FakeWorkspaceProvider } = await import('@defrex/autobuild/plugin-sdk')
    const { createOperatorSandboxService } = await import('@defrex/autobuild/testing')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const workspaces = await mkdtemp(join(tmpdir(), 'ab-sandbox-registry-'))
    const source = await mkdtemp(join(tmpdir(), 'ab-sandbox-registry-src-'))
    await Bun.write(join(source, 'README.md'), 'hello\n')
    const provider = new FakeWorkspaceProvider({
      root: join(workspaces, 'wt'),
      sandboxRoot: join(workspaces, 'sb'),
      envSource: { PATH: process.env.PATH ?? '' },
    })
    const sandbox = await createOperatorSandboxService({
      store: world.store,
      repo: source,
      provider,
      sandbox: { idleMinutes: 30, environmentVariables: [] },
      baseBranch: 'main',
      clock,
    })
    return {
      world,
      sandbox,
      source,
      async cleanup() {
        await world.store.close()
        await rm(workspaces, { recursive: true, force: true })
        await rm(source, { recursive: true, force: true })
      },
    }
  }

  test('tool↔annotation lockstep covers the six sandbox tools', () => {
    for (const name of [
      'sandbox.exec',
      'sandbox.start',
      'sandbox.wait',
      'sandbox.read_file',
      'sandbox.write_file',
      'sandbox.reset',
    ]) {
      const tool = TOOLS.find((entry) => entry.name === name)
      expect(tool).toBeDefined()
      const table = OPERATOR_TOOL_ANNOTATIONS[name as keyof typeof OPERATOR_TOOL_ANNOTATIONS]
      expect(tool!.approval).toBe('default')
      expect(tool!.annotations).toEqual({
        readOnlyHint: table.readOnlyHint,
        destructiveHint: table.destructiveHint,
        idempotentHint: table.idempotentHint,
      })
    }
    expect(
      OPERATOR_TOOL_ANNOTATIONS['sandbox.reset' as keyof typeof OPERATOR_TOOL_ANNOTATIONS]
        .destructiveHint,
    ).toBe(true)
  })

  test('documented bounds ride on the descriptions', () => {
    for (const [name, bound] of [
      ['sandbox.exec', '300 seconds'],
      ['sandbox.exec', '65536 bytes'],
      ['sandbox.wait', 'only after exit'],
      ['sandbox.reset', 'Destructively'],
    ] as const) {
      expect(
        TOOLS.find((tool) => tool.name === name)!.description,
        `${name} must document "${bound}"`,
      ).toContain(bound)
    }
  })

  test('absence is enforced at dispatch too: no backend, no advertisement and no service', async () => {
    const world = await seedWorld()
    try {
      const registry = buildRegistry({ store: world.store, clock })
      expect(registry.entries.some((tool) => tool.name.startsWith('sandbox.'))).toBe(false)
      const error = await registry
        .call('sandbox.exec', { repo, command: 'true' }, { identity: 'Ada' })
        .catch((e) => e)
      expect(error).toBeInstanceOf(RegistryError)
      expect((error as RegistryError).reason).toBe('unknown-tool')
      expect((error as RegistryError).body).toMatchObject({ kind: 'not-found' })
    } finally {
      await world.store.close()
    }
  })

  test('with a backend the six tools advertise and execute end to end', async () => {
    const fx = await sandboxWorld()
    try {
      const registry = buildRegistry({ store: fx.world.store, clock, sandbox: fx.sandbox })
      expect(registry.entries.filter((tool) => tool.name.startsWith('sandbox.'))).toHaveLength(6)
      const result = (await registry.call(
        'sandbox.exec',
        { repo: fx.source, command: 'echo hi' },
        { identity: 'Ada' },
      )) as { exitCode: number; stdout: string }
      expect(result).toMatchObject({ exitCode: 0, stdout: 'hi\n' })
    } finally {
      await fx.cleanup()
    }
  })

  test('exec-timeout and not-found failures map to their stage codes; identity is required', async () => {
    const fx = await sandboxWorld()
    try {
      const registry = buildRegistry({ store: fx.world.store, clock, sandbox: fx.sandbox })
      const noIdentity = await registry
        .call('sandbox.exec', { repo: fx.source, command: 'true' })
        .catch((e) => e)
      expect(noIdentity).toBeInstanceOf(RegistryError)
      expect((noIdentity as RegistryError).reason).toBe('no-identity')

      const timeout = await registry
        .call(
          'sandbox.exec',
          { repo: fx.source, command: 'sleep 30', timeoutSeconds: 1 },
          { identity: 'Ada' },
        )
        .catch((e) => e)
      expect(timeout).toBeInstanceOf(RegistryError)
      expect((timeout as RegistryError).body).toMatchObject({
        kind: 'refusal',
        code: 'sandbox-exec-timeout',
      })

      const unknownCommand = await registry
        .call(
          'sandbox.wait',
          { repo: fx.source, commandId: 'sbcmd-gone', waitSeconds: 0 },
          { identity: 'Ada' },
        )
        .catch((e) => e)
      expect(unknownCommand).toBeInstanceOf(RegistryError)
      expect((unknownCommand as RegistryError).body).toMatchObject({
        kind: 'refusal',
        code: 'sandbox-not-found',
      })

      // A tool call naming a foreign repository is refused with the typed
      // sandbox body, not improvised.
      const foreign = await registry
        .call('sandbox.exec', { repo, command: 'true' }, { identity: 'Ada' })
        .catch((e) => e)
      expect(foreign).toBeInstanceOf(RegistryError)
      expect((foreign as RegistryError).body).toMatchObject({
        kind: 'refusal',
        code: 'sandbox-exec',
      })
    } finally {
      await fx.cleanup()
    }
  }, 20_000)

  test('path-escape refusals carry the typed body; read_file round-trips bytes', async () => {
    const fx = await sandboxWorld()
    try {
      const registry = buildRegistry({ store: fx.world.store, clock, sandbox: fx.sandbox })
      for (const path of ['../outside', '/abs']) {
        const error = await registry
          .call('sandbox.read_file', { repo: fx.source, path }, { identity: 'Ada' })
          .catch((e) => e)
        expect(error).toBeInstanceOf(RegistryError)
        expect((error as RegistryError).body).toMatchObject({ kind: 'refusal' })
      }
      const read = (await registry.call(
        'sandbox.read_file',
        { repo: fx.source, path: 'README.md' },
        { identity: 'Ada' },
      )) as { encoding: string; content: string }
      expect(read).toEqual({ encoding: 'utf8', content: 'hello\n' })
      await registry.call(
        'sandbox.write_file',
        {
          repo: fx.source,
          path: 'out/notes.txt',
          content: Buffer.from([0, 255]).toString('base64'),
          encoding: 'base64',
        },
        { identity: 'Ada' },
      )
      const binary = (await registry.call(
        'sandbox.read_file',
        { repo: fx.source, path: 'out/notes.txt' },
        { identity: 'Ada' },
      )) as { encoding: string; content: string }
      expect(binary.encoding).toBe('base64')
      expect(Buffer.from(binary.content, 'base64')).toEqual(Buffer.from([0, 255]))
      await registry.call('sandbox.reset', { repo: fx.source }, { identity: 'Ada' })
    } finally {
      await fx.cleanup()
    }
  })
})
