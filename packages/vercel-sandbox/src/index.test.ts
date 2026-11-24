import { describe, expect, test } from 'bun:test'
import manifest from './index'
import {
  parsePluginManifest,
  type WorkspaceProviderPluginFactoryContext,
} from '@defrex/autobuild/plugin-sdk'

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
      factory: (context: WorkspaceProviderPluginFactoryContext) => unknown
    }
    // Invoked with the FULL extended context (AUT-560): the plugin package
    // compiles against, and its factory accepts, the seam-carrying context
    // the host passes to workspace-provider factories.
    const context: WorkspaceProviderPluginFactoryContext = {
      config: {},
      env: {},
      repoRoot: '/repo',
      storeRef: 'https://store.example.test',
      delegateCredential: async () => 'delegated-token',
      runtimeReferences: [],
      origin: async () => 'https://github.com/acme/app.git',
      remoteBranchHead: async () => undefined,
    }
    expect(() => registration.factory(context)).toThrow('AUT-505')
  })
})
