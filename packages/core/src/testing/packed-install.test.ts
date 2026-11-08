import { beforeEach, describe, expect, test } from 'bun:test'
import type { Exec } from '../ports/workspace/git-worktree'
import {
  INSTALL_STDERR_LIMIT,
  PackedInstallError,
  REGISTRY_LAG_RETRY_DELAY_MS,
  installPackedDistribution,
  isRegistryLagFailure,
  isTransientInstallFailure,
  resetRegistryLagCooldownForTests,
} from './packed-install'

const OBSERVED_GATEWAY_LAG =
  'error: No version matching "4.0.85" found for specifier "@ai-sdk/gateway" (but package exists)'

// Verbatim bun 1.4.4 stderr measured against a scripted fake registry.
const CONNECTION_REFUSED =
  'error: ConnectionRefused downloading package manifest left-pad\nerror: left-pad@1.3.0 failed to resolve'
const CONNECTION_CLOSED =
  'error: ConnectionClosed downloading package manifest left-pad\nerror: left-pad@1.3.0 failed to resolve'
const DNS_FAILED =
  'error: DNSResolveFailed downloading package manifest left-pad\nerror: left-pad@1.3.0 failed to resolve'
const MANIFEST_503 =
  'error: GET http://127.0.0.1:4873/left-pad - 503\nerror: left-pad@1.3.0 failed to resolve'
const TARBALL_503 = 'error: GET http://127.0.0.1:4873/left-pad/-/left-pad-1.3.0.tgz - 503'
const MANIFEST_429 = 'error: GET http://127.0.0.1:4873/left-pad - 429'
const MANIFEST_404 =
  'error: GET http://127.0.0.1:4873/left-pad - 404\nerror: left-pad@1.3.0 failed to resolve'
const TARBALL_404 = 'error: GET http://127.0.0.1:4873/left-pad/-/left-pad-1.3.0.tgz - 404'
const INTEGRITY =
  'error: Integrity check failed for tarball: left-pad\nerror: IntegrityCheckFailed extracting tarball from left-pad'
const JSON_PARSE =
  '1 | {"_id":"left-pad","name":"left-pad","versions":{"1.3.0":{\n    ^\nerror: Unexpected end of input'
const PANIC =
  'panic(main thread): called `Option::unwrap()` on a `None` value\noh no: Bun has crashed.'

const silent = () => {}

function recorder() {
  const sleeps: number[] = []
  const logs: string[] = []
  return {
    sleeps,
    logs,
    options: {
      clock: () => 0,
      cooldown: {},
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
      log: (message: string) => {
        logs.push(message)
      },
    },
  }
}

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

