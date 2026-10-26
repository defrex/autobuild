import { z } from 'zod'
import { documentSchema, documentFields } from './reference-metadata'

const accountCredentialEnvSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .refine(
    (name) => !name.startsWith('AB_'),
    'Autobuild control variables cannot hold account credentials',
  )
export const accountSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('claude-subscription'),
    credentialEnv: accountCredentialEnvSchema,
  }),
  z.strictObject({
    kind: z.literal('kimi-code'),
    credentialEnv: accountCredentialEnvSchema,
    region: z.enum(['overseas', 'china']).default('overseas'),
  }),
])

documentSchema(accountSchema, { description: 'Named nonsecret billing account descriptor.' })
documentSchema(accountCredentialEnvSchema, {
  constraints: 'Portable environment variable identifier; AB_ control variables are reserved.',
})
for (const branch of accountSchema.options)
  documentFields(branch, {
    kind: 'Claude subscription or Kimi Code membership using the unmodified Claude runtime.',
    credentialEnv:
      'Dispatcher-host environment variable holding the credential; never the credential itself.',
    ...(branch.shape.kind.value === 'kimi-code'
      ? {
          region:
            'Membership region: overseas (default) or china. Selects the base URL and exact egress host together.',
        }
      : {}),
  })

/** Nonsecret billing descriptors. Credential values are resolved only at execution boundaries. */
export type Account =
  | { kind: 'claude-subscription'; credentialEnv: string }
  | { kind: 'kimi-code'; credentialEnv: string; region: 'overseas' | 'china' }
export type Accounts = Readonly<Record<string, Account>>
export const selectedAccountSchema = z.strictObject({
  name: z.string().min(1),
  descriptor: accountSchema,
})
export type SelectedAccount = z.infer<typeof selectedAccountSchema>

export function kimiEndpoint(region: 'overseas' | 'china'): { baseUrl: string; host: string } {
  return region === 'china'
    ? { baseUrl: 'https://api.kimi.com/coding/', host: 'api.kimi.com' }
    : { baseUrl: 'https://api.kimi.ai/coding/', host: 'api.kimi.ai' }
}

export function selectAccount(
  accounts: Accounts,
  runtime: string | undefined,
  name: string | undefined,
  label: string,
): SelectedAccount | undefined {
  if (name === undefined && runtime === 'claude') {
    const defaults = Object.entries(accounts).filter(
      ([, account]) => account.kind === 'claude-subscription',
    )
    if (defaults.length > 1)
      throw new Error(`${label}: ambiguous Claude subscription account; select account explicitly`)
    name = defaults[0]?.[0]
  }
  if (name === undefined) return undefined
  if (!Object.hasOwn(accounts, name))
    throw new Error(`${label}: unknown account ${JSON.stringify(name)}`)
  if (runtime !== 'claude')
    throw new Error(`${label}: account ${JSON.stringify(name)} requires runtime "claude"`)
  return { name, descriptor: accounts[name]! }
}

export function accountRemedy(account: SelectedAccount): string {
  return (
    `account ${JSON.stringify(account.name)} (${account.descriptor.credentialEnv}): ` +
    (account.descriptor.kind === 'claude-subscription'
      ? 'renew with claude setup-token and set the dispatcher credential variable'
      : 'replace the Kimi Code membership key in the dispatcher credential variable')
  )
}

/** Encodes arbitrary names injectively; never a credential. */
export function accountPlaceholder(name: string): string {
  return `autobuild-account-${Buffer.from(name).toString('hex')}`
}
