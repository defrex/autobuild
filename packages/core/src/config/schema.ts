import { isSafeStepName } from '../context-directory'
/**
 * autobuild.toml schema (SPEC §16.1, D9): the one declarative per-repo config
 * file. Declarative, not executable — the kernel, dispatcher, CLI, and any
 * future tooling parse it without evaluating anything; commands are plain
 * shell strings.
 *
 * Strictness policy (§16.1): unknown top-level keys/tables and unknown keys
 * inside known tables are ERRORS — a typo must not silently disable a
 * verifier. Open maps ([commands], [roles], [workspace.config], and the named
 * [verify.<step>] and [finalize.<step>] table sets) are exempt by construction:
 * their keys are user-chosen names, while every value remains strictly
 * validated.
 */
import { z } from 'zod'
import { documentSchema, documentFields } from './reference-metadata'
import { landingRuleSchema } from './landing'
export { landingRuleSchema, type LandingRule } from './landing'
import { normalizeServiceURL } from '../connection'
import { prImageHostSchema } from '../ontology'
import { SANDBOX_FORBIDDEN_ENV } from '../ports/workspace/operator-sandbox'
import {
  runtimeProvisioningMap,
  runtimeProvisioningMissingMessage,
  sandboxForbiddenEnvMessage,
} from '../ports/workspace/provider-capabilities'
import { defineEntry, openMap, ownEntries, parseEntry } from '../open-map'
import { forwardIssues } from '../zod-issues'
import { effectiveRuntimeReferences } from './roles'

// ── Open maps ────────────────────────────────────────────────────────────────

//
// Every open map below is parsed through `../open-map`, which keeps a
// user-chosen key intact instead of losing it to the prototype chain: the
// perfectly valid TOML table `[roles."__proto__"]` would otherwise vanish while
// parsing SUCCEEDS — never eagerly resolved, never dispatchable, and invisible
// to the unconsumed-key warning that exists to catch exactly this class of dead
// configuration (§9). A silent drop is the one outcome the strictness policy
// above rules out.
//
// The TOML parser already hands us null-prototype tables with the key intact,
// and `openMap` keeps it that way end to end.
//
// `[workspace.config]` is the one open map here whose keys are PLUGIN-owned
// rather than Autobuild-owned, which makes faithful pass-through more important
// rather than less. Autobuild cannot validate a key it does not interpret, so a
// dropped one is undetectable downstream: the plugin sees an absent key and
// cannot tell an operator who omitted it from one who declared it, then reports
// its own error against a table that plainly contains it.

/**
 * A section mixing ONE known key (`steps`) with an open set of named step
 * tables — the same preservation contract as `openMap`.
 *
 * Without it a valid `[verify."__proto__"]` table vanished before
 * cross-validation, which then reported "is listed in verify.steps but has no
 * [verify.__proto__] table" about a table sitting right there in the file. Loud
 * rather than silent, but a diagnostic that contradicts the source is its own
 * defect: §16.1 errors are feedback to whoever edits the file.
 */
function stepSection<T, C, S = string[]>(
  label: string,
  stepsSchema: z.ZodType<S>,
  tableSchema: z.ZodType<T>,
  compose: (steps: S, stepConfigs: Record<string, T>, afterReconcile: boolean) => C,
  allowAfterReconcile = false,
) {
  const afterReconcileSchema = z.boolean().default(true)
  const schema = z
    .unknown()
    .transform((input, ctx): C => {
      const stepConfigs: Record<string, T> = Object.create(null)
      let steps = stepsSchema.parse(undefined)
      let afterReconcile = afterReconcileSchema.parse(undefined)
      for (const [key, raw] of ownEntries(input, label, ctx)) {
        if (key === 'afterReconcile' && allowAfterReconcile) {
          const parsed = afterReconcileSchema.safeParse(raw)
          if (parsed.success) afterReconcile = parsed.data
          else forwardIssues(parsed.error.issues, ctx, [key])
          continue
        }
        if (key === 'steps') {
          const parsed = stepsSchema.safeParse(raw)
          if (parsed.success) steps = parsed.data
          else forwardIssues(parsed.error.issues, ctx, ['steps'])
          continue
        }
        const table = parseEntry(tableSchema, raw, key, ctx)
        if (table.ok) defineEntry(stepConfigs, key, table.value)
      }
      return compose(steps, stepConfigs, afterReconcile)
    })
    .prefault({})
  documentSchema(stepsSchema, {
    ...(allowAfterReconcile
      ? {
          constraints:
            'Each name is nonempty; each grouped stage contains at least one nonempty name. Names must be unique within and across stages.',
        }
      : {}),
    description:
      (allowAfterReconcile
        ? 'Ordered verify stages: a name is a singleton stage; a nonempty array runs its members concurrently. Names must be unique within and across stages. '
        : 'Ordered names of the configured step tables. ') +
      'Names contain only ASCII letters, digits, ., _ and -, excluding "." and "..". Every listed step must have a table and every table must be listed.',
  })
  documentSchema(tableSchema, {
    description:
      'Named step. Select exactly one strict variant using kind; command belongs only to check, skill only to agent.',
  })
  documentSchema(afterReconcileSchema, {
    description:
      'Whether verification runs after reconciliation. A step override takes precedence.',
  })
  return documentSchema(schema, {
    structure: {
      kind: 'steps',
      steps: stepsSchema,
      table: tableSchema,
      ...(allowAfterReconcile ? { afterReconcile: afterReconcileSchema } : {}),
    },
  })
}

// ── [pr] / [pr.imageHost] ────────────────────────────────────────────────────

/** Optional public GitHub release used for review-window image copies.
 * Omission is intentionally `undefined`: hosting is off by default. */
export const imageHostSchema = prImageHostSchema

documentFields(imageHostSchema, {
  provider: 'Select the GitHub release adapter.',
  repository: 'Public repository containing the existing review release.',
  releaseId: 'Numeric id of an existing published, mutable release.',
})
export type ImageHostConfig = z.infer<typeof imageHostSchema>

export const prSchema = z.strictObject({
  imageHost: imageHostSchema.optional(),
})

documentFields(prSchema, {
  imageHost:
    'Copy attached images to a temporary public review location so they can render inline.',
})
export type PrConfig = z.infer<typeof prSchema>

// ── [workspace] ─────────────────────────────────────────────────────────────

const envNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a nonblank environment variable name')

/** Strict built-in Vercel configuration. Values are operational policy only;
 * credentials are referenced by variable name and never accepted as literals. */
