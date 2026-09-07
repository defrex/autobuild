import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadConfig } from './load'

test('repository installs mandatory lint and the path-scoped dashboard verifiers', async () => {
  const config = await loadConfig(join(import.meta.dir, '..', '..', '..', '..', 'autobuild.toml'))
  expect(config.baseBranch).toBe('main')
  expect(config.capacity).toBe(5)
  expect(config.policy.harvestThreshold).toBe(5)
  // Upgrade compatibility: the repository config intentionally omits this new field.
  expect(config.policy.harvestMaxDrift).toBe(3)
  // This repository runs its harvest unattended: proposals are filed straight
  // into the ready state, while handbacks still land in Backlog.
  expect(config.tickets.proposalState).toBe('Todo')
  expect(config.tickets.proposalState).toBe(config.tickets.readyState)
  expect(config.tickets.triageState).toBe('Backlog')
  expect(config.pr).toBeUndefined()
  expect(config.commands.lint).toBe('bun run check')
  expect(config.verify.steps).toEqual(['lint', 'types', 'unit', 'dashboard', 'web-dashboard'])
  expect(config.verify.stepConfigs.lint).toEqual({
    kind: 'check',
    command: 'lint',
    always: true,
  })
  expect(config.verify.stepConfigs.dashboard).toEqual({
    kind: 'agent',
    skill: 'ab-verify-dashboard',
    paths: [
      'packages/core/src/cli/dashboard/**',
      'packages/core/src/cli/dispatch.ts',
      'tools/dashboard-capture.ts',
      '.agents/skills/ab-verify-dashboard/SKILL.md',
    ],
  })
  expect(config.verify.stepConfigs['web-dashboard']).toEqual({
    kind: 'agent',
    skill: 'verify-web-dashboard',
    paths: [
      'app/**',
      'tools/web-dashboard-capture.tsx',
      '.agents/skills/verify-web-dashboard/SKILL.md',
      'DESIGN.md',
    ],
  })
})
