import { describe, expect, test } from 'bun:test'
import { createProductionRuntimes } from '../ports/runner/production'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import {
  probeInitRuntimes,
  sanitizeSetupEnvironment,
  selectSetupRuntime,
  setupAgentCommand,
  SETUP_RUNTIME_PREFERENCE,
} from './init-agent'

const runner = createProductionRuntimes().runtimes.claude!.runner

function registration(result: boolean | { usable: boolean; reason: string }) {
  return { runner, servesModels: [], initUsable: async () => result }
}

describe('init runtime probing and selection', () => {
  test('probes preferred names first, then plugin names lexically', async () => {
    const runtimes: RuntimeRegistry = {
      zebra: registration(true),
      pi: registration({ usable: true, reason: 'pi ready' }),
      alpha: registration(false),
      claude: registration({ usable: false, reason: 'logged out' }),
      codex: registration(true),
    }
    const reports = await probeInitRuntimes(runtimes, '/repo', {})
    expect(reports.map((report) => report.runtime)).toEqual([
      'claude',
      'codex',
      'pi',
      'alpha',
      'zebra',
    ])
    expect(reports.find((report) => report.runtime === 'zebra')).toMatchObject({
      usable: true,
      reason: 'usable',
    })
    expect(selectSetupRuntime(reports)).toBe('codex')
  })

  test('the launcher preference and direct interactive argv are explicit', () => {
    expect(SETUP_RUNTIME_PREFERENCE).toEqual(['claude', 'codex', 'pi'])
    for (const runtime of SETUP_RUNTIME_PREFERENCE) {
      expect(setupAgentCommand(runtime, 'exact prompt')).toEqual([runtime, 'exact prompt'])
    }
    expect(() => setupAgentCommand('plugin-only', 'prompt')).toThrow(
      'no interactive setup launcher',
    )
    expect(
      selectSetupRuntime([
        { runtime: 'pi', usable: true, reason: 'ready' },
        { runtime: 'claude', usable: true, reason: 'ready' },
      ]),
    ).toBe('claude')
  })

  test('reports absent and throwing probes without hiding other runtimes', async () => {
    const runtimes: RuntimeRegistry = {
      absent: { runner, servesModels: [] },
      thrown: {
        runner,
        servesModels: [],
        initUsable: async () => {
          throw new Error('executable missing')
        },
      },
    }
    expect(await probeInitRuntimes(runtimes, '/repo', {})).toEqual([
      { runtime: 'absent', usable: false, reason: 'no init usability probe is registered' },
      { runtime: 'thrown', usable: false, reason: 'probe failed: executable missing' },
    ])
  })
})

describe('setup child environment', () => {
  test('removes every ambient Autobuild identity and preserves ordinary values', () => {
    expect(
      sanitizeSetupEnvironment({
        PATH: '/bin',
        HOME: '/home/test',
        AB_BUILD: 'other-build',
        AB_SESSION: 'session',
        AB_HARVEST: 'harvest',
        AB_STORE: '/secret/store',
        UNSET: undefined,
      }),
    ).toEqual({ PATH: '/bin', HOME: '/home/test' })
  })
})
