/**
 * autobuild.toml schema (SPEC §16.1, D9): the one declarative per-repo config
 * file. Declarative, not executable — the kernel, dispatcher, CLI, and any
 * future tooling parse it without evaluating anything; commands are plain
 * shell strings.
 *
 * Strictness policy (§16.1): unknown top-level keys/tables and unknown keys
 * inside known tables are ERRORS — a typo must not silently disable a
 * verifier. Open maps ([commands], [roles], and the named [verify.<step>] and
 * [finalize.<step>] table sets) are exempt by construction: their keys are
 * user-chosen names, while every value remains strictly validated.
 */
import { z } from 'zod'
import { prImageHostSchema } from '../ontology'

// ── [pr] / [pr.imageHost] ────────────────────────────────────────────────────

/** Optional public GitHub release used for review-window image copies.
 * Omission is intentionally `undefined`: hosting is off by default. */
export const imageHostSchema = prImageHostSchema
export type ImageHostConfig = z.infer<typeof imageHostSchema>

export const prSchema = z.strictObject({
  imageHost: imageHostSchema.optional(),
})
export type PrConfig = z.infer<typeof prSchema>

// ── [workspace] ─────────────────────────────────────────────────────────────

/** Workspace selector. The host validates the selector envelope; the nested
 * config belongs to the selected plugin factory and is intentionally open. */
export const workspaceSchema = z.strictObject({
  provider: z
    .string()
    .refine(
      (value) => value.trim().length > 0,
      '[workspace].provider must be a nonblank provider name',
    )
    .default('git-worktree'),
  config: z.record(z.string(), z.unknown()).default({}),
})
export type WorkspaceConfig = z.infer<typeof workspaceSchema>

// ── [commands] ───────────────────────────────────────────────────────────────
//
// Open map of deterministic verbs the kernel may run. `setup`, `lint`,
// `typecheck`, `test` are conventions, not required keys (§16.1).

export const commandsSchema = z.record(z.string().min(1), z.string().min(1))
export type Commands = z.infer<typeof commandsSchema>

// ── [server] ─────────────────────────────────────────────────────────────────
//
// Optional table. Config declares; the kernel owns the lifecycle (§16.2).

export const serverSchema = z.strictObject({
  start: z.string().min(1),
  /** Readiness probe target: hit until success or `readyTimeout` (§16.2). */
  url: z.string().min(1),
  /** Seconds (§16.1). */
  readyTimeout: z.number().int().positive().default(60),
})
export type ServerConfig = z.infer<typeof serverSchema>

// ── [verify.<step>] ──────────────────────────────────────────────────────────

/**
 * The intentionally small path-selector grammar (§16.1): positive,
 * repository-relative globs with literal characters, `*`, `?`, and `**` only
 * as a complete path segment. Reject every ambiguous/unsafe form at config
 * load rather than allowing a typo to become a never-running safety gate.
 */
