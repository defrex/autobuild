import { describe, expect, test } from 'bun:test'

describe('PostgreSQL store environment', () => {
  test('root full-stack manifest has no blob provider SDK dependency', async () => {
    const manifest = (await Bun.file('package.json').json()) as {
      dependencies?: Record<string, string>
    }
    const names = Object.keys(manifest.dependencies ?? {})
    expect(names).not.toContain('@aws-sdk/client-s3')
    expect(names).not.toContain('@vercel/blob')
    expect(names).not.toContain('pg')
    expect(names).not.toContain('postgres')
    const hosted = (await Bun.file('packages/hosted-store-service/package.json').json()) as {
      dependencies?: Record<string, string>
    }
    expect(hosted.dependencies?.pg).toBe('8.18.0')
  })
})
