/**
 * `ab models` (§9 companion) — a human lookup from a friendly model name to the
 * provider-qualified id the two-axis config wants. Pi's catalog is large and
 * its ids are provider-native (`openai/gpt-5.6-sol`, `moonshotai/kimi-k3`), so
 * "I want GLM 5.2 for code-review" needs a way to find `.../glm-5.2` before
 * editing autobuild.toml. This lists Pi's catalog filtered by a substring so
 * the id can be pasted straight into `[roles.default]` or a concrete role.
 *
 * The SDK import sits behind an injectable seam (like PiAgentRunner's factory)
 * so the command is unit-testable offline.
 */

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
  let sdk: typeof import('@earendil-works/pi-coding-agent')
  try {
    sdk = await import('@earendil-works/pi-coding-agent')
  } catch (error) {
    throw new Error(
      `ab models: could not load the pi SDK ("@earendil-works/pi-coding-agent") — ` +
        `install it. Original error: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  // Full catalog is available offline; the availability check needs the network.
  const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: availableOnly })
  const models = availableOnly ? await runtime.getAvailable() : runtime.getModels()
  return models.map((m) => ({ provider: m.provider, id: m.id }))
}

export interface AbModelsOptions {
  /** Case-insensitive substring over `provider/id`; absent ⇒ list everything. */
  query?: string
  /** Restrict to models with configured credentials. */
  availableOnly: boolean
  stdout: (line: string) => void
  /** Injectable for tests; defaults to the real Pi SDK catalog. */
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
