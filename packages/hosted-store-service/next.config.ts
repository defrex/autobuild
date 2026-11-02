import { resolve } from 'node:path'
import type { NextConfig } from 'next'

const config: NextConfig = {
  transpilePackages: [
    '@defrex/autobuild',
    '@defrex/autobuild-postgres-store',
    '@defrex/autobuild-hosted-store-service',
  ],
  serverExternalPackages: ['better-auth', 'pg'],
  // Installed deployments explicitly supply their root (the deployment folder,
  // or the workspace root above it); source deployments retain workspace-wide
  // resolution and Next's inferred tracing root.
  turbopack: { root: process.env.AB_SERVICE_BUILD_ROOT ?? resolve(process.cwd(), '..', '..') },
  ...(process.env.AB_SERVICE_BUILD_ROOT
    ? { outputFileTracingRoot: process.env.AB_SERVICE_BUILD_ROOT }
    : {}),
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
  // the build packs into .autobuild-dist/ (see the hosted-dispatcher package
  // README); carry it into the cron route's function bundle. Both routes
  // retain legacy operate-skill trace entries; neither executes operator
  // turns. Next 16's Turbopack does not apply these includes, so
  // `deploy:build` and `ab-hosted-service-build` both run
  // `ab-hosted-dispatcher ship-deployment`, which appends the equivalent
  // entries and the provider plugins. Webpack uses them here.
  outputFileTracingIncludes: process.env.AB_SERVICE_BUILD_ROOT
    ? {}
    : {
        '/api/dispatch': ['./.autobuild-dist/**', './skills/operate/SKILL.md'],
        '/operator/[[...path]]': ['./skills/operate/SKILL.md'],
      },
}

export default config