const nonblankProvisioningString = (field: string) =>
  z.string().refine((value) => value.trim().length > 0, `${field} must be nonblank`)

export const vercelProvisioningStepSchema = z.strictObject({
  name: nonblankProvisioningString('provisioning step name'),
  command: nonblankProvisioningString('provisioning step command'),
})

documentFields(vercelProvisioningStepSchema, {
  name: 'Unique provisioning step name. Must contain a non-whitespace character.',
  command:
    'Shell command executed in declaration order during provisioning. Must contain a non-whitespace character.',
})
export type VercelProvisioningStep = z.infer<typeof vercelProvisioningStepSchema>

const vercelUniversalImageSchema = z
  .string()
  .refine(
    (image) =>
      /^vercel\/sandbox\/universal(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|@sha256:[0-9a-f]{64})?$/.test(
        image,
      ),
    'Autobuild Bun provisioning is validated only on the vercel/sandbox/universal managed image; use its bare name, a tag, or a sha256 digest containing exactly 64 lowercase hexadecimal characters',
  )

export const runtimeProvisioningEntrySchema = z.strictObject({
  install: z.string().refine((value) => value.trim().length > 0, 'install must be nonblank'),
  preflight: z.string().refine((value) => value.trim().length > 0, 'preflight must be nonblank'),
})

documentFields(runtimeProvisioningEntrySchema, {
  install: 'required nonblank shell command; use an immutable package version, digest, or commit',
  preflight: 'required nonblank shell command; verify the expected executable and exact version',
})
documentSchema(runtimeProvisioningEntrySchema, {
  description:
    'Installation and preflight commands for an effective runtime. Every effective role or alternate runtime must have an entry.',
})
export type RuntimeProvisioningEntry = z.infer<typeof runtimeProvisioningEntrySchema>

export const runtimeProvisioningSchema = openMap(
  '[workspace.config.runtimeProvisioning]',
  runtimeProvisioningEntrySchema,
  { keys: 'nonblank' },
)

export const vercelSandboxConfigSchema = z
  .strictObject({
    image: vercelUniversalImageSchema.default('vercel/sandbox/universal:latest'),
    vcpus: z.number().int().min(1).max(32).default(4),
    timeoutSeconds: z.number().int().min(60).max(86_400),
    /** Deadline for each provider acknowledgement; distinct from VM lifetime. */
    operationTimeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
    /** Billing safety net: snapshots created for this environment expire after
     * this duration instead of the provider's 30-day default. Absent means the
     * provider default. */
    snapshotExpirationSeconds: z.number().int().min(300).max(2_592_000).optional(),
    region: z.string().min(1).optional(),
    failoverRegions: z.array(z.string().min(1)).default([]),
    environmentVariables: z.array(envNameSchema).default([]),
    provisioning: z.array(vercelProvisioningStepSchema).default([]),
    runtimeProvisioning: runtimeProvisioningSchema,
    gitUsernameEnv: envNameSchema.optional(),
    gitPasswordEnv: envNameSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const unique = (entries: readonly string[], path: string) => {
      const seen = new Set<string>()
      entries.forEach((entry, index) => {
        if (seen.has(entry))
          ctx.addIssue({
            code: 'custom',
            path: [path, index],
            message: `duplicate environment variable ${JSON.stringify(entry)}`,
          })
        seen.add(entry)
      })
    }
    unique(value.environmentVariables, 'environmentVariables')
    unique(value.failoverRegions, 'failoverRegions')
    const provisioningNames = new Map<string, number>()
    value.provisioning.forEach((step, index) => {
      const first = provisioningNames.get(step.name)
      if (first !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['provisioning', index, 'name'],
          message: `duplicate provisioning step name ${JSON.stringify(step.name)} — first declared at provisioning[${first}].name`,
        })
      } else {
        provisioningNames.set(step.name, index)
      }
    })
    if (value.region !== undefined && value.failoverRegions.includes(value.region)) {
      ctx.addIssue({
        code: 'custom',
        path: ['failoverRegions'],
        message: 'failover regions must not include the primary region',
      })
    }
    if ((value.gitUsernameEnv === undefined) !== (value.gitPasswordEnv === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['gitPasswordEnv'],
        message: 'gitUsernameEnv and gitPasswordEnv must be configured together',
      })
    }
    for (const [key, name] of [
      ['gitUsernameEnv', value.gitUsernameEnv],
      ['gitPasswordEnv', value.gitPasswordEnv],
    ] as const) {
      if (name !== undefined && value.environmentVariables.includes(name)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message:
            'private repository clone credentials must not be exposed as runtime environment variables',
        })
      }
      if (
        name !== undefined &&
        /^(?:GITHUB_TOKEN|GH_TOKEN|VERCEL_(?:TOKEN|OIDC_TOKEN|TEAM_ID|PROJECT_ID))$/.test(name)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message:
            'private repository read credentials must be separate from Forge and Vercel credentials',
        })
      }
    }
  })

documentFields(vercelSandboxConfigSchema, {
  image: 'Managed image used to provision the workspace.',
  vcpus:
    'Virtual CPUs allocated to each workspace; provider account limits may further restrict allocation.',
  timeoutSeconds:
    'VM/session lifetime in seconds and abrupt-orphan bound. Provider plan limits also apply.',
  operationTimeoutMs:
    'Deadline in milliseconds for each provider acknowledgement, independent of session lifetime.',
  snapshotExpirationSeconds:
    'Snapshot expiration in seconds. Omission uses the provider expiration policy.',
  region: 'Primary region; omission uses the provider region selection.',
  failoverRegions:
    'Ordered alternative regions used if the primary region cannot provision a workspace.',
  environmentVariables:
    'unique API-credential variable names copied into runtime and agent/check commands',
  provisioning:
    'ordered strict inline tables `{ name, command }`; names and commands are nonblank and names are unique',
  runtimeProvisioning:
    'open map keyed by every effective role/alternate runtime; each entry requires `install` and `preflight`',
  gitUsernameEnv:
    'optional variable name for the dedicated read-only clone username; requires `gitPasswordEnv`',
  gitPasswordEnv:
    'optional variable name for the dedicated read-only clone password; requires `gitUsernameEnv`',
})
documentSchema(vercelSandboxConfigSchema, {
  description: 'Strict Vercel workspace provisioning configuration.',
  constraints:
    'Environment variable and failover region lists must be unique. Failovers exclude the primary region. Provisioning names must be unique. Clone credential names must be configured together, excluded from runtime environmentVariables, and separate from Forge and Vercel credentials.',
})
type NormalizedVercelSandboxConfig = z.infer<typeof vercelSandboxConfigSchema>
/** Direct provider construction remains source-compatible; schema-parsed
 * production config always materializes operationTimeoutMs. */
