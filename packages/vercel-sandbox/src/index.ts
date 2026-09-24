/**
 * `@defrex/autobuild-vercel-sandbox` — the Vercel Sandbox workspace provider
 * as an Autobuild plugin (AUT-517).
 *
 * Transitional state: the provider's implementation is builtin-hosted in
 * core, because it depends on core internals that are not on the plugin-sdk
 * surface (`config/schema`, `distribution-archive`, `operator-sandbox`,
 * `build-execution`, `harvest-execution`, `git-worktree`) and the package
 * must typecheck with only `@defrex/autobuild/plugin-sdk` imports. The
 * capabilities are the shared `VERCEL_SANDBOX_CAPABILITIES` object imported
 * from the SDK — the same runtime value the builtin registration references,
 * so the two declarations cannot drift.
 *
 * While the builtin exists, the loader's duplicate-skip rule guarantees this
 * manifest's factory is never invoked: every declared registration collides
 * with a builtin workspace-provider registration, so the whole module is
 * skipped with a notice and the builtin keeps serving the name. After the
 * builtin's removal (AUT-505) the skip rule retires itself and a moved-in
 * implementation replaces the guarded factory below.
 */
import {
  parsePluginManifest,
  VERCEL_SANDBOX_CAPABILITIES,
  type AutobuildPluginManifest,
  type WorkspaceProviderPluginDescriptor,
  type WorkspaceProviderPluginFactory,
} from '@defrex/autobuild/plugin-sdk'

// Typed against the extended workspace-provider factory context (AUT-560):
// when the host invokes a workspace-provider factory it passes the
// host-derived seams (`storeRef`, `storeToken`, `runtimeReferences`,
// `origin`, `remoteBranchHead`) beside the shared `{ config, env, repoRoot }`.
// The guard below stays until AUT-505 moves the implementation into this
// package; the moved-in factory will consume exactly those seams.
const vercelSandboxFactory: WorkspaceProviderPluginFactory = () => {
  throw new Error(
    'the vercel-sandbox implementation is builtin-hosted in this distribution; ' +
      "plugin construction arrives with the builtin's removal (AUT-505)",
  )
}

const vercelSandboxRegistration: WorkspaceProviderPluginDescriptor = {
  factory: vercelSandboxFactory,
  capabilities: VERCEL_SANDBOX_CAPABILITIES,
}

const manifest: AutobuildPluginManifest = {
  name: 'autobuild-vercel-sandbox',
  apiVersion: '^1.7.0',
  workspaceProviders: {
    'vercel-sandbox': vercelSandboxRegistration,
  },
}

// Evaluation-time validation keeps a malformed manifest from ever reaching a
// loader: the default export is parsed once here, so a broken package fails
// at its own import rather than at a distant dispatch startup.
parsePluginManifest(manifest)

export default manifest
