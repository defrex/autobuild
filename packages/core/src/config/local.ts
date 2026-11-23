/**
 * Local configuration overrides (SPEC §16.1): an uncommitted
 * `.autobuild/local.toml` beside a checkout's `autobuild.toml`, layered over
 * it for every process that reads configuration from that checkout.
 *
 * Only an allowlist of top-level sections may be overridden. Every root key
 * declares its classification below, so a section added later is a type error
 * until someone decides whether it is personal or shared. The layer merges raw
 * TOML tables before schema validation: defaults, open-map handling and every
 * cross-field rule run on the merged input exactly as they do for
 * `autobuild.toml`, and an invalid local value gets the message the setting
 * gets in `autobuild.toml`, naming the local file.
 */
import { join } from 'node:path'
import { ConfigError, parseConfigTable, validateConfigTable } from './load'
import type { Config, configRootSchema } from './schema'

/** Location of the local override file, relative to the checkout root. */
export const LOCAL_CONFIG_RELATIVE_PATH = '.autobuild/local.toml'

export function localConfigPath(repoRoot: string): string {
  return join(repoRoot, '.autobuild', 'local.toml')
}

export type LocalOverrideClass = 'local' | 'committed'

/**
 * Whether each raw root key may be set in `.autobuild/local.toml`. Keyed by the
 * raw root schema (which carries both `merge` and the deprecated `landing`), so
 * adding a root key without a classification fails to compile.
 */
export const LOCAL_OVERRIDE_CLASSIFICATION = {
  // The local machine and process: how much work it runs, how often it scans,
  // whether it adopts runtime upgrades.
  capacity: 'local',
  ticketScanIntervalSeconds: 'local',
  upgrade: 'local',
  // Personal notifications.
  hooks: 'local',
  // Which model subscriptions a person holds.
  roles: 'local',
  accounts: 'local',
  // Must agree across everyone sharing the store, ticket source and forge.
  store: 'committed',
  baseBranch: 'committed',
  forge: 'committed',
  plugins: 'committed',
  merge: 'committed',
  landing: 'committed',
  pr: 'committed',
  generated: 'committed',
  profiles: 'committed',
  policy: 'committed',
  orchestrator: 'committed',
  tickets: 'committed',
  // Build-owned: a build's pipeline comes from its own branch on every machine.
  workspace: 'committed',
  commands: 'committed',
  verify: 'committed',
  finalize: 'committed',
} as const satisfies { [K in keyof typeof configRootSchema.shape]: LocalOverrideClass }

export type ConfigRootKey = keyof typeof LOCAL_OVERRIDE_CLASSIFICATION

/** The sections a local file may set, in declaration order. */
export const LOCAL_OVERRIDE_KEYS = (
  Object.keys(LOCAL_OVERRIDE_CLASSIFICATION) as ConfigRootKey[]
).filter((key) => LOCAL_OVERRIDE_CLASSIFICATION[key] === 'local')

/** Which settings a dispatcher's effective configuration took from a local file. */
export interface LocalOverrideRecord {
  /** Path of the local file as the reading process named it. */
  file: string
  /** Sorted dotted leaf paths the file sets; an array is one leaf. */
  settings: string[]
}

export interface ConfigText {
  text: string
  source: string
}

export interface LayeredConfig {
  config: Config
  localOverrides?: LocalOverrideRecord
}

function isTable(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}

/**
 * Merge two raw TOML tables key by key: tables merge recursively; scalars,
 * arrays (including arrays of tables) and a type mismatch replace whole. Inputs
 * are never mutated. Keys are defined, never assigned, so an open-map entry
 * named `__proto__` survives as an own key.
 */
export function mergeConfigTables(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = Object.create(null)
  const define = (key: string, value: unknown) =>
    Object.defineProperty(merged, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  for (const key of Object.keys(base)) define(key, base[key])
  for (const key of Object.keys(local)) {
    const over = local[key]
    const under = Object.hasOwn(base, key) ? base[key] : undefined
    define(key, isTable(under) && isTable(over) ? mergeConfigTables(under, over) : over)
  }
  return merged
}

function pathSegment(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
}

/** Sorted dotted leaf paths a local table sets. An array is a leaf; an empty
 * table contributes its own path. */
export function localOverrideSettings(table: Record<string, unknown>): string[] {
  const settings: string[] = []
  const walk = (value: Record<string, unknown>, prefix: string) => {
    for (const key of Object.keys(value)) {
      const path = prefix === '' ? pathSegment(key) : `${prefix}.${pathSegment(key)}`
      const child = value[key]
      if (isTable(child) && Object.keys(child).length > 0) walk(child, path)
      else settings.push(path)
    }
  }
  walk(table, '')
  return settings.sort()
}

function rejectedKeys(local: ConfigText, table: Record<string, unknown>): string[] {
  const allowed = `local overrides accept ${LOCAL_OVERRIDE_KEYS.join(', ')}`
  const committed: string[] = []
  const unknown: string[] = []
  for (const key of Object.keys(table)) {
    const classification = Object.hasOwn(LOCAL_OVERRIDE_CLASSIFICATION, key)
      ? LOCAL_OVERRIDE_CLASSIFICATION[key as ConfigRootKey]
      : undefined
    if (classification === 'local') continue
    if (classification === 'committed')
      committed.push(`${local.source}: ${key} can only be set in autobuild.toml — ${allowed}`)
    else
      unknown.push(
        `${local.source}: ${JSON.stringify(key)} is not a configuration setting — ${allowed}`,
      )
  }
  return [...committed, ...unknown]
}

/**
 * Parse `autobuild.toml` text layered with an optional local override file.
 *
 * The committed file is validated alone first, so its errors name it exactly
 * as `parseConfig` would. The local file is then checked against the
 * allowlist and merged; any failure after that point was introduced by the
 * local layer and names the local file.
 */
export function parseLayeredConfig(
  input: { committed: ConfigText; local?: ConfigText },
  warn: (message: string) => void = console.error,
): LayeredConfig {
  const { committed, local } = input
  const committedTable = parseConfigTable(committed.text, committed.source)
  const committedConfig = validateConfigTable(committedTable, committed.source, warn)
  if (local === undefined) return { config: committedConfig }

  const localTable = parseConfigTable(local.text, local.source)
  const rejected = rejectedKeys(local, localTable)
  if (rejected.length > 0) throw new ConfigError(rejected.join('\n'))

  // Deprecations were already reported for the committed file, and the local
  // file cannot set the deprecated spelling.
  const config = validateConfigTable(
    mergeConfigTables(committedTable, localTable),
    local.source,
    () => {},
  )
  const settings = localOverrideSettings(localTable)
  return settings.length > 0
    ? { config, localOverrides: { file: local.source, settings } }
    : { config }
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Read a checkout's local override file; `undefined` when it does not exist. */
export async function readLocalConfig(repoRoot: string): Promise<ConfigText | undefined> {
  const source = localConfigPath(repoRoot)
  try {
    return { text: await Bun.file(source).text(), source }
  } catch (error) {
    if (missing(error)) return undefined
    throw new ConfigError(
      `${source} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
