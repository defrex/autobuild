import { resolve } from 'node:path'
import type { NextConfig } from 'next'

const config: NextConfig = {
  transpilePackages: [
    '@defrex/autobuild',
    '@defrex/autobuild-postgres-store',
    '@defrex/autobuild-hosted-store-service',
  ],
  serverExternalPackages: ['better-auth', 'pg'],
  // Installed deployments explicitly supply their root; source deployments
  // retain workspace-wide resolution.
  turbopack: { root: process.env.AB_SERVICE_BUILD_ROOT ?? resolve(process.cwd(), '..', '..') },
  // RFC 9728 discovery must exist at the origin root: MCP clients discover
  // the authorization server from `/.well-known/oauth-protected-resource` at
  // the resource URL's origin before falling back to path-based probes. The
  // MCP plugin serves both documents under /api/auth; rewrite them up.
  async headers() {
    return [
      {
        source: '/connect/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ]
  },
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
  // carry it into the cron route's function bundle. The operator route and the
  // dispatch route additionally execute orchestrator turns (AUT-342), whose
  // runner reads the canonical ab-operate skill at runtime through a dynamic
  // fs read no tracing can see — so both routes carry
  // skills/operate/SKILL.md as well. Note: Next 16's default Turbopack builds
  // never apply outputFileTracingIncludes (only webpack builds do), so
  // packages/hosted-dispatcher/src/ship-packed-distribution.ts — the last
  // step of deploy:build — appends these extras to the trace files itself:
  // the archive and the manifest to the dispatch route's trace only, and the
  // skill to both turn-executing routes. These entries document the intent
  // and still apply on any webpack build.
  outputFileTracingIncludes: process.env.AB_SERVICE_BUILD_ROOT
    ? {}
    : {
        '/api/dispatch': ['./.autobuild-dist/**', './skills/operate/SKILL.md'],
        '/operator/[[...path]]': ['./skills/operate/SKILL.md'],
      },
}

export default config
