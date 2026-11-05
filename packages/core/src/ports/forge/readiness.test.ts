import { expect, test } from 'bun:test'
import { FakeForge } from './fake'
import { LocalGitForge } from './local-git'
import {
  branchGuardWarnings,
  inspectForgeReadiness,
  readinessChecks,
  readinessLabel,
} from './readiness'

test('local forge trivially passes the complete inventory', async () => {
  const checks = await inspectForgeReadiness(new LocalGitForge({ repoRoot: '/unused' }), {
    rootBranch: 'main',
  })
  expect(checks).toHaveLength(7)
  expect(checks.every((check) => check.status === 'pass')).toBe(true)
})
test('legacy capability and exceptions produce complete unknown checks', async () => {
  const forge = new FakeForge()
  Object.defineProperty(forge, 'inspectReadiness', { value: undefined, configurable: true })
  expect(
    (await inspectForgeReadiness(forge, { rootBranch: 'main' })).every(
      (check) => check.status === 'unknown',
    ),
  ).toBe(true)
  Object.defineProperty(forge, 'inspectReadiness', {
    value: () => {
      throw new Error('secret')
    },
  })
  const checks = await inspectForgeReadiness(forge, { rootBranch: 'main' })
  expect(JSON.stringify(checks)).not.toContain('secret')
  expect(checks.every((check) => check.status === 'unknown')).toBe(true)
})
test('classify hard failures, recommendations, and unknown independently', () => {
  const checks = readinessChecks('fail', 'Disabled')
  expect(readinessLabel(checks[0]!)).toBe('FAIL')
  expect(readinessLabel(checks[5]!)).toBe('WARN')
  checks[0]!.status = 'unknown'
  expect(readinessLabel(checks[0]!)).toBe('UNKNOWN')
})

test('branch guard warns once only when the adapter lacks remote branch existence', () => {
  expect(branchGuardWarnings(new FakeForge())).toEqual([])
  const lines = branchGuardWarnings({ name: 'plugin', remoteBranchExists: undefined })
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('forge plugin: cross-store branch collision protection is unavailable')
})
