/**
 * The per-call operator-sandbox resolver (#1219): the hosted MCP binding's
 * gate and cache in front of the `sandbox.*` tools.
 *
 * Each call reads the repository's LATEST deposited effective config (one
 * repository read plus the latest artifact row, never a listing of every
 * revision) and refuses with a typed `SandboxUnavailableError` when the gate
 * is closed. An open gate returns one composed backend per repository, keyed
 * by effective-config revision and a caller-supplied credential key, reused
 * across calls. The repo-scoped store token the composition needs is cached
 * separately and renewed only near expiry, so a recomposition (new revision,
 * changed credential) never issues a fresh credential while the token holds.
 *
 * Composition is injected: this module never imports the
 * `operator-sandbox-host` closure, so `./operator` does not grow it.
 *
 * A credential key that rotates often (a short-lived OIDC value) recomposes
 * on each rotation: a scratch directory plus forge and provider construction,
 * still bounded and with no new store credential while the token is fresh.
 */
import { redactSandboxMessage } from '../ports/workspace/operator-sandbox'
import type { Config } from '../config/schema'
import { systemClock, type BuildStore, type Clock } from '../store/types'
import { OrchestratorConfigError, readOrchestratorGate } from './query'
import type { OperatorSandboxService } from './sandbox'

export type SandboxUnavailableReason =
  | 'no-effective-config'
  | 'orchestrator-disabled'
  | 'effective-config-invalid'
  | 'backend-unavailable'

/** A sandbox call cannot be served for this repository. The registry maps it
 * to a `sandbox-<reason>` refusal, so a caller sees why, never `unknown tool`. */
export class SandboxUnavailableError extends Error {
  override readonly name = 'SandboxUnavailableError'

