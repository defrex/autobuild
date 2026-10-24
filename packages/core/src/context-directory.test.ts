import { expect, test } from 'bun:test'
import { contextDirectory, isSafeStepName, resolveContextDirectory } from './context-directory'

test('phase and extension directories are stable across rounds', () => {
  expect(contextDirectory('implement@2')).toBe('.ab/implement')
  expect(contextDirectory('verify:ui.app@3')).toBe('.ab/verify-ui.app')
  expect(contextDirectory('finalize@1', '__proto__')).toBe('.ab/finalize-__proto__')
  expect(resolveContextDirectory('plan')).toBe('.ab/plan')
  expect(resolveContextDirectory('finalize', '.ab/finalize-post')).toBe('.ab/finalize-post')
})

test('explicit directory cannot escape or select another phase', () => {
  for (const path of ['', '/tmp/context', '.ab/../x', '.ab/plan/nested', '.ab/implement']) {
    expect(() => resolveContextDirectory('plan', path)).toThrow('AB_CONTEXT_DIR')
  }
})

test('step names preserve safe punctuation and reject path syntax', () => {
  for (const name of ['A1', '.hidden', 'a.b_c-d', '__proto__'])
    expect(isSafeStepName(name)).toBe(true)
  for (const name of ['', '.', '..', 'a/b', 'a\\b', 'a b', 'a:b', '../x', 'é']) {
    expect(isSafeStepName(name)).toBe(false)
  }
})
