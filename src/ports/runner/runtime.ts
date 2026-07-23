/**
 * The runtime registry (SPEC §9): the "adapter registry" the spec says adding
 * a runtime should touch — and ONLY it. Each registration pairs an AgentRunner
 * adapter with its capabilities: model families/default for compatibility
 * validation, plus an
 * optional tool-free, non-phase one-shot completion. Keeping capabilities HERE, in a
 * wrapper around the adapter, is deliberate: the `AgentRunner` port itself is
 * frozen (spec "out of scope" — no renaming/extending it), so capability data
 * lives beside the registry rather than inside the port. The kernel never
 * learns a runtime's name; it asks the resolver, and the resolver reads this.
 *
 * "runtime" is the config-surface vocabulary for what the code has always
 * called a runner: the registry KEY is the runtime name (== the frozen
 * `session.started.runner` value the build-runner records), while the adapter's
 * own `.name` is a separate, also-frozen thing that fills
 * `AgentSessionHandle.runner`.
 */
import type { AgentRunner } from '../types'
import type { OneShotCompletion } from './one-shot'

export interface RuntimeRegistration {
  /** The adapter behind this runtime (§9). */
  runner: AgentRunner
  /**
   * Optional tool-free, non-resumable, non-phase completion capability. Its
   * absence is a normal capability boundary, not a configuration error;
   * deterministic callers decide their own fail-safe fallback.
   */
  oneShot?: OneShotCompletion
  /**
   * Model-id PREFIXES this runtime can serve, e.g. `['openai/',
   * 'kimi-coding/']`. Prefix families — not an exhaustive id list — because the
   * model landscape moves faster than the pipeline and the spec forbids
   * hardcoding served ids: a new model from either provider validates without
   * editing this list. These families are validation data only: role resolution
   * never searches them to choose or substitute a runtime. `serves()` below is
   * the matcher.
   */
  servesModels: string[]
  /**
   * This runtime's own default model, used when a step selects the runtime but
   * names no model. When set, it must match `servesModels` like any other
   * resolved model. `undefined` ⇒ the adapter's un-named built-in default (e.g.
   * Claude's subscription default) — the path that preserves no-model behavior.
   */
  defaultModel?: string
}

/** name → registration. The one place a runtime's name lives (§9). */
export type RuntimeRegistry = Record<string, RuntimeRegistration>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Validate an untrusted plugin factory result at the composition boundary.
 * TypeScript's structural types disappear at runtime, so factories must not be
 * able to smuggle a partial adapter or inconsistent capability declaration
 * into the eager role resolver.
 */
export function validateRuntimeRegistration(
  value: unknown,
): RuntimeRegistration {
  if (!isObject(value)) {
    throw new Error('must be an object')
  }

  const runner = value.runner
  if (!isObject(runner)) {
    throw new Error('runner must be an AgentRunner-shaped object')
  }
  if (typeof runner.name !== 'string' || runner.name.trim().length === 0) {
    throw new Error('runner.name must be a nonblank string')
  }
  for (const method of ['start', 'continue', 'end'] as const) {
    if (typeof runner[method] !== 'function') {
      throw new Error(`runner.${method} must be a function`)
    }
  }

  const servesModels = value.servesModels
  if (
    !Array.isArray(servesModels) ||
    servesModels.some(
      (family) => typeof family !== 'string' || family.trim().length === 0,
    )
  ) {
    throw new Error('servesModels must be an array of nonblank strings')
  }

  const defaultModel = value.defaultModel
  if (
    defaultModel !== undefined &&
    (typeof defaultModel !== 'string' || defaultModel.trim().length === 0)
  ) {
    throw new Error('defaultModel must be a nonblank string when provided')
  }

  const oneShot = value.oneShot
  if (
    oneShot !== undefined &&
    (!isObject(oneShot) || typeof oneShot.complete !== 'function')
  ) {
    throw new Error('oneShot.complete must be a function when provided')
  }

  const registration = value as unknown as RuntimeRegistration
  if (defaultModel !== undefined && !serves(registration, defaultModel)) {
    throw new Error(
      `defaultModel "${defaultModel}" is not served by servesModels ` +
        `[${servesModels.join(', ')}]`,
    )
  }
  return registration
}

/**
 * Does this registration serve `model`? Prefix-family match:
 * `openai/gpt-5.6-sol` is served by a registration declaring `openai/`. Empty
 * `servesModels` serves nothing (a runtime that can run only with its adapter's
 * un-named built-in default, never with a configured model id).
 */
export function serves(reg: RuntimeRegistration, model: string): boolean {
  return reg.servesModels.some((prefix) => model.startsWith(prefix))
}
