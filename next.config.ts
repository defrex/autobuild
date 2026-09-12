import type { NextConfig } from 'next'

const config: NextConfig = {
  serverExternalPackages: ['better-auth', 'pg'],
  turbopack: { root: process.cwd() },
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
