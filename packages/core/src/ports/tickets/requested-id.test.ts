import { expect, test } from 'bun:test'
import { hostedRequestedIds } from './requested-id'
import { normalizeStateName } from './states'

test('requested number policy is literal, bigint-safe and allocates above every preserved number', () => {
  const policy = hostedRequestedIds('A.+')
  expect(policy.preserve('A.+-706')).toBe('A.+-706')
  for (const id of ['AUT-706', 'A.+-01', 'A.+-0', 'A.+--1'])
    expect(policy.preserve(id)).toBeUndefined()
  expect(policy.allocate(['A.+-706', 'A.+-9007199254740993'])).toBe('A.+-9007199254740994')
  expect(() => policy.preserve('A.+-9223372036854775808')).toThrow('bigint')
  expect(normalizeStateName(' In  Progress ')).toBe('in-progress')
  for (const state of ['123', '☃', 'a'.repeat(41)])
    expect(() => normalizeStateName(state)).toThrow('invalid state')
})
