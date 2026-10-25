/** Offline TypeScript HTTP oracle. Production Rust must never invoke this tool. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { normalizeOperator } from '../../../packages/core/src/store/types'
import { MemoryBuildStore } from '../../../packages/core/src/store/memory'
import { reduceSession } from '../../../packages/core/src/store/session-reducer'
import { createOperatorServer } from '../../../packages/hosted-store-service/src/operator-server'
import { testProjects } from '../../../packages/hosted-store-service/src/testing/projects'
import * as historical from '../../../packages/hosted-store-service/src/compatibility-fixtures/operator-v0.9'
import { buildRegistry } from '../../../packages/core/src/operator/registry'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '../../../packages/core/src/store/remote/version'
import {
  supportedClientRange,
  RELEASE_LINE_PROTOCOLS,
} from '../../../packages/core/src/store/remote/compatibility'
import { mintToken } from '../../../packages/core/src/store/remote/token'
import { sources, root, experiment } from './fixture-core'

export const operatorClock = '2026-09-02T00:00:00.000Z'
export const operatorRepo = 'acme/widgets'
const secret = 'offline-operator-fixture-secret'
const clock = () => new Date(operatorClock)
const corpusPath = resolve(experiment, 'fixtures/operator-corpus.json')

/** Every typed route, including retired setting seams and generic registry dispatch. */
export const operatorRoutes = [
  ['GET', 'builds'],
  ['GET', 'builds/:slug'],
  ['GET', 'dashboard'],
  ['GET', 'status'],
  ['GET', 'harvest/status'],
  ['GET', 'builds/:slug/artifacts/:kind'],
  ['POST', 'builds/:slug/control'],
  ['POST', 'builds/:slug/restack'],
  ['POST', 'builds/:slug/answer'],
  ['PUT', 'settings/intake'],
  ['POST', 'settings/intake/toggle'],
  ['PUT', 'settings/auto-merge-default'],
  ['POST', 'settings/auto-merge-default/toggle'],
  ['POST', 'bulk-control'],
  ['POST', 'harvest/control'],
  ['GET', 'tickets'],
  ['GET', 'tickets/states'],
  ['POST', 'tickets/states'],
  ['GET', 'tickets/:id'],
  ['POST', 'tickets'],
  ['PATCH', 'tickets/:id'],
  ['POST', 'tickets/:id/move'],
  ['POST', 'tickets/:id/block'],
  ['POST', 'tickets/:id/unblock'],
  ['GET', 'sessions'],
  ['POST', 'sessions'],
  ['GET', 'sessions/:sid'],
  ['POST', 'sessions/:sid/messages'],
  ['PUT', 'sessions/:sid/wake'],
  ['POST', 'sessions/:sid/approvals'],
  ['POST', 'sessions/:sid/archive'],
  ['GET', 'sessions/:sid/turns/:turn/stream'],
  ['POST', 'tools/:tool'],
].map(([method, path]) => `${method} ${path}`)
export const operatorBuildActions = [
  'pause',
  'cancel-pause',
  'resume',
  'abort',
  'discard',
  'land',
  'hold',
]
export const operatorAnswers = [
  'guidance',
  'retry',
  'dismiss',
  'review-round-ceiling',
  'revise-spec:body',
  'revise-spec:ticket',
]

export interface OperatorRequest {
  method: string
  path: string
  body?: unknown
  rawBody?: string
  user?: string
  auth?: 'missing' | 'invalid' | 'expired' | 'foreign' | 'admin' | 'operator'
  version?: string | null
  protocol?: string | null
}
export interface OperatorScenario {
  id: string
  route: string
  covers?: string[]
  seed?: 'session' | 'approval' | 'archived' | 'foreign-session'
  requests: OperatorRequest[]
}
interface Observation {
  request: OperatorRequest
  status: number
  headers: Record<string, string>
  body: unknown
  /** Full ordered post-log; the suffix after seed/previous observation is the durable delta. */
  sessions: { record: unknown; events: unknown[]; state: unknown }[]
}
export interface OperatorFixture {
  scenario: OperatorScenario
  bindings: string[]
  seed: Observation['sessions']
  observations: Observation[]
}
export interface OperatorCorpus {
  format: 1
  checkpoint: 'session-and-validation-foundation'
  manifest: ReturnType<typeof operatorManifest>
  inventory: ReturnType<typeof operatorInventory>
  coverage: {
    routes: string[]
    missingRoutes: string[]
    missingBuildActions: string[]
    missingAnswers: string[]
    missingTools: string[]
  }
  fixtures: OperatorFixture[]
}

