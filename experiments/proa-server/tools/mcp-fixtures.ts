/** Offline oracle: production Rust consumes JSON and never starts this process. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  InitializeRequestSchema,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  PingRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { TOOLS } from '../../../packages/core/src/operator/registry'
import type { BuildStore } from '../../../packages/core/src/store/types'
import { validateEventWrite } from '../../../packages/core/src/events/catalog'
import { MemoryBuildStore } from '../../../packages/core/src/store/memory'
import { createHostedStoreService } from '../../../packages/hosted-store-service/src/service'
import { MemoryTicketPolicyStore } from '../../../packages/postgres-store/src/ticket-policy'
import { testAccess } from '../../../packages/hosted-store-service/src/testing/access'
import { testProjects } from '../../../packages/hosted-store-service/src/testing/projects'
import { createMcpEndpoint } from '../../../packages/hosted-store-service/src/web/mcp'
import type { WebAuth } from '../../../packages/hosted-store-service/src/web/auth'
import { parseWebAuthEnv } from '../../../packages/hosted-store-service/src/web/config'
import { sources } from './fixture-core'
import { operatorClock } from './operator-fixtures'
export const mcpRepo = 'https://github.com/acme/widgets'

export const mcpCorpusPath = resolve(import.meta.dir, '../fixtures/mcp-corpus.json')
const origin = 'https://operator.example'
const secret = 'offline-mcp-fixture-secret'
const now = () => new Date(operatorClock)

/** Identity seam only: the endpoint, SDK transport, registry and operator router are real. */
export function mcpOracle() {
  const store = new MemoryBuildStore({ clock: now })
  const projects = testProjects([mcpRepo])
  const env = {
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
    GITHUB_CLIENT_ID: 'offline',
    GITHUB_CLIENT_SECRET: 'offline',
    AB_WEB_AUTH_PROVIDERS: 'github',
    AB_WEB_SUPER_USER_EMAILS: 'operator@example.com',
    AB_WEB_REPOSITORIES: mcpRepo,
    AB_POSTGRES_URL: 'postgres://offline',
    AB_STORE_SECRET: secret,
    AB_BLOB_BACKEND: 's3',
    AB_S3_BUCKET: 'offline',
    AB_S3_REGION: 'us-east-1',
    AB_S3_ACCESS_KEY_ID: 'offline',
    AB_S3_SECRET_ACCESS_KEY: 'offline',
  }
  const config = parseWebAuthEnv(env)
  const delegate = createHostedStoreService({
    env,
    openStore: async () => store,
    openProjectRegistry: async () => projects,
    openTicketPolicy: async () => new MemoryTicketPolicyStore(),
    clock: now,
  })
  const auth = {
    api: {
      getMcpSession: async ({ headers }: { headers: Headers }) =>
        headers.get('authorization') === 'Bearer offline-token'
          ? {
              userId: 'offline-user',
              clientId: 'offline-client',
              accessTokenExpiresAt: new Date(now().getTime() + 3600000),
            }
          : null,
    },
    $context: Promise.resolve({
      internalAdapter: {
        findUserById: async () => ({ email: 'operator@example.com' }),
      },
      adapter: { findOne: async () => ({ name: 'offline-mcp-client' }) },
    }),
  } as unknown as WebAuth
  return {
    store,
    endpoint: createMcpEndpoint({
      projects,
      config,
      access: testAccess(env, projects),
      auth,
      storeSecret: secret,
      delegate: (request) => delegate.fetch(request),
      now,
    }),
  }
}
/** Minimal schema-valid inputs exercise dispatch/refusals, independently of schema failures. */
type SampleSchema = {
  default?: unknown
  const?: unknown
  enum?: unknown[]
  anyOf?: SampleSchema[]
  oneOf?: SampleSchema[]
  type?: string
  required?: string[]
  properties?: Record<string, SampleSchema>
  minimum?: number
}
function sample(schema: SampleSchema): unknown {
  if ('default' in schema) return schema.default
  if ('const' in schema) return schema.const
  if (schema.enum) return schema.enum[0]
  if (schema.anyOf) return sample(schema.anyOf[0]!)
  if (schema.oneOf) return sample(schema.oneOf[0]!)
  if (schema.type === 'object')
    return Object.fromEntries(
      (schema.required ?? []).map((key: string) => [
        key,
        key === 'repo' ? mcpRepo : sample(schema.properties![key]!),
      ]),
    )
  if (schema.type === 'array') return []
  if (schema.type === 'boolean') return false
  if (schema.type === 'number' || schema.type === 'integer') return Math.max(schema.minimum ?? 0, 0)
  if (schema.type === 'null') return null
  return 'missing'
}
export async function seedMcpControl(
  store: BuildStore,
  seed: 'control' | 'merge' | 'land' = 'control',
) {
  const slug = seed === 'control' ? 'mcp-control-build' : `mcp-${seed}-build`
  const corpus = JSON.parse(
    readFileSync(resolve(import.meta.dir, '../fixtures/control-corpus.json'), 'utf8'),
  )
  const fixture = corpus.fixtures.find(
    (f: { scenario: { id: string } }) =>
      f.scenario.id === (seed === 'control' ? 'pause-running' : 'land-ready'),
  )
  const events = JSON.parse(
    JSON.stringify(fixture.seed.events)
      .replaceAll('acme/widgets', mcpRepo)
      .replaceAll('control-build', slug),
  ) as Parameters<typeof validateEventWrite>[0][]
  await store.createBuild({
    slug,
    repo: mcpRepo,
    created: validateEventWrite(events[0]!) as never,
  })
  for (const event of events.slice(1)) await store.append(slug, validateEventWrite(event))
}
export interface McpRequest {
  label: string
  seed?: 'control' | 'merge' | 'land'
  method?: string
  body?: unknown
  rawBody?: string
  authenticated?: boolean
  accept?: string
  protocol?: string
  contentType?: string
}
export async function generateMcpCorpus() {
  const { endpoint, store } = mcpOracle()
  const rpc = (
    label: string,
    method: string,
    params: unknown = {},
    id: unknown = 1,
  ): McpRequest => ({ label, body: { jsonrpc: '2.0', id, method, params } })
  const requests: McpRequest[] = [
    { ...rpc('unauthenticated', 'tools/list'), authenticated: false },
    rpc('initialize', 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'offline', version: '1' },
    }),
    rpc('initialize-old-version', 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'offline', version: '1' },
    }),
    rpc('initialize-unknown-version', 'initialize', {
      protocolVersion: 'unknown',
      capabilities: {},
      clientInfo: { name: 'offline', version: '1' },
    }),
    rpc('initialize-connector-capabilities', 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {
        sampling: { context: {}, tools: {} },
        roots: { listChanged: true },
        elicitation: { form: { applyDefaults: true }, url: {} },
        experimental: { connector: { enabled: true } },
      },
      clientInfo: {
        name: 'connector',
        version: '1',
        title: 'Connector',
        icons: [{ src: 'https://client.test/icon.png' }],
      },
    }),
    rpc('tools/list', 'tools/list'),
    rpc('ping-string-id', 'ping', {}, 'request'),
    rpc('ping-null-id', 'ping', {}, null),
    rpc('unknown-method', 'unknown'),
    {
      label: 'initialized',
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    },
    { label: 'malformed-json', rawBody: '{' },
    { label: 'invalid-envelope', body: {} },
    { ...rpc('missing-accept', 'tools/list'), accept: 'application/json' },
    { label: 'get-sse', method: 'GET' },
    { label: 'get-no-sse', method: 'GET', accept: 'application/json' },
    { ...rpc('unsupported-protocol', 'ping'), protocol: 'invalid' },
    { ...rpc('unsupported-content-type', 'ping'), contentType: 'text/plain' },
    rpc('initialize-invalid-params', 'initialize', {}),
    rpc('call-invalid-params', 'tools/call', {}),
    rpc('call-null-arguments', 'tools/call', { name: 'builds.list', arguments: null }),
    rpc('list-invalid-cursor', 'tools/list', { cursor: 1 }),
    { label: 'delete', method: 'DELETE' },
    { label: 'put', method: 'PUT' },
    { label: 'options', method: 'OPTIONS' },
    rpc('repositories.list', 'tools/call', {
      name: 'repositories.list',
      arguments: {},
    }),
    rpc('unknown-tool', 'tools/call', { name: 'missing.tool', arguments: {} }),
    rpc('builds.list-success', 'tools/call', {
      name: 'builds.list',
      arguments: { repo: mcpRepo },
    }),
    ...['merges.list', 'landings.list'].map((name) =>
      rpc(`${name}-success`, 'tools/call', { name, arguments: { repo: mcpRepo } }),
    ),
    rpc('notes.read-success', 'tools/call', {
      name: 'notes.read',
      arguments: { repo: mcpRepo },
    }),
    rpc('notes.write-success', 'tools/call', {
      name: 'notes.write',
      arguments: { repo: mcpRepo, document: 'MCP fixture notes' },
    }),
  ]
  for (const entry of TOOLS) {
    requests.push(
      rpc(`${entry.name}-schema-refusal`, 'tools/call', {
        name: entry.name,
        arguments: {},
      }),
    )
  }
  for (const entry of TOOLS) {
    const input = sample(
      entry.inputSchema.toJSONSchema({ unrepresentable: 'any' }) as unknown as SampleSchema,
    ) as Record<string, unknown>
    requests.push(
      rpc(`${entry.name}-dispatch`, 'tools/call', { name: entry.name, arguments: input }),
    )
    requests.push(
      rpc(`${entry.name}-unserved`, 'tools/call', {
        name: entry.name,
        arguments: { ...input, repo: 'https://github.com/unknown/repo' },
      }),
    )
  }
  requests.push({
    ...rpc('builds.control-positive', 'tools/call', {
      name: 'builds.control',
      arguments: { repo: mcpRepo, slug: 'mcp-control-build', action: 'pause' },
    }),
    seed: 'control',
  })
  for (const action of ['merge', 'land'] as const)
    requests.push({
      ...rpc(`builds.control-${action}-positive`, 'tools/call', {
        name: 'builds.control',
        arguments: { repo: mcpRepo, slug: `mcp-${action}-build`, action },
      }),
      seed: action,
    })
  const observations = []
  for (const request of requests) {
    if (request.seed) await seedMcpControl(store, request.seed)
    const headers = new Headers({
      'content-type': request.contentType ?? 'application/json',
      accept: request.accept ?? 'application/json, text/event-stream',
    })
    if (request.protocol) headers.set('mcp-protocol-version', request.protocol)
    if (request.authenticated !== false) headers.set('authorization', 'Bearer offline-token')
    const response = await endpoint.fetch(
      new Request(`${origin}/mcp`, {
        method: request.method ?? 'POST',
        headers,
        ...(['GET', 'OPTIONS', 'DELETE'].includes(request.method ?? '')
          ? {}
          : { body: request.rawBody ?? JSON.stringify(request.body ?? {}) }),
      }),
    )
    const sse = response.headers.get('content-type')?.startsWith('text/event-stream')
    if (sse) await response.body?.cancel()
    const text = sse ? '' : await response.text()
    observations.push({
      request,
      status: response.status,
      headers: Object.fromEntries([...response.headers].filter(([key]) => !['date'].includes(key))),
      body: text ? (JSON.parse(text) as unknown) : null,
    })
  }
  const listed = observations.find((o) => o.request.label === 'tools/list')!.body as {
    result: { tools: { name: string }[] }
  }
  const tools = listed.result.tools
  const missing = [...TOOLS.map((t) => t.name), 'repositories.list'].filter(
    (name) => !requests.some((r) => r.label === name || r.label === `${name}-schema-refusal`),
  )
  if (missing.length) throw new Error(`Missing MCP tool coverage: ${missing.join(', ')}`)
  return {
    format: 1,
    manifest: {
      sourceClosureSha256: createHash('sha256').update(JSON.stringify(sources())).digest('hex'),
      generatorSha256: createHash('sha256')
        .update(readFileSync(import.meta.filename))
        .digest('hex'),
    },
    tools,
    protocolSchemas: Object.fromEntries(
      Object.entries({
        initialize: InitializeRequestSchema,
        'tools/call': CallToolRequestSchema,
        'tools/list': ListToolsRequestSchema,
        ping: PingRequestSchema,
      }).map(([name, schema]) => [
        name,
        schema.toJSONSchema({ io: 'input', unrepresentable: 'any' }),
      ]),
    ),
    validationSchemas: Object.fromEntries(
      TOOLS.map((entry) => [
        entry.name,
        entry.inputSchema.toJSONSchema({ unrepresentable: 'any' }),
      ]),
    ),
    coverage: { missing },
    observations,
  }
}
export async function checkMcpCorpus(
  corpus: unknown = JSON.parse(readFileSync(mcpCorpusPath, 'utf8')),
) {
  if (!isDeepStrictEqual(corpus, await generateMcpCorpus()))
    throw new Error('MCP corpus drifted; run tools/mcp-fixtures.ts --write')
}
if (import.meta.main) {
  if (process.argv.includes('--write'))
    await Bun.write(mcpCorpusPath, `${JSON.stringify(await generateMcpCorpus(), null, 2)}\n`)
  else await checkMcpCorpus()
}
