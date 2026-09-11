/**
 * The hosted dispatcher (AUT-303): a cron-authenticated HTTP surface that
 * makes this deployment the kernel owner. One authorized invocation runs, per
 * configured repository, one bounded origin-mode dispatcher tick by re-driving
 * the SAME dispatch kernel an operator runs locally (`abDispatch` with
 * `--repository`, AUT-302) — claim, provision, launch, observe, settle, merge
 * PRs, janitor, lease sweep. Nothing about the loop is reimplemented here;
 * overlap safety stays in the durable repository lease (a losing invocation
 * records `dispatcher.tick-yielded`) and missed ticks stay a resume decision.
 *
 * Identity: each repository tick mints `hosted-dispatcher-<uuid>` as the
 * kernelRunId. That id is the repository-lease holder and it tags every tick
 * report, run boundary, and deposited `dispatcher-effective-config` artifact,
 * so the web dashboard's repository journal shows hosted activity exactly as
 * it shows a local one. Guests authenticate with a short-TTL unattributed
 * deployment operator token (`operator: true`) signed with the deployment's
 * own store signing secret — the exact secret both the Store and ticket
 * servers verify tokens against — so one credential covers store, tickets, and
 * the guest session, and store identity still travels via the run id. The
 * secret and minted tokens never appear in logs, responses, or error messages.
 *
 * This surface is deliberately NOT routed through `createHostedStoreService`:
 * the machine routes gate on Autobuild version headers a bare cron request
 * cannot send, and cron authorization is the deployment's `CRON_SECRET`, not a
 * minted token. It is its own small protocol beside the store, ticket, and
 * operator servers.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { normalizeGitRemoteUrl } from 'autobuild/origin'
import type { Clock } from 'autobuild/plugin-sdk'
import { spawnExec } from 'autobuild/git-worktree'
import { abDispatch, type DispatchOpts } from 'autobuild/cli'
import { mintToken } from 'autobuild/remote-store'
import { parseHostedStoreEnv, type HostedStoreEnv } from './config'

/** The service environment the dispatcher reads. Secrets are only ever taken
 * through `parseHostedStoreEnv`'s already-validated fields. */
export type HostedDispatcherEnv = HostedStoreEnv

export interface HostedDispatcherConfig {
  /** The deployment's `AB_STORE_SECRET` — the signing secret the Store and
   * ticket servers verify tokens with, reused so a minted credential is
   * accepted everywhere it is presented. `CRON_SECRET` is never a signing
   * input and the two are never coupled. */
  secret: string
  /** The deployment's public origin, used as `AB_STORE` for the kernel, the
   * hosted ticket source, and guests. */
  origin: string
  /** Normalized https repository identities, configured order preserved. */
  repositories: readonly string[]
  /** Optional per-repository GitHub token overrides (`AB_DISPATCHER_GITHUB_TOKENS`),
   * keyed by the same normalized https identities as `repositories`. A
   * repository with an override authenticates its forge operations with it;
   * every other repository keeps the shared service-environment credential.
   * Values are never logged, echoed, or deposited. */
  githubTokenOverrides: ReadonlyMap<string, string>
  /** Tick budget per invocation in seconds (default 240, inside Vercel's
   * 300 s default function duration). */
  budgetSeconds: number
  /** Minted guest-token TTL in seconds (default 7 days). */
  tokenTtlSeconds: number
  /** The cron authorization shared secret; blank/unset disables the endpoint. */
  cronSecret?: string
}

const DEFAULT_BUDGET_SECONDS = 240
const MIN_BUDGET_SECONDS = 10
const MAX_BUDGET_SECONDS = 780
const DEFAULT_TOKEN_TTL_SECONDS = 604800
const MIN_TOKEN_TTL_SECONDS = 3600

function required(env: HostedDispatcherEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required and must be nonblank`)
  return value
}

function integerSetting(env: HostedDispatcherEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim()
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`)
  return value
}

/** Parse one repository-CSV variable into normalized https identities. */
function repositoryList(raw: string, name: string): string[] {
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
  if (values.length === 0) throw new Error(`${name} must name at least one repository`)
  const repositories: string[] = []
  for (const value of values) {
    // Entries are repository identities — normalized https origins — so an
    // operator-spelled `git@github.com:acme/app.git` still matches the Store's
    // identity for this repository (same rule as AB_WEB_REPOSITORIES).
    const normalized = normalizeGitRemoteUrl(value)
    if (!/^https:\/\/[^\s]+$/.test(normalized)) {
      throw new Error(`${name} contains an unsafe repository name: ${JSON.stringify(value)}`)
    }
    if (!repositories.includes(normalized)) repositories.push(normalized)
  }
  return repositories
}

