/**
 * Eager runtime/model/extension role resolution (SPEC §9, §16.1). Primary
 * fields and the ordered alternate list inherit independently from the
 * reserved `[roles.default]` entry. A declared role list, including `[]`,
 * replaces the inherited list wholesale; each entry overlays that concrete
 * role's effective primary axes and is validated at construction.
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
  /** Named extensions this session may use. Empty ⇒ hermetic. */
  extensions?: readonly string[]
}

/** A role's primary target plus its failure-triggered targets in declaration order. */
export interface ResolvedRole extends ResolvedRuntime {
  alternates: readonly ResolvedRuntime[]
}

export interface RuntimeAxes {
  runtime?: string
  model?: string
  extensions?: readonly string[]
}

/** One role entry as it arrives from `[roles]`: all fields are optional. */
export interface RuntimeSpec extends RuntimeAxes {
  alternates?: readonly RuntimeAxes[]
}

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
  /** Resolve the earliest declared role/alias, otherwise `[roles.default]`. */
  resolve(role: string, ...aliases: string[]): ResolvedRole
}

function runtimeNames(registry: RuntimeRegistry): string {
  return Object.keys(registry).join(', ') || 'none'
}

function servedModels(registry: RuntimeRegistry, runtime: string): string {
  return registry[runtime]!.servesModels.join(', ') || 'no models'
}

function mergeAxes(spec: RuntimeAxes, base: RuntimeAxes): RuntimeAxes {
  const runtime = spec.runtime ?? base.runtime
  const model = spec.model ?? base.model
  return {
    ...(runtime !== undefined ? { runtime } : {}),
    ...(model !== undefined ? { model } : {}),
    extensions: spec.extensions ?? base.extensions ?? [],
  }
}

/** Resolve one already-merged raw target. Registry defaults apply only when no
 * configured model exists on that target. Problems aggregate instead of throw. */
function resolveAxes(
  axes: RuntimeAxes,
  registry: RuntimeRegistry,
  label: string,
  problems: string[],
): ResolvedRuntime | undefined {
  const runtime = axes.runtime
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

  const model = axes.model ?? reg.defaultModel
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
    extensions: axes.extensions ?? [],
  }
}

function resolveRole(
  spec: RuntimeSpec,
  defaultSpec: RuntimeSpec,
  registry: RuntimeRegistry,
  label: string,
  problems: string[],
): ResolvedRole | undefined {
  const primaryAxes = mergeAxes(spec, defaultSpec)
  const primary = resolveAxes(primaryAxes, registry, label, problems)
  const alternateSpecs = spec.alternates ?? defaultSpec.alternates ?? []
  const alternates: ResolvedRuntime[] = []
  alternateSpecs.forEach((alternate, index) => {
    const resolved = resolveAxes(
      mergeAxes(alternate, primaryAxes),
      registry,
      `${label}.alternates[${index}]`,
      problems,
    )
    if (resolved !== undefined) alternates.push(resolved)
  })
  return primary === undefined ? undefined : { ...primary, alternates }
}

/** Build and eagerly validate the complete role resolver. */
export function createRuntimeResolver(
  registry: RuntimeRegistry,
  roles: Record<string, RuntimeSpec>,
): RuntimeResolver {
  const problems: string[] = []
  const defaultSpec = roles.default ?? {}
  const resolvedDefault = resolveRole(defaultSpec, {}, registry, '[roles.default]', problems)

  const resolvedRoles: Record<string, ResolvedRole> = Object.create(null)
  for (const [role, spec] of Object.entries(roles)) {
    if (role === 'default') continue
    const resolved = resolveRole(spec, defaultSpec, registry, `[roles.${role}]`, problems)
    if (resolved !== undefined) resolvedRoles[role] = resolved
  }

  if (problems.length > 0) throw new RuntimeConfigError(problems)
  const fallback = resolvedDefault!

  return {
    resolve(role: string, ...aliases: string[]): ResolvedRole {
      for (const key of [role, ...aliases]) {
        if (key === 'default') return fallback
        const resolved = resolvedRoles[key]
        if (resolved !== undefined) return resolved
      }
      return fallback
    },
  }
}
