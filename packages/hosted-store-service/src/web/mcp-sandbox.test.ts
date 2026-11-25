/**
 * Hosted sandbox tools over `/mcp` (#1219): the real OAuth flow, the MCP SDK
 * client, the binding, and the hosted service's operator server, in memory.
 * Sandbox composition is the service's injected seam, returning the real
 * operator sandbox service over an IO-free provider double.
 *
 * The parity cases pin advertisement to dispatch: every tool `/mcp` lists is
 * executable, and a deployment without sandbox capability neither lists nor
 * serves `sandbox.*`.
 */
import { testAccess } from '../testing/access'
import { testProjects } from '../testing/projects'
import { describe, expect, test } from 'bun:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { TOOLS } from '@defrex/autobuild/operator'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  mintToken,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '@defrex/autobuild/remote-store'
import {
  createOperatorSandboxService,
  FakeForge,
  memoryOperatorSandbox,
  parseConfig,
} from '@defrex/autobuild/testing'
import {
  authorizeFlow,
  baseEnv,
  buildApp,
  buildAuth,
  connectClient,
  discoverMetadata,
  dynamicRegister,
  seedUser,
} from '../testing/mcp-oauth'

const ENABLED = 'https://github.com/owner/enabled'
const DISABLED = 'https://github.com/owner/disabled'
const MISSING = 'https://github.com/owner/missing'
const PROJECTS = [ENABLED, DISABLED, MISSING]
const OPERATOR = 'ada@example.com'

/** The deposited artifact shape: step configs flatten into their section. */
function effectiveConfig(enabled: boolean): string {
  const { verify, finalize, ...root } = parseConfig(`
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = []
[finalize]
steps = []
[orchestrator]
enabled = ${enabled}
`)
  return JSON.stringify({
    ...root,
    verify: { steps: verify.steps, ...verify.stepConfigs },
    finalize: { steps: finalize.steps, ...finalize.stepConfigs },
  })
}

async function harness(options: { withoutOrigin?: boolean } = {}) {
  const env: Record<string, string> = { ...baseEnv, AB_WEB_REPOSITORIES: PROJECTS.join(',') }
  const serviceEnv: Record<string, string> = { ...env }
  if (options.withoutOrigin) delete serviceEnv.BETTER_AUTH_URL
  const auth = buildAuth(env)
  const sandbox = memoryOperatorSandbox()
  const forge = new FakeForge()
  const issued: string[] = []
  const reported: unknown[] = []
  const delegated: string[] = []
  let composed = 0
  let failCompose = false
  const { app, backing, service } = buildApp(env, auth, testAccess(env, testProjects(PROJECTS)), {
    serviceEnv,
    projects: PROJECTS,
    reportInternalError: (error) => {
      reported.push(error)
    },
    onDelegate: (request) => {
      delegated.push(decodeURIComponent(new URL(request.url).pathname))
    },
    issueDispatcherCredential: async (repo, creator) => {
      issued.push(`${repo} ${creator}`)
      return 'sandbox-store-token'
    },
    composeOperatorSandbox: async ({ store, repo, config }) => {
      if (failCompose) throw new Error('provider construction failed')
      composed++
      return createOperatorSandboxService({
        store,
        repo,
        provider: sandbox.provider,
        sandbox: config.orchestrator.sandbox,
        baseBranch: config.baseBranch,
        forge,
      })
    },
  })
  for (const [repo, enabled] of [
    [ENABLED, true],
    [DISABLED, false],
  ] as const) {
    await backing.ensureRepo(repo)
    await backing.putRepoArtifact(repo, {
      kind: 'dispatcher-effective-config',
      content: effectiveConfig(enabled),
    })
  }
  await backing.ensureRepo(MISSING)
  const seeded = await seedUser(auth, OPERATOR)
  const registered = await dynamicRegister(app, await discoverMetadata(app))
  const tokens = await authorizeFlow(app, seeded.cookie, registered)
  const client = await connectClient(app, tokens, registered)
  return {
    env,
    app,
    backing,
    service,
    client,
    sandbox,
    forge,
    issued,
    reported,
    delegated,
    composed: () => composed,
    failCompose: (value: boolean) => {
      failCompose = value
    },
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as { text: string }[])[0]!.text
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {}
  return { isError: result.isError === true, body }
}

/** Minimal schema-valid input for every operator tool, against the enabled
 * repository. Unknown slugs and ticket ids refuse in the domain, after
 * dispatch, which is what the parity test needs. */
