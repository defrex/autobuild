/**
 * Regenerate every file derived from `packages/ui/src/tokens.ts`:
 * `src/generated/tokens.css`, the front matter of the root `DESIGN.md`, and
 * the generated keys of `.impeccable/design.json`.
 *
 *   bun run ui:tokens
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { withDesignFrontMatter, withDesignSidecar } from '../src/design-doc'
import { tokensCss } from '../src/tokens-css'

const pkg = resolve(import.meta.dir, '..')
const repo = resolve(pkg, '../..')

async function update(path: string, next: (current: string) => string) {
  const current = await readFile(path, 'utf8')
  const updated = next(current)
  if (updated !== current) await writeFile(path, updated)
  console.log(`${updated === current ? 'unchanged' : 'wrote'} ${path}`)
}

const css = join(pkg, 'src/generated/tokens.css')
await writeFile(css, tokensCss())
console.log(`wrote ${css}`)
await update(join(repo, 'DESIGN.md'), withDesignFrontMatter)
await update(join(repo, '.impeccable/design.json'), (json) => withDesignSidecar(json))
