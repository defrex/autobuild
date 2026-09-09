import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadConfig } from '../packages/core/src/config/load'
import { effectiveRuntimeReferences } from '../packages/core/src/config/roles'
import { vercelSandboxConfigSchema } from '../packages/core/src/config/schema'

const REPO_ROOT = join(import.meta.dir, '..')
const OPENAI = 'vercel-ai-gateway/openai/gpt-5.6-sol'
const KIMI = 'vercel-ai-gateway/moonshotai/kimi-k3'
const CLAUDE = 'vercel-ai-gateway/anthropic/claude-opus-5'
const APPROVED_MODELS = [OPENAI, KIMI, CLAUDE]

test('repository dispatches every agent route through provisioned Pi in Vercel Sandbox', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))

  expect(config.workspace.provider).toBe('vercel-sandbox')
  const workspace = vercelSandboxConfigSchema.parse(config.workspace.config)
  expect(workspace).toMatchObject({
    image: 'vercel/sandbox/universal:latest',
    vcpus: 4,
    timeoutSeconds: 2700,
    operationTimeoutMs: 30_000,
    environmentVariables: ['AI_GATEWAY_API_KEY'],
  })
  expect(workspace.gitUsernameEnv).toBeUndefined()
  expect(workspace.gitPasswordEnv).toBeUndefined()
  expect(workspace.provisioning.map(({ name }) => name)).toEqual([
    'system-install',
    'browser-smoke',
  ])
  expect(workspace.provisioning[0]?.command).toContain('google-chrome-stable_current_amd64.deb')
  expect(workspace.provisioning[0]?.command).toContain('fonts-noto-cjk')
  expect(workspace.provisioning[0]?.command).toContain('fonts-noto-color-emoji')
  expect(workspace.provisioning[1]?.command).toContain('CHROMIUM_BIN=/usr/bin/google-chrome-stable')
  expect(workspace.provisioning[1]?.command).toContain('--headless')
  expect(workspace.runtimeProvisioning).toEqual({
    pi: {
      install: 'npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.84.4',
      preflight: 'test "$(pi --version)" = "0.84.4"',
    },
  })

  const effective = effectiveRuntimeReferences(config)
  expect(effective).toHaveLength(1)
  expect(effective[0]?.runtime).toBe('pi')
  expect(effective[0]?.usesRuntimeDefaultModel).toBe(false)
  expect(effective[0]?.models).toEqual([...APPROVED_MODELS].sort())
  expect(effective[0]?.references.length).toBeGreaterThan(0)

  const expectedRoutes: Record<string, [string, string, string]> = {
    default: [OPENAI, KIMI, CLAUDE],
    implement: [OPENAI, KIMI, CLAUDE],
    'plan-review': [KIMI, OPENAI, CLAUDE],
    'code-review': [KIMI, OPENAI, CLAUDE],
  }
  for (const [role, expected] of Object.entries(expectedRoutes)) {
    const route = config.roles[role]
    expect(route?.runtime).toBe('pi')
    expect([route?.model, ...(route?.alternates ?? []).map(({ model }) => model)]).toEqual(expected)
    expect(
      route?.alternates?.every(({ runtime }) => runtime === undefined || runtime === 'pi'),
    ).toBe(true)
  }
})

test('remote rollout preserves this repository pipeline and hosted integration', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))

  expect(config.commands).toMatchObject({
    setup: 'bun install',
    lint: 'bun run check',
    typecheck: 'bun run typecheck',
    test: 'bun run test',
  })
  expect(config.verify.steps).toEqual(['lint', 'types', 'unit', 'dashboard', 'web-dashboard'])
  expect(config.verify.stepConfigs.lint).toEqual({ kind: 'check', command: 'lint', always: true })
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
