/**
 * Readiness-probe helpers shared by the local-worktree and remote validation
 * paths (AUT-516). Moved out of `cli/init-validation.ts` so the remote
 * capability implementation can use them without init-validation importing
 * the provider implementation; `init-validation.ts` re-exports for
 * compatibility.
 */
import type { Exec } from '../ports/workspace/git-worktree'
import type { GuestProbeReport } from '../ports/workspace/provider-capabilities'

export const INIT_PROBE_MARKER = 'AB_INIT_READINESS_V1='

function message(error: unknown): string {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.map(message)].filter(Boolean).join('; ')
  }
  if (error instanceof Error)
    return `${error.message}${error.cause === undefined ? '' : `; ${message(error.cause)}`}`
  return String(error)
}

/** Replace every supplied nonempty value, longest first, in all diagnostics. */
export function createReadinessRedactor(
  env: Readonly<Record<string, string | undefined>>,
  explicitSecretNames: readonly string[] = [],
): (value: unknown) => string {
  const namedSecrets = new Set(explicitSecretNames)
  const secrets = [
    ...new Set(
      Object.entries(env)
        .filter(
          ([name, value]) =>
            value !== undefined &&
            value !== '' &&
            (namedSecrets.has(name) || /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(name)),
        )
        .map(([, value]) => value as string),
    ),
  ].sort((left, right) => right.length - left.length)
  return (value) => {
    let text = message(value)
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]')
    return text
  }
}

export function parseGuestOutput(output: string): GuestProbeReport {
  const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith(INIT_PROBE_MARKER))
  if (line === undefined)
    throw new Error('remote readiness probe returned malformed output (result marker absent)')
  const value = JSON.parse(line.slice(INIT_PROBE_MARKER.length)) as GuestProbeReport
  if (!Array.isArray(value.checks))
    throw new Error('remote readiness probe returned malformed checks')
  return value
}

export async function gitText(
  exec: Exec,
  repo: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await exec(['git', ...args], {
    cwd: repo,
    ...(signal === undefined ? {} : { signal }),
  })
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.join(' ')} exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
    )
  return result.stdout.trim()
}