export function verifyPathGlobError(pattern: string): string | undefined {
  if (pattern.length === 0) return 'path selectors must be nonempty'
  if (pattern.includes('\0')) return 'path selectors must not contain NUL bytes'
  if (pattern.startsWith('/') || /^[A-Za-z]:\//.test(pattern)) {
    return 'path selectors must be repository-relative, not absolute'
  }
  if (pattern.includes('\\')) {
    return 'path selectors use Git-style "/" separators; backslashes and escapes are unsupported'
  }
  if (pattern.startsWith('!')) {
    return 'path selectors are positive globs; negation is unsupported'
  }
  if (/[\[\]{}]/.test(pattern)) {
    return 'path selectors support only literal characters, *, ?, and whole-segment **; character classes and brace expansion are unsupported'
  }
  if (/[?*+@!]\(/.test(pattern)) {
    return 'path selectors support only literal characters, *, ?, and whole-segment **; extglobs are unsupported'
  }

  const segments = pattern.split('/')
  if (segments.some((segment) => segment.length === 0)) {
    return 'path selectors must not contain empty path segments'
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return 'path selectors must not contain "." or ".." traversal segments'
  }
  if (segments.some((segment) => segment.includes('**') && segment !== '**')) {
    return 'the ** wildcard must occupy a complete path segment'
  }
  return undefined
}

export const verifyPathGlobSchema = z.string().superRefine((pattern, ctx) => {
  const message = verifyPathGlobError(pattern)
  if (message !== undefined) ctx.addIssue({ code: 'custom', message })
})

const verifyApplicabilityShape = {
  /** Any-match positive path selectors; absent means unconditional. */
  paths: z
    .array(verifyPathGlobSchema)
    .min(1, 'paths must contain at least one repository-relative glob')
    .optional(),
  /** Explicit mandatory-gate guard: true takes precedence over paths and a
   * plan may not deselect the step. */
  always: z.boolean().optional(),
}

export const verifyCheckStepSchema = z.strictObject({
  /** Deterministic: command + pass/fail (§16.1). */
  kind: z.literal('check'),
  /** Ref into [commands] — cross-validated below. */
  command: z.string().min(1),
  ...verifyApplicabilityShape,
})

export const verifyAgentStepSchema = z.strictObject({
  /** Agent-verify: skill + verdict schema (§16.1). */
  kind: z.literal('agent'),
  skill: z.string().min(1),
  /** true ⇒ the kernel starts the [server] before the session (§16.2). */
  needsServer: z.boolean().default(false),
  ...verifyApplicabilityShape,
})

export const verifyStepConfigSchema = z.discriminatedUnion('kind', [
  verifyCheckStepSchema,
  verifyAgentStepSchema,
])
export type VerifyStepConfig = z.infer<typeof verifyStepConfigSchema>

export interface VerifyConfig {
  /** Step order — each entry names a `verify:<step>` phase (§15.2.1). */
  steps: string[]
  /** The [verify.<step>] tables, keyed by step name. */
  stepConfigs: Record<string, VerifyStepConfig>
}

/**
 * [verify] mixes one known key (`steps`) with an open set of per-step
 * subtables, so it cannot be a strictObject; instead every non-`steps` key is
 * validated as a step table — nothing passes through loosely.
 */
export const verifySectionSchema = z
  .looseObject({
    steps: z.array(z.string().min(1)).default([]),
  })
  .transform(({ steps, ...stepTables }, ctx): VerifyConfig => {
    const stepConfigs: Record<string, VerifyStepConfig> = {}
    for (const [step, table] of Object.entries(stepTables)) {
      const parsed = verifyStepConfigSchema.safeParse(table)
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: 'custom',
            path: [step, ...issue.path],
            message: issue.message,
          })
        }
        continue
      }
      stepConfigs[step] = parsed.data
    }
    return { steps, stepConfigs }
  })

// ── [finalize.<step>] ────────────────────────────────────────────────────────

/** Finalize steps deliberately omit verify-only applicability/server fields. */
export const finalizeCheckStepSchema = z.strictObject({
  kind: z.literal('check'),
  /** Ref into [commands] — cross-validated below. */
  command: z.string().min(1),
})

export const finalizeAgentStepSchema = z.strictObject({
  kind: z.literal('agent'),
  /** Exact installed skill name passed to the configured runtime. */
  skill: z.string().min(1),
})

export const finalizeStepConfigSchema = z.discriminatedUnion('kind', [
  finalizeCheckStepSchema,
  finalizeAgentStepSchema,
])
export type FinalizeStepConfig = z.infer<typeof finalizeStepConfigSchema>

export interface FinalizeConfig {
  /** Ordered, failure-tolerant post-steps (§5). */
  steps: string[]
  /** The [finalize.<step>] tables, keyed by logical step name. */
  stepConfigs: Record<string, FinalizeStepConfig>
}

