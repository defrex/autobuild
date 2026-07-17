/**
 * autobuild.toml schema (SPEC §16.1, D9): the one declarative per-repo config
 * file. Declarative, not executable — the kernel, dispatcher, CLI, and any
 * future tooling parse it without evaluating anything; commands are plain
 * shell strings.
 *
 * Strictness policy (§16.1): unknown top-level tables and unknown keys inside
 * known tables are ERRORS — a typo must not silently disable a verifier. Open
 * maps ([commands], [roles], [outer], and the [verify.<step>] table set) are
 * exempt by construction: their keys are user-chosen names.
 */
import { z } from 'zod'

// ── [project] ────────────────────────────────────────────────────────────────

export const projectSchema = z.strictObject({
  baseBranch: z.string().min(1).default('main'),
})
export type ProjectConfig = z.infer<typeof projectSchema>

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

export const verifyCheckStepSchema = z.strictObject({
  /** Deterministic: command + pass/fail (§16.1). */
  kind: z.literal('check'),
  /** Ref into [commands] — cross-validated below. */
  command: z.string().min(1),
})

export const verifyAgentStepSchema = z.strictObject({
  /** Agent-verify: skill + verdict schema (§16.1). */
  kind: z.literal('agent'),
  skill: z.string().min(1),
  /** true ⇒ the kernel starts the [server] before the session (§16.2). */
  needsServer: z.boolean().default(false),
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

// ── [finalize] ───────────────────────────────────────────────────────────────

export const finalizeSchema = z.strictObject({
  /** Optional post-steps, failure-tolerant (§5). */
  steps: z
    .array(z.string().min(1, 'finalize.steps entries must be nonempty step names'))
    .default([]),
})
export type FinalizeConfig = z.infer<typeof finalizeSchema>

// ── [agent] ──────────────────────────────────────────────────────────────────
//
// The repo-wide DEFAULT pair on the two configuration axes (SPEC §9, §16.1):
// `runtime` (which adapter executes the session) and `model` (which model it
// runs on). Both optional, so all four override shapes are expressible here as
// well as per-role. Absent entirely ⇒ the built-in fallback runtime with its
// own default model, i.e. today's behavior is unchanged. Resolution against the
// runtime registry (capability checks, model-only routing) happens in the
// resolver, not here — config load never sees the registry.
export const agentDefaultsSchema = z.strictObject({
  runtime: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
})
export type AgentDefaultsConfig = z.infer<typeof agentDefaultsSchema>

// ── [roles] ──────────────────────────────────────────────────────────────────
//
// Open map: role → per-step OVERRIDE on the two axes (SPEC §9, §16.1). Both
// keys optional, so a step may pin `runtime`, `model`, both, or neither
// (neither ⇒ the [agent] default pair). Mixing models across roles is
// intentional — a different reviewer catches more.

export const roleSchema = z.strictObject({
  runtime: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
})
export type RoleConfig = z.infer<typeof roleSchema>

// ── [policy] ─────────────────────────────────────────────────────────────────

export const policySchema = z.strictObject({
  /** Same-finding survival threshold before auto-escalate (§10, §15.4). */
  stallRounds: z.number().int().positive().default(3),
  maxVerifyAttempts: z.number().int().positive().default(3),
  maxReconcileAttempts: z.number().int().positive().default(3),
  /**
   * converge's `maxRounds` for the review loops (SPEC §10). §16.1's example
   * leaves this knob implicit — §10 names it in the converge policy, so it
   * lives here; default 5.
   */
  maxReviewRounds: z.number().int().positive().default(5),
})
export type PolicyConfig = z.infer<typeof policySchema>

// ── [dispatcher] ─────────────────────────────────────────────────────────────

export const dispatcherSchema = z.strictObject({
  /** Concurrent builds for this repo (§16.1; global cap is OPEN — §18.4). */
  capacity: z.number().int().positive().default(1),
  /** Ticket labels that mark a ticket ready for dispatch (§3.3). Absent = the
   * ticket source's default gate (linear: ["autobuild"]; file: none — the
   * `ready/` directory is the gate). Resolved by readyCriteria in
   * src/processes/dispatcher.ts. */
  readyLabels: z.array(z.string().min(1)).optional(),
  /**
   * The single workflow state a ticket must sit in to be dispatchable — the
   * mandatory dispatch gate (§3.3). Required and non-blank: without it every
   * ticket from the source would be eligible in any state, including completed
   * ones (the AUT-10 mis-gating). Applied by readyCriteria in
   * src/processes/dispatcher.ts, on top of any label gate. Matched exactly and
   * case-sensitively by the Linear source (name your ready workflow state);
   * the file source canonicalizes it to a state directory (`ready` → `ready/`).
   */
  readyState: z
    .string({
      error:
        '[dispatcher].readyState is required — name the one workflow state a ticket must sit in to be dispatched (e.g. "ready"). Omitting it would make every ticket from the source eligible, including completed ones.',
    })
    .refine(
      (s) => s.trim().length > 0,
      '[dispatcher].readyState must not be blank — name the one workflow state a ticket must sit in to be dispatched (e.g. "ready").',
    ),
})
export type DispatcherConfig = z.infer<typeof dispatcherSchema>

// ── [tickets] ────────────────────────────────────────────────────────────────
//
// Which TicketSource the dispatcher drives (§3.2, §13). Omitting the table
// entirely gives the local file tracker at `.autobuild/tickets` — a repo
// dispatches with no config and no secret. Declarative only: the Linear API
// key comes from the LINEAR_API_KEY environment variable, never from this file.

export const ticketsSchema = z.strictObject({
  source: z.enum(['linear', 'file']),
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

// ── [outer] ──────────────────────────────────────────────────────────────────
//
// Open map: outer-loop process name → cron schedule (§16.1).

export const outerScheduleSchema = z.strictObject({
  cron: z.string().min(1),
})
export type OuterScheduleConfig = z.infer<typeof outerScheduleSchema>

// ── Whole file ───────────────────────────────────────────────────────────────

const configTableSchema = z.strictObject({
  project: projectSchema.prefault({}),
  commands: commandsSchema.prefault({}),
  server: serverSchema.optional(),
  verify: verifySectionSchema.prefault({}),
  finalize: finalizeSchema.prefault({}),
  // The repo-wide default pair (§9). Optional and NOT prefaulted — absence is
  // meaningful (⇒ built-in fallback runtime + its default model), and a
  // prefaulted `{}` would be indistinguishable from an explicit empty table.
  agent: agentDefaultsSchema.optional(),
  roles: z.record(z.string().min(1), roleSchema).prefault({}),
  policy: policySchema.prefault({}),
  // An absent [dispatcher] table must NOT silently default: prefault feeds `{}`
  // through the schema, which now fails on the missing required `readyState`
  // (AC 5 — a config with no ready state fails clearly, at path
  // `dispatcher.readyState`). The cast only satisfies prefault's input type,
  // whose `readyState` is required; at runtime `{}` is what flows through, and
  // it is meant to be rejected.
  dispatcher: dispatcherSchema.prefault({} as z.input<typeof dispatcherSchema>),
  // No [tickets] table ⇒ the local file tracker (§13). prefault feeds the
  // literal THROUGH ticketsSchema, so the default is a parsed TicketsConfig
  // and a present-but-partial table is untouched by it.
  tickets: ticketsSchema.prefault({ source: 'file' }),
  outer: z.record(z.string().min(1), outerScheduleSchema).prefault({}),
})

/** The known top-level tables — used to make unknown-table errors actionable. */
export const TOP_LEVEL_TABLES = Object.keys(configTableSchema.shape)

/**
 * Cross-validation (§16.1): errors carry the path and what would be accepted,
 * because validation failures are feedback to whoever edits the file (D6
 * discipline applied to config).
 */
export const configSchema = configTableSchema.superRefine((config, ctx) => {
  const commandNames = Object.keys(config.commands)
  const knownCommands =
    commandNames.length > 0
      ? `known commands: ${commandNames.join(', ')}`
      : '[commands] has no entries'

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
  } else {
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
})

export type Config = z.infer<typeof configSchema>
