import { describe, test } from 'bun:test'
import { SQL } from 'bun'
import { describeTicketSourceContract } from 'autobuild/plugin-sdk'
import { migratePostgres } from './schema'
import { openPostgresTicketDatabase } from './tickets'

const testUrl = process.env.AB_POSTGRES_TEST_URL?.trim()

async function isolatedDatabase(): Promise<{ url: string; cleanup(): Promise<void> }> {
  if (!testUrl) throw new Error('AB_POSTGRES_TEST_URL is required')
  const schema = `ab_tickets_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = new SQL(testUrl)
  await admin.unsafe(`CREATE SCHEMA ${schema}`)
  await admin.close()
  const scoped = new URL(testUrl)
  scoped.searchParams.set('options', `-csearch_path=${schema}`)
  await migratePostgres(scoped.toString())
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

if (!testUrl) {
  describe('PostgreSQL TicketSource live contract', () => {
    test.skip('set AB_POSTGRES_TEST_URL to run TicketSource conformance', () => {})
  })
} else {
  describeTicketSourceContract('PostgresTicketSource', async () => {
    const isolated = await isolatedDatabase()
    const database = await openPostgresTicketDatabase(isolated.url)
    return {
      source: database.source({ teamKey: 'ENG', claimedState: 'Doing' }),
      states: { ready: 'Ready', claimed: 'Doing', completed: 'Done' },
      editableLabel: 'autobuild',
      cleanup: async () => {
        await database.close()
        await isolated.cleanup()
      },
    }
  })
}
