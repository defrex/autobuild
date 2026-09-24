/**
 * The `vercel-sandbox` provider's `[workspace.config]` schema, moved verbatim
 * from core's `config/schema.ts` (AUT-505). The host parses `[workspace.config]`
 * through this schema at the registry-aware construction seam
 * (`createWorkspaceProvider`), driven by the plugin manifest's declared
 * `configSchema` capability; core's config parser no longer validates this
 * provider's config at parse time.
 */
import { z } from 'zod'
import { openMap } from '@defrex/autobuild/plugin-sdk'

const envNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a nonblank environment variable name')

/** Strict Vercel configuration. Values are operational policy only;
 * credentials are referenced by variable name and never accepted as literals. */
const nonblankProvisioningString = (field: string) =>
  z.string().refine((value) => value.trim().length > 0, `${field} must be nonblank`)

export const vercelProvisioningStepSchema = z.strictObject({
  name: nonblankProvisioningString('provisioning step name'),
  command: nonblankProvisioningString('provisioning step command'),
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
