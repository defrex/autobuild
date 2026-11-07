import { spawnExec, type Exec, type ExecResult } from '../ports/workspace/git-worktree'

/**
 * Install a packed distribution artifact from a test consumer directory, with
 * bounded-delay retries for two narrow failure signatures: bun's registry-lag
 * signature and a transient transport/5xx signature. Any other failure throws
 * a {@link PackedInstallError} carrying the install's bounded stderr, so the
 * cause reaches the verify report instead of a bare exit code.
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
 * measured from the most recent distinct lag failure — see below) and re-runs
 * once with `--no-cache`, which ignores the manifest cache entirely (tarballs
 * stay cached) and forces a fresh packument fetch. A genuinely broken pin matches
 * neither the lag signature nor the transient signature and fails without any
 * retry.
 *
 * The window anchor is re-set on each *distinct* lag event: when a lag failure
 * arrives after the previous window has fully elapsed (elapsed ≥ 330s), it is
 * treated as a new window and pays the full delay, so a second independent
 * registry-lag event is not floored to a zero-length delay by the first
 * event's stale timestamp. Within an unelapsed window, successive installs
 * still share the remainder, so a second packing test in the same process does
 * not pay another full window if the first one already crossed it.
 */

/** npm packument `max-age=300` plus margin; the window the retry crosses. */
export const REGISTRY_LAG_RETRY_DELAY_MS = 330_000

const REGISTRY_LAG_SIGNATURE =
  /No version matching .* found for specifier .* \(but package exists\)/

/** True when the output matches bun's packument-lag failure signature. */
export function isRegistryLagFailure(output: string): boolean {
  return REGISTRY_LAG_SIGNATURE.test(output)
}

/** Delays before each transient retry: at most 2 retries (3 attempts). */
export const TRANSIENT_INSTALL_RETRY_DELAYS_MS = [2_000, 5_000] as const

/** Tail characters of stderr kept in a failure message or retry log. */
export const INSTALL_STDERR_LIMIT = 3_000

/** Tail characters of stdout kept in a failure message. */
export const INSTALL_STDOUT_LIMIT = 500

/**
 * Transient failure lines, measured against a scripted fake registry with bun
 * 1.4.4. Transport faults (connection refused or closed mid-body, DNS failure)
 * print `error: <ErrorName> downloading package manifest|tarball <name>`; a
 * 5xx on a manifest or tarball prints `error: GET <url> - 503`. bun retries
 * both internally before exiting. Either may be followed by
 * `error: <pkg>@<range> failed to resolve`. Deterministic failures exit almost
 * at once with other lines: a 404 (`GET <url> - 404`), an integrity mismatch
 * (`Integrity check failed for tarball` / `IntegrityCheckFailed extracting
 * tarball`), or a truncated manifest's JSON parse excerpt.
 */
export const TRANSIENT_TRANSPORT_LINE =
  /^error: [A-Z][A-Za-z]+ downloading (package manifest|tarball) /
export const TRANSIENT_STATUS_LINE = /^error: GET \S+ - (408|429|5\d\d)$/
export const RESOLVE_FOLLOW_ON_LINE = /^error: \S+ failed to resolve$/

const ANSI_SGR = /\x1b\[[0-9;]*m/g

/**
 * True when every `error:` line in the output belongs to the transient class
 * and at least one transport or retryable-status line is present. Any other
 * `error:` line, or no `error:` line at all (a panic), is deterministic.
 */
export function isTransientInstallFailure(output: string): boolean {
  let transient = false
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '').replace(ANSI_SGR, '')
    if (!line.startsWith('error:')) continue
    if (TRANSIENT_TRANSPORT_LINE.test(line) || TRANSIENT_STATUS_LINE.test(line)) transient = true
    else if (!RESOLVE_FOLLOW_ON_LINE.test(line)) return false
  }
  return transient
}

function boundedTail(text: string, limit: number): string {
  if (text.length === 0) return '(empty)'
  if (text.length <= limit) return text
  return `… (truncated)${text.slice(-limit)}`
}

/** The thrown failure message: the command, exit code, and bounded output tails. */
export function formatInstallFailure(
  args: readonly string[],
  cwd: string,
  result: ExecResult,
  attempts: number,
): string {
  return [
    `bun install ${args.join(' ')} failed in ${cwd} (exit ${result.exitCode}, ${attempts} attempt(s))`,
    `--- stderr (last ${INSTALL_STDERR_LIMIT} chars) ---`,
    boundedTail(result.stderr, INSTALL_STDERR_LIMIT),
    `--- stdout (last ${INSTALL_STDOUT_LIMIT} chars) ---`,
    boundedTail(result.stdout, INSTALL_STDOUT_LIMIT),
  ].join('\n')
}

