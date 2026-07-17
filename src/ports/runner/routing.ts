/**
 * Runtime/model/extension role resolution (SPEC §9, §16.1). The reserved
 * `[roles.default]` entry is the raw inheritance base; every phase role merges
 * over it independently per field.
 *
 * The resolver is EAGER: `createRuntimeResolver` resolves the default and every
 * declared phase role AT CONSTRUCTION, aggregating every problem into one loud
 * `RuntimeConfigError`. A named runtime/model pair is exact: the runtime must
 * be registered and must serve that model. Resolution never substitutes a
 * runtime-local default for an incompatible configured model and never hunts
 * the registry for a runtime that happens to serve a model-only role.
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
  /** The resolution for a role, cached at construction. A role absent from
   * config resolves to the validated `[roles.default]` result. */
  resolve(role: string): ResolvedRuntime
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
  fallbackRuntime: string,
  registry: RuntimeRegistry,
  label: string,
  problems: string[],
): ResolvedRuntime | undefined {
  const runtime = spec.runtime ?? base.runtime ?? fallbackRuntime
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
 * reserved default or any declared phase role — throws one aggregated
 * `RuntimeConfigError`, so bad config fails before a session launches.
 *
 * @param registry         name → adapter + compatibility data.
 * @param roles            `[roles]`, including optional reserved `default`.
 * @param fallbackRuntime  wiring fallback when no role/default names runtime.
 */
export function createRuntimeResolver(
  registry: RuntimeRegistry,
  roles: Record<string, RuntimeSpec>,
  fallbackRuntime: string,
): RuntimeResolver {
  const problems: string[] = []
  const defaultSpec = roles.default ?? {}

  const resolvedDefault = resolveSpec(
    defaultSpec,
    {},
    fallbackRuntime,
    registry,
    '[roles.default]',
    problems,
  )

  const resolvedRoles: Record<string, ResolvedRuntime> = {}
  for (const [role, spec] of Object.entries(roles)) {
    // Reserved inheritance base, never a dispatched phase-role cache entry.
    if (role === 'default') continue
    const resolved = resolveSpec(
      spec,
      defaultSpec,
      fallbackRuntime,
      registry,
      `[roles.${role}]`,
      problems,
    )
    if (resolved !== undefined) resolvedRoles[role] = resolved
  }

  if (problems.length > 0) throw new RuntimeConfigError(problems)
  // A failed default always contributes a problem, so it is defined here.
  const fallback = resolvedDefault!

  return {
    resolve(role: string): ResolvedRuntime {
      return resolvedRoles[role] ?? fallback
    },
  }
}
