import { expect, test } from 'bun:test'
import { delegationSeamScenarios } from './delegation-integration'

test('native delegation seam inventory retains authority and durable lifecycle boundaries', () => {
  const cases = delegationSeamScenarios(),
    ids = cases.map((c) => c.id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const id of [
    'admin-build-runner',
    'admin-harvest-runner',
    'owner-build-phase',
    'dispatcher-build-phase',
    'internal-build-phase',
    'runner-cannot-widen',
    'foreign-owner',
    'version-before-auth',
    'auth-before-invalid-json',
    'admin-build-within',
    'admin-build-expired',
    'admin-phase-within',
    'admin-phase-expired',
    'harvest-runner-harvest-within',
    'harvest-runner-harvest-expired',
    'harvest-runner-harvest-suspended',
    'harvest-runner-authorization-replaced',
    'build-runner-session-predates',
    'build-runner-stale-anchor',
    'owner-revoked',
    'owner-expired',
    'owner-removed',
  ])
    expect(ids).toContain(id)
})
