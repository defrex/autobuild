import assert from 'node:assert/strict'
import { AUTOBUILD_VERSION, REMOTE_STORE_PROTOCOL_VERSION } from '@defrex/autobuild/remote-store'
import { verifyAuditCapability } from './audit-capability'

assert.equal(AUTOBUILD_VERSION, '0.14.0')
await verifyAuditCapability('0.13.0', '3', false)
await verifyAuditCapability('0.14.0', REMOTE_STORE_PROTOCOL_VERSION, true)
console.log('audit service verified')
