import { SQL } from 'bun'
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '../../../packages/postgres-store/node_modules/@aws-sdk/client-s3'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../..')
export const defaultAdminUrl = 'postgres://postgres:postgres@127.0.0.1:5432/postgres'
export function administrativeUrl(env: Record<string, string | undefined>) {
  const explicit = env.AB_POSTGRES_TEST_URL?.trim()
  const url = explicit || defaultAdminUrl
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Invalid administrative PostgreSQL URL')
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname)
  )
    throw new Error('Administrative PostgreSQL target must be loopback')
  // libpq host query overrides can otherwise bypass the hostname check.
  if ([...parsed.searchParams.keys()].some((key) => ['host', 'hostaddr', 'service'].includes(key)))
    throw new Error('Administrative PostgreSQL host overrides are not permitted')
  return { url, explicit: Boolean(explicit) }
}
export function isolatedEnvironment(env = process.env): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !key.startsWith('AB_') &&
        !key.startsWith('VERCEL_') &&
        !key.startsWith('BLOB_') &&
        !key.startsWith('AWS_') &&
        key !== 'DATABASE_URL',
    ),
  )
}
export async function preparePostgres(
  env = process.env,
  invoke = async () => {
    const child = Bun.spawn(['sh', 'scripts/postgres-live.sh', 'ensure-running'], {
      cwd: root,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if ((await child.exited) !== 0) throw new Error('Local PostgreSQL startup failed')
  },
  probe = async (url: string) => {
    const sql = new SQL(url, { max: 1, connectionTimeout: 5 })
    try {
      await sql`SELECT 1`
    } catch {
      throw new Error('Administrative PostgreSQL probe failed')
    } finally {
      await sql.close()
    }
  },
) {
  const selected = administrativeUrl(env)
  if (!selected.explicit) await invoke()
  await probe(selected.url)
  return selected.url
}
export async function startS3() {
  const child = Bun.spawn(['bun', resolve(import.meta.dir, 's3-service.ts')], {
    env: isolatedEnvironment(),
    stdout: 'pipe',
    stderr: 'inherit',
  })
  let closed = false
  const stop = async () => {
    if (closed) return
    closed = true
    child.kill('SIGTERM')
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000)
    try {
      await child.exited
    } finally {
      clearTimeout(timeout)
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const line = await Promise.race([
      (async () => {
        const reader = child.stdout.getReader()
        let text = ''
        while (!text.includes('\n')) {
          const result = await reader.read()
          if (result.done) throw new Error('S3 service exited before readiness')
          text += new TextDecoder().decode(result.value)
        }
        reader.releaseLock()
        return text.split('\n')[0]!
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('S3 service startup timed out')), 15000)
      }),
    ])
    const { endpoint, directory } = JSON.parse(line) as { endpoint: string; directory: string }
    const env = {
      AB_BLOB_BACKEND: 's3',
      AB_BLOB_PREFIX: '//proof///artifacts/',
      AB_S3_ENDPOINT: endpoint,
      AB_S3_BUCKET: 'proa-data-proof',
      AB_S3_REGION: 'us-east-1',
      AB_S3_ACCESS_KEY_ID: 'S3RVER',
      AB_S3_SECRET_ACCESS_KEY: 'S3RVER',
      AB_S3_FORCE_PATH_STYLE: 'true',
    }
    const client = new S3Client({
      endpoint,
      region: env.AB_S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER' },
    })
    try {
      const bytes = new Uint8Array([0, 255, 1, 128])
      await client.send(
        new PutObjectCommand({ Bucket: env.AB_S3_BUCKET, Key: 'readiness', Body: bytes }),
      )
      const result = await client.send(
        new GetObjectCommand({ Bucket: env.AB_S3_BUCKET, Key: 'readiness' }),
      )
      if (String(await result.Body!.transformToByteArray()) !== String(bytes))
        throw new Error('S3 readiness bytes differ')
    } finally {
      client.destroy()
    }
    return { endpoint, directory, env, stop }
  } catch (error) {
    await stop()
    throw error
  } finally {
    clearTimeout(timer)
  }
}
export async function withDataServices<T>(
  work: (adminUrl: string, env: Record<string, string | undefined>) => Promise<T>,
) {
  const admin = await preparePostgres()
  const s3 = await startS3()
  const stop = () => {
    void s3.stop()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    return await work(admin, { ...isolatedEnvironment(), ...s3.env })
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    await s3.stop()
  }
}