export function operatorInventory() {
  const store = new MemoryBuildStore({ clock })
  return {
    routes: operatorRoutes,
    buildActions: operatorBuildActions,
    answers: operatorAnswers,
    tools: buildRegistry({ store, clock })
      .entries.map((entry) => entry.name)
      .sort(),
  }
}
export function operatorManifest() {
  // Hash the complete TS oracle closure, not just the directly imported router.
  const oracleSources = sources()
  return {
    sourceClosureSha256: createHash('sha256').update(JSON.stringify(oracleSources)).digest('hex'),
    sourceFiles: Object.keys(oracleSources).length,
    generatorSha256: createHash('sha256')
      .update(readFileSync(import.meta.filename))
      .digest('hex'),
    documentationSha256: createHash('sha256')
      .update(readFileSync(resolve(root, 'docs/operator-api.md')))
      .digest('hex'),
    identity: {
      version: AUTOBUILD_VERSION,
      protocol: REMOTE_STORE_PROTOCOL_VERSION,
      window: supportedClientRange(),
      historicalProtocols: RELEASE_LINE_PROTOCOLS,
    },
    clock: operatorClock,
    operatorNormalization: [
      ' owner@example.com ',
      '\uFEFFOwner@Example.com\uFEFF',
      '\u0085Owner@Example.com\u0085',
      '\uFEFF \t\n',
      '',
      '\u2007Owner@Example.com\u202F',
      'Owner\uFEFFName',
    ].map((input) => {
      try {
        return { input, owner: normalizeOperator(input) }
      } catch (error) {
        return { input, error: (error as Error).message }
      }
    }),
    // Only concrete generated session ids are bound. Timestamps, actor, sequence and text stay exact.
    bindings: {
      '$session:N':
        'the Nth session id generated by the TypeScript store in this isolated scenario',
    },
    attributionExceptions: [
      {
        surface: 'ticket-row mutations',
        observation: 'obs_675b94d9',
        reason: 'Preserve TypeScript storage parity; no invented durable ticket audit schema.',
      },
    ],
  }
}

