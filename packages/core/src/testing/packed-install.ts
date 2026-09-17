import { spawnExec, type Exec, type ExecResult } from '../ports/workspace/git-worktree'

/**
 * Install a packed distribution artifact from a test consumer directory, with a
 * bounded-delay retry for bun's registry-lag failure signature.
 *
 * The packing tests resolve a floating `ai: ^7.0.101` range against the live
 * registry in a fresh, lockfile-less consumer. Every new `ai` release
 * exact-pins a fresh `@ai-sdk/gateway` version, and the packument bun consults
 * can lag that publish (npm serves packuments with `Cache-Control: max-age=
 * 300`), so resolution fails with:
 *
 *   No version matching "4.0.85" found for specifier "@ai-sdk/gateway" (but
 *   package exists)
 *
 * Diagnosis established (see the build's PR notes): failed resolutions write
 * no manifest-cache entries, so an immediate retry deterministically re-fails
 * while the server serves the stale packument; and a *successful* install's
 * cached packuments are trusted for the served max-age across processes. The
 * retry therefore waits out the window (330s = 300s max-age plus margin,
 * measured from the first lag failure in this process) and re-runs once with
 * `--no-cache`, which ignores the manifest cache entirely (tarballs stay
 * cached) and forces a fresh packument fetch. A genuinely broken pin does not
 * match the narrow signature below and fails without any retry.
 */

/** npm packument `max-age=300` plus margin; the window the retry crosses. */
export const REGISTRY_LAG_RETRY_DELAY_MS = 330_000

const REGISTRY_LAG_SIGNATURE =
  /No version matching .* found for specifier .* \(but package exists\)/

/** True when the output matches bun's packument-lag failure signature. */
export function isRegistryLagFailure(output: string): boolean {
  return REGISTRY_LAG_SIGNATURE.test(output)
}

/** First lag failure seen in this process; anchors the shared retry window. */
let registryLagSince: number | undefined

/** Test-only: clear the process-wide lag-failure cooldown. */
export function resetRegistryLagCooldownForTests(): void {
  registryLagSince = undefined
}

export type InstallPackedDistributionOptions = {
  /** Replaces the default spawn, for tests. */
  run?: Exec
  /** Injectable clock (defaults to `Date.now`) for deterministic delay math. */
  clock?: () => number
  /** Injectable sleep (defaults to a real timer) for deterministic delays. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Run `bun install <args>` in `cwd`. On the registry-lag signature, wait out
 * the remaining window since the first lag failure in this process and retry
 * once with `--no-cache`; any other non-zero exit returns immediately. The
 * cooldown is shared by all installs in the process, so a second packing test
 * does not pay another full window if the first one already crossed it.
 */
export async function installPackedDistribution(
  args: readonly string[],
  cwd: string,
  options: InstallPackedDistributionOptions = {},
): Promise<ExecResult> {
  const run = options.run ?? spawnExec
  const clock = options.clock ?? Date.now
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const first = await run(['bun', 'install', ...args], { cwd })
  if (first.exitCode === 0 || !isRegistryLagFailure(`${first.stdout}${first.stderr}`)) {
    return first
  }

  const now = clock()
  registryLagSince ??= now
  const delay = Math.max(0, REGISTRY_LAG_RETRY_DELAY_MS - (now - registryLagSince))
  if (delay > 0) {
    await sleep(delay)
  }
  return run(['bun', 'install', ...args, '--no-cache'], { cwd })
}
