import { expect, spyOn, test } from 'bun:test'
import { parseConfig } from './load'
const base = '[tickets]\nsource = "file"\nreadyState = "ready"\n'
test('merge and deprecated landing normalize identically, warning only after successful legacy validation', () => {
  const warnings: string[] = []
  for (const rules of [' = []', '\nmode = "consent"\nfrom = "node"\ninto = "root"']) {
    const section = rules.startsWith(' =')
      ? (key: string) => `${key}${rules}\n${base}`
      : (key: string) => `${base}\n[[${key}]]${rules}`
    const modern = parseConfig(section('merge'), 'modern.toml', (m) => warnings.push(m))
    expect(warnings).toEqual([])
    const legacy = parseConfig(section('landing'), 'legacy.toml', (m) => warnings.push(m))
    expect(legacy).toEqual(modern)
    expect(warnings.splice(0)).toEqual([
      'legacy.toml: [[landing]] is deprecated; use [[merge]] instead',
    ])
  }
  expect(() =>
    parseConfig(`${base}\n[[landing]]\nmode = "invalid"`, 'bad', (m) => warnings.push(m)),
  ).toThrow()
  expect(warnings).toEqual([])
})
test('dual declarations are refused even when empty; canonical failures name merge paths', () => {
  expect(() => parseConfig(`merge = []\nlanding = []\n${base}`)).toThrow('cannot both be declared')
  expect(() => parseConfig(`${base}\n[[merge]]\nmode = "invalid"`)).toThrow('merge[0].mode')
  expect(() => parseConfig(`${base}\n[[merge]]\nmode = "auto"\nunknown = true`)).toThrow('merge[0]')
})
test('explicit one-shot parses default to console.error for deprecated landing', () => {
  const error = spyOn(console, 'error').mockImplementation(() => {})
  try {
    parseConfig(`landing = []\n${base}`, 'explicit.toml')
    expect(error.mock.calls).toEqual([
      ['explicit.toml: [[landing]] is deprecated; use [[merge]] instead'],
    ])
  } finally {
    error.mockRestore()
  }
})
test('merge rules accept changed-path predicates with the verify selector grammar', () => {
  const config = parseConfig(
    `${base}\n[[merge]]\npaths = ["autobuild.toml", "docs/policy/**"]\nmode = "consent"\n` +
      `\n[[merge]]\nwithin = ["docs/**", "README.md"]\nmode = "auto"\n`,
  )
  expect(config.landing).toEqual([
    { paths: ['autobuild.toml', 'docs/policy/**'], mode: 'consent' },
    { within: ['docs/**', 'README.md'], mode: 'auto' },
  ])
  expect(() => parseConfig(`${base}\n[[merge]]\nwithin = []\nmode = "auto"`)).toThrow(
    'merge[0].within',
  )
  expect(() => parseConfig(`${base}\n[[merge]]\npaths = []\nmode = "auto"`)).toThrow(
    'merge[0].paths',
  )
  for (const selector of ['{a,b}', '!x', 'a**', '/abs', 'a/../b', '[ab]']) {
    for (const key of ['merge', 'landing']) {
      const rules = `\n[[${key}]]\nmode = "auto"\n\n[[${key}]]\npaths = [${JSON.stringify(selector)}]\nmode = "consent"`
      expect(() => parseConfig(`${base}${rules}`, 'bad.toml', () => {})).toThrow(
        `${key}[1].paths[0]`,
      )
    }
  }
  expect(() =>
    parseConfig(`${base}\n[[merge]]\nwithin = ["docs/**", "a**"]\nmode = "auto"`),
  ).toThrow('merge[0].within[1]')
})
test('the documented protected-paths configuration parses as written', () => {
  const config = parseConfig(`baseBranch = "main"

[[merge]]
paths = ["autobuild.toml", ".agents/**", "SPEC.md", "docs/policy/**"]
mode = "consent"

[[merge]]
within = ["docs/**", "README.md"]
mode = "auto"

[[merge]]
mode = "consent"

[tickets]
source = "file"
readyState = "ready"
`)
  expect(config.landing.map((rule) => rule.mode)).toEqual(['consent', 'auto', 'consent'])
})
