import { describe, expect, test } from 'bun:test'
import {
  declaredNames,
  isBareSpecifier,
  isBuiltinSpecifier,
  packageNameOfSpecifier,
} from './publish-dependencies-check'

describe('pure helpers', () => {
  test('package names of scoped and unscoped specifiers', () => {
    expect(packageNameOfSpecifier('zod')).toBe('zod')
    expect(packageNameOfSpecifier('next/server')).toBe('next')
    expect(packageNameOfSpecifier('@a/b')).toBe('@a/b')
    expect(packageNameOfSpecifier('@a/b/c')).toBe('@a/b')
  })

  test('relative, subpath-import, absolute and scheme specifiers are not bare', () => {
    for (const specifier of ['./x', '../x', '.', '..', '/abs/x', '#internal', 'data:text/js,1']) {
      expect(isBareSpecifier(specifier)).toBe(false)
    }
    expect(isBareSpecifier('zod')).toBe(true)
    expect(isBareSpecifier('@a/b/c')).toBe(true)
  })

  test('Node and Bun builtins', () => {
    for (const specifier of ['node:fs', 'fs/promises', 'path', 'bun', 'bun:test']) {
      expect(isBuiltinSpecifier(specifier)).toBe(true)
    }
    expect(isBuiltinSpecifier('zod')).toBe(false)
  })

  test('declared names span dependencies, peers and optional dependencies only', () => {
    expect(
      [
        ...declaredNames({
          dependencies: { a: '1' },
          peerDependencies: { b: '1' },
          optionalDependencies: { c: '1' },
          devDependencies: { d: '1' },
        }),
      ].sort(),
    ).toEqual(['a', 'b', 'c'])
  })
})
