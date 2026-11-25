import { temporaryDirectories as ownTempDirectories } from '@defrex/autobuild/testing'
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
  RegistryError,
  repositoryNeedsAttention,
  TOOLS,
} from '@defrex/autobuild/operator'
import type { RepositoryEvent } from '@defrex/autobuild/plugin-sdk'
import type { OperatorTicketBackend } from '@defrex/autobuild/operator'

const mkdtemp = ownTempDirectories(afterEach)

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
const _CONFORMING_SPEC =
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
async function _seedPausing(): Promise<World> {
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

function _api(server: { fetch(req: Request): Promise<Response> }) {
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
function _toolFor(world: World) {
  const registry = buildRegistry({
    store: world.store,
    tickets: world.backend,
    clock,
  })
  return async (name: string, input: unknown): Promise<object> =>
    (await registry.call(name, input, { identity: 'Ada' })) as object
}

/** Tool failures surface as RegistryError; return the mapped failure body. */
async function _toolFailure(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
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
function _expectJsonClean(value: unknown): void {
  expectEqual(JSON.parse(JSON.stringify(value)), value)
}

describe('agent tool registry contract', () => {
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

  test('repository.events delivers exactly the ab watch repository attention set', async () => {
    const world = await seedWorld()
    const registry = buildRegistry({ store: world.store, clock })
    const baseline = (await registry.call('repository.events', { repo })) as {
      events: unknown[]
      cursor: number
      hasMore: boolean
    }
    expectEqual(baseline.events, [])
    expect(baseline.hasMore).toBe(false)
    await world.store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'ticket.handed-back',
      payload: {
        ticket: { source: 'file', id: 'AUT-1' },
        build: 'demo',
        cause: 'abort',
        state: 'Ready',
        role: 'ready',
      },
    })
    await world.store.appendRepo(repo, {
      actor: humanActor('Ada'),
      type: 'dispatcher.intake-set',
      payload: { enabled: true },
    })
    const appended = (await world.store.getRepoEvents(repo, baseline.cursor)) as RepositoryEvent[]
    const attention = (await registry.call('repository.events', {
      repo,
      cursor: baseline.cursor,
    })) as { events: RepositoryEvent[]; cursor: number }
    expectEqual(attention.events, appended.filter(repositoryNeedsAttention))
    expectEqual(
      attention.events.map((event) => event.type),
      ['ticket.handed-back'],
    )
    // The cursor advances past filtered events.
    expect(attention.cursor).toBe(appended.at(-1)!.seq)
    const all = (await registry.call('repository.events', {
      repo,
      cursor: baseline.cursor,
      filter: 'all',
    })) as { events: RepositoryEvent[] }
    expectEqual(all.events, appended)
    // A bounded wait ends on a new event.
    const waiting = registry.call('repository.events', {
      repo,
      cursor: attention.cursor,
      waitSeconds: 10,
    }) as Promise<{ events: { type: string }[] }>
    await new Promise((resolve) => setTimeout(resolve, 750))
    await world.store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'ticket.handed-back',
      payload: {
        ticket: { source: 'file', id: 'AUT-2' },
        attempt: 'prep',
        cause: 'spec-bounce',
        state: 'Triage',
        role: 'triage',
      },
    })
    expectEqual(
      (await waiting).events.map((event) => event.type),
      ['ticket.handed-back'],
    )
  })
})

