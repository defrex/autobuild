import { expect, test } from 'bun:test'
import { MemoryBuildStore } from '../store/memory'
import { FakeForge } from '../ports/forge/fake'
import { proveTargetLineage } from './target-lineage'
import { nodeRestackLog } from './generators/node-restack-log'

const oid = (n: number) => n.toString(16).padStart(40, '0')
async function fixture(count: number) {
  const store = new MemoryBuildStore()
  await store.createBuild({ slug: 'parent', repo: 'repo', branch: 'ab-node/parent' })
  const log = nodeRestackLog()
  // Real complete transactions exercise settled receipt retention too.
  for (const e of log.slice(0, 2)) await store.append('parent', e)
  for (let i = 1; i <= count; i++) {
    for (const e of log.slice(2)) {
      const payload = JSON.parse(
        JSON.stringify(e.payload)
          .replaceAll('node-tx', `tx-${i}`)
          .replaceAll('a'.repeat(40), oid(i))
          .replaceAll('c'.repeat(40), oid(i + 1)),
      )
      await store.append('parent', { actor: e.actor, type: e.type, payload })
    }
  }
  const forge = new FakeForge()
  for (let i = 1; i <= count + 2; i++) forge.seedCommit(oid(i))
  const prove = (from: string, sha: string, branch = 'ab-node/parent') =>
    proveTargetLineage({ store, forge, node: 'parent', from, sha, branch })
  return { store, forge, prove }
}
test('walks settled receipts and rejects missing links, foreign heads and branch ownership alone', async () => {
  const { store, prove } = await fixture(2)
  expect((await prove(oid(1), oid(3)))?.receipts.map((r) => r.id)).toEqual(['tx-1', 'tx-2'])
  expect(await prove(oid(1), oid(4))).toBeUndefined()
  expect(await prove(oid(1), oid(3), 'main')).toBeUndefined()
  expect(await prove(oid(4), oid(3))).toBeUndefined()
  const copy = await store.getNodeRewrite('parent', oid(1))
  copy!.head = oid(4)
  expect((await store.getNodeRewrite('parent', oid(1)))?.head).toBe(oid(2))
})
test('caps proof at 64 hops and never accepts a longer gap', async () => {
  const { store, prove } = await fixture(65)
  let reads = 0
  const get = store.getNodeRewrite.bind(store)
  store.getNodeRewrite = async (...args) => {
    reads++
    return get(...args)
  }
  expect(await prove(oid(1), oid(66))).toBeUndefined()
  expect(reads).toBe(64)
  reads = 0
  expect((await prove(oid(2), oid(66)))?.receipts).toHaveLength(64)
  expect(reads).toBe(64)
})
test('latest publication bridge proves immutable ancestry on both sides', async () => {
  const { forge, prove } = await fixture(1)
  forge.seedCommit(oid(1), [oid(3)])
  forge.seedCommit(oid(4), [oid(2)])
  expect((await prove(oid(3), oid(4)))?.receipts).toEqual([
    { id: 'tx-1', previous: oid(1), head: oid(2) },
  ])
  expect(await prove(oid(4), oid(3))).toBeUndefined()
})
