/** Explicit integration entry only. This module never registers Bun unit tests. */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { S3Client } from '../../../packages/postgres-store/node_modules/@aws-sdk/client-s3'
import { S3BlobStore } from '../../../packages/postgres-store/src/s3'
import { startS3, isolatedEnvironment } from './data-services'

export async function protocolBlobInteroperability(executable: string) {
  const service = await startS3()
  let child: ReturnType<typeof Bun.spawn> | undefined
  let client: S3Client | undefined
  const checks: string[] = []
  try {
    child = Bun.spawn([executable], {
      cwd: resolve(import.meta.dir, '..'),
      env: {
        ...isolatedEnvironment(),
        ...service.env,
        AB_POSTGRES_URL: 'postgres://unused@127.0.0.1:1/proa_blob_proof',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const running = child
    assert.ok(typeof running.stdin !== 'number' && running.stdin)
    assert.ok(typeof running.stdout !== 'number' && running.stdout)
    const input = running.stdin
    const lines = (async function* () {
      let pending = ''
      for await (const bytes of running.stdout as ReadableStream<Uint8Array>) {
        pending += new TextDecoder().decode(bytes)
        while (pending.includes('\n')) {
          const end = pending.indexOf('\n')
          const line = pending.slice(0, end)
          pending = pending.slice(end + 1)
          yield JSON.parse(line) as {
            ready?: boolean
            value?: unknown
            error?: string
          }
        }
      }
      throw new Error('Native blob proof exited before response')
    })()
    async function next() {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          lines.next().then((r) => r.value),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Native blob proof response timeout')), 15000)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    assert.equal((await next()).ready, true)
    const request = async (value: object) => {
      input.write(`${JSON.stringify(value)}\n`)
      await input.flush()
      return next()
    }
    client = new S3Client({
      endpoint: service.endpoint,
      region: service.env.AB_S3_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: service.env.AB_S3_ACCESS_KEY_ID,
        secretAccessKey: service.env.AB_S3_SECRET_ACCESS_KEY,
      },
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 5000 },
    })
    const store = new S3BlobStore({
      client,
      bucket: service.env.AB_S3_BUCKET,
      prefix: service.env.AB_BLOB_PREFIX,
    })
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from([0, 255, 128, 10]),
      Buffer.from('snow-雪\u0000'),
    ]) {
      const hash = createHash('sha256').update(bytes).digest('hex')
      assert.deepEqual(await request({ op: 'put', hash, base64: bytes.toString('base64') }), {
        value: null,
      })
      assert.deepEqual(Buffer.from((await store.get(hash))!), bytes)
      checks.push(`rust-put/typescript-get/${bytes.length}`)
      await store.put(hash, bytes)
      assert.deepEqual(await request({ op: 'get', hash }), {
        value: bytes.toString('base64'),
      })
      checks.push(`typescript-put/rust-get/${bytes.length}`)
      assert.deepEqual(await request({ op: 'put', hash, base64: bytes.toString('base64') }), {
        value: null,
      })
      assert.deepEqual(Buffer.from((await store.get(hash))!), bytes)
      checks.push(`repeat-whole-object/${bytes.length}`)
    }
    assert.deepEqual(await request({ op: 'get', hash: '0'.repeat(64) }), {
      error: 'blob object is missing',
    })
    checks.push('missing-object-is-distinct')
    input.end()
    let exitTimer: ReturnType<typeof setTimeout> | undefined
    try {
      assert.equal(
        await Promise.race([
          running.exited,
          new Promise<never>((_, reject) => {
            exitTimer = setTimeout(() => reject(new Error('Native blob proof exit timeout')), 10000)
          }),
        ]),
        0,
      )
    } finally {
      clearTimeout(exitTimer)
    }
    return { checks, liveVercel: false }
  } finally {
    client?.destroy()
    if (child?.exitCode === null) {
      child.kill('SIGTERM')
      const killTimer = setTimeout(() => child?.kill('SIGKILL'), 10000)
      try {
        await child.exited
      } finally {
        clearTimeout(killTimer)
      }
    }
    await service.stop()
  }
}