export type VercelSandboxConfig = Omit<
  NormalizedVercelSandboxConfig,
  'operationTimeoutMs' | 'provisioning' | 'runtimeProvisioning'
> & {
  operationTimeoutMs?: number
  /** Optional only for source compatibility with direct adapter construction;
   * schema-loaded repository configuration always materializes this list. */
  provisioning?: VercelProvisioningStep[]
  /** Optional only for source compatibility in direct adapter construction;
   * parsed production configuration always materializes this map. */
  runtimeProvisioning?: NormalizedVercelSandboxConfig['runtimeProvisioning']
}

/** Workspace selector. The host validates the selector envelope; plugin nested
 * config remains open, while built-in config is validated by configSchema. */
export const workspaceSchema = z.strictObject({
  provider: z
    .string()
    .refine(
      (value) => value.trim().length > 0,
      '[workspace].provider must be a nonblank provider name',
    )
    .default('git-worktree'),
  config: openMap(
    '[workspace.config]',
    documentSchema(z.unknown(), {
      description:
        'Plugin-owned value passed through unchanged. Builtin providers validate their own declared schema.',
    }),
    { keys: 'any' },
  ),
})

documentFields(workspaceSchema, {
  provider:
    'Select the provider used for provisioning, recovery, PR epilogue working-directory calls, and release.',
  config:
    'Adapter-specific declarative configuration passed unchanged to the selected plugin factory.',
})
export type WorkspaceConfig = z.infer<typeof workspaceSchema>

/**
 * The parse-time subset of workspace-provider behavior a builtin declares
 * (AUT-516). This table lives in `config/schema.ts` because the
 * `[workspace.config]` validation runs inside `configSchema`'s
 * `superRefine` — at parse time, long before plugins load, in processes that
 * never touch the registry. The full capability objects (including the
 * registry-seam declarations) are assembled in
 * `ports/workspace/builtin-capabilities.ts`, which takes this subset from
 * here — a parity now enforced by
 * `ports/workspace/builtin-capabilities.test.ts` (AUT-573), so a builtin
 * added to only one table fails tests rather than compiling silently. The
 * construction-site refusal text differs by design from the
 * parse-site one, so it is NOT copied from this table.
 */
export interface WorkspaceProviderConfigDeclaration {
  /** Strict schema applied to `[workspace.config]`. A builtin declaration
   * carries EXACTLY ONE of `configSchema` / `configRefusalMessage`: when the
   * schema is absent, the declaration must carry `configRefusalMessage` for
   * nonempty provider config to be refused (the neither-key side is pinned by
   * the AUT-565 test in config.test.ts), and carrying BOTH is forbidden —
   * `configSchema`'s superRefine checks `configRefusalMessage` first, so the
   * refusal branch would win and the schema would silently never apply (the
   * both-keys side is pinned by its sibling test). Providers absent from
   * `BUILTIN_WORKSPACE_PROVIDER_CONFIG` are plugin-owned pass-throughs and
   * are never refused here. */
  configSchema?: z.ZodType
  /** Parse-site refusal text for a provider that rejects `[workspace.config]`
   * outright. This is the sole parse-site refusal key: a declaration without
   * it never refuses `[workspace.config]` here, with or without a schema.
   * Distinct from the capability's construction-site `configRefusal`. */
  configRefusalMessage?: string
  /** Referenced runtimes must have `[workspace.config.runtimeProvisioning]`
   * entries (checked only once roles, verify, and finalize are all present). */
  requireRuntimeProvisioning?: boolean
  /** Names added to the operator-sandbox forbidden-forwarding set beyond
   * `SANDBOX_FORBIDDEN_ENV`. */
  sandboxForbiddenEnv?: readonly string[]
}

/** Parse-time behavior of every builtin workspace provider, keyed by the
 * provider name an operator writes in `[workspace].provider`. No provider
 * name appears in any validation branch — every check reads this table. */
export const BUILTIN_WORKSPACE_PROVIDER_CONFIG: ReadonlyMap<
  string,
  WorkspaceProviderConfigDeclaration
> = new Map([
  [
    'git-worktree',
    {
      configRefusalMessage:
        '[workspace.config] is not supported by the builtin "git-worktree" provider — remove it or select a plugin workspace provider',
    },
  ],
  [
    'vercel-sandbox',
    {
      configSchema: vercelSandboxConfigSchema,
      requireRuntimeProvisioning: true,
      // Its credentials are already in SANDBOX_FORBIDDEN_ENV.
      sandboxForbiddenEnv: [],
    },
  ],
])

// ── [commands] ───────────────────────────────────────────────────────────────
//
// Open map of deterministic verbs the kernel may run. `setup`, `lint`,
// `typecheck`, `test` are conventions, not required keys (§16.1).

