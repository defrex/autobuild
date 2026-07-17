/**
 * The two-axis runtime/model resolver (SPEC §9, §16.1) — v1's `resolveRole`,
 * generalized. Two independent axes are settable once as a repo-wide default
 * (`[agent]`) and overridable per step (`[roles]`): the RUNTIME that executes
 * the session and the MODEL it runs on. Overrides resolve most-specific-first.
 *
 * The resolver is EAGER: `createRuntimeResolver` resolves the default pair and
 * every declared role AT CONSTRUCTION, aggregating every problem into one loud
 * `RuntimeConfigError`. So a config naming an unregistered runtime, a
 * runtime+model pair the runtime can't serve, or an ambiguous model-only route
 * fails BEFORE any session launches — never a silent fallback mid-build. This
 * is why it replaces the old per-call resolve: a lazy resolve only fails the
 * one build that happens to hit the bad role, and can't detect "several
 * non-default supporters" as a config error at all.
 */
import type { AgentRunner } from '../types'
import { serves, type RuntimeRegistry } from './runtime'

/** A resolved (runtime, model) pair plus the adapter to run it (§9). */
export interface ResolvedRuntime {
  runner: AgentRunner
  /** The registry key == the frozen `session.started.runner` value. */
  runtime: string
  /** Absent ⇒ the adapter's built-in default model. */
  model?: string
}

/** One axis override as it arrives from config (`[agent]` or a `[roles]`
 * entry): both keys optional. */
export interface RuntimeSpec {
  runtime?: string
  model?: string
}

/**
 * A loud, aggregated configuration failure (§9). Dedicated (not the TOML
 * parser's ConfigError) so `ports/` need not depend on `config/load`. Carries
 * every problem found across the default pair and all roles, one per line.
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
   * config resolves to the default pair (validated at construction). */
  resolve(role: string): ResolvedRuntime
}

/** The registered runtime names, for error messages. */
function runtimeNames(registry: RuntimeRegistry): string {
  return Object.keys(registry).join(', ') || 'none'
}

/**
 * Resolve one spec most-specific-first, collecting problems into `problems`
 * rather than throwing (so the caller can aggregate). Returns the resolution,
 * or `undefined` when a problem made it unresolvable.
 *
 * `defaultRuntimeName` is the runtime the model-only branch prefers: for a
 * role it is the resolved default pair's runtime; for the default pair itself
 * it is the wiring fallback (e.g. `claude`).
 */
function resolveSpec(
  spec: RuntimeSpec,
  defaultRuntimeName: string,
  registry: RuntimeRegistry,
  label: string,
  problems: string[],
): ResolvedRuntime | undefined {
  const { runtime, model } = spec

  // ── runtime + model → exactly that pair; the runtime must serve the model.
  if (runtime !== undefined && model !== undefined) {
    const reg = registry[runtime]
    if (reg === undefined) {
      problems.push(
        `${label} names runtime "${runtime}", which is not registered ` +
          `(registered runtimes: ${runtimeNames(registry)})`,
      )
      return undefined
    }
    if (!serves(reg, model)) {
      problems.push(
        `${label} pins runtime "${runtime}" with model "${model}", but "${runtime}" ` +
          `serves only [${reg.servesModels.join(', ') || 'no models'}] — pin a model it ` +
          `serves or a different runtime`,
      )
      return undefined
    }
    return { runner: reg.runner, runtime, model }
  }

  // ── runtime only → that runtime with its own default model.
  if (runtime !== undefined) {
    const reg = registry[runtime]
    if (reg === undefined) {
      problems.push(
        `${label} names runtime "${runtime}", which is not registered ` +
          `(registered runtimes: ${runtimeNames(registry)})`,
      )
      return undefined
    }
    return {
      runner: reg.runner,
      runtime,
      ...(reg.defaultModel !== undefined ? { model: reg.defaultModel } : {}),
    }
  }

  // ── model only → a runtime that can serve it.
  if (model !== undefined) {
    const supporters = Object.keys(registry).filter((name) =>
      serves(registry[name]!, model),
    )
    // The default runtime wins whenever it qualifies, even if others also do.
    if (supporters.includes(defaultRuntimeName)) {
      return { runner: registry[defaultRuntimeName]!.runner, runtime: defaultRuntimeName, model }
    }
    if (supporters.length === 1) {
      const name = supporters[0]!
      return { runner: registry[name]!.runner, runtime: name, model }
    }
    if (supporters.length === 0) {
      problems.push(
        `${label} requests model "${model}", but no registered runtime serves it ` +
          `(registered runtimes: ${runtimeNames(registry)}) — pin a runtime explicitly`,
      )
      return undefined
    }
    problems.push(
      `${label} requests model "${model}", which is served by multiple runtimes ` +
        `(${supporters.join(', ')}) and none is the default — pin the runtime explicitly`,
    )
    return undefined
  }

  // ── neither → the default runtime with its own default model.
  const reg = registry[defaultRuntimeName]
  if (reg === undefined) {
    problems.push(
      `${label} falls back to runtime "${defaultRuntimeName}", which is not registered ` +
        `(registered runtimes: ${runtimeNames(registry)})`,
    )
    return undefined
  }
  return {
    runner: reg.runner,
    runtime: defaultRuntimeName,
    ...(reg.defaultModel !== undefined ? { model: reg.defaultModel } : {}),
  }
}

/**
 * Build the resolver, resolving EVERYTHING eagerly (§9). Any problem — in the
 * default pair or any role — throws one aggregated `RuntimeConfigError`, so a
 * bad config fails before a session launches.
 *
 * @param registry         name → adapter + capabilities.
 * @param agentDefaults    the `[agent]` table (may be undefined ⇒ empty spec).
 * @param fallbackRuntime  the wiring default runtime (e.g. `claude`) — the
 *                         model-only preference for the default pair, and the
 *                         runtime used when `[agent]` names neither axis.
 * @param roles            the `[roles]` map, `role → { runtime?, model? }`.
 */
export function createRuntimeResolver(
  registry: RuntimeRegistry,
  agentDefaults: RuntimeSpec | undefined,
  fallbackRuntime: string,
  roles: Record<string, RuntimeSpec>,
): RuntimeResolver {
  const problems: string[] = []

  // The default pair, keyed on the wiring fallback for its own model-only route.
  const defaultPair = resolveSpec(
    agentDefaults ?? {},
    fallbackRuntime,
    registry,
    '[agent] default',
    problems,
  )

  // Every role resolves against the default pair's runtime (its model-only
  // preference). If the default pair itself failed, roles still resolve so we
  // surface all their problems too — fall back to the wiring default name.
  const defaultRuntimeName = defaultPair?.runtime ?? fallbackRuntime
  const resolvedRoles: Record<string, ResolvedRuntime> = {}
  for (const [role, spec] of Object.entries(roles)) {
    const resolved = resolveSpec(spec, defaultRuntimeName, registry, `[roles].${role}`, problems)
    if (resolved !== undefined) resolvedRoles[role] = resolved
  }

  if (problems.length > 0) throw new RuntimeConfigError(problems)
  // defaultPair is defined here: a failed default pair pushes a problem.
  const fallback = defaultPair!

  return {
    resolve(role: string): ResolvedRuntime {
      return resolvedRoles[role] ?? fallback
    },
  }
}
