import { createHostedStoreService, parseHostedStoreEnv } from './src'

const config = parseHostedStoreEnv(process.env)
const service = createHostedStoreService({ env: process.env })

Bun.serve({
  hostname: config.hostname,
  port: config.port,
  fetch: service.fetch,
})