export const commandsSchema = openMap(
  '[commands]',
  documentSchema(z.string().min(1), { description: 'Named deterministic shell command.' }),
)
export type Commands = z.infer<typeof commandsSchema>

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
  if (/[[\]{}]/.test(pattern)) {
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

documentSchema(verifyPathGlobSchema, {
  constraints:
    'Positive repository-relative globs with literal characters, *, ?, and whole-segment ** only. No NUL, absolute paths, backslashes, negation, empty or traversal segments, character classes, brace expansion or extglobs.',
})

const verifyApplicabilityShape = {
  /** Absence preserves historical serialized configuration identity. */
  failFast: documentSchema(z.boolean().optional(), { default: 'false (omission is preserved)' }),
  afterReconcile: z.boolean().optional(),
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

documentFields(verifyCheckStepSchema, {
  kind: 'Select the strict step variant. Fields from another variant are rejected.',
  command:
    'Name of an existing command in [commands]; required for check steps and forbidden for agent steps.',
  afterReconcile:
    'Step override wins over `[verify].afterReconcile`; false skips this step after reconciliation only.',
  failFast: 'Cancel unfinished members of this stage when this step fails. Defaults to false.',
  paths: 'Apply only when at least one changed path matches. Available to both variants.',
  always:
    '`true` makes the step mandatory in plan selection and bypasses path gating. Available to both variants.',
})

export const verifyAgentStepSchema = z.strictObject({
  /** Agent-verify: skill + verdict schema (§16.1). */
  kind: z.literal('agent'),
  skill: z.string().min(1),
  ...verifyApplicabilityShape,
})

documentFields(verifyAgentStepSchema, {
  kind: 'Select the strict step variant. Fields from another variant are rejected.',
  skill: 'Exact installed skill name; required for agent steps and forbidden for check steps.',
  afterReconcile:
    'Step override wins over `[verify].afterReconcile`; false skips this step after reconciliation only.',
  failFast: 'Cancel unfinished members of this stage when this step fails. Defaults to false.',
  paths: 'Apply only when at least one changed path matches. Available to both variants.',
  always:
    '`true` makes the step mandatory in plan selection and bypasses path gating. Available to both variants.',
})

export const verifyStepConfigSchema = z.discriminatedUnion('kind', [
  verifyCheckStepSchema,
  verifyAgentStepSchema,
])
export type VerifyStepConfig = z.infer<typeof verifyStepConfigSchema>

export interface VerifyConfig {
  afterReconcile: boolean
  /** Step order — each entry names a `verify:<step>` phase (§15.2.1). */
  steps: string[]
  /** Present only when the source contains grouped entries. */
  stages?: string[][]
  /** The [verify.<step>] tables, keyed by step name. */
  stepConfigs: Record<string, VerifyStepConfig>
}

/**
 * [verify] mixes known scalars (`steps`, `afterReconcile`) with per-step
 * subtables, so it cannot be a strictObject; every other key is
 * validated as a step table — nothing passes through loosely, and no step name
 * is lost to the prototype chain (see `stepSection`).
 */
export const verifySectionSchema = stepSection(
  '[verify]',
  z
    .array(
      z.union([
        z.string().min(1),
        z.array(z.string().min(1)).min(1, 'verify stage must not be empty'),
      ]),
    )
    .default([]),
  verifyStepConfigSchema,
  (entries, stepConfigs, afterReconcile): VerifyConfig => ({
    steps: entries.flat(),
    stepConfigs,
    afterReconcile,
    ...(entries.some(Array.isArray)
      ? { stages: entries.map((entry) => (typeof entry === 'string' ? [entry] : entry)) }
      : {}),
  }),
  true,
)

/** Historical configurations have singleton stages without additional metadata. */
export function verifyStages(config: VerifyConfig): readonly (readonly string[])[] {
  return config.stages ?? config.steps.map((step) => [step])
}

// ── [finalize.<step>] ────────────────────────────────────────────────────────

/** Finalize steps deliberately omit verify-only applicability fields. */
export const finalizeCheckStepSchema = z.strictObject({
  kind: z.literal('check'),
  /** Ref into [commands] — cross-validated below. */
  command: z.string().min(1),
})

documentFields(finalizeCheckStepSchema, {
  kind: 'Select the strict step variant. Fields from another variant are rejected.',
  command:
    'Name of an existing command in [commands]; required for check steps and forbidden for agent steps.',
})

export const finalizeAgentStepSchema = z.strictObject({
  kind: z.literal('agent'),
  /** Exact installed skill name passed to the configured runtime. */
  skill: z.string().min(1),
})

documentFields(finalizeAgentStepSchema, {
  kind: 'Select the strict step variant. Fields from another variant are rejected.',
  skill: 'Exact installed skill name; required for agent steps and forbidden for check steps.',
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
export const finalizeSectionSchema = stepSection(
  '[finalize]',
  z.array(z.string().min(1, 'finalize.steps entries must be nonempty step names')).default([]),
  finalizeStepConfigSchema,
  (steps, stepConfigs): FinalizeConfig => ({ steps, stepConfigs }),
)

// ── [roles] ──────────────────────────────────────────────────────────────────
//
// Open map: role → fields on the runtime, model, and args axes (SPEC §9,
// §16.1). The reserved `default` entry is the raw inheritance base and must
// name a runtime; registry-aware enforcement lives in the eager resolver;
// every other role overrides it independently per field. Registry-dependent
// compatibility validation happens in the eager runtime resolver, because the
// config loader does not know the injected runtime registry.

const roleArgsSchema = z.array(z.string().min(1))

const runtimeAxesSchema = z.strictObject({
  runtime: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  args: roleArgsSchema.optional(),
  // Deprecated compatibility field. It remains schema-valid but is a warning-only no-op.
  extensions: z.array(z.string().min(1)).optional(),
})

documentFields(runtimeAxesSchema, {
  runtime: 'Select an agent adapter.',
  model: 'Select the exact model. Codex uses unqualified `gpt-*`; Pi ids are provider-qualified.',
  args: 'Ordered extra CLI argv tokens applied to every phase and tool-free one-shot invocation. A supplied list replaces, rather than unions with, the inherited list.',
  extensions:
    'Compatibility-only field. Dispatch warns for each declaring role; migrate explicit runtime options to `args`.',
})

export const roleSchema = runtimeAxesSchema.extend({
  // Wall-clock budget for each session dispatched through this logical role.
  // Absent ⇒ inherit [roles.default], then [policy].sessionBudgetSeconds.
  // Alternates deliberately use runtimeAxesSchema: one logical role owns one
  // budget regardless of which provider target executes the attempt.
  sessionBudgetSeconds: z.number().int().positive().optional(),
  // Extra CLI arguments. Absent ⇒ inherit [roles.default].args; a declared
  // list, including [], replaces the default wholesale rather than unioning.
  args: roleArgsSchema.optional(),
  // Deprecated compatibility field. It is accepted only so dispatch can emit
  // a migration diagnostic; it has no effect on runtime resolution.
  extensions: z.array(z.string().min(1)).optional(),
  // Ordered failure-triggered execution targets. Absent ⇒ inherit the base
  // list; a declared list (including []) replaces it wholesale. Each strict
  // entry overlays the concrete role's resolved primary axes.
  alternates: z.array(runtimeAxesSchema).optional(),
})

documentFields(roleSchema, {
  runtime: 'Select an agent adapter.',
  model: 'Select the exact model. Codex uses unqualified `gpt-*`; Pi ids are provider-qualified.',
  args: 'Ordered extra CLI argv tokens applied to every phase and tool-free one-shot invocation. A supplied list replaces, rather than unions with, the inherited list.',
  extensions:
    'Compatibility-only field. Dispatch warns for each declaring role; migrate explicit runtime options to `args`.',
  sessionBudgetSeconds:
    'Active-time budget for each build phase session routed through this logical role. Suspended intervals are excluded; native continuation retains the original ceiling and accumulated active time. One budget covers the primary and every alternate target.',
  alternates:
    "Failure-triggered execution targets (provider failures and a runtime whose CLI is not installed). A role's list replaces the inherited list wholesale; each entry overlays that role's effective primary axes. `extensions` is accepted there only as the same deprecated no-op.",
})
documentSchema(roleSchema, {
  description:
    'Named role inheriting each omitted axis from roles.default. The default role must name a registered runtime.',
})
documentSchema(roleSchema.shape.runtime, {
  constraints:
    'Required on roles.default by runtime resolution; other roles inherit it. Must name a registered runtime.',
})
documentSchema(roleSchema.shape.model, {
  constraints:
    'Omission inherits the base model, otherwise uses the selected runtime default. Must be compatible with that runtime.',
})
documentSchema(roleSchema.shape.args, {
  constraints:
    'Omission inherits the base list, otherwise resolves to an empty list; an explicit list replaces it.',
})
documentSchema(roleSchema.shape.sessionBudgetSeconds, {
  constraints:
    'Omission inherits roles.default.sessionBudgetSeconds, otherwise policy.sessionBudgetSeconds.',
})
documentSchema(roleSchema.shape.alternates, {
  constraints:
    'Omission inherits the base alternate list, otherwise resolves to an empty list; each alternate overlays the resolved primary axes.',
})
export type RoleConfig = z.infer<typeof roleSchema>

// ── [policy] ─────────────────────────────────────────────────────────────────

export const policySchema = z.strictObject({
  upgradeDrainSeconds: z.number().int().positive().default(900),
  /** Wall-clock bound for an agent phase session; roles may override it. */
  sessionBudgetSeconds: z.number().int().positive().default(3600),
  /** Same-finding survival threshold before auto-escalate (§10, §15.4). */
  stallRounds: z.number().int().positive().default(3),
  maxVerifyAttempts: z.number().int().positive().default(3),
  /** Consecutive dispatch failures before human intervention is required. */
  maxDispatchAttempts: z.number().int().positive().default(3),
  /** Consecutive workspace setup failures before human intervention is required. */
  maxSetupAttempts: z.number().int().positive().default(3),
  /** Consecutive provider lifecycle failures before recovery requires a human retry. */
  maxInfrastructureAttempts: z.number().int().positive().default(3),
  maxReconcileAttempts: z.number().int().positive().default(3),
  /** converge's `maxRounds` for the review loops (SPEC §10). */
  maxReviewRounds: z.number().int().positive().default(6),
  /** Unclaimed observation occurrences required to start one harvest run. */
  harvestThreshold: z.number().int().positive().default(5),
  /** Merged builds after the oldest observation that start harvest; zero disables drift. */
  janitorFailureAttentionSeconds: z.number().int().positive().default(600),
  nodeIdleAfterSeconds: z.number().int().positive().default(600),
  nodeIdlePollSeconds: z.number().int().positive().default(120),
  janitorBackoffMaxSeconds: z.number().int().positive().default(300),
  harvestMaxDrift: z.number().int().nonnegative().default(3),
})

documentFields(policySchema, {
  upgradeDrainSeconds:
    'Deadline for a retiring generation, relative to handoff start; hot-reloaded during drain.',
  sessionBudgetSeconds:
    'Active-time bound for each build agent session unless its logical role overrides it. Native continuation retains the original ceiling; suspension does not consume it.',
  stallRounds: 'Escalate when the same review finding survives this many rounds.',
  maxVerifyAttempts: 'Bound failure-driven verify \u2192 implement retry cycles.',
  maxDispatchAttempts: 'Bound consecutive dispatch failures before human escalation.',
  maxSetupAttempts: 'Bound consecutive workspace setup failures before human escalation.',
  maxInfrastructureAttempts:
    'Bound consecutive provision/start/wait/cleanup failures before a setup-targeted policy escalation; a human `retry` answer re-arms this budget.',
  maxReconcileAttempts:
    'Bound completed reconciles that leave the PR conflicted against an unchanged authoritative base. Moving-base races do not consume the bound.',
  maxReviewRounds:
    'Default bound for each plan/review and implement/review convergence loop. Your agent may replace it for one parked build loop and current spec revision with `ab answer --review-round-ceiling`; other builds are unaffected.',
  harvestThreshold: 'New unclaimed observation occurrences needed to start one harvest run.',
  janitorFailureAttentionSeconds: 'Consecutive janitor failure duration before build attention.',
  nodeIdleAfterSeconds: 'Quiet period before opened integration nodes enter idle polling.',
  nodeIdlePollSeconds: 'Interval between idle node checks; durable activity wakes the next tick.',
  janitorBackoffMaxSeconds: 'Cap on exponential janitor retry delay, starting at 30 seconds.',
  harvestMaxDrift:
    'Other builds merged after the oldest unclaimed observation needed to start a run; `0` disables drift.',
})
export type PolicyConfig = z.infer<typeof policySchema>

// ── [tickets] ────────────────────────────────────────────────────────────────
//
// Which TicketSource the dispatcher drives and the source-vocabulary states
// that govern its lifecycle (§3.2, §3.3, §13). Declarative only: the Linear
// API key comes from the LINEAR_API_KEY environment variable, never from this
// file.

export const ticketsInputSchema = z.strictObject({
  url: z.string().optional(),
  /** Builtin or plugin-registered TicketSource name. Registry membership is
   * validated after configured plugins load. */
  source: z
    .string()
    .refine(
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
    )
    .optional(),
  /**
   * Narrows readiness to tickets assigned to one Linear user — a third
   * conjunctive gate beside readyState and readyLabels. `"me"` is the owner of
   * the dispatcher's LINEAR_API_KEY; an email names a specific user (for a
   * shared or bot key). Unassigned tickets are never ready while it is set.
   * Linear only; absent leaves readiness unchanged.
   */
  readyAssignee: z
    .string()
    .refine(
      (s) => s === 'me' || (s === s.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)),
      '[tickets].readyAssignee must be "me" (the owner of the API key) or a user email address (e.g. "person@example.com")',
    )
    .optional(),
  /** Backend team key (e.g. "ENG") — required for linear and hosted. */
  teamKey: z.string().min(1).optional(),
  /** Workflow state claim() moves an issue to (§12); Linear and hosted. */
  claimedState: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, 'state must be nonblank')
    .optional(),
  /** Hosted project completion state; defaults to done. */
  doneState: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, 'state must be nonblank')
    .optional(),
  /** State create() files new tickets into. Absent = the provider's default
   * (Linear: the team's default state, e.g. Backlog; file: Triage). */
  createState: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, 'state must be nonblank')
    .optional(),
  /** State the dispatcher hands tickets back to for human triage — spec-gate
   * bounces (§6.3), aborted builds, closed-unmerged PRs. Absent = the
   * provider's default (Linear: Backlog; file: Triage) — resolved by
   * defaultTriageState in src/processes/dispatcher.ts. */
  triageState: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, 'state must be nonblank')
    .optional(),
  /** State harvest files its synthesized proposals into (§12). Absent = the
   * triage state, which keeps the constitutional grooming gate: a proposal
   * waits for a human before it can be dispatched. Setting it to readyState
   * waives that gate for this repository — proposals dispatch unread — and is
   * the only supported way to do so. Separate from triageState so the waiver
   * does not also redirect spec-gate bounces, aborts, and closed-unmerged PRs
   * into the ready state, where a bounce would re-dispatch itself. Resolved by
   * defaultProposalState in src/processes/dispatcher.ts. */
  proposalState: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, 'state must be nonblank')
    .optional(),
  /** Directory of state dirs (`triage/ ready/ doing/ done/`) holding `<id>.md`
   * ticket files; optional — defaults to `.autobuild/tickets`, resolved
   * relative to the repo. Kept schema-optional (not `.default()`) so the
   * linear-only cross-validation below stays meaningful and the factory can
   * still tell a defaulted dir from an explicit one. */
  dir: z.string().min(1).optional(),
})