/** Like [verify], [finalize] mixes `steps` with a strict named table set. */
export const finalizeSectionSchema = z
  .looseObject({
    steps: z
      .array(z.string().min(1, 'finalize.steps entries must be nonempty step names'))
      .default([]),
  })
  .transform(({ steps, ...stepTables }, ctx): FinalizeConfig => {
    const stepConfigs: Record<string, FinalizeStepConfig> = {}
    for (const [step, table] of Object.entries(stepTables)) {
      const parsed = finalizeStepConfigSchema.safeParse(table)
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: 'custom',
            path: [step, ...issue.path],
            message: issue.message,
          })
        }
        continue
      }
      stepConfigs[step] = parsed.data
    }
    return { steps, stepConfigs }
  })

// ── [roles] ──────────────────────────────────────────────────────────────────
//
// Open map: role → fields on the runtime, model, and extensions axes (SPEC §9,
// §16.1). The reserved optional `default` entry is the raw inheritance base;
// every other role overrides it independently per field. Registry-dependent
// compatibility validation happens in the eager runtime resolver, because the
// config loader does not know the injected runtime registry.

export const roleSchema = z.strictObject({
  runtime: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  // Per-role extension allowlist (SPEC §9). Absent ⇒ inherit
  // [roles.default].extensions; absent there too ⇒ hermetic. A set list,
  // including [], replaces the default wholesale rather than unioning with it.
  extensions: z.array(z.string().min(1)).optional(),
})
export type RoleConfig = z.infer<typeof roleSchema>

// ── [policy] ─────────────────────────────────────────────────────────────────

export const policySchema = z.strictObject({
  /** Same-finding survival threshold before auto-escalate (§10, §15.4). */
  stallRounds: z.number().int().positive().default(3),
  maxVerifyAttempts: z.number().int().positive().default(3),
  maxReconcileAttempts: z.number().int().positive().default(3),
  /** converge's `maxRounds` for the review loops (SPEC §10). */
  maxReviewRounds: z.number().int().positive().default(4),
  /** Unclaimed observation occurrences required to start one harvest run. */
  harvestThreshold: z.number().int().positive().default(5),
})
export type PolicyConfig = z.infer<typeof policySchema>

// ── [tickets] ────────────────────────────────────────────────────────────────
//
// Which TicketSource the dispatcher drives and the source-vocabulary states
// that govern its lifecycle (§3.2, §3.3, §13). Declarative only: the Linear
// API key comes from the LINEAR_API_KEY environment variable, never from this
// file.

export const ticketsSchema = z.strictObject({
  /** Builtin or plugin-registered TicketSource name. Registry membership is
   * validated after configured plugins load. */
  source: z.string().refine(
    (value) => value.trim().length > 0,
    '[tickets].source must be a nonblank builtin or plugin ticket source name',
  ),
  /**
   * Ticket labels that additionally narrow the mandatory readyState gate
   * (§3.3). A nonempty list is conjunctive: every configured label must be
   * present. For readyLabels = ["autobuild", "ready"], a ticket carrying only
   * "autobuild" does not satisfy the label gate. An explicit [] disables the
   * label gate; absent uses the ticket source's default (linear: ["autobuild"];
   * file: none). Resolved by readyCriteria in src/processes/dispatcher.ts.
   */
  readyLabels: z.array(z.string().min(1)).optional(),
  /**
   * The single workflow state a ticket must sit in to be dispatchable — the
   * mandatory ready gate (§3.3). Required and non-blank: without it every
   * ticket from the source would be eligible in any state, including completed
   * ones (the AUT-10 mis-gating). Applied by readyCriteria on top of any label
   * gate. Linear matches exactly and case-sensitively; the file source
   * canonicalizes it to a state directory (`ready` → `ready/`).
   */
  readyState: z
    .string({
      error:
        '[tickets].readyState is required — name the one workflow state a ticket must sit in to be dispatched (e.g. "ready"). Omitting it would make every ticket from the source eligible, including completed ones.',
    })
    .refine(
      (s) => s.trim().length > 0,
      '[tickets].readyState must not be blank — name the one workflow state a ticket must sit in to be dispatched (e.g. "ready").',
    ),
  /** Linear team key (e.g. "ENG") — required when source = "linear". */
  teamKey: z.string().min(1).optional(),
  /** Workflow state claim() moves an issue to (§12); Linear only. */
  claimedState: z.string().min(1).optional(),
  /** State create() files new tickets into. Absent = the provider's default
   * (Linear: the team's default state, e.g. Backlog; file: Triage). */
  createState: z.string().min(1).optional(),
  /** State the dispatcher hands tickets back to for human triage — spec-gate
   * bounces (§6.3), aborted builds, closed-unmerged PRs. Absent = the
   * provider's default (Linear: Backlog; file: Triage) — resolved by
   * defaultTriageState in src/processes/dispatcher.ts. */
  triageState: z.string().min(1).optional(),
  /** Directory of state dirs (`triage/ ready/ doing/ done/`) holding `<id>.md`
   * ticket files; optional — defaults to `.autobuild/tickets`, resolved
   * relative to the repo. Kept schema-optional (not `.default()`) so the
   * linear-only cross-validation below stays meaningful and the factory can
   * still tell a defaulted dir from an explicit one. */
  dir: z.string().min(1).optional(),
})
export type TicketsConfig = z.infer<typeof ticketsSchema>

