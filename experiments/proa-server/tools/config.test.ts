import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { evaluateVerifyApplicability } from '../../../packages/core/src/kernel/verify-applicability'
import { root } from './verify'

type Pipeline = {
  commands: Record<string, string>
  verify: Record<string, { paths: string[]; kind: string; command?: string; skill?: string }> & {
    steps: (string | string[])[]
  }
}
const config = Bun.TOML.parse(await Bun.file(join(root, 'autobuild.toml')).text()) as Pipeline

test('new steps gate only experiment and skill; product gates retain exclusions', () => {
  for (const step of ['proa-rust', 'ui-proa']) {
    const paths = config.verify[step]!.paths
    const applies = (path: string) =>
      evaluateVerifyApplicability({ kind: 'paths', step, paths }, [path]).applies
    for (const path of [
      'experiments/proa-server/src/pages/home.rs',
      'experiments/proa-server/tools/capture.ts',
      '.agents/skills/verify-ui-proa/SKILL.md',
      '.claude/skills/verify-ui-proa',
    ])
      expect(applies(path)).toBe(true)
    for (const path of [
      'packages/core/src/kernel/engine.ts',
      'docs/configuration.md',
      'autobuild.toml',
    ])
      expect(applies(path)).toBe(false)
  }
  for (const step of ['docs', 'ui-app', 'integration'])
    expect(
      evaluateVerifyApplicability({ kind: 'paths', step, paths: config.verify[step]!.paths }, [
        'experiments/proa-server/src/main.rs',
      ]).applies,
    ).toBe(false)
})
test('original nine steps, commands and definitions remain unchanged', () => {
  const baseline = structuredClone(config)
  delete baseline.commands['proa-rust']
  delete baseline.verify['proa-rust']
  delete baseline.verify['ui-proa']
  const stages = baseline.verify.steps
  expect(stages.splice(4)).toEqual(['proa-rust', 'ui-proa'])
  expect(stages).toEqual([
    ['lint', 'types'],
    ['unit', 'build', 'integration'],
    'ui-tui',
    ['ui-app', 'ui-website', 'docs'],
  ])
  baseline.verify.steps = stages.flat()
  expect(
    createHash('sha256')
      .update(JSON.stringify({ commands: baseline.commands, verify: baseline.verify }))
      .digest('hex'),
  ).toBe('cf72a0d564b4ec03c501159d4bf8c524dd062d2ac84e83b56cb046f501f7d374')
})
