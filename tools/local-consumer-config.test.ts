import { expect, test } from 'bun:test'
import { constants } from 'node:fs'
import { access, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { readDistSkills } from '../packages/core/src/cli/init'
import { loadConfig } from '../packages/core/src/config/load'
import { effectiveRuntimeReferences } from '../packages/core/src/config/roles'
import { evaluateVerifyApplicability } from '../packages/core/src/kernel/verify-applicability'

const REPO_ROOT = join(import.meta.dir, '..')

const PRODUCER = { runtime: 'codex', model: 'gpt-6.1-sol' }
const REVIEWER = { runtime: 'claude', model: 'claude-opus-5-5' }

test('repository builds in local worktrees on the local Claude Code and Codex CLIs', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))

  expect(config.workspace).toEqual({ provider: 'git-worktree', config: {} })

  // Producers run on Codex and reviewers on Claude, each falling back to the
  // other provider. Every route stays on a subscription-billed local CLI:
  // no Pi, no gateway-qualified model id.
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

test('local rollout preserves this repository pipeline and file ticket tracker', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))

  expect(config.commands).toMatchObject({
    setup: 'bun install',
    lint: 'bun run check',
    typecheck: 'bun run typecheck',
    test: 'bun run test',
  })
  const testPostgres = config.commands['test-postgres']
  expect(testPostgres).toContain('AB_POSTGRES_TEST_URL')
  expect(testPostgres).toContain('bun tools/hosted-service-packaging.ts')
  expect(testPostgres).toContain('packages/postgres-store/src/store.live.test.ts')
  expect(testPostgres).toContain('packages/postgres-store/src/migrate.test.ts')
  expect(config.verify.steps).toEqual([
    'lint',
    'types',
    'unit',
    'postgres',
    'dashboard',
    'web-dashboard',
    'website',
    'docs',
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
    paths: expect.arrayContaining(['packages/hosted-store-service/app/**']),
  })
  expect(config.verify.stepConfigs.website).toEqual({
    kind: 'agent',
    skill: 'verify-website',
    paths: [
      'packages/website/**',
      'docs/**',
      'design/website/**',
      'tools/website-capture*',
      '.agents/skills/verify-website/SKILL.md',
    ],
  })
  expect(config.finalize.steps).toEqual(['changelog'])
  expect(config.finalize.stepConfigs.changelog).toEqual({
    kind: 'agent',
    skill: 'finalize-changelog',
  })
  expect(config.tickets).toMatchObject({
    source: 'file',
    readyState: 'ready',
    createState: 'ready',
    triageState: 'triage',
    proposalState: 'triage',
  })
  expect(config.tickets.teamKey).toBeUndefined()
})

test('the website step covers site source, design references and evidence tooling', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))
  const step = config.verify.stepConfigs.website
  if (!step || !('paths' in step) || !step.paths) throw new Error('website step has no paths')
  const rule = { kind: 'paths' as const, step: 'website', paths: step.paths }
  for (const path of [
    'packages/website/src/page.ts',
    'docs/overview.md',
    'docs/architecture.md',
    'packages/website/docs/start.md',
    'design/website/reference.html',
    'tools/website-capture.ts',
    'tools/website-capture.test.ts',
    'tools/website-capture.md',
    '.agents/skills/verify-website/SKILL.md',
  ]) {
    expect(evaluateVerifyApplicability(rule, [path]).applies).toBe(true)
  }
  for (const path of ['autobuild.toml']) {
    expect(evaluateVerifyApplicability(rule, [path]).applies).toBe(false)
  }
})

test('verify-website is an unprefixed repo-local skill with a Claude symlink', async () => {
  const link = join(REPO_ROOT, '.claude/skills/verify-website')
  expect(await realpath(link)).toBe(
    await realpath(join(REPO_ROOT, '.agents/skills/verify-website')),
  )
  const skill = await readFile(join(link, 'SKILL.md'), 'utf8')
  expect(skill).toMatch(/^name: verify-website$/m)
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
