/**
 * Declarative capabilities a workspace-provider registration can supply, plus
 * the readiness contract those capabilities speak. Core honours these
 * declarations at registry-aware seams without naming any provider, which is
 * what lets a third-party remote provider receive the same treatment as the
 * builtin `vercel-sandbox` registration (AUT-516).
 *
 * This module is a leaf: runtime imports are limited to `config/roles`
 * helpers, everything else is types. `config/schema.ts` imports the message
 * builders below, and `builtin-capabilities.ts` imports `config/schema.ts` —
 * so nothing here may import either, or module evaluation would cycle.
 */
import type { z } from 'zod'
import { displayName, tomlKey, type RuntimeReferenceGroup } from '../../config/roles'
import type { Config } from '../../config/schema'
import type { Exec } from './git-worktree'

/** Host-derived effective routes; consumed only by remote providers. */
export type RuntimeReferencesSource =
  | readonly RuntimeReferenceGroup[]
  | (() => readonly RuntimeReferenceGroup[])

export function currentRuntimeReferences(
  source: RuntimeReferencesSource | undefined,
): readonly RuntimeReferenceGroup[] {
  if (source === undefined) return []
  return typeof source === 'function' ? source() : source
}

/** The `[workspace.config.runtimeProvisioning]` map of a parsed provider
 * config, `{}` when the provider declares no such table. */
export function runtimeProvisioningMap(parsedConfig: unknown): Record<string, unknown> {
  if (parsedConfig === null || typeof parsedConfig !== 'object') return {}
  const table = (parsedConfig as { runtimeProvisioning?: unknown }).runtimeProvisioning
  return table !== null && typeof table === 'object' ? (table as Record<string, unknown>) : {}
}

/** Verbatim `configSchema` diagnostic for a referenced runtime with no
 * provisioning entry. Shared by the config parse and the construction seam so
 * the two cannot drift. */
export function runtimeProvisioningMissingMessage(group: RuntimeReferenceGroup): string {
  return (
    `runtime ${displayName(group.runtime)} is selected by ${group.references.join(', ')} but has no sandbox provisioning; add ` +
    `[workspace.config.runtimeProvisioning.${tomlKey(group.runtime)}] with nonblank install and preflight commands`
  )
}

/** Verbatim credential-free operator-sandbox diagnostic (AUT-340). Shared by
 * the config parse and the construction seam so the two cannot drift. */
export function sandboxForbiddenEnvMessage(name: string): string {
  return `environment variable ${JSON.stringify(name)} is a store, forge, ticket-provider, model, or Vercel credential and may never be forwarded into an operator sandbox`
}

// ── Readiness contract ───────────────────────────────────────────────────────

export interface ReadinessCheck {
  name: string
  status: 'pass' | 'fail' | 'absent'
  detail: string
}

export interface InitValidationReport {
  provider: string
  context: 'local worktree' | 'Vercel Sandbox'
  workspace?: string
  revision?: string
  checks: ReadinessCheck[]
  exitCode: number
  /** Vercel only: automatic snapshots deleted while releasing the disposable
   * environment; zero proves no snapshot storage was left behind. */
  snapshotsDeleted?: number
}

export interface GuestProbeReport {
  checks: ReadinessCheck[]
}

// ── Capability declarations ──────────────────────────────────────────────────

/** One required-environment group: alternatives are tried in order, and one
 * is satisfied when EVERY named variable in it is set nonempty. A site that
 * performs no check today omits its message field. */
export interface WorkspaceProviderEnvRequirement {
  alternatives: readonly (readonly string[])[]
  /** Verbatim dispatch-preflight text (`cli/dispatch.ts`). */
  dispatchMessage?: string
  /** Verbatim init-preflight text (`validateInitReadiness`'s hostPreflight). */
  validationMessage?: string
}

/**
 * Everything a workspace-provider registration can declare about its own
 * behavior, so core can enforce it without naming the provider. Field texts
 * are verbatim today's messages; a capability absent means "no check".
 */
export interface WorkspaceProviderCapabilities {
  /** Strict schema applied to `[workspace.config]`. Mutually exclusive with
   * `configRefusal`. */
  configSchema?: z.ZodType
  /** Construction-site refusal (`createWorkspaceProvider`) for a provider
   * that rejects `[workspace.config]` outright. Distinct from the parse-site
   * refusal text, which lives on the builtin config table in
   * `config/schema.ts` — the two strings differ by design. */
  configRefusal?: string
  /** Referenced runtimes must have `[workspace.config.runtimeProvisioning]`
   * entries. */
  requireRuntimeProvisioning?: boolean
  /** Names added to the operator-sandbox forbidden-forwarding set beyond
   * `SANDBOX_FORBIDDEN_ENV`. Enforced at the two registry-aware seams —
   * `createWorkspaceProvider` construction and the registry-aware
   * `validateInitReadiness` check — not at config parse: plugins are not
   * loaded when config is parsed, and no site loads plugins earlier to widen
   * parse-time coverage. The shared `SANDBOX_FORBIDDEN_ENV` names are
   * rejected at parse time for every provider (AUT-536). */
  sandboxForbiddenEnv?: readonly string[]
  supportedForges?: readonly string[]
  /** Verbatim texts; dispatch and init validation emit different sentences. */
  forgeDispatchMessage?: string
  forgeValidationMessage?: string
  requiredEnv?: readonly WorkspaceProviderEnvRequirement[]
  /** Variables that must exist in the launcher process environment, never
   * only in a loaded `.env`. */
  processEnvOnly?: readonly { name: string; message: string }[]
  /** Store requirements for checkout-less providers, with each site's
   * verbatim text. */
  storeRequirements?: {
    constructionMessage: string
    storeRefMessage: string
    storeTokenMessage: string
  }
  /** Validates the git origin URL before dispatch (throws the provider's own
   * message) and returns the normalized origin coordinates. */
  validateOrigin?: (raw: string) => { url: string; host: string; path: string; directory: string }
  originReadFailureMessage?: string
  /** Env names the provider forwards into the guest (readiness redaction). */
  guestEnvNames?: (config: unknown) => readonly string[]
  /** Readiness summary stdout lines printed after the report. */
  describeEnvironment?: (
    config: unknown,
    env: Record<string, string | undefined>,
  ) => readonly string[]
  /** Remote readiness validation for `ab init --validate`. */
  validateReadiness?: (ctx: WorkspaceReadinessContext) => Promise<InitValidationReport>
}

/** Everything a readiness implementation reads. `facade` and `packageArchive`
 * are the host's test seams, passed opaquely — the vercel implementation
 * narrows them. */
export interface WorkspaceReadinessContext {
  config: Config
  /** The `[workspace.config]` parsed with the declared `configSchema`. */
  providerConfig: unknown
  env: Record<string, string | undefined>
  storeRef: string
  storeToken: string
  repo: string
  baseBranch: string
  configBytes: string
  exec: Exec
  redact: (value: unknown) => string
  runtimeReferences: readonly RuntimeReferenceGroup[]
  stdout: (line: string) => void
  signal?: AbortSignal
  facade?: unknown
  packageArchive?: () => Promise<Uint8Array>
}