export function operatorScenarios(): OperatorScenario[] {
  const one = (
    id: string,
    route: string,
    request: OperatorRequest,
    seed?: OperatorScenario['seed'],
  ): OperatorScenario => ({ id, route, ...(seed ? { seed } : {}), requests: [request] })
  const scenarios: OperatorScenario[] = [
    one('identity-before-auth', 'GET sessions', {
      method: 'GET',
      path: 'sessions',
      version: null,
      protocol: null,
      auth: 'missing',
    }),
    one('identity-invalid', 'GET sessions', {
      method: 'GET',
      path: 'sessions',
      version: 'invalid',
      auth: 'missing',
    }),
    one('identity-old-major', 'GET sessions', {
      method: 'GET',
      path: 'sessions',
      version: '0.9.0',
      protocol: '3',
    }),
    one('identity-protocol', 'GET sessions', { method: 'GET', path: 'sessions', protocol: '3' }),
    ...(['missing', 'invalid', 'expired', 'foreign'] as const).map((auth) =>
      one(`auth-${auth}`, 'GET sessions', { method: 'GET', path: 'sessions', auth }),
    ),
    one('invalid-json', 'POST sessions', { method: 'POST', path: 'sessions', rawBody: '{' }),
    one('session-create-json-bom', 'POST sessions', {
      method: 'POST',
      path: 'sessions',
      rawBody: '\uFEFF{"title":"BOM session"}',
    }),
    one('session-create-unknown-field', 'POST sessions', {
      method: 'POST',
      path: 'sessions',
      body: { title: 'New', user: 'forged' },
    }),
    one('session-create-empty-title', 'POST sessions', {
      method: 'POST',
      path: 'sessions',
      body: { title: '' },
    }),
    one('session-create', 'POST sessions', {
      method: 'POST',
      path: 'sessions',
      body: { title: 'Inspect build' },
    }),
    one('session-create-default', 'POST sessions', { method: 'POST', path: 'sessions', body: {} }),
    one('session-list', 'GET sessions', { method: 'GET', path: 'sessions' }, 'session'),
    one(
      'session-detail',
      'GET sessions/:sid',
      { method: 'GET', path: 'sessions/$session:0' },
      'session',
    ),
    one(
      'session-foreign-hidden',
      'GET sessions/:sid',
      { method: 'GET', path: 'sessions/$session:0' },
      'foreign-session',
    ),
    one('session-missing', 'GET sessions/:sid', { method: 'GET', path: 'sessions/missing' }),
    one(
      'session-message',
      'POST sessions/:sid/messages',
      {
        method: 'POST',
        path: 'sessions/$session:0/messages',
        body: { text: '  Help with this build  ' },
      },
      'session',
    ),
    one(
      'session-message-whitespace',
      'POST sessions/:sid/messages',
      { method: 'POST', path: 'sessions/$session:0/messages', body: { text: '  ' } },
      'session',
    ),
    one(
      'session-message-forged-actor',
      'POST sessions/:sid/messages',
      {
        method: 'POST',
        path: 'sessions/$session:0/messages',
        body: { text: 'Help', actor: { kind: 'human', user: 'forged' } },
      },
      'session',
    ),
    one(
      'session-other-reader',
      'GET sessions/:sid',
      { method: 'GET', path: 'sessions/$session:0', user: 'other@example.com' },
      'session',
    ),
    one(
      'session-other-writer',
      'POST sessions/:sid/messages',
      {
        method: 'POST',
        path: 'sessions/$session:0/messages',
        user: 'other@example.com',
        body: { text: 'Help' },
      },
      'session',
    ),
    one(
      'session-wake',
      'PUT sessions/:sid/wake',
      { method: 'PUT', path: 'sessions/$session:0/wake', body: { globs: ['escalation.*'] } },
      'session',
    ),
    one(
      'session-wake-empty',
      'PUT sessions/:sid/wake',
      { method: 'PUT', path: 'sessions/$session:0/wake', body: { globs: [] } },
      'session',
    ),
    one(
      'session-wake-invalid',
      'PUT sessions/:sid/wake',
      { method: 'PUT', path: 'sessions/$session:0/wake', body: { globs: [''] } },
      'session',
    ),
    one(
      'session-approval-approve',
      'POST sessions/:sid/approvals',
      {
        method: 'POST',
        path: 'sessions/$session:0/approvals',
        body: { turn: 'ot_fixture', toolCallId: 'call_fixture', decision: 'approve' },
      },
      'approval',
    ),
    one(
      'session-approval-deny',
      'POST sessions/:sid/approvals',
      {
        method: 'POST',
        path: 'sessions/$session:0/approvals',
        body: { turn: 'ot_fixture', toolCallId: 'call_fixture', decision: 'deny' },
      },
      'approval',
    ),
    one(
      'session-approval-mismatch',
      'POST sessions/:sid/approvals',
      {
        method: 'POST',
        path: 'sessions/$session:0/approvals',
        body: { turn: 'ot_other', toolCallId: 'call_fixture', decision: 'approve' },
      },
      'approval',
    ),
    one(
      'session-approval-none',
      'POST sessions/:sid/approvals',
      {
        method: 'POST',
        path: 'sessions/$session:0/approvals',
        body: { turn: 'ot_fixture', toolCallId: 'call_fixture', decision: 'approve' },
      },
      'session',
    ),
    one(
      'session-archive',
      'POST sessions/:sid/archive',
      { method: 'POST', path: 'sessions/$session:0/archive' },
      'session',
    ),
    one(
      'session-archive-again',
      'POST sessions/:sid/archive',
      { method: 'POST', path: 'sessions/$session:0/archive' },
      'archived',
    ),
    one(
      'session-archived-message',
      'POST sessions/:sid/messages',
      { method: 'POST', path: 'sessions/$session:0/messages', body: { text: 'Help' } },
      'archived',
    ),
    one(
      'session-stream-unknown-turn',
      'GET sessions/:sid/turns/:turn/stream',
      { method: 'GET', path: 'sessions/$session:0/turns/missing/stream?since=0&wait=0' },
      'session',
    ),
    one(
      'session-stream-invalid-since',
      'GET sessions/:sid/turns/:turn/stream',
      { method: 'GET', path: 'sessions/$session:0/turns/missing/stream?since=-1' },
      'session',
    ),
    one(
      'session-stream-invalid-wait',
      'GET sessions/:sid/turns/:turn/stream',
      { method: 'GET', path: 'sessions/$session:0/turns/missing/stream?wait=0.1' },
      'session',
    ),
    one('build-scope-invalid', 'GET builds', { method: 'GET', path: 'builds?scope=unknown' }),
    one('build-detail-unknown', 'GET builds/:slug', { method: 'GET', path: 'builds/missing' }),
    one('artifact-invalid-revision', 'GET builds/:slug/artifacts/:kind', {
      method: 'GET',
      path: 'builds/missing/artifacts/spec?rev=1.5',
    }),
    one('artifact-unsafe-revision', 'GET builds/:slug/artifacts/:kind', {
      method: 'GET',
      path: 'builds/missing/artifacts/spec?rev=9007199254740992',
    }),
    one('restack-unknown', 'POST builds/:slug/restack', {
      method: 'POST',
      path: 'builds/missing/restack',
    }),
    one('intake-unknown-field', 'PUT settings/intake', {
      method: 'PUT',
      path: 'settings/intake',
      body: { enabled: true, unexpected: true },
    }),
    one('bulk-unknown-field', 'POST bulk-control', {
      method: 'POST',
      path: 'bulk-control',
      body: { action: 'pause', unexpected: true },
    }),
    one('harvest-invalid-run', 'POST harvest/control', {
      method: 'POST',
      path: 'harvest/control',
      body: { action: 'run', run: '' },
    }),
    one('tool-unknown', 'POST tools/:tool', {
      method: 'POST',
      path: 'tools/missing',
      body: { repo: operatorRepo },
    }),
    one('tool-repo-mismatch-before-lookup', 'POST tools/:tool', {
      method: 'POST',
      path: 'tools/missing',
      body: { repo: 'foreign/repo' },
    }),
    one('tool-input-object', 'POST tools/:tool', {
      method: 'POST',
      path: 'tools/builds.list',
      body: [],
    }),
    one('tool-invalid-json', 'POST tools/:tool', {
      method: 'POST',
      path: 'tools/builds.list',
      rawBody: '{',
    }),
    one('answer-retry-text-rejected', 'POST builds/:slug/answer', {
      method: 'POST',
      path: 'builds/missing/answer',
      body: { resolution: 'retry', text: 'ignored?' },
    }),
  ]
  for (const action of operatorBuildActions)
    scenarios.push(
      one(`build-${action}-unknown`, 'POST builds/:slug/control', {
        method: 'POST',
        path: 'builds/missing/control',
        body: { action },
      }),
    )
  return scenarios
}

