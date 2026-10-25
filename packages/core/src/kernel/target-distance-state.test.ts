import { expect, test } from 'bun:test'
import { validateEventWrite, type AbEvent } from '../events/catalog'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { advanceLeafRestack, leafRestackReducer } from './leaf-restack-state'
import { leafRestackLog } from './generators/leaf-restack-log'

const payload = { branch: 'main', sha: 'a'.repeat(40), head: 'b'.repeat(40), count: 7 }
const event = (type: string, value: unknown): AbEvent =>
  ({
    ...validateEventWrite({
      type,
      actor: type === 'target.distance' ? DISPATCHER : KERNEL,
      payload: value,
    }),
    seq: 1,
    ts: '2026-10-25T00:00:00Z',
    build: 'leaf',
  }) as AbEvent

test('distance schema accepts only pinned known samples or explicit unknown', () => {
  for (const count of [0, 7, null])
    expect(() => event('target.distance', { ...payload, count })).not.toThrow()
  for (const count of [-1, 1.5])
    expect(() => event('target.distance', { ...payload, count })).toThrow()
  expect(() => event('target.distance', { ...payload, sha: 'invalid' })).toThrow()
  expect(() => event('target.distance', { ...payload, head: null })).toThrow()
  expect(() => event('target.distance', { ...payload, head: null, count: null })).not.toThrow()
})
test('legacy replay, destination and rewrite invalidation agree incrementally', () => {
  const acc = leafRestackReducer.initial()
  const sample = event('target.distance', payload)
  advanceLeafRestack(acc, [sample])
  expect(acc.distance).toEqual(payload)
  advanceLeafRestack(acc, [event('target.moved', { branch: 'main', sha: 'c'.repeat(40) })])
  expect(acc.distance).toBeUndefined()
  const log = leafRestackLog()
  const whole = leafRestackReducer.initial()
  advanceLeafRestack(whole, log)
  const incremental = leafRestackReducer.initial()
  for (const fact of log) advanceLeafRestack(incremental, [fact])
  expect(incremental).toEqual(whole)
  expect(whole.distance).toBeUndefined()
  expect(leafRestackReducer.initial().distance).toBeUndefined()
})
