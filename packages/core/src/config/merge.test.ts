import { expect, test } from 'bun:test'
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
