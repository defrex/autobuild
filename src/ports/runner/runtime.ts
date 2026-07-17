/**
 * The runtime registry (SPEC §9): the "adapter registry" the spec says adding
 * a runtime should touch — and ONLY it. Each registration pairs an AgentRunner
 * adapter with its capabilities: model families/default for routing, plus an
 * optional pre-build one-shot completion. Keeping capabilities HERE, in a
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
   * Optional pre-build, non-resumable completion capability. Its absence is a
   * normal capability boundary, not a configuration error: deterministic
   * callers must fall back locally rather than failing dispatch.
   */
  oneShot?: OneShotCompletion
  /**
   * Model-id PREFIXES this runtime can serve, e.g. `['kimi-', 'gpt-']`. Prefix
   * families — not an exhaustive id list — because the model landscape moves
   * faster than the pipeline and the spec forbids hardcoding served ids: a new
   * `kimi-*`/`gpt-*` model routes here without editing this list. Keep families
   * NARROW so two runtimes don't both claim a family (that surfaces as the
   * resolver's "multiple non-default supporters" loud error, never a silent
   * mis-route). `serves()` below is the matcher.
   */
  servesModels: string[]
  /**
   * This runtime's own default model, used when a step selects the runtime but
   * names no model. `undefined` ⇒ the adapter's built-in default (e.g. Claude's
   * subscription default) — the path that preserves today's no-model behavior.
   */
  defaultModel?: string
}

/** name → registration. The one place a runtime's name lives (§9). */
export type RuntimeRegistry = Record<string, RuntimeRegistration>

/**
 * Does this registration serve `model`? Prefix-family match: `kimi-k3` is
 * served by a registration declaring `kimi-`. Empty `servesModels` serves
 * nothing (a runtime that only runs via an explicit `defaultModel`/built-in
 * default and never via model-only routing).
 */
export function serves(reg: RuntimeRegistration, model: string): boolean {
  return reg.servesModels.some((prefix) => model.startsWith(prefix))
}
