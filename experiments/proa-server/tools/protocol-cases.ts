/** Machine-route inventory. This is a completion checklist, not conformance evidence.
 * HTTP runners must register an assertion for every row before claiming coverage.
 */
export type ProtocolCase = {
  method: 'GET' | 'POST' | 'PUT'
  path: string
  status: number[]
  body: string
  gate: 'public' | 'identity → principal' | 'identity → ownership'
}
const cases: ProtocolCase[] = []
function route(method: ProtocolCase['method'], path: string, status: number[], body: string) {
  cases.push({
    method,
    path,
    status,
    body,
    gate:
      path === '/health'
        ? 'public'
        : ['/builds', '/repos', '/credentials/delegate'].includes(path)
          ? 'identity → principal'
          : 'identity → ownership',
  })
}
route('GET', '/health', [200], 'ok, autobuildVersion, protocolVersion, supportedClientRange')
route('POST', '/credentials/delegate', [200], 'delegated credential')
route('GET', '/builds', [200], 'BuildRecord[] filtered by principal')
route('POST', '/builds', [201], 'BuildRecord; authenticated identity is allocated by server')
route('POST', '/repos', [200], 'RepoRecord')
for (const scope of ['/builds/:slug', '/repos/:repo', '/sessions/:id']) {
  route(
    'GET',
    scope,
    [200],
    scope.startsWith('/sessions') ? 'SessionRecord or null' : 'scope record',
  )
  route('POST', `${scope}/events`, [201], 'stored event')
  route('GET', `${scope}/events`, [200], 'event[]; since and bounded wait')
  route('POST', `${scope}/deposits`, [201], 'event and artifact metadata')
  route('POST', `${scope}/artifacts`, [201], 'ArtifactMeta')
  route('GET', `${scope}/artifacts`, [200], 'null or {meta, contentBase64}; kind and optional rev')
  route('GET', `${scope}/artifact-list`, [200], 'ArtifactMeta[]')
  route('POST', `${scope}/streams`, [201], 'StreamRecord')
  route('GET', `${scope}/streams`, [200], 'StreamRecord[]')
  if (!scope.startsWith('/sessions')) {
    route('POST', `${scope}/reducer-values`, [200], '{version, cursor, value}')
    route('GET', `${scope}/snapshots/:reducer`, [200], 'snapshot or null; version required')
    route('PUT', `${scope}/snapshots/:reducer`, [200], '{written}')
    for (const action of ['claim', 'heartbeat', 'release'])
      route('POST', `${scope}/lease/${action}`, [200], '{ok}')
  }
  if (!scope.startsWith('/repos'))
    route('POST', `${scope}/events/conditional`, [200, 201], 'null on stale head or stored event')
}
route(
  'POST',
  '/builds/:slug/deposits/conditional',
  [200, 201],
  'null on stale head or deposit result',
)
for (const action of ['claim', 'heartbeat', 'release'])
  route('POST', `/builds/:slug/node-writer/${action}`, [200], 'node writer authority result')
for (const path of ['/builds/:slug/ticket-assets', '/builds/:slug/ticket-assets/file'])
  route('GET', path, [200], 'pinned manifest or base64 file, or null')
for (const leaf of [
  'high-water',
  'change-position',
  'state-events',
  'builds',
  'build-digests',
  'ticket-asset-limits',
])
  route('GET', `/repos/:repo/${leaf}`, [200], leaf)
for (const action of ['begin', 'finish'])
  route('POST', `/repos/:repo/tick/${action}`, [200], 'fenced tick result')
route('GET', '/repos/:repo/operator-presence', [200], 'fresh operator presence[]')
route('POST', '/repos/:repo/operator-presence', [200], 'operator presence')
route('GET', '/repos/:repo/sessions', [200], 'SessionRecord[]')
route('POST', '/repos/:repo/sessions', [201], 'SessionRecord')
const assets = '/repos/:repo/tickets/:id/assets'
route('POST', assets, [201], 'TicketAssetMeta')
for (const leaf of ['', '/file', '/list'])
  route('GET', `${assets}${leaf}`, [200], 'manifest, base64 file or list; absent asset is null')
route('POST', `${assets}/remove`, [200], 'removed manifest or null')
for (const scope of [
  '/builds/:slug/streams',
  '/repos/:repo/streams',
  '/sessions/:id/streams',
  '/streams',
]) {
  route('GET', `${scope}/:stream`, [200], 'StreamRecord')
  route('GET', `${scope}/:stream/chunks`, [200], 'StreamRead; since and bounded wait')
  route('POST', `${scope}/:stream/chunks`, [201], 'StreamChunk')
  route('POST', `${scope}/:stream/close`, [200], 'closed StreamRecord')
}
export const protocolCases: readonly ProtocolCase[] = cases
export const excludedProtocols = [
  { surface: 'ticket-source HTTP protocol', reason: 'separate ticket' },
  { surface: 'project connection protocol and ab connect', reason: 'separate ticket' },
  { surface: 'MCP', reason: 'explicitly out of scope' },
  {
    surface: 'credential administration and mint admin',
    reason: 'only shared credential reads and delegation are included',
  },
] as const
export const protocolErrors = {
  unknownRoute: { status: 404, kind: 'not-found', error: 'no route: METHOD PATH' },
  invalidBody: { status: 400, kind: 'validation', error: 'invalid request body: ZOD_ERROR' },
  malformedJson: { status: 400, kind: 'validation', error: 'request body is not valid JSON' },
  removedProject: { status: 403, kind: 'auth', error: 'project not registered' },
} as const
/** Fail closed when a runner omits a route; inventory alone never counts as coverage. */
export function assertProtocolCoverage(covered: ReadonlySet<string>) {
  const missing = protocolCases
    .map(({ method, path }) => `${method} ${path}`)
    .filter((key) => !covered.has(key))
  if (missing.length) throw new Error(`Untested protocol routes:\n${missing.join('\n')}`)
}
