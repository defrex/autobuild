import { SQL } from 'bun'
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '../../../packages/postgres-store/node_modules/@aws-sdk/client-s3'
import { resolve, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

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
        !key.startsWith('GITHUB_') &&
        !key.startsWith('PROA_') &&
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
export interface S3ServiceOptions {
  command?: string[]
  startupTimeoutMs?: number
  teardownTimeoutMs?: number
}
export async function startS3(options: S3ServiceOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'proa-s3-'))
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn(options.command ?? ['bun', resolve(import.meta.dir, 's3-service.ts')], {
      env: { ...isolatedEnvironment(), PROA_S3_DIRECTORY: directory },
      stdout: 'pipe',
      stderr: 'inherit',
    })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  let stopping: Promise<void> | undefined
  const stop = () => {
    stopping ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        if (child.exitCode === null) child.kill('SIGTERM')
        await Promise.race([
          child.exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('S3 service teardown timed out')),
              options.teardownTimeoutMs ?? 10000,
            )
          }),
        ])
      } catch (error) {
        child.kill('SIGKILL')
        await child.exited
        throw error
      } finally {
        clearTimeout(timer)
        process.removeListener('SIGINT', signalStop)
        process.removeListener('SIGTERM', signalStop)
        await rm(directory, { recursive: true, force: true })
      }
    })()
    return stopping
  }
  const signalStop = () => {
    void stop().catch((error) => console.error('S3 signal cleanup failed', error))
  }
  process.once('SIGINT', signalStop)
  process.once('SIGTERM', signalStop)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const line = await Promise.race([
      (async () => {
        const stdout = child.stdout
        if (typeof stdout === 'number' || !stdout)
          throw new Error('S3 service has no readiness pipe')
        const reader = stdout.getReader()
        let text = ''
        try {
          while (!text.includes('\n')) {
            const result = await reader.read()
            if (result.done) throw new Error('S3 service exited before readiness')
            text += new TextDecoder().decode(result.value)
            if (text.length > 8192) throw new Error('S3 service readiness message is too large')
          }
        } finally {
          reader.releaseLock()
        }
        return text.split('\n')[0]!
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('S3 service startup timed out')),
          options.startupTimeoutMs ?? 15000,
        )
      }),
    ])
    const { endpoint, directory: reportedDirectory } = JSON.parse(line) as {
      endpoint: string
      directory: string
    }
    const address = new URL(endpoint)
    if (
      address.protocol !== 'http:' ||
      address.hostname !== '127.0.0.1' ||
      !address.port ||
      reportedDirectory !== directory
    )
      throw new Error('Invalid S3 service readiness identity')
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
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 5000 },
      credentials: { accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER' },
    })
    try {
      const bytes = new Uint8Array([0, 255, 1, 128])
      await client.send(
        new PutObjectCommand({ Bucket: env.AB_S3_BUCKET, Key: 'readiness', Body: bytes }),
        { abortSignal: AbortSignal.timeout(10000) },
      )
      const result = await client.send(
        new GetObjectCommand({ Bucket: env.AB_S3_BUCKET, Key: 'readiness' }),
        { abortSignal: AbortSignal.timeout(10000) },
      )
      if (String(await result.Body!.transformToByteArray()) !== String(bytes))
        throw new Error('S3 readiness bytes differ')
    } finally {
      client.destroy()
    }
    return { endpoint, directory, env, stop }
  } catch (error) {
    try {
      await stop()
    } catch (cleanupError) {
      console.error('S3 startup cleanup failed', cleanupError)
    }
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
  let failure: unknown
  let value: T | undefined
  try {
    value = await work(admin, { ...isolatedEnvironment(), ...s3.env })
  } catch (error) {
    failure = error
  } finally {
    try {
      await s3.stop()
    } catch (error) {
      console.error('S3 cleanup failed', error)
      failure ??= error
    }
  }
  if (failure) throw failure
  return value as T
}
