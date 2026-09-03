#!/usr/bin/env bun
import { resolvePostgresUrl } from './env'
import { migratePostgres } from './schema'

async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== 'migrate') {
    throw new Error('usage: ab-postgres-store migrate')
  }
  await migratePostgres(resolvePostgresUrl(process.env))
  console.log('Autobuild PostgreSQL schema is ready')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
