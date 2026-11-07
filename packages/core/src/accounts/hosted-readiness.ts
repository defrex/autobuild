/**
 * Init validation's hosted metadata readiness boundary. Accounts whose
 * credential is checked only from project-secret metadata are listed by name
 * in this variable so the guest probe skips their live model request; the
 * value is a JSON list of account names, never credential values.
 */
export const HOSTED_ACCOUNT_READINESS_ENV = 'AB_HOSTED_ACCOUNT_READINESS'

/** Stands in for a hosted credential during validation; the real value is never downloaded. */
export const HOSTED_METADATA_PLACEHOLDER = 'autobuild-hosted-metadata-only'

export function hostedReadinessNames(env: Readonly<Record<string, string | undefined>>): string[] {
  return JSON.parse(env[HOSTED_ACCOUNT_READINESS_ENV] ?? '[]') as string[]
}

export function withHostedReadiness(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  return JSON.stringify([...hostedReadinessNames(env), name])
}
