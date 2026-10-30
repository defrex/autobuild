import { DISPATCH_PLACEMENT_CAPABILITY } from '@defrex/autobuild/remote-store'
import {
  dispatcherSelection,
  parseDispatcherRepositories,
  dispatcherOrigin,
} from './dispatcher-selection'
import type { DispatchPlacement, DispatchPlacementFact } from '@defrex/autobuild/remote-store'
import { projectSecretsHandler } from './project-secrets'
import {
  openPostgresProjectSecretsFromEnv,
  type ProjectSecretsManagement,
} from '@defrex/autobuild-postgres-store/project-secrets'
import { accessForEnv } from './web/access'
import {
  withRepositoryReads,
  withHostedProjectContext,
} from '@defrex/autobuild-postgres-store/request-context'
import {
  PostgresTicketGrantStore,
  type TicketGrantStore,
} from '@defrex/autobuild-postgres-store/ticket-grants'
import { SQL } from 'bun'
import {
  PostgresTicketPolicyStore,
  type TicketPolicyStore,
} from '@defrex/autobuild-postgres-store/ticket-policy'
import { ticketLifecycle } from '@defrex/autobuild/hosted-tickets'
import { openPostgresConnectionStoreFromEnv } from '@defrex/autobuild-postgres-store/connections'
import { createConnectionHandler } from './connections'
import {
  openPostgresCredentialStoreFromEnv,
  type CredentialReader,
} from '@defrex/autobuild-postgres-store/credentials'
import { createMachineAuth, MachineAuthError, requireProject } from './machine-auth'
import { normalizeProjectRepository } from '@defrex/autobuild-postgres-store/projects'
import {
  openPostgresProjectRegistryFromEnv,
  type ProjectRegistryReader,
} from '@defrex/autobuild-postgres-store/projects'
import {
  openPostgresBuildStoreFromEnv,
  openPostgresTicketDatabase,
  type PostgresTicketDatabase,
} from '@defrex/autobuild-postgres-store'
import {
  systemClock,
  type BuildStore,
  type Clock,
  type TicketSource,
} from '@defrex/autobuild/plugin-sdk'
import { createOperatorServer } from './operator-server'
import {
  orchestratorConfig,
  type Config,
  type OperatorTicketContext,
  decodeEffectiveConfig,
  OperatorQueryError,
  type OperatorSandboxService,
} from '@defrex/autobuild/operator'
import { createHostedOperatorSandboxService } from '@defrex/autobuild/operator-sandbox-host'
import { createTicketServer, HOSTED_TICKET_OPERATIONS } from './remote-tickets'
import {
  AUTOBUILD_VERSION,
  clientIdentityError,
  supportedClientRange,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '@defrex/autobuild/remote-store'
import { createStoreServer } from './remote-store-server'
import {
  HOSTED_ARTIFACT_MAX_BYTES,
  HOSTED_TICKET_ASSET_REQUEST_MAX_BYTES,
  HOSTED_EVENT_WAIT_MAX_SECONDS,
  parseHostedStoreEnv,
  retiredTicketDiagnostic,
  type HostedStoreEnv,
} from './config'

type HostedBackend = 'store' | 'tickets' | 'operator'

export interface HostedStoreErrorContext {
  backend: HostedBackend
  method: string
  pathname: string
}

export interface HostedStoreServiceOptions {
  syncPlacement?: (repo: string, desired: DispatchPlacementFact) => Promise<DispatchPlacement>
  openSecrets?: (env: HostedStoreEnv) => Promise<ProjectSecretsManagement>
  secretMembership?: (user: string, repo: string) => Promise<boolean>
  diagnostic?: (message: string) => void
  issueDispatcherCredential?: (repo: string, creator: string, expiresAt: Date) => Promise<string>
  openCredentials?: (env: HostedStoreEnv) => Promise<CredentialReader>
  openProjectRegistry?: (env: HostedStoreEnv) => Promise<ProjectRegistryReader>
  env?: HostedStoreEnv
  clock?: Clock
  openStore?: (env: HostedStoreEnv, options: { clock?: Clock }) => Promise<BuildStore>
  /** Context-aware backend seam. Production chooses one deployment backend;
   * tests inject a fake while exercising the real authenticated protocol. */
  sourceFor?: (context: OperatorTicketContext) => TicketSource | Promise<TicketSource>
  /** State discovery seam paired with sourceFor. Defaults to configured database lifecycle. */
  statesFor?: (context: OperatorTicketContext, source: TicketSource) => string[] | Promise<string[]>
  openTicketGrants?: (url: string) => Promise<TicketGrantStore>
  openTicketPolicy?: (url: string) => Promise<TicketPolicyStore>
  openTicketDatabase?: (url: string) => Promise<PostgresTicketDatabase>
  /** Receives original failures and safe request metadata. Never exposed to clients. */
  reportInternalError?: (
    error: unknown,
    context: HostedStoreErrorContext,
  ) => unknown | Promise<unknown>
}

const internalError = (): Response =>
  new Response(JSON.stringify({ error: 'hosted store is unavailable', kind: 'internal' }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  })

function notFound(req: Request, pathname: string): Response {
  return Response.json(
    { error: `no route: ${req.method} ${pathname}`, kind: 'not-found' },
    { status: 404 },
  )
}

const ticketOperations = new Set<string>([...HOSTED_TICKET_OPERATIONS, 'policy', 'grants'])
/** `METHOD <path under …/tickets/{id}/assets>`: put, manifest, one file, list, remove. */
const ticketAssetRoutes = new Set(['POST ', 'GET ', 'GET file', 'GET list', 'POST remove'])

/** The deployment's public origin, from `BETTER_AUTH_URL` — the sandbox
 * backend's `storeRef` (the deployment's own HTTPS face, which the sandbox
 * provider requires and the guest never receives). Absence or invalidity
 * leaves the sandbox backend unavailable for the whole deployment; every
 * other behavior is unchanged. */
export function hostedPublicOrigin(env: HostedStoreEnv): string | undefined {
  const raw = env.BETTER_AUTH_URL?.trim()
  if (raw === undefined || raw === '') return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

interface HostedSandboxDeps {
  issueCredential(repo: string, creator: string, expiresAt: Date): Promise<string>
  store: BuildStore
  clock: Clock
  /** The enclosing HostedStoreConfig's signing secret — the store and
   * operator servers' own — never a member of the repository's effective
   * config (which carries no secret). */
  secret: string
  env: HostedStoreEnv
  /** The deployment's public origin (the provider's storeRef). */
  origin: string
  report: (error: unknown) => Promise<void> | void
}

/** Mint the sandbox provider's repo-scoped, short-lived store token locally
 * (least privilege); the sandbox guest never receives it — the guest
 * environment is always built from an empty record plus the configured
 * forwarded names. The token exists only to satisfy the provider's
 * construction authority precondition. */
function sandboxStoreToken(deps: HostedSandboxDeps, repo: string): Promise<string> {
  return deps.issueCredential(
    repo,
    'system:hosted-operator-sandbox',
    new Date(deps.clock().getTime() + 3_600_000),
  )
}

/** Merge the request's OIDC token into the composition env under
 * `VERCEL_OIDC_TOKEN` with the dispatcher's exact precedence rule: an
 * explicit environment token always wins. A deployment using the durable
 * `VERCEL_TOKEN` triple needs no header at all. */
function sandboxCompositionEnv(
  deps: HostedSandboxDeps,
  credentials?: { oidcToken?: string },
): HostedStoreEnv {
  return {
    ...deps.env,
    ...(credentials?.oidcToken && !deps.env.VERCEL_OIDC_TOKEN
      ? { VERCEL_OIDC_TOKEN: credentials.oidcToken }
      : {}),
  }
}

/** Compose the hosted operator-sandbox backend for one enabled repository
 * from the deposited effective config plus the deployment's seams. Throws
 * on every construction failure; the callers contain it and degrade to
 * serving without the sandbox tools. */
async function hostedSandboxBackend(
  deps: HostedSandboxDeps,
  repo: string,
  config: Config,
  credentials?: { oidcToken?: string },
): Promise<OperatorSandboxService> {
  return createHostedOperatorSandboxService({
    store: deps.store,
    repo,
    config,
    env: sandboxCompositionEnv(deps, credentials),
    storeRef: deps.origin,
    storeToken: await sandboxStoreToken(deps, repo),
    clock: deps.clock,
  })
}
const storeResourceRoutes = new Set([
  'POST reducer-values',
  'GET events',
  'POST events',
  // The session-events compare-and-append (AUT-342): the same resource route
  // shape the build stream's conditional append uses.
  'POST events/conditional',
  'POST deposits',
  'GET artifacts',
  'POST artifacts',
  'GET artifact-list',
  'GET artifact-meta',
  'GET node-rewrite',
  // Repo-scoped batch read of build digests (AUT-487); handled by the store
  // server before the repo-existence gate, so an unknown repo is still
  // classified here and answers 200 from build records.
  'GET build-digests',
  'GET change-position',
  'GET placement',
  'GET builds',
  // The bounded repository-journal read (AUT-489); unlike build-digests this
  // route is served inside the repo-existence gate, exactly like `GET
  // events`. Without this classification `hostedBackend` answers the generic
  // 404 before createStoreServer runs, and after the reader cutover every
  // dispatcher tick's unguarded journal read would reject over HTTP.
  'GET state-events',
  // The journal's high-water mark (AUT-647), the dispatcher view's cursor:
  // served inside the repo-existence gate like `GET state-events`.
  'GET high-water',
  'POST tick/begin',
  'POST tick/finish',
  'POST node-writer/claim',
  'POST node-writer/heartbeat',
  'POST node-writer/release',
  'POST lease/claim',
  'POST lease/heartbeat',
  'POST lease/release',
])

/** Classify only route shapes implemented by the delegated protocol servers. */
function hostedBackend(req: Request, pathname: string): HostedBackend | undefined {
  let segments: string[]
  try {
    segments = pathname
      .split('/')
      .filter((part) => part.length > 0)
      .map(decodeURIComponent)
  } catch {
    return undefined
  }

  if (segments[0] === 'operator') {
    if (segments[1] !== 'v1' || segments[2] !== 'repos' || segments.length < 5) return undefined
    const rest = segments.slice(4)
    if (rest[0] === 'tickets') {
      if ((req.method === 'GET' || req.method === 'POST') && rest.length === 1) return 'operator'
      if ((req.method === 'GET' || req.method === 'PATCH') && rest.length === 2 && rest[1])
        return 'operator'
      if (
        req.method === 'POST' &&
        rest.length === 3 &&
        rest[1] &&
        (rest[2] === 'move' || rest[2] === 'block' || rest[2] === 'unblock')
      )
        return 'operator'
      return undefined
    }
    if (
      req.method === 'GET' &&
      rest.length === 1 &&
      (rest[0] === 'builds' || rest[0] === 'dashboard' || rest[0] === 'status')
    ) {
      return 'operator'
    }
    // The registry's generic tools route (one POST per tool call).
    if (req.method === 'POST' && rest.length === 2 && rest[0] === 'tools' && rest[1]) {
      return 'operator'
    }
    // Operator sessions: collection list/create and the addressed family.
    if (rest[0] === 'sessions') {
      if ((req.method === 'GET' || req.method === 'POST') && rest.length === 1) return 'operator'
      if (req.method === 'GET' && rest.length === 2 && rest[1]) return 'operator'
      if (req.method === 'POST' && rest.length === 3 && rest[1]) {
        if (rest[2] === 'messages' || rest[2] === 'approvals' || rest[2] === 'archive') {
          return 'operator'
        }
      }
      if (req.method === 'PUT' && rest.length === 3 && rest[2] === 'wake') return 'operator'
      if (
        req.method === 'GET' &&
        rest.length === 5 &&
        rest[2] === 'turns' &&
        rest[4] === 'stream'
      ) {
        return 'operator'
      }
      return undefined
    }
    if (req.method === 'GET' && rest.join('/') === 'harvest/status') return 'operator'
    if (
      req.method === 'POST' &&
      (rest.join('/') === 'bulk-control' || rest.join('/') === 'harvest/control')
    ) {
      return 'operator'
    }
    const setting = rest[1] === 'intake' || rest[1] === 'auto-merge-default'
    if (rest[0] === 'settings' && setting) {
      if (req.method === 'PUT' && rest.length === 2) return 'operator'
      if (req.method === 'POST' && rest.length === 3 && rest[2] === 'toggle') return 'operator'
    }
    if (rest[0] === 'builds' && rest[1]) {
      if (req.method === 'GET' && rest.length === 2) return 'operator'
      if (req.method === 'GET' && rest.length === 4 && rest[2] === 'artifacts' && rest[3]) {
        return 'operator'
      }
      if (
        req.method === 'POST' &&
        rest.length === 3 &&
        (rest[2] === 'control' || rest[2] === 'answer')
      ) {
        return 'operator'
      }
    }
    return undefined
  }

  if (segments[0] === 'tickets') {
    return req.method === 'POST' && segments.length === 2 && ticketOperations.has(segments[1]!)
      ? 'tickets'
      : undefined
  }

  // Global addressed stream routes (SPEC §7.6): the client addresses streams
  // by store-assigned id, so the server resolves the stream's own scope.
  if (segments[0] === 'streams' && segments.length >= 2) {
    const leaf = segments.slice(2).join('/')
    if (leaf === '') return req.method === 'GET' ? 'store' : undefined
    if (leaf === 'chunks')
      return req.method === 'GET' || req.method === 'POST' ? 'store' : undefined
    if (leaf === 'close') return req.method === 'POST' ? 'store' : undefined
    return undefined
  }

  if (segments.join('/') === 'credentials/delegate' && req.method === 'POST') return 'store'

  const root = segments[0]
  if (root !== 'builds' && root !== 'repos' && root !== 'sessions') return undefined
  if (root === 'sessions') {
    // Raw store session family: /sessions/{id}/… mirrors the repository
    // journal's resource routes; the collection lives under /repos/.
    if (segments.length === 2) return req.method === 'GET' ? 'store' : undefined
    const route = `${req.method} ${segments.slice(2).join('/')}`
    if (route === 'GET streams' || route === 'POST streams') return 'store'
    return storeResourceRoutes.has(route) ? 'store' : undefined
  }
  if (segments.length === 1) {
    const allowed =
      root === 'builds' ? req.method === 'GET' || req.method === 'POST' : req.method === 'POST'
    return allowed ? 'store' : undefined
  }
  if (segments.length === 2) return req.method === 'GET' ? 'store' : undefined
  if (root === 'repos' && segments[2] === 'sessions' && segments.length === 3) {
    return req.method === 'GET' || req.method === 'POST' ? 'store' : undefined
  }

  // Stream family and addressed stream sub-routes under any resource root
  // (build, repo, session): create/list at …/streams, then chunks and close.
  if (segments[2] === 'streams' && segments.length >= 3) {
    const leaf = segments.slice(4).join('/')
    if (segments.length === 3) {
      return req.method === 'GET' || req.method === 'POST' ? 'store' : undefined
    }
    if (segments.length === 4 && req.method === 'GET') return 'store'
    if (leaf === 'chunks') {
      return req.method === 'GET' || req.method === 'POST' ? 'store' : undefined
    }
    if (leaf === 'close') return req.method === 'POST' ? 'store' : undefined
    return undefined
  }

  if (
    root === 'repos' &&
    segments[2] === 'operator-presence' &&
    segments.length === 4 &&
    req.method === 'DELETE'
  )
    return 'store'
  if (
    root === 'repos' &&
    ['operator-presence', 'scan-cadence'].includes(segments[2]!) &&
    segments.length === 3
  ) {
    return req.method === 'GET' || req.method === 'POST' ? 'store' : undefined
  }

  // Ticket assets (SPEC §7.1): the effective-limits route and the per-ticket
  // asset family under a repository.
  if (root === 'repos' && segments[2] === 'ticket-asset-limits' && segments.length === 3) {
    return req.method === 'GET' ? 'store' : undefined
  }
  if (root === 'repos' && segments[2] === 'tickets' && segments[4] === 'assets') {
    const assetRoute = `${req.method} ${segments.slice(5).join('/')}`
    return ticketAssetRoutes.has(assetRoute) ? 'store' : undefined
  }

  // Reducer snapshots (a cache beside the log): `GET|PUT …/snapshots/:reducer`
  // under a build or repository journal, served inside the existence gates.
  if (
    (root === 'builds' || root === 'repos') &&
    segments[2] === 'snapshots' &&
    segments.length === 4
  ) {
    return req.method === 'GET' || req.method === 'PUT' ? 'store' : undefined
  }
  const route = `${req.method} ${segments.slice(2).join('/')}`
  if (
    root === 'builds' &&
    (route === 'POST events/conditional' || route === 'POST deposits/conditional')
  )
    return 'store'
  // A build's frozen ticket assets (SPEC §6.3): manifest and one file.
  if (root === 'builds' && (route === 'GET ticket-assets' || route === 'GET ticket-assets/file')) {
    return 'store'
  }
  return storeResourceRoutes.has(route) ? 'store' : undefined
}

/** Host-neutral Fetch handler. Persistence opens once, on the first recognized machine request. */
export function createHostedStoreService(options: HostedStoreServiceOptions = {}): {
  fetch(req: Request): Promise<Response>
  projects: ProjectRegistryReader
  machineAuth: () => import('./machine-auth').MachineAuth
} {
  const env = options.env ?? process.env
  const diagnostic = retiredTicketDiagnostic(env)
  if (diagnostic !== undefined) (options.diagnostic ?? console.warn)(diagnostic)
  let projectPromise: Promise<ProjectRegistryReader> | undefined
  const openProjects = () => {
    if (!projectPromise) {
      const attempt = (options.openProjectRegistry ?? openPostgresProjectRegistryFromEnv)(env)
      projectPromise = attempt
      void attempt.catch(() => {
        if (projectPromise === attempt) projectPromise = undefined
      })
    }
    return projectPromise
  }
  const projects: ProjectRegistryReader = {
    list: async () => (await openProjects()).list(),
    has: async (repo) => (await openProjects()).has(repo),
  }

  let credentialPromise: Promise<CredentialReader> | undefined
  const credentials: CredentialReader = {
    authenticate: async (token, now) => {
      if (!credentialPromise) {
        const attempt = (options.openCredentials ?? openPostgresCredentialStoreFromEnv)(env)
        credentialPromise = attempt
        void attempt.catch(() => {
          if (credentialPromise === attempt) credentialPromise = undefined
        })
      }
      return (await credentialPromise).authenticate(token, now)
    },
  }
  let delegationStore: Promise<BuildStore> | undefined
  const authorityStore = () => {
    if (!delegationStore) {
      const attempt = opener(env, options.clock === undefined ? {} : { clock: options.clock })
      delegationStore = attempt
      void attempt.catch(() => {
        if (delegationStore === attempt) delegationStore = undefined
      })
    }
    return delegationStore
  }
  const machineAuth = () =>
    createMachineAuth({
      secret: parseHostedStoreEnv(env).secret,
      projects,
      credentials,
      store: authorityStore,
      ...(options.clock ? { clock: options.clock } : {}),
    })

  const opener = options.openStore ?? openPostgresBuildStoreFromEnv
  const openTicketStore = authorityStore
  const ticketOpener = options.openTicketDatabase ?? openPostgresTicketDatabase
  const reporter =
    options.reportInternalError ??
    ((error: unknown, context: HostedStoreErrorContext) => {
      console.error('Hosted store internal error', context, error)
    })
  let storeHandlerPromise: Promise<(req: Request) => Promise<Response>> | undefined
  let ticketHandlerPromise: Promise<(req: Request) => Promise<Response>> | undefined
  let ticketBackendPromise:
    | Promise<{
        sourceFor: (context: OperatorTicketContext) => TicketSource | Promise<TicketSource>
        statesFor: (
          context: OperatorTicketContext,
          source: TicketSource,
        ) => string[] | Promise<string[]>
      }>
    | undefined
  const requestsWithInternalFailures = new WeakSet<Request>()

  const report = async (error: unknown, req: Request, backend: HostedBackend) => {
    try {
      await reporter(error, {
        backend,
        method: req.method,
        pathname: new URL(req.url).pathname,
      })
    } catch {
      // Diagnostics must never alter the public response.
    }
  }

  const reportProtocolFailure = (error: unknown, req: Request, backend: HostedBackend) => {
    requestsWithInternalFailures.add(req)
    return report(error, req, backend)
  }

  let policyPromise: Promise<TicketPolicyStore> | undefined
  const openPolicy = () => {
    policyPromise ??= options.openTicketPolicy
      ? options.openTicketPolicy(parseHostedStoreEnv(env).postgres.url)
      : Promise.resolve(
          new PostgresTicketPolicyStore(new SQL(parseHostedStoreEnv(env).postgres.url)),
        )
    return policyPromise
  }
  const configReference = async (store: BuildStore, repo: string) => {
    const result = await store.getReducerValue(
      { kind: 'repo', repo },
      { reducer: 'effectiveConfig' },
    )
    return result.value as { run?: string; reference?: { kind: string; rev: number } }
  }
  const ticketConfiguration = async (store: BuildStore, repo: string) => {
    const facts = (await store.getRepo(repo)) ? await configReference(store, repo) : {}
    const ref = facts.reference
    if (!ref)
      throw new OperatorQueryError(
        'effective-config-unavailable',
        facts.run === undefined
          ? `effective config unavailable for repository "${repo}": no dispatcher run is recorded`
          : `effective config unavailable for repository "${repo}"`,
      )
    const artifact = await store.getRepoArtifact(repo, ref.kind, ref.rev)
    if (artifact === null)
      throw new OperatorQueryError(
        'effective-config-unavailable',
        `effective config ${ref.kind}@${ref.rev} is not retrievable`,
      )
    return decodeEffectiveConfig(artifact.content, `${ref.kind}@${ref.rev}`)
  }
  const ticketContext = async (repo: string): Promise<OperatorTicketContext> => {
    if (!(await projects.has(repo))) throw new MachineAuthError(403, 'project not registered')
    const policy = await (await openPolicy()).get(repo)
    if (policy) return { repo, tickets: policy.tickets, teamKey: policy.tickets.teamKey }
    const config = await ticketConfiguration(await openTicketStore(), repo)
    const legacy = ticketLifecycle(config.tickets, true)
    return {
      repo,
      tickets: {
        ...config.tickets,
        triageState: legacy.triage,
        claimedState: legacy.doing,
        doneState: legacy.done,
        createState: legacy.create,
        proposalState: legacy.proposal,
      },
      teamKey: config.tickets.teamKey ?? '',
    }
  }

  const openTicketBackend = () => {
    ticketBackendPromise ??= (async () => {
      const config = parseHostedStoreEnv(env)
      let databasePromise: Promise<PostgresTicketDatabase> | undefined
      const openDatabase = () => {
        if (!databasePromise) {
          const attempt = ticketOpener(config.postgres.url)
          databasePromise = attempt
          void attempt.catch(() => {
            if (databasePromise === attempt) databasePromise = undefined
          })
        }
        return databasePromise
      }
      const lifecycleFor = (context: OperatorTicketContext) => {
        const { triage, ready, doing, done } = ticketLifecycle(context.tickets)
        return { triage, ready, doing, done }
      }
      const validate = async (context: OperatorTicketContext) => {
        if (!(await projects.has(context.repo)))
          throw new MachineAuthError(403, 'project not registered')
        if (context.tickets.source !== 'hosted')
          throw new OperatorQueryError(
            'external-ticket-source',
            `Tickets for project "${context.repo}" live in its own "${context.tickets.source}" ticket source, accessed directly by its dispatcher.`,
          )
      }
      return {
        sourceFor: async (context: OperatorTicketContext) => {
          await validate(context)
          const source: TicketSource = options.sourceFor
            ? await options.sourceFor(context)
            : (await openDatabase()).source({
                repo: context.repo,
                teamKey: context.teamKey,
                lifecycle: lifecycleFor(context),
                ...(context.tickets.createState !== undefined
                  ? { createState: context.tickets.createState }
                  : {}),
                ...(context.tickets.proposalState !== undefined
                  ? { proposalState: context.tickets.proposalState }
                  : {}),
              })
          if (source.assets) return source
          const store = await authorityStore()
          return Object.assign(source, {
            assets: {
              ticketAssetLimits: store.ticketAssetLimits.bind(store),
              putTicketAsset: store.putTicketAsset.bind(store),
              getTicketAsset: store.getTicketAsset.bind(store),
              listTicketAssets: store.listTicketAssets.bind(store),
              removeTicketAsset: store.removeTicketAsset.bind(store),
            },
          })
        },
        statesFor: async (context: OperatorTicketContext, source: TicketSource) => {
          await validate(context)
          if (source.listStates) return (await source.listStates()).map((s) => s.name)
          if (options.statesFor) return options.statesFor(context, source)
          return [
            ...new Set(
              [
                ...Object.values(lifecycleFor(context)),
                context.tickets.createState,
                context.tickets.proposalState,
              ].filter((v): v is string => v !== undefined),
            ),
          ]
        },
      }
    })()
    return ticketBackendPromise
  }

  const openStoreHandler = () => {
    if (storeHandlerPromise === undefined) {
      const attempt = (async () => {
        const config = parseHostedStoreEnv(env)
        const store = await authorityStore()
        const shared = options.clock === undefined ? {} : { clock: options.clock }
        const clock = options.clock ?? systemClock
        // The hosted operator-sandbox backend (AUT-584): composed per runner
        // from the deposited effective config plus the deployment's seams.
        // The public origin gates the whole backend — absent or invalid
        // BETTER_AUTH_URL leaves every binding sandbox-free, unchanged from
        // today's filtered behavior.
        const sandboxOrigin = hostedPublicOrigin(env)
        const sandboxDeps: HostedSandboxDeps | undefined =
          sandboxOrigin === undefined
            ? undefined
            : {
                store,
                clock,
                issueCredential:
                  options.issueDispatcherCredential ??
                  (async (repo, creator, expiresAt) => {
                    const credentials = await openPostgresCredentialStoreFromEnv(env)
                    try {
                      return (
                        await credentials.issue(repo, creator, { purpose: 'dispatcher', expiresAt })
                      ).token
                    } finally {
                      await credentials.close()
                    }
                  }),
                secret: config.secret,
                env,
                origin: sandboxOrigin,
                report: (error) =>
                  report(error, new Request('ab://operator-sandbox-composition'), 'operator'),
              }
        const publication =
          options.syncPlacement ??
          ('syncDispatchPlacement' in store
            ? (repo: string, desired: DispatchPlacementFact) =>
                (
                  store as BuildStore & {
                    syncDispatchPlacement(
                      repo: string,
                      desired: DispatchPlacementFact,
                    ): Promise<DispatchPlacement>
                  }
                ).syncDispatchPlacement(repo, desired)
            : undefined)
        let placementConfiguration:
          | { selection: ReturnType<typeof dispatcherSelection>; origin: string }
          | undefined
        const storeServer = createStoreServer({
          store,
          ...(publication
            ? {
                placement: (repo: string) => {
                  placementConfiguration ??= {
                    selection: dispatcherSelection(
                      parseDispatcherRepositories(env.AB_DISPATCHER_REPOSITORIES),
                    ),
                    origin: dispatcherOrigin(env),
                  }
                  const { selection, origin } = placementConfiguration
                  return publication(
                    repo,
                    selection.includes(repo) ? { hosted: true, origin } : { hosted: false },
                  )
                },
              }
            : {}),
          requireRegistered: async (repo) => {
            if (!(await projects.has(repo)))
              throw new MachineAuthError(403, 'project not registered')
          },
          secret: config.secret,
          auth: machineAuth(),
          maxArtifactBytes: HOSTED_ARTIFACT_MAX_BYTES,
          maxTicketAssetRequestBytes: HOSTED_TICKET_ASSET_REQUEST_MAX_BYTES,
          maxEventWaitSeconds: HOSTED_EVENT_WAIT_MAX_SECONDS,
          onInternalError: (error, req) => reportProtocolFailure(error, req, 'store'),
          ...shared,
        })
        const operatorServer = createOperatorServer({
          auth: machineAuth(),
          projects,
          store,
          secret: config.secret,
          ticketBackend: {
            contextFor: ticketContext,
            sourceFor: async (context) => (await openTicketBackend()).sourceFor(context),
            statesFor: async (context, source) =>
              (await openTicketBackend()).statesFor(context, source),
          },
          onInternalError: (error, req) => reportProtocolFailure(error, req, 'operator'),
          ...(sandboxDeps !== undefined
            ? {
                sandboxFor: async (repo, credentials) => {
                  let resolved: Config | null
                  try {
                    resolved = await orchestratorConfig(store, repo)
                  } catch {
                    // A broken effective config fails the archive route
                    // elsewhere; the release degrades to the dispatcher's
                    // idle settlement.
                    return undefined
                  }
                  if (resolved === null) return undefined
                  try {
                    return await hostedSandboxBackend(sandboxDeps, repo, resolved, credentials)
                  } catch (error) {
                    await sandboxDeps.report(error)
                    return undefined
                  }
                },
              }
            : {}),
          ...shared,
        })
        return (req: Request) =>
          new URL(req.url).pathname.startsWith('/operator/v1/')
            ? operatorServer.fetch(req)
            : storeServer.fetch(req)
      })()
      storeHandlerPromise = attempt
      void attempt.catch(() => {
        if (storeHandlerPromise === attempt) storeHandlerPromise = undefined
      })
    }
    return storeHandlerPromise
  }

  const openTicketHandler = () => {
    ticketHandlerPromise ??= (async () => {
      const config = parseHostedStoreEnv(env)
      return createTicketServer({
        auth: machineAuth(),
        secret: config.secret,
        grants: await (options.openTicketGrants
          ? options.openTicketGrants(config.postgres.url)
          : Promise.resolve(new PostgresTicketGrantStore(new SQL(config.postgres.url)))),
        statesFor: async (context, principal, source) => {
          const repo = context.repo ?? (principal.kind !== 'admin' ? principal.repo : undefined)
          if (!repo) throw new MachineAuthError(403, 'project required')
          return (await openTicketBackend()).statesFor(await ticketContext(repo), source)
        },
        policy: {
          get: async (repo) => {
            if (!(await projects.has(repo)))
              throw new MachineAuthError(403, 'project not registered')
            return (await openPolicy()).get(repo)
          },
          put: async (repo, policy, writer) => {
            if (!(await projects.has(repo)))
              throw new MachineAuthError(403, 'project not registered')
            // A new project can publish before its first dispatcher run. Only
            // a real previous policy/config supplies historical names to retain.
            const priorPolicy = await (await openPolicy()).get(repo)
            let hasPriorConfig = false
            if (!priorPolicy) {
              const priorStore = await openTicketStore()
              if (await priorStore.getRepo(repo))
                hasPriorConfig = (await configReference(priorStore, repo)).reference !== undefined
            }
            if (priorPolicy || hasPriorConfig) {
              const previous = await ticketContext(repo)
              if (previous.tickets.source === 'hosted') {
                const source = await (await openTicketBackend()).sourceFor(previous)
                await source.listStates?.()
              }
            }
            await (await openPolicy()).put(repo, policy, writer)
          },
        },
        sourceFor: async (context, principal) => {
          if (principal.kind === 'internal')
            throw new MachineAuthError(
              403,
              'internal operator credential may only access operator routes',
            )
          const repo =
            context.repo !== undefined
              ? normalizeProjectRepository(context.repo)
              : principal.kind === 'project' ||
                  principal.kind === 'delegated' ||
                  principal.kind === 'ticket-grant'
                ? principal.repo
                : undefined
          if (!repo)
            throw new MachineAuthError(
              403,
              'owner ticket requests require context.repo naming a registered project',
            )
          requireProject(principal, repo)
          if (!(await projects.has(repo))) throw new MachineAuthError(403, 'project not registered')
          return (await openTicketBackend()).sourceFor(await ticketContext(repo))
        },
        onInternalError: (error, req) => reportProtocolFailure(error, req, 'tickets'),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      }).fetch
    })()
    return ticketHandlerPromise
  }

  let connections: ReturnType<typeof openPostgresConnectionStoreFromEnv> | undefined
  let connectionCredentials: ReturnType<typeof openPostgresCredentialStoreFromEnv> | undefined
  const connectionHandler = createConnectionHandler({
    store: () =>
      (connections ??= openPostgresConnectionStoreFromEnv(env).catch((error) => {
        connections = undefined
        throw error
      })),
    credentials: () =>
      (connectionCredentials ??= openPostgresCredentialStoreFromEnv(env).catch((error) => {
        connectionCredentials = undefined
        throw error
      })),
    machineAuth,
    baseURL: hostedPublicOrigin(env) ?? '',
  })
  let secrets: Promise<ProjectSecretsManagement> | undefined
  const access = accessForEnv(env)
  const secretHandler = projectSecretsHandler({
    auth: machineAuth,
    canAccess:
      options.secretMembership ??
      (async (user, repo) => {
        const actor = await access.principal(user)
        return !!actor && (await access.canAccess(actor, repo))
      }),
    store: () =>
      (secrets ??= (options.openSecrets ?? openPostgresProjectSecretsFromEnv)(env).catch(
        (error) => {
          secrets = undefined
          throw error
        },
      )),
  })
  return {
    projects,
    machineAuth,
    fetch(req: Request): Promise<Response> {
      return withHostedProjectContext(() =>
        withRepositoryReads(async () => {
          const url = new URL(req.url)
          if (url.pathname.startsWith('/secrets/v1/')) return secretHandler(req)
          if (url.pathname.startsWith('/connect/v1/')) return connectionHandler(req)
          if (req.method === 'GET' && url.pathname === '/health') {
            return Response.json({
              ok: true,
              ...(options.syncPlacement || !options.openStore
                ? { capabilities: [DISPATCH_PLACEMENT_CAPABILITY] }
                : {}),
              autobuildVersion: AUTOBUILD_VERSION,
              protocolVersion: REMOTE_STORE_PROTOCOL_VERSION,
              supportedClientRange: supportedClientRange(),
            })
          }

          const backend = hostedBackend(req, url.pathname)
          if (backend === undefined) return notFound(req, url.pathname)

          const clientAutobuild = req.headers.get(AUTOBUILD_VERSION_HEADER)
          const clientProtocol = req.headers.get(REMOTE_STORE_PROTOCOL_VERSION_HEADER)
          const mismatch = clientIdentityError(clientAutobuild, clientProtocol)
          if (mismatch !== undefined) {
            return Response.json(
              {
                error: mismatch,
                kind: 'conflict',
              },
              { status: 409 },
            )
          }

          try {
            const response =
              backend === 'tickets'
                ? await (await openTicketHandler())(req)
                : await (await openStoreHandler())(req)
            return response.status >= 500 && requestsWithInternalFailures.has(req)
              ? internalError()
              : response
          } catch (error) {
            await report(error, req, backend)
            return internalError()
          }
        }),
      )
    },
  }
}
