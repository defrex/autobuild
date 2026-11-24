import { expect, test } from 'bun:test'

test('launcher transitive graph is eagerly loaded filesystem/process code', async () => {
  const { readFile } = await import('node:fs/promises')
  const { resolve, dirname } = await import('node:path')
  const visited = new Set<string>()
  const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
  async function visit(file: string): Promise<void> {
    if (visited.has(file)) return
    visited.add(file)
    const source = transpiler.transformSync(await readFile(file, 'utf8'))
    expect(source, file).not.toMatch(/\bimport\s*\(/)
    for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
      const path = resolve(dirname(file), `${match[1]}.ts`)
      expect(path).not.toMatch(/\/(store|kernel|plugins|ports)\//)
      await visit(path)
    }
  }
  await visit(resolve(import.meta.dir, 'dispatch-launcher.ts'))
  expect(visited.size).toBeGreaterThan(5)
})
