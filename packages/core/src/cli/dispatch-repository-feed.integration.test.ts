import { expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import { MemoryBuildStore } from '../store/memory'

const clock = () => new Date('2026-10-16T00:00:00Z')

test.each([false, true])(
  'frontend read budget stays flat across thousands of journal events (memory=%s)',
  async (memory) => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { openLocalStore } = await import('../store/local/store')
    const { dispatchReadBudget } = await import('../testing/dispatch-read-budget')
    const root = await mkdtemp(join(tmpdir(), 'ab-dashboard-feed-'))
    try {
      const store = memory ? new MemoryBuildStore() : openLocalStore(root)
      await dispatchReadBudget(
        store,
        store,
        memory
          ? undefined
          : async (repo, count) => {
              // Bulk fixture construction avoids 100,000 separate SQLite transactions.
              const { validateRepositoryEventWrite } = await import('../events/repository')
              const event = validateRepositoryEventWrite({
                actor: DISPATCHER,
                type: 'dispatcher.run-stopped',
                payload: { run: 'discarded', outcome: 'normal' },
              })
              const sqlite = (store as unknown as { sqlite: import('bun:sqlite').Database }).sqlite
              const high = await store.getRepoHighWater(repo)
              sqlite
                .query(`WITH RECURSIVE gap(seq) AS (
          SELECT 1 UNION ALL SELECT seq + 1 FROM gap WHERE seq < ?2
        ) INSERT INTO repo_events (repo, seq, ts, actor, type, payload)
          SELECT ?1, ?3 + seq, ?4, ?5, ?6, ?7 FROM gap`)
                .run(
                  repo,
                  count,
                  high,
                  clock().toISOString(),
                  JSON.stringify(event.actor),
                  event.type,
                  JSON.stringify(event.payload),
                )
            },
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

// The placement selector stats project credentials on disk, so this budget
// proof cannot run under the unit IO guard.
test('placement read budget is bounded across fresh readers', async () => {
  const { placementReadBudget } = await import('../testing/reduced-read-budget')
  const { readDispatchPlacement } = await import('../store/reduced-reads')
  const { MemoryBuildStore } = await import('../store/memory')
  const store = new MemoryBuildStore()
  await placementReadBudget({
    store,
    select: async (repo) => {
      const { selectDispatchMode } = await import('./dispatch-mode')
      const { resolveRepoStatePaths } = await import('./repo-state')
      let reads = 0
      const result = await selectDispatchMode(
        {
          targetRepo: '/checkout',
          env: {},
          exec: async () => {
            throw new Error('unexpected exec')
          },
          stderr: () => {},
        },
        {
          resolve: async () =>
            resolveRepoStatePaths({ repo, checkout: '/checkout', storeRef: 'https://store.test' }),
          open: () => ({
            getDispatchPlacement: async (key) => {
              reads++
              return (await readDispatchPlacement(store, key)).value
            },
            close: async () => {},
          }),
        },
      )
      expect(reads).toBe(1)
      return result
    },
    fresh: async () => ({
      getDispatchPlacement: async (repo) => (await readDispatchPlacement(store, repo)).value,
    }),
  })
})
