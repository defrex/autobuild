/**
 * autobuild.toml loading (SPEC §16.1, D9).
 *
 * Branch-owned worktree config and supplied immutable text are parsed as
 * one-shot inputs: `parseConfig(text)` is the primary API, while
 * `loadConfig(path)` is a disk convenience for scoped CLI and local tooling.
 * The running dispatcher has a separate live-reload context: `LiveConfig`
 * reads the main checkout, retains its last valid snapshot across rejected
 * candidates, and lets each action capture the current snapshot at its boundary.
 */
import { parse as parseToml, TomlError } from 'smol-toml'
import type { z } from 'zod'
import { expandIssues } from '../zod-issues'
import { configSchema, TOP_LEVEL_SCALARS, TOP_LEVEL_TABLES, type Config } from './schema'

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
    if (issue.keys.includes('server')) {
      message +=
        ' — [server] was removed; arrange any application lifecycle inside the verify command or skill'
    }
    message +=
      ` — known top-level keys: ${TOP_LEVEL_SCALARS.join(', ')}; ` +
      `known tables: ${TOP_LEVEL_TABLES.join(', ')}`
  }
  const removedNeedsServer =
    (issue.code === 'unrecognized_keys' && issue.keys.includes('needsServer')) ||
    message.includes('"needsServer"')
  if (removedNeedsServer) {
    message +=
      " — needsServer was removed; arrange any application lifecycle inside this step's command or skill"
  }
  const path =
    removedNeedsServer && issue.path.at(-1) !== 'needsServer'
      ? [...issue.path, 'needsServer']
      : issue.path
  return `  ${formatPath(path)}: ${message}`
}

export function parseConfig(
  tomlText: string,
  source = 'autobuild.toml',
  warn: (message: string) => void = console.error,
): Config {
  let table: unknown
  try {
    table = parseToml(tomlText)
  } catch (error) {
    if (error instanceof TomlError) {
      throw new ConfigError(`${source}: TOML syntax error: ${error.message}`)
    }
    throw error
  }

  if (table && typeof table === 'object' && 'orchestrator' in table) {
    const orchestrator = table.orchestrator
    if (orchestrator && typeof orchestrator === 'object') {
      const removed = ['model', 'invocationBudgetSeconds', 'approvals', 'wake'].filter((key) =>
        Object.hasOwn(orchestrator, key),
      )
      if (removed.length > 0) {
        throw new ConfigError(
          `${source}: [orchestrator].${removed.join(', [orchestrator].')} removed: the embedded runner was removed; operators run externally. Keep only enabled and sandbox settings.`,
        )
      }
    }
  }
  const result = configSchema.safeParse(table)
  if (!result.success) {
    // Expanded for the operator, raw for the payload: the expanded copies carry
    // synthesized `option N of M:` messages, while `ConfigError.issues` should
    // stay what validation actually reported.
    const details = expandIssues(result.error.issues).map(describeIssue).join('\n')
    throw new ConfigError(`${source}: invalid config\n${details}`, result.error.issues)
  }
  if (table && typeof table === 'object' && Object.hasOwn(table, 'landing')) {
    warn(`${source}: [[landing]] is deprecated; use [[merge]] instead`)
  }
  return result.data
}

export async function loadConfig(path: string): Promise<Config> {
  const text = await Bun.file(path).text()
  return parseConfig(text, path)
}
