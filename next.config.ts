import type { NextConfig } from 'next'

const config: NextConfig = {
  serverExternalPackages: ['better-auth', 'pg'],
  turbopack: { root: process.cwd() },
  // RFC 9728 discovery must exist at the origin root: MCP clients discover
  // the authorization server from `/.well-known/oauth-protected-resource` at
  // the resource URL's origin before falling back to path-based probes. The
  // MCP plugin serves both documents under /api/auth; rewrite them up.
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: '/.well-known/oauth-authorization-server',
          destination: '/api/auth/.well-known/oauth-authorization-server',
        },
        {
          source: '/.well-known/oauth-protected-resource',
          destination: '/api/auth/.well-known/oauth-protected-resource',
        },
      ],
      afterFiles: [],
      fallback: [],
    }
  },
  // The hosted dispatcher installs the guest distribution from the archive
  // `deploy:build` packs into .autobuild-dist/ (see docs/hosted-dispatcher.md);
  // carry it into the cron route's function bundle. Note: Next 16's default
  // Turbopack builds never apply outputFileTracingIncludes (only webpack builds
  // do), so `tools/ship-packed-distribution.ts` — the last step of deploy:build —
  // appends the archive to the dispatch route's trace file instead. This entry
  // documents the intent and still applies on any webpack build.
  outputFileTracingIncludes: { '/api/dispatch': ['./.autobuild-dist/**'] },
}

export default config
