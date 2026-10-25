import { expect, test } from 'bun:test'
import { access } from 'node:fs/promises'
import {
  administrativeUrl,
  defaultAdminUrl,
  isolatedEnvironment,
  preparePostgres,
  startS3,
} from './data-services'

test('unset admin URL starts existing cluster and passes explicit default to probe', async () => {
  const calls: string[] = []
  expect(
    await preparePostgres(
      {},
      async () => {
        calls.push('helper')
      },
      async (url) => {
        calls.push(url)
      },
    ),
  ).toBe(defaultAdminUrl)
  expect(calls).toEqual(['helper', defaultAdminUrl])
})
test('explicit loopback override bypasses helper and probe failure propagates', async () => {
  const url = 'postgres://test@localhost/custom'
  expect(
    await preparePostgres(
      { AB_POSTGRES_TEST_URL: url },
      async () => {
        throw Error('helper called')
      },
      async (selected) => {
        expect(selected).toBe(url)
      },
    ),
  ).toBe(url)
  await expect(
    preparePostgres(
      { AB_POSTGRES_TEST_URL: url },
      async () => {},
      async () => {
        throw Error('probe failed')
      },
    ),
  ).rejects.toThrow('probe failed')
  for (const url of [
    'postgres://example.com/db',
    'invalid',
    'postgres://localhost/db?host=production',
  ])
    expect(() => administrativeUrl({ AB_POSTGRES_TEST_URL: url })).toThrow()
})
test('integration environment excludes production credentials and phase identity', () => {
  expect(
    isolatedEnvironment({
      PATH: '/bin',
      AB_SESSION: 'session',
      AB_POSTGRES_URL: 'production',
      DATABASE_URL: 'production',
      AWS_SECRET_ACCESS_KEY: 'secret',
      BLOB_READ_WRITE_TOKEN: 'secret',
    }),
  ).toEqual({ PATH: '/bin' })
})
test('signed real S3 readiness and cleanup after failing child', async () => {
  const service = await startS3()
  try {
    const child = Bun.spawn(['bun', '-e', 'process.exit(42)'])
    expect(await child.exited).toBe(42)
  } finally {
    await service.stop()
  }
  await expect(access(service.directory)).rejects.toThrow()
  await expect(fetch(service.endpoint)).rejects.toThrow()
}, 30000)

test('missing and unready S3 service fail explicitly', async () => {
  await expect(startS3({ command: ['/definitely-missing/proa-s3-service'] })).rejects.toThrow()
  await expect(startS3({ command: ['/bin/false'] })).rejects.toThrow('before readiness')
  await expect(
    startS3({
      command: ['bun', '-e', 'setInterval(() => {}, 1000)'],
      startupTimeoutMs: 50,
    }),
  ).rejects.toThrow('startup timed out')
}, 10000)

test('announced but unreachable S3 service fails its signed readiness probe', async () => {
  await expect(
    startS3({
      command: [
        'bun',
        '-e',
        `
    console.log(JSON.stringify({ endpoint: 'http://127.0.0.1:1', directory: process.env.PROA_S3_DIRECTORY }));
    setInterval(() => {}, 1000);
  `,
      ],
    }),
  ).rejects.toThrow()
}, 15000)

test('service stop is idempotent and waits for shared cleanup', async () => {
  const service = await startS3()
  await Promise.all([service.stop(), service.stop()])
  await expect(access(service.directory)).rejects.toThrow()
  await expect(fetch(service.endpoint)).rejects.toThrow()
}, 30000)
