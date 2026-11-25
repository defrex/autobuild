/**
 * Per-repository MCP URLs (#1224) end to end, in memory: the MCP SDK's own
 * OAuth client discovers and authorizes from the URL alone, the token is
 * bound to that URL's resource, and the endpoint serves exactly that
 * repository through the same per-call closure as `/mcp`.
 */
import { testAccess } from '../testing/access'
import { testProjects } from '../testing/projects'
import { describe, expect, test } from 'bun:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { startAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import {
  approveAuthorization,
  authorizeFlow,
  authorizeWithDiscovery,
  baseEnv,
  buildApp,
  buildAuth,
  connectClient,
  discoverMetadata,
  dynamicRegister,
  ORIGIN,
  perRepositoryURL,
  REDIRECT_URI,
  REPO,
  SCOPE,
  seedUser,
  toolsListRequest,
} from '../testing/mcp-oauth'
import { MCP_SERVER_INSTRUCTIONS, repositoryMcpInstructions } from './mcp'

const OTHER = 'https://github.com/owner/other'
const UNREACHABLE = 'https://github.com/owner/unreachable'
const UNREGISTERED = 'https://github.com/owner/unregistered'
const PROJECTS = [REPO, OTHER, UNREACHABLE]
const OPERATOR = 'ada@example.com'
const REPO_URL = perRepositoryURL(REPO)
const OTHER_URL = perRepositoryURL(OTHER)

type CallResult = { isError?: boolean; content: { text: string }[] }

type JsonSchema = {
  properties?: Record<string, unknown>
  required?: string[]
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  allOf?: JsonSchema[]
}

async function harness() {
  const env: Record<string, string> = { ...baseEnv, AB_WEB_REPOSITORIES: PROJECTS.join(',') }
  const auth = buildAuth(env)
  const access = testAccess(env, testProjects(PROJECTS))
  const store = await access.store()
  const allowed = store.canAccess.bind(store)
  // Registered but outside this operator's reach; `revoke` drops REPO after
  // the given number of further access checks.
  let revokeAfter = Number.POSITIVE_INFINITY
  store.canAccess = async (actor, repo) => {
    if (repo === UNREACHABLE) return false
    if (repo === REPO && revokeAfter-- <= 0) return false
    return allowed(actor, repo)
  }
  const delegated: string[] = []
  const { app, backing } = buildApp(env, auth, access, {
    projects: PROJECTS,
    onDelegate: (request) => delegated.push(decodeURIComponent(new URL(request.url).pathname)),
  })
  for (const repo of PROJECTS) await backing.ensureRepo(repo)
  const { cookie } = await seedUser(auth, OPERATOR)
  return {
    app,
    backing,
    cookie,
    delegated,
    revoke: (after: number) => {
      revokeAfter = after
    },
  }
}

type Harness = Awaited<ReturnType<typeof harness>>

/** A deployment-wide (unbound) token through the existing `/mcp` flow. */
async function deploymentToken(h: Harness) {
  const client = await dynamicRegister(h.app, await discoverMetadata(h.app))
  return { tokens: await authorizeFlow(h.app, h.cookie, client), client }
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as { text: string }[])[0]!.text
  return { isError: result.isError === true, body: JSON.parse(text) as unknown }
}

