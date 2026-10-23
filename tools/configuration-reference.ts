import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { configurationReference, renderFields } from '../packages/core/src/config/reference'

const REGENERATE = 'bun run docs:configuration'
type Regions = Record<string, string>
type RegionSource = Regions | (() => Regions)
export function rewriteConfigurationReference(
  document: string,
  source: RegionSource = () =>
    Object.fromEntries(
      Object.entries(configurationReference()).map(([name, fields]) => [
        name,
        renderFields(fields),
      ]),
    ),
): string {
  const regions = typeof source === 'function' ? source() : source
  const marker = /^<!-- configuration-reference:([^\n]*?) -->$/gm
  const tokens = [...document.matchAll(marker)]
  if ((document.match(/<!-- configuration-reference:/g) ?? []).length !== tokens.length)
    throw new Error('Malformed configuration-reference marker')
  const seen = new Set<string>()
  let cursor = 0
  let result = ''
  for (let index = 0; index < tokens.length; index += 2) {
    const start = tokens[index]!
    const end = tokens[index + 1]
    const name = start[1]!
    if (name.startsWith('/') || !end || end[1] !== `/${name}`)
      throw new Error(`Unbalanced configuration-reference markers at ${name}`)
    if (!Object.hasOwn(regions, name))
      throw new Error(`Unknown configuration-reference region ${name}`)
    if (seen.has(name)) throw new Error(`Duplicate configuration-reference region ${name}`)
    seen.add(name)
    result += document.slice(cursor, start.index! + start[0].length)
    result += `\n\n${regions[name]!.trimEnd()}\n\n`
    cursor = end.index!
    result += end[0]
    cursor += end[0].length
  }
  const missing = Object.keys(regions).filter((name) => !seen.has(name))
  if (missing.length)
    throw new Error(`Missing configuration-reference regions: ${missing.join(', ')}`)
  return result + document.slice(cursor)
}
export async function updateConfigurationReference(
  path: string,
  mode: '--write' | '--check',
  regions?: RegionSource,
): Promise<void> {
  try {
    const existing = await readFile(path, 'utf8')
    const expected = rewriteConfigurationReference(existing, regions)
    if (mode === '--write') {
      if (expected !== existing) await writeFile(path, expected)
    } else if (existing !== expected) {
      throw new Error('Generated configuration reference is stale')
    }
  } catch (error) {
    throw new Error(
      `${path}: ${error instanceof Error ? error.message : String(error)}. Regenerate with ${REGENERATE}.`,
    )
  }
}
if (import.meta.main) {
  const mode = process.argv[2]
  if (process.argv.length !== 3 || (mode !== '--write' && mode !== '--check')) {
    console.error('Usage: bun tools/configuration-reference.ts --write|--check')
    process.exitCode = 1
  } else {
    try {
      await updateConfigurationReference(resolve(import.meta.dir, '../docs/configuration.md'), mode)
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