const ref = { repo: ENABLED }
const build = { ...ref, slug: 'parity-missing' }
const ticket = { ...ref, id: 'PARITY-1' }
const PARITY_INPUTS: Record<string, Record<string, unknown>> = {
  'merges.list': ref,
  'landings.list': ref,
  'tickets.tree': ref,
  'builds.list': { ...ref, scope: 'all' },
  'builds.get': build,
  'builds.events': { ...build, cursor: 0, waitSeconds: 0 },
  'builds.artifact': { ...build, kind: 'plan' },
  'builds.restack': build,
  'optimization.revise': { ...build, maxAttempts: 1 },
  'optimization.stop': build,
  'optimization.settle-unmeasured': {
    ...build,
    attempt: 'parity-attempt',
    policy: 'release-unmeasured',
  },
  'builds.control': { ...build, action: 'pause' },
  'builds.answer': { ...build, resolution: 'retry' },
  'builds.reopen': { ...build, feedback: 'parity' },
  'repository.forge_clear': { ...ref, forge: 'github', reason: 'parity' },
  'repository.status': ref,
  'repository.events': { ...ref, waitSeconds: 0, filter: 'all' },
  'repository.settings': { ...ref, setting: 'intake', enabled: true },
  'repository.bulk_control': { ...ref, action: 'resume' },
  'harvest.status': ref,
  'harvest.control': { ...ref, action: 'toggle-gate' },
  'tickets.states': ref,
  'tickets.state.create': { ...ref, name: 'parity' },
  'tickets.list': ref,
  'tickets.get': ticket,
  'tickets.create': { ...ref, title: 'Parity', body: 'parity' },
  'tickets.update': { ...ticket, title: 'Parity' },
  'tickets.block': { ...ticket, blockerIds: ['PARITY-2'] },
  'tickets.unblock': { ...ticket, blockerIds: ['PARITY-2'] },
  'tickets.move': { ...ticket, state: 'ready' },
  'tickets.start': ticket,
  'tickets.search': { ...ref, query: 'parity' },
  'tickets.asset.attach': {
    ...ticket,
    kind: 'design',
    name: 'parity',
    layout: 'file',
    entries: [{ type: 'file', path: 'parity.txt', contentBase64: '' }],
  },
  'tickets.asset.get': { ...ticket, kind: 'design', name: 'parity' },
  'tickets.asset.remove': { ...ticket, kind: 'design', name: 'parity' },
  'notes.read': ref,
  'notes.write': { ...ref, document: 'parity' },
  'sandbox.exec': { ...ref, command: 'true' },
  'sandbox.start': { ...ref, command: 'true' },
  'sandbox.wait': { ...ref, commandId: 'cmd-parity', waitSeconds: 0 },
  'sandbox.read_file': { ...ref, path: 'missing.txt' },
  'sandbox.write_file': { ...ref, path: 'parity.txt', content: 'parity', encoding: 'utf8' },
  'sandbox.reset': ref,
  'sandbox.publish': { ...ref, title: 'Parity' },
}

const sandboxNames = TOOLS.map((tool) => tool.name as string).filter((name) =>
  name.startsWith('sandbox.'),
)

