import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

interface DispatcherManifest {
  name?: unknown
  version?: unknown
  engines?: { bun?: unknown }
  exports?: Record<string, unknown>
  bin?: Record<string, unknown>
  peerDependencies?: Record<string, unknown>
  private?: unknown
  publishConfig?: { access?: unknown }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

const manifest = (await readJson(join(import.meta.dir, '..', 'package.json'))) as DispatcherManifest

describe('hosted-dispatcher package manifest', () => {
  test('is the published @defrex/autobuild-hosted-dispatcher at the workspace version', async () => {
    expect(manifest.name).toBe('@defrex/autobuild-hosted-dispatcher')
    const root = await readJson(join(import.meta.dir, '..', '..', '..', 'package.json'))
    expect(manifest.version).toBe(root.version)
    expect(manifest.engines?.bun).toBe('>=1.4.0')
  })

  test('peers on exactly the core CLI and the hosted store service', () => {
    expect(Object.keys(manifest.peerDependencies ?? {}).sort()).toEqual([
      '@defrex/autobuild',
      '@defrex/autobuild-hosted-store-service',
    ])
  })

  test('peers on hosted-store-service >=0.9.0, the first version exporting ./operator-api', () => {
    // dispatcher.integration.test.ts imports
    // @defrex/autobuild-hosted-store-service/operator-api (and app/dashboard
    // imports it too). The subpath first ships in hosted-store-service 0.9.0 —
    // the published 0.8.0 does not export it — so a lower floor would let a
    // floor-version install break the suite. 0.9.0 exists only if the next
    // release is a minor bump; the release tool applies one version to all
    // workspace manifests.
    expect(manifest.peerDependencies?.['@defrex/autobuild-hosted-store-service']).toBe('>=0.9.0')
  })

  test('exposes the runtime singleton and the dispatcher bin', () => {
    expect(Object.keys(manifest.bin ?? {})).toEqual(['ab-hosted-dispatcher'])
    expect(Object.keys(manifest.exports ?? {})).toContain('./runtime')
  })

  test('is publishable: non-private with public access', () => {
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
  })
})
