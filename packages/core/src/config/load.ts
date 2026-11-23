/**
 * autobuild.toml loading (SPEC §16.1, D9).
 *
 * Branch-owned worktree config and supplied immutable text are parsed as
 * one-shot inputs: `parseConfig(text)` is the primary API, while
 * `loadConfig(path)` reads a checkout for scoped CLI and local tooling, layering
 * the checkout's uncommitted `.autobuild/local.toml` over `autobuild.toml`
 * (see `./local`). The running dispatcher has a separate live-reload context:
 * `LiveConfig` reads the main checkout's two files as one candidate, retains its
 * last valid snapshot across rejected candidates, and lets each action capture
 * the current snapshot at its boundary.
 */
import { dirname } from 'node:path'
import { parse as parseToml, TomlError } from 'smol-toml'
import type { z } from 'zod'
import { expandIssues } from '../zod-issues'
import { parseLayeredConfig, readLocalConfig } from './local'
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

/** The hook a redefinition error points at, when the offending line is a
 * `[hooks.<name>]` header; other syntax errors keep the generic message. */
function duplicateHookName(text: string, error: TomlError): string | undefined {
  if (!error.message.includes('redefine')) return undefined
  const line = text.split(/\r?\n/)[error.line - 1]
  const match =
    line === undefined
      ? null
      : /^\s*\[\s*hooks\s*\.\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*\]/.exec(line)
  if (match === null) return undefined
  const name = match[1]!
  return name.startsWith('"') || name.startsWith("'") ? name.slice(1, -1) : name
}

/** Parse TOML text into a raw table, naming `source` in every syntax error.
 * No schema validation happens here: layered readers merge raw tables first
 * (see `./local`) so defaults and cross-validation see the merged input. */
export function parseConfigTable(
  tomlText: string,
  source = 'autobuild.toml',
): Record<string, unknown> {
  try {
    return parseToml(tomlText) as Record<string, unknown>
  } catch (error) {
    if (error instanceof TomlError) {
      const hook = duplicateHookName(tomlText, error)
      if (hook !== undefined)
        throw new ConfigError(
          `${source}: duplicate hook name ${JSON.stringify(hook)} — declare each [hooks.<name>] table once`,
        )
      throw new ConfigError(`${source}: TOML syntax error: ${error.message}`)
    }
    throw error
  }
}

/** Validate a raw configuration table; every error names `source`. Deprecated
 * spellings are reported through `warn` after validation succeeds. */
export function validateConfigTable(
  table: Record<string, unknown>,
  source = 'autobuild.toml',
  warn: (message: string) => void = console.error,
): Config {
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

/**
 * Parse and validate autobuild.toml text. Deprecated spellings are reported
 * through `warn` after validation succeeds; invalid text throws first. The
 * `console.error` default suits explicit one-shot reads (scoped CLI commands,
 * `ab init`, `ab upgrade`). Recurring or internal callers — the dispatcher and
 * pipeline-source resolution — pass their own sink, a collector or a no-op, so
 * a deprecation is reported once per startup or changed file instead of per
 * phase launch.
 *
 * This reads committed text only. Readers of a checkout use `loadConfig`,
 * which layers the checkout's `.autobuild/local.toml` over it.
 */
export function parseConfig(
  tomlText: string,
  source = 'autobuild.toml',
  warn: (message: string) => void = console.error,
): Config {
  return validateConfigTable(parseConfigTable(tomlText, source), source, warn)
}

/**
 * Read a checkout's configuration: `path` (its `autobuild.toml`) layered with
 * the sibling `.autobuild/local.toml` when that file exists. Without a local
 * file the result is exactly `parseConfig` of `path`.
 */
export async function loadConfig(
  path: string,
  warn: (message: string) => void = console.error,
): Promise<Config> {
  const text = await Bun.file(path).text()
  const local = await readLocalConfig(dirname(path))
  return parseLayeredConfig({ committed: { text, source: path }, local }, warn).config
}
