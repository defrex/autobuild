/**
 * Minimal local .env loader for the `ab` binary: `KEY=VALUE` lines, `#`
 * comments, optional matching quotes around the value, optional `export `
 * prefix. Values never override variables already present in the environment
 * — the real environment wins, so a checked-in .env cannot shadow runner-set
 * ambient auth (D8). Bun auto-loads .env when running bin/ab.ts directly;
 * this loader makes the behavior explicit and Node-portable.
 */
import { readFileSync } from 'node:fs'

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Parse .env text into key/value pairs; malformed lines are skipped. */
export function parseDotEnv(raw: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    let trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (trimmed.startsWith('export ')) trimmed = trimmed.slice('export '.length)
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    if (!KEY_PATTERN.test(key)) continue
    let value = trimmed.slice(eq + 1).trim()
    const quote = value[0]
    if (
      (quote === '"' || quote === "'") &&
      value.length >= 2 &&
      value.endsWith(quote)
    ) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

/**
 * Load `path` into `env` if the file exists (silently a no-op otherwise).
 * Only keys not already set in `env` are written.
 */
export function loadDotEnv(
  path: string,
  env: Record<string, string | undefined>,
): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const [key, value] of Object.entries(parseDotEnv(raw))) {
    if (env[key] === undefined) env[key] = value
  }
}
