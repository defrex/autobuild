import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadConfig } from './load'

test('repository installs the path-scoped dashboard image verifier after deterministic checks', async () => {
  const config = await loadConfig(
    join(import.meta.dir, '..', '..', 'autobuild.toml'),
  )
  expect(config.verify.steps).toEqual(['types', 'unit', 'dashboard'])
  expect(config.verify.stepConfigs['dashboard']).toEqual({
    kind: 'agent',
    skill: 'ab-verify-dashboard',
    needsServer: false,
    paths: ['src/cli/dashboard/**', 'src/cli/dispatch.ts'],
  })
})
