import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

describe('@defrex/autobuild-vercel-sandbox', () => {
  test('every @defrex/autobuild specifier in src/ is exactly the plugin-sdk entry', async () => {
    const directory = join(import.meta.dir)
    const files = (await readdir(directory)).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.spec.ts'),
    )
    expect(files).toContain('index.ts')
    const offenders: string[] = []
    for (const file of files) {
      const text = await readFile(join(directory, file), 'utf8')
      for (const match of text.matchAll(/['"](@defrex\/autobuild[^'"]*)['"]/g)) {
        if (match[1] !== '@defrex/autobuild/plugin-sdk') offenders.push(`${file}: ${match[1]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