/** Parse the optional per-repository forge-credential override map
 * (`AB_DISPATCHER_GITHUB_TOKENS`): a JSON object mapping repository identities
 * (same normalization as the repository set, so an operator may spell either
 * form) to GitHub token material. Unset or blank means no overrides —
 * behavior is byte-identical to the shared-credential-only deployment. Every
 * key must name a repository in the resolved served set, so a typo fails
 * loudly instead of silently leaving a repository on the shared identity.
 * Error messages name the variable and the offending identity — never a value. */
function githubTokenOverrides(
  env: HostedDispatcherEnv,
  repositories: readonly string[],
): Map<string, string> {
  const raw = env.AB_DISPATCHER_GITHUB_TOKENS?.trim()
  if (raw === undefined || raw === '') return new Map()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // JSON.parse error text can embed fragments of its input; rethrow a fixed
    // message so token material never reaches a log or response.
    throw new Error(
      'AB_DISPATCHER_GITHUB_TOKENS must be a JSON object mapping repository identities to GitHub tokens',
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      'AB_DISPATCHER_GITHUB_TOKENS must be a JSON object mapping repository identities to GitHub tokens',
    )
  }
  const overrides = new Map<string, string>()
  for (const [rawKey, value] of Object.entries(parsed as Record<string, unknown>)) {
    // Entries are repository identities — normalized https origins, exactly
    // like the repository set — so an operator-spelled
    // `git@github.com:acme/app.git` matches the served `https://` identity.
    const identity = normalizeGitRemoteUrl(rawKey)
    if (!/^https:\/\/[^\s]+$/.test(identity) || !repositories.includes(identity)) {
      throw new Error(
        `AB_DISPATCHER_GITHUB_TOKENS contains a key that is not a served repository: ${JSON.stringify(rawKey)}`,
      )
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(
        `AB_DISPATCHER_GITHUB_TOKENS contains a blank value for repository ${JSON.stringify(identity)}`,
      )
    }
    // Two spellings can normalize to one identity; a duplicate would make the
    // effective credential depend on JSON key order, so it is rejected.
    if (overrides.has(identity)) {
      throw new Error(
        `AB_DISPATCHER_GITHUB_TOKENS names repository ${JSON.stringify(identity)} more than once`,
      )
    }
    overrides.set(identity, value.trim())
  }
  return overrides
}

/** Parse the dispatcher configuration from the service environment. Called per
 * tick, so a misconfigured deployment fails loudly per invocation (naming the
 * offending variable, never a value) rather than at module load. */
export function parseHostedDispatcherEnv(env: HostedDispatcherEnv): HostedDispatcherConfig {
  // The signing secret is NOT a new variable: it is the deployment's
  // AB_STORE_SECRET, validated once here together with the rest of the store
  // configuration.
  const secret = parseHostedStoreEnv(env).secret
  const rawOrigin = required(env, 'AB_DISPATCHER_ORIGIN')
  let origin: URL
  try {
    origin = new URL(rawOrigin)
  } catch {
    throw new Error('AB_DISPATCHER_ORIGIN must be an absolute http(s) origin')
  }
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new Error(
      'AB_DISPATCHER_ORIGIN must be an absolute http(s) origin without credentials or a path',
    )
  }
  if (env.NODE_ENV === 'production' && origin.protocol !== 'https:') {
    throw new Error('AB_DISPATCHER_ORIGIN must use https in production')
  }
  const rawRepositories = env.AB_DISPATCHER_REPOSITORIES?.trim()
  const repositories =
    rawRepositories === undefined || rawRepositories === ''
      ? // Fall back to the web configuration so a deployment configures its
        // repository set once.
        repositoryList(required(env, 'AB_WEB_REPOSITORIES'), 'AB_WEB_REPOSITORIES')
      : repositoryList(rawRepositories, 'AB_DISPATCHER_REPOSITORIES')
  const rawBudget = integerSetting(env, 'AB_DISPATCHER_BUDGET_SECONDS', DEFAULT_BUDGET_SECONDS)
  const budgetSeconds = Math.min(MAX_BUDGET_SECONDS, Math.max(MIN_BUDGET_SECONDS, rawBudget))
  const tokenTtlSeconds = integerSetting(
    env,
    'AB_DISPATCHER_TOKEN_TTL_SECONDS',
    DEFAULT_TOKEN_TTL_SECONDS,
  )
  if (tokenTtlSeconds < MIN_TOKEN_TTL_SECONDS) {
    throw new Error(
      `AB_DISPATCHER_TOKEN_TTL_SECONDS must be at least ${MIN_TOKEN_TTL_SECONDS} — the minted ` +
        'credential must outlive a guest build lifetime',
    )
  }
  const githubTokenOverridesMap = githubTokenOverrides(env, repositories)
  const cronSecret = env.CRON_SECRET?.trim()
  return {
    secret,
    origin: origin.origin,
    repositories,
    githubTokenOverrides: githubTokenOverridesMap,
    budgetSeconds,
    tokenTtlSeconds,
    ...(cronSecret !== undefined && cronSecret !== '' ? { cronSecret } : {}),
  }
}

