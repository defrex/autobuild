import { SQL } from 'bun'
import { migratePostgres } from '../../../packages/postgres-store/src/schema'
import { administrativeUrl } from './data-services'

/** One migrated, empty database per remote-client factory. The callback must
 * stop its server/connections before returning. No TypeScript store is provided:
 * test setup may migrate, but every contract operation must cross Rust HTTP.
 * Call under withDataServices to share the isolated S3 emulator lifecycle.
 */
export async function withProtocolDatabase<T>(
  adminUrl: string,
  environment: Record<string, string | undefined>,
  work: (environment: Record<string, string | undefined>) => Promise<T>,
): Promise<T> {
  // Recheck here as this helper is exported independently of withDataServices.
  administrativeUrl({ AB_POSTGRES_TEST_URL: adminUrl })
  const database = `proa_protocol_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = new SQL(adminUrl, { max: 1, connectionTimeout: 5 })
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  let created = false
  try {
    await admin.unsafe(`CREATE DATABASE ${database}`)
    created = true
    await migratePostgres(url.href)
    return await work({ ...environment, AB_POSTGRES_URL: url.href })
  } finally {
    try {
      if (created) await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`)
    } finally {
      await admin.close()
    }
  }
}