describe('sandbox registry tools (AUT-340)', () => {
  async function sandboxWorld() {
    const world = await seedWorld()
    const { FakeWorkspaceProvider } = await import('@defrex/autobuild/plugin-sdk')
    const { createOperatorSandboxService } = await import('@defrex/autobuild/testing')
    const { rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const workspaces = await mkdtemp(join(tmpdir(), 'ab-sandbox-registry-'))
    const source = await mkdtemp(join(tmpdir(), 'ab-sandbox-registry-src-'))
    await Bun.write(join(source, 'README.md'), 'hello\n')
    const { FakeForge } = await import('@defrex/autobuild/plugin-sdk')
    const provider = new FakeWorkspaceProvider({
      root: join(workspaces, 'wt'),
      sandboxRoot: join(workspaces, 'sb'),
      envSource: { PATH: process.env.PATH ?? '' },
    })
    const forge = new FakeForge()
    const sandbox = await createOperatorSandboxService({
      store: world.store,
      repo: source,
      provider,
      sandbox: { idleMinutes: 30, environmentVariables: [] },
      baseBranch: 'main',
      forge,
      clock,
    })
    // Every tool but open/status refuses until the environment is ready.
    await sandbox.open('Ada', { repo: source })
    await sandbox.settled('Ada')
    return {
      world,
      sandbox,
      forge,
      source,
      async cleanup() {
        await world.store.close()
        await rm(workspaces, { recursive: true, force: true })
        await rm(source, { recursive: true, force: true })
      },
    }
  }

  test('tool↔annotation lockstep covers every sandbox tool', () => {
    for (const name of [
      'sandbox.open',
      'sandbox.status',
      'sandbox.close',
      'sandbox.refresh',
      'sandbox.exec',
      'sandbox.start',
      'sandbox.wait',
      'sandbox.read_file',
      'sandbox.write_file',
      'sandbox.reset',
      'sandbox.publish',
    ]) {
      const tool = TOOLS.find((entry) => entry.name === name)
      expect(tool).toBeDefined()
      const table = OPERATOR_TOOL_ANNOTATIONS[name as keyof typeof OPERATOR_TOOL_ANNOTATIONS]
      expect(tool!.approval).toBe(table.approval)
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

  test('with a backend every sandbox tool advertises and executes end to end', async () => {
    const fx = await sandboxWorld()
    try {
      const registry = buildRegistry({ store: fx.world.store, clock, sandbox: fx.sandbox })
      expect(registry.entries.filter((tool) => tool.name.startsWith('sandbox.'))).toHaveLength(11)
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

  test('without a forge, sandbox.publish is filtered and refused as unknown-tool', async () => {
    const world = await seedWorld()
    const { FakeWorkspaceProvider } = await import('@defrex/autobuild/plugin-sdk')
    const { createOperatorSandboxService: createSandbox } = await import(
      '@defrex/autobuild/testing'
    )
    const { rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const workspaces = await mkdtemp(join(tmpdir(), 'ab-sandbox-noforge-'))
    const source = await mkdtemp(join(tmpdir(), 'ab-sandbox-noforge-src-'))
    await Bun.write(join(source, 'README.md'), 'hello\n')
    try {
      const provider = new FakeWorkspaceProvider({
        sandboxRoot: join(workspaces, 'sb'),
        envSource: { PATH: process.env.PATH ?? '' },
      })
      const sandbox = await createSandbox({
        store: world.store,
        repo: source,
        provider,
        sandbox: { idleMinutes: 30, environmentVariables: [] },
        baseBranch: 'main',
        clock,
      })
      const registry = buildRegistry({ store: world.store, clock, sandbox })
      expect(sandbox.canPublish).toBe(false)
      expect(registry.entries.some((tool) => tool.name === 'sandbox.publish')).toBe(false)
      expect(registry.entries.filter((tool) => tool.name.startsWith('sandbox.'))).toHaveLength(10)
      const error = await registry
        .call('sandbox.publish', { repo: source, title: 'Fix' }, { identity: 'Ada' })
        .catch((e) => e)
      expect(error).toBeInstanceOf(RegistryError)
      expect((error as RegistryError).reason).toBe('unknown-tool')
    } finally {
      await world.store.close()
      await rm(workspaces, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
    }
  })

  test('sandbox.publish round-trips end to end with a JSON-serializable result', async () => {
    const fx = await sandboxWorld()
    try {
      const registry = buildRegistry({ store: fx.world.store, clock, sandbox: fx.sandbox })
      // Make a real commit so the checkout head is a descendant of the base.
      await registry.call(
        'sandbox.exec',
        {
          repo: fx.source,
          command: 'echo change >> README.md && git add README.md && git commit -q -m change',
        },
        { identity: 'Ada' },
      )
      const result = (await registry.call(
        'sandbox.publish',
        { repo: fx.source, title: 'Fix login', body: 'small fix' },
        { identity: 'Ada', via: { kind: 'session', id: 'sess-9' } },
      )) as {
        branch: string
        sha: string
        pr: { number: number; url: string; headSha: string }
      }
      expect(result.branch).toMatch(/^ab\/orch-ada-[0-9a-f]{8}$/)
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/)
      expect(result.pr).toMatchObject({ number: 1, url: expect.any(String) })
      JSON.stringify(result)
      const events = await fx.world.store.getRepoStateEvents(fx.source)
      const published = events.find((event) => event.type === 'orchestrator.sandbox.published')!
      expect(published.payload).toMatchObject({
        operator: 'Ada',
        session: 'sess-9',
        branch: result.branch,
      })
    } finally {
      await fx.cleanup()
    }
  }, 20_000)

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
      // Reset returns while the fresh provision runs in the background.
      expect(
        await registry.call('sandbox.reset', { repo: fx.source }, { identity: 'Ada' }),
      ).toMatchObject({ state: 'provisioning' })
      await fx.sandbox.settled('Ada')
    } finally {
      await fx.cleanup()
    }
  })
})
