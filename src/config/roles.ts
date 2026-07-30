/**
 * Role-key consumability diagnostics (SPEC §9).
 *
 * `[roles]` is an open map, so a `[roles.<name>]` entry whose name nothing
 * consumes is accepted, eagerly resolved, validated — and then never looked up.
 * The session that was meant to run on it runs on `[roles.default]` instead.
 * This module is the pure derivation that lets `ab dispatch` say so at startup.
 * It never throws and never changes which runtime or model runs.
 *
 * TWO MECHANISMS, DELIBERATELY KEPT APART. No notice, comment, or document may
 * say a declared key "inherits default":
 *
 * - *Declaration.* `createRuntimeResolver` eagerly resolves EVERY declared role
 *   by merging its own fields over `default` independently per field
 *   (`src/ports/runner/routing.ts`). `[roles.ghost]` with its own runtime and
 *   model resolves to exactly that pair, and is validated — an unconsumed role
 *   naming an unregistered runtime still fails `ab dispatch` loudly. The
 *   warnings here neither suppress nor compete with that error.
 * - *Lookup.* `resolve(role, ...aliases)` returns the validated
 *   `[roles.default]` result when NO candidate key is declared. That wholesale
 *   fallback is what silently runs a verify step on the default model.
 *
 * The harm named here is the pair of the two: a key declared on one side and
 * never requested on the other.
 */
import { CORE_PHASES } from '../ontology'
import type { Config } from './schema'

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** `ab dispatch`'s pre-build title completion (src/cli/dispatch.ts). */
export const SLUG_ROLE = 'slug'
/** `ab upgrade`'s skill-conflict resolver (src/cli/upgrade-agent.ts). */
export const UPGRADE_ROLE = 'upgrade'
/** The harvest run's synthesize session (src/processes/harvest-runner.ts). */
export const HARVEST_ROLE = 'harvest'
/** The harvest run's review session (src/processes/harvest-runner.ts). */
export const HARVEST_REVIEW_ROLE = 'harvest-review'

/**
 * Roles the pipeline requests outside the configured phases and steps. These
 * are shared constants rather than bare string literals at their call sites so
 * a consumer and this diagnostic cannot drift apart — a consumable key missing
 * from here would become a false "unconsumed" warning, which is the same class
 * of bug this module exists to report.
 */
export const INTERNAL_ROLES = [SLUG_ROLE, UPGRADE_ROLE, HARVEST_ROLE, HARVEST_REVIEW_ROLE] as const

/** The reserved `[roles]` inheritance base (§9). Never reported unconsumed. */
export const RESERVED_ROLE = 'default'

// ── Derivation ───────────────────────────────────────────────────────────────

/** Every consumer a declared key has, of every kind. */
export interface RoleKeyConsumers {
  key: string
  /** The human phrase for this key's own canonical use, when it has one. */
  canonicalUse?: string
  /** Agent verify steps this key currently ROUTES through the deprecated
   * skill-name convention — the step declares no `[roles.<step>]` of its own. */
  activeAlias: string[]
  /** Agent verify steps whose configured skill is this key but which declare
   * their own step-named role, so the key is inert for them. */
  supersededAlias: string[]
}

export interface RoleKeyDiagnostics {
  /** The sorted canonical keys this configuration can consume. Deliberately
   * excludes deprecated aliases: the message must not teach the dying form. */
  valid: string[]
  /** Declared keys with no consumer of any kind, sorted. */
  unconsumed: string[]
  /** Declared keys a deprecated skill-name alias reaches, sorted by key —
   * both the still-routing and the superseded-and-inert cases. */
  deprecated: RoleKeyConsumers[]
}

/** The structural shape both `[verify.<step>]` and `[finalize.<step>]` share. */
type StepTable = { kind: 'check' } | { kind: 'agent'; skill: string }

/** Declared steps that actually run, in declaration order, agent kind only —
 * a `kind = "check"` step starts no session and consumes no role. */
function agentSteps(
  steps: readonly string[],
  stepConfigs: Record<string, StepTable>,
): { step: string; skill: string }[] {
  const agents: { step: string; skill: string }[] = []
  const seen = new Set<string>()
  for (const step of steps) {
    if (seen.has(step)) continue
    seen.add(step)
    // OWN property, for the same reason `declared` below is spelled out: step
    // names are user-chosen from an open set, so `constructor` and `toString`
    // are legal, and a bare read would answer an inherited function for a
    // listed-but-tableless step. Cross-validation rejects that config before it
    // can reach here, so this is redundant in practice — it keeps the read
    // sound on its own rather than on a guarantee made in another file.
    if (!Object.hasOwn(stepConfigs, step)) continue
    const table = stepConfigs[step]!
    if (table.kind !== 'agent') continue
    agents.push({ step, skill: table.skill })
  }
  return agents
}

