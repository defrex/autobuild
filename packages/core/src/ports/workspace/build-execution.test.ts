import { describe, expect, test } from 'bun:test'
import { parseBuildChildLaunch } from './build-execution'

const identity = {
  slug: 'build',
  storeRef: 'https://store.example.test',
  instance: 'instance-1',
  workspaceRef: 'sandbox-1',
}

describe('parseBuildChildLaunch', () => {
  test('accepts the two disjoint supervision modes', () => {
    expect(
      parseBuildChildLaunch({
        ...identity,
        supervision: { kind: 'local-parent', parentPid: 42 },
      }),
    ).toEqual({ ...identity, supervision: { kind: 'local-parent', parentPid: 42 } })
    expect(parseBuildChildLaunch({ ...identity, supervision: { kind: 'environment' } })).toEqual({
      ...identity,
      supervision: { kind: 'environment' },
    })
  })

  test('fails closed for cross-mode, nonpositive, fractional, and incomplete envelopes', () => {
    for (const value of [
      { ...identity, supervision: { kind: 'environment', parentPid: 42 } },
      { ...identity, supervision: { kind: 'local-parent', parentPid: 0 } },
      { ...identity, supervision: { kind: 'local-parent', parentPid: -1 } },
      { ...identity, supervision: { kind: 'local-parent', parentPid: 1.5 } },
      { ...identity, supervision: { kind: 'local-parent' } },
      { ...identity, workspaceRef: '', supervision: { kind: 'environment' } },
      { ...identity, supervision: { kind: 'unknown' } },
    ]) {
      expect(parseBuildChildLaunch(value)).toBeUndefined()
    }
  })
})
