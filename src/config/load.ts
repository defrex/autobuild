/**
 * autobuild.toml loading (SPEC §16.1, D9).
 *
 * Config is read from the build's *branch* at workspace provision (D9), so
 * every build sees one consistent config — the caller typically has the file
 * content (e.g. `git show <branch>:autobuild.toml`), not a checked-out path.
 * `parseConfig(text)` is therefore the primary API; `loadConfig(path)` is the
 * disk convenience for the CLI and local tooling.
 */
import { parse as parseToml, TomlError } from 'smol-toml'
import type { z } from 'zod'
import { configSchema, TOP_LEVEL_TABLES, type Config } from './schema'

/**
 * Config failures are feedback to whoever edits the file: the message carries
 * the source name, the path of every problem, and what would be accepted.
 */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues?: unknown,
  ) {
    super(message)
    this.name = 'ConfigError'
  }
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return '(top level)'
  return path
    .map((segment, index) =>
      typeof segment === 'number'
        ? `[${segment}]`
        : index === 0
          ? String(segment)
          : `.${String(segment)}`,
    )
    .join('')
}

function describeIssue(issue: z.core.$ZodIssue): string {
  let message = issue.message
  if (issue.code === 'unrecognized_keys' && issue.path.length === 0) {
    if (issue.keys.includes('agent')) {
      message +=
        ' — [agent] was removed; move those fields to [roles.default] ' +
        '(the default entry in [roles])'
    }
    message += ` — known tables: ${TOP_LEVEL_TABLES.join(', ')}`
  }
  return `  ${formatPath(issue.path)}: ${message}`
}

export function parseConfig(tomlText: string, source = 'autobuild.toml'): Config {
  let table: unknown
  try {
    table = parseToml(tomlText)
  } catch (error) {
    if (error instanceof TomlError) {
      throw new ConfigError(`${source}: TOML syntax error: ${error.message}`)
    }
    throw error
  }

  const result = configSchema.safeParse(table)
  if (!result.success) {
    const details = result.error.issues.map(describeIssue).join('\n')
    throw new ConfigError(`${source}: invalid config\n${details}`, result.error.issues)
  }
  return result.data
}

export async function loadConfig(path: string): Promise<Config> {
  const text = await Bun.file(path).text()
  return parseConfig(text, path)
}
