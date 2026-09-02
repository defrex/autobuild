import { describe, expect, test } from 'bun:test'
import { HOSTED_ARTIFACT_MAX_BYTES, parseHostedStoreEnv } from './config'

const valid = {
  AB_STORE_SECRET: 'secret',
  AB_POSTGRES_URL: 'postgres://localhost/autobuild',
  AB_BLOB_BACKEND: 's3',
  AB_S3_BUCKET: 'bucket',
  AB_S3_REGION: 'us-east-1',
  AB_S3_ACCESS_KEY_ID: 'key',
  AB_S3_SECRET_ACCESS_KEY: 'secret-key',
}

describe('hosted store configuration', () => {
  test('applies host/port defaults and the fixed product ceiling', () => {
    const config = parseHostedStoreEnv(valid)
    expect(config.hostname).toBe('0.0.0.0')
    expect(config.port).toBe(3000)
    expect(config.ticketBackend).toBe('database')
    expect(config.ticketLifecycle).toEqual({
      triage: 'Triage',
      ready: 'Ready',
      doing: 'Doing',
      done: 'Done',
    })
    expect(HOSTED_ARTIFACT_MAX_BYTES).toBe(1024 * 1024)
  })

  test('requires service-only Linear credentials and distinct configured states', () => {
    expect(() => parseHostedStoreEnv({ ...valid, AB_TICKET_BACKEND: 'linear' })).toThrow(
      'LINEAR_API_KEY',
    )
    expect(
      parseHostedStoreEnv({ ...valid, AB_TICKET_BACKEND: 'linear', LINEAR_API_KEY: 'lin-key' })
        .linearApiKey,
    ).toBe('lin-key')
    expect(() => parseHostedStoreEnv({ ...valid, AB_TICKET_READY_STATE: 'Done' })).toThrow(
      'distinct',
    )
    expect(() => parseHostedStoreEnv({ ...valid, AB_TICKET_READY_STATE: ' ' })).toThrow(
      'AB_TICKET_READY_STATE',
    )
  })

  test('rejects missing secret and malformed ports', () => {
    expect(() => parseHostedStoreEnv({ ...valid, AB_STORE_SECRET: ' ' })).toThrow('AB_STORE_SECRET')
    expect(() => parseHostedStoreEnv({ ...valid, PORT: '3.5' })).toThrow('PORT')
    expect(() => parseHostedStoreEnv({ ...valid, PORT: '0' })).toThrow('PORT')
  })
})
