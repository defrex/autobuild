import { sensitiveAccountValues } from '../../accounts/sensitive'
import type { NetworkPolicy, NetworkPolicyRule } from '@vercel/sandbox'
import {
  accountPlaceholder,
  accountRemedy,
  kimiEndpoint,
  type Accounts,
} from '../../config/accounts'

/** Only exact provider + account-specific header matches receive credentials. */
export function accountPolicy(
  base: NetworkPolicy,
  accounts: Accounts,
  env: Readonly<Record<string, string | undefined>>,
  requiredAccounts: Accounts = accounts,
): { policy: NetworkPolicy; missing: string[] } {
  if (Object.keys(accounts).length === 0) return { policy: base, missing: [] }
  if (base === 'deny-all' || (typeof base === 'object' && Array.isArray(base.allow)))
    throw new Error('Account policy requires a rule-based network policy')
  const allow: Record<string, NetworkPolicyRule[]> =
    typeof base === 'object'
      ? { ...(base.allow as Record<string, NetworkPolicyRule[]>) }
      : { '*': [] }
  const missing: string[] = []
  for (const [name, descriptor] of Object.entries(accounts)) {
    const credential = env[descriptor.credentialEnv]
    if (!credential) {
      if (Object.hasOwn(requiredAccounts, name)) missing.push(accountRemedy({ name, descriptor }))
      continue
    }
    const claude = descriptor.kind !== 'kimi-code'
    const host =
      descriptor.kind === 'chatgpt-subscription'
        ? 'api.openai.com'
        : descriptor.kind === 'kimi-code'
          ? kimiEndpoint(descriptor.region).host
          : 'api.anthropic.com'
    const key = claude ? 'authorization' : 'x-api-key'
    const prefix = claude ? 'Bearer ' : ''
    allow[host] = [
      ...(allow[host] ?? []),
      {
        match: {
          headers: [{ key: { exact: key }, value: { exact: prefix + accountPlaceholder(name) } }],
        },
        transform: [{ headers: { [key]: prefix + credential } }],
      },
    ]
  }
  return { policy: { ...(typeof base === 'object' ? base : {}), allow }, missing }
}

/** Declared credential variables and aliases containing their values never cross
 * into the guest. Placeholders let sessions choose accounts without host RPC. */
export function accountGuestEnvironment(
  forwarded: Record<string, string>,
  accounts: Accounts,
  host: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env = { ...forwarded }
  if (Object.keys(accounts).length) env.AB_ACCOUNT_PLACEHOLDERS = '1'
  const secrets = [
    ...sensitiveAccountValues,
    ...Object.values(accounts)
      .map((a) => host[a.credentialEnv])
      .filter((v): v is string => !!v),
  ]
  for (const [key, value] of Object.entries(env))
    if (secrets.some((secret) => value.includes(secret))) delete env[key]
  for (const [name, account] of Object.entries(accounts))
    env[account.credentialEnv] = accountPlaceholder(name)
  return env
}
