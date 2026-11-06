import { expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { loadConfig } from '../packages/core/src/config/load'
import {
  evaluateVerifyApplicability,
  type VerifyApplicabilityRule,
} from '../packages/core/src/kernel/verify-applicability'
import { checkoutRoot, suiteCommands } from './test-temp-leaks'

test('the integration verify step applies to every directory holding integration tests', async () => {
  const config = await loadConfig(join(checkoutRoot, 'autobuild.toml'))
  const step = config.verify.stepConfigs.integration
  expect(step).toBeDefined()
  const rule: VerifyApplicabilityRule =
    step?.always || !step?.paths
      ? { kind: 'always' }
      : { kind: 'paths', step: 'integration', paths: step.paths }
  const applies = (path: string) => evaluateVerifyApplicability(rule, [path]).applies

  const [command = []] = await suiteCommands('integration', [], { env: {}, report: () => {} })
  const files = command.slice(2)
  expect(files.length).toBeGreaterThan(0)
  for (const file of files) {
    expect({ file, applies: applies(file) }).toEqual({ file, applies: true })
    // A build touching only this directory's source still runs its tests.
    const sibling = `${dirname(file)}/x.ts`
    expect({ sibling, applies: applies(sibling) }).toEqual({ sibling, applies: true })
  }
  for (const path of [
    'tools/x.ts',
    'scripts/x.sh',
    'bin/x.ts',
    'packages/web-dashboard-capture/src/x.tsx',
    // Moved tests also check skills, docs and configuration.
    'skills/guide/SKILL.md',
    '.agents/skills/ab-guide/SKILL.md',
    'docs/configuration.md',
    'autobuild.toml',
  ])
    expect({ path, applies: applies(path) }).toEqual({ path, applies: true })
})
