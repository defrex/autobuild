import { type HumanAccess, humanAccess } from './access'
import type { ProjectRegistryReader } from '@defrex/autobuild-postgres-store/projects'
/**
 * The hosted MCP endpoint (AUT-341): the agent tool registry served over
 * Streamable HTTP on the same origin as the operator dashboard, authorized by
 * Better Auth's MCP plugin (OAuth 2.1) and executed through the operator
 * API's token-verified protocol.
 *
 * Attribution path per tool call: the MCP bearer token resolves to the
 * signed-in operator (Better Auth's token store, then current super-user
 * designation or organization membership); admission and repository access
 * are rechecked inside every tool callback, including with a live token;
 * the endpoint mints the same short-lived attributed operator token the web
 * gateway mints, plus a `via` marker naming the MCP client from its OAuth
 * registration; the operator server executes the named registry tool with
 * that token, so every durable write is attributed to the person who
 * authorized the client.
 *
 * The binding is fully data-driven: it iterates the hosted service's served
 * table (`operatorTools`, the same table its operator server dispatches) and
 * registers every entry with one generic handler that delegates to
 * `POST /operator/v1/repos/:repo/tools/:tool`. Advertisement therefore equals
 * dispatch: a filtered tool is neither listed nor served. There are no
 * per-tool branches — when a future ticket adds registry entries, they
 * appear here and execute with no change to this file.
 *
 * Two modes share that one per-call closure, so their behavior cannot drift:
 *
 * - `/mcp` is deployment-wide: every tool takes `repo`, and
 *   `repositories.list` names the repositories the operator can reach.
 * - `/mcp/<host>/<path>` (#1224) serves exactly one registered repository,
 *   the identity `https://<host>/<path>`. Its advertised schemas omit `repo`
 *   (the binding supplies it), a `repo` naming another repository is refused
 *   as `validation`, `repositories.list` is not offered, and `sandbox.*` is
 *   listed only when that repository's latest deposited effective config
 *   enables `[orchestrator]` (one bounded latest-artifact read per listing).
 *   Schema validation happens once, in the operator server's registry. A
 *   non-canonical suffix is 404 before authentication; an unregistered or
 *   unreachable repository is a uniform 404 after it, so the URL is no
 *   existence oracle across organizations.
 *
 * Agent context (#1225): the registry's `context.list` and `context.read`
 * tools serve each repository's captured skills and agent instructions (or
 * the canonical skills bundled with this Autobuild when none are captured).
 * Both modes also expose one MCP prompt per skill (shared naming in
 * `registerContextPrompts`), and append a context section to the server
 * instructions. Instructions travel only in the `initialize` response, so the
 * endpoint peeks at the JSON-RPC body and reads context only for an
 * initialize: one delegated `context.list` per repository in scope (the
 * endpoint's, or every accessible one, four at a time). Prompt indexes load
 * only for `prompts/list` and `prompts/get`; every other request reads
 * nothing new. All context reads go through the same attributed delegation
 * as tool calls.
 *
 * Token audience (RFC 8707, recorded by ./mcp-resource-binding): a token
 * issued for a per-repository URL is accepted only there; an unbound token
 * (legacy, or issued for `/mcp`) is accepted at every URL, because
 * repository access is still rechecked on every call. Any other token gets a
 * 401 `invalid_token` challenge naming this endpoint's metadata, so the
 * client re-authorizes. The check runs on the request and again in every
 * tool callback.
 *
 * The delegation is in-process. The inbound request's `x-vercel-oidc-token`
 * header (the only place a Vercel Function receives its OIDC token) is copied
 * onto the delegated request so sandbox tools can authenticate the provider;
 * nothing else is forwarded, and the token never leaves the function.
 *
 * Transport: a stateless `WebStandardStreamableHTTPServerTransport` (fresh
 * transport + server per request, JSON responses, no session
 * validation) — built for runtimes like Vercel Functions where no
 * server-lifetime state survives between requests. All identity is resolved
 * per request from the bearer token, so cold starts behave identically to
 * warm instances. GET serves the SDK's standalone SSE stream with 200 —
 * stateless mode disables session validation, not server-to-client streams
 * (pinned by the test in src/web/mcp.io.integration.test.ts) — and DELETE answers 200,
 * discarding the per-request transport. 405 is reserved for methods outside
 * GET/POST/DELETE, which the MCP transport contract permits for stateless
 * servers.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { OperatorApiClient, OperatorApiError } from '../operator-client'
import {
  contextInstructions,
  promptLabel,
  registerContextPrompts,
  type ContextEntry,
  type ContextIndex,
  type ContextPromptSource,
  type ContextReadResult,
  type ToolEntry,
} from '@defrex/autobuild/operator'
import { AUTOBUILD_VERSION, mintToken } from '@defrex/autobuild/remote-store'
import { normalizeEmail } from './config'
import type { WebAuth } from './auth'
import type { WebAuthConfig } from './config'
import { readResourceBinding, tokenAccepted, type BindingAdapter } from './mcp-resource-binding'
import {
  protectedResourceMetadataURL,
  repositoryFromMcpSuffix,
  repositoryMcpResource,
} from './mcp-resource'

const OIDC_HEADER = 'x-vercel-oidc-token'

function asFetch(
  delegate: (request: Request) => Promise<Response>,
  inbound: Request,
): typeof fetch {
  // OperatorApiClient calls fetchFn(url, init) with a string URL; the hosted
  // service's fetch takes a Request.
  const oidcToken = inbound.headers.get(OIDC_HEADER)?.trim()
  return ((input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    if (oidcToken) request.headers.set(OIDC_HEADER, oidcToken)
    return delegate(request)
  }) as unknown as typeof fetch
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
  'Start with `context.list`: it names the skills and agent instructions to load before acting.',
  'Mutating tools append durable, human-attributed events under the signed-in operator who authorized this client; destructive controls are annotated.',
  'Sandbox tools act in repositories whose latest effective config does not disable `[orchestrator]`; a call for another repository is refused with a typed `sandbox-*` code that names the reason.',
  'Start each operator round with `repository.attention`: one call returns everything waiting on the operator, each item naming the tool call that resolves it; pass back its cursor next time.',
  'Read tools mirror the operator API routes — every result equals the corresponding route — and `builds.events` after a cursor is the polling companion to `builds.get`; `repository.events` after a cursor delivers repository attention such as `ticket.handed-back`.',
].join(' ')

/** Server instructions for the deployment-wide endpoint, with the agent
 * context section for every repository the operator can access. */