/**
 * Classify every declared `[roles.<key>]` against every consumer it has.
 * Iterates `steps` rather than the `stepConfigs` key sets so only steps that
 * actually run contribute; cross-validation already guarantees the two agree.
 */
export function roleKeyDiagnostics(config: Config): RoleKeyDiagnostics {
  const verifyAgents = agentSteps(config.verify.steps, config.verify.stepConfigs)
  const finalizeAgents = agentSteps(config.finalize.steps, config.finalize.stepConfigs)

  // `default` is tested FIRST so the reserved phrase always wins, which is also
  // what keeps the rename/delete advice structurally unreachable for it.
  const canonicalUse = (key: string): string | undefined => {
    if (key === RESERVED_ROLE) return `the reserved [roles.${RESERVED_ROLE}] inheritance base`
    if ((CORE_PHASES as readonly string[]).includes(key)) return `the "${key}" core phase role`
    if (verifyAgents.some((agent) => agent.step === key)) return `agent verify step "${key}"`
    if (finalizeAgents.some((agent) => agent.step === key)) return `agent finalize step "${key}"`
    if ((INTERNAL_ROLES as readonly string[]).includes(key)) return `the internal "${key}" role`
    return undefined
  }

  // MUST mirror the resolver's candidate walk (src/ports/runner/routing.ts),
  // reserved arm included: a step named `default` always has its step-named
  // role declared, so its skill-name alias really is inert. The `||` arm is
  // redundant in practice — construction fails without `[roles.default]` — but
  // it keeps the two implementations of "declared" from drifting apart.
  const declared = (step: string): boolean =>
    step === RESERVED_ROLE || Object.hasOwn(config.roles, step)

  const valid = [
    ...new Set([
      RESERVED_ROLE,
      ...CORE_PHASES,
      ...verifyAgents.map((agent) => agent.step),
      ...finalizeAgents.map((agent) => agent.step),
      ...INTERNAL_ROLES,
    ]),
  ].sort()

  const unconsumed: string[] = []
  const deprecated: RoleKeyConsumers[] = []

  for (const key of Object.keys(config.roles).sort()) {
    const use = canonicalUse(key)
    // A step whose own name IS the key has no alias at all: the key is
    // canonical for it, and step-name precedence means it routes that way.
    const aliasFor = verifyAgents.filter((agent) => agent.skill === key && agent.step !== key)
    const activeAlias = aliasFor.filter((a) => !declared(a.step)).map((a) => a.step)
    const supersededAlias = aliasFor.filter((a) => declared(a.step)).map((a) => a.step)

    if (activeAlias.length > 0 || (supersededAlias.length > 0 && use === undefined)) {
      deprecated.push({
        key,
        ...(use !== undefined ? { canonicalUse: use } : {}),
        activeAlias,
        supersededAlias,
      })
      continue
    }
    // Fully consumed. An inert alias on an already-canonical key needs no
    // advice, and `canonicalUse(RESERVED_ROLE)` is what exempts the reserved
    // key from the unconsumed bucket — structurally, not by an early skip.
    if (use !== undefined) continue
    unconsumed.push(key)
  }

  return { valid, unconsumed, deprecated }
}

// ── Notices ──────────────────────────────────────────────────────────────────
//
// One string per key, so advice is never blanket, and every branch's advice is
// safe to follow literally — which means BOTH that following it converges (one
// edit, then silence) and that what it tells you to type is valid TOML. Two
// shape constraints: the key and its replacement land in the FIRST CLAUSE, so
// they are on the first rendered row at any realistic width; and the valid-key
// list is its own string, so it starts at column 0 of its own row instead of
// trailing a paragraph. House style is subject-first, `subject: predicate —
// detail`, with no `warning:` prefix.

function andList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

/** TOML bare keys are letters, digits, `-`, and `_` only. */
const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/

