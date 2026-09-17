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

  test('re-anchors on a second independent lag window instead of flooring the delay to zero', async () => {
    const sleeps: number[] = []
    let now = 0
    const clock = () => now
    const sleep = async (ms: number) => {
      sleeps.push(ms)
    }

    // A distinct lag event begins after the first window has fully elapsed
    // (the reported bug scenario at and beyond the 330s boundary): it must pay
    // its own full window, not a zero-length delay from the stale anchor. Each
    // case is an independent process: first lag at t = 0, second at `start`.
    const cases = [REGISTRY_LAG_RETRY_DELAY_MS, REGISTRY_LAG_RETRY_DELAY_MS + 10_000]
    for (const [index, start] of cases.entries()) {
      const cooldown = {}
      now = 0
      sleeps.length = 0
      const first = scriptedRun([
        { stderr: OBSERVED_GATEWAY_LAG, exitCode: 1 },
        { stdout: 'installed', exitCode: 0 },
      ])
      await installPackedDistribution([], '/a', {
        run: first.run,
        cooldown,
        clock,
        sleep,
      })
      expect(sleeps).toEqual([REGISTRY_LAG_RETRY_DELAY_MS])

      now = start
      sleeps.length = 0
      const second = scriptedRun([
        { stderr: OBSERVED_GATEWAY_LAG, exitCode: 1 },
        { stdout: `installed ${index}`, exitCode: 0 },
      ])
      const result = await installPackedDistribution([], '/later', {
        run: second.run,
        cooldown,
        clock,
        sleep,
      })

      expect(result.exitCode).toBe(0)
      expect(second.invocations).toHaveLength(2)
      expect(second.invocations[1]?.cmd).toEqual(['bun', 'install', '--no-cache'])
      expect(sleeps).toEqual([REGISTRY_LAG_RETRY_DELAY_MS])
    }
  })

  test('shares the cooldown within an unelapsed window: sleeps only the remainder', async () => {
    const cooldown = {}
    const sleeps: number[] = []
    let now = 0
    const options = {
      cooldown,
      clock: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
    }

    const first = scriptedRun([
      { stderr: OBSERVED_GATEWAY_LAG, exitCode: 1 },
      { stdout: 'installed', exitCode: 0 },
    ])
    await installPackedDistribution([], '/a', { run: first.run, ...options })
    expect(sleeps).toEqual([REGISTRY_LAG_RETRY_DELAY_MS])

    // Still inside the first lag's window: the second install shares the
    // remainder and keeps the original anchor.
    now = 100_000
    const second = scriptedRun([
      { stderr: OBSERVED_GATEWAY_LAG, exitCode: 1 },
      { stdout: 'installed', exitCode: 0 },
    ])
    const result = await installPackedDistribution([], '/b', { run: second.run, ...options })

    expect(result.exitCode).toBe(0)
    expect(second.invocations).toHaveLength(2)
    expect(second.invocations[1]?.cmd).toEqual(['bun', 'install', '--no-cache'])
    expect(sleeps).toEqual([REGISTRY_LAG_RETRY_DELAY_MS, REGISTRY_LAG_RETRY_DELAY_MS - 100_000])
  })

  test('injected cooldown state makes the delay math order-independent', async () => {
    const sleeps: number[] = []
    const sleep = async (ms: number) => {
      sleeps.push(ms)
    }

    // Two calls with separate injected state each pay the full window,
    // regardless of order; neither sees the other's anchor.
    for (const cwd of ['/a', '/b']) {
      const run = scriptedRun([
        { stderr: OBSERVED_GATEWAY_LAG, exitCode: 1 },
        { stdout: 'installed', exitCode: 0 },
      ])
      await installPackedDistribution([], cwd, {
        run: run.run,
        cooldown: {},
        clock: () => 0,
        sleep,
      })
    }
    expect(sleeps).toEqual([REGISTRY_LAG_RETRY_DELAY_MS, REGISTRY_LAG_RETRY_DELAY_MS])

    // Deliberately stale injected state (older than the window) — the exact
    // production bug scenario, expressed through the seam — pays the full
    // window instead of flooring the delay to 0.
    const stale = scriptedRun([
      { stderr: OBSERVED_GATEWAY_LAG, exitCode: 1 },
      { stdout: 'installed', exitCode: 0 },
    ])
    sleeps.length = 0
    await installPackedDistribution([], '/stale', {
      run: stale.run,
      cooldown: { since: -REGISTRY_LAG_RETRY_DELAY_MS },
      clock: () => 0,
      sleep,
    })
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
