import { expect, test } from 'bun:test'
import { constants } from 'node:fs'
import { access, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { readDistSkills } from '../packages/core/src/cli/init'
import { loadConfig } from '../packages/core/src/config/load'
import { effectiveRuntimeReferences } from '../packages/core/src/config/roles'
import { evaluateVerifyApplicability } from '../packages/core/src/kernel/verify-applicability'

const REPO_ROOT = join(import.meta.dir, '..')

const PRODUCER = { runtime: 'codex', model: 'gpt-6.1-sol', account: 'chatgpt' }
const REVIEWER = { runtime: 'claude', model: 'claude-opus-5-5', account: 'claude' }

test('repository builds in Vercel Sandbox on subscription-billed Claude Code and Codex', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))

  expect(config.workspace.provider).toBe('vercel-sandbox')
  const sandbox = config.workspace.config as {
    provisioning: { name: string }[]
    runtimeProvisioning: Record<string, { install: string; preflight: string }>
    environmentVariables?: string[]
  }
  expect(sandbox.provisioning.map((step) => step.name)).toEqual([
    'system-install',
    'browser-smoke',
    'postgres',
    'git-identity',
  ])
  // Each runtime is pinned, and its preflight checks that exact version.
  for (const [runtime, pin] of [
    ['claude', '@anthropic-ai/claude-code@'],
    ['codex', '@openai/codex@'],
  ] as const) {
    const provisioning = sandbox.runtimeProvisioning[runtime]!
    const version = provisioning.install.split(pin)[1] ?? ''
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(provisioning.preflight).toContain(version)
  }
  // Accounts carry the credentials; nothing is forwarded into the guest.
  expect(sandbox.environmentVariables ?? []).toEqual([])
  expect(config.accounts).toEqual({
    claude: { kind: 'claude-subscription', credentialEnv: 'CLAUDE_CODE_OAUTH_TOKEN' },
    chatgpt: { kind: 'chatgpt-subscription', credentialEnv: 'CHATGPT_ACCESS_TOKEN' },
  })

  // Producers run on Codex and reviewers on Claude, each falling back to the
  // other provider. Every route bills a named subscription account: no Pi,
  // no gateway-qualified model id.
  const expected: Record<string, typeof PRODUCER> = {
    default: PRODUCER,
    plan: PRODUCER,
    implement: PRODUCER,
    'plan-review': REVIEWER,
    'code-review': REVIEWER,
  }
  expect(Object.keys(config.roles).sort()).toEqual(Object.keys(expected).sort())
  for (const [key, primary] of Object.entries(expected)) {
    const role = config.roles[key]!
    expect(role).toMatchObject(primary)
    const fallback = primary === PRODUCER ? REVIEWER : PRODUCER
    expect(role.alternates).toEqual([fallback])
  }

  const runtimes = effectiveRuntimeReferences(config).map(({ runtime }) => runtime)
  expect(runtimes.sort()).toEqual(['claude', 'codex'])
  await access(join(REPO_ROOT, 'scripts/postgres-live.sh'), constants.X_OK)
})

test('remote rollout preserves this repository pipeline on the hosted ticket tracker', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))

  expect(config.commands).toMatchObject({
    setup: 'bun install',
    lint: 'bun run check',
    typecheck: 'bun run typecheck',
    test: 'bun run test',
  })
  expect(config.commands.build).toBe('bun run check:build')
  const testIntegration = config.commands['test-integration']
  expect(testIntegration).toContain('AB_POSTGRES_TEST_URL')
  expect(testIntegration).toContain('bun run test:integration')
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
  ])
  expect(config.verify.stepConfigs.lint).toEqual({ kind: 'check', command: 'lint', always: true })
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
  expect(config.verify.stepConfigs['ui-tui']).toMatchObject({
    kind: 'agent',
    skill: 'verify-ui-tui',
    paths: expect.arrayContaining(['packages/core/src/cli/dashboard/**']),
  })
  expect(config.verify.stepConfigs['ui-app']).toMatchObject({
    kind: 'agent',
    skill: 'verify-ui-app',
    paths: expect.arrayContaining(['packages/hosted-store-service/app/**']),
  })
  expect(config.verify.stepConfigs['ui-website']).toEqual({
    kind: 'agent',
    skill: 'verify-ui-website',
    paths: [
      'packages/website/**',
      'docs/**',
      'design/website/**',
      'tools/website-capture*',
      '.agents/skills/verify-ui-website/SKILL.md',
    ],
  })
  expect(config.finalize.steps).toEqual(['changelog'])
  expect(config.finalize.stepConfigs.changelog).toEqual({
    kind: 'agent',
    skill: 'finalize-changelog',
  })
  expect(config.tickets).toMatchObject({
    source: 'hosted',
    url: 'https://app.autobuild.run',
    teamKey: 'AUT',
    readyState: 'ready',
    createState: 'ready',
    triageState: 'triage',
    proposalState: 'triage',
  })
  expect(config.store).toEqual({ url: 'https://app.autobuild.run' })
})

