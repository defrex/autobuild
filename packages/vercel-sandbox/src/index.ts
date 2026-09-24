/**
 * This package — the Vercel Sandbox workspace provider as an Autobuild plugin
 * (AUT-505). The provider's implementation, schema,
 * capability declaration, and remote readiness validation live in this
 * package; core carries neither the provider nor its SDK. A repository opts
 * in by installing this package next to the CLI and declaring the package in
 * the `plugins` list of `autobuild.toml`.
 */
import {
  parsePluginManifest,
  type AutobuildPluginManifest,
  type WorkspaceProviderPluginContext,
  type WorkspaceProviderPluginDescriptor,
} from '@defrex/autobuild/plugin-sdk'
import { VercelSandboxProvider } from './provider'
import { vercelSandboxConfigSchema } from './schema'
import { VERCEL_SANDBOX_CAPABILITIES } from './capabilities'

const vercelSandboxRegistration: WorkspaceProviderPluginDescriptor = {
  factory(context: WorkspaceProviderPluginContext) {
    return new VercelSandboxProvider({
      // `[workspace.config]` is parsed here with the moved schema; the host's
      // registry-aware construction seam has already validated it through the
      // declared `configSchema` capability, so this parse cannot fail for a
      // config that reached the factory.
      config: vercelSandboxConfigSchema.parse(context.config),
      env: { ...context.env },
      // storeRef/storeToken are guaranteed present: the pre-invocation
      // storeRequirements check in createWorkspaceProvider ran before the
      // factory, and the provider's own constructor re-checks them.
      storeRef: context.storeRef ?? '',
      storeToken: context.storeToken ?? '',
      repo: context.repoRoot,
      runtimeReferences: context.runtimeReferences ?? [],
      setupCommand: context.sandboxSetupCommand,
      sandboxEnvironmentVariables: context.sandboxEnvironmentVariables,
      ...(context.origin !== undefined ? { origin: context.origin } : {}),
      ...(context.remoteBranchHead !== undefined
        ? { remoteBranchHead: context.remoteBranchHead }
        : {}),
    })
  },
  capabilities: VERCEL_SANDBOX_CAPABILITIES,
}

const manifest: AutobuildPluginManifest = {
  name: 'autobuild-vercel-sandbox',
  apiVersion: '^1.6.0',
  workspaceProviders: {
    'vercel-sandbox': vercelSandboxRegistration,
  },
}

// Evaluation-time validation keeps a malformed manifest from ever reaching a
// loader: the default export is parsed once here, so a broken package fails
// at its own import rather than at a distant dispatch startup.
parsePluginManifest(manifest)

export default manifest

// The moved provider module's full public surface, re-exported as named
// exports so every cross-package consumer imports through the package
// surface, never relative src paths.
export * from './provider'
export * from './schema'
export { VERCEL_SANDBOX_CAPABILITIES } from './capabilities'
export { validateVercelGithubOrigin } from './github-origin'
export { validateRemoteReadiness } from './readiness'
