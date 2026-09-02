import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { MemoryBlobStore } from 'autobuild/plugin-sdk'
import { MIGRATE_COMMAND, SCHEMA_CHECKSUM, SCHEMA_VERSION, migratePostgres } from './schema'
import { openPostgresBuildStore } from './store'

const testUrl = process.env.AB_POSTGRES_TEST_URL?.trim()

async function schemaHarness(): Promise<{ url: string; cleanup: () => Promise<void> }> {
  if (!testUrl) throw new Error('AB_POSTGRES_TEST_URL is required')
  const schema = `ab_migrate_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = new SQL(testUrl)
  await admin.unsafe(`CREATE SCHEMA ${schema}`)
  await admin.close()
  const scoped = new URL(testUrl)
  scoped.searchParams.set('options', `-csearch_path=${schema}`)
  return {
    url: scoped.toString(),
    cleanup: async () => {
      const sql = new SQL(testUrl)
      try {
        await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`)
      } finally {
        await sql.close()
      }
    },
  }
}

if (testUrl) {
  describe('PostgreSQL schema migration', () => {
    test('is repeatable and serializes concurrent initializers', async () => {
      const harness = await schemaHarness()
      try {
        await Promise.all([migratePostgres(harness.url), migratePostgres(harness.url)])
        await migratePostgres(harness.url)
        const store = await openPostgresBuildStore(harness.url, new MemoryBlobStore())
        await store.close()
      } finally {
        await harness.cleanup()
      }
    })

    for (const scenario of [
      { name: 'older', version: SCHEMA_VERSION - 1, checksum: SCHEMA_CHECKSUM },
      { name: 'newer', version: SCHEMA_VERSION + 1, checksum: SCHEMA_CHECKSUM },
      { name: 'checksum-mismatched', version: SCHEMA_VERSION, checksum: 'wrong' },
    ]) {
      test(`rejects an ${scenario.name} marker`, async () => {
        const harness = await schemaHarness()
        const sql = new SQL(harness.url)
        try {
          await sql`CREATE TABLE ab_schema_migrations (
            singleton boolean PRIMARY KEY, version integer NOT NULL,
            checksum text NOT NULL, applied_at timestamptz NOT NULL
          )`
          await sql`INSERT INTO ab_schema_migrations VALUES
            (true, ${scenario.version}, ${scenario.checksum}, ${new Date().toISOString()})`
          const error = await openPostgresBuildStore(harness.url, new MemoryBlobStore()).catch(
            (caught: unknown) => caught,
          )
          expect(error).toBeInstanceOf(Error)
          expect((error as Error).message).toContain(MIGRATE_COMMAND)
          await expect(migratePostgres(harness.url)).rejects.toThrow('incompatible')
        } finally {
          await sql.close()
          await harness.cleanup()
        }
      })
    }

    test('opening an uninitialized database names the migration step', async () => {
      const harness = await schemaHarness()
      try {
        const error = await openPostgresBuildStore(harness.url, new MemoryBlobStore()).catch(
          (caught: unknown) => caught,
        )
        expect((error as Error).message).toContain(MIGRATE_COMMAND)
      } finally {
        await harness.cleanup()
      }
    })
  })
} else {
  describe('PostgreSQL migration live tests', () => {
    test.skip('set AB_POSTGRES_TEST_URL to run schema migration tests', () => {})
  })
}
