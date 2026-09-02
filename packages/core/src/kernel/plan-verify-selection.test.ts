import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import { resolvePlanVerifySteps } from './plan-verify-selection'

const config = parseConfig(`
[tickets]
source = "file"
readyState = "ready"
[commands]
types = "bun typecheck"
unit = "bun test"
docs = "bun test docs"
[verify]
steps = ["types", "unit", "docs"]
[verify.types]
kind = "check"
command = "types"
always = true
[verify.unit]
kind = "check"
command = "unit"
[verify.docs]
kind = "check"
command = "docs"
paths = ["docs/**"]
`)

describe('resolvePlanVerifySteps', () => {
  test('a plan without front matter selects every configured step', () => {
    expect(resolvePlanVerifySteps('# Plan\n\nDo the work.\n', config)).toEqual([
      'types',
      'unit',
      'docs',
    ])
  })

  test('an explicit selection is canonicalized to config order', () => {
    expect(
      resolvePlanVerifySteps('+++\nverifySteps = ["docs", "types"]\n+++\n# Plan\n', config),
    ).toEqual(['types', 'docs'])
  })

  test('an empty selection is valid when every configured step is optional', () => {
    const optional = parseConfig(`
[tickets]
source = "file"
readyState = "ready"
[commands]
unit = "bun test"
[verify]
steps = ["unit"]
[verify.unit]
kind = "check"
command = "unit"
`)
    expect(resolvePlanVerifySteps('+++\nverifySteps = []\n+++\n# Plan\n', optional)).toEqual([])
  })

  test('unknown, duplicate, blank, and padded names are rejected with the offending entry', () => {
    expect(() =>
      resolvePlanVerifySteps('+++\nverifySteps = ["types", "ghost"]\n+++\n', config),
    ).toThrow(/unknown step "ghost".*\[verify\.ghost\]/s)
    expect(() =>
      resolvePlanVerifySteps('+++\nverifySteps = ["types", "unit", "unit"]\n+++\n', config),
    ).toThrow(/duplicate step "unit"/)
    expect(() => resolvePlanVerifySteps('+++\nverifySteps = ["types", ""]\n+++\n', config)).toThrow(
      /verifySteps\.1.*nonempty/s,
    )
    expect(() =>
      resolvePlanVerifySteps('+++\nverifySteps = ["types", " unit "]\n+++\n', config),
    ).toThrow(/verifySteps\.1.*blank or padded/s)
  })

  test('an explicit list must include every always = true mandatory step', () => {
    expect(() =>
      resolvePlanVerifySteps('+++\nverifySteps = ["unit"]\n+++\n# Plan\n', config),
    ).toThrow(/omits mandatory step "types".*\[verify\.types\]\.always = true/s)
  })

  test('the metadata shape is narrow and strict', () => {
    for (const plan of [
      '+++\nother = true\nverifySteps = ["types"]\n+++\n',
      '+++\nverifySteps = "types"\n+++\n',
      '+++\n+++\n',
    ]) {
      expect(() => resolvePlanVerifySteps(plan, config)).toThrow(/front matter is invalid/)
    }
  })

  test('malformed fences and TOML are errors once an opening block is attempted', () => {
    expect(() => resolvePlanVerifySteps('+++ trailing\nverifySteps = []\n+++\n', config)).toThrow(
      /malformed opening fence/,
    )
    expect(() => resolvePlanVerifySteps('+++\nverifySteps = []\n', config)).toThrow(
      /missing its closing/,
    )
    expect(() => resolvePlanVerifySteps('+++\nverifySteps = [\n+++\n', config)).toThrow(
      /not valid TOML/,
    )
  })

  test('CRLF fences are accepted without changing the Markdown body', () => {
    expect(
      resolvePlanVerifySteps('+++\r\nverifySteps = ["types", "unit"]\r\n+++\r\n# Plan\r\n', config),
    ).toEqual(['types', 'unit'])
  })
})
