import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import manifest from './index'
import { parsePluginManifest } from '@defrex/autobuild/plugin-sdk'

describe('@defrex/autobuild-vercel-sandbox', () => {
  test('default export is a parseable plugin manifest registering vercel-sandbox', () => {
    const parsed = parsePluginManifest(manifest)
    expect(parsed.name).toBe('autobuild-vercel-sandbox')
    expect(Object.keys(parsed.workspaceProviders ?? {})).toEqual(['vercel-sandbox'])
    const registration = parsed.workspaceProviders?.['vercel-sandbox']
    expect(typeof (registration as { factory: unknown }).factory).toBe('function')
    expect((registration as { capabilities?: unknown }).capabilities).toBeDefined()
  })

  test('the guarded factory names AUT-505 when reached', () => {
    const registration = manifest.workspaceProviders?.['vercel-sandbox'] as {
      factory: () => unknown
    }
    expect(() => registration.factory()).toThrow('AUT-505')
  })

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