test('the ui-website step covers site source, design references and evidence tooling', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))
  const step = config.verify.stepConfigs['ui-website']
  if (!step || !('paths' in step) || !step.paths) throw new Error('ui-website step has no paths')
  const rule = { kind: 'paths' as const, step: 'ui-website', paths: step.paths }
  for (const path of [
    'packages/website/src/page.ts',
    'docs/overview.md',
    'docs/architecture.md',
    'packages/website/docs/start.md',
    'design/website/reference.html',
    'tools/website-capture.ts',
    'tools/website-capture.test.ts',
    'tools/website-capture.md',
    '.agents/skills/verify-ui-website/SKILL.md',
  ]) {
    expect(evaluateVerifyApplicability(rule, [path]).applies).toBe(true)
  }
  for (const path of ['autobuild.toml']) {
    expect(evaluateVerifyApplicability(rule, [path]).applies).toBe(false)
  }
})

test('verify-ui-website is an unprefixed repo-local skill with a Claude symlink', async () => {
  const link = join(REPO_ROOT, '.claude/skills/verify-ui-website')
  expect(await realpath(link)).toBe(
    await realpath(join(REPO_ROOT, '.agents/skills/verify-ui-website')),
  )
  const skill = await readFile(join(link, 'SKILL.md'), 'utf8')
  expect(skill).toMatch(/^name: verify-ui-website$/m)
})

test('docs gate covers product surfaces and excludes repository configuration', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))
  const step = config.verify.stepConfigs.docs!
  const paths = [
    'packages/core/src/**',
    'packages/hosted-dispatcher/src/**',
    'packages/hosted-store-service/src/**',
    'packages/hosted-store-service/app/**',
    'packages/postgres-store/src/**',
    'packages/vercel-sandbox/src/**',
    'packages/website/**',
    'bin/**',
    'skills/**',
    'templates/**',
    'SPEC.md',
    'README.md',
    'docs/**',
  ]
  expect(step).toEqual({ kind: 'agent', skill: 'verify-docs', paths })
  const rule = { kind: 'paths' as const, step: 'docs', paths }
  for (const path of paths.map((path) => path.replace('**', 'example.ts'))) {
    expect(evaluateVerifyApplicability(rule, [path]).applies).toBe(true)
    // Deleted paths and both rename sides use the same changed-path evidence.
    expect(evaluateVerifyApplicability(rule, [path, 'tools/renamed.ts']).applies).toBe(true)
    expect(evaluateVerifyApplicability(rule, ['tools/old.ts', path]).applies).toBe(true)
  }
  for (const path of [
    'tools/check.ts',
    'autobuild.toml',
    'AGENTS.md',
    '.agents/skills/verify-docs/SKILL.md',
    '.claude/skills/verify-docs',
    'packages/web-dashboard-capture/src/index.ts',
  ]) {
    expect(evaluateVerifyApplicability(rule, [path]).applies).toBe(false)
  }
  const link = join(REPO_ROOT, '.claude/skills/verify-docs')
  expect(await realpath(link)).toBe(await realpath(join(REPO_ROOT, '.agents/skills/verify-docs')))
  const skill = await readFile(join(link, 'SKILL.md'), 'utf8')
  expect(skill).toMatch(/^name: verify-docs$/m)
  expect(skill).toMatch(/^disable-model-invocation: true$/m)
  for (const instruction of [
    'ab context',
    'commitRange.base',
    'commitRange.head',
    'git diff <base>..<head>',
    'ab verdict pass --notes .ab/docs-verify-report.md',
    'ab verdict fail --report .ab/docs-verify-report.md',
  ])
    expect(skill).toContain(instruction)
  expect(
    (await readDistSkills(REPO_ROOT)).some((skill) => skill.installName === 'verify-docs'),
  ).toBe(false)
})
