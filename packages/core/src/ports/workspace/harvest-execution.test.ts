import { describe, expect, test } from 'bun:test'
import { HARVEST_RUNNER_OPTIONS_ENV, parseHarvestRunnerLaunch } from './harvest-execution'

const valid = {
  storeRef: 'https://store.example.test',
  repo: 'https://github.com/acme/app.git',
  instance: 'host-harvest-i1',
  baseBranch: 'main',
  supervision: { kind: 'environment' as const },
}

describe('harvest execution launch envelope', () => {
  test('parses a minimal environment-owned envelope', () => {
    expect(parseHarvestRunnerLaunch(valid)).toEqual(valid)
  })

  test('parses the full envelope with lease adoption, advisory ref, and environment identity', () => {
    const full = {
      ...valid,
      workspaceRef: 'autobuild-harvest-abc1234567',
      leaseHolder: 'host-dispatch-i0',
      environment: {
        provider: 'vercel-sandbox',
        environmentId: 'autobuild-harvest-abc1234567',
        sessionId: 'session-9',
      },
    }
    expect(parseHarvestRunnerLaunch(full)).toEqual(full)
  })

  test('rejects missing or invalid envelopes', () => {
    for (const bad of [
      undefined,
      null,
      'envelope',
      {},
      { ...valid, supervision: { kind: 'local-parent', parentPid: 123 } },
      { ...valid, supervision: { kind: 'environment', parentPid: 123 } },
      { ...valid, storeRef: '' },
      { ...valid, repo: '' },
      { ...valid, instance: '' },
      { ...valid, baseBranch: '' },
      { ...valid, leaseHolder: '' },
      { ...valid, workspaceRef: '' },
      { ...valid, environment: { provider: '', environmentId: 'env' } },
      { ...valid, environment: { provider: 'p', environmentId: '' } },
      { ...valid, environment: { provider: 'p', environmentId: 'e', sessionId: '' } },
      { ...valid, environment: 'env' },
    ]) {
      expect(parseHarvestRunnerLaunch(bad)).toBeUndefined()
    }
  })

  test('the envelope env var name mirrors the build child convention', () => {
    expect(HARVEST_RUNNER_OPTIONS_ENV).toBe('AB_HARVEST_RUNNER_OPTIONS')
  })
})
