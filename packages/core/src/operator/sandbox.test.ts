import { describe, expect, test } from 'bun:test'
import { SandboxOperationError } from '../ports/workspace/operator-sandbox'
import {
  resolveSandboxRelativePath,
  truncateSandboxOutput,
  SANDBOX_TRUNCATION_MARKER,
  sandboxPublicationBranch,
} from './sandbox'

describe('resolveSandboxRelativePath', () => {
  test('normalizes safe relative paths and rejects every escape shape', () => {
    expect(resolveSandboxRelativePath('src/a.txt')).toBe('src/a.txt')
    expect(resolveSandboxRelativePath('./src/./a.txt')).toBe('src/a.txt')
    expect(resolveSandboxRelativePath('src/../a.txt')).toBe('a.txt')
    for (const bad of ['../x', '/abs', 'a/../../b', '', '.', 'a/..', 'C:/x']) {
      expect(() => resolveSandboxRelativePath(bad)).toThrow(SandboxOperationError)
    }
  })
})

describe('truncateSandboxOutput', () => {
  test('returns output at the bound unchanged and appends the marker past it', () => {
    const exact = 'a'.repeat(65_536)
    expect(truncateSandboxOutput(exact)).toBe(exact)
    const over = 'b'.repeat(65_537)
    const truncated = truncateSandboxOutput(over)
    expect(truncated.startsWith('b'.repeat(65_536))).toBe(true)
    expect(truncated).toContain(SANDBOX_TRUNCATION_MARKER)
  })
})

test('branch naming: an operator with no alphanumerics still yields a canonical branch', () => {
  const branch = sandboxPublicationBranch('https://github.com/acme/widgets', '@@@')
  expect(branch).toMatch(/^ab\/orch--[0-9a-f]{8}$/)
  expect(branch).toMatch(/^ab\/[a-z0-9][a-z0-9-]*$/)
  const normal = sandboxPublicationBranch('https://github.com/acme/widgets', 'Ada Lovelace!')
  expect(normal).toBe(
    `ab/orch-ada-lovelace-${require('node:crypto')
      .createHash('sha256')
      .update('https://github.com/acme/widgets\0Ada Lovelace!')
      .digest('hex')
      .slice(0, 8)}`,
  )
})
