import { expect, test } from 'bun:test'
import { MemoryBuildStore } from '../store/memory'
import { abForgeClear } from './forge-clear'

test('CLI selects the requested store and emits its durable attributed recovery', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo('/repo')
  const output: string[] = []
  await abForgeClear({
    targetRepo: '/repo',
    env: { USER: 'Ada' },
    exec: async () => ({ stdout: '', stderr: '', exitCode: 128 }),
    storeRef: 'file:/selected',
    openStore: (ref) => {
      expect(ref).toContain('selected')
      return store
    },
    stdout: (line) => output.push(line),
    forge: 'github',
    reason: 'wrong deadline',
    json: true,
  })
  expect(JSON.parse(output[0]!)).toMatchObject({
    event: {
      actor: { kind: 'human', user: 'Ada' },
      type: 'dispatcher.forge-recovered',
      payload: { forge: 'github', reason: 'wrong deadline' },
    },
  })
})

test('CLI refuses phase authority and invalid reasons before opening a store', async () => {
  for (const env of [{ AB_BUILD: 'build' }, { AB_SESSION: 'session' }, { AB_HARVEST: 'harvest' }]) {
    await expect(
      abForgeClear({
        targetRepo: '/repo',
        env,
        exec: async () => {
          throw new Error('must not execute')
        },
        stdout: () => {},
        forge: 'github',
        reason: 'override',
      }),
    ).rejects.toThrow('outside a build or harvest session')
  }
})
