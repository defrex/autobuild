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
  expect(config.commands.lint).toBe('./scripts/verify-bun.sh bun run check')
  expect(config.verify.steps).toEqual([
    'lint',
    'types',
    'unit',
    'build',
    'integration',
    'app-load',
    'ui-tui',
    'ui-app',
    'ui-website',
    'ui-web',
    'docs',
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
  // Integration holds every IO test and applies to every build, as unit does.
  expect(config.verify.stepConfigs.integration).toEqual({
    kind: 'check',
    command: 'test-integration',
  })
  // Browser load failures: every file the web app's client bundle reads gates it.
  expect(config.verify.stepConfigs['app-load']).toMatchObject({
    kind: 'check',
    command: 'app-load',
    paths: expect.arrayContaining(['packages/hosted-store-service/app/**', 'packages/core/src/**']),
  })
  expect(config.verify.stepConfigs['ui-tui']).toEqual({
    kind: 'agent',
    skill: 'verify-ui-tui',
    paths: [
      'packages/core/src/cli/dashboard/**',
      'packages/core/src/cli/dispatch.ts',
      'tools/dashboard-capture.ts',
      'tools/capture-parity.ts',
      '.agents/skills/verify-ui-tui/SKILL.md',
      'tools/account-credentials-capture.ts',
      'tools/verify-stages-capture.ts',
      'tools/rollback-capture.ts',
      'tools/handoff-capture.ts',
      'tools/parked-slot-wait-capture.ts',
      'tools/optimization-node-capture.ts',
      'tools/ticket-wait-capture.ts',
      'tools/harvest-suspension-capture.ts',
      'tools/native-session-capture.ts',
      'tools/judge-session-capture.ts',
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
  expect(config.verify.stepConfigs['ui-web']).toEqual({
    kind: 'agent',
    skill: 'verify-ui-web',
    paths: ['packages/ui/**', 'packages/core/src/web/**'],
  })
})
