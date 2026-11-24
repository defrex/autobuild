/** `compileEventGlobs`: the anchored event-glob matcher behind `--event`. */
import { describe, expect, test } from 'bun:test'
import { compileEventGlobs } from './globs'
import { EVENT_TYPES } from './payloads'

describe('event glob compilation', () => {
  const usage = 'usage: ab watch [--event <glob>]...'

  test('anchored glob semantics: * any run, ? exactly one, dots verbatim', () => {
    const escalation = compileEventGlobs(['escalation.*'], { repository: false, usage })[0]!
    expect(escalation.test('escalation.raised')).toBe(true)
    expect(escalation.test('escalation.answered')).toBe(true)
    expect(escalation.test('build.completed')).toBe(false)

    const question = compileEventGlobs(['pr.merge?'], { repository: false, usage })[0]!
    expect(question.test('pr.merged')).toBe(true)
    expect(question.test('pr.closed')).toBe(false)
    expect(question.test('pr.mergedX')).toBe(false)

    const star = compileEventGlobs(['*'], { repository: false, usage })[0]!
    expect(EVENT_TYPES.every((type) => star.test(type))).toBe(true)

    // A dot in the pattern must not become a wildcard.
    const literal = compileEventGlobs(['pr.merged'], { repository: false, usage })[0]!
    expect(literal.test('prXmerged')).toBe(false)
  })

  test('each glob must match the applicable catalog, and the error names the glob', () => {
    expect(() => compileEventGlobs(['bogus.*'], { repository: false, usage })).toThrow(
      '--event "bogus.*"',
    )
    expect(() => compileEventGlobs(['bogus.*'], { repository: false, usage })).toThrow(usage)

    // Repository-only globs need --repository; with it they validate.
    expect(() => compileEventGlobs(['harvest.*'], { repository: false, usage })).toThrow(
      '--event "harvest.*"',
    )
    expect(() => compileEventGlobs(['harvest.*'], { repository: true, usage })).not.toThrow()
    expect(() => compileEventGlobs(['pr.*'], { repository: true, usage })).not.toThrow()
  })
})
