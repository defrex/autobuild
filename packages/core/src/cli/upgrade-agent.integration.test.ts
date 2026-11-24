import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import type { OneShotCompletion } from '../ports/runner/one-shot'
import { ScriptedAgentRunner, defaultTurnResult } from '../ports/runner/fake'
import { createUpgradeAgentResolver } from './upgrade-agent'

const INPUT = {
  skill: 'ab-plan',
  path: 'SKILL.md',
  base: '---\nname: ab-plan\n---\nbase bytes\n',
  local: '---\nname: ab-plan\n---\nlocal bytes\n',
  incoming: '---\nname: ab-plan\n---\nincoming bytes\n',
}

function runner(): ScriptedAgentRunner {
  return new ScriptedAgentRunner({ script: () => defaultTurnResult() })
}

function config(roles: string) {
  return parseConfig(`[tickets]\nsource = "file"\nreadyState = "ready"\n\n${roles}`, 'fixture.toml')
}

function registration(
  oneShot: OneShotCompletion | undefined,
  servesModels: string[],
  defaultModel?: string,
) {
  return {
    runner: runner(),
    ...(oneShot !== undefined ? { oneShot } : {}),
    servesModels,
    ...(defaultModel !== undefined ? { defaultModel } : {}),
  }
}

describe('createUpgradeAgentResolver deadline', () => {
  test('a stalled completion is aborted at the fixed caller-owned deadline', async () => {
    let signal: AbortSignal | undefined
    const stalled = createUpgradeAgentResolver({
      targetRepo: '/repo',
      env: {},
      timeoutMs: 5,
      load: async () => config('[roles.default]\nruntime = "alpha"\n'),
      runtimeFactory: () => ({
        runtimes: {
          alpha: registration(
            {
              complete: (input) => {
                signal = input.signal
                return new Promise(() => {})
              },
            },
            ['alpha-'],
          ),
        },
      }),
    })

    await expect(stalled(INPUT)).rejects.toThrow(
      'upgrade conflict resolution deadline exceeded after 5ms',
    )
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(true)
  })
})
