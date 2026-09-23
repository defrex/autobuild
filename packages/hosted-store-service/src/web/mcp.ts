/**
 * The hosted MCP endpoint (AUT-341): the agent tool registry served over
 * Streamable HTTP on the same origin as the operator dashboard, authorized by
 * Better Auth's MCP plugin (OAuth 2.1) and executed through the operator
 * API's token-verified protocol.
 *
 * Attribution path per tool call: the MCP bearer token resolves to the
 * signed-in operator (Better Auth's token store, then the email allowlist
 * re-checked — sign-in admission stops an outside person at the front door,
 * this re-check cuts off anyone dropped from the list with a live token);
 * the endpoint mints the same short-lived attributed operator token the web
 * gateway mints, plus a `via` marker naming the MCP client from its OAuth
 * registration; the operator server executes the named registry tool with
 * that token, so every durable write is attributed to the person who
 * authorized the client.
 *
 * The binding is fully data-driven: it iterates the registry's closed
 * `entries` table and registers every entry with one generic handler that
 * delegates to `POST /operator/v1/repos/:repo/tools/:tool`. There are no
 * per-tool branches — when a future ticket adds registry entries, they
 * appear here and execute with no change to this file.
 *
 * Transport: a stateless `WebStandardStreamableHTTPServerTransport` (fresh
 * transport + `McpServer` per request, JSON responses, no session
 * validation) — built for runtimes like Vercel Functions where no
 * server-lifetime state survives between requests. All identity is resolved
 * per request from the bearer token, so cold starts behave identically to
 * warm instances. GET serves the SDK's standalone SSE stream with 200 —
 * stateless mode disables session validation, not server-to-client streams
 * (pinned by the unit test in src/web/mcp.test.ts) — and DELETE answers 200,
 * discarding the per-request transport. 405 is reserved for methods outside
 * GET/POST/DELETE, which the MCP transport contract permits for stateless
 * servers.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { OperatorApiClient, OperatorApiError } from '../operator-client'
import { TOOLS, type ToolEntry } from '@defrex/autobuild/operator'
import { AUTOBUILD_VERSION, mintToken } from '@defrex/autobuild/remote-store'
import { isAllowedEmail, normalizeEmail } from './config'
import type { WebAuth } from './auth'
import type { WebAuthConfig } from './config'

function asFetch(delegate: (request: Request) => Promise<Response>): typeof fetch {
  // OperatorApiClient calls fetchFn(url, init) with a string URL; the hosted
  // service's fetch takes a Request.
  return ((input: string | URL | Request, init?: RequestInit) =>
    delegate(
      input instanceof Request ? input : new Request(input, init),
    )) as unknown as typeof fetch
}

/** Upper bound for a tool-requested bounded wait (`builds.events`), so no
 * single MCP request outlives the route's function duration limit — see the
 * pairing with `maxDuration` in app/mcp/route.ts (the Next.js app tree under
 * this package) and the dispatcher route's
 * documentation. The registry's own schema currently caps waits lower; this
 * binding-side clamp is the guard that holds if that cap rises. */
export const MCP_MAX_WAIT_SECONDS = 240

export const MCP_SERVER_INSTRUCTIONS = [
  'Autobuild operator tools for the repositories this deployment serves: builds, repository and harvest controls, tickets, and operator notes.',
  'Autobuild runs builds from tickets: a dispatcher claims groomed tickets, an embedded agent implements each build through plan/implement/verify rounds, and every durable action is attributed.',
  'Call `repositories.list` first to discover which repository identities this deployment serves; every tool names its repository explicitly via `repo`.',
  'Mutating tools append durable, human-attributed events under the signed-in operator who authorized this client; destructive controls are annotated.',
  'Read tools mirror the operator API routes — every result equals the corresponding route — and `builds.events` after a cursor is the polling companion to `builds.get`.',
].join(' ')

export interface McpEndpointOptions {
  /** The parsed web auth config (repositories, baseURL, mcpResource). */
  config: WebAuthConfig
  /** The Better Auth instance carrying the MCP plugin. */
  auth: WebAuth
  /** The store signing secret the operator token is minted with. */
  storeSecret: string
  /** The hosted service's own fetch — the delegation target for tool calls. */
  delegate: (request: Request) => Promise<Response>
  now?: () => Date
  /** Registry table override for tests; defaults to the core closed table. */
  entries?: readonly ToolEntry[]
}

/** The JSON-RPC error body the plugin's `withMcpAuth` returns on 401,
 * mirrored here so the endpoint fails identically. */
function unauthorized(config: WebAuthConfig): Response {
  const challenge = `Bearer resource_metadata="${config.baseURL}/.well-known/oauth-protected-resource"`
  return Response.json(
    {
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Unauthorized: Authentication required',
        'www-authenticate': challenge,
      },
      id: null,
    },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': challenge,
        'Access-Control-Expose-Headers': 'WWW-Authenticate',
      },
    },
  )
}