/** One configured repository's outcome inside one invocation. */
export interface HostedDispatcherRepositoryOutcome {
  repository: string
  /** `ticked` — the kernel ran one tick; `failed` — the tick threw (the error
   * message names variables, never secret values); `skipped` — the invocation
   * budget no longer covers a minimum-remaining floor, so the next invocation
   * resumes the work. */
  outcome: 'ticked' | 'failed' | 'skipped'
  /** This tick's durable run identity (`hosted-dispatcher-<uuid>`). */
  runId?: string
  error?: string
}

export interface HostedDispatcherTickSummary {
  /** Epoch ms this invocation's work was bounded by. */
  deadlineAt: number
  repositories: HostedDispatcherRepositoryOutcome[]
}

export interface HostedDispatcherOptions {
  /** Service environment; defaults to `process.env`. */
  env?: HostedDispatcherEnv
  clock?: Clock
  /** The kernel entry. Defaults to the real `abDispatch`; integration tests
   * wrap it with `wire`/`nonStoreWire` fakes and `originConfigTransport`. */
  dispatch?: (opts: DispatchOpts) => Promise<void>
  /** Where the kernel's own report lines go. Unset, they are forwarded to
   * `log`/`logError` prefixed with the repository so a deployment's runtime
   * logs carry every tick report and warning the kernel prints locally. */
  stdout?: (line: string) => void
  stderr?: (line: string) => void
  /** Operational log sink for the endpoint and per-repository outcomes
   * (default `console.log`). Every line starts with `hosted-dispatcher` and
   * carries the invocation id; secrets and minted tokens never reach it. */
  log?: (line: string) => void
  /** Error-level sink (default `console.error`): rejected invocations,
   * configuration failures with the offending variable, and failed repository
   * ticks with the kernel error's stack. */
  logError?: (line: string) => void
}

/** Below this much remaining budget a further repository is recorded as
 * `skipped` instead of started, so one invocation always answers and the
 * unfinished repository resumes on the next one. */
const MIN_REMAINING_MS = 20_000

const LOG_PREFIX = 'hosted-dispatcher'

function invocationId(): string {
  return `inv_${randomUUID().slice(0, 8)}`
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    const cause =
      error.cause instanceof Error
        ? `\n  caused by: ${error.cause.stack ?? error.cause.message}`
        : error.cause !== undefined
          ? `\n  caused by: ${String(error.cause)}`
          : ''
    return `${error.stack ?? `${error.name}: ${error.message}`}${cause}`
  }
  return String(error)
}

/** The kernel owner. One `tick()` per authorized invocation; repositories run
 * sequentially and fully isolated — one repository's failure never stops
 * another. Overlap correctness lives in the durable journal: the repository
 * supervisor lease makes a loser record `dispatcher.tick-yielded`; the
 * response does not re-derive it. */
/** Per-invocation credentials that arrive with the request rather than the
 * environment. */
export interface HostedDispatcherInvocation {
  /** The Vercel OIDC token a Vercel Function receives on the
   * `x-vercel-oidc-token` request header. It becomes the kernel's
   * `VERCEL_OIDC_TOKEN` when the environment carries none, so the Sandbox SDK
   * authenticates as the deployment. Never logged. */
  oidcToken?: string
}

