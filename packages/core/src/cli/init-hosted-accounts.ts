/**
 * Pure readiness checks for hosted Claude and Kimi accounts whose credential
 * is a static project secret (`ab secrets set NAME`). Only write-only
 * metadata is read; a project secret's value is never downloaded or printed.
 */
import type { Account } from '../config/accounts'
import type { ProjectSecretMetadata } from '../project-secrets'
import type { ReadinessCheck } from '../ports/workspace/provider-capabilities'

/**
 * A Claude or Kimi account is checked by metadata only on a connected project
 * validated by a provider with remote readiness (the Vercel egress transform
 * is what supplies project secrets), and only when no local variable is set.
 */
export function staticSecretEligible(
  descriptor: Account,
  env: Readonly<Record<string, string | undefined>>,
  opts: { connected: boolean; remoteReadiness: boolean },
): boolean {
  return (
    (descriptor.kind === 'claude-subscription' || descriptor.kind === 'kimi-code') &&
    opts.connected &&
    opts.remoteReadiness &&
    !env[descriptor.credentialEnv]
  )
}

export function staticSecretRemedy(descriptor: Account): string {
  const local =
    descriptor.kind === 'kimi-code'
      ? 'provide the Kimi Code membership key in the local variable'
      : 'run claude setup-token and provide the local variable'
  return `set the project secret with bun ab secrets set ${descriptor.credentialEnv}, or ${local}`
}

export function staticSecretReadiness(
  name: string,
  descriptor: Account,
  metadata: readonly ProjectSecretMetadata[] | undefined,
): ReadinessCheck & { ready: boolean } {
  const entry = metadata?.find((s) => s.name === descriptor.credentialEnv && s.kind === 'static')
  const ready = entry?.status === 'ready' && entry.failureCode === null
  const facts = entry ? `owner ${entry.owner}; set ${entry.setAt}` : ''
  return {
    name: `account ${JSON.stringify(name)}`,
    status: ready ? 'pass' : 'fail',
    ready,
    detail: ready
      ? `Hosted credential ready; ${facts}. Hosted Claude and Kimi accounts are checked by metadata; the first hosted build is the live check.`
      : entry
        ? `Hosted credential ${entry.status}${entry.failureCode === null ? '' : ` (${entry.failureCode})`}; ${facts}; ${staticSecretRemedy(descriptor)}`
        : `${descriptor.credentialEnv} is missing; ${staticSecretRemedy(descriptor)}`,
  }
}
