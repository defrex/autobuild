import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { storeSchema } from '../config/schema'

/** Store selection happens before full dispatch configuration is loaded. */
export function configuredStore(checkout: string): string | undefined {
  let text: string
  try {
    text = readFileSync(join(checkout, 'autobuild.toml'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const table = parse(text)
  return table.store === undefined ? undefined : storeSchema.parse(table.store).url
}
