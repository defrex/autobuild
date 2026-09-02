/** `ab models` lists the catalog resolved by the operator's local Pi CLI. */
import { checkLocalPi } from '../ports/runner/pi'
import { readLocalPiCatalog } from '../ports/runner/pi-rpc'

/** One catalog entry — a provider-qualified id, split for display. */
export interface PiCatalogEntry {
  provider: string
  id: string
}

/**
 * Fetch Pi's model catalog. `availableOnly` narrows to models whose provider
 * credentials are configured (a network/credential check); otherwise the full
 * offline catalog is returned.
 */
export type PiModelCatalogFn = (opts: { availableOnly: boolean }) => Promise<PiCatalogEntry[]>

const defaultCatalog: PiModelCatalogFn = async ({ availableOnly }) => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  await checkLocalPi(process.cwd(), env)
  return readLocalPiCatalog({ cwd: process.cwd(), env, availableOnly })
}

export interface AbModelsOptions {
  /** Case-insensitive substring over `provider/id`; absent ⇒ list everything. */
  query?: string
  /** Restrict to models with configured credentials. */
  availableOnly: boolean
  stdout: (line: string) => void
  /** Injectable for tests; defaults to the local Pi CLI catalog. */
  catalog?: PiModelCatalogFn
}

export async function abModels(opts: AbModelsOptions): Promise<void> {
  const catalog = opts.catalog ?? defaultCatalog
  const entries = await catalog({ availableOnly: opts.availableOnly })

  const needle = opts.query?.toLowerCase()
  const matched = (
    needle === undefined
      ? entries
      : entries.filter((e) => `${e.provider}/${e.id}`.toLowerCase().includes(needle))
  ).sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`))

  if (matched.length === 0) {
    opts.stdout(
      opts.query !== undefined
        ? `no Pi models match "${opts.query}"${opts.availableOnly ? ' with configured credentials' : ''}`
        : 'no Pi models found',
    )
    return
  }

  for (const e of matched) {
    opts.stdout(`${e.provider}/${e.id}`)
  }
  opts.stdout('')
  opts.stdout(
    `${matched.length} model(s) — paste a provider-qualified id into autobuild.toml [roles.default] or a concrete [roles.<name>] entry.`,
  )
}
