// Gate-owned S3 subset. Signature checking remains enabled.
import S3rver from 's3rver'
import { rm } from 'node:fs/promises'

const directory = process.env.PROA_S3_DIRECTORY
if (!directory) throw new Error('S3 service requires its parent-owned temporary directory')
let server: S3rver | undefined
let closing: Promise<void> | undefined
function close() {
  closing ??= (async () => {
    try {
      await server?.close()
    } finally {
      await rm(directory!, { recursive: true, force: true })
    }
  })()
  return closing
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  })
try {
  server = new S3rver({
    address: '127.0.0.1',
    port: 0,
    silent: true,
    directory,
    configureBuckets: [{ name: 'proa-data-proof' }],
  })
  const address = await server.run()
  console.log(JSON.stringify({ endpoint: `http://127.0.0.1:${address.port}`, directory }))
} catch (error) {
  await close()
  throw error
}
