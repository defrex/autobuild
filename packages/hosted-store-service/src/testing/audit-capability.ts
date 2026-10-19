import assert from 'node:assert/strict'
import { MemoryBuildStore, sampleBuildInput } from '@defrex/autobuild/plugin-sdk'
import { DISPATCHER } from '@defrex/autobuild/testing'
import {
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '@defrex/autobuild/remote-store'
import { createStoreServer } from '../remote-store-server'

export async function verifyAuditCapability(version: string, protocol: string, supported: boolean) {
  const store = new MemoryBuildStore()
  const repo = 'acme/audit-digest'
  const slug = 'audit-digest'
  await store.createBuild(sampleBuildInput(slug, { repo }))
  const server = createStoreServer({ store })
  const check = async (pending: boolean) => {
    assert.equal(
      (await store.getRepoBuildDigests(repo)).get(slug)?.integrationAuditPending,
      pending ? true : undefined,
    )
    const response = await server.fetch(
      new Request(`http://test/repos/${encodeURIComponent(repo)}/build-digests`, {
        headers: {
          [AUTOBUILD_VERSION_HEADER]: version,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: protocol,
        },
      }),
    )
    assert.equal(response.status, 200)
    const [digest] = (await response.json()) as Record<string, unknown>[]
    assert.ok(digest)
    assert.equal(digest.slug, slug)
    if (supported && pending) assert.equal(digest.integrationAuditPending, true)
    else assert.equal(Object.hasOwn(digest, 'integrationAuditPending'), false)
  }
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'integration.landed',
    payload: {
      operation: 'landing-1',
      head: 'head',
      landed: 'landed',
      provenance: 'kernel',
      verified: true,
      fenced: false,
    },
  })
  await check(true)
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'build.completed',
    payload: { outcome: 'merged' },
  })
  await check(true)
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'integration.audited',
    payload: { operation: 'landing-1', verifiedTree: 'tree', landedTree: 'tree', identities: [] },
  })
  await check(false)
}