  constructor(
    readonly reason: SandboxUnavailableReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/** The request-scoped provider credential a hosted call carries. */
export interface SandboxRequestCredentials {
  oidcToken?: string
}

export interface OperatorSandboxResolverOptions {
  store: BuildStore
  clock?: Clock
  /** Whether a composed backend can publish; the registry filters
   * `sandbox.publish` when false. */
  canPublish: boolean
  /** Issue a repo-scoped store token valid until `expiresAt`. */
  issueStoreToken(repo: string, expiresAt: Date): Promise<string>
  /** Lifetime requested for each issued store token. Default one hour. */
  storeTokenLifetimeMs?: number
  /** A cached token is renewed once less than this remains. Default ten minutes. */
  storeTokenRenewMarginMs?: number
  /** The part of the request credentials composition depends on. A change
   * recomposes the backend. Default: none (`''`). */
  credentialKey?(credentials?: SandboxRequestCredentials): string
  compose(input: {
    repo: string
    config: Config
    storeToken: string
    credentials?: SandboxRequestCredentials
  }): Promise<OperatorSandboxService>
  /** Observes composition, token and disposal failures. Never thrown. */
  report?(error: unknown): void | Promise<void>
}

export interface OperatorSandboxResolver {
  readonly canPublish: boolean
  /** Gate the call on the repository's latest effective config and return its
   * cached backend. Throws `SandboxUnavailableError` when the call cannot be
   * served. */
  resolve(repo: string, credentials?: SandboxRequestCredentials): Promise<OperatorSandboxService>
  /** Dispose every cached backend. */
  dispose(): Promise<void>
}

const DEFAULT_TOKEN_LIFETIME_MS = 3_600_000
const DEFAULT_TOKEN_RENEW_MARGIN_MS = 600_000

function describe(error: unknown): string {
  return redactSandboxMessage(error instanceof Error ? error.message : String(error))
}

export function createOperatorSandboxResolver(
  options: OperatorSandboxResolverOptions,
): OperatorSandboxResolver {
  const clock = options.clock ?? systemClock
  const lifetime = options.storeTokenLifetimeMs ?? DEFAULT_TOKEN_LIFETIME_MS
  const margin = options.storeTokenRenewMarginMs ?? DEFAULT_TOKEN_RENEW_MARGIN_MS
  const keyOf = options.credentialKey ?? (() => '')
  const services = new Map<
    string,
    { revision: number; key: string; service: Promise<OperatorSandboxService> }
  >()
  const tokens = new Map<string, { expiresAt: number; token: Promise<string> }>()

  const report = async (error: unknown): Promise<void> => {
    try {
      await options.report?.(error)
    } catch {
      // Reporting never fails a call.
    }
  }

  const unavailable = (repo: string, error: unknown): SandboxUnavailableError =>
    new SandboxUnavailableError(
      'backend-unavailable',
      `the operator sandbox backend for repository "${repo}" could not be built: ${describe(error)}`,
      { cause: error },
    )

  const storeToken = (repo: string): Promise<string> => {
    const now = clock().getTime()
    const cached = tokens.get(repo)
    if (cached !== undefined && cached.expiresAt - now > margin) return cached.token
    const expiresAt = now + lifetime
    const token = options.issueStoreToken(repo, new Date(expiresAt))
    const entry = { expiresAt, token }
    tokens.set(repo, entry)
    token.catch(() => {
      if (tokens.get(repo) === entry) tokens.delete(repo)
    })
    return token
  }

  const retire = (service: Promise<OperatorSandboxService>): void => {
    // A superseded backend may still serve an in-flight call. Disposal only
    // removes its local scratch, which the hosted providers reach solely
    // through paths the injected seams bypass, so that call is unaffected.
    // Each backend serializes its own calls; a replacement mid-burst can
    // briefly overlap two calls for one environment. Replacement happens only
    // on a revision or credential change, so no cross-instance lock exists.
    void service.then((old) => old.dispose?.()).catch((error: unknown) => report(error))
  }

  return {
    canPublish: options.canPublish,

    async resolve(repo, credentials) {
      let gate: Awaited<ReturnType<typeof readOrchestratorGate>>
      try {
        gate = await readOrchestratorGate(options.store, repo)
      } catch (error) {
        if (error instanceof OrchestratorConfigError) {
          throw new SandboxUnavailableError(
            'effective-config-invalid',
            `repository "${repo}" has an unusable latest effective config (${error.message}); fix the configuration and let the dispatcher deposit it again`,
            { cause: error },
          )
        }
        throw error
      }
      if (!gate.enabled) {
        throw gate.reason === 'orchestrator-disabled'
          ? new SandboxUnavailableError(
              'orchestrator-disabled',
              `repository "${repo}" does not enable [orchestrator] in its latest deposited effective config; set \`[orchestrator] enabled = true\` and let the dispatcher deposit it`,
            )
          : new SandboxUnavailableError(
              'no-effective-config',
              `repository "${repo}" has no deposited effective config; sandbox tools need a dispatcher run with \`[orchestrator] enabled = true\``,
            )
      }
      const key = keyOf(credentials)
      const cached = services.get(repo)
      if (cached !== undefined && cached.revision === gate.revision && cached.key === key) {
        return cached.service
      }
      const config = gate.config
      const service = (async () => {
        let token: string
        try {
          token = await storeToken(repo)
        } catch (error) {
          await report(error)
          throw unavailable(repo, error)
        }
        try {
          return await options.compose({
            repo,
            config,
            storeToken: token,
            ...(credentials !== undefined ? { credentials } : {}),
          })
        } catch (error) {
          await report(error)
          throw unavailable(repo, error)
        }
      })()
      const entry = { revision: gate.revision, key, service }
      services.set(repo, entry)
      service.catch(() => {
        if (services.get(repo) === entry) services.delete(repo)
      })
      if (cached !== undefined) retire(cached.service)
      return service
    },

    async dispose() {
      const all = [...services.values()]
      services.clear()
      tokens.clear()
      await Promise.all(
        all.map(async ({ service }) => {
          try {
            await (await service).dispose?.()
          } catch (error) {
            await report(error)
          }
        }),
      )
    },
  }
}