describe('hosted sandbox tools over /mcp', () => {
  test('the enabled repository serves every sandbox tool, attributed to the operator', async () => {
    const h = await harness()
    try {
      const { tools } = await h.client.listTools()
      const listed = tools.map((tool) => tool.name)
      expect(listed).toEqual(expect.arrayContaining(sandboxNames))
      expect(sandboxNames).toHaveLength(7)
      // Read-only tools keep their advertisement and results.
      expect(listed).toEqual(
        expect.arrayContaining(
          TOOLS.filter((tool) => !sandboxNames.includes(tool.name)).map((t) => t.name),
        ),
      )
      const status = await call(h.client, 'repository.status', { repo: ENABLED })
      expect(status.isError).toBe(false)
      expect(status.body).toMatchObject({ repo: ENABLED })

      const exec = await call(h.client, 'sandbox.exec', { repo: ENABLED, command: 'echo hi' })
      expect(exec).toEqual({ isError: false, body: { exitCode: 0, stdout: 'echo hi', stderr: '' } })
      const exec2 = await call(h.client, 'sandbox.exec', { repo: ENABLED, command: 'pwd' })
      expect(exec2.isError).toBe(false)
      // Two consecutive calls: at most one credential, one composition.
      expect(h.issued.length).toBeLessThanOrEqual(1)
      expect(h.composed()).toBe(1)

      const started = await call(h.client, 'sandbox.start', { repo: ENABLED, command: 'sleep 1' })
      const { commandId } = started.body as { commandId: string }
      expect(typeof commandId).toBe('string')
      const waited = await call(h.client, 'sandbox.wait', {
        repo: ENABLED,
        commandId,
        waitSeconds: 0,
      })
      expect(waited.body).toMatchObject({ state: 'exited', exitCode: 0 })
      const written = await call(h.client, 'sandbox.write_file', {
        repo: ENABLED,
        path: 'notes.txt',
        content: 'hello',
      })
      expect(written.isError).toBe(false)
      const read = await call(h.client, 'sandbox.read_file', { repo: ENABLED, path: 'notes.txt' })
      expect(read.isError).toBe(false)
      expect(JSON.stringify(read.body)).toContain('hello')
      const published = await call(h.client, 'sandbox.publish', { repo: ENABLED, title: 'Notes' })
      expect(published.isError).toBe(false)
      expect((published.body as { branch: string }).branch).toStartWith('ab/orch-')
      expect(h.sandbox.pushes).toHaveLength(1)
      const reset = await call(h.client, 'sandbox.reset', { repo: ENABLED })
      expect(reset.isError).toBe(false)

      const facts = (await h.backing.getRepoEvents(ENABLED)).filter((event) =>
        event.type.startsWith('orchestrator.sandbox.'),
      )
      expect(facts.length).toBeGreaterThan(0)
      for (const fact of facts) expect(fact.actor).toMatchObject({ kind: 'human', user: OPERATOR })
    } finally {
      await h.client.close()
    }
  })

  test('a closed gate refuses with a typed code that names the reason', async () => {
    const h = await harness()
    try {
      const code = async (repo: string) =>
        (await call(h.client, 'sandbox.exec', { repo, command: 'ls' })).body as { code?: string }
      expect(await code(DISABLED)).toMatchObject({ code: 'sandbox-orchestrator-disabled' })
      expect(await code(MISSING)).toMatchObject({ code: 'sandbox-no-effective-config' })
      h.failCompose(true)
      expect(await code(ENABLED)).toMatchObject({ code: 'sandbox-backend-unavailable' })
      expect(h.reported.map(String)).toEqual(['Error: provider construction failed'])
    } finally {
      await h.client.close()
    }
  })

  test('every advertised tool is executable', async () => {
    const h = await harness()
    try {
      const { tools } = await h.client.listTools()
      const advertised = tools
        .map((tool) => tool.name)
        .filter((name) => name !== 'repositories.list')
      expect(advertised.sort()).toEqual(
        h.service.operatorTools.map((tool) => tool.name as string).sort(),
      )
      for (const name of advertised) {
        // Schema-valid input, so the call passes MCP validation and reaches
        // the operator server's dispatch. A domain refusal there is fine; an
        // unknown tool is the drift this test exists to catch.
        const args = PARITY_INPUTS[name]
        expect(args, `parity input for ${name}`).toBeDefined()
        const entry = h.service.operatorTools.find((tool) => tool.name === name)!
        expect(entry.inputSchema.safeParse(args).success, `valid input for ${name}`).toBe(true)
        const before = h.delegated.length
        const result = await h.client.callTool({ name, arguments: args })
        expect(h.delegated.slice(before), `${name} reaches the operator server`).toEqual([
          `/operator/v1/repos/${ENABLED}/tools/${name}`,
        ])
        expect(JSON.stringify(result)).not.toContain('unknown tool')
      }
    } finally {
      await h.client.close()
    }
  })

  test('a deployment without sandbox capability neither lists nor serves sandbox tools', async () => {
    const h = await harness({ withoutOrigin: true })
    try {
      expect(h.service.operatorTools.some((tool) => tool.name.startsWith('sandbox.'))).toBe(false)
      const { tools } = await h.client.listTools()
      expect(tools.some((tool) => tool.name.startsWith('sandbox.'))).toBe(false)
      const response = await h.service.fetch(
        new Request(
          `https://operator.example/operator/v1/repos/${encodeURIComponent(ENABLED)}/tools/sandbox.exec`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${mintToken(h.env.AB_STORE_SECRET!, {
                version: 1,
                internalOperator: { user: OPERATOR, repo: ENABLED },
                exp: Date.now() + 30_000,
              })}`,
              [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
              [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ repo: ENABLED, command: 'ls' }),
          },
        ),
      )
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ kind: 'not-found' })
    } finally {
      await h.client.close()
    }
  })
})
