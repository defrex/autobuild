import { beforeEach, describe, expect, test } from 'bun:test'
import type { Exec } from '../ports/workspace/git-worktree'
import {
  REGISTRY_LAG_RETRY_DELAY_MS,
  installPackedDistribution,
  isRegistryLagFailure,
  resetRegistryLagCooldownForTests,
} from './packed-install'

const OBSERVED_GATEWAY_LAG =
  'error: No version matching "4.0.85" found for specifier "@ai-sdk/gateway" (but package exists)'

type Invocation = { cmd: string[]; cwd?: string }
type Outcome = { stdout?: string; stderr?: string; exitCode: number }

function scriptedRun(script: Outcome[]) {
  const invocations: Invocation[] = []
  const run: Exec = async (cmd, opts) => {
    invocations.push({ cmd, cwd: opts.cwd })
    const next = script.shift()
    if (!next) throw new Error(`unexpected extra invocation: ${cmd.join(' ')}`)
    return { stdout: next.stdout ?? '', stderr: next.stderr ?? '', exitCode: next.exitCode }
  }
  return { invocations, run }
}

describe('isRegistryLagFailure', () => {
  test('matches the real observed packument-lag signature', () => {
    expect(isRegistryLagFailure(OBSERVED_GATEWAY_LAG)).toBe(true)
    expect(isRegistryLagFailure(`$ bun install\n${OBSERVED_GATEWAY_LAG}\nexit code: 1`)).toBe(true)
  })

  test('matches the sibling-provider variants seen in reproduction', () => {
    expect(
      isRegistryLagFailure(
        'No version matching "4.0.85" found for specifier "@ai-sdk/provider" (but package exists)',
      ),
    ).toBe(true)
    expect(
      isRegistryLagFailure(
        'No version matching "4.0.85" found for specifier "@ai-sdk/provider-utils" (but package exists)',
      ),
    ).toBe(true)
  })

  test('rejects ordinary failures, empty output, and unrelated bun errors', () => {
    expect(isRegistryLagFailure('')).toBe(false)
    expect(isRegistryLagFailure('error: Package "@ai-sdk/gateway" not found in registry')).toBe(
      false,
    )
    expect(isRegistryLagFailure('ERR_PNPM_NO_MATCHING_VERSION 404 Not Found')).toBe(false)
    expect(isRegistryLagFailure('error: preinstall script failed with exit code 1')).toBe(false)
  })
})

describe('installPackedDistribution', () => {
  beforeEach(() => {
    resetRegistryLagCooldownForTests()
  })

  test('retries once with --no-cache after the full window on the lag signature', async () => {
    const { invocations, run } = scriptedRun([
      { stderr: OBSERVED_GATEWAY_LAG, exitCode: 1 },
      { stdout: 'installed', exitCode: 0 },
    ])
    const sleeps: number[] = []
    const now = 0

    const result = await installPackedDistribution(['--linker', 'isolated'], '/consumer', {
      run,
      clock: () => now,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    expect(result).toEqual({ stdout: 'installed', stderr: '', exitCode: 0 })
    expect(invocations).toHaveLength(2)
    expect(invocations[0]?.cmd).toEqual(['bun', 'install', '--linker', 'isolated'])
    expect(invocations[0]?.cwd).toBe('/consumer')
    expect(invocations[1]?.cmd).toEqual(['bun', 'install', '--linker', 'isolated', '--no-cache'])
    expect(invocations[1]?.cwd).toBe('/consumer')
    expect(sleeps).toEqual([REGISTRY_LAG_RETRY_DELAY_MS])
    expect(REGISTRY_LAG_RETRY_DELAY_MS).toBe(330_000)
  })

  test('returns immediately without a retry on a non-lag failure', async () => {
    const { invocations, run } = scriptedRun([
      { stderr: 'error: Package "@ai-sdk/gateway" not found in registry', exitCode: 1 },
    ])
    const sleeps: number[] = []

    const result = await installPackedDistribution([], '/consumer', {
      run,
      clock: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    expect(result.exitCode).toBe(1)
    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.cmd).toEqual(['bun', 'install'])
    expect(sleeps).toEqual([])
  })

  test('shares the cooldown: a lag failure after the window retries with no sleep', async () => {
    const first = scriptedRun([
      { stderr: OBSERVED_GATEWAY_LAG, exitCode: 1 },
      { stdout: 'installed', exitCode: 0 },
    ])
    const sleeps: number[] = []
    let now = 0
    const options = {
      clock: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
    }

    await installPackedDistribution([], '/a', { run: first.run, ...options })
    expect(sleeps).toEqual([REGISTRY_LAG_RETRY_DELAY_MS])

    // The window has already been crossed by the time the second packing test
    // fails with the same signature: no further sleep, immediate retry.
    now = REGISTRY_LAG_RETRY_DELAY_MS
    const second = scriptedRun([
      { stderr: OBSERVED_GATEWAY_LAG, exitCode: 1 },
      { stdout: 'installed', exitCode: 0 },
    ])
    const result = await installPackedDistribution([], '/b', { run: second.run, ...options })

    expect(result.exitCode).toBe(0)
    expect(second.invocations).toHaveLength(2)
    expect(second.invocations[1]?.cmd).toEqual(['bun', 'install', '--no-cache'])
    expect(sleeps).toEqual([REGISTRY_LAG_RETRY_DELAY_MS])
  })

  test('returns the first attempt untouched on success', async () => {
    const { invocations, run } = scriptedRun([{ stdout: 'resolved 312 packages', exitCode: 0 }])
    const sleeps: number[] = []

    const result = await installPackedDistribution(
      ['--production', '--ignore-scripts'],
      '/extracted',
      {
        run,
        clock: () => 0,
        sleep: async (ms) => {
          sleeps.push(ms)
        },
      },
    )

    expect(result).toEqual({ stdout: 'resolved 312 packages', stderr: '', exitCode: 0 })
    expect(invocations).toEqual([
      { cmd: ['bun', 'install', '--production', '--ignore-scripts'], cwd: '/extracted' },
    ])
    expect(sleeps).toEqual([])
  })
})
