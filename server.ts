import { createHostedStoreService, parseHostedStoreEnv } from '@autobuild/hosted-store-service'

const config = parseHostedStoreEnv(process.env)
const service = createHostedStoreService({ env: process.env })

Bun.serve({
  hostname: config.hostname,
  port: config.port,
  fetch: service.fetch,
})
