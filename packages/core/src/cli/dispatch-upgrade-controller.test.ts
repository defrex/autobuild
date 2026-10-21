import { expect, test } from 'bun:test'
import { DispatchUpgradeController } from './dispatch-upgrade-controller'
import type { RepositoryEventWrite } from '../events/repository'
import type { UpgradeTarget } from './dispatch-upgrade-target'
const from = {
  version: '1.0.0',
  commit: 'unknown',
  source: { kind: 'package' as const, location: '/runtime' },
}
function fixture() {
  const events: RepositoryEventWrite[] = []
  let enabled = true,
    calls = 0
  let target: UpgradeTarget = { mode: 'pinned', key: 'two', version: '2.0.0', source: 'main' }
  const controller = new DispatchUpgradeController({
    run: 'r',
    lineage: 'l',
    from,
    failedKeys: [],
    enabled: () => enabled,
    resolve: async () => target,
    prepare: async () => {
      calls++
      throw new Error('registry unavailable')
    },
    append: async (event) => {
      events.push(event)
    },
    cutover: async () => {
      throw new Error('must not cut over')
    },
    redact: (message) => message,
  })
  return {
    controller,
    events,
    calls: () => calls,
    target: (value: UpgradeTarget) => {
      target = value
    },
    disable: () => {
      enabled = false
      controller.changed()
    },
  }
}
test('failure suppression tracks exact target input and opt-out disables work', async () => {
  const h = fixture()
  await h.controller.check()
  await h.controller.check()
  expect(h.calls()).toBe(1)
  expect(h.events.map((e) => e.type)).toEqual([
    'dispatcher.upgrade-detected',
    'dispatcher.upgrade-failed',
  ])
  h.target({ mode: 'pinned', key: 'older', version: '0.9.0', source: 'main' })
  await h.controller.check()
  expect(h.calls()).toBe(2)
  h.disable()
  h.target({ mode: 'pinned', key: 'three', version: '3.0.0', source: 'main' })
  await h.controller.check()
  expect(h.calls()).toBe(2)
})
test('equal version performs no install and initial check does not wait for cadence', async () => {
  const h = fixture()
  h.target({ mode: 'installed', key: 'one', version: '1.0.0', source: '/original' })
  await h.controller.check()
  expect(h.calls()).toBe(0)
  h.target({ mode: 'installed', key: 'two', version: '2.0.0', source: '/original' })
  h.controller.start()
  await Bun.sleep(20)
  await h.controller.stop()
  expect(h.calls()).toBe(1)
})
test('stop cancels an in-flight preparation before any handoff', async () => {
  let entered!: () => void
  const ready = new Promise<void>((r) => {
    entered = r
  })
  let aborted = false
  const controller = new DispatchUpgradeController({
    run: 'r',
    lineage: 'l',
    from,
    failedKeys: [],
    enabled: () => true,
    resolve: async () => ({ mode: 'installed', key: 'two', version: '2.0.0', source: '/original' }),
    prepare: async (_target, signal) => {
      entered()
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => {
          aborted = true
          resolve()
        }),
      )
      signal.throwIfAborted()
      throw new Error('unreachable')
    },
    append: async () => {},
    cutover: async () => {
      throw new Error('must not cut over')
    },
  })
  controller.start()
  await ready
  await controller.stop()
  expect(aborted).toBe(true)
})

test('cadence has one in-flight check and opt-out cancels preparation', async () => {
  let enabled = true,
    calls = 0,
    entered!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const controller = new DispatchUpgradeController({
    run: 'r',
    lineage: 'l',
    from,
    failedKeys: [],
    enabled: () => enabled,
    intervalMs: 5,
    resolve: async () => ({ mode: 'pinned', key: 'two', version: '2.0.0', source: 'main' }),
    prepare: async (_target, signal) => {
      calls++
      entered()
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      signal.throwIfAborted()
      throw new Error('unreachable')
    },
    append: async () => {},
    cutover: async () => {
      throw new Error('must not cut over')
    },
  })
  controller.start()
  await ready
  await controller.check()
  await Bun.sleep(20)
  expect(calls).toBe(1)
  enabled = false
  controller.changed()
  await controller.stop()
})

for (const { name, commit, bunTag, locked, unchanged } of [
  {
    name: 'full running SHA matches abbreviated lock',
    commit: `a1b2c3d${'0'.repeat(33)}`,
    bunTag: undefined,
    locked: 'a1b2c3d',
    unchanged: true,
  },
  {
    name: 'unknown SHA retains the matching abbreviated Bun tag',
    commit: 'unknown',
    bunTag: 'fork-owner-repo-name-a1b2c3d',
    locked: 'a1b2c3d',
    unchanged: true,
  },
  {
    name: 'abbreviated Bun tag matches a longer locked commit',
    commit: 'unknown',
    bunTag: 'fork-owner-repo-name-a1b2c3d',
    locked: `a1b2c3d${'0'.repeat(33)}`,
    unchanged: true,
  },
  {
    name: 'changed commit is still detected',
    commit: 'unknown',
    bunTag: 'fork-owner-repo-name-b1b2c3d',
    locked: 'a1b2c3d',
    unchanged: false,
  },
  {
    name: 'different forge repository is still detected',
    commit: 'unknown',
    bunTag: 'other-owner-repo-name-a1b2c3d',
    locked: 'a1b2c3d',
    unchanged: false,
  },
  {
    name: 'Bun provenance takes precedence over a stale npm gitHead',
    commit: `a1b2c3d${'0'.repeat(33)}`,
    bunTag: 'fork-owner-repo-name-b1b2c3d',
    locked: 'a1b2c3d',
    unchanged: false,
  },
]) {
  test(`fresh forge launch: ${name}`, async () => {
    const events: RepositoryEventWrite[] = []
    let installs = 0,
      cutovers = 0
    const controller = new DispatchUpgradeController({
      run: 'fresh-run',
      lineage: 'fresh-launcher',
      from: { ...from, commit },
      runningBunTag: bunTag,
      failedKeys: [],
      currentKey: undefined,
      enabled: () => true,
      resolve: async () => ({
        mode: 'pinned',
        key: 'forge',
        source: 'main',
        record: [
          `@defrex/autobuild@github:fork-owner/repo-name#${locked}`,
          {},
          `fork-owner-repo-name-${locked}`,
        ],
      }),
      prepare: async () => {
        installs++
        throw new Error('preparation observed')
      },
      append: async (event) => {
        events.push(event)
      },
      cutover: async () => {
        cutovers++
        return true
      },
    })
    await controller.check()
    await controller.check()
    expect(installs).toBe(unchanged ? 0 : 1)
    expect(cutovers).toBe(0)
    expect(events.map((event) => event.type)).toEqual(
      unchanged ? [] : ['dispatcher.upgrade-detected', 'dispatcher.upgrade-failed'],
    )
    await controller.stop()
  })
}
