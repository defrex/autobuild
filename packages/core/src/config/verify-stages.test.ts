import { expect, test } from 'bun:test'
import { parseConfig } from './load'
import { verifyStages } from './schema'
const source = (steps: string, extra = '') =>
  `[tickets]\nsource = "file"\nreadyState = "ready"\n[commands]\na="true"\nb="true"\n[verify]\nsteps=${steps}\n[verify.a]\nkind="check"\ncommand="a"\n${extra}\n[verify.b]\nkind="check"\ncommand="b"\n`
test('mixed stages flatten canonically and retain groups through JSON pinning', () => {
  const config = parseConfig(source('[["a"], "b"]'))
  expect(config.verify.steps).toEqual(['a', 'b'])
  expect(verifyStages(JSON.parse(JSON.stringify(config.verify)))).toEqual([['a'], ['b']])
  expect(parseConfig(source('["a","b"]')).verify).not.toHaveProperty('stages')
  expect(parseConfig(source('["a","b"]')).verify.stepConfigs.a).not.toHaveProperty('failFast')
  expect(parseConfig(source('[["a","b"]]', 'failFast=true')).verify.stepConfigs.a?.failFast).toBe(
    true,
  )
})
test('empty stages, repeated members and nonboolean failFast are refused', () => {
  for (const steps of ['[[],"a","b"]', '[["a","a"],"b"]', '[["a","b"],"a"]'])
    expect(() => parseConfig(source(steps))).toThrow()
  expect(() => parseConfig(source('["a","b"]', 'failFast="true"'))).toThrow()
  expect(() => parseConfig(`${source('["a","b"]')}\n[finalize]\nsteps=[["a"]]\n`)).toThrow()
})