// ── Whole file ───────────────────────────────────────────────────────────────

const configRootSchema = z.strictObject({
  /** Base branch builds cut from and target (§16.1). */
  baseBranch: z.string().min(1).default('main'),
  /** Concurrent builds for this repository (§16.1). */
  capacity: z.number().int().positive().default(1),
  /** Forge adapter selected from builtins and configured plugins. */
  forge: z.string().refine(
    (value) => value.trim().length > 0,
    'forge adapter name must be nonblank',
  ).default('github'),
  /** Trusted in-process plugin modules, loaded in declaration order from the
   * consuming repository before production adapters are constructed. */
  plugins: z
    .array(
      z.string().refine(
        (value) => value.trim().length > 0,
        'plugin module specifiers must be nonblank',
      ),
    )
    .default([]),
  pr: prSchema.optional(),
  workspace: workspaceSchema.prefault({}),
  commands: commandsSchema.prefault({}),
  server: serverSchema.optional(),
  verify: verifySectionSchema.prefault({}),
  finalize: finalizeSectionSchema.prefault({}),
  // `default` is a reserved optional entry inside this open map (§9). An
  // absent [roles.default] is an empty base; the resolver then uses its wiring
  // fallback runtime and that runtime's own default model.
  roles: z.record(z.string().min(1), roleSchema).prefault({}),
  policy: policySchema.prefault({}),
  // An absent [tickets] table must NOT silently default past the mandatory
  // ready gate. Prefault feeds the file-source identity through ticketsSchema,
  // which deliberately fails on missing `readyState` at `tickets.readyState`.
  // The cast only satisfies prefault's input type; `{ source: 'file' }` is
  // intentionally invalid until the repository names its ready state.
  tickets: ticketsSchema.prefault({
    source: 'file',
  } as z.input<typeof ticketsSchema>),
})

/** Root metadata keeps strict error prose and documentation coverage honest. */
export const TOP_LEVEL_SCALARS = ['baseBranch', 'capacity', 'forge', 'plugins'] as const
export const TOP_LEVEL_TABLES = Object.keys(configRootSchema.shape).filter(
  (key) => !(TOP_LEVEL_SCALARS as readonly string[]).includes(key),
)
export const TOP_LEVEL_KEYS = Object.keys(configRootSchema.shape)

/**
 * Cross-validation (§16.1): errors carry the path and what would be accepted,
 * because validation failures are feedback to whoever edits the file (D6
 * discipline applied to config).
 */
