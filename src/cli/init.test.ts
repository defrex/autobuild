/**
 * `ab init` tests (SPEC §16.3, D11): vendored, namespaced, editable skills.
 * Installs from the REAL distribution (skills/ + templates/ resolved relative
 * to the module, not the cwd) into throwaway temp targets, and proves the
 * safety properties: config never clobbered, local edits never overwritten
 * without force, pristine records byte-identical to what was installed.
 *
 * Also covers the main.ts routing restructure: `ab init` runs OUTSIDE build
 * sessions, so runCli must route it before any store/env requirement — and
 * bin/ab.ts must work with no AB_* environment set at all.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  abInit as productionAbInit,
  claudeSkillPath,
  defaultDistRoot,
  INIT_ROLE_PROFILE_CHOICES,
  INIT_SPLIT_AUTHOR_MODEL,
  INIT_SPLIT_REVIEWER_MODEL,
  installedSkillFilePath,
  installedSkillPath,
  MODEL_INVOCABLE_SKILLS,
  pristineSkillFilePath,
  pristineSkillPath,
  renderAutobuildTemplate,
  renderInitSelections,
  rewriteSkillSource,
} from './init'
import type { InitPresentation, InitPrompter, InitPromptQuestion } from './init-prompt'
import { INIT_PLUGIN_HELP, InitCancelledError } from './init-prompt'
import { runCli, type SessionlessCliDeps } from './main'
import { parseConfig } from '../config/load'
import { createProductionRuntimes } from '../ports/runner/production'
import { createRuntimeResolver } from '../ports/runner/routing'
import type { RuntimeRegistry } from '../ports/runner/runtime'

const TEST_INIT_RUNTIMES: RuntimeRegistry = Object.fromEntries(
  Object.entries(createProductionRuntimes().runtimes).map(([name, registration]) => [
    name,
    { ...registration, initUsable: async () => true },
  ]),
)

const abInit: typeof productionAbInit = (opts) =>
  productionAbInit({ ...opts, runtimes: opts.runtimes ?? TEST_INIT_RUNTIMES, env: opts.env ?? {} })

const DIST_ROOT = resolve(import.meta.dir, '..', '..')

/** The canonical skills shipped in the distribution (§16.3). */
const SKILL_NAMES = [
  'code-review',
  'finalize',
  'guide',
  'harvest',
  'harvest-review',
  'implement',
  'plan',
  'plan-review',
  'reconcile',
  'spec',
  'tickets',
  'verify-e2e',
]

let target: string

beforeEach(async () => {
  target = await mkdtemp(join(tmpdir(), 'ab-init-'))
})

afterEach(async () => {
  await rm(target, { recursive: true, force: true })
})

/** Split installed content into frontmatter lines and the body below it. */
function splitFrontmatter(content: string): { front: string[]; body: string } {
  const lines = content.split('\n')
  expect(lines[0]).toBe('---')
  const close = lines.indexOf('---', 1)
  expect(close).toBeGreaterThan(0)
  return { front: lines.slice(1, close), body: lines.slice(close + 1).join('\n') }
}

