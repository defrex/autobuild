import { expect, test } from 'bun:test'
import { compilePathSelectors, pathSelectorError } from './path-selectors'

test('compiled selectors any-match, case-sensitively, with whole-segment **', () => {
  const matches = compilePathSelectors(['docs/**', 'README.md', 'src/*.ts'])
  expect(['docs/a.md', 'docs/x/y.md', 'README.md', 'src/a.ts'].every(matches)).toBe(true)
  expect(['Docs/a.md', 'readme.md', 'src/x/a.ts', 'README.md.bak'].some(matches)).toBe(false)
})

test('compiling fails closed on a selector outside the grammar', () => {
  expect(pathSelectorError('a**')).toBeDefined()
  expect(() => compilePathSelectors(['docs/**', '{a,b}'])).toThrow('invalid path selector "{a,b}"')
  expect(() => compilePathSelectors(['!x'], (selector) => `custom ${selector}`)).toThrow(
    'custom !x',
  )
})
