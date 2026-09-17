import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * The store service hosts state only: after the hosted dispatcher moved to
 * `@defrex/autobuild-hosted-dispatcher`, no module here may import it and the
 * manifest must neither export it nor depend on it or on any workspace
 * sandbox provider. A deployment that installs only the store service then
 * never loads the dispatcher's kernel/provider closure.
 */
const packageDirectory = join(import.meta.dir, '..')

async function readManifest(): Promise<{
  exports?: Record<string, unknown>
  dependencies?: Record<string, unknown>
  peerDependencies?: Record<string, unknown>
}> {
  return JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as {
    exports?: Record<string, unknown>
    dependencies?: Record<string, unknown>
    peerDependencies?: Record<string, unknown>
  }
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path)
  }
  return files
}

/**
 * Specifiers that would load the dispatcher. Applied to every import form the
 * scanner recognizes.
 */
const DISPATCHER_SPECIFIER = /^(\.\/dispatcher$)|(^@defrex\/autobuild-hosted-dispatcher)/

/**
 * Extract dispatcher specifiers from a module's text, across every import form
 * that could load it: static `from` specifiers (including `export ... from`),
 * bare side-effect `import '...'`, dynamic `import('...')` with either a quoted
 * or a template-literal specifier, and `require('...')` (defensively; the
 * package is ESM and has no require today). A static-only scan would let a
 * side-effect or dynamic import silently reintroduce the dispatcher's
 * kernel/provider closure.
 */
export function dispatcherSpecifiers(text: string): string[] {
  const specifiers: string[] = []
  const patterns = [
    /from\s+['"]([^'"]+)['"]/g, // static import/export-from
    /\bimport\s+['"]([^'"]+)['"]/g, // side-effect import
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g, // dynamic import()
    /\bimport\s*\(\s*`([^`]+)`/g, // dynamic import() with a template-literal specifier
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g, // require() if one ever appears
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1]!
      if (DISPATCHER_SPECIFIER.test(specifier)) specifiers.push(specifier)
    }
  }
  return specifiers
}

describe('hosted-store-service package boundary', () => {
  test('manifest has no dispatcher export and no dispatcher or provider dependency', async () => {
    const manifest = await readManifest()
    expect(Object.keys(manifest.exports ?? {})).not.toContain('./dispatcher')
    const dependencyNames = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]
    expect(dependencyNames.filter((name) => name.includes('hosted-dispatcher'))).toEqual([])
    expect(
      dependencyNames.filter(
        (name) => name === '@vercel/sandbox' || name.startsWith('@defrex/autobuild-'),
      ),
    ).toEqual(['@defrex/autobuild-postgres-store'])
  })

  test('no module imports the dispatcher', async () => {
    const files = await sourceFiles(join(packageDirectory, 'src'))
    expect(files.length).toBeGreaterThan(0)
    const offenders: string[] = []
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      for (const specifier of dispatcherSpecifiers(text)) {
        offenders.push(`${file}: ${specifier}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('scan flags side-effect and dynamic dispatcher imports, not just static ones', () => {
    // Positive: every import form that could load the dispatcher is flagged.
    expect(
      dispatcherSpecifiers("import { kernel } from '@defrex/autobuild-hosted-dispatcher/kernel'"),
    ).toEqual(['@defrex/autobuild-hosted-dispatcher/kernel'])
    expect(dispatcherSpecifiers("import './dispatcher'")).toEqual(['./dispatcher'])
    expect(
      dispatcherSpecifiers("const m = await import('@defrex/autobuild-hosted-dispatcher')"),
    ).toEqual(['@defrex/autobuild-hosted-dispatcher'])
    expect(dispatcherSpecifiers("const d = require('./dispatcher')")).toEqual(['./dispatcher'])
    expect(
      dispatcherSpecifiers(
        `const m = await import(
  './dispatcher'
)`,
      ),
    ).toEqual(['./dispatcher'])
    expect(dispatcherSpecifiers('const m = await import(`./dispatcher`)')).toEqual(['./dispatcher'])
    expect(
      dispatcherSpecifiers('const m = await import(`@defrex/autobuild-hosted-dispatcher`)'),
    ).toEqual(['@defrex/autobuild-hosted-dispatcher'])
    expect(
      dispatcherSpecifiers(
        `const m = await import(\`@defrex/autobuild-hosted-dispatcher/\${name}\`)`,
      ),
    ).toEqual([`@defrex/autobuild-hosted-dispatcher/\${name}`])

    // Negative controls: legitimate specifiers stay clean.
    expect(
      dispatcherSpecifiers("import { store } from '@defrex/autobuild-postgres-store'"),
    ).toEqual([])
    expect(dispatcherSpecifiers("import './service'")).toEqual([])
    expect(dispatcherSpecifiers("void import('@defrex/autobuild-postgres-store')")).toEqual([])
    expect(dispatcherSpecifiers("import { x } from '@defrex/autobuild'")).toEqual([])

    // Backtick specifiers unrelated to the dispatcher stay clean; interpolation
    // alone is not a false positive.
    expect(dispatcherSpecifiers('void import(`./service`)')).toEqual([])
    expect(dispatcherSpecifiers('import(`@defrex/autobuild-postgres-store`)')).toEqual([])
    expect(dispatcherSpecifiers(`import(\`./\${name}\`)`)).toEqual([])

    // Limitation, by design: a dynamic import whose specifier is a bare
    // variable (`import(pkgVar)`) or whose text is reshaped by interpolation
    // (e.g. `import(`./dispatch${kind}`)`) cannot be caught by text matching
    // and stays outside this scan's claimed reach.
  })
})