/**
 * A role or step name AS THE OPERATOR MUST TYPE IT.
 *
 * Role and step names are arbitrary nonempty strings, so interpolating one
 * bare is wrong twice over: `[roles.ab verify]` is a syntax error, and
 * `[roles.ui.visual]` is not the key at all — TOML reads the dot as nesting and
 * rejects it as an unknown field under `roles.ui`. Quoting only when needed
 * keeps every ordinary notice byte-identical. `JSON.stringify` emits exactly the
 * escapes a TOML basic string accepts (`\"`, `\\`, `\n`, `\uXXXX`, …).
 */
function tomlKey(name: string): string {
  return TOML_BARE_KEY.test(name) ? name : JSON.stringify(name)
}

/** The table header to write, quoted when the name needs it. */
const roleTable = (name: string): string => `[roles.${tomlKey(name)}]`

/** A step name in prose. Escaped, so an odd name cannot break out of its quotes. */
const named = (steps: readonly string[]): string =>
  andList(steps.map((step) => (TOML_BARE_KEY.test(step) ? `"${step}"` : JSON.stringify(step))))

const roleTables = (names: readonly string[]): string => andList(names.map(roleTable))

function deprecationNotice(entry: RoleKeyConsumers): string {
  const { key, canonicalUse, activeAlias, supersededAlias } = entry

  // A SUPERSEDED alias is not a consumer. It is inert by definition — the step
  // declares its own step-named role, which wins — so it can never be a reason
  // to keep this key, and it never blocks the rename. Counting it as one made
  // the advice non-converging: "keep it, it is also the superseded key for
  // e2e", followed on the next dispatch by "it can be deleted".

  // Inert: the key routes nothing at all.
  if (activeAlias.length === 0) {
    const subject =
      supersededAlias.length === 1
        ? `agent verify step ${named(supersededAlias)} declares its own step-named role`
        : `agent verify steps ${named(supersededAlias)} each declare their own step-named role`
    return (
      `autobuild.toml: ${roleTable(key)} can be deleted — ${subject}, so this ` +
      `deprecated skill-name key changes nothing.`
    )
  }

  // Safe rename: one step still routed and no OTHER consumer, so the key moves
  // in one edit. Superseded steps are deliberately not "other consumers".
  if (canonicalUse === undefined && activeAlias.length === 1) {
    return (
      `autobuild.toml: ${roleTable(key)} should be ${roleTable(activeAlias[0]!)} — it is the ` +
      `deprecated skill-name key for agent verify step ${named(activeAlias)} and stops ` +
      `working in a future release.`
    )
  }

  // Shared or colliding: the key routes several steps, or its name is itself
  // canonical, so the advice is to declare each step and then keep or delete.
  const routed =
    activeAlias.length === 1
      ? 'it routes that agent verify step through the deprecated skill-name key'
      : 'it routes those agent verify steps through the deprecated skill-name key'
  const advice =
    canonicalUse !== undefined
      ? `Keep ${roleTable(key)}: it is also ${canonicalUse}.`
      : `Delete ${roleTable(key)} once those are declared.`
  return `autobuild.toml: ${roleTable(key)} should be ${roleTables(activeAlias)} — ${routed}. ${advice}`
}

/**
 * The rendered notices — THE one message set. Empty for a clean configuration.
 *
 * Order: the unconsumed-keys line, then the valid-key line (only when there are
 * unconsumed keys), then one notice per deprecated key in key order. Every
 * surface renders these exact strings in full: nothing here or downstream may
 * cap, summarize, or truncate them, or a surface would report that a class of
 * problem exists without naming the keys the operator has to change.
 *
 * The unconsumed line deliberately stops at the harm and does not explain what
 * runs instead — that belongs in SPEC §9 and `docs/configuration.md`, and
 * putting it here pushed the required valid-key list past the right edge.
 */
export function roleKeyWarnings(config: Config): string[] {
  const { valid, unconsumed, deprecated } = roleKeyDiagnostics(config)
  const lines: string[] = []
  if (unconsumed.length > 0) {
    const keys = unconsumed.map(roleTable).join(', ')
    lines.push(
      unconsumed.length === 1
        ? `autobuild.toml: ${keys} is declared but nothing requests it — its runtime and model never reach a session.`
        : `autobuild.toml: ${keys} are declared but nothing requests them — their runtime and model never reach a session.`,
    )
    // Rendered as keys, not as prose names: this list is what the operator
    // types next, so a name needing quotes must show them here too.
    lines.push(`Valid role keys: ${valid.map(tomlKey).join(', ')}`)
  }
  for (const entry of deprecated) lines.push(deprecationNotice(entry))
  return lines
}
