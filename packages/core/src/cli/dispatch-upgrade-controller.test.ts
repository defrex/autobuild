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