describe('isTransientInstallFailure', () => {
  test('accepts each measured transient signature', () => {
    for (const output of [
      CONNECTION_REFUSED,
      CONNECTION_CLOSED,
      DNS_FAILED,
      MANIFEST_503,
      TARBALL_503,
      MANIFEST_429,
      `bun install v1.4.4\r\n\x1b[31m${TARBALL_503}\x1b[0m\r\n`,
    ])
      expect(isTransientInstallFailure(output)).toBe(true)
  })

  test('rejects deterministic failures, panics, and mixed output', () => {
    for (const output of [
      MANIFEST_404,
      TARBALL_404,
      INTEGRITY,
      'error: IntegrityCheckFailed extracting tarball from left-pad',
      JSON_PARSE,
      OBSERVED_GATEWAY_LAG,
      PANIC,
      '',
      'error: left-pad@1.3.0 failed to resolve',
      `${CONNECTION_REFUSED}\nerror: IntegrityCheckFailed extracting tarball from left-pad`,
    ])
      expect(isTransientInstallFailure(output)).toBe(false)
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
      log: silent,
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

  test('throws without a retry on an unclassified failure', async () => {
    const { invocations, run } = scriptedRun([
      { stderr: 'error: Package "@ai-sdk/gateway" not found in registry', exitCode: 1 },
    ])
    const { sleeps, options } = recorder()

    const failure = await installPackedDistribution([], '/consumer', { run, ...options }).catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(PackedInstallError)
    expect((failure as PackedInstallError).attempts).toBe(1)
    expect((failure as PackedInstallError).result.exitCode).toBe(1)
    expect((failure as Error).message).toContain('not found in registry')
    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.cmd).toEqual(['bun', 'install'])
    expect(sleeps).toEqual([])
  })

  test('retries a transient failure after a short delay and logs its stderr', async () => {
    const { invocations, run } = scriptedRun([
      { stderr: CONNECTION_REFUSED, exitCode: 1 },
      { stdout: 'installed', exitCode: 0 },
    ])
    const { sleeps, logs, options } = recorder()

    const result = await installPackedDistribution(['--production'], '/consumer', {
      run,
      ...options,
    })

    expect(result.exitCode).toBe(0)
    expect(invocations.map((invocation) => invocation.cmd)).toEqual([
      ['bun', 'install', '--production'],
      ['bun', 'install', '--production'],
    ])
    expect(sleeps).toEqual([2_000])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('attempt 1 of 3')
    expect(logs[0]).toContain(CONNECTION_REFUSED)
  })

  test('throws after the bounded transient retries are spent', async () => {
    const { invocations, run } = scriptedRun([
      { stderr: MANIFEST_503, exitCode: 1 },
      { stderr: DNS_FAILED, exitCode: 1 },
      { stderr: TARBALL_503, exitCode: 1 },
    ])
    const { sleeps, options } = recorder()

    const failure = await installPackedDistribution([], '/consumer', { run, ...options }).catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(PackedInstallError)
    expect((failure as PackedInstallError).attempts).toBe(3)
    expect((failure as Error).message).toContain('exit 1, 3 attempt(s)')
    expect((failure as Error).message).toContain(TARBALL_503)
    expect(invocations).toHaveLength(3)
    expect(sleeps).toEqual([2_000, 5_000])
  })

  test('throws a deterministic failure at once with its stderr', async () => {
    for (const stderr of [INTEGRITY, MANIFEST_404]) {
      const { invocations, run } = scriptedRun([
        { stderr, stdout: 'bun install v1.4.4', exitCode: 1 },
      ])
      const { sleeps, logs, options } = recorder()

      const failure = await installPackedDistribution([], '/consumer', { run, ...options }).catch(
        (error: unknown) => error,
      )

      expect(failure).toBeInstanceOf(PackedInstallError)
      expect((failure as Error).message).toContain(stderr)
      expect((failure as Error).message).toContain('bun install v1.4.4')
      expect(invocations).toHaveLength(1)
      expect(sleeps).toEqual([])
      expect(logs).toEqual([])
    }
  })

  test('bounds the stderr carried into the error to its tail', async () => {
    const tail = 'error: IntegrityCheckFailed extracting tarball from left-pad'
    const stderr = `${'x'.repeat(50_000)}\n${tail}`
    const { run } = scriptedRun([{ stderr, exitCode: 1 }])
    const { options } = recorder()

    const failure = (await installPackedDistribution([], '/consumer', { run, ...options }).catch(
      (error: unknown) => error,
    )) as Error

    const section = failure.message.split('--- stderr')[1]?.split('\n--- stdout')[0] ?? ''
    const body = section.slice(section.indexOf('\n') + 1)
    expect(body.startsWith('… (truncated)')).toBe(true)
    expect(body.length).toBeLessThanOrEqual(INSTALL_STDERR_LIMIT + '… (truncated)'.length)
    expect(body.endsWith(tail)).toBe(true)
    expect(failure.message).toContain('(empty)')
  })

  test('allowFailure returns the non-zero result instead of throwing', async () => {
    const { invocations, run } = scriptedRun([{ stderr: PANIC, exitCode: 134 }])
    const { sleeps, options } = recorder()

    const result = await installPackedDistribution([], '/negative', {
      run,
      ...options,
      allowFailure: true,
    })

    expect(result).toEqual({ stdout: '', stderr: PANIC, exitCode: 134 })
    expect(invocations).toHaveLength(1)
    expect(sleeps).toEqual([])
  })

  test('a lag failure then a transient failure retries each path within bounds', async () => {
    const { invocations, run } = scriptedRun([
      { stderr: OBSERVED_GATEWAY_LAG, exitCode: 1 },
      { stderr: CONNECTION_CLOSED, exitCode: 1 },
      { stdout: 'installed', exitCode: 0 },
    ])
    const { sleeps, logs, options } = recorder()

    const result = await installPackedDistribution([], '/consumer', { run, ...options })

    expect(result.exitCode).toBe(0)
    expect(invocations.map((invocation) => invocation.cmd)).toEqual([
      ['bun', 'install'],
      ['bun', 'install', '--no-cache'],
      ['bun', 'install'],
    ])
    expect(sleeps).toEqual([REGISTRY_LAG_RETRY_DELAY_MS, 2_000])
    expect(logs[0]).toContain('registry-lag signature')
    expect(logs[0]).toContain(OBSERVED_GATEWAY_LAG)
    expect(options.cooldown).toEqual({ since: 0 })
  })

  test('a repeated lag failure after its one retry throws', async () => {
    const { invocations, run } = scriptedRun([
      { stderr: OBSERVED_GATEWAY_LAG, exitCode: 1 },
      { stderr: OBSERVED_GATEWAY_LAG, exitCode: 1 },
    ])
    const { sleeps, options } = recorder()

    const failure = await installPackedDistribution([], '/consumer', { run, ...options }).catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(PackedInstallError)
    expect((failure as PackedInstallError).attempts).toBe(2)
    expect(invocations).toHaveLength(2)
    expect(sleeps).toEqual([REGISTRY_LAG_RETRY_DELAY_MS])
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
        log: silent,
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
        log: silent,
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
      log: silent,
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
        log: silent,
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
      log: silent,
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
        log: silent,
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
