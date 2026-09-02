import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import {
  MemoryBlobStore,
  describeBuildStoreContract,
  sampleBuildInput,
  sampleEventWrite,
} from 'autobuild/plugin-sdk'
import { migratePostgres } from './schema'
import { openPostgresBuildStore } from './store'

const testUrl = process.env.AB_POSTGRES_TEST_URL?.trim()

async function isolatedDatabase(): Promise<{ url: string; cleanup: () => Promise<void> }> {
  if (!testUrl) throw new Error('AB_POSTGRES_TEST_URL is required')
  const schema = `ab_test_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = new SQL(testUrl)
  await admin.unsafe(`CREATE SCHEMA ${schema}`)
  await admin.close()
  const scoped = new URL(testUrl)
  scoped.searchParams.set('options', `-csearch_path=${schema}`)
  const url = scoped.toString()
  await migratePostgres(url)
  return {
    url,
    cleanup: async () => {
      const cleanupSql = new SQL(testUrl)
      try {
        await cleanupSql.unsafe(`DROP SCHEMA ${schema} CASCADE`)
      } finally {
        await cleanupSql.close()
      }
    },
  }
}

async function runWorker(
  url: string,
  mode: 'build' | 'repo' | 'conditional',
  resource: string,
  count: number,
): Promise<string> {
  const child = Bun.spawn(
    [
      process.execPath,
      `${import.meta.dir}/testing/concurrent-worker.ts`,
      url,
      mode,
      resource,
      String(count),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`concurrency worker failed (${exitCode}): ${stderr}`)
  return stdout.trim()
}

if (testUrl) {
  describeBuildStoreContract('PostgreSQL', async (options) => {
    const database = await isolatedDatabase()
    const store = await openPostgresBuildStore(database.url, new MemoryBlobStore(), options)
    return { store, cleanup: database.cleanup }
  })

  describe('PostgreSQL durability and concurrency', () => {
    test('concurrent repository ensures create one absent row and return the winning record', async () => {
      const database = await isolatedDatabase()
      const stores = await Promise.all(
        Array.from({ length: 8 }, () =>
          openPostgresBuildStore(database.url, new MemoryBlobStore()),
        ),
      )
      const assertionSql = new SQL(database.url)
      try {
        const records = await Promise.all(stores.map((store) => store.ensureRepo('acme/new-repo')))
        expect(records).toHaveLength(stores.length)
        expect(
          records.every((record) => JSON.stringify(record) === JSON.stringify(records[0])),
        ).toBe(true)

        const rows = await assertionSql`SELECT * FROM repo_streams WHERE repo = ${'acme/new-repo'}`
        expect(rows).toHaveLength(1)
        const createdAt = rows[0]?.created_at
        const updatedAt = rows[0]?.updated_at
        expect(records[0]).toEqual({
          repo: 'acme/new-repo',
          createdAt:
            createdAt instanceof Date
              ? createdAt.toISOString()
              : new Date(String(createdAt)).toISOString(),
          updatedAt:
            updatedAt instanceof Date
              ? updatedAt.toISOString()
              : new Date(String(updatedAt)).toISOString(),
        })
      } finally {
        await assertionSql.close()
        await Promise.all(stores.map((store) => store.close()))
        await database.cleanup()
      }
    })

    test('concurrent creation of one absent build has one winner and normalized losers', async () => {
      const database = await isolatedDatabase()
      const stores = await Promise.all(
        Array.from({ length: 8 }, () =>
          openPostgresBuildStore(database.url, new MemoryBlobStore()),
        ),
      )
      const assertionSql = new SQL(database.url)
      try {
        const results = await Promise.allSettled(
          stores.map((store) => store.createBuild(sampleBuildInput('new-shared-build'))),
        )
        const fulfilled = results.filter((result) => result.status === 'fulfilled')
        const rejected = results.filter((result) => result.status === 'rejected')
        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(stores.length - 1)
        expect(rejected.map((result) => result.reason?.message)).toEqual(
          Array.from(
            { length: stores.length - 1 },
            () => 'build "new-shared-build" already exists',
          ),
        )

        const rows = await assertionSql`SELECT * FROM builds WHERE slug = ${'new-shared-build'}`
        expect(rows).toHaveLength(1)
        expect(rows[0]?.slug).toBe('new-shared-build')
        expect(rows[0]?.repo).toBe(sampleBuildInput('new-shared-build').repo)
      } finally {
        await assertionSql.close()
        await Promise.all(stores.map((store) => store.close()))
        await database.cleanup()
      }
    })

    test('fresh independent instances see prior writes and serialize streams', async () => {
      const database = await isolatedDatabase()
      const blobs = new MemoryBlobStore()
      const first = await openPostgresBuildStore(database.url, blobs)
      const second = await openPostgresBuildStore(database.url, blobs)
      try {
        await first.createBuild(sampleBuildInput('shared'))
        await first.ensureRepo('acme/shared')
        await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            (index % 2 ? first : second).append('shared', sampleEventWrite(String(index))),
          ),
        )
        await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            (index % 2 ? first : second).appendRepo('acme/shared', {
              actor: { kind: 'human', user: 'operator' },
              type: 'dispatcher.pause-set',
              payload: { enabled: index % 2 === 0 },
            }),
          ),
        )
        const contenders = await Promise.all([
          first.appendIfCurrent('shared', 20, sampleEventWrite('winner-a')),
          second.appendIfCurrent('shared', 20, sampleEventWrite('winner-b')),
        ])
        expect(contenders.filter(Boolean)).toHaveLength(1)
        expect((await second.getEvents('shared')).map((event) => event.seq)).toEqual(
          Array.from({ length: 21 }, (_, index) => index + 1),
        )
        expect((await first.getRepoEvents('acme/shared')).map((event) => event.seq)).toEqual(
          Array.from({ length: 20 }, (_, index) => index + 1),
        )
        await first.close()
        const fresh = await openPostgresBuildStore(database.url, blobs)
        try {
          expect(await fresh.getBuild('shared')).not.toBeNull()
        } finally {
          await fresh.close()
        }
      } finally {
        await second.close()
        await database.cleanup()
      }
    })

    test('separate processes serialize build/repository appends and conditional races', async () => {
      const database = await isolatedDatabase()
      const store = await openPostgresBuildStore(database.url, new MemoryBlobStore())
      try {
        await store.createBuild(sampleBuildInput('process-shared'))
        await store.ensureRepo('acme/process-shared')
        await Promise.all([
          runWorker(database.url, 'build', 'process-shared', 15),
          runWorker(database.url, 'build', 'process-shared', 15),
          runWorker(database.url, 'repo', 'acme/process-shared', 15),
          runWorker(database.url, 'repo', 'acme/process-shared', 15),
        ])
        expect((await store.getEvents('process-shared')).map((event) => event.seq)).toEqual(
          Array.from({ length: 30 }, (_, index) => index + 1),
        )
        expect(
          (await store.getRepoEvents('acme/process-shared')).map((event) => event.seq),
        ).toEqual(Array.from({ length: 30 }, (_, index) => index + 1))
        const conditional = await Promise.all([
          runWorker(database.url, 'conditional', 'process-shared', 30),
          runWorker(database.url, 'conditional', 'process-shared', 30),
        ])
        expect(conditional.sort()).toEqual(['stale', 'winner'])
      } finally {
        await store.close()
        await database.cleanup()
      }
    })
  })
} else {
  describe('PostgreSQL live contract', () => {
    test.skip('set AB_POSTGRES_TEST_URL to run the PostgreSQL contract and concurrency suite', () => {})
  })
}