/** A packed install that failed after any applicable retries. */
export class PackedInstallError extends Error {
  override readonly name = 'PackedInstallError'
  constructor(
    message: string,
    readonly result: ExecResult,
    readonly attempts: number,
  ) {
    super(message)
  }
}

/** Anchor state for the shared retry window. */
type CooldownState = { since?: number }

/** First lag failure seen in this process; anchors the shared retry window. */
const processCooldown: CooldownState = {}

/** Test-only: clear the process-wide lag-failure cooldown. */
export function resetRegistryLagCooldownForTests(): void {
  processCooldown.since = undefined
}

export type InstallPackedDistributionOptions = {
  /** Replaces the default spawn, for tests. */
  run?: Exec
  /** Injectable clock (defaults to `Date.now`) for deterministic delay math. */
  clock?: () => number
  /** Injectable sleep (defaults to a real timer) for deterministic delays. */
  sleep?: (ms: number) => Promise<void>
  /**
   * Injectable cooldown anchor state. Defaults to the process-wide singleton;
   * tests pass a fresh object so assertions never depend on shared state.
   */
  cooldown?: CooldownState
  /** Return the final non-zero result instead of throwing, for negative controls. */
  allowFailure?: boolean
  /** Receives each retried failure's bounded stderr (defaults to `console.error`). */
  log?: (message: string) => void
}

/**
 * Run `bun install <args>` in `cwd`. On the registry-lag signature, wait out
 * the remaining window since the most recent distinct lag failure and retry
 * once with `--no-cache`. A lag failure arriving after the previous window has
 * elapsed re-anchors the window and pays the full delay. Within an unelapsed
 * window the cooldown is shared by all installs in the process, so a second
 * packing test does not pay another full window if the first one already
 * crossed it. On the transient signature, retry after each of
 * {@link TRANSIENT_INSTALL_RETRY_DELAYS_MS}. Every retried failure's bounded
 * stderr is logged, so a run that later passes still leaves its signature in
 * the output. Any other failure, or one whose retries are spent, throws a
 * {@link PackedInstallError} unless `allowFailure` is set.
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
  const log = options.log ?? console.error
  const maxTransientAttempts = TRANSIENT_INSTALL_RETRY_DELAYS_MS.length + 1

  let lagRetried = false
  let noCache = false
  let transientRetries = 0
  let attempts = 0
  for (;;) {
    attempts += 1
    const result = await run(['bun', 'install', ...args, ...(noCache ? ['--no-cache'] : [])], {
      cwd,
    })
    noCache = false
    if (result.exitCode === 0) return result
    const output = `${result.stdout}${result.stderr}`
    const stderr = boundedTail(result.stderr, INSTALL_STDERR_LIMIT)

    if (!lagRetried && isRegistryLagFailure(output)) {
      const now = clock()
      const state = options.cooldown ?? processCooldown
      let delay: number
      if (state.since === undefined || now - state.since >= REGISTRY_LAG_RETRY_DELAY_MS) {
        // No prior window, or the prior one has fully elapsed: this is a distinct
        // lag event, so anchor at now and pay the full window instead of flooring
        // the delay to 0 with a stale timestamp.
        state.since = now
        delay = REGISTRY_LAG_RETRY_DELAY_MS
      } else {
        // Still inside the anchor's window: share the remainder and keep the
        // original anchor.
        delay = REGISTRY_LAG_RETRY_DELAY_MS - (now - state.since)
      }
      log(
        `bun install hit the registry-lag signature; waiting ${Math.ceil(delay / 1000)}s then retrying with --no-cache:\n${stderr}`,
      )
      await sleep(delay)
      lagRetried = true
      noCache = true
      continue
    }

    const transientDelay = TRANSIENT_INSTALL_RETRY_DELAYS_MS[transientRetries]
    if (transientDelay !== undefined && isTransientInstallFailure(output)) {
      transientRetries += 1
      log(
        `bun install transient failure (attempt ${transientRetries} of ${maxTransientAttempts}); retrying in ${transientDelay / 1000}s:\n${stderr}`,
      )
      await sleep(transientDelay)
      continue
    }

    if (options.allowFailure) return result
    throw new PackedInstallError(
      formatInstallFailure(args, cwd, result, attempts),
      result,
      attempts,
    )
  }
}
