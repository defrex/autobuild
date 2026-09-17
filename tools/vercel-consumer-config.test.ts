import { expect, test } from 'bun:test'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig } from '../packages/core/src/config/load'
import { effectiveRuntimeReferences } from '../packages/core/src/config/roles'
import { vercelSandboxConfigSchema } from '../packages/core/src/config/schema'

const REPO_ROOT = join(import.meta.dir, '..')
const ROLE_KEYS = ['default', 'implement', 'plan-review', 'code-review']

test('repository dispatches every agent route through provisioned Pi in Vercel Sandbox', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))

  expect(config.workspace.provider).toBe('vercel-sandbox')
  const workspace = vercelSandboxConfigSchema.parse(config.workspace.config)
  expect(workspace).toMatchObject({
    image: 'vercel/sandbox/universal:latest',
    vcpus: 4,
    timeoutSeconds: 14400,
    operationTimeoutMs: 30_000,
    environmentVariables: ['AI_GATEWAY_API_KEY'],
  })
  expect(workspace.gitUsernameEnv).toBeUndefined()
  expect(workspace.gitPasswordEnv).toBeUndefined()
  expect(workspace.provisioning.map(({ name }) => name)).toEqual([
    'system-install',
    'browser-smoke',
    'postgres',
    'git-identity',
  ])
  expect(workspace.provisioning[0]?.command).toContain('google-chrome-stable_current_amd64.deb')
  expect(workspace.provisioning[0]?.command).toContain('fonts-noto-cjk')
  expect(workspace.provisioning[0]?.command).toContain('fonts-noto-color-emoji')
  const browserSmoke = workspace.provisioning[1]?.command
  expect(browserSmoke).toContain('CHROMIUM_BIN=/usr/bin/google-chrome-stable')
  expect(browserSmoke).toContain('BUN_BIN=/opt/autobuild-runtime/node_modules/.bin/bun')
  expect(browserSmoke).toContain('./scripts/browser-smoke.sh')
  expect(browserSmoke).not.toContain('--headless')
  await access(join(REPO_ROOT, 'scripts/browser-smoke.sh'), constants.X_OK)
  await access(join(REPO_ROOT, 'scripts/browser-smoke-server.ts'), constants.R_OK)
  expect(workspace.provisioning[2]?.command).toBe('./scripts/postgres-live.sh install')
  await access(join(REPO_ROOT, 'scripts/postgres-live.sh'), constants.X_OK)
  // The pinned Pi version changes on every catalog refresh; derive it from the
  // install command so a version bump is not a test edit. The install prefix —
  // `npm install --global --ignore-scripts`, whose --ignore-scripts safety flag
  // must not silently disappear — and the preflight formula — exact pinned
  // version plus an explicit catalog refresh — are the contract itself and
  // stay hardcoded.
  const piProvisioning = workspace.runtimeProvisioning?.pi
  const install = piProvisioning?.install ?? ''
  expect(install).toMatch(
    /^npm install --global --ignore-scripts @earendil-works\/pi-coding-agent@/,
  )
  const version = /@earendil-works\/pi-coding-agent@([^'\s]+)\s*$/.exec(install)?.[1]
  if (version === undefined) {
    throw new Error(`pi install command does not pin a package version: ${install}`)
  }
  expect(piProvisioning?.preflight).toBe(
    `test "$(pi --version)" = "${version}" && pi update --models`,
  )

  // Catalog-shaped expectations are derived from `autobuild.toml` (the source
  // the test already loads) so a catalog refresh cannot stale the test. What
  // stays pinned: the runtime must be `pi` for every role, every model id must
  // be a gateway id (the disposable-guest, API-billed constraint), each phase
  // role keeps at least one fallback, and the two config views agree. A
  // nonexistent-but-gateway-shaped id is caught at provision time by the live
  // sandbox preflight (`pi update --models` fails on unknown ids).
  const roleKeys = Object.keys(config.roles)
  expect(roleKeys.sort()).toEqual([...ROLE_KEYS].sort())

  const gatewayModels = new Set<string>()
  for (const role of Object.values(config.roles)) {
    expect(role.runtime).toBe('pi')
    expect(role.alternates?.length ?? 0).toBeGreaterThan(0)
    expect(role.model).toBeDefined()
    for (const model of [role.model, ...(role.alternates ?? []).map(({ model }) => model)]) {
      expect(model?.startsWith('vercel-ai-gateway/'), `non-gateway model id: ${model}`).toBe(true)
      gatewayModels.add(model!)
    }
    for (const alternate of role.alternates ?? []) {
      expect(alternate.runtime === undefined || alternate.runtime === 'pi').toBe(true)
    }
  }

  const effective = effectiveRuntimeReferences(config)
  expect(effective).toHaveLength(1)
  expect(effective[0]?.runtime).toBe('pi')
  expect(effective[0]?.usesRuntimeDefaultModel).toBe(false)
  expect(effective[0]?.models).toEqual([...gatewayModels].sort())
  expect(effective[0]?.references.length).toBeGreaterThan(0)
})

test('remote rollout preserves this repository pipeline and hosted integration', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))

  expect(config.commands).toMatchObject({
    setup: 'bun install',
    lint: 'bun run check',
    typecheck: 'bun run typecheck',
    test: 'bun run test',
  })
  const testPostgres = config.commands['test-postgres']
  expect(testPostgres).toContain('AB_POSTGRES_TEST_URL')
  expect(testPostgres).toContain('packages/postgres-store/src/store.live.test.ts')
  expect(testPostgres).toContain('packages/postgres-store/src/migrate.test.ts')
  expect(config.verify.steps).toEqual([
    'lint',
    'types',
    'unit',
    'postgres',
    'dashboard',
    'web-dashboard',
  ])
  expect(config.verify.stepConfigs.lint).toEqual({ kind: 'check', command: 'lint', always: true })
  expect(config.verify.stepConfigs.postgres).toEqual({
    kind: 'check',
    command: 'test-postgres',
    always: true,
  })
  expect(config.verify.stepConfigs.dashboard).toMatchObject({
    kind: 'agent',
    skill: 'ab-verify-dashboard',
    paths: expect.arrayContaining(['packages/core/src/cli/dashboard/**']),
  })
  expect(config.verify.stepConfigs['web-dashboard']).toMatchObject({
    kind: 'agent',
    skill: 'verify-web-dashboard',
    paths: expect.arrayContaining(['app/**']),
  })
  expect(config.finalize.steps).toEqual(['changelog'])
  expect(config.finalize.stepConfigs.changelog).toEqual({
    kind: 'agent',
    skill: 'ab-finalize-changelog',
  })
  expect(config.tickets).toMatchObject({
    source: 'hosted',
    teamKey: 'AUT',
    readyState: 'Todo',
    claimedState: 'In Progress',
    createState: 'Todo',
    triageState: 'Backlog',
    proposalState: 'Todo',
  })
})