export function deploymentMcpInstructions(context?: readonly ContextEntry[]): string {
  return context === undefined
    ? MCP_SERVER_INSTRUCTIONS
    : `${MCP_SERVER_INSTRUCTIONS}\n${contextInstructions(context, { scoped: false })}`
}

/** Server instructions for a per-repository endpoint: they name its one
 * repository and say nothing about any other project. `context`, when given,
 * appends that repository's agent context section. */
export function repositoryMcpInstructions(repo: string, context?: ContextEntry): string {
  const base = [
    `Autobuild operator tools for the repository ${repo}: builds, repository and harvest controls, tickets, and operator notes.`,
    'Autobuild runs builds from tickets: a dispatcher claims groomed tickets, an embedded agent implements each build through plan/implement/verify rounds, and every durable action is attributed.',
    `This connector serves only ${repo}: every tool acts on it, and no tool takes a \`repo\` argument.`,
    'Start with `context.list`: it names the skills and agent instructions to load before acting.',
    'Mutating tools append durable, human-attributed events under the signed-in operator who authorized this client; destructive controls are annotated.',
    "Sandbox tools are listed when this repository's latest deposited effective config enables `[orchestrator]`; a sandbox call while it does not is refused with a typed `sandbox-*` code that names the reason.",
    'Read tools mirror the operator API routes — every result equals the corresponding route — and `builds.events` after a cursor is the polling companion to `builds.get`; `repository.events` after a cursor delivers repository attention such as `ticket.handed-back`.',
  ].join(' ')
  return context === undefined
    ? base
    : `${base}\n${contextInstructions([context], { scoped: true })}`
}

