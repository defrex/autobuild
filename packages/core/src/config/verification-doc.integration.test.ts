import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseConfig } from './load'
import { resolvePlanVerifySteps } from '../kernel/plan-verify-selection'

const doc = readFileSync(resolve(import.meta.dir, '../../../../docs/verification.md'), 'utf8')
const blocks = [
  ...doc.matchAll(
    /<!-- (config-fragment|plan-front-matter):([a-z0-9-]+) -->\n```toml\n([\s\S]*?)\n```/g,
  ),
]
const scaffold = '\n[tickets]\nsource = "file"\nreadyState = "ready"\n'

test('verification guide config fragments parse with the required ticket scaffold', () => {
  expect(blocks).toHaveLength([...doc.matchAll(/```toml\n/g)].length)
  const fragments = blocks.filter((block) => block[1] === 'config-fragment')
  expect(fragments).toHaveLength(2)
  for (const block of fragments) {
    expect(() => parseConfig(block[3]! + scaffold, `verification.md#${block[2]}`)).not.toThrow()
  }
})

test('verification guide plan selects its companion universe in configured order', () => {
  const plans = blocks.filter((block) => block[1] === 'plan-front-matter')
  expect(plans).toHaveLength(1)
  for (const plan of plans) {
    const companion = blocks.find(
      (block) => block[1] === 'config-fragment' && block[2] === plan[2],
    )!
    const config = parseConfig(companion[3]! + scaffold)
    const selected = resolvePlanVerifySteps(plan[3]!, config)
    expect(selected).toEqual(['types', 'acceptance'])
    for (const step of config.verify.steps) {
      if (config.verify.stepConfigs[step]?.always) expect(selected).toContain(step)
    }
  }
})
