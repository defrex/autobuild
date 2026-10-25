// Gate-owned S3 subset. Signature checking remains enabled.
import S3rver from 's3rver'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = await mkdtemp(join(tmpdir(), 'proa-s3-'))
const server = new S3rver({
  address: '127.0.0.1',
  port: 0,
  silent: true,
  directory,
  configureBuckets: [{ name: 'proa-data-proof' }],
})
let closing = false
async function close() {
  if (closing) return
  closing = true
  try {
    await server.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  })
try {
  const address = await server.run()
  console.log(JSON.stringify({ endpoint: `http://127.0.0.1:${address.port}`, directory }))
} catch (error) {
  await close()
  throw error
}