/** Whether a POST body is (or batches) an MCP `initialize` request — the
 * only response that carries server instructions. Read from a clone, so the
 * transport still reads the original; anything unparsable is false. */
async function requestsInitialize(request: Request): Promise<boolean> {
  if (request.method !== 'POST') return false
  try {
    const body = (await request.clone().json()) as unknown
    const messages = Array.isArray(body) ? body : [body]
    return messages.some(
      (message) =>
        message !== null &&
        typeof message === 'object' &&
        (message as { method?: unknown }).method === 'initialize',
    )
  } catch {
    return false
  }
}

/** Run `work` over `items`, at most `limit` at a time, keeping order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index]!)
    }
  })
  await Promise.all(lanes)
  return results
}

/** Concurrent context reads per deployment-wide request. */
const CONTEXT_CONCURRENCY = 4

/** Remove `repo` from a JSON Schema object's properties and required list,
 * recursing into top-level union and intersection branches. */
function withoutRepo(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema }
  if (out.properties !== null && typeof out.properties === 'object') {
    const { repo: _repo, ...properties } = out.properties as Record<string, unknown>
    out.properties = properties
  }
  if (Array.isArray(out.required)) {
    const required = out.required.filter((key) => key !== 'repo')
    if (required.length > 0) out.required = required
    else delete out.required
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = out[key]
    if (Array.isArray(branches))
      out[key] = branches.map((branch) =>
        branch !== null && typeof branch === 'object'
          ? withoutRepo(branch as Record<string, unknown>)
          : branch,
      )
  }
  return out
}

/** The advertised definitions for a per-repository endpoint: each entry's
 * schema converted exactly as `McpServer` converts it, minus `repo`. */
export function repositoryScopedToolDefinitions(entries: readonly ToolEntry[]): Tool[] {
  return entries.map((entry) => {
    const object = normalizeObjectSchema(entry.inputSchema as never)
    const schema = object
      ? (toJsonSchemaCompat(object, { strictUnions: true, pipeStrategy: 'input' }) as Record<
          string,
          unknown
        >)
      : { type: 'object', properties: {} }
    return {
      name: entry.name,
      description: toolDescription(entry),
      inputSchema: withoutRepo(schema) as Tool['inputSchema'],
      annotations: entry.annotations,
      // McpServer's default for a tool registered without task support.
      execution: { taskSupport: 'forbidden' },
    }
  })
}

function toolDescription(entry: ToolEntry): string {
  return `${entry.description}\n\nReturns: ${entry.outputDescription}`
}

export interface McpEndpointOptions {
  access?: HumanAccess
  projects: ProjectRegistryReader
  /** The parsed web auth config (baseURL, mcpResource). */
  config: WebAuthConfig
  /** The Better Auth instance carrying the MCP plugin. */
  auth: WebAuth
  /** The store signing secret the operator token is minted with. */
  storeSecret: string
  /** The hosted service's own fetch — the delegation target for tool calls. */
  delegate: (request: Request) => Promise<Response>
  now?: () => Date
  /** The operator server's served table, `hostedService().operatorTools`.
   * Required: advertising any other table lets listing drift from dispatch. */
  entries: readonly ToolEntry[]
  /** Whether a per-repository endpoint lists `sandbox.*` for its repository,
   * `hostedService().listsSandboxTools`. Called at most once per listing and
   * only when the served table has sandbox entries; absent means never
   * listed per repository. A rejection omits them (fail closed). */
  sandboxListed?: (repo: string) => Promise<boolean>
}

/** The resource one request addresses and its RFC 9728 metadata URL. */
interface McpResourceEndpoint {
  resource: string
  metadata: string
  /** Set on a per-repository endpoint: the one repository it serves. */
  repo?: string
}

/** The JSON-RPC error body the plugin's `withMcpAuth` returns on 401,
 * mirrored here so the endpoint fails identically. A token bound to another
 * resource adds `error="invalid_token"` so the client re-authorizes. */
