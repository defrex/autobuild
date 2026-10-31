import { MemoryBuildStore } from '@defrex/autobuild/plugin-sdk'
import { createStoreServer } from '../remote-store-server'
import assert from 'node:assert/strict'
import { AUTOBUILD_VERSION, REMOTE_STORE_PROTOCOL_VERSION } from '@defrex/autobuild/remote-store'
import { verifyAuditCapability } from './audit-capability'

assert.equal(AUTOBUILD_VERSION, '1.3.0')
await verifyAuditCapability('1.2.0', '6', true)
await verifyAuditCapability('1.3.0', '6', true)
await verifyAuditCapability('1.3.0', REMOTE_STORE_PROTOCOL_VERSION, true)
console.log('audit service verified')

const server = createStoreServer({ store: new MemoryBuildStore() })
const response = await server.fetch(
  new Request('http://test/builds', {
    headers: { 'x-autobuild-version': '1.1.0', 'x-autobuild-protocol-version': '6' },
  }),
)
assert.equal(response.status, 409)