/** Which Sandbox credential the kernel will present, for the tick log line. */
function sandboxAuthSource(
  env: HostedDispatcherEnv,
  invocation: HostedDispatcherInvocation,
): 'oidc-env' | 'oidc-header' | 'token' | 'none' {
  if (env.VERCEL_OIDC_TOKEN) return 'oidc-env'
  if (invocation.oidcToken) return 'oidc-header'
  if (env.VERCEL_TOKEN && env.VERCEL_TEAM_ID && env.VERCEL_PROJECT_ID) return 'token'
  return 'none'
}

export function createHostedDispatcher(options: HostedDispatcherOptions = {}): {
  tick(
    invocation?: string,
    credentials?: HostedDispatcherInvocation,
  ): Promise<HostedDispatcherTickSummary>
} {
  const env = options.env ?? process.env
  const clock: Clock = options.clock ?? (() => new Date())
  const dispatch = options.dispatch ?? ((opts: DispatchOpts) => abDispatch(opts))
  const log = options.log ?? ((line: string) => console.log(line))
  const logError = options.logError ?? ((line: string) => console.error(line))
  return {
    async tick(
      invocation = invocationId(),
      credentials: HostedDispatcherInvocation = {},
    ): Promise<HostedDispatcherTickSummary> {
      const config = parseHostedDispatcherEnv(env)
      const now = clock().getTime()
      const deadlineAt = now + config.budgetSeconds * 1000
      const sandboxAuth = sandboxAuthSource(env, credentials)
      log(
        `${LOG_PREFIX} ${invocation}: tick start repositories=${config.repositories.length} budgetSeconds=${config.budgetSeconds} origin=${config.origin} sandboxAuth=${sandboxAuth}`,
      )
      const repositories: HostedDispatcherRepositoryOutcome[] = []
      for (const repository of config.repositories) {
        if (clock().getTime() + MIN_REMAINING_MS > deadlineAt) {
          repositories.push({ repository, outcome: 'skipped' })
          log(`${LOG_PREFIX} ${invocation}: ${repository} skipped (invocation budget exhausted)`)
          continue
        }
        const runId = `hosted-dispatcher-${randomUUID()}`
        const kernelPrefix = `${LOG_PREFIX} ${invocation}: ${repository} [kernel]`
        const stdout = options.stdout ?? ((line: string) => log(`${kernelPrefix} ${line}`))
        const stderr = options.stderr ?? ((line: string) => logError(`${kernelPrefix} ${line}`))
        const startedAt = Date.now()
        log(`${LOG_PREFIX} ${invocation}: ${repository} tick run=${runId}`)
        // Unattributed deployment operator credential: it covers store and
        // ticket operations (attributed operator tokens are operator-API-only
        // and cannot write store events). It names nothing because store
        // identity travels via the run id. Never logged, never returned.
        const token = mintToken(config.secret, {
          operator: true,
          session: '*',
          exp: clock().getTime() + config.tokenTtlSeconds * 1000,
        })
        const childEnv: Record<string, string | undefined> = {
          ...env,
          AB_STORE: config.origin,
          AB_TOKEN: token,
        }
        // A Vercel Function receives the deployment's OIDC token as a request
        // header, not as VERCEL_OIDC_TOKEN; hand it to the kernel under that
        // name so the Sandbox SDK authenticates as the deployment. An explicit
        // environment token keeps precedence.
        if (!childEnv.VERCEL_OIDC_TOKEN && credentials.oidcToken) {
          childEnv.VERCEL_OIDC_TOKEN = credentials.oidcToken
        }
        // Per-repository forge identity: both variables are set to the
        // override so no reader (`resolveGitHubToken` prefers GITHUB_TOKEN,
        // the publication path and init-validation accept either) can straddle
        // the override and the shared credential within one tick. Repositories
        // without an override keep the shared credential untouched.
        const forgeOverride = config.githubTokenOverrides.get(repository)
        if (forgeOverride !== undefined) {
          childEnv.GITHUB_TOKEN = forgeOverride
          childEnv.GH_TOKEN = forgeOverride
        }
        try {
          // The kernel would otherwise fall back to the gh CLI login of
          // whoever runs this service (a maintainer's laptop, per the README's
          // local-run section), and a multi-tenant dispatcher must never act
          // on a served repository as an ambient personal identity. Every
          // served repository authenticates with an explicit token, or fails.
          if (!childEnv.GITHUB_TOKEN && !childEnv.GH_TOKEN) {
            throw new Error(
              'origin-mode dispatch requires GITHUB_TOKEN or GH_TOKEN for the GitHub API: ' +
                `the hosted dispatcher has no per-repository override for ${repository} and ` +
                'no shared token, and never uses a gh CLI login',
            )
          }
          await dispatch({
            targetRepo: '<hosted-dispatcher>',
            repository,
            once: true,
            plain: true,
            env: childEnv,
            exec: spawnExec,
            stdout,
            stderr,
            kernelRunId: runId,
            deadlineAt,
          })
          repositories.push({ repository, outcome: 'ticked', runId })
          log(
            `${LOG_PREFIX} ${invocation}: ${repository} ticked run=${runId} ms=${Date.now() - startedAt}`,
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          repositories.push({ repository, outcome: 'failed', runId, error: message })
          logError(
            `${LOG_PREFIX} ${invocation}: ${repository} failed run=${runId} ms=${Date.now() - startedAt}: ${errorDetail(error)}`,
          )
        }
      }
      const counts = { ticked: 0, failed: 0, skipped: 0 }
      for (const entry of repositories) counts[entry.outcome] += 1
      log(
        `${LOG_PREFIX} ${invocation}: tick complete ticked=${counts.ticked} failed=${counts.failed} skipped=${counts.skipped}`,
      )
      return { deadlineAt, repositories }
    },
  }
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest()
  const digestB = createHash('sha256').update(b).digest()
  return timingSafeEqual(digestA, digestB)
}

function jsonError(status: number, kind: string, error: string): Response {
  return Response.json({ error, kind }, { status })
}

/** The cron endpoint: one authorized GET runs one bounded tick per configured
 * repository. `CRON_SECRET` unset/blank disables the endpoint entirely — work
 * never runs without authorization configured. A wrong or missing bearer is
 * rejected without performing any work, compared timing-safe. */
export function createDispatcherEndpoint(options: HostedDispatcherOptions = {}): {
  fetch(request: Request): Promise<Response>
} {
  const dispatcher = createHostedDispatcher(options)
  const env = options.env ?? process.env
  const log = options.log ?? ((line: string) => console.log(line))
  const logError = options.logError ?? ((line: string) => console.error(line))
  return {
    async fetch(request: Request): Promise<Response> {
      const invocation = invocationId()
      const startedAt = Date.now()
      // The user agent tells a Vercel Cron invocation (`vercel-cron/1.0`)
      // apart from an operator's curl in the runtime logs; it is not trusted.
      const agent = request.headers.get('user-agent') ?? '-'
      log(
        `${LOG_PREFIX} ${invocation}: ${request.method} ${new URL(request.url).pathname} agent=${JSON.stringify(agent)}`,
      )
      const reject = (status: number, kind: string, error: string): Response => {
        logError(`${LOG_PREFIX} ${invocation}: rejected ${status} ${kind}: ${error}`)
        return jsonError(status, kind, error)
      }
      if (request.method !== 'GET') {
        return reject(405, 'method-not-allowed', 'the dispatcher endpoint answers GET only')
      }
      // Endpoint disabled: never run work without authorization configured.
      const cronSecret = env.CRON_SECRET?.trim()
      if (cronSecret === undefined || cronSecret === '') {
        return reject(
          403,
          'disabled',
          'the dispatcher endpoint is disabled: CRON_SECRET is not configured',
        )
      }
      const authorization = request.headers.get('authorization') ?? ''
      if (!timingSafeStringEqual(authorization, `Bearer ${cronSecret}`)) {
        return reject(
          401,
          'unauthorized',
          `dispatcher endpoint requires the cron bearer token (authorization header ${authorization === '' ? 'absent' : 'present but wrong'})`,
        )
      }
      try {
        const oidcToken = request.headers.get('x-vercel-oidc-token')?.trim()
        const summary = await dispatcher.tick(
          invocation,
          oidcToken !== undefined && oidcToken !== '' ? { oidcToken } : {},
        )
        log(`${LOG_PREFIX} ${invocation}: 200 ok ms=${Date.now() - startedAt}`)
        return Response.json(
          { ok: true, repositories: summary.repositories },
          { headers: { 'cache-control': 'private, no-store' } },
        )
      } catch (error) {
        // A misconfigured deployment names the offending variable, never a
        // value: every parser error is written that way.
        logError(
          `${LOG_PREFIX} ${invocation}: 500 configuration invalid ms=${Date.now() - startedAt}: ${errorDetail(error)}`,
        )
        return jsonError(
          500,
          'internal',
          error instanceof Error ? error.message : 'dispatcher configuration is invalid',
        )
      }
    },
  }
}
