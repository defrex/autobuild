import { describe, expect, test } from 'bun:test'
import { abModels, type PiCatalogEntry, type PiModelCatalogFn } from './models'

function fakeCatalog(
  all: PiCatalogEntry[],
  available: PiCatalogEntry[] = all,
): { catalog: PiModelCatalogFn; calls: Array<{ availableOnly: boolean }> } {
  const calls: Array<{ availableOnly: boolean }> = []
  const catalog: PiModelCatalogFn = async ({ availableOnly }) => {
    calls.push({ availableOnly })
    return availableOnly ? available : all
  }
  return { catalog, calls }
}

const CATALOG: PiCatalogEntry[] = [
  { provider: 'openai', id: 'gpt-5.6-sol' },
  { provider: 'moonshotai', id: 'kimi-k3' },
  { provider: 'cerebras', id: 'zai-glm-4.7' },
  { provider: 'openrouter', id: 'z-ai/glm-5.2' },
]

function collect(): { stdout: (line: string) => void; lines: string[] } {
  const lines: string[] = []
  return { stdout: (line) => lines.push(line), lines }
}

describe('abModels', () => {
  test('filters the catalog by a case-insensitive substring over provider/id', async () => {
    const { catalog } = fakeCatalog(CATALOG)
    const { stdout, lines } = collect()
    await abModels({ query: 'GLM', availableOnly: false, stdout, catalog })

    expect(lines).toContain('cerebras/zai-glm-4.7')
    expect(lines).toContain('openrouter/z-ai/glm-5.2')
    expect(lines).not.toContain('openai/gpt-5.6-sol')
    expect(lines.at(-1)).toBe(
      '2 model(s) — paste a provider-qualified id into autobuild.toml [roles.default] or a concrete [roles.<name>] entry.',
    )
  })

  test('lists everything (sorted) when no query is given', async () => {
    const { catalog } = fakeCatalog(CATALOG)
    const { stdout, lines } = collect()
    await abModels({ availableOnly: false, stdout, catalog })

    const ids = lines.filter((l) => l.includes('/'))
    expect(ids).toEqual([
      'cerebras/zai-glm-4.7',
      'moonshotai/kimi-k3',
      'openai/gpt-5.6-sol',
      'openrouter/z-ai/glm-5.2',
    ])
  })

  test('--available narrows to credentialed models and passes the flag through', async () => {
    const { catalog, calls } = fakeCatalog(CATALOG, [{ provider: 'openai', id: 'gpt-5.6-sol' }])
    const { stdout, lines } = collect()
    await abModels({ query: 'gpt', availableOnly: true, stdout, catalog })

    expect(calls).toEqual([{ availableOnly: true }])
    expect(lines).toContain('openai/gpt-5.6-sol')
    expect(lines.at(-1)).toContain('1 model(s)')
  })

  test('reports a clean miss', async () => {
    const { catalog } = fakeCatalog(CATALOG)
    const { stdout, lines } = collect()
    await abModels({ query: 'llama', availableOnly: false, stdout, catalog })

    expect(lines).toEqual(['no Pi models match "llama"'])
  })
})
