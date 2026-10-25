import { SQL } from 'bun'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'

await withDataServices(async (admin, environment) => {
  const databases: string[] = []
  for (let index = 0; index < 2; index++) {
    await withProtocolDatabase(admin, environment, async (env) => {
      const sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 })
      try {
        const rows = await sql`SELECT current_database() AS name`
        databases.push(rows[0].name)
        const builds = await sql`SELECT count(*)::int AS count FROM builds`
        if (builds[0].count !== 0) throw new Error('Protocol database is not empty')
      } finally {
        await sql.close()
      }
    })
  }
  if (databases[0] === databases[1]) throw new Error('Protocol factories reused a database')
  const failure = new Error('intentional factory failure')
  let failedDatabase: string | undefined
  try {
    await withProtocolDatabase(admin, environment, async (env) => {
      failedDatabase = new URL(env.AB_POSTGRES_URL!).pathname.slice(1)
      throw failure
    })
    throw new Error('Factory failure did not propagate')
  } catch (error) {
    if (error !== failure) throw error
  }
  const inspect = new SQL(admin, { max: 1 })
  try {
    for (const database of [...databases, failedDatabase]) {
      const rows = await inspect`SELECT datname FROM pg_database WHERE datname = ${database}`
      if (rows.length) throw new Error('Protocol database leaked after factory exit')
    }
  } finally {
    await inspect.close()
  }
  console.log('Protocol database isolation and failure cleanup passed (not HTTP conformance)')
})