/** Replace only explicitly bound generated ids, including their occurrences in refusal text. */
export function bindOperatorIds(value: unknown, bindings: readonly string[]): unknown {
  if (typeof value === 'string')
    return bindings.reduce((text, id, index) => text.replaceAll(id, `$session:${index}`), value)
  if (Array.isArray(value)) return value.map((item) => bindOperatorIds(item, bindings))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, bindOperatorIds(item, bindings)]),
    )
  return value
}

export async function replayOperatorScenario(scenario: OperatorScenario): Promise<OperatorFixture> {
  const store = new MemoryBuildStore({ clock })
  const projects = testProjects([operatorRepo, 'foreign/repo'])
  const server = createOperatorServer({ store, projects, secret, clock })
  const bindings: string[] = []
  if (scenario.seed) {
    const session = await store.createSession({
      repo: scenario.seed === 'foreign-session' ? 'foreign/repo' : operatorRepo,
      operator: 'operator@example.com',
      title: 'Seed session',
    })
    bindings.push(session.id)
    if (scenario.seed === 'approval') {
      await store.appendSessionEvent(session.id, {
        actor: { kind: 'human', user: 'operator@example.com' },
        type: 'message.posted',
        payload: { text: 'Inspect' },
      })
      const actor = { kind: 'agent' as const, role: 'orchestrator', session: 'ot_fixture' }
      await store.appendSessionEvent(session.id, {
        actor,
        type: 'turn.started',
        payload: {
          turn: 'ot_fixture',
          stream: 'stream_fixture',
          trigger: { kind: 'message', messageSeq: 2 },
        },
      })
      await store.appendSessionEvent(session.id, {
        actor,
        type: 'approval.requested',
        payload: {
          turn: 'ot_fixture',
          toolCallId: 'call_fixture',
          toolName: 'notes.write',
          input: {},
        },
      })
      await store.appendSessionEvent(session.id, {
        actor,
        type: 'turn.suspended',
        payload: { turn: 'ot_fixture', cause: 'approval' },
      })
    }
    if (scenario.seed === 'archived')
      await store.appendSessionEvent(session.id, {
        actor: { kind: 'human', user: 'operator@example.com' },
        type: 'session.archived',
        payload: {},
      })
  }
  const snapshot = async () => {
    const records = [
      ...(await store.listSessions(operatorRepo)),
      ...(await store.listSessions('foreign/repo')),
    ]
    for (const record of records) if (!bindings.includes(record.id)) bindings.push(record.id)
    return await Promise.all(
      records.map(async (record) => {
        const events = await store.getSessionEvents(record.id)
        return { record, events, state: reduceSession(events) }
      }),
    )
  }
  const seed = await snapshot()
  const observations: Observation[] = []
  for (const request of scenario.requests) {
    const token = mintToken(
      secret,
      request.auth === 'admin'
        ? {
            version: 1,
            ownerAdmin: { user: request.user ?? 'operator@example.com' },
            exp: clock().getTime() + 60_000,
          }
        : {
            version: 1,
            internalOperator: {
              user: request.user ?? 'operator@example.com',
              repo: request.auth === 'foreign' ? 'foreign/repo' : operatorRepo,
            },
            exp: clock().getTime() + (request.auth === 'expired' ? -1 : 60_000),
          },
    )
    const headers = new Headers()
    if (request.version !== null)
      headers.set(AUTOBUILD_VERSION_HEADER, request.version ?? AUTOBUILD_VERSION)
    if (request.protocol !== null)
      headers.set(
        REMOTE_STORE_PROTOCOL_VERSION_HEADER,
        request.protocol ?? REMOTE_STORE_PROTOCOL_VERSION,
      )
    if (request.auth !== 'missing')
      headers.set('authorization', `Bearer ${request.auth === 'invalid' ? 'invalid' : token}`)
    const path = bindings.reduce(
      (text, id, index) => text.replaceAll(`$session:${index}`, encodeURIComponent(id)),
      request.path,
    )
    const body =
      request.rawBody ?? (request.body === undefined ? undefined : JSON.stringify(request.body))
    if (body !== undefined) headers.set('content-type', 'application/json')
    const response = await server.fetch(
      new Request(
        `https://fixture.invalid/operator/v1/repos/${encodeURIComponent(operatorRepo)}/${path}`,
        { method: request.method, headers, ...(body === undefined ? {} : { body }) },
      ),
    )
    const responseBody: unknown = await response.json()
    // The frozen error decoder remains an independent historical contract.
    if (response.status >= 400) historical.operatorErrorSchema.parse(responseBody)
    observations.push({
      request,
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: responseBody,
      sessions: await snapshot(),
    })
  }
  return bindOperatorIds(
    { scenario, bindings: bindings.map((_, index) => `$session:${index}`), seed, observations },
    bindings,
  ) as OperatorFixture
}

