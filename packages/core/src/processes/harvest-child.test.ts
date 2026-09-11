import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryBuildStore } from '../store/memory'
import { steppingClock } from '../testing/fixed'
import type { BuildStore } from '../store/types'
import { runHarvestChild } from './harvest-child'

const HOST_ENV = {
  provider: 'vercel-sandbox',
  environmentId: 'autobuild-harvest-abc1234567',
  sessionId: 'session-1',
}

function guestInput(over: Partial<Parameters<typeof runHarvestChild>[0]> = {}) {
  return {
    storeRef: 'https://store.example.test',
    repo: '/repo',
    instance: 'host-harvest-i1',
    baseBranch: 'main',
    supervision: { kind: 'environment' as const },
    ...over,
  }
}

/** A minimal checkout the guest loads its config from. The file ticket source
 * needs no external authority, so the composition runs end to end offline. */
async function guestWorkspace(tickets: string[]): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-child-'))
  await writeFile(
    join(workspace, 'autobuild.toml'),
    [
      'baseBranch = "main"',
      '[tickets]',
      ...tickets,
      '[roles.default]',
      'runtime = "pi"',
      '[policy]',
      'harvestThreshold = 5',
      'harvestMaxDrift = 3',
    ].join('\n'),
  )
  return workspace
}

describe('harvest child (guest runner composition)', () => {
  test('assembles deps from the checkout config, adopts the lease holder, and closes the store', async () => {
    const workspace = await guestWorkspace(['source = "file"', 'readyState = "Ready"'])
    const clock = steppingClock()
    const store = new MemoryBuildStore({ clock })
    await store.ensureRepo('/repo')
    const closes: number[] = []
    const openStore = (): BuildStore => {
      const inner = store
      return new Proxy(inner, {
        get(target, key, receiver) {
          if (key === 'close') {
            return async () => {
              closes.push(1)
              return target.close()
            }
          }
          return Reflect.get(target, key, receiver)
        },
      })
    }
    // The owning dispatch loop already holds the repository lease; the guest
    // heartbeats the adopted holder and never releases it.
    await store.claimRepoLease('/repo', 'host-dispatch-i0', 60_000)
    try {
      await runHarvestChild(
        guestInput({ leaseHolder: 'host-dispatch-i0', environment: HOST_ENV }),
        { AB_STORE: 'https://store.example.test', AB_TOKEN: 'scoped-token' },
        openStore,
        workspace,
      )
      // No observations queued: the run is idle, nothing was claimed, and the
      // adopted lease is still held (release belongs to the owning loop).
      expect((await store.getRepoEvents('/repo')).some((e) => e.type === 'harvest.started')).toBe(
        false,
      )
      expect(closes).toHaveLength(1)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test('missing AB_TOKEN fails fast for a hosted ticket source and still closes the store', async () => {
    const workspace = await guestWorkspace([
      'source = "hosted"',
      'teamKey = "AUT"',
      'readyState = "Todo"',
    ])
    const store = new MemoryBuildStore({ clock: steppingClock() })
    let closed = false
    const openStore = (): BuildStore =>
      new Proxy(store, {
        get(target, key, receiver) {
          if (key === 'close') {
            return async () => {
              closed = true
              return target.close()
            }
          }
          return Reflect.get(target, key, receiver)
        },
      })
    try {
      await expect(
        runHarvestChild(
          guestInput(),
          { AB_STORE: 'https://store.example.test' },
          openStore,
          workspace,
        ),
      ).rejects.toThrow(/AB_TOKEN/)
      expect(closed).toBe(true)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test('the shipped guest entrypoint exits 2 on a missing or invalid envelope', async () => {
    const entrypoint = join(import.meta.dir, '../../../../bin/ab-harvest-runner.ts')
    const baseEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) baseEnv[key] = value
    }
    delete baseEnv.AB_HARVEST_RUNNER_OPTIONS
    const missing = Bun.spawnSync([process.execPath, entrypoint], {
      env: baseEnv,
      stdout: 'ignore',
      stderr: 'ignore',
    })
    expect(missing.exitCode).toBe(2)
    const invalid = Bun.spawnSync([process.execPath, entrypoint], {
      env: { ...baseEnv, AB_HARVEST_RUNNER_OPTIONS: '{"supervision":{"kind":"local-parent"}}' },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    expect(invalid.exitCode).toBe(2)
  })
})
