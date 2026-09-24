# @defrex/autobuild-vercel-sandbox

The Vercel Sandbox workspace provider as an Autobuild plugin package
(AUT-517).

## Transitional arrangement

Until the builtin provider is removed (AUT-505), the provider's
implementation stays **builtin-hosted** in `@defrex/autobuild`: its
implementation depends on core internals that are not on the
`@defrex/autobuild/plugin-sdk` surface, and moving it now would force the
root package to depend on this plugin, recreating a root ↔ provider
publish cycle.

This package therefore ships the plugin manifest with the full AUT-516
capability declarations — the exact shared `VERCEL_SANDBOX_CAPABILITIES`
object the builtin registration references — and a guarded factory that
throws naming AUT-505 if it is ever reached. While the builtin exists, the
plugin loader's duplicate-skip rule guarantees the factory is never
invoked: a configured plugin whose registrations all collide with builtin
workspace-provider registrations is skipped with a one-line notice, and the
builtin keeps serving the provider. After AUT-505 removes the builtin and
moves the implementation here, the skip rule retires itself (it keys on
builtin ownership) and a second plugin registering `vercel-sandbox`
collides and fails startup as today.

## Hosted deployment bundle

The hosted dispatcher's deploy-build stages a self-contained `bun build`
bundle of this package into the repository-root `node_modules` and appends
it to the dispatch route's trace, so a bare
`@defrex/autobuild-vercel-sandbox` specifier resolves inside the deployed
`/api/dispatch` function. The npm published package remains the real
`src`.
