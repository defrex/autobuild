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
      for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1]!
        if (
          specifier === './dispatcher' ||
          specifier.startsWith('@defrex/autobuild-hosted-dispatcher')
        ) {
          offenders.push(`${file}: ${specifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