documentFields(ticketsInputSchema, {
  url: 'Ticket service independent of [store] url and AB_STORE. Required with local builds.',
  source: 'Select the ticket adapter after configured plugins load.',
  readyLabels: 'Require every listed label in addition to the state gate.',
  readyState: 'The one workflow state eligible for dispatch.',
  readyAssignee:
    'Require the ticket to be assigned to one Linear user, in addition to the state and label gates.',
  teamKey: 'Backend team key such as `"ENG"`, or an existing plugin config field.',
  claimedState: 'Workflow state entered when a ticket is claimed.',
  doneState: 'Project completion state and merged-ticket transition.',
  createState: 'Default state for newly created tickets when `ab ticket create` omits `--state`.',
  triageState: 'State used for spec-gate bounces, aborts, and closed-unmerged PRs.',
  proposalState:
    'State harvest files its synthesized proposals into. Setting it to `readyState` waives the human grooming gate, not dependency eligibility.',
  dir: 'Root containing file-source state directories, or an existing plugin config field. Relative file paths resolve from the repository.',
})
documentSchema(ticketsInputSchema, {
  constraints:
    'readyState is required except for hosted, which resolves omission to ready. url is forbidden for file and linear; hosted URLs are normalized service URLs.',
})
documentSchema(ticketsInputSchema.shape.readyState, {
  required: 'Required unless source = "hosted"; hosted omission resolves to "ready".',
})
documentSchema(ticketsInputSchema.shape.teamKey, {
  required: 'Required for linear and hosted; forbidden for file; optional for plugins.',
})
documentSchema(ticketsInputSchema.shape.claimedState, { constraints: 'Forbidden for file.' })
documentSchema(ticketsInputSchema.shape.dir, { constraints: 'Forbidden for linear and hosted.' })
documentSchema(ticketsInputSchema.shape.readyAssignee, { constraints: 'Allowed only for linear.' })
documentSchema(ticketsInputSchema.shape.readyLabels, {
  constraints:
    'Omission uses source readiness defaults (Linear: autobuild label; file: none). Explicit [] disables label gating.',
})
documentSchema(ticketsInputSchema.shape.url, {
  constraints:
    'Forbidden for file and linear. Hosted omission uses the selected remote BuildStore URL; with a local BuildStore an explicit hosted URL is required.',
})
documentSchema(ticketsInputSchema.shape.doneState, {
  constraints: 'Hosted resolution uses done when omitted.',
})
documentSchema(ticketsInputSchema.shape.claimedState, {
  constraints:
    'Forbidden for file. Resolution uses In Progress for direct Linear, doing for hosted.',
})
documentSchema(ticketsInputSchema.shape.createState, {
  constraints: 'Omission uses the source creation state (Linear team default; file Triage).',
})
documentSchema(ticketsInputSchema.shape.triageState, {
  constraints:
    'Omission resolves to Backlog for Linear, triage for hosted, Triage for file/plugin sources.',
})
documentSchema(ticketsInputSchema.shape.proposalState, {
  constraints: 'Omission uses the resolved triageState.',
})
documentSchema(ticketsInputSchema.shape.dir, {
  constraints:
    'Forbidden for linear and hosted. File omission resolves to the selected local state root tickets directory; plugin omission remains omitted.',
})
export const ticketsSchema = ticketsInputSchema
  .superRefine((tickets, ctx) => {
    if (tickets.source === 'hosted' && tickets.url !== undefined) {
      try {
        normalizeServiceURL(tickets.url, 'tickets.url')
      } catch (error) {
        ctx.addIssue({ code: 'custom', path: ['url'], message: (error as Error).message })
      }
    }
    if (tickets.source !== 'hosted' && tickets.readyState === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['readyState'],
        message:
          '[tickets].readyState is required — name the one workflow state a ticket must sit in to be dispatched (e.g. "ready").',
      })
    if (['file', 'linear'].includes(tickets.source) && tickets.url !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message: '[tickets].url applies only to source = "hosted"',
      })
  })
  .transform((tickets) => ({
    ...tickets,
    readyState: tickets.readyState ?? 'ready',
    ...(tickets.source === 'hosted' && tickets.url !== undefined
      ? { url: normalizeServiceURL(tickets.url, 'tickets.url') }
      : {}),
  }))

