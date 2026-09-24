import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import manifest from './index'
import { parsePluginManifest } from '@defrex/autobuild/plugin-sdk'
import type { VercelSandboxFacade } from './provider'
import { VercelSandboxProvider, VERCEL_SANDBOX_CAPABILITIES } from './index'

describe('@defrex/autobuild-vercel-sandbox', () => {
  test('default export is a parseable plugin manifest registering vercel-sandbox', () => {
    const parsed = parsePluginManifest(manifest)
    expect(parsed.name).toBe('autobuild-vercel-sandbox')
    expect(Object.keys(parsed.workspaceProviders ?? {})).toEqual(['vercel-sandbox'])
    const registration = parsed.workspaceProviders?.['vercel-sandbox']
    expect(typeof (registration as { factory: unknown }).factory).toBe('function')
    expect((registration as { capabilities?: unknown }).capabilities).toEqual(
      VERCEL_SANDBOX_CAPABILITIES,
    )
  })

  test('the capabilities declare the moved parse-time and registry-seam behaviors', () => {
    expect(VERCEL_SANDBOX_CAPABILITIES.configSchema).toBeDefined()
    expect(VERCEL_SANDBOX_CAPABILITIES.requireRuntimeProvisioning).toBe(true)
    expect(VERCEL_SANDBOX_CAPABILITIES.supportedForges).toEqual(['github'])
    expect(VERCEL_SANDBOX_CAPABILITIES.sandboxForbiddenEnv).toEqual([
      'VERCEL_OIDC_TOKEN',
      'VERCEL_TOKEN',
      'VERCEL_TEAM_ID',
      'VERCEL_PROJECT_ID',
    ])
    expect(VERCEL_SANDBOX_CAPABILITIES.validateReadiness).toBeDefined()
    expect(VERCEL_SANDBOX_CAPABILITIES.validateOrigin).toBeDefined()
    expect(VERCEL_SANDBOX_CAPABILITIES.storeRequirements).toBeDefined()
  })

  test('the factory constructs a provider from the extended plugin context', () => {
    const registration = manifest.workspaceProviders?.['vercel-sandbox'] as {
      factory: (context: unknown) => unknown
    }
    const facade = {} as VercelSandboxFacade
    const provider = registration.factory({
      config: { timeoutSeconds: 600 },
      env: {
        VERCEL_TOKEN: 'tok',
        VERCEL_TEAM_ID: 'team',
        VERCEL_PROJECT_ID: 'proj',
      },
      repoRoot: '/repo',
      storeRef: 'https://store.example.test',
      storeToken: 'scoped',
      runtimeReferences: [],
    }) as VercelSandboxProvider
    expect(provider).toBeInstanceOf(VercelSandboxProvider)
    expect(provider.name).toBe('vercel-sandbox')
    expect(typeof provider.provision).toBe('function')
    expect(facade).toBeDefined()
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