function unauthorized(metadata: string, invalidToken = false): Response {
  const challenge = `Bearer ${invalidToken ? 'error="invalid_token", ' : ''}resource_metadata="${metadata}"`
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

function refused(status: 401 | 403 | 404 | 503, message: string): Response {
  return Response.json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }, { status })
}

function textResult(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  }
}

const PER_REPOSITORY_PREFIX = '/mcp/'

/** The resolved operator behind one request's bearer token. */
interface McpOperator {
  email: string
  client: string
}

export function createMcpEndpoint(options: McpEndpointOptions): {
  fetch(request: Request): Promise<Response>
} {
  const access = options.access ?? humanAccess
  const config = options.config
  const now = options.now ?? (() => new Date())
  const entries = options.entries
  const deploymentResource = config.mcpResource.replace(/\/$/, '')
  const deployment: McpResourceEndpoint = {
    resource: deploymentResource,
    metadata: `${config.baseURL}/.well-known/oauth-protected-resource`,
  }
  const served = new Map(entries.map((entry) => [entry.name as string, entry]))
  const servesSandbox = entries.some((entry) => entry.name.startsWith('sandbox.'))
  let scopedDefinitions: Tool[] | undefined

  /** Resolve the bearer token to the signed-in operator: Better Auth's MCP
   * token store finds the oauthAccessToken row (the plugin does not check
   * expiry — the resource must), the user must still be admitted,
   * the client name comes from the token's OAuth registration, and the
   * token's recorded audience must cover the addressed endpoint. */
  async function operator(
    request: Request,
    endpoint: McpResourceEndpoint,
  ): Promise<McpOperator | Response> {
    const session = await options.auth.api.getMcpSession({ headers: request.headers })
    if (!session) return unauthorized(endpoint.metadata)
    if (
      !Number.isFinite(new Date(session.accessTokenExpiresAt).getTime()) ||
      new Date(session.accessTokenExpiresAt).getTime() <= now().getTime()
    ) {
      return unauthorized(endpoint.metadata)
    }
    const context = await options.auth.$context
    const user = await context.internalAdapter.findUserById(session.userId)
    if (!user || !(await access.principal(user.email))) {
      return refused(403, 'this identity is not allowed')
    }
    const application = await context.adapter.findOne({
      model: 'oauthApplication',
      where: [{ field: 'clientId', value: session.clientId }],
    })
    const tokenRowId = (session as { id?: unknown }).id
    const binding =
      typeof tokenRowId === 'string'
        ? await readResourceBinding(context.adapter as BindingAdapter, tokenRowId, now())
        : undefined
    if (!tokenAccepted(binding, deploymentResource, endpoint.resource)) {
      return unauthorized(endpoint.metadata, true)
    }
    const name = (application as { name?: unknown } | null)?.name
    return {
      email: normalizeEmail(user.email),
      client: typeof name === 'string' && name !== '' ? name : session.clientId,
    }
  }

  /** Execute one registry tool through the operator API, attributed to
   * `current`. Throws `OperatorApiError` on a refusal. */
  async function delegatedCall(
    request: Request,
    current: McpOperator,
    repo: string,
    toolName: string,
    input: unknown,
  ): Promise<unknown> {
    const token = mintToken(options.storeSecret, {
      version: 1,
      internalOperator: { user: current.email, repo },
      via: { kind: 'mcp', client: current.client },
      exp: now().getTime() + 30_000,
    })
    const client = new OperatorApiClient({
      url: config.baseURL,
      token,
      fetchFn: asFetch(options.delegate, request),
    })
    return client.callTool(repo, toolName, input)
  }

  /** The repositories a request's agent context covers: the endpoint's one,
   * or every repository the operator can access. */
  async function contextRepos(current: McpOperator, endpoint: McpResourceEndpoint) {
    if (endpoint.repo !== undefined) return [endpoint.repo]
    const principal = await access.principal(current.email)
    return principal ? access.projects(principal) : []
  }

  /** `context.list` for each repository (bounded concurrency); a failure is
   * that repository's error entry, never the whole request's. */
  async function contextEntries(
    request: Request,
    current: McpOperator,
    repos: readonly string[],
  ): Promise<ContextEntry[]> {
    return mapLimit(repos, CONTEXT_CONCURRENCY, async (repo): Promise<ContextEntry> => {
      try {
        const index = (await delegatedCall(request, current, repo, 'context.list', {
          repo,
        })) as ContextIndex | null
        if (
          index === null ||
          typeof index !== 'object' ||
          !Array.isArray(index.skills) ||
          !Array.isArray(index.instructions) ||
          index.load === undefined
        )
          return { repo, error: 'context.list returned no index' }
        return { repo, index }
      } catch (error) {
        return { repo, error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  /** The prompt source for one request: indexes load lazily, only for
   * `prompts/list` and `prompts/get`. */
  function promptSource(
    request: Request,
    current: McpOperator,
    endpoint: McpResourceEndpoint,
  ): ContextPromptSource {
    return {
      scoped: endpoint.repo !== undefined,
      async indexes(label) {
        const repos = (await contextRepos(current, endpoint)).filter(
          (repo) => label === undefined || promptLabel(repo) === label,
        )
        const entries = await contextEntries(request, current, repos)
        return entries.filter(
          (entry): entry is { repo: string; index: ContextIndex } => 'index' in entry,
        )
      },
      read: async (repo, path) =>
        (await delegatedCall(request, current, repo, 'context.read', {
          repo,
          path,
        })) as ContextReadResult,
    }
  }

  /** The one per-call closure both modes run: the operator recheck,
   * repository access, the wait clamp, the attributed delegation and failure
   * mapping. `args.repo` names the repository (the per-repository mode has
   * already set it to the endpoint's). */
  async function runTool(
    request: Request,
    endpoint: McpResourceEndpoint,
    entry: ToolEntry,
    args: unknown,
  ): Promise<CallToolResult> {
    try {
      const current = await operator(request, endpoint)
      if (current instanceof Response)
        throw new OperatorApiError(403, 'auth', 'this identity is not allowed')
      const principal = await access.principal(current.email)
      if (!principal) throw new Error('access refused')
      const parsed = (args ?? {}) as { repo?: unknown }
      if (
        typeof parsed.repo !== 'string' ||
        !(await options.projects.has(parsed.repo)) ||
        !(await access.canAccess(principal, parsed.repo))
      ) {
        return textResult(
          endpoint.repo === undefined
            ? {
                kind: 'validation',
                error: `repository "${String(parsed.repo)}" is not served by this deployment; call repositories.list for the served identities`,
              }
            : {
                kind: 'auth',
                error: `this operator can no longer reach repository "${endpoint.repo}"`,
              },
          true,
        )
      }
      let input: unknown = args
      const waitSeconds = (parsed as { waitSeconds?: unknown }).waitSeconds
      if (
        (entry.name === 'builds.events' || entry.name === 'repository.events') &&
        typeof waitSeconds === 'number'
      ) {
        input = {
          ...(args as object),
          waitSeconds: Math.min(waitSeconds, MCP_MAX_WAIT_SECONDS),
        }
      }
      return textResult(await delegatedCall(request, current, parsed.repo, entry.name, input))
    } catch (error) {
      return textResult(
        error instanceof OperatorApiError
          ? {
              kind: error.kind,
              error: error.message,
              ...(error.code !== undefined ? { code: error.code } : {}),
              ...(error.progress !== undefined ? { progress: error.progress } : {}),
            }
          : { kind: 'internal' as const, error: 'operator tool is unavailable' },
        true,
      )
    }
  }

  function deploymentServer(
    request: Request,
    current: McpOperator,
    context: readonly ContextEntry[] | undefined,
  ): McpServer {
    const server = new McpServer(
      { name: 'autobuild', version: AUTOBUILD_VERSION },
      { instructions: deploymentMcpInstructions(context) },
    )
    registerContextPrompts(server.server, promptSource(request, current, deployment))
    for (const entry of entries) {
      server.registerTool(
        entry.name,
        {
          description: toolDescription(entry),
          inputSchema: entry.inputSchema,
          annotations: entry.annotations,
        },
        // The SDK validates args against the entry's schema before this runs.
        async (args: unknown) => runTool(request, deployment, entry, args),
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
      async () => {
        try {
          const current = await operator(request, deployment)
          if (current instanceof Response) throw new Error('access refused')
          const principal = await access.principal(current.email)
          if (!principal) throw new Error('access refused')
          const repositories = await access.projects(principal)
          return textResult({ repositories })
        } catch {
          return textResult({ kind: 'internal', error: 'project registry is unavailable' }, true)
        }
      },
    )
    return server
  }

  function repositoryServer(
    request: Request,
    endpoint: McpResourceEndpoint & { repo: string },
    current: McpOperator,
    context: ContextEntry | undefined,
  ) {
    const repo = endpoint.repo
    const server = new Server(
      { name: 'autobuild', version: AUTOBUILD_VERSION },
      {
        capabilities: { tools: {}, prompts: {} },
        instructions: repositoryMcpInstructions(repo, context),
      },
    )
    registerContextPrompts(server, promptSource(request, current, endpoint))
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      scopedDefinitions ??= repositoryScopedToolDefinitions(entries)
      const sandbox =
        servesSandbox && options.sandboxListed !== undefined
          ? await options.sandboxListed(repo).catch(() => false)
          : false
      return {
        tools: sandbox
          ? scopedDefinitions
          : scopedDefinitions.filter((tool) => !tool.name.startsWith('sandbox.')),
      }
    })
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      const entry = served.get(call.params.name)
      if (entry === undefined) {
        // McpServer's shape for an unknown tool: an error result, not a
        // JSON-RPC error.
        const error = new McpError(ErrorCode.InvalidParams, `Tool ${call.params.name} not found`)
        return { content: [{ type: 'text' as const, text: error.message }], isError: true }
      }
      const args = call.params.arguments ?? {}
      if (args.repo !== undefined && args.repo !== repo) {
        return textResult(
          {
            kind: 'validation',
            error: `this connector serves "${repo}"; omit \`repo\``,
          },
          true,
        )
      }
      return runTool(request, endpoint, entry, { ...args, repo })
    })
    return server
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

      const pathname = new URL(request.url).pathname
      let endpoint: McpResourceEndpoint = deployment
      if (pathname.startsWith(PER_REPOSITORY_PREFIX)) {
        const repo = repositoryFromMcpSuffix(pathname.slice(PER_REPOSITORY_PREFIX.length))
        if (repo === undefined) return refused(404, 'no repository is served at this URL')
        const resource = repositoryMcpResource(deploymentResource, repo)
        endpoint = {
          resource,
          metadata: protectedResourceMetadataURL(config.baseURL, resource),
          repo,
        }
      }

      let resolved: McpOperator | Response
      try {
        resolved = await operator(request, endpoint)
        if (resolved instanceof Response) return resolved
        if (endpoint.repo !== undefined) {
          const principal = await access.principal(resolved.email)
          if (
            !principal ||
            !(await options.projects.has(endpoint.repo)) ||
            !(await access.canAccess(principal, endpoint.repo))
          ) {
            return refused(404, 'repository is not served to this operator')
          }
        }
      } catch {
        return refused(503, 'access service is unavailable')
      }

      // Instructions travel only in the `initialize` response, and every
      // request builds a fresh server, so the agent context is read only for
      // an initialize: one `context.list` per repository in scope. Every
      // other method (tools/list, tools/call, …) reads nothing new.
      const context = (await requestsInitialize(request))
        ? await contextEntries(
            request,
            resolved,
            await contextRepos(resolved, endpoint).catch(() => []),
          )
        : undefined
      const server =
        endpoint.repo === undefined
          ? deploymentServer(request, resolved, context)
          : repositoryServer(request, { ...endpoint, repo: endpoint.repo }, resolved, context?.[0])
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      await server.connect(transport)
      return transport.handleRequest(request)
    },
  }
}
