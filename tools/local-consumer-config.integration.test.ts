import { expect, test } from 'bun:test'
import { constants } from 'node:fs'
import { access, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { readDistSkills } from '../packages/core/src/cli/init'
import { loadConfig } from '../packages/core/src/config/load'
import { effectiveRuntimeReferences } from '../packages/core/src/config/roles'
import { verifyStages } from '../packages/core/src/config/schema'
import { evaluateVerifyApplicability } from '../packages/core/src/kernel/verify-applicability'

const REPO_ROOT = join(import.meta.dir, '..')

const CODEX = { runtime: 'codex', model: 'gpt-6.1-sol' }
const CLAUDE = { runtime: 'claude', model: 'claude-opus-5-5' }

test('repository builds locally in git worktrees on the host CLI logins', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))

  // A contributor needs no hosted service: the default workspace, the local
  // BuildStore, and the host's own Claude Code and Codex logins.
  expect(config.workspace.provider).toBe('git-worktree')
  expect(config.store).toBeUndefined()
  expect(config.accounts ?? {}).toEqual({})

  // Producers run on Claude and reviewers on Codex, each falling back to the
  // other provider. No route names a billing account: no Pi, no
  // gateway-qualified model id.
  const expected: Record<string, typeof CODEX> = {
    default: CODEX,
    plan: CLAUDE,
    implement: CLAUDE,
    'plan-review': CODEX,
    'code-review': CODEX,
  }
  expect(Object.keys(config.roles).sort()).toEqual(Object.keys(expected).sort())
  for (const [key, primary] of Object.entries(expected)) {
    const role = config.roles[key]!
    expect(role).toMatchObject(primary)
    expect(role.account).toBeUndefined()
    const fallback = primary === CODEX ? CLAUDE : CODEX
    expect(role.alternates).toEqual([fallback])
  }

  const runtimes = effectiveRuntimeReferences(config).map(({ runtime }) => runtime)
  expect(runtimes.sort()).toEqual(['claude', 'codex'])
  await access(join(REPO_ROOT, 'scripts/postgres-live.sh'), constants.X_OK)
})

test('this repository pipeline runs on its GitHub issues', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))

  expect(config.commands).toMatchObject({
    setup: 'bun install',
    lint: './scripts/verify-bun.sh bun run check',
    typecheck: './scripts/verify-bun.sh bun run typecheck',
    test: './scripts/verify-bun.sh bun run test',
  })
  expect(config.commands.build).toBe('./scripts/verify-bun.sh bun run check:build')
  const testIntegration = config.commands['test-integration']
  expect(testIntegration).toBe(
    "./scripts/postgres-live.sh ensure-running && AB_POSTGRES_TEST_URL='postgres://postgres:postgres@127.0.0.1:5432/postgres' ./scripts/verify-bun.sh bun run test:integration",
  )
  expect(config.commands['app-load']).toBe('./scripts/verify-bun.sh bun run check:app-load')
  await access(join(REPO_ROOT, 'scripts/verify-bun.sh'), constants.X_OK)
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
  expect(config.verify.stepConfigs.lint).toEqual({ kind: 'check', command: 'lint', always: true })
  expect(config.verify.stepConfigs.build).toEqual({
    kind: 'check',
    command: 'build',
    always: true,
  })
  expect(verifyStages(config.verify)).toEqual([
    ['lint', 'types'],
    ['unit', 'build', 'integration', 'app-load'],
    ['ui-tui'],
    ['ui-app', 'ui-website', 'ui-web', 'docs'],
  ])
  // Integration holds every IO test, including those that check skills, docs
  // and configuration, so it applies to every build exactly as unit does.
  expect(config.verify.stepConfigs.unit).toEqual({ kind: 'check', command: 'test' })
  expect(config.verify.stepConfigs.integration).toEqual({
    kind: 'check',
    command: 'test-integration',
  })
  expect(config.verify.stepConfigs['app-load']).toMatchObject({
    kind: 'check',
    command: 'app-load',
    paths: expect.arrayContaining(['packages/hosted-store-service/app/**', 'packages/core/src/**']),
  })
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
  expect(config.verify.stepConfigs['ui-web']).toMatchObject({
    kind: 'agent',
    skill: 'verify-ui-web',
  })
  expect(config.finalize.steps).toEqual(['changelog'])
  expect(config.finalize.stepConfigs.changelog).toEqual({
    kind: 'agent',
    skill: 'finalize-changelog',
  })
  // Each collaborator's dispatcher builds and files issues assigned to the
  // owner of its own GitHub credential.
  expect(config.tickets).toMatchObject({
    source: 'github',
    readyState: 'ready',
    readyLabels: [],
    readyAssignee: 'me',
    createAssignee: 'me',
    createLabels: ['autobuild'],
    createState: 'ready',
    triageState: 'triage',
    proposalState: 'triage',
    backlogState: 'icebox',
    rejectedState: 'rejected',
  })
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
    'tools/website-capture.integration.test.ts',
    'tools/website-capture.md',
    '.agents/skills/verify-ui-website/SKILL.md',
  ]) {
    expect(evaluateVerifyApplicability(rule, [path]).applies).toBe(true)
  }
  for (const path of ['autobuild.toml']) {
    expect(evaluateVerifyApplicability(rule, [path]).applies).toBe(false)
  }
})

