/**
 * TicketSource factory (SPEC §3.2, §13): construct the source the [tickets]
 * config table names. The Linear API key is a secret, so it never lives in
 * autobuild.toml — it comes from the LINEAR_API_KEY environment variable
 * (a local .env file works via the CLI's loader), and a missing key is a
 * hard error naming the variable (D6 discipline).
 */
import type { TicketsConfig } from '../../config/schema'
import type { TicketSource } from '../types'
import { FileTicketSource } from './file'
import { LinearTicketSource } from './linear'

export function createTicketSource(
  config: TicketsConfig,
  env: Record<string, string | undefined>,
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

  if (config.dir === undefined) {
    throw new Error(
      '[tickets].source = "file" requires dir — the directory holding <id>.md ticket files',
    )
  }
  return new FileTicketSource({
    dir: config.dir,
    ...(config.createState !== undefined
      ? { createState: config.createState }
      : {}),
  })
}
