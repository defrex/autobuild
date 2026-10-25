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
  // Harvest proposals keep the human grooming gate: they land in triage
  // alongside handbacks rather than dispatching unread.
  expect(config.tickets.proposalState).toBe('triage')
  expect(config.tickets.proposalState).not.toBe(config.tickets.readyState)
  expect(config.tickets.triageState).toBe('triage')
  expect(config.pr).toBeUndefined()
  expect(config.commands.lint).toBe('bun run check')
  expect(config.verify.steps).toEqual([
    'lint',
    'types',
    'unit',
    'build',
    'integration',
    'ui-tui',
    'ui-app',
    'ui-website',
    'docs',
    'proa-rust',
    'ui-proa',
  ])
  expect(config.verify.stepConfigs.lint).toEqual({
    kind: 'check',
    command: 'lint',
    always: true,
  })
  expect(config.verify.stepConfigs.build).toEqual({
    kind: 'check',
    command: 'build',
    always: true,
  })
  expect(config.verify.stepConfigs.integration).toMatchObject({
    kind: 'check',
    command: 'test-integration',
    paths: expect.arrayContaining(['packages/core/src/**', 'packages/postgres-store/**']),
  })
  expect(config.verify.stepConfigs.integration?.always).toBeUndefined()
  expect(config.verify.stepConfigs['ui-tui']).toEqual({
    kind: 'agent',
    skill: 'verify-ui-tui',
    paths: [
      'packages/core/src/cli/dashboard/**',
      'packages/core/src/cli/dispatch.ts',
      'tools/dashboard-capture.ts',
      'tools/capture-parity.ts',
      '.agents/skills/verify-ui-tui/SKILL.md',
    ],
  })
  expect(config.verify.stepConfigs['ui-app']).toEqual({
    kind: 'agent',
    skill: 'verify-ui-app',
    paths: [
      'packages/hosted-store-service/app/**',
      'packages/web-dashboard-capture/src/**',
      'packages/core/src/operator/**',
      'packages/core/src/cli/dashboard/**',
      'tools/capture-parity.ts',
      '.agents/skills/verify-ui-app/SKILL.md',
      'DESIGN.md',
    ],
  })
})