documentSchema(ticketsSchema, {
  constraints:
    'readyState is required except for hosted, whose omitted value resolves to ready. url is forbidden for file and linear; hosted URLs must be absolute HTTPS (loopback HTTP allowed), without credentials, query or fragment, and are normalized.',
})
export type TicketsConfig = z.infer<typeof ticketsSchema>

// ── [orchestrator] ──────────────────────────────────────────────────────────
//
// The operator-agent gate (AUT-340). Absent table ≡ disabled: with `enabled =
// false` (the default) the sandbox registry tools are absent from every
// binding and no environment is ever provisioned.

export const orchestratorSandboxSchema = z.strictObject({
  /** Idle minutes without a sandbox tool call before the dispatcher tick's
   * janitor stops the environment, keeping its snapshot for the next resume. */
  idleMinutes: z.number().int().positive().default(30),
  /** Names of non-secret host environment variables forwarded into the
   * sandbox (during provisioning/setup and tool exec/start alike). These are
   * the ONLY non-toolchain environment the sandbox ever sees; forwarding any
   * store, forge, ticket-provider, model, or Vercel credential name is a
   * config error. Unset means none. */
  environmentVariables: z.array(z.string().min(1)).default([]),
})

documentFields(orchestratorSandboxSchema, {
  idleMinutes:
    "Minutes without a sandbox tool call after which the dispatcher tick's janitor stops the environment, keeping its snapshot; the next tool call resumes it.",
  environmentVariables:
    'Names of non-secret host variables forwarded into the sandbox \u2014 the only non-toolchain environment it ever sees, during provisioning/setup and tool exec/start alike. Unset means none.',
})
documentSchema(orchestratorSandboxSchema.shape.environmentVariables, {
  constraints:
    'When enabled, forwarding store, forge, ticket-provider, model or Vercel credentials, or builtin-provider forbidden names, is rejected.',
})
export type OrchestratorSandboxConfig = z.infer<typeof orchestratorSandboxSchema>

