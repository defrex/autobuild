import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { currentDesignFrontMatter, designFrontMatter, designSidecarTokens } from './design-doc'

const repo = join(import.meta.dir, '../../..')
const hint = 'regenerate with `bun run ui:tokens`'

test('DESIGN.md front matter matches tokens.ts', async () => {
  const design = await Bun.file(join(repo, 'DESIGN.md')).text()
  const committed = currentDesignFrontMatter(design)
  if (committed !== designFrontMatter()) throw new Error(`DESIGN.md front matter is stale; ${hint}`)
  expect(committed).toBe(designFrontMatter())
})

test('.impeccable/design.json token keys match tokens.ts', async () => {
  const sidecar = JSON.parse(await Bun.file(join(repo, '.impeccable/design.json')).text()) as {
    extensions: Record<string, unknown>
  }
  for (const [key, value] of Object.entries(designSidecarTokens())) {
    if (JSON.stringify(sidecar.extensions[key]) !== JSON.stringify(value))
      throw new Error(`.impeccable/design.json extensions.${key} is stale; ${hint}`)
    expect(sidecar.extensions[key]).toEqual(value)
  }
})
