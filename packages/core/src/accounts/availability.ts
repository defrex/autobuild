import { accountRemedy, type Accounts, type SelectedAccount } from '../config/accounts'
import type { RepositoryReadFacts } from '../store/reduced-reads'
import type { RepositoryEventWrite } from '../events/repository'
import { DISPATCHER } from '../events/envelope'

export interface MissingAccountCredential extends SelectedAccount {
  source: 'environment' | 'project-secrets'
  remedy: string
}

/** Presence only: no provider calls, token validation, or secret values in diagnostics. */
export function missingAccountCredentials(
  accounts: Accounts,
  env: Readonly<Record<string, string | undefined>>,
  source: MissingAccountCredential['source'] = 'environment',
  workspaceProvider = 'vercel-sandbox',
): MissingAccountCredential[] {
  return Object.entries(accounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(
      ([, descriptor]) =>
        !env[descriptor.credentialEnv] &&
        !(
          source === 'environment' &&
          workspaceProvider !== 'vercel-sandbox' &&
          descriptor.kind === 'claude-subscription'
        ),
    )
    .map(([name, descriptor]) => ({
      name,
      descriptor,
      source,
      remedy:
        source === 'environment'
          ? accountRemedy({ name, descriptor })
          : `account ${JSON.stringify(name)} (${descriptor.credentialEnv}): set the project secret with ab secrets set ${descriptor.credentialEnv}` +
            (descriptor.kind === 'chatgpt-subscription'
              ? ` or renew with ab accounts login ${JSON.stringify(name)} --project`
              : ''),
    }))
}
export function formatMissingAccountCredentials(
  missing: readonly MissingAccountCredential[],
): string {
  return `Missing credentials: ${missing.map((account) => `${account.remedy} [${account.source}]`).join('; ')}`
}
export class MissingAccountCredentialsError extends Error {
  constructor(readonly missing: MissingAccountCredential[]) {
    super(formatMissingAccountCredentials(missing))
    this.name = 'MissingAccountCredentialsError'
  }
}

/** Reconcile against the canonical reduced value, shared by all launches in a tick. */
export async function reconcileMissingAccounts(
  missing: readonly MissingAccountCredential[],
  current: RepositoryReadFacts['missingAccounts'],
  append: (event: RepositoryEventWrite) => Promise<unknown>,
): Promise<void> {
  const next = new Map(missing.map((account) => [account.name, account]))
  for (const [name] of Object.entries(current))
    if (!next.has(name))
      await append({ actor: DISPATCHER, type: 'account.credentials-recovered', payload: { name } })
  for (const account of missing)
    if (!sameMissingAccount(current[account.name], account))
      await append({ actor: DISPATCHER, type: 'account.credentials-unavailable', payload: account })
}

function sameMissingAccount(
  left: MissingAccountCredential | undefined,
  right: MissingAccountCredential,
): boolean {
  return (
    !!left &&
    left.name === right.name &&
    left.source === right.source &&
    left.remedy === right.remedy &&
    left.descriptor.kind === right.descriptor.kind &&
    left.descriptor.credentialEnv === right.descriptor.credentialEnv &&
    (left.descriptor.kind !== 'kimi-code' ||
      (right.descriptor.kind === 'kimi-code' && left.descriptor.region === right.descriptor.region))
  )
}

/** The project snapshot is authoritative even when empty. Do not borrow service credentials. */
export function applyProjectAccountSnapshot(
  accounts: Accounts,
  env: Record<string, string | undefined>,
  snapshot: Readonly<Record<string, string>>,
) {
  for (const descriptor of Object.values(accounts)) {
    delete env[descriptor.credentialEnv]
    if (snapshot[descriptor.credentialEnv])
      env[descriptor.credentialEnv] = snapshot[descriptor.credentialEnv]
  }
}