export async function generateOperatorCorpus(): Promise<OperatorCorpus> {
  const fixtures = await Promise.all(operatorScenarios().map(replayOperatorScenario))
  const routes = [...new Set(fixtures.map((fixture) => fixture.scenario.route))].sort()
  return {
    format: 1,
    checkpoint: 'session-and-validation-foundation',
    manifest: operatorManifest(),
    inventory: operatorInventory(),
    coverage: {
      routes,
      missingRoutes: operatorRoutes.filter((route) => !routes.includes(route)),
      missingBuildActions: [...operatorBuildActions],
      missingAnswers: [...operatorAnswers],
      missingTools: operatorInventory().tools,
    },
    fixtures,
  }
}

export async function checkOperatorCorpus(corpus: OperatorCorpus) {
  const current = await generateOperatorCorpus()
  if (!isDeepStrictEqual(corpus, current))
    throw new Error(
      'operator corpus is stale; regenerate with bun tools/operator-fixtures.ts --write',
    )
}
if (import.meta.main) {
  if (process.argv.includes('--write')) {
    writeFileSync(
      corpusPath,
      `${JSON.stringify(await generateOperatorCorpus(), null, 2).replace(/[^\x00-\x7f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`,
    )
  } else {
    await checkOperatorCorpus(JSON.parse(readFileSync(corpusPath, 'utf8')))
    console.log(
      'Operator foundation corpus matches current TypeScript HTTP behavior; full control coverage remains pending.',
    )
  }
}
