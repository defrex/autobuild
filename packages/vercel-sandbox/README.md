# @defrex/autobuild-vercel-sandbox

The Vercel Sandbox workspace provider as an Autobuild plugin package
(AUT-505). The provider's implementation, its `[workspace.config]` schema,
its capability declarations, and its remote readiness validation live in
this package; core carries neither the provider nor its SDK.

## Complete opt-in

1. Install the plugin next to the CLI:

   ```sh
   bun add -g @defrex/autobuild-vercel-sandbox
   ```

2. Declare it in `autobuild.toml` among the root scalars (before the first
   table):

   ```toml
   plugins = ["@defrex/autobuild-vercel-sandbox"]
   ```

A configuration that selects `vercel-sandbox` without the plugin installed
and declared fails before any workspace is provisioned, with a message that
names the unregistered provider and points at the `plugins` list.

## What the provider does

`vercel-sandbox` runs the complete build in an isolated Vercel VM while the
local supervisor retains credentialed branch/PR publication. Remote execution
requires the hosted HTTPS BuildStore plus its scoped token, an HTTPS
`github.com/owner/repository` origin, `forge = "github"`, and Vercel
authentication (`VERCEL_OIDC_TOKEN`, or all of `VERCEL_TOKEN`,
`VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`). The dispatcher also requires a
push-capable `GITHUB_TOKEN` or `GH_TOKEN`, validated before ready tickets are
listed or claimed.

The plugin manifest declares the provider's full capability set — the
`[workspace.config]` schema, supported forges, required environment groups,
process-env-only requirements, store requirements, the four Vercel credential
names as `sandboxForbiddenEnv` extras, origin validation, and remote
readiness validation — so the host enforces the same contracts at the
registry-aware seams as it did for the builtin registration.

The `[workspace.config]` keys the provider accepts (`image`, `vcpus`,
`timeoutSeconds`, `operationTimeoutMs`, `snapshotExpirationSeconds`,
`region`, `failoverRegions`, `environmentVariables`, `provisioning`,
`runtimeProvisioning`, `gitUsernameEnv`, `gitPasswordEnv`) are documented in
the [configuration reference](../../docs/configuration.md#vercel-sandbox).

## Hosted deployment bundle

The hosted dispatcher's deploy-build stages a self-contained `bun build`
bundle of this package into the repository-root `node_modules` and appends
it to the dispatch route's trace, so a bare
`@defrex/autobuild-vercel-sandbox` specifier resolves inside the deployed
`/api/dispatch` function. The npm published package remains the real
`src`.