export const orchestratorSchema = z.strictObject({
  enabled: z.boolean().default(false),
  sandbox: orchestratorSandboxSchema.prefault({}),
})

documentFields(orchestratorSchema, {
  enabled:
    'Enables externally driven sandbox tools, archive cleanup and dispatcher idle settlement. Operators run in external agent harnesses.',
  sandbox: 'Sandbox behavior knobs.',
})
export type OrchestratorConfig = z.infer<typeof orchestratorSchema>

// ── Whole file ───────────────────────────────────────────────────────────────

export const storeSchema = z.strictObject({
  url: z.string().transform((value, ctx) => {
    try {
      return normalizeServiceURL(value)
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message })
      return z.NEVER
    }
  }),
})

documentFields(storeSchema, {
  url: 'Absolute HTTPS service base URL; loopback HTTP is allowed for development. No credentials, query or fragment. Trailing slashes are normalized.',
})
documentSchema(storeSchema.shape.url, {
  constraints:
    'Absolute HTTPS service URL; loopback HTTP allowed. No credentials, query or fragment. Trailing slashes normalized.',
})
export const configRootSchema = z.strictObject({
  store: storeSchema.optional(),
  upgrade: z.strictObject({ automatic: z.boolean().default(true) }).prefault({}),
  /** Base branch builds cut from and target (§16.1). */
  baseBranch: z.string().min(1).default('main'),
  /** Concurrent builds for this repository (§16.1). */
  capacity: z.number().int().positive().default(1),
  ticketScanIntervalSeconds: z.number().int().positive().default(60),
  /** Forge adapter selected from builtins and configured plugins. */
  forge: z
    .string()
    .refine((value) => value.trim().length > 0, 'forge adapter name must be nonblank')
    .default('github'),
  /** Trusted in-process plugin modules, loaded in declaration order from the
   * consuming repository before production adapters are constructed. Exact
   * specifier strings must be unique (cross-validated below). */
  plugins: z
    .array(
      z
        .string()
        .refine((value) => value.trim().length > 0, 'plugin module specifiers must be nonblank'),
    )
    .default([]),
  merge: z.array(landingRuleSchema).optional(),
  landing: z.array(landingRuleSchema).optional(),
  pr: prSchema.optional(),
  workspace: workspaceSchema.prefault({}),
  commands: commandsSchema,
  verify: verifySectionSchema,
  finalize: finalizeSectionSchema,
  // `default` is reserved inside this open map (§9). The schema preserves the
  // raw map — EVERY declared key, `__proto__` included, or an entry would
  // disappear ahead of both eager resolution and the unconsumed-key warning;
  // the registry-aware eager resolver requires default.runtime and can
  // therefore include the complete materialized runtime list in its diagnostic.
  roles: openMap('[roles]', roleSchema),
  policy: policySchema.prefault({}),
  orchestrator: orchestratorSchema.prefault({}),
  // An absent [tickets] table must NOT silently default past the mandatory
  // ready gate. Prefault feeds the file-source identity through ticketsSchema,
  // which deliberately fails on missing `readyState` at `tickets.readyState`.
  // The cast only satisfies prefault's input type; `{ source: 'file' }` is
  // intentionally invalid until the repository names its ready state.
  tickets: ticketsSchema.prefault({
    source: 'file',
  } as z.input<typeof ticketsSchema>),
})

documentFields(configRootSchema, {
  store: 'Optional remote BuildStore connection. Credentials live outside TOML.',
  upgrade: 'Automatic dispatcher runtime target checks and adoption.',
  baseBranch: 'Branch used to cut builds, target PRs, and merge during reconciliation.',
  capacity:
    'Concurrent occupied slots for this repository. Paused and blocked work retains slots. Node reconcile and verification exclude their own blocked/paused descendants at admission; new claims use total occupancy. See [integration capacity](integration-tree.md).',
  ticketScanIntervalSeconds:
    'Ticket-source ready scan cadence; tick spacing is the effective minimum.',
  forge:
    'Forge adapter name. Shipped values are `github` and `local-git`; configured plugins may register other names.',
  plugins:
    'Trusted Bun plugin modules loaded by dispatch, `ab ticket`, and scoped phase CLI processes.',
  merge: 'Ordered merge rules; the first matching rule controls consent.',
  landing: 'Deprecated alias for merge. Do not declare both keys.',
  pr: 'Pull request review image hosting configuration.',
  workspace: 'Workspace provider selector and provider-specific configuration.',
  commands: 'Named shell commands used by setup and deterministic checks.',
  verify:
    'Ordered verification steps and applicability rules. Step names use ASCII letters, digits, ., _ and -; exactly . and .. are forbidden.',
  finalize:
    'Ordered post-PR steps. Failures are recorded without blocking the PR. Step names use ASCII letters, digits, ., _ and -; exactly . and .. are forbidden.',
  roles: 'Named agent roles. The reserved default role provides inherited runtime axes.',
  policy: 'Lifecycle budgets, retries, convergence and harvest limits.',
  orchestrator:
    'Operator-agent sandbox settings. This table does not start or host an operator agent.',
  tickets:
    'Ticket source and lifecycle vocabulary. Omitting the table supplies source=file but still requires readyState.',
})
documentSchema(configRootSchema.shape.upgrade.unwrap().shape.automatic, {
  description: 'Check and adopt changed runtime targets automatically.',
})
documentSchema(configRootSchema.shape.plugins, {
  constraints: 'Exact module specifiers must be unique.',
})