test('the ui-web step runs only for packages/ui and the web server', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))
  const step = config.verify.stepConfigs['ui-web']
  if (!step || !('paths' in step) || !step.paths) throw new Error('ui-web step has no paths')
  expect(step.paths).toEqual(['packages/ui/**', 'packages/core/src/web/**'])
  const rule = { kind: 'paths' as const, step: 'ui-web', paths: step.paths }
  for (const path of [
    'packages/ui/src/app/shell.tsx',
    'packages/ui/src/catalog/main.tsx',
    'packages/ui/src/ansi.css',
    'packages/core/src/web/http.ts',
    'packages/core/src/web/assets/app.js',
  ]) {
    expect(evaluateVerifyApplicability(rule, [path]).applies).toBe(true)
  }
  const skipped = [
    'tools/ui-web-capture.ts',
    'tools/ui-web-capture.test.ts',
    '.agents/skills/verify-ui-web/SKILL.md',
    'tools/website-capture-png.ts',
    'packages/web-dashboard-capture/src/full-document.ts',
    'autobuild.toml',
    'DESIGN.md',
    'packages/core/src/kernel/engine.ts',
    'packages/core/src/cli/dashboard/render.ts',
    'packages/hosted-store-service/app/page.tsx',
    'packages/website/src/page.ts',
    'docs/verification.md',
    'tools/website-capture.ts',
  ]
  for (const path of skipped) {
    expect(evaluateVerifyApplicability(rule, [path]).applies).toBe(false)
  }
  expect(
    evaluateVerifyApplicability(rule, [...skipped, 'packages/ui/src/app/shell.tsx']).applies,
  ).toBe(true)
})

// Every tools/ module the terminal capture entry point reaches through relative
// imports, entry point excluded.
async function terminalCaptureHelpers(): Promise<string[]> {
  const entry = 'tools/dashboard-capture.ts'
  const visited = new Set<string>([entry])
  const queue = [entry]
  const specifier = /(?:from|import\()\s*['"]\.\/([^'"]+)['"]/g
  while (queue.length > 0) {
    const file = queue.shift()!
    const source = await readFile(join(REPO_ROOT, file), 'utf8')
    for (const match of source.matchAll(specifier)) {
      const name = match[1]!
      const path = `tools/${name.endsWith('.ts') ? name : `${name}.ts`}`
      if (visited.has(path)) continue
      visited.add(path)
      queue.push(path)
    }
  }
  visited.delete(entry)
  return [...visited].sort()
}

test('the ui-tui step covers the terminal dashboard, capture entry point and every capture helper', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))
  const step = config.verify.stepConfigs['ui-tui']
  if (!step || !('paths' in step) || !step.paths) throw new Error('ui-tui step has no paths')
  const rule = { kind: 'paths' as const, step: 'ui-tui', paths: step.paths }

  // A helper-only change alters captured frames, so it selects ui-tui alone.
  const helpers = await terminalCaptureHelpers()
  expect(helpers).toEqual(
    expect.arrayContaining([
      'tools/rollback-capture.ts',
      'tools/parked-slot-wait-capture.ts',
      'tools/optimization-node-capture.ts',
    ]),
  )
  for (const helper of helpers) {
    const applies = evaluateVerifyApplicability(rule, [helper]).applies
    expect({ helper, applies }).toEqual({ helper, applies: true })
  }

  for (const path of [
    'packages/core/src/cli/dashboard/render.ts',
    'packages/core/src/cli/dispatch.ts',
    'tools/dashboard-capture.ts',
    'tools/capture-parity.ts',
    '.agents/skills/verify-ui-tui/SKILL.md',
  ]) {
    const applies = evaluateVerifyApplicability(rule, [path]).applies
    expect({ path, applies }).toEqual({ path, applies: true })
  }
  for (const path of [
    'autobuild.toml',
    'tools/website-capture.ts',
    'tools/website-capture-png.ts',
    'tools/git-tracked.ts',
    'tools/check.ts',
    'packages/core/src/kernel/engine.ts',
    'packages/hosted-store-service/app/page.tsx',
    'docs/verification.md',
  ]) {
    const applies = evaluateVerifyApplicability(rule, [path]).applies
    expect({ path, applies }).toEqual({ path, applies: false })
  }

  // A renamed or removed helper cannot leave a dead literal selector behind.
  for (const path of step.paths) {
    if (!path.startsWith('tools/') || /[*?]/.test(path)) continue
    await access(join(REPO_ROOT, path))
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

test('verify-ui-web is an unprefixed repo-local skill with a Claude symlink', async () => {
  const link = join(REPO_ROOT, '.claude/skills/verify-ui-web')
  expect(await realpath(link)).toBe(await realpath(join(REPO_ROOT, '.agents/skills/verify-ui-web')))
  const skill = await readFile(join(link, 'SKILL.md'), 'utf8')
  expect(skill).toMatch(/^name: verify-ui-web$/m)
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
