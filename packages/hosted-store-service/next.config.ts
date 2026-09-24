import { resolve } from 'node:path'
import type { NextConfig } from 'next'

const config: NextConfig = {
  serverExternalPackages: ['better-auth', 'pg'],
  // Turbopack's root must be the workspace root (this package directory is two
  // levels below it) so module resolution spans the monorepo. Next loads this
  // TypeScript config by transpiling it to CommonJS, where `import.meta` is a
  // syntax error — so the root is derived from `cwd`, which is this package
  // directory in every invocation (`bun run dev`/`build` from the package
  // directory, Vercel building with the Root Directory as cwd).
  turbopack: { root: resolve(process.cwd(), '..', '..') },
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
  // carry it into the cron route's function bundle. The operator route and the
  // dispatch route additionally execute orchestrator turns (AUT-342), whose
  // runner reads the canonical ab-operate skill at runtime through a dynamic
  // fs read no tracing can see — so both routes carry
  // skills/operate/SKILL.md as well. Note: Next 16's default Turbopack builds
  // never apply outputFileTracingIncludes (only webpack builds do), so
  // packages/hosted-dispatcher/src/ship-packed-distribution.ts — the last
  // step of deploy:build — appends the archive and the skill to both routes'
  // trace files instead. These entries document the intent and still apply on
  // any webpack build.
  outputFileTracingIncludes: {
    '/api/dispatch': ['./.autobuild-dist/**', './skills/operate/SKILL.md'],
    '/operator/[[...path]]': ['./skills/operate/SKILL.md'],
  },
}

export default config