function refused(status: 401 | 403, message: string): Response {
  return Response.json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }, { status })
}

/** The resolved operator behind one request's bearer token. */
interface McpOperator {
  email: string
  client: string
}

export function createMcpEndpoint(options: McpEndpointOptions): {
  fetch(request: Request): Promise<Response>
} {
  const config = options.config
  const now = options.now ?? (() => new Date())
  const entries = options.entries ?? TOOLS

  /** Resolve the bearer token to the signed-in operator: Better Auth's MCP
   * token store finds the oauthAccessToken row (the plugin does not check
   * expiry — the resource must), the user must still satisfy the allowlist,
   * and the client name comes from the token's OAuth registration. */
  async function operator(request: Request): Promise<McpOperator | Response> {
    const session = await options.auth.api.getMcpSession({ headers: request.headers })
    if (!session) return unauthorized(config)
    if (new Date(session.accessTokenExpiresAt).getTime() <= now().getTime()) {
      return unauthorized(config)
    }
    const context = await options.auth.$context
    const user = await context.internalAdapter.findUserById(session.userId)
    if (!user || !isAllowedEmail(config.allowedEmails, user.email)) {
      return refused(403, 'this identity is not allowed')
    }
    const application = await context.adapter.findOne({
      model: 'oauthApplication',
      where: [{ field: 'clientId', value: session.clientId }],
    })
    const name = (application as { name?: unknown } | null)?.name
    return {
      email: normalizeEmail(user.email),
      client: typeof name === 'string' && name !== '' ? name : session.clientId,
    }
  }

  return {
    async fetch(request: Request): Promise<Response> {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
            'Access-Control-Max-Age': '86400',
          },
        })
      }

      const resolved = await operator(request)
      if (resolved instanceof Response) return resolved

      // One minted attributed operator token per request, executed by the
      // operator server (delegated in-process — the signed-token path is
      // genuinely exercised without a network hop).
      const token = mintToken(options.storeSecret, {
        operator: { user: resolved.email },
        via: { kind: 'mcp', client: resolved.client },
        exp: now().getTime() + 30_000,
      })
      const client = new OperatorApiClient({
        url: config.baseURL,
        token,
        fetchFn: asFetch(options.delegate),
      })

      const server = new McpServer(
        { name: 'autobuild', version: AUTOBUILD_VERSION },
        { instructions: MCP_SERVER_INSTRUCTIONS },
      )

      for (const entry of entries) {
        server.registerTool(
          entry.name,
          {
            description: `${entry.description}\n\nReturns: ${entry.outputDescription}`,
            inputSchema: entry.inputSchema,
            annotations: entry.annotations,
          },
          // The SDK validates args against the entry's schema before this
          // runs. The SAME generic closure serves every entry: repo scoping,
          // the wait clamp, delegation, and failure mapping are identical.
          async (args: unknown) => {
            try {
              const parsed = (args ?? {}) as { repo?: unknown }
              if (typeof parsed.repo !== 'string' || !config.repositories.includes(parsed.repo)) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: JSON.stringify({
                        kind: 'validation',
                        error: `repository "${String(parsed.repo)}" is not served by this deployment; call repositories.list for the served identities`,
                      }),
                    },
                  ],
                  isError: true,
                }
              }
              let input: unknown = args
              const waitSeconds = (parsed as { waitSeconds?: unknown }).waitSeconds
              if (entry.name === 'builds.events' && typeof waitSeconds === 'number') {
                input = {
                  ...(args as object),
                  waitSeconds: Math.min(waitSeconds, MCP_MAX_WAIT_SECONDS),
                }
              }
              const value = await client.callTool(parsed.repo, entry.name, input)
              return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
            } catch (error) {
              const body =
                error instanceof OperatorApiError
                  ? {
                      kind: error.kind,
                      error: error.message,
                      ...(error.code !== undefined ? { code: error.code } : {}),
                      ...(error.progress !== undefined ? { progress: error.progress } : {}),
                    }
                  : { kind: 'internal' as const, error: 'operator tool is unavailable' }
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(body) }],
                isError: true,
              }
            }
          },
        )
      }

      // Deployment configuration, not operator state — it does not widen the
      // core registry's closed table.
      server.registerTool(
        'repositories.list',
        {
          description:
            'List the repository identities this deployment serves — the `repo` values every tool accepts.',
          inputSchema: {},
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        async () => ({
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ repositories: [...config.repositories] }),
            },
          ],
        }),
      )

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      await server.connect(transport)
      return transport.handleRequest(request)
    },
  }
}
