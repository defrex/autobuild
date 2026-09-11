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
  const cronSecret = env.CRON_SECRET?.trim()
  return {
    secret,
    origin: origin.origin,
    repositories,
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
  stdout?: (line: string) => void
  stderr?: (line: string) => void
}

/** Below this much remaining budget a further repository is recorded as
 * `skipped` instead of started, so one invocation always answers and the
 * unfinished repository resumes on the next one. */
const MIN_REMAINING_MS = 20_000

function noop(): void {}

/** The kernel owner. One `tick()` per authorized invocation; repositories run
 * sequentially and fully isolated — one repository's failure never stops
 * another. Overlap correctness lives in the durable journal: the repository
 * supervisor lease makes a loser record `dispatcher.tick-yielded`; the
 * response does not re-derive it. */
export function createHostedDispatcher(options: HostedDispatcherOptions = {}): {
  tick(): Promise<HostedDispatcherTickSummary>
} {
  const env = options.env ?? process.env
  const clock: Clock = options.clock ?? (() => new Date())
  const dispatch = options.dispatch ?? ((opts: DispatchOpts) => abDispatch(opts))
  const stdout = options.stdout ?? noop
  const stderr = options.stderr ?? noop
  return {
    async tick(): Promise<HostedDispatcherTickSummary> {
      const config = parseHostedDispatcherEnv(env)
      const now = clock().getTime()
      const deadlineAt = now + config.budgetSeconds * 1000
      const repositories: HostedDispatcherRepositoryOutcome[] = []
      for (const repository of config.repositories) {
        if (clock().getTime() + MIN_REMAINING_MS > deadlineAt) {
          repositories.push({ repository, outcome: 'skipped' })
          continue
        }
        const runId = `hosted-dispatcher-${randomUUID()}`
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
        try {
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
        } catch (error) {
          repositories.push({
            repository,
            outcome: 'failed',
            runId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
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
  return {
    async fetch(request: Request): Promise<Response> {
      if (request.method !== 'GET') {
        return jsonError(405, 'method-not-allowed', 'the dispatcher endpoint answers GET only')
      }
      // Endpoint disabled: never run work without authorization configured.
      const cronSecret = env.CRON_SECRET?.trim()
      if (cronSecret === undefined || cronSecret === '') {
        return jsonError(
          403,
          'disabled',
          'the dispatcher endpoint is disabled: CRON_SECRET is not configured',
        )
      }
      const authorization = request.headers.get('authorization') ?? ''
      if (!timingSafeStringEqual(authorization, `Bearer ${cronSecret}`)) {
        return jsonError(401, 'unauthorized', 'dispatcher endpoint requires the cron bearer token')
      }
      try {
        const summary = await dispatcher.tick()
        return Response.json(
          { ok: true, repositories: summary.repositories },
          { headers: { 'cache-control': 'private, no-store' } },
        )
      } catch (error) {
        // A misconfigured deployment names the offending variable, never a
        // value: every parser error is written that way.
        return jsonError(
          500,
          'internal',
          error instanceof Error ? error.message : 'dispatcher configuration is invalid',
        )
      }
    },
  }
}