/** Root metadata keeps strict error prose and documentation coverage honest. */
export const TOP_LEVEL_SCALARS = [
  'baseBranch',
  'capacity',
  'ticketScanIntervalSeconds',
  'forge',
  'plugins',
] as const
export const TOP_LEVEL_TABLES = Object.keys(configRootSchema.shape).filter(
  (key) => !(TOP_LEVEL_SCALARS as readonly string[]).includes(key),
)
export const TOP_LEVEL_KEYS = Object.keys(configRootSchema.shape)

/**
 * Cross-validation (§16.1): errors carry the path and what would be accepted,
 * because validation failures are feedback to whoever edits the file (D6
 * discipline applied to config).
 */
const normalizedConfigSchema = configRootSchema.transform((input, ctx) => {
  if (input.merge !== undefined && input.landing !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['merge'],
      message: 'merge and deprecated landing cannot both be declared',
    })
    return z.NEVER
  }
  const { merge, landing, ...rest } = input
  return { ...rest, landing: merge ?? landing ?? [] }
})

export const configSchema = normalizedConfigSchema.superRefine((config, ctx) => {
  for (const kind of ['verify', 'finalize'] as const) {
    const section = config[kind]
    if (!section) continue
    for (const name of new Set([...section.steps, ...Object.keys(section.stepConfigs)])) {
      if (!isSafeStepName(name))
        ctx.addIssue({
          code: 'custom',
          path: [kind, name],
          message: `${kind} step "${name}" must contain only ASCII letters, digits, ., _ or - and cannot be . or ..`,
        })
    }
  }

  const firstPluginIndex = new Map<string, number>()
  config.plugins.forEach((specifier, index) => {
    const firstIndex = firstPluginIndex.get(specifier)
    if (firstIndex === undefined) {
      firstPluginIndex.set(specifier, index)
      return
    }
    ctx.addIssue({
      code: 'custom',
      path: ['plugins', index],
      message:
        `duplicate plugin module specifier ${JSON.stringify(specifier)} — first declared at ` +
        `plugins[${firstIndex}]; remove or deduplicate this entry`,
    })
  })

  const workspaceDeclaration = BUILTIN_WORKSPACE_PROVIDER_CONFIG.get(config.workspace.provider)
  // The parse-site refusal fires only for a declaration carrying
  // `configRefusalMessage`; providers absent from the table are plugin-owned
  // pass-throughs and are never refused here.
  if (workspaceDeclaration?.configRefusalMessage !== undefined) {
    if (Object.keys(config.workspace.config).length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['workspace', 'config'],
        message: workspaceDeclaration.configRefusalMessage,
      })
    }
  } else if (workspaceDeclaration?.configSchema !== undefined) {
    const parsed = workspaceDeclaration.configSchema.safeParse(config.workspace.config)
    if (!parsed.success) {
      forwardIssues(parsed.error.issues, ctx, ['workspace', 'config'])
    } else if (
      workspaceDeclaration.requireRuntimeProvisioning === true &&
      config.roles !== undefined &&
      config.verify !== undefined &&
      config.finalize !== undefined
    ) {
      for (const group of effectiveRuntimeReferences(config)) {
        if (Object.hasOwn(runtimeProvisioningMap(parsed.data), group.runtime)) continue
        ctx.addIssue({
          code: 'custom',
          path: ['workspace', 'config', 'runtimeProvisioning', group.runtime],
          message: runtimeProvisioningMissingMessage(group),
        })
      }
    }
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
    const seen = new Set<string>()
    config.verify.steps.forEach((step, index) => {
      if (seen.has(step))
        ctx.addIssue({
          code: 'custom',
          path: ['verify', 'steps', index],
          message: `duplicate verify step ${JSON.stringify(step)} across or within stages`,
        })
      seen.add(step)
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
          message: `[verify.${step}].command = "${stepConfig.command}" does not name a key in [commands] — ${knownCommands}`,
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
          message: `[finalize.${step}].command = "${stepConfig.command}" does not name a key in [commands] — ${knownCommands}`,
        })
      }
    }
  }

  const tickets = config.tickets
  if (tickets.source === 'linear' || tickets.source === 'hosted') {
    if (tickets.teamKey === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['tickets', 'teamKey'],
        message: `[tickets].source = "${tickets.source}" requires teamKey${
          tickets.source === 'linear' ? ' — the Linear team key (e.g. "ENG")' : ''
        }`,
      })
    }
    if (tickets.dir !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['tickets', 'dir'],
        message: '[tickets].dir applies only to source = "file" — remove it or set source = "file"',
      })
    }
  } else if (tickets.source === 'file') {
    // dir is optional for the file source: absent = .autobuild/tickets.
    for (const key of ['teamKey', 'claimedState'] as const) {
      if (tickets[key] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['tickets', key],
          message: `[tickets].${key} applies only to source = "linear" or "hosted" — remove it or select one of those sources`,
        })
      }
    }
  }
  if (tickets.source !== 'linear' && tickets.readyAssignee !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['tickets', 'readyAssignee'],
      message: `[tickets].readyAssignee applies only to source = "linear" — remove it or select that source (selected source: "${tickets.source}")`,
    })
  }
  // Plugin sources receive the existing ticket lifecycle/configuration fields
  // unchanged; adapter-specific validation belongs to their factory.

  // The credential-free sandbox rule (AUT-340): a forwarded variable name may
  // never name a store, forge, ticket-provider, model, or Vercel credential.
  // A workspace provider can declare additional forbidden names beyond the
  // shared set. This check is deliberately builtin-only: plugins are not
  // loaded when config is parsed, so a plugin provider's declared names cannot
  // be seen here (AUT-536). The deferral is accepted, not an oversight — the
  // declared extras are enforced at the registry-aware seams instead,
  // `createWorkspaceProvider` (construction) and `validateInitReadiness`
  // (init validation), both of which run after plugin load; no site loads
  // plugins earlier to widen parse-time coverage.
  if (config.orchestrator.enabled) {
    const providerForbidden =
      BUILTIN_WORKSPACE_PROVIDER_CONFIG.get(config.workspace.provider)?.sandboxForbiddenEnv ?? []
    config.orchestrator.sandbox.environmentVariables.forEach((name, index) => {
      if (SANDBOX_FORBIDDEN_ENV.includes(name) || providerForbidden.includes(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['orchestrator', 'sandbox', 'environmentVariables', index],
          message: sandboxForbiddenEnvMessage(name),
        })
      }
    })
  }
})

export type Config = z.infer<typeof configSchema>
