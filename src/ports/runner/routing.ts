/**
 * Runtime/model/extension role resolution (SPEC §9, §16.1). The reserved
 * `[roles.default]` entry is the raw inheritance base; every concrete role
 * merges over it independently per field (phase and non-phase alike).
 *
 * The resolver is EAGER: `createRuntimeResolver` resolves the default and every
 * declared role AT CONSTRUCTION, aggregating every problem into one loud
 * `RuntimeConfigError`. A named runtime/model pair is exact: the runtime must
 * be registered and must serve that model. Resolution never substitutes a
 * runtime-local default for an incompatible configured model and never hunts
 * the registry for a runtime that happens to serve a model-only role.
 *
 * At lookup time the resolver answers one question: WHICH DECLARED KEY APPLIES.
 * A caller may offer deprecated compatibility keys after the primary role, and
 * the reserved base is matched by name at its own position in that walk even
 * though it is never cached as a phase role. When no candidate is declared the
 * validated `[roles.default]` result is returned — a real, wholesale fallback,
 * which `ab dispatch` warns about from the declaration side (`src/config/roles.ts`).
 */
import type { AgentRunner } from '../types'
import { serves, type RuntimeRegistry } from './runtime'

/** A resolved runtime/model pair plus the adapter to run it (§9). */
export interface ResolvedRuntime {
  runner: AgentRunner
  /** The registry key == the frozen `session.started.runner` value. */
  runtime: string
  /** Absent ⇒ the adapter's built-in default model. */
  model?: string
  /** Named extensions this session may use (§9, third axis). Empty ⇒ hermetic.
   * Runtime-specific — runtimes without an extension model ignore it. */
  extensions?: readonly string[]
}

/** One role entry as it arrives from `[roles]`: all fields are optional. */
export interface RuntimeSpec {
  runtime?: string
  model?: string
  extensions?: readonly string[]
}

/**
 * A loud, aggregated configuration failure (§9). Dedicated (not the TOML
 * parser's ConfigError) so `ports/` need not depend on `config/load`. Carries
 * every problem found across the default and all declared roles, one per line.
 */
export class RuntimeConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `invalid runtime/model configuration (SPEC §9):\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    )
    this.name = 'RuntimeConfigError'
  }
}

export interface RuntimeResolver {
  /**
   * The resolution for a role, cached at construction.
   *
   * @param role    the logical name the pipeline dispatched (core phase, verify
   *                or finalize step name, internal role).
   * @param aliases deprecated compatibility keys, consulted IN ORDER and only
   *                when `role` itself is not declared — today, an agent verify
   *                step's configured skill name (§9 routing).
   *
   * The earliest declared candidate wins. When no candidate is declared, the
   * validated `[roles.default]` result is returned, exactly as before aliases
   * existed.
   */
  resolve(role: string, ...aliases: string[]): ResolvedRuntime
}

/** The registered runtime names, for error messages. */
function runtimeNames(registry: RuntimeRegistry): string {
  return Object.keys(registry).join(', ') || 'none'
}

/** The declared model families for one runtime, for error messages. */
function servedModels(registry: RuntimeRegistry, runtime: string): string {
  return registry[runtime]!.servesModels.join(', ') || 'no models'
}

/**
 * Merge one raw role over a raw base, then resolve and validate that exact
 * pair. Registry defaults are applied only AFTER raw inheritance: a child that
 * changes runtime must get its new runtime's default model when neither entry
 * explicitly names a model, not inherit the old runtime's implicit default.
 *
 * Problems are collected rather than thrown so construction can report every
 * bad role in one failure.
 */
function resolveSpec(
  spec: RuntimeSpec,
  base: RuntimeSpec,
  registry: RuntimeRegistry,
  label: string,
  problems: string[],
): ResolvedRuntime | undefined {
  const runtime = spec.runtime ?? base.runtime
  if (runtime === undefined || runtime.trim().length === 0) {
    problems.push(
      `${label} is missing required runtime. Add:\n\n` +
        `[roles.default]\n` +
        `runtime = "<runtime>"\n\n` +
        `Available runtimes: ${runtimeNames(registry)}`,
    )
    return undefined
  }
  const reg = registry[runtime]
  if (reg === undefined) {
    problems.push(
      `${label} resolves to runtime "${runtime}", which is not registered ` +
        `(registered runtimes: ${runtimeNames(registry)})`,
    )
    return undefined
  }

  // The sole implicit fill-in: once the merged runtime is known, an entirely
  // absent configured model uses that runtime's own default. `undefined` keeps
  // the adapter's built-in default behavior.
  const model = spec.model ?? base.model ?? reg.defaultModel
  if (model !== undefined && !serves(reg, model)) {
    problems.push(
      `${label} resolves runtime "${runtime}" with model "${model}", but ` +
        `"${runtime}" serves only [${servedModels(registry, runtime)}]`,
    )
    return undefined
  }

  return {
    runner: reg.runner,
    runtime,
    ...(model !== undefined ? { model } : {}),
    extensions: spec.extensions ?? base.extensions ?? [],
  }
}

/**
 * Build the resolver, resolving EVERYTHING eagerly (§9). Any problem — in the
 * reserved default or any declared role — throws one aggregated
 * `RuntimeConfigError`, so bad config fails before a session launches.
 *
 * @param registry name → adapter + compatibility data.
 * @param roles    `[roles]`, including the required reserved `default`.
 */
export function createRuntimeResolver(
  registry: RuntimeRegistry,
  roles: Record<string, RuntimeSpec>,
): RuntimeResolver {
  const problems: string[] = []
  const defaultSpec = roles.default ?? {}

  const resolvedDefault = resolveSpec(defaultSpec, {}, registry, '[roles.default]', problems)

  // NULL-PROTOTYPE, and load-bearing: role keys are user-chosen names from an
  // open map, and `resolve` treats "the cache has this key" as "the config
  // declares this role". On a normal `{}`, `resolvedRoles['constructor']` (or
  // `toString`, `valueOf`, …) hits `Object.prototype` and answers a FUNCTION —
  // an undeclared role would resolve to it, shadow a declared alias, and hand
  // `executeSession` an object with no runner or runtime.
  const resolvedRoles: Record<string, ResolvedRuntime> = Object.create(null)
  for (const [role, spec] of Object.entries(roles)) {
    // Reserved inheritance base, never a dispatched phase-role cache entry.
    if (role === 'default') continue
    const resolved = resolveSpec(spec, defaultSpec, registry, `[roles.${role}]`, problems)
    if (resolved !== undefined) resolvedRoles[role] = resolved
  }

  if (problems.length > 0) throw new RuntimeConfigError(problems)
  // A failed default always contributes a problem, so it is defined here.
  const fallback = resolvedDefault!

  return {
    resolve(role: string, ...aliases: string[]): ResolvedRuntime {
      for (const key of [role, ...aliases]) {
        // The reserved base is declared by definition — construction fails
        // without it — but it is deliberately never cached as a phase role, so
        // match it here or a later alias would outrank it.
        if (key === 'default') return fallback
        // Sound as a declaration test only because the cache has a null
        // prototype — see its construction above.
        const resolved = resolvedRoles[key]
        if (resolved !== undefined) return resolved
      }
      return fallback
    },
  }
}
