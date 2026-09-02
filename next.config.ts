import type { NextConfig } from 'next'

const config: NextConfig = {
  serverExternalPackages: ['better-auth', 'pg'],
  turbopack: { root: process.cwd() },
}

export default config
