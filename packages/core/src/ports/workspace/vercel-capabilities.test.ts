import { describe, expect, test } from 'bun:test'
import pluginManifest from '@defrex/autobuild-vercel-sandbox'
import { builtinWorkspaceProviderRegistration } from './builtin-capabilities'
import { VERCEL_SANDBOX_CAPABILITIES } from './vercel-capabilities'

/**
 * Parity between the builtin `vercel-sandbox` registration and the
 * `@defrex/autobuild-vercel-sandbox` plugin's declaration (AUT-517). Both
 * sides consume the single shared `VERCEL_SANDBOX_CAPABILITIES` object, so
 * the assertion is reference equality: any future divergence is a
 * compile-time split, not a silent drift of hand-duplicated closures.
 */
describe('vercel-sandbox capability parity', () => {
  test('the plugin manifest references the shared capability object', () => {
    const registration = pluginManifest.workspaceProviders?.['vercel-sandbox'] as {
      capabilities?: unknown
    }
    expect(registration.capabilities).toBe(
      builtinWorkspaceProviderRegistration('vercel-sandbox')?.capabilities,
    )
    expect(registration.capabilities).toBe(VERCEL_SANDBOX_CAPABILITIES)
  })
})
