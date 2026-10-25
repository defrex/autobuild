/**
 * End-to-end tests for `ab mcp` — the stdio binding of the agent tool
 * registry, driven over a REAL process boundary with the MCP SDK client
 * (bin-ab.test.ts pattern: spawn the real binary, never runCli).
 *
 * The SDK evidence for every relied-upon shape (registerTool with Zod 4
 * schemas, annotation forwarding, typed -32602 rejection before the handler,
 * StdioServerTransport ↔ StdioClientTransport round-trip) is recorded in the
 * plan; these tests fail loudly on any version-drift regression.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { KERNEL, DISPATCHER } from '../events/envelope'
import { openLocalStore } from '../store/local/store'

const ROOT = join(import.meta.dir, '..', '..', '..', '..')
const BIN = join(ROOT, 'bin', 'ab.ts')
const TOOL_NAMES = 26

let tmp: string
let storeDir: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ab-mcp-'))
  storeDir = join(tmp, 'store')
  await Bun.write(join(tmp, 'autobuild.toml'), '[tickets]\nsource = "file"\nreadyState = "ready"\n')
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function bareEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
  }
}

async function seed(): Promise<void> {
  const local = openLocalStore(storeDir)
  await local.createBuild({ slug: 'demo', repo: await realpath(tmp) })
  await local.append('demo', {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'runner-1', host: 'host-1', resumedFromSeq: 0 },
  })
  await local.putArtifact('demo', { kind: 'notes', content: new Uint8Array([0, 1, 255, 128]) })
  await local.close()
}

async function connect(env: Record<string, string> = bareEnv()): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: [BIN, 'mcp', '--store', storeDir],
    cwd: tmp,
    env,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'mcp-contract-test', version: '0.0.0' })
  await client.connect(transport)
  return client
}

test('ab mcp advertises the registry: 26 tools with schemas and annotations', async () => {
  await seed()
  const client = await connect()
  try {
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(TOOL_NAMES)
    const names = tools.map((tool) => tool.name).sort()
    expect(names).toContain('builds.list')
    expect(names).toContain('builds.restack')
    expect(names).toContain('landings.list')
    expect(names).toContain('tickets.tree')
    expect(names).toContain('notes.write')
    expect(names).toContain('tickets.move')
    const buildsList = tools.find((tool) => tool.name === 'builds.list')!
    // Per-field descriptions survive the wire as JSON Schema.
    expect((buildsList.inputSchema as Record<string, unknown>).type).toBe('object')
    const properties = (buildsList.inputSchema as Record<string, unknown>).properties as Record<
      string,
      { description?: string }
    >
    expect(properties.repo?.description).toContain('Repository identity')
    expect(buildsList.annotations).toMatchObject({ readOnlyHint: true })
    const buildsControl = tools.find((tool) => tool.name === 'builds.control')!
    expect(buildsControl.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    })
    const notesRead = tools.find((tool) => tool.name === 'notes.read')!
    expect(notesRead.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
  } finally {
    await client.close()
  }
})

test('ab mcp serves reads over stdio, byte-safe artifacts included', async () => {
  await seed()
  const client = await connect()
  try {
    const listing = await client.callTool({
      name: 'builds.list',
      arguments: { repo: await realpath(tmp), scope: 'all' },
    })
    expect(listing.isError).toBeUndefined()
    const summaries = JSON.parse((listing.content as { text: string }[])[0]!.text) as {
      slug: string
    }[]
    expect(summaries.map((summary) => summary.slug)).toEqual(['demo'])

    const artifact = await client.callTool({
      name: 'builds.artifact',
      arguments: { repo: await realpath(tmp), slug: 'demo', kind: 'notes' },
    })
    const decoded = JSON.parse((artifact.content as { text: string }[])[0]!.text) as {
      meta: { kind: string; revision: number }
      contentBase64: string
    }
    expect(decoded.meta).toMatchObject({ kind: 'notes', revision: 0 })
    // Round-trip the bytes: contentBase64 decodes to the exact deposited bytes.
    expect([...Buffer.from(decoded.contentBase64, 'base64')]).toEqual([0, 1, 255, 128])

    // Invalid input is rejected by the schema before any handler runs.
    const bad = await client.callTool({
      name: 'builds.list',
      arguments: { repo: await realpath(tmp), scope: 'nope' },
    })
    expect(bad.isError).toBe(true)
  } finally {
    await client.close()
  }
})

test('a mutating call attributes its durable write to the operator identity', async () => {
  await seed()
  // Pin the operator identity explicitly: the SDK's stdio transport merges the
  // host's default environment (USER included) under the env it is given, so
  // relying on the "dashboard" fallback would make the expectation depend on
  // whether the machine running the suite exports USER.
  const client = await connect({ ...bareEnv(), USER: 'operator-1' })
  try {
    const result = await client.callTool({
      name: 'repository.settings',
      arguments: { repo: await realpath(tmp), setting: 'intake', enabled: false },
    })
    expect(result.isError).toBeUndefined()
    const body = JSON.parse((result.content as { text: string }[])[0]!.text) as { enabled: boolean }
    expect(body.enabled).toBe(false)
  } finally {
    await client.close()
  }

  // The client closed above, and the write is already durable: attributed to
  // the sessionless operator identity, with the via marker naming the connected
  // MCP client learned at the initialize handshake.
  const reopened = openLocalStore(storeDir)
  const event = (await reopened.getRepoEvents(await realpath(tmp))).at(-1)
  expect(event?.type).toBe('dispatcher.intake-set')
  expect(event?.actor).toEqual({
    kind: 'human',
    user: 'operator-1',
    via: { kind: 'mcp', client: 'mcp-contract-test' },
  })
  await reopened.close()
})

test('ab mcp fails closed inside a phase session, before any MCP traffic', async () => {
  const env = {
    ...bareEnv(),
    AB_STORE: storeDir,
    AB_BUILD: 'demo',
    AB_PHASE: 'implement@1',
    AB_SESSION: 'session-1',
  }
  const complete = Bun.spawn(['bun', BIN, 'mcp', '--store', storeDir], {
    cwd: tmp,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(complete.stdout).text(),
    new Response(complete.stderr).text(),
    complete.exited,
  ])
  expect(code).toBe(1)
  expect(stderr).toContain('cannot run inside a phase session')
  expect(stdout).toBe('')

  const malformed = Bun.spawn(['bun', BIN, 'mcp', '--store', storeDir], {
    cwd: tmp,
    env: { ...bareEnv(), AB_STORE: storeDir, AB_PHASE: 'implement@1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [malformedOut, malformedErr, malformedCode] = await Promise.all([
    new Response(malformed.stdout).text(),
    new Response(malformed.stderr).text(),
    malformed.exited,
  ])
  expect(malformedCode).toBe(1)
  expect(malformedErr).toContain('cannot run inside a phase session')
  expect(malformedOut).toBe('')
})

test('with [orchestrator] enabled the seven sandbox tools advertise and one round trip works', async () => {
  // A real local git checkout with a main branch: the git-worktree sandbox
  // provisions a detached worktree from it.
  const gitInit = Bun.spawn(['git', 'init', '-q', '-b', 'main', '.'], {
    cwd: tmp,
    stdout: 'ignore',
    stderr: 'ignore',
  })
  if ((await gitInit.exited) !== 0) throw new Error('git init failed')
  const commit = Bun.spawn(
    [
      'git',
      '-c',
      'user.email=ab@test.invalid',
      '-c',
      'user.name=ab-test',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'seed',
    ],
    { cwd: tmp, env: bareEnv(), stdout: 'ignore', stderr: 'ignore' },
  )
  if ((await commit.exited) !== 0) throw new Error('git commit failed')
  await Bun.write(
    join(tmp, 'autobuild.toml'),
    '[tickets]\nsource = "file"\nreadyState = "ready"\n\n[orchestrator]\nenabled = true\n',
  )
  await seed()
  const client = await connect()
  try {
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(TOOL_NAMES + 7)
    const names = tools.map((tool) => tool.name).sort()
    for (const name of [
      'sandbox.exec',
      'sandbox.start',
      'sandbox.wait',
      'sandbox.read_file',
      'sandbox.write_file',
      'sandbox.reset',
      'sandbox.publish',
    ]) {
      expect(names).toContain(name)
    }
    const exec = tools.find((tool) => tool.name === 'sandbox.exec')!
    expect(exec.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    const reset = tools.find((tool) => tool.name === 'sandbox.reset')!
    expect(reset.annotations).toMatchObject({ destructiveHint: true })
    const publish = tools.find((tool) => tool.name === 'sandbox.publish')!
    expect(publish.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    })

    const roundTrip = await client.callTool({
      name: 'sandbox.exec',
      arguments: { repo: await realpath(tmp), command: 'echo round-trip' },
    })
    expect(roundTrip.isError).toBeUndefined()
    const body = JSON.parse((roundTrip.content as { text: string }[])[0]!.text) as {
      exitCode: number
      stdout: string
    }
    expect(body).toMatchObject({ exitCode: 0 })
    expect(body.stdout).toContain('round-trip')
  } finally {
    await client.close()
  }
})

import { buildMcpTicketBackend } from './mcp'
import { parseConfig } from '../config/load'

test('local MCP keeps file tickets usable without a team key', async () => {
  const config = parseConfig(await Bun.file(join(tmp, 'autobuild.toml')).text())
  const backend = await buildMcpTicketBackend({
    targetRepo: tmp,
    checkout: tmp,
    localStateRoot: storeDir,
    env: {},
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    stdout: () => {},
    stderr: () => {},
  })
  const source = await backend.sourceFor({ repo: tmp, tickets: config.tickets, teamKey: '' })
  const created = await source.create({ title: 'Local ticket', body: 'Spec' })
  expect((await source.get(created.ref.id))?.title).toBe('Local ticket')
})

test('MCP ticket tools expose node kind and nullable target, with metadata-only guarded updates', async () => {
  await seed()
  const repo = await realpath(tmp)
  const local = openLocalStore(storeDir)
  await local.ensureRepo(repo)
  const config = parseConfig(await Bun.file(join(tmp, 'autobuild.toml')).text())
  const { verify, finalize, ...root } = config
  const artifact = await local.putRepoArtifact(repo, {
    kind: 'dispatcher-effective-config',
    content: JSON.stringify({
      ...root,
      verify: { steps: verify.steps, ...verify.stepConfigs },
      finalize: { steps: finalize.steps, ...finalize.stepConfigs },
    }),
  })
  await local.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.run-started',
    payload: {
      run: 'run-1',
      pid: 1,
      effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
      roleWarnings: [],
    },
  })
  await local.close()
  const client = await connect()
  const resultTicket = (result: Awaited<ReturnType<Client['callTool']>>) => {
    const content = result.content as Array<{ type: string; text?: string }>
    const body = JSON.parse(content.find((item) => item.type === 'text')!.text!)
    if (result.isError) throw new Error(JSON.stringify(body))
    return body.ticket
  }
  try {
    const node = resultTicket(
      await client.callTool({
        name: 'tickets.create',
        arguments: { repo, title: 'Node', body: 'spec', kind: 'node' },
      }),
    )
    expect(node.kind).toBe('node')
    const child = resultTicket(
      await client.callTool({
        name: 'tickets.create',
        arguments: { repo, title: 'Child', body: 'spec', target: node.ref.id },
      }),
    )
    expect(child.kind).toBe('work')
    expect(child.target).toBe(node.ref.id)
    const cleared = resultTicket(
      await client.callTool({
        name: 'tickets.update',
        arguments: { repo, id: child.ref.id, target: null, expectedRevision: child.revision },
      }),
    )
    expect(cleared.target).toBeUndefined()
    const shown = resultTicket(
      await client.callTool({ name: 'tickets.get', arguments: { repo, id: node.ref.id } }),
    )
    expect(shown.kind).toBe('node')
  } finally {
    await client.close()
  }
})

test('MCP builds.events forwards failed-node attention intact and respects its cursor', async () => {
  await seed()
  const local = openLocalStore(storeDir)
  const event = await local.append('demo', {
    actor: KERNEL,
    type: 'integration.verification-failed',
    payload: {
      id: 'cycle',
      head: 'a'.repeat(40),
      parent: 'b'.repeat(40),
      steps: ['unit'],
      guidance: 'file a repair child targeting this node: demo',
    },
  })
  await local.close()
  const client = await connect()
  try {
    const call = async (cursor: number) => {
      const result = await client.callTool({
        name: 'builds.events',
        arguments: { repo: await realpath(tmp), slug: 'demo', cursor },
      })
      expect(result.isError).toBeUndefined()
      return JSON.parse((result.content as { text: string }[])[0]!.text)
    }
    expect(await call(event.seq - 1)).toEqual({ events: [event], cursor: event.seq })
    expect(await call(event.seq)).toEqual({ events: [], cursor: event.seq })
  } finally {
    await client.close()
  }
})

test('MCP node spec revision needs no escalation and retains transport identity', async () => {
  await seed()
  const repo = await realpath(tmp)
  const local = openLocalStore(storeDir)
  await local.createBuild({ slug: 'node', repo, ticket: { source: 'file', id: 'NODE' } })
  await local.append('node', {
    actor: DISPATCHER,
    type: 'build.created',
    payload: { repo, ticket: { source: 'file', id: 'NODE' }, baseBranch: 'main', kind: 'node' },
  })
  await local.append('node', { actor: DISPATCHER, type: 'node.opened', payload: { sha: 'base' } })
  await local.close()
  const client = await connect({ ...bareEnv(), USER: 'operator-1' })
  try {
    const result = await client.callTool({
      name: 'builds.answer',
      arguments: {
        repo,
        slug: 'node',
        resolution: 'revise-spec',
        origin: 'body',
        body: '# Revised\n\n## Acceptance criteria\n- Works\n\n## Out of scope\n- Other work\n',
      },
    })
    const leaf = await client.callTool({
      name: 'builds.answer',
      arguments: {
        repo,
        slug: 'demo',
        resolution: 'revise-spec',
        origin: 'body',
        body: '# Revised\n\n## Acceptance criteria\n- Works\n\n## Out of scope\n- Other work\n',
      },
    })
    expect(leaf.isError).toBe(true)
    expect(JSON.stringify(leaf.content)).toContain('no open escalation for a spec revision')
    expect(result.isError).toBeUndefined()
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({
      kind: 'answered',
      nodeRevision: true,
      count: 0,
      specRev: 0,
    })
  } finally {
    await client.close()
  }
  const reopened = openLocalStore(storeDir)
  expect((await reopened.getEvents('node')).at(-1)).toMatchObject({
    type: 'spec.revised',
    payload: {
      operator: {
        user: 'operator-1',
        via: { kind: 'mcp', client: 'mcp-contract-test' },
      },
    },
  })
  await reopened.close()
})

test('canonical and deprecated merge tools and actions work through the stdio SDK', async () => {
  const repo = await realpath(tmp)
  const store = openLocalStore(storeDir)
  try {
    for (const action of ['merge', 'land']) {
      const slug = `consent-${action}`

      await store.createBuild({ slug, repo, branch: `branch/${slug}` })
      await store.append(slug, {
        actor: KERNEL,
        type: 'runner.attached',
        payload: { instance: 'runner', host: 'host' },
      })
      await store.append(slug, {
        actor: KERNEL,
        type: 'workspace.provisioned',
        payload: {
          provider: 'local',
          ref: 'local',
          path: '/workspace',
          branch: `branch/${slug}`,
          base: { source: 'local', remoteError: 'offline', sha: 'base' },
        },
      })
      const finalized = await store.append(slug, {
        actor: KERNEL,
        type: 'finalize.completed',
        payload: { pr: { number: 1, url: 'https://forge/1', headSha: 'head' } },
      })
      await store.append(slug, {
        actor: DISPATCHER,
        type: 'landing.decided',
        payload: {
          candidate: { head: 'head', parent: 'base', cycle: String(finalized.seq) },
          from: 'leaf',
          into: { kind: 'root' },
          labels: [],
          mode: 'consent',
          rule: { default: true },
        },
      })
    }
  } finally {
    await store.close()
  }
  const client = await connect({ ...bareEnv(), USER: 'merge-operator' })
  try {
    const { tools } = await client.listTools()
    expect(tools.find((t) => t.name === 'landings.list')?.description).toContain(
      'Deprecated alias for merges.list',
    )
    expect(tools.some((t) => t.name === 'merges.list')).toBe(true)
    const modern = await client.callTool({ name: 'merges.list', arguments: { repo } })
    const legacy = await client.callTool({ name: 'landings.list', arguments: { repo } })
    expect(modern.isError).toBeUndefined()
    expect(legacy).toEqual(modern)
    for (const action of ['merge', 'land']) {
      const slug = `consent-${action}`
      const result = await client.callTool({
        name: 'builds.control',
        arguments: { repo, slug, action },
      })
      expect(result.isError).toBeUndefined()
      expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({
        kind: 'command',
        command: 'land',
        slug,
      })
    }
  } finally {
    await client.close()
  }
  const durable = openLocalStore(storeDir)
  try {
    for (const action of ['merge', 'land']) {
      const facts = await durable.getEvents(`consent-${action}`)
      expect(facts.at(-1)).toMatchObject({
        type: 'build.land-requested',
        actor: { kind: 'human', user: 'merge-operator' },
        payload: { decisionSeq: 4 },
      })
    }
  } finally {
    await durable.close()
  }
})