function expectLeanGeneratedConfig(source: string): void {
  const lines = source.split('\n')
  expect(lines.slice(0, 3)).toEqual([
    '# Autobuild pipeline configuration.',
    '# Declarative only; nothing in this file is evaluated.',
    '# Ask your coding agent to change it.',
  ])
  expect(source).not.toMatch(/^\s*#\s*\[[^\]]+\]/m)
  expect(source).not.toMatch(/^\s*#\s*[A-Za-z0-9_.-]+\s*=/m)
  expect(source).not.toMatch(/(?:§\s*\d|\bD\d+\b)/)
  expect(source).not.toContain('@ab-init/')
  expect(source).toContain('capacity = 1')
  for (const setting of [
    'stallRounds = 3',
    'maxVerifyAttempts = 3',
    'maxReconcileAttempts = 3',
    'maxReviewRounds = 4',
    'harvestThreshold = 5',
    'steps = []',
  ]) {
    expect(source).toContain(setting)
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\[[^\]]+\]$/.test(lines[index]!)) continue
    expect(lines[index - 1]).toMatch(/^# \S.{0,78}$/)
    expect(lines[index - 2] ?? '').not.toMatch(/^# /)
  }
}

describe('abInit — fresh install', () => {
  test('installs every skill under .agents and links Claude discovery to the same copies', async () => {
    const report = await abInit({ targetRepo: target })

    expect(report.config).toBe('written')
    expect(report.skills).toEqual(
      SKILL_NAMES.map((name) => ({ skill: `ab-${name}`, action: 'installed' })),
    )
    for (const name of SKILL_NAMES) {
      const installed = await readFile(installedSkillPath(target, `ab-${name}`), 'utf8')
      const pristine = await readFile(pristineSkillPath(target, `ab-${name}`), 'utf8')
      expect(pristine).toBe(installed)
      const claude = claudeSkillPath(target, `ab-${name}`)
      expect((await lstat(claude)).isSymbolicLink()).toBe(true)
      expect(await readlink(claude)).toBe(`../../.agents/skills/ab-${name}`)
      expect(await readFile(join(claude, 'SKILL.md'), 'utf8')).toBe(installed)
    }
  })

  test('vendors guide references byte-identically through live, pristine, and Claude views', async () => {
    await abInit({ targetRepo: target })
    const relative = 'references/plugin-authoring.md'
    const canonical = await readFile(
      join(DIST_ROOT, 'skills', 'guide', ...relative.split('/')),
      'utf8',
    )
    expect(await readFile(installedSkillFilePath(target, 'ab-guide', relative), 'utf8')).toBe(
      canonical,
    )
    expect(await readFile(pristineSkillFilePath(target, 'ab-guide', relative), 'utf8')).toBe(
      canonical,
    )
    expect(
      await readFile(join(claudeSkillPath(target, 'ab-guide'), ...relative.split('/')), 'utf8'),
    ).toBe(canonical)
  })

  test('frontmatter: name rewritten; disable-model-invocation everywhere EXCEPT the model-invocable set', async () => {
    // The set is the policy (§16.3): skills that drive no phase may be
    // model-invoked; every phase skill must not be.
    expect([...MODEL_INVOCABLE_SKILLS].sort()).toEqual(['guide', 'spec', 'tickets'])
    await abInit({ targetRepo: target })
    for (const name of SKILL_NAMES) {
      const installed = await readFile(installedSkillPath(target, `ab-${name}`), 'utf8')
      const { front } = splitFrontmatter(installed)
      expect(front).toContain(`name: ab-${name}`)
      if (MODEL_INVOCABLE_SKILLS.has(name)) {
        // The model-invocable skills drive no phase (§16.3). "Move ticket X to
        // ready" is a conversational trigger — auto-invocation is the point,
        // where for a phase skill it would be a bug.
        expect(front.some((l) => l.startsWith('disable-model-invocation:'))).toBe(false)
      } else {
        expect(front).toContain('disable-model-invocation: true')
      }
      // The description travels verbatim from the source frontmatter.
      const source = await readFile(join(DIST_ROOT, 'skills', name, 'SKILL.md'), 'utf8')
      const sourceDescription = splitFrontmatter(source).front.find((l) =>
        l.startsWith('description:'),
      )
      expect(sourceDescription).toBeDefined()
      expect(front).toContain(sourceDescription!)
    }
  })

  test('body below the frontmatter is byte-identical to the source', async () => {
    await abInit({ targetRepo: target })
    for (const name of SKILL_NAMES) {
      const source = await readFile(join(DIST_ROOT, 'skills', name, 'SKILL.md'), 'utf8')
      const installed = await readFile(installedSkillPath(target, `ab-${name}`), 'utf8')
      expect(splitFrontmatter(installed).body).toBe(splitFrontmatter(source).body)
    }
  })

  test('a no-package render is a lean setup-only, zero-verify config', async () => {
    await abInit({ targetRepo: target })
    const generated = await readFile(join(target, 'autobuild.toml'), 'utf8')
    expectLeanGeneratedConfig(generated)
    const generatedConfig = parseConfig(generated)
    expect(generatedConfig.baseBranch).toBe('main')
    expect(generatedConfig.capacity).toBe(1)
    expect(generatedConfig.policy).toEqual({
      stallRounds: 3,
      maxVerifyAttempts: 3,
      maxReconcileAttempts: 3,
      maxReviewRounds: 4,
      harvestThreshold: 5,
    })
    expect(generatedConfig.commands).toEqual({ setup: 'bun install' })
    expect(generatedConfig.verify).toEqual({ steps: [], stepConfigs: {} })
    expect(generatedConfig.finalize).toEqual({ steps: [], stepConfigs: {} })
    expect(generatedConfig.tickets.readyLabels).toBeUndefined()
  })

  test('creates a .gitignore containing the repository-local state rule', async () => {
    await abInit({ targetRepo: target })
    expect(await readFile(join(target, '.gitignore'), 'utf8')).toBe('.autobuild/\n')
  })

  test('the generated autobuild.toml parses with its dispatch and role defaults', async () => {
    // A fresh project must be dispatchable out of the box: the required
    // readyState is present, non-blank, and set to the file tracker's `ready/`
    // directory. Its agent base is the reserved role entry, never a second
    // top-level config concept.
    await abInit({ targetRepo: target })
    const config = parseConfig(await readFile(join(target, 'autobuild.toml'), 'utf8'))
    expect(config.baseBranch).toBe('main')
    expect(config.capacity).toBe(1)
    expect(config.policy.harvestThreshold).toBe(5)
    expect(config.tickets.readyState).toBe('ready')
    expect(config.roles.default).toEqual({ runtime: 'pi' })
    expect(config.roles.plan?.model).toBe(INIT_SPLIT_AUTHOR_MODEL)
    expect(config.commands).toEqual({ setup: 'bun install' })
    expect(config.finalize).toEqual({ steps: [], stepConfigs: {} })
    expect(config.verify).toEqual({ steps: [], stepConfigs: {} })
  })

  test('non-interactive selection discovers future registered runtimes generically', async () => {
    const runner = TEST_INIT_RUNTIMES.claude!.runner
    await productionAbInit({
      targetRepo: target,
      env: {},
      runtimes: {
        future: { runner, servesModels: [], initUsable: async () => true },
      },
    })
    expect(
      parseConfig(await readFile(join(target, 'autobuild.toml'), 'utf8')).roles.default,
    ).toEqual({ runtime: 'future' })
  })

  test('no usable runtime fails before mutating the repository and names the override flag', async () => {
    const runner = TEST_INIT_RUNTIMES.claude!.runner
    await expect(
      productionAbInit({
        targetRepo: target,
        env: {},
        runtimes: {
          unavailable: { runner, servesModels: [], initUsable: async () => false },
        },
      }),
    ).rejects.toThrow('--role-profile')
    expect(existsSync(join(target, 'autobuild.toml'))).toBe(false)
    expect(existsSync(join(target, '.gitignore'))).toBe(false)
    expect(existsSync(join(target, '.agents'))).toBe(false)
  })

  test('distRoot defaults relative to the module — identical to an explicit distRoot', async () => {
    expect(defaultDistRoot()).toBe(DIST_ROOT)
    const other = await mkdtemp(join(tmpdir(), 'ab-init-explicit-'))
    try {
      await abInit({ targetRepo: target })
      await abInit({ targetRepo: other, distRoot: DIST_ROOT })
      const a = await readFile(installedSkillPath(target, 'ab-plan'), 'utf8')
      const b = await readFile(installedSkillPath(other, 'ab-plan'), 'utf8')
      expect(a).toBe(b)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })
})

describe('abInit — package-script-aware config rendering', () => {
  const recognized = ['lint', 'type-check', 'test'] as const
  const subsets = Array.from({ length: 1 << recognized.length }, (_, mask) =>
    recognized.filter((_, index) => (mask & (1 << index)) !== 0),
  )

  for (const scripts of subsets) {
    test(`renders only ${scripts.length === 0 ? 'no recognized scripts' : scripts.join(', ')}`, async () => {
      const declarations: Record<string, string> = {
        build: 'bun build src/index.ts',
        // Deliberate near miss: this must not stand in for exact `type-check`.
        typecheck: 'tsc --noEmit',
      }
      for (const script of scripts) declarations[script] = `echo ${script}`
      await writeFile(
        join(target, 'package.json'),
        JSON.stringify({ name: 'fixture', scripts: declarations }),
      )

      await abInit({ targetRepo: target })
      const generated = await readFile(join(target, 'autobuild.toml'), 'utf8')
      const config = parseConfig(generated)
      const has = (script: (typeof recognized)[number]) => scripts.includes(script)

      expect(config.commands).toEqual({
        setup: 'bun install',
        ...(has('lint') ? { lint: 'bun run lint' } : {}),
        ...(has('type-check') ? { 'type-check': 'bun run type-check' } : {}),
        ...(has('test') ? { test: 'bun run test' } : {}),
      })
      expect(config.verify.steps).toEqual(scripts)
      expect(config.verify.stepConfigs).toEqual(
        Object.fromEntries(
          scripts.map((script) => [script, { kind: 'check', command: script, always: true }]),
        ),
      )
      for (const [name, step] of Object.entries(config.verify.stepConfigs)) {
        expect(step).toEqual({ kind: 'check', command: name, always: true })
        expect(Object.hasOwn(config.commands, name)).toBe(true)
      }
      expectLeanGeneratedConfig(generated)
    })
  }

  test('a package with no scripts map produces the empty package-backed set', async () => {
    await writeFile(join(target, 'package.json'), JSON.stringify({ name: 'fixture' }))
    await abInit({ targetRepo: target })
    const config = parseConfig(await readFile(join(target, 'autobuild.toml'), 'utf8'))
    expect(config.commands).toEqual({ setup: 'bun install' })
    expect(config.verify).toEqual({ steps: [], stepConfigs: {} })
  })

  test('malformed package JSON fails with the manifest path', async () => {
    const manifestPath = join(target, 'package.json')
    await writeFile(manifestPath, '{"scripts":')
    await expect(abInit({ targetRepo: target })).rejects.toThrow(`${manifestPath}: invalid JSON`)
    expect(existsSync(join(target, 'autobuild.toml'))).toBe(false)
  })

  test('an unreadable package manifest fails with its path', async () => {
    const manifestPath = join(target, 'package.json')
    await mkdir(manifestPath)
    await expect(abInit({ targetRepo: target })).rejects.toThrow(
      `${manifestPath}: unable to read package manifest`,
    )
    expect(existsSync(join(target, 'autobuild.toml'))).toBe(false)
  })

  test('invalid recognized script declarations fail with the manifest path and script', async () => {
    const invalid: Array<[string, unknown]> = [
      ['lint', 42],
      ['type-check', null],
      ['test', '   '],
    ]
    for (const [script, declaration] of invalid) {
      const repo = join(target, script)
      await mkdir(repo, { recursive: true })
      const manifestPath = join(repo, 'package.json')
      await writeFile(manifestPath, JSON.stringify({ scripts: { [script]: declaration } }))
      await expect(abInit({ targetRepo: repo })).rejects.toThrow(
        `${manifestPath}: package script "${script}" must be a non-empty string`,
      )
    }
  })

  test('template rendering rejects missing or duplicated package and selection anchors', async () => {
    const template = await readFile(join(DIST_ROOT, 'templates', 'autobuild.toml'), 'utf8')
    expect(() =>
      renderAutobuildTemplate(
        template.replace('# @ab-init/package-script-commands', ''),
        new Set(['lint']),
      ),
    ).toThrow(/must occur exactly once; found 0/)
    expect(() => renderAutobuildTemplate(`${template}\n${template}`, new Set())).toThrow(
      /must occur exactly once; found 2/,
    )
    const baseline = renderAutobuildTemplate(template, new Set())
    const selections = {
      ticketSource: 'file',
      workspaceProvider: 'git-worktree',
      roleProfile: 'claude',
    } as const
    expect(() =>
      renderInitSelections(baseline.replace('# @ab-init/roles-start', ''), selections),
    ).toThrow(/must each occur exactly once/)
    expect(() => renderInitSelections(`${baseline}\n${baseline}`, selections)).toThrow(
      /must each occur exactly once/,
    )
  })
})

class ScriptedInitPrompter implements InitPrompter {
  readonly questions: InitPromptQuestion[] = []
  presentation: InitPresentation | undefined
  closed = false

  constructor(private readonly answers: string[] = []) {}

  async select<T extends string>(question: InitPromptQuestion<T>): Promise<T> {
    this.questions.push(question)
    const answer = this.answers.shift() ?? question.defaultValue
    const choice = question.choices.find((candidate) => candidate.value === answer)
    if (choice === undefined) throw new Error(`test answer ${answer} is not a choice`)
    return choice.value
  }

  present(presentation: InitPresentation): void {
    this.presentation = presentation
  }

  close(): void {
    this.closed = true
  }
}

describe('abInit — interactive adapter onboarding', () => {
  async function generated(repo: string): Promise<string> {
    return readFile(join(repo, 'autobuild.toml'), 'utf8')
  }

  test('headless and explicit skip preserve the default package-rendered bytes', async () => {
    await writeFile(
      join(target, 'package.json'),
      JSON.stringify({ scripts: { lint: 'eslint', 'type-check': 'tsc', test: 'vitest' } }),
    )
    const template = await readFile(join(DIST_ROOT, 'templates', 'autobuild.toml'), 'utf8')
    const expected = renderInitSelections(
      renderAutobuildTemplate(template, new Set(['lint', 'type-check', 'test'])),
      { ticketSource: 'file', workspaceProvider: 'git-worktree', roleProfile: 'split' },
    )

    await abInit({ targetRepo: target })
    expect(await generated(target)).toBe(expected)

    const skipped = join(target, 'skip')
    await mkdir(skipped)
    await writeFile(join(skipped, 'package.json'), await readFile(join(target, 'package.json')))
    const prompter = new ScriptedInitPrompter(['linear', 'git-worktree', 'split'])
    await abInit({
      targetRepo: skipped,
      selections: { noInteractive: true },
      prompter,
    })
    expect(await generated(skipped)).toBe(expected)
    expect(prompter.questions).toHaveLength(0)
  })

  test('prompt order, defaults, local-first options, and common plugin help are fixed', async () => {
    await writeFile(
      join(target, 'package.json'),
      JSON.stringify({ scripts: { 'type-check': 'tsc', test: 'vitest' } }),
    )
    const prompter = new ScriptedInitPrompter()
    await abInit({ targetRepo: target, prompter })

    expect(prompter.questions.map((question) => question.message)).toEqual([
      'Choose a ticket source',
      'Choose a workspace provider',
      'Choose a role runtime/model arrangement',
    ])
    expect(prompter.questions.map((question) => question.defaultValue)).toEqual([
      'file',
      'git-worktree',
      'split',
    ])
    expect(prompter.questions.map((question) => question.choices[0]?.value)).toEqual([
      'file',
      'git-worktree',
      'split',
    ])
    expect(prompter.questions.every((question) => question.help === INIT_PLUGIN_HELP)).toBe(true)
    expect(prompter.closed).toBe(true)

    const config = parseConfig(await generated(target))
    expect(config.tickets.source).toBe('file')
    expect(config.workspace).toEqual({ provider: 'git-worktree', config: {} })
    expect(config.commands).toMatchObject({
      setup: 'bun install',
      'type-check': 'bun run type-check',
      test: 'bun run test',
    })
    expect(config.verify.steps).toEqual(['type-check', 'test'])
    expect(config.roles.plan).toEqual({ runtime: 'pi', model: INIT_SPLIT_AUTHOR_MODEL })
    expect(config.roles.implement).toEqual({
      runtime: 'pi',
      model: INIT_SPLIT_AUTHOR_MODEL,
    })
    expect(config.roles['plan-review']).toEqual({
      runtime: 'pi',
      model: INIT_SPLIT_REVIEWER_MODEL,
    })
    expect(config.roles['code-review']).toEqual({
      runtime: 'pi',
      model: INIT_SPLIT_REVIEWER_MODEL,
    })
    expect(INIT_SPLIT_AUTHOR_MODEL).not.toBe(INIT_SPLIT_REVIEWER_MODEL)
  })

  test('the presenter does not request Pi setup after successful auto-detection', async () => {
    const prompter = new ScriptedInitPrompter(['linear', 'git-worktree', 'split'])
    const report = await abInit({ targetRepo: target, prompter })

    expect(prompter.presentation).toEqual({
      config: 'written',
      skillCounts: {
        installed: report.skills.length,
        unchanged: 0,
        kept: 0,
        overwritten: 0,
      },
      attention: [],
      nextSteps: [
        'Ask your coding agent to change autobuild.toml.',
        expect.stringContaining('Linear setup required:'),
      ],
    })
  })

  test('shipped runtime resolution accepts the split and Pi profiles', async () => {
    const roles = ['plan', 'implement', 'plan-review', 'code-review'] as const
    const production = createProductionRuntimes()

    for (const roleProfile of ['split', 'pi'] as const) {
      const repo = join(target, roleProfile)
      const output: string[] = []
      await abInit({
        targetRepo: repo,
        selections: {
          ticketSource: 'file',
          workspaceProvider: 'git-worktree',
          roleProfile,
        },
        stdout: (line) => output.push(line),
      })
      const setupNotice = output.find((line) => line.includes('Pi setup required:'))
      expect(setupNotice).toContain('run `pi` and use `/login`')
      expect(setupNotice).toContain('provider API key in the environment')
      expect(setupNotice).not.toContain('pi login')

      const config = parseConfig(await generated(repo))
      const resolver = createRuntimeResolver(production.runtimes, config.roles)
      const resolved = Object.fromEntries(roles.map((role) => [role, resolver.resolve(role)]))
      for (const role of roles) expect(resolved[role]?.runtime).toBe('pi')

      if (roleProfile === 'split') {
        expect(resolved.plan?.model).toBe(INIT_SPLIT_AUTHOR_MODEL)
        expect(resolved.implement?.model).toBe(INIT_SPLIT_AUTHOR_MODEL)
        expect(resolved['plan-review']?.model).toBe(INIT_SPLIT_REVIEWER_MODEL)
        expect(resolved['code-review']?.model).toBe(INIT_SPLIT_REVIEWER_MODEL)
        expect(resolved.plan?.model).not.toBe(resolved['plan-review']?.model)
      } else {
        const piDefault = production.runtimes.pi?.defaultModel
        for (const role of roles) expect(resolved[role]?.model).toBe(piDefault)
      }
    }
  })

  test('partial flags suppress only their prompts; fully specified flags never select', async () => {
    const partial = new ScriptedInitPrompter(['git-worktree', 'pi'])
    await abInit({
      targetRepo: target,
      selections: { ticketSource: 'linear' },
      prompter: partial,
    })
    expect(partial.questions.map((question) => question.message)).toEqual([
      'Choose a workspace provider',
      'Choose a role runtime/model arrangement',
    ])

    const fullRepo = join(target, 'full')
    const full = new ScriptedInitPrompter()
    await abInit({
      targetRepo: fullRepo,
      selections: {
        ticketSource: 'file',
        workspaceProvider: 'git-worktree',
        roleProfile: 'claude',
      },
      prompter: full,
    })
    expect(full.questions).toHaveLength(0)
  })

  for (const roleProfile of INIT_ROLE_PROFILE_CHOICES.map((choice) => choice.value)) {
    test(`interactive ${roleProfile} profile is byte-identical to equivalent flags`, async () => {
      const interactive = join(target, 'interactive')
      const flagged = join(target, 'flagged')
      await abInit({
        targetRepo: interactive,
        prompter: new ScriptedInitPrompter(['file', 'git-worktree', roleProfile]),
      })
      await abInit({
        targetRepo: flagged,
        selections: {
          ticketSource: 'file',
          workspaceProvider: 'git-worktree',
          roleProfile,
        },
      })
      expect(await generated(interactive)).toBe(await generated(flagged))
      const flaggedSource = await generated(flagged)
      expect(() => parseConfig(flaggedSource)).not.toThrow()
      expectLeanGeneratedConfig(flaggedSource)
    })
  }

  for (const ticketSource of ['file', 'linear'] as const) {
    test(`interactive ${ticketSource} tickets are byte-identical to equivalent flags`, async () => {
      const interactive = join(target, 'interactive')
      const flagged = join(target, 'flagged')
      await abInit({
        targetRepo: interactive,
        prompter: new ScriptedInitPrompter([ticketSource, 'git-worktree', 'claude']),
      })
      await abInit({
        targetRepo: flagged,
        selections: {
          ticketSource,
          workspaceProvider: 'git-worktree',
          roleProfile: 'claude',
        },
      })
      expect(await generated(interactive)).toBe(await generated(flagged))
      const flaggedSource = await generated(flagged)
      expect(parseConfig(flaggedSource).tickets.source).toBe(ticketSource)
      expectLeanGeneratedConfig(flaggedSource)
    })
  }

  test('Linear writes valid placeholders, prints non-secret setup, and never stores a secret', async () => {
    const lines: string[] = []
    await abInit({
      targetRepo: target,
      selections: {
        ticketSource: 'linear',
        workspaceProvider: 'git-worktree',
        roleProfile: 'claude',
      },
      stdout: (line) => lines.push(line),
    })
    const source = await generated(target)
    const config = parseConfig(source)
    expect(config.tickets).toMatchObject({
      source: 'linear',
      teamKey: 'REPLACE_WITH_LINEAR_TEAM_KEY',
      readyState: 'REPLACE_WITH_LINEAR_READY_STATE',
    })
    expect(lines.join('\n')).toContain('LINEAR_API_KEY')
    expect(lines.join('\n')).toContain('[tickets].teamKey')
    expect(lines.join('\n')).toContain('[tickets].readyState')
    expect(source).not.toMatch(/LINEAR_API_KEY\s*=/)
  })

  test('cancellation at every question leaves the repository untouched', async () => {
    for (const cancelAt of [1, 2, 3]) {
      const repo = join(target, `cancel-${cancelAt}`)
      await mkdir(repo)
      let selected = 0
      let closed = false
      const prompter: InitPrompter = {
        async select<T extends string>(question: InitPromptQuestion<T>): Promise<T> {
          selected += 1
          if (selected === cancelAt) throw new InitCancelledError()
          return question.defaultValue
        },
        close() {
          closed = true
        },
      }

      await expect(abInit({ targetRepo: repo, prompter })).rejects.toThrow('Init cancelled.')
      expect(closed).toBe(true)
      expect(existsSync(join(repo, 'autobuild.toml'))).toBe(false)
      expect(existsSync(join(repo, '.gitignore'))).toBe(false)
      expect(existsSync(join(repo, '.agents'))).toBe(false)
      expect(existsSync(join(repo, '.claude'))).toBe(false)
    }
  })

  test('fresh invalid and contradictory selections fail, while an existing config ignores them', async () => {
    await expect(
      abInit({ targetRepo: target, selections: { ticketSource: 'jira' } }),
    ).rejects.toThrow(/invalid --ticket-source.*file\|linear/)
    await expect(
      abInit({
        targetRepo: target,
        selections: { noInteractive: true, roleProfile: 'split' },
      }),
    ).rejects.toThrow(/--no-interactive cannot be combined/)

    await writeFile(join(target, 'autobuild.toml'), 'baseBranch = "kept"\n')
    const prompter = new ScriptedInitPrompter()
    const report = await abInit({
      targetRepo: target,
      force: true,
      selections: {
        ticketSource: 'not-real',
        workspaceProvider: 'also-not-real',
        roleProfile: 'invalid',
        noInteractive: true,
      },
      prompter,
    })
    expect(report.config).toBe('skipped')
    expect(await generated(target)).toBe('baseBranch = "kept"\n')
    expect(prompter.questions).toHaveLength(0)
  })
})

describe('abInit — idempotence and safety', () => {
  test('appends the state rule without changing existing ignore bytes', async () => {
    await writeFile(join(target, '.gitignore'), 'dist/\n.env')
    await abInit({ targetRepo: target })
    expect(await readFile(join(target, '.gitignore'), 'utf8')).toBe('dist/\n.env\n.autobuild/\n')
  })

  test('does not duplicate an existing state rule on re-init', async () => {
    await writeFile(join(target, '.gitignore'), 'dist/\n.autobuild/\n')
    await abInit({ targetRepo: target })
    await abInit({ targetRepo: target })
    expect(await readFile(join(target, '.gitignore'), 'utf8')).toBe('dist/\n.autobuild/\n')
  })

  test('migrates .agent skills, pristine bases, local additions, and Claude links', async () => {
    const name = 'ab-plan'
    const customName = 'ab-custom'
    const oldRoot = join(target, '.agent', 'skills')
    const oldLive = join(oldRoot, name, 'SKILL.md')
    const oldPristine = join(oldRoot, '.ab-pristine', name, 'SKILL.md')
    const oldCustom = join(oldRoot, customName, 'SKILL.md')
    await mkdir(dirname(oldLive), { recursive: true })
    await mkdir(dirname(oldPristine), { recursive: true })
    await mkdir(dirname(oldCustom), { recursive: true })
    await writeFile(oldLive, 'locally customized plan\n')
    await writeFile(join(dirname(oldLive), 'notes.md'), 'local supporting file\n')
    await writeFile(oldPristine, 'old pristine plan\n')
    await writeFile(oldCustom, '---\nname: ab-custom\n---\nlocal addition\n')

    const claudeRoot = join(target, '.claude', 'skills')
    await mkdir(claudeRoot, { recursive: true })
    await symlink(`../../.agent/skills/${name}`, join(claudeRoot, name), 'dir')
    await symlink(`../../.agent/skills/${customName}`, join(claudeRoot, customName), 'dir')

    const report = await abInit({ targetRepo: target })

    expect(report.skills.find((skill) => skill.skill === name)).toEqual({
      skill: name,
      action: 'kept',
    })
    expect(await readFile(installedSkillPath(target, name), 'utf8')).toBe(
      'locally customized plan\n',
    )
    expect(await readFile(pristineSkillPath(target, name), 'utf8')).toBe('old pristine plan\n')
    expect(
      await readFile(join(dirname(installedSkillPath(target, name)), 'notes.md'), 'utf8'),
    ).toBe('local supporting file\n')
    expect(await readFile(installedSkillPath(target, customName), 'utf8')).toContain(
      'local addition',
    )
    expect(existsSync(join(target, '.agent'))).toBe(false)
    expect(await readlink(claudeSkillPath(target, name))).toBe(`../../.agents/skills/${name}`)
    expect(await readlink(claudeSkillPath(target, customName))).toBe(
      `../../.agents/skills/${customName}`,
    )
  })

  test('surfaces conflicting legacy pristine leftovers for manual recovery', async () => {
    const name = 'ab-plan'
    const live = installedSkillPath(target, name)
    const pristine = pristineSkillPath(target, name)
    const legacyPristine = join(target, '.claude', 'skills', '.ab-pristine', name, 'SKILL.md')
    await mkdir(dirname(live), { recursive: true })
    await mkdir(dirname(pristine), { recursive: true })
    await mkdir(dirname(legacyPristine), { recursive: true })
    await writeFile(live, 'local plan\n')
    await writeFile(pristine, 'new-layout pristine\n')
    await writeFile(legacyPristine, 'conflicting legacy pristine\n')
    const lines: string[] = []

    await abInit({ targetRepo: target, stdout: (line) => lines.push(line) })

    expect(lines).toContain(
      'ab-plan: warning — conflicting legacy pristine files remain at ' +
        '.claude/skills/.ab-pristine/ab-plan for manual recovery',
    )
    expect(await readFile(legacyPristine, 'utf8')).toBe('conflicting legacy pristine\n')
    expect(await readFile(pristine, 'utf8')).toBe('new-layout pristine\n')
  })

  test('migrates a legacy .claude install, preserving local edits and its pristine base', async () => {
    const name = 'ab-plan'
    const legacyLive = join(target, '.claude', 'skills', name, 'SKILL.md')
    const legacyPristine = join(target, '.claude', 'skills', '.ab-pristine', name, 'SKILL.md')
    await mkdir(dirname(legacyLive), { recursive: true })
    await mkdir(dirname(legacyPristine), { recursive: true })
    await writeFile(legacyLive, 'locally customized legacy plan\n')
    await writeFile(join(dirname(legacyLive), 'notes.md'), 'local supporting file\n')
    await writeFile(legacyPristine, 'old pristine plan\n')

    const report = await abInit({ targetRepo: target })

    expect(report.skills.find((skill) => skill.skill === name)).toEqual({
      skill: name,
      action: 'kept',
    })
    expect(await readFile(installedSkillPath(target, name), 'utf8')).toBe(
      'locally customized legacy plan\n',
    )
    expect(await readFile(pristineSkillPath(target, name), 'utf8')).toBe('old pristine plan\n')
    const supportingFile = join(dirname(installedSkillPath(target, name)), 'notes.md')
    expect(await readFile(supportingFile, 'utf8')).toBe('local supporting file\n')
    expect((await lstat(claudeSkillPath(target, name))).isSymbolicLink()).toBe(true)
    expect(await readFile(join(claudeSkillPath(target, name), 'SKILL.md'), 'utf8')).toBe(
      'locally customized legacy plan\n',
    )
    expect(existsSync(dirname(legacyPristine))).toBe(false)
  })

  test('re-init reports every skill unchanged and config skipped', async () => {
    await abInit({ targetRepo: target })
    const report = await abInit({ targetRepo: target })
    expect(report.config).toBe('skipped')
    expect(report.skills.map((s) => s.action)).toEqual(SKILL_NAMES.map(() => 'unchanged'))
  })

  test('an existing autobuild.toml is never clobbered', async () => {
    await abInit({ targetRepo: target })
    await writeFile(join(target, 'autobuild.toml'), 'baseBranch = "trunk"\n')
    const report = await abInit({ targetRepo: target })
    expect(report.config).toBe('skipped')
    expect(await readFile(join(target, 'autobuild.toml'), 'utf8')).toBe('baseBranch = "trunk"\n')
  })

  test('an existing config skips later package inspection, including with force', async () => {
    const manifestPath = join(target, 'package.json')
    await writeFile(manifestPath, JSON.stringify({ scripts: { lint: 'eslint .' } }))
    await abInit({ targetRepo: target })
    const original = await readFile(join(target, 'autobuild.toml'), 'utf8')
    expect(parseConfig(original).commands.lint).toBe('bun run lint')

    await writeFile(
      manifestPath,
      JSON.stringify({ scripts: { 'type-check': 'tsc', test: 'vitest' } }),
    )
    expect((await abInit({ targetRepo: target, force: true })).config).toBe('skipped')
    expect(await readFile(join(target, 'autobuild.toml'), 'utf8')).toBe(original)

    await rm(manifestPath)
    await mkdir(manifestPath)
    expect((await abInit({ targetRepo: target })).config).toBe('skipped')
    expect(await readFile(join(target, 'autobuild.toml'), 'utf8')).toBe(original)
  })

  test('re-init after a local edit keeps the edit (kept) — pristine untouched', async () => {
    await abInit({ targetRepo: target })
    const live = installedSkillPath(target, 'ab-plan')
    const pristineBefore = await readFile(pristineSkillPath(target, 'ab-plan'), 'utf8')
    const edited = `${await readFile(live, 'utf8')}\nLocal repo standards here.\n`
    await writeFile(live, edited)

    const report = await abInit({ targetRepo: target })
    expect(report.skills.find((s) => s.skill === 'ab-plan')).toEqual({
      skill: 'ab-plan',
      action: 'kept',
    })
    expect(await readFile(live, 'utf8')).toBe(edited)
    expect(await readFile(pristineSkillPath(target, 'ab-plan'), 'utf8')).toBe(pristineBefore)
  })

  test('a missing SKILL.md never lets re-init clobber a customized distributed sibling', async () => {
    await abInit({ targetRepo: target })
    const root = installedSkillPath(target, 'ab-guide')
    const relative = 'references/plugin-authoring.md'
    const live = installedSkillFilePath(target, 'ab-guide', relative)
    const pristine = pristineSkillFilePath(target, 'ab-guide', relative)
    const pristineBefore = await readFile(pristine, 'utf8')
    await rm(root)
    await writeFile(live, 'local authoring rules survive partial cleanup\n')

    const report = await abInit({ targetRepo: target })

    expect(report.skills.find((entry) => entry.skill === 'ab-guide')?.action).toBe('kept')
    expect(existsSync(root)).toBe(true)
    expect(await readFile(live, 'utf8')).toBe('local authoring rules survive partial cleanup\n')
    expect(await readFile(pristine, 'utf8')).toBe(pristineBefore)
  })

  test('re-init independently preserves or force-overwrites distributed support files and leaves local extras alone', async () => {
    await abInit({ targetRepo: target })
    const relative = 'references/plugin-authoring.md'
    const live = installedSkillFilePath(target, 'ab-guide', relative)
    const pristine = pristineSkillFilePath(target, 'ab-guide', relative)
    const original = await readFile(live, 'utf8')
    const extra = installedSkillFilePath(target, 'ab-guide', 'references/local.md')
    await writeFile(live, 'local authoring rules\n')
    await writeFile(extra, 'repo-only reference\n')

    const kept = await abInit({ targetRepo: target })
    expect(kept.skills.find((entry) => entry.skill === 'ab-guide')?.action).toBe('kept')
    expect(await readFile(live, 'utf8')).toBe('local authoring rules\n')
    expect(await readFile(pristine, 'utf8')).toBe(original)
    expect(await readFile(extra, 'utf8')).toBe('repo-only reference\n')

    const forced = await abInit({ targetRepo: target, force: true })
    expect(forced.skills.find((entry) => entry.skill === 'ab-guide')?.action).toBe('overwritten')
    expect(await readFile(live, 'utf8')).toBe(original)
    expect(await readFile(pristine, 'utf8')).toBe(original)
    expect(await readFile(extra, 'utf8')).toBe('repo-only reference\n')
  })

  test('force: true overwrites the edited skill AND its pristine record', async () => {
    await abInit({ targetRepo: target })
    const live = installedSkillPath(target, 'ab-plan')
    const original = await readFile(live, 'utf8')
    await writeFile(live, 'totally rewritten\n')

    const report = await abInit({ targetRepo: target, force: true })
    expect(report.skills.find((s) => s.skill === 'ab-plan')).toEqual({
      skill: 'ab-plan',
      action: 'overwritten',
    })
    // Unedited skills are unchanged even under force.
    expect(report.skills.find((s) => s.skill === 'ab-implement')).toEqual({
      skill: 'ab-implement',
      action: 'unchanged',
    })
    expect(await readFile(live, 'utf8')).toBe(original)
    expect(await readFile(pristineSkillPath(target, 'ab-plan'), 'utf8')).toBe(original)
  })

  test('prints an aggregate plain summary and names only attention outcomes', async () => {
    const lines: string[] = []
    await abInit({ targetRepo: target, stdout: (line) => lines.push(line) })
    expect(lines).toEqual([
      'autobuild.toml: written',
      `Skills: ${SKILL_NAMES.length} installed, 0 unchanged, 0 kept, 0 overwritten`,
      '',
      'Next steps:',
      '  - Ask your coding agent to change autobuild.toml.',
    ])

    await writeFile(installedSkillPath(target, 'ab-plan'), 'local plan\n')
    lines.length = 0
    await abInit({ targetRepo: target, stdout: (line) => lines.push(line) })
    expect(lines[0]).toBe('autobuild.toml: skipped')
    expect(lines[1]).toBe(
      `Skills: 0 installed, ${SKILL_NAMES.length - 1} unchanged, 1 kept, 0 overwritten`,
    )
    expect(lines).toContain('ab-plan: kept')
    expect(lines.join('\n')).not.toContain('ab-implement: unchanged')

    lines.length = 0
    await abInit({ targetRepo: target, force: true, stdout: (line) => lines.push(line) })
    expect(lines).toContain('ab-plan: overwritten')
    expect(lines.join('\n')).not.toContain('ab-implement: unchanged')
  })
})

describe('rewriteSkillSource', () => {
  test('rejects a skill without frontmatter', () => {
    expect(() => rewriteSkillSource('# no frontmatter\n', 'plan')).toThrow(/frontmatter/)
  })

  test('preserves unknown frontmatter keys and replaces an existing disable flag', () => {
    const out = rewriteSkillSource(
      '---\nname: x\ncustom: keep-me\ndisable-model-invocation: false\n---\nbody\n',
      'x',
    )
    const { front, body } = splitFrontmatter(out)
    expect(front).toEqual(['name: ab-x', 'custom: keep-me', 'disable-model-invocation: true'])
    expect(body).toBe('body\n')
  })
})

describe('runCli routing — init/upgrade run outside build sessions (§16.3)', () => {
  function sessionless(): SessionlessCliDeps & { out: string[]; err: string[] } {
    const out: string[] = []
    const err: string[] = []
    return {
      workspacePath: target,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      initRuntimes: TEST_INIT_RUNTIMES,
      processEnv: {},
      out,
      err,
    }
  }

  test('ab init works with NO store/env deps, defaulting the target to the cwd', async () => {
    const d = sessionless()
    expect(await runCli(['init'], d)).toBe(0)
    expect(existsSync(join(target, 'autobuild.toml'))).toBe(true)
    expect(existsSync(installedSkillPath(target, 'ab-plan'))).toBe(true)
    expect(d.out).toContain(
      `Skills: ${SKILL_NAMES.length} installed, 0 unchanged, 0 kept, 0 overwritten`,
    )
  })

  test('ab init takes an explicit target and --force only overwrites edited skills', async () => {
    const explicit = await mkdtemp(join(tmpdir(), 'ab-init-cli-'))
    try {
      const d = sessionless()
      expect(await runCli(['init', explicit], d)).toBe(0)
      const skillPath = installedSkillPath(explicit, 'ab-plan')
      const defaultSkill = await readFile(skillPath, 'utf8')
      const configPath = join(explicit, 'autobuild.toml')
      const existingConfig = 'baseBranch = "trunk"\n'
      await writeFile(skillPath, 'edited\n')
      await writeFile(configPath, existingConfig)
      d.out.length = 0

      expect(await runCli(['init', explicit, '--force'], d)).toBe(0)

      expect(d.out).toContain('autobuild.toml: skipped')
      expect(d.out).toContain('ab-plan: overwritten')
      expect(await readFile(skillPath, 'utf8')).toBe(defaultSkill)
      expect(await readFile(configPath, 'utf8')).toBe(existingConfig)
    } finally {
      await rm(explicit, { recursive: true, force: true })
    }
  })

  test('ab init routes adapter flags and a fully specified run never prompts', async () => {
    const d = sessionless()
    const prompter = new ScriptedInitPrompter()
    d.initPrompter = prompter
    expect(
      await runCli(
        [
          'init',
          '--ticket-source',
          'linear',
          '--workspace-provider',
          'git-worktree',
          '--role-profile',
          'split',
        ],
        d,
      ),
    ).toBe(0)
    expect(prompter.questions).toHaveLength(0)
    const config = parseConfig(await readFile(join(target, 'autobuild.toml'), 'utf8'))
    expect(config.tickets.source).toBe('linear')
    expect(config.roles.plan?.model).toBe(INIT_SPLIT_AUTHOR_MODEL)
    expect(config.roles['plan-review']?.model).toBe(INIT_SPLIT_REVIEWER_MODEL)
  })

  test('ab init cancellation exits 1 with a plain message and no partial install', async () => {
    const d = sessionless()
    d.initPrompter = {
      async select(): Promise<never> {
        throw new InitCancelledError()
      },
    }

    expect(await runCli(['init'], d)).toBe(1)
    expect(d.out).toEqual([])
    expect(d.err).toEqual(['Init cancelled.'])
    expect(existsSync(join(target, 'autobuild.toml'))).toBe(false)
    expect(existsSync(join(target, '.agents'))).toBe(false)
  })

  test('ab init rejects unknown flags with usage feedback', async () => {
    const d = sessionless()
    expect(await runCli(['init', '--frobnicate'], d)).toBe(1)
    expect(d.err.join('\n')).toContain('usage: ab init [target] [--force]')
  })

  test('detailed help distinguishes first-time config creation from forced skill replacement', async () => {
    const d = sessionless()
    expect(await runCli(['init', '--help'], d)).toBe(0)
    expect(await runCli(['help', 'upgrade'], d)).toBe(0)
    const help = d.out.join('\n')
    expect(help).toContain('ab init [target] [--force]')
    expect(help).toContain('Create autobuild.toml only when absent')
    expect(help).toContain('vendor the default ab-* skills')
    expect(help).toContain('--force overwrites edited vendored skills only')
    expect(help).toContain('never overwrites an existing autobuild.toml')
    expect(help).toContain('ab upgrade [target]')
  })

  test('session commands without session deps fail with agent feedback, not a crash', async () => {
    const d = sessionless()
    expect(await runCli(['context'], d)).toBe(1)
    expect(d.err.join('\n')).toContain("'ab context' runs inside a build session")
  })

  test('bin/ab.ts init works in a subprocess with NO AB_* env set', async () => {
    await writeFile(
      join(target, 'package.json'),
      JSON.stringify({ scripts: { test: 'custom-test-runner' } }),
    )
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith('AB_')) env[key] = value
    }
    const proc = Bun.spawn(['bun', join(DIST_ROOT, 'bin', 'ab.ts'), 'init', target], {
      cwd: DIST_ROOT,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('autobuild.toml: written')
    expect(stdout).toContain(`Skills: ${SKILL_NAMES.length} installed`)
    expect(stdout).not.toContain('ab-spec: installed')
    expect(stdout).not.toMatch(/\u001b\[/)
    expect(stdout).not.toMatch(/[┌┐└┘─│◆◇●○]/)
    expect(existsSync(installedSkillPath(target, 'ab-spec'))).toBe(true)
    const config = parseConfig(await readFile(join(target, 'autobuild.toml'), 'utf8'))
    expect(config.commands.test).toBe('bun run test')
    expect(config.verify.steps).toEqual(['test'])
    expect(config.verify.stepConfigs.test).toEqual({
      kind: 'check',
      command: 'test',
      always: true,
    })
  })
})
