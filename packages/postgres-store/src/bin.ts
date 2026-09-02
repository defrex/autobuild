#!/usr/bin/env bun
import { migratePostgres } from './schema'

async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== 'migrate') {
    throw new Error('usage: ab-postgres-store migrate')
  }
  const url = process.env.AB_POSTGRES_URL?.trim()
  if (!url) throw new Error('AB_POSTGRES_URL is required and must be nonblank')
  await migratePostgres(url)
  console.log('Autobuild PostgreSQL schema is ready')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
