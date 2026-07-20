import { describe, expect, test } from 'bun:test'
import {
  evaluateVerifyApplicability,
  pathExclusionReason,
  type VerifyApplicabilityRule,
} from './verify-applicability'

function paths(...selectors: string[]): VerifyApplicabilityRule {
  return { kind: 'paths', step: 'dashboard', paths: selectors }
}

describe('evaluateVerifyApplicability', () => {
  test('matches exact paths and remains case-sensitive', () => {
    expect(
      evaluateVerifyApplicability(paths('src/cli/dispatch.ts'), [
        'README.md',
        'src/cli/dispatch.ts',
      ]),
    ).toEqual({ applies: true })
    expect(
      evaluateVerifyApplicability(paths('src/cli/dispatch.ts'), [
        'src/CLI/dispatch.ts',
      ]),
    ).toEqual({
      applies: false,
      reason:
        'excluded by [verify.dashboard].paths: no changed path matched ["src/cli/dispatch.ts"]',
    })
  })

  test('supports *, ?, and whole-segment ** with full-path matching', () => {
    expect(
      evaluateVerifyApplicability(paths('src/*.ts'), ['src/nested/file.ts']),
    ).toEqual(expect.objectContaining({ applies: false }))
    expect(
      evaluateVerifyApplicability(paths('src/file?.ts'), ['src/file1.ts']),
    ).toEqual({ applies: true })
    expect(
      evaluateVerifyApplicability(paths('src/**/dashboard.ts'), [
        'src/dashboard.ts',
      ]),
    ).toEqual({ applies: true })
    expect(
      evaluateVerifyApplicability(paths('src/**/dashboard.ts'), [
        'src/cli/nested/dashboard.ts',
      ]),
    ).toEqual({ applies: true })
  })

  test('uses OR semantics across selectors and changed paths', () => {
    expect(
      evaluateVerifyApplicability(
        paths('migrations/**', 'src/cli/dashboard/**'),
        ['docs/guide.md', 'src/cli/dashboard/model.ts'],
      ),
    ).toEqual({ applies: true })
  })

  test('no changed files and no match produce one stable rule-naming reason', () => {
    const rule = paths('src/cli/dashboard/**', 'src/cli/dispatch.ts')
    const reason = pathExclusionReason('dashboard', rule.kind === 'paths' ? rule.paths : [])
    expect(evaluateVerifyApplicability(rule, [])).toEqual({
      applies: false,
      reason,
    })
    expect(evaluateVerifyApplicability(rule, ['README.md', 'docs/a.md'])).toEqual({
      applies: false,
      reason,
    })
    expect(evaluateVerifyApplicability(rule, ['docs/a.md', 'README.md'])).toEqual({
      applies: false,
      reason,
    })
  })

  test('always applies regardless of paths or changed-path ordering', () => {
    expect(evaluateVerifyApplicability({ kind: 'always' }, [])).toEqual({
      applies: true,
    })
    expect(
      evaluateVerifyApplicability(
        { kind: 'always' },
        ['z-last', 'a-first'],
      ),
    ).toEqual({ applies: true })
  })

  test('direct callers fail closed before Bun.Glob sees unsupported syntax', () => {
    expect(() =>
      evaluateVerifyApplicability(paths('../secrets/**'), ['README.md']),
    ).toThrow('invalid [verify.dashboard].paths selector')
  })
})