function rawTokenRequest(h: Harness, params: Record<string, string>) {
  return h.app(
    new Request(`${ORIGIN}/api/auth/mcp/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    }),
  )
}

function noRepo(schema: JsonSchema, name: string) {
  expect(schema.properties?.repo, name).toBeUndefined()
  expect(schema.required ?? [], name).not.toContain('repo')
  for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])])
    noRepo(branch, name)
}

describe('per-repository MCP URLs', () => {
  test('a standard client authorizes from the URL alone and lists scoped tools', async () => {
    const h = await harness()
    const flow = await authorizeWithDiscovery(h.app, h.cookie, REPO_URL)
    const metadataURL = `${ORIGIN}/.well-known/oauth-protected-resource/mcp/github.com/owner/repo`
    expect(flow.challenge).toBe(`Bearer resource_metadata="${metadataURL}"`)
    const metadata = await (await h.app(new Request(metadataURL))).json()
    expect(metadata).toMatchObject({ resource: REPO_URL, authorization_servers: [ORIGIN] })
    expect(flow.tokenRequests.map((body) => body.get('resource'))).toEqual([REPO_URL])

    const scoped = await connectClient(h.app, flow.tokens, flow.client, REPO_URL)
    const { tokens: wide, client } = await deploymentToken(h)
    const deployment = await connectClient(h.app, wide, client)
    try {
      expect(scoped.getInstructions()).toBe(repositoryMcpInstructions(REPO))
      expect(deployment.getInstructions()).toBe(MCP_SERVER_INSTRUCTIONS)
      const instructions = scoped.getInstructions()!
      expect(instructions).toContain(REPO)
      for (const absent of ['repositories.list', 'this deployment serves', OTHER])
        expect(instructions).not.toContain(absent)

      // Parity guard: each scoped definition is the `/mcp` definition with
      // `repo` removed, and nothing else changes.
      const scopedTools = (await scoped.listTools()).tools
      const wideTools = new Map((await deployment.listTools()).tools.map((t) => [t.name, t]))
      expect(scopedTools.map((tool) => tool.name)).not.toContain('repositories.list')
      expect(scopedTools.some((tool) => tool.name.startsWith('sandbox.'))).toBe(false)
      expect(scopedTools.length).toBeGreaterThan(20)
      for (const tool of scopedTools) {
        noRepo(tool.inputSchema as JsonSchema, tool.name)
        const wideTool = wideTools.get(tool.name)!
        const { repo: _repo, ...properties } = (wideTool.inputSchema.properties ?? {}) as Record<
          string,
          unknown
        >
        const { required: wideRequired, ...wideSchema } = wideTool.inputSchema
        const required = (wideRequired ?? []).filter((key) => key !== 'repo')
        expect(tool, tool.name).toEqual({
          ...wideTool,
          inputSchema: {
            ...wideSchema,
            ...(required.length > 0 ? { required } : {}),
            properties,
          },
        } as never)
      }
    } finally {
      await scoped.close()
      await deployment.close()
    }
  })

  test('calls act on the endpoint repository, attributed, and refuse a foreign repo', async () => {
    const h = await harness()
    const flow = await authorizeWithDiscovery(h.app, h.cookie, REPO_URL)
    const scoped = await connectClient(h.app, flow.tokens, flow.client, REPO_URL)
    const { tokens: wide, client } = await deploymentToken(h)
    const deployment = await connectClient(h.app, wide, client)
    try {
      const status = await call(scoped, 'repository.status')
      expect(status.isError).toBe(false)
      expect(status.body).toEqual(
        (await call(deployment, 'repository.status', { repo: REPO })).body,
      )
      expect(h.delegated).toEqual([
        `/operator/v1/repos/${REPO}/tools/repository.status`,
        `/operator/v1/repos/${REPO}/tools/repository.status`,
      ])
      // The endpoint's own identity is accepted and dropped.
      expect((await call(scoped, 'repository.status', { repo: REPO })).isError).toBe(false)

      const before = h.delegated.length
      const foreign = await call(scoped, 'repository.status', { repo: OTHER })
      expect(foreign).toMatchObject({ isError: true, body: { kind: 'validation' } })
      expect(h.delegated.length).toBe(before)
      expect((await scoped.callTool({ name: 'repositories.list', arguments: {} })).isError).toBe(
        true,
      )

      const set = await call(scoped, 'repository.settings', { setting: 'intake', enabled: false })
      expect(set).toMatchObject({ isError: false, body: { enabled: false } })
      const event = (await h.backing.getRepoEvents(REPO)).at(-1)
      expect(event?.type).toBe('dispatcher.intake-set')
      expect(event?.actor).toEqual({
        kind: 'human',
        user: OPERATOR,
        via: { kind: 'mcp', client: 'e2e-mcp-client' },
      })
      expect((await h.backing.getRepoEvents(OTHER)).length).toBe(0)
    } finally {
      await scoped.close()
      await deployment.close()
    }
  })

  test('a token is bound to the resource it was issued for', async () => {
    const h = await harness()
    const flow = await authorizeWithDiscovery(h.app, h.cookie, REPO_URL)
    const bound = flow.tokens.access_token
    const list = (token: string, url: string) => h.app(toolsListRequest(token, 1, url))
    expect((await list(bound, REPO_URL)).status).toBe(200)
    for (const [url, metadata] of [
      [OTHER_URL, `${ORIGIN}/.well-known/oauth-protected-resource/mcp/github.com/owner/other`],
      [`${ORIGIN}/mcp`, `${ORIGIN}/.well-known/oauth-protected-resource`],
    ] as const) {
      const refused = await list(bound, url)
      expect(refused.status).toBe(401)
      expect(refused.headers.get('www-authenticate')).toBe(
        `Bearer error="invalid_token", resource_metadata="${metadata}"`,
      )
    }
    // A deployment-wide token covers every per-repository URL.
    const { tokens: wide, client } = await deploymentToken(h)
    expect((await list(wide.access_token, REPO_URL)).status).toBe(200)

    // A refresh keeps the binding, and naming another resource is refused.
    const clientId = (flow.client as { client_id: string }).client_id
    const refreshed = await rawTokenRequest(h, {
      grant_type: 'refresh_token',
      refresh_token: flow.tokens.refresh_token!,
      client_id: clientId,
    })
    expect(refreshed.status).toBe(200)
    const next = (await refreshed.json()) as OAuthTokens
    expect((await list(next.access_token, REPO_URL)).status).toBe(200)
    expect((await list(next.access_token, OTHER_URL)).status).toBe(401)
    const elsewhere = await rawTokenRequest(h, {
      grant_type: 'refresh_token',
      refresh_token: next.refresh_token!,
      client_id: clientId,
      resource: OTHER_URL,
    })
    expect(elsewhere.status).toBe(400)
    expect(await elsewhere.json()).toMatchObject({ error: 'invalid_target' })

    // A code exchange naming a resource this server does not serve.
    const metadata = await discoverMetadata(h.app)
    const { authorizationUrl, codeVerifier } = await startAuthorization(ORIGIN, {
      metadata,
      clientInformation: client,
      redirectUrl: REDIRECT_URI,
      scope: SCOPE,
    })
    const code = await approveAuthorization(h.app, h.cookie, authorizationUrl)
    const foreign = await rawTokenRequest(h, {
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: REDIRECT_URI,
      client_id: (client as { client_id: string }).client_id,
      resource: 'https://elsewhere.example/mcp',
    })
    expect(foreign.status).toBe(400)
    expect(await foreign.json()).toMatchObject({ error: 'invalid_target' })
  })

  test('unregistered, unreachable and malformed URLs are 404, never a connector', async () => {
    const h = await harness()
    const { tokens } = await deploymentToken(h)
    for (const repo of [UNREGISTERED, UNREACHABLE]) {
      const response = await h.app(toolsListRequest(tokens.access_token, 1, perRepositoryURL(repo)))
      expect(response.status, repo).toBe(404)
    }
    for (const url of [
      `${REPO_URL}/`,
      `${ORIGIN}/mcp/`,
      `${ORIGIN}/mcp/github.com/owner/Repo.git`,
    ]) {
      const response = await h.app(
        new Request(url, {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'application/json' },
        }),
      )
      expect(response.status, url).toBe(404)
    }
    // The transport contract matches `/mcp`: SSE on GET, preflight on OPTIONS.
    const stream = await h.app(
      new Request(REPO_URL, {
        headers: { accept: 'text/event-stream', authorization: `Bearer ${tokens.access_token}` },
      }),
    )
    expect(stream.status).toBe(200)
    await stream.body?.cancel()
    expect((await h.app(new Request(REPO_URL, { method: 'OPTIONS' }))).status).toBe(204)
  })

  test('access is rechecked on every call while the token is live', async () => {
    const h = await harness()
    const flow = await authorizeWithDiscovery(h.app, h.cookie, REPO_URL)
    const token = flow.tokens.access_token
    // The request-level check passes; access is lost before the callback's
    // recheck, which refuses the call with no delegation.
    h.revoke(1)
    const response = await h.app(
      new Request(REPO_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'repository.status', arguments: {} },
        }),
      }),
    )
    const result = ((await response.json()) as { result: CallResult }).result
    expect(result.isError).toBe(true)
    const body = JSON.parse(result.content[0]!.text)
    expect(body).toMatchObject({ kind: 'auth' })
    expect(JSON.stringify(body)).not.toContain('repositories.list')
    expect(h.delegated).toEqual([])
    expect((await h.app(toolsListRequest(token, 2, REPO_URL))).status).toBe(404)
  })
})