export const configSchema = configRootSchema.superRefine((config, ctx) => {
  if (
    config.workspace.provider === 'git-worktree' &&
    Object.keys(config.workspace.config).length > 0
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['workspace', 'config'],
      message:
        '[workspace.config] is not supported by the builtin "git-worktree" provider — remove it or select a plugin workspace provider',
    })
  }

  const commandNames = Object.keys(config.commands)
  const knownCommands =
    commandNames.length > 0
      ? `known commands: ${commandNames.join(', ')}`
      : '[commands] has no entries'

  // A failed transformed subsection can be absent from Zod's partial object
  // while sibling issues are collected. Guard the cross-check so malformed
  // tables report validation feedback instead of throwing inside validation.
  if (config.verify?.stepConfigs !== undefined) {
    config.verify.steps.forEach((step, index) => {
      if (!Object.hasOwn(config.verify.stepConfigs, step)) {
        ctx.addIssue({
          code: 'custom',
          path: ['verify', 'steps', index],
          message:
            `verify step "${step}" is listed in verify.steps but has no [verify.${step}] table — ` +
            `add one with kind = "check" (command = <name in [commands]>) or kind = "agent" (skill = <skill name>)`,
        })
      }
    })

    const listed = new Set(config.verify.steps)
    for (const [step, stepConfig] of Object.entries(config.verify.stepConfigs)) {
      if (!listed.has(step)) {
        ctx.addIssue({
          code: 'custom',
          path: ['verify', step],
          message:
            `[verify.${step}] is defined but "${step}" is not listed in verify.steps — ` +
            `add "${step}" to verify.steps or remove the table`,
        })
      }
      if (stepConfig.kind === 'check' && !Object.hasOwn(config.commands, stepConfig.command)) {
        ctx.addIssue({
          code: 'custom',
          path: ['verify', step, 'command'],
          message:
            `[verify.${step}].command = "${stepConfig.command}" does not name a key in [commands] — ${knownCommands}`,
        })
      }
      if (stepConfig.kind === 'agent' && stepConfig.needsServer && config.server === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['verify', step, 'needsServer'],
          message:
            `[verify.${step}].needsServer = true requires a [server] table (start, url) — ` +
            `add [server] or set needsServer = false`,
        })
      }
    }
  }

  if (config.finalize?.stepConfigs !== undefined) {
    config.finalize.steps.forEach((step, index) => {
      if (!Object.hasOwn(config.finalize.stepConfigs, step)) {
        ctx.addIssue({
          code: 'custom',
          path: ['finalize', 'steps', index],
          message:
            `finalize step "${step}" is listed in finalize.steps but has no [finalize.${step}] table — ` +
            `add one with kind = "check" (command = <name in [commands]>) or kind = "agent" (skill = <skill name>)`,
        })
      }
    })

    const listedFinalize = new Set(config.finalize.steps)
    for (const [step, stepConfig] of Object.entries(config.finalize.stepConfigs)) {
      if (!listedFinalize.has(step)) {
        ctx.addIssue({
          code: 'custom',
          path: ['finalize', step],
          message:
            `[finalize.${step}] is defined but "${step}" is not listed in finalize.steps — ` +
            `add "${step}" to finalize.steps or remove the table`,
        })
      }
      if (stepConfig.kind === 'check' && !Object.hasOwn(config.commands, stepConfig.command)) {
        ctx.addIssue({
          code: 'custom',
          path: ['finalize', step, 'command'],
          message:
            `[finalize.${step}].command = "${stepConfig.command}" does not name a key in [commands] — ${knownCommands}`,
        })
      }
    }
  }

  const tickets = config.tickets
  if (tickets.source === 'linear') {
    if (tickets.teamKey === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['tickets', 'teamKey'],
        message:
          '[tickets].source = "linear" requires teamKey — the Linear team key (e.g. "ENG")',
      })
    }
    if (tickets.dir !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['tickets', 'dir'],
        message:
          '[tickets].dir applies only to source = "file" — remove it or set source = "file"',
      })
    }
  } else if (tickets.source === 'file') {
    // dir is optional for the file source: absent = .autobuild/tickets.
    for (const key of ['teamKey', 'claimedState'] as const) {
      if (tickets[key] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['tickets', key],
          message: `[tickets].${key} applies only to source = "linear" — remove it or set source = "linear"`,
        })
      }
    }
  }
  // Plugin sources receive the existing ticket lifecycle/configuration fields
  // unchanged; adapter-specific validation belongs to their factory.
})

export type Config = z.infer<typeof configSchema>
