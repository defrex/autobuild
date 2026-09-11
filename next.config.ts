import type { NextConfig } from 'next'

const config: NextConfig = {
  serverExternalPackages: ['better-auth', 'pg'],
  turbopack: { root: process.cwd() },
  // The hosted dispatcher installs the guest distribution from the archive
  // `deploy:build` packs into .autobuild-dist/ (see docs/hosted-dispatcher.md);
  // carry it into the cron route's function bundle.
  outputFileTracingIncludes: { '/api/dispatch': ['./.autobuild-dist/**'] },
}

export default config
