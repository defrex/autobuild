/**
 * TicketSource factory (SPEC §3.2, §13): construct the source the [tickets]
 * config table names. The Linear API key is a secret, so it never lives in
 * autobuild.toml — it comes from the LINEAR_API_KEY environment variable
 * (a local .env file works via the CLI's loader), and a missing key is a
 * hard error naming the variable (D6 discipline).
 *
 * This factory is also the single place that knows how a file tracker's
 * directory is decided, because three facts have to be settled together and
 * only here are all three in scope: the default (`.autobuild/tickets`), the
 * repo-relative → absolute resolution, and whether the directory was DEFAULTED
 * (which decides `selfIgnore`). Filling `dir` in earlier would destroy that
 * last bit before the adapter is constructed.
 */
import { resolve } from 'node:path'
import type { TicketsConfig } from '../../config/schema'
import type { TicketSource } from '../types'
import { DEFAULT_TICKETS_DIR, FileTicketSource } from './file'
import { LinearTicketSource } from './linear'

export function createTicketSource(
  config: TicketsConfig,
  env: Record<string, string | undefined>,
  /** A relative [tickets].dir is relative to the repo, not this process's cwd. */
  targetRepo: string,
): TicketSource {
  if (config.source === 'linear') {
    const apiKey = env['LINEAR_API_KEY']
    if (apiKey === undefined || apiKey === '') {
      throw new Error(
        'LINEAR_API_KEY is not set — expected a Linear personal API key; ' +
          'required when [tickets].source = "linear". Set it in the ' +
          'environment or a local .env file.',
      )
    }
    // teamKey presence is cross-validated at config parse; re-checked here
    // because the type leaves it optional for the file source.
    if (config.teamKey === undefined) {
      throw new Error(
        '[tickets].source = "linear" requires teamKey — the Linear team key (e.g. "ENG")',
      )
    }
    return new LinearTicketSource({
      apiKey,
      teamKey: config.teamKey,
      ...(config.claimedState !== undefined
        ? { claimedState: config.claimedState }
        : {}),
      ...(config.createState !== undefined
        ? { createState: config.createState }
        : {}),
    })
  }

  return new FileTicketSource({
    dir: resolve(targetRepo, config.dir ?? DEFAULT_TICKETS_DIR),
    // Only the DEFAULTED backlog hides itself from git. An explicit dir is the
    // user's directory — possibly tracked on purpose — and silently dropping it
    // out of `git status` would be a bad, hard-to-notice failure.
    selfIgnore: config.dir === undefined,
    ...(config.createState !== undefined
      ? { createState: config.createState }
      : {}),
  })
}
