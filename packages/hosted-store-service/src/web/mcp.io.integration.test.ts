/**
 * End-to-end OAuth 2.1 + MCP over the hosted service (AUT-341): a single
 * Fetch router composes Better Auth's handler at /api/auth/* and the /mcp
 * endpoint delegating in-process to the real hosted service (store +
 * operator + ticket backends). Better Auth runs on its memory adapter here;
 * mcp.integration.test.ts runs the same flow against a migrated Postgres
 * schema for production adapter parity.
 *
 * The client side is the MCP SDK's own OAuth client (client/auth.js) and
 * StreamableHTTPClientTransport, exactly the machinery Claude web, Claude
 * Code, and Codex bring, so contract drift on either side fails loudly.
 */
import { testAccess } from '../testing/access'
import { describe, expect, test } from 'bun:test'
import { refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { TOOLS } from '@defrex/autobuild/operator'
import { DISPATCHER, KERNEL, parseConfig } from '@defrex/autobuild/testing'
import {
  authorizeFlow,
  baseEnv,
  buildApp,
  buildAuth,
  connectClient,
  discoverMetadata,
  discoverProtectedResource,
  dynamicRegister,
  emptyDB,
  ORIGIN,
  REDIRECT_URI,
  REPO,
  routerFetch,
  seedUser,
  toolsListRequest,
} from '../testing/mcp-oauth'
import { createWebAuth } from './auth'
import { MCP_SERVER_INSTRUCTIONS } from './mcp'

describe('hosted MCP over OAuth (memory adapter)', () => {
  const env = { ...baseEnv }
  const db = emptyDB()
  const auth = createWebAuth(env, { access: testAccess(env), database: memoryAdapter(db) })
  const { app, backing } = buildApp(env, auth)
  let adaCookie = ''
  let adaTokens: OAuthTokens | undefined
  let registered: OAuthClientInformationMixed | undefined

  test('an unauthenticated tools/list POST receives the RFC 9728 challenge', async () => {
    const response = await app(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    )
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
    )
  })

  test('the full OAuth flow authorizes a dynamically registered client', async () => {
    const seeded = await seedUser(auth, 'ada@example.com')
    adaCookie = seeded.cookie
    const metadata = await discoverMetadata(app)
    await discoverProtectedResource(app)
    registered = await dynamicRegister(app, metadata)
    adaTokens = await authorizeFlow(app, adaCookie, registered)
    expect(adaTokens.access_token).toBeTruthy()
  })

  test('the MCP client connects, lists the live registry table, and reads a tool', async () => {
    const mcpClient = await connectClient(app, adaTokens!, registered!)
    try {
      const { tools } = await mcpClient.listTools()
      // Equality with the live registry table, plus repositories.list.
      expect(tools).toHaveLength(TOOLS.length + 1)
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [...TOOLS.map((entry) => entry.name as string), 'repositories.list'].sort(),
      )
      const repositories = tools.find((tool) => tool.name === 'repositories.list')!
      expect(repositories.annotations).toMatchObject({ readOnlyHint: true })
      const buildsList = tools.find((tool) => tool.name === 'builds.list')!
      expect((buildsList.inputSchema as Record<string, unknown>).type).toBe('object')
      expect(buildsList.annotations).toMatchObject({ readOnlyHint: true })
      // Server instructions summarize how Autobuild works and point at the
      // repository listing.
      expect(MCP_SERVER_INSTRUCTIONS).toContain('repositories.list')

      const listing = await mcpClient.callTool({ name: 'repositories.list', arguments: {} })
      expect((listing.content as { text: string }[])[0]!.text).toBe(
        JSON.stringify({ repositories: [REPO] }),
      )

      const reads = await mcpClient.callTool({
        name: 'builds.list',
        arguments: { repo: REPO, scope: 'all' },
      })
      expect(reads.isError).toBeUndefined()
      expect(JSON.parse((reads.content as { text: string }[])[0]!.text)).toEqual([])
    } finally {
      await mcpClient.close()
    }
  })

  test('merge aliases survive authenticated SDK validation and operator API delegation', async () => {
    const repo = REPO
    for (const action of ['merge', 'land']) {
      const slug = `consent-${action}`

      await backing.createBuild({ slug, repo, branch: `branch/${slug}` })
      await backing.append(slug, {
        actor: KERNEL,
        type: 'runner.attached',
        payload: { instance: 'runner', host: 'host' },
      })
      await backing.append(slug, {
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
      const finalized = await backing.append(slug, {
        actor: KERNEL,
        type: 'finalize.completed',
        payload: { pr: { number: 1, url: 'https://forge/1', headSha: 'head' } },
      })
      await backing.append(slug, {
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
    const client = await connectClient(app, adaTokens!, registered!)
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
    for (const action of ['merge', 'land']) {
      expect((await backing.getEvents(`consent-${action}`)).at(-1)).toMatchObject({
        type: 'build.land-requested',
        actor: {
          kind: 'human',
          user: 'ada@example.com',
          via: { kind: 'mcp', client: 'e2e-mcp-client' },
        },
        payload: { decisionSeq: 4 },
      })
    }
  })
  test('MCP ticket tools retain external-source refusal instead of returning an empty queue', async () => {
    const client = await connectClient(app, adaTokens!, registered!)
    try {
      await backing.ensureRepo(REPO)
      for (const source of ['linear', 'file']) {
        const { verify, finalize, ...root } = parseConfig(
          `[tickets]\nsource = "${source}"\n${source === 'linear' ? 'teamKey = "ENG"\n' : ''}readyState = "Ready"\n[verify]\nsteps = []\n[finalize]\nsteps = []`,
        )
        const artifact = await backing.putRepoArtifact(REPO, {
          kind: 'dispatcher-effective-config',
          content: JSON.stringify({
            ...root,
            verify: { steps: verify.steps },
            finalize: { steps: finalize.steps },
          }),
        })
        await backing.appendRepo(REPO, {
          actor: DISPATCHER,
          type: 'dispatcher.run-started',
          payload: {
            run: `ticket-${source}`,
            pid: 1,
            effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
            roleWarnings: [],
          },
        })
        const result = await client.callTool({ name: 'tickets.list', arguments: { repo: REPO } })
        expect(result.isError).toBe(true)
        expect((result.content as { text: string }[])[0]!.text).toContain(source)
      }
    } finally {
      await client.close()
    }
  })

  test('a mutating tool call stamps the operator and the via marker onto the event', async () => {
    const mcpClient = await connectClient(app, adaTokens!, registered!)
    try {
      const result = await mcpClient.callTool({
        name: 'repository.settings',
        arguments: { repo: REPO, setting: 'intake', enabled: false },
      })
      expect(result.isError).toBeUndefined()
      const body = JSON.parse((result.content as { text: string }[])[0]!.text) as {
        enabled: boolean
      }
      expect(body.enabled).toBe(false)
    } finally {
      await mcpClient.close()
    }
    // The durable event names the signed-in operator and the MCP client that
    // executed the call — the minted token's via survived the operator
    // server's registry execution.
    const event = (await backing.getRepoEvents(REPO)).at(-1)
    expect(event?.type).toBe('dispatcher.intake-set')
    expect(event?.actor).toEqual({
      kind: 'human',
      user: 'ada@example.com',
      via: { kind: 'mcp', client: 'e2e-mcp-client' },
    })
  })

  test('notes round-trip with the deposit metadata naming the user and via', async () => {
    const mcpClient = await connectClient(app, adaTokens!, registered!)
    try {
      const write = await mcpClient.callTool({
        name: 'notes.write',
        arguments: { repo: REPO, document: 'round 1 notes' },
      })
      expect(write.isError).toBeUndefined()
      const read = await mcpClient.callTool({ name: 'notes.read', arguments: { repo: REPO } })
      const body = JSON.parse((read.content as { text: string }[])[0]!.text) as {
        document: string
        metadata: { user: string; via: { kind: string; client: string } }
      }
      expect(body.document).toBe('round 1 notes')
      expect(body.metadata).toEqual({
        user: 'ada@example.com',
        via: { kind: 'mcp', client: 'e2e-mcp-client' },
      })
    } finally {
      await mcpClient.close()
    }
  })

  test('a tool call naming an unserved repository is refused', async () => {
    const mcpClient = await connectClient(app, adaTokens!, registered!)
    try {
      const result = await mcpClient.callTool({
        name: 'builds.list',
        arguments: { repo: 'https://github.com/owner/other', scope: 'all' },
      })
      expect(result.isError).toBe(true)
      expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({
        kind: 'validation',
      })
    } finally {
      await mcpClient.close()
    }
  })

  test('refresh works after access-token expiry', async () => {
    // A dedicated instance with a 1-second access token: waiting out the
    // production hour would be absurd in a test.
    const shortAuth = buildAuth({ ...baseEnv }, 1)
    const short = buildApp({ ...baseEnv }, shortAuth)
    const seeded = await seedUser(shortAuth, 'ada@example.com')
    const metadata = await discoverMetadata(short.app)
    const client = await dynamicRegister(short.app, metadata)
    const tokens = await authorizeFlow(short.app, seeded.cookie, client)
    expect(tokens.expires_in).toBe(1)
    await Bun.sleep(1200)

    const expired = await short.app(toolsListRequest(tokens.access_token!, 2))
    expect(expired.status).toBe(401)

    const refreshed = await refreshAuthorization(ORIGIN, {
      metadata,
      clientInformation: client,
      refreshToken: tokens.refresh_token!,
      fetchFn: routerFetch(short.app),
    })
    expect(refreshed.access_token).toBeTruthy()
    const works = await short.app(toolsListRequest(refreshed.access_token!, 3))
    expect(works.status).toBe(200)
  })

  test('a non-allowlisted operator completes authorization but is refused at the resource', async () => {
    env.AB_WEB_SUPER_USER_EMAILS += ',mallory@example.com'
    const seeded = await seedUser(auth, 'mallory@example.com', db)
    const tokens = await authorizeFlow(app, seeded.cookie)
    env.AB_WEB_SUPER_USER_EMAILS = baseEnv.AB_WEB_SUPER_USER_EMAILS!
    const response = await app(toolsListRequest(tokens.access_token!, 4))
    expect(response.status).toBe(403)
  })

  test('a violating client_name is rejected at the real DCR route (AUT-399)', async () => {
    // The hook lives in createWebAuth's plugin list, but this proves the
    // real /api/auth/mcp/register route — the one the SDK and discovery
    // document drive — surfaces the policy as a 400 with the RFC 7591
    // error shape the endpoint itself uses for other metadata problems.
    const response = await app(
      new Request(`${ORIGIN}/api/auth/mcp/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'acme\u0000console',
          redirect_uris: [REDIRECT_URI],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_client_metadata' })
  })

  test('DCR persists the authenticationScheme the plugin writes', async () => {
    // The pinned 1.4.18 MCP plugin's DCR writes `authenticationScheme` but
    // its declared oauthApplication schema omits it; the file-local plugin
    // declaration in createWebAuth restores it through the adapter factory.
    // The registered client used token_endpoint_auth_method 'none'.
    const row = db.oauthApplication?.find((candidate) => candidate.name === 'e2e-mcp-client')
    expect(row?.authenticationScheme).toBe('none')
    // Pin the DCR-carried fields the memory adapter persists, so the
    // postgres parity block below can assert the two adapters' visible
    // behavior matches without reaching across describe scopes. (Optional
    // fields left undefined — icon, userId here — are omitted by the
    // memory adapter but read back as NULL on Postgres, so only the
    // defined DCR-carried values are pinned.)
    expect(row).toMatchObject({
      name: 'e2e-mcp-client',
      type: 'public',
      authenticationScheme: 'none',
    })
    expect(row?.redirectUrls).toContain('https://claude.ai/api/mcp/auth_callback')
  })
})
