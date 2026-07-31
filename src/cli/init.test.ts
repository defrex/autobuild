import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseConfig } from '../config/load'
import { createProductionRuntimes } from '../ports/runner/production'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import {
  abInit,
  claudeSkillPath,
  defaultDistRoot,
  installedSkillFilePath,
  installedSkillPath,
  MODEL_INVOCABLE_SKILLS,
  pristineSkillFilePath,
  readDistSkills,
} from './init'
import type { SetupAgentInvocation } from './init-agent'
import { runCli, type SessionlessCliDeps } from './main'

const production = createProductionRuntimes().runtimes
const TEST_RUNTIMES: RuntimeRegistry = Object.fromEntries(
  Object.entries(production).map(([name, registration]) => [
    name,
    { ...registration, initUsable: async () => ({ usable: true, reason: `${name} ready` }) },
  ]),
)

let target: string

beforeEach(async () => {
  target = await mkdtemp(join(tmpdir(), 'ab-init-agent-'))
})

afterEach(async () => {
  await rm(target, { recursive: true, force: true })
})

async function init(opts: Omit<Parameters<typeof abInit>[0], 'targetRepo' | 'runtimes'> = {}) {
  return abInit({ targetRepo: target, runtimes: TEST_RUNTIMES, env: {}, ...opts })
}

describe('agent-driven ab init', () => {
  test('vendors every skill with pristine bytes and Claude discovery links', async () => {
    const report = await init()
    expect(report.config).toBe('written')
    expect(report.exitCode).toBe(0)
    expect(report.skills).toHaveLength(11)
    expect(report.skills.map((entry) => entry.skill)).not.toContain('ab-setup')
    expect(report.skills.map((entry) => entry.skill)).not.toContain('ab-verify-e2e')
    expect([...MODEL_INVOCABLE_SKILLS].sort()).toEqual(['guide', 'spec', 'tickets'])

    const distributed = await readDistSkills(defaultDistRoot())
    expect(report.skills.map((entry) => entry.skill)).toEqual(
      distributed.map((skill) => skill.installName),
    )
    for (const skill of distributed) {
      for (const file of skill.files) {
        const live = await readFile(
          installedSkillFilePath(target, skill.installName, file.path),
          'utf8',
        )
        expect(live).toBe(file.content)
        expect(
          await readFile(pristineSkillFilePath(target, skill.installName, file.path), 'utf8'),
        ).toBe(file.content)
      }
      expect((await lstat(claudeSkillPath(target, skill.installName))).isSymbolicLink()).toBe(true)
      expect(await readlink(claudeSkillPath(target, skill.installName))).toBe(
        `../../.agents/skills/${skill.installName}`,
      )
      const frontmatter = skill.content.slice(0, skill.content.indexOf('\n---', 4))
      expect(frontmatter.includes('disable-model-invocation: true')).toBe(
        !MODEL_INVOCABLE_SKILLS.has(skill.name),
      )
    }
    const setupReference = 'references/setup.md'
    const liveReference = await readFile(
      installedSkillFilePath(target, 'ab-guide', setupReference),
      'utf8',
    )
    expect(liveReference).toContain('author a repository-owned\n   agent-verify skill')
    expect(await readFile(pristineSkillFilePath(target, 'ab-guide', setupReference), 'utf8')).toBe(
      liveReference,
    )
    expect(await readFile(join(target, '.gitignore'), 'utf8')).toBe('.autobuild/\n')
  })

  test.each(['claude-to-agents', 'agents-to-claude'] as const)(
    'vendors every skill when the skill roots are aliased: %s',
    async (direction) => {
      const backingRoot = join(
        target,
        ...(direction === 'claude-to-agents' ? ['.agents', 'skills'] : ['.claude', 'skills']),
      )
      if (direction === 'claude-to-agents') {
        await mkdir(join(target, '.claude'), { recursive: true })
        await symlink('../.agents/skills', join(target, '.claude', 'skills'), 'dir')
      } else {
        await mkdir(join(target, '.agents'), { recursive: true })
        await symlink('../.claude/skills', join(target, '.agents', 'skills'), 'dir')
      }
      expect(existsSync(backingRoot)).toBe(false)

      const report = await init()

      expect(report.exitCode).toBe(0)
      expect(report.discoveryConflicts).toEqual([])
      expect(report.skills.length).toBeGreaterThan(1)
      expect(report.skills.every((entry) => entry.action === 'installed')).toBe(true)
      for (const { skill } of report.skills) {
        expect(await readFile(installedSkillPath(target, skill), 'utf8')).toBe(
          await readFile(join(target, '.claude', 'skills', skill, 'SKILL.md'), 'utf8'),
        )
        expect((await lstat(claudeSkillPath(target, skill))).isSymbolicLink()).toBe(false)
        expect(existsSync(join(target, '.agents', 'skills', skill, skill))).toBe(false)
      }
    },
  )

  test('contains a distinct Claude directory conflict and skips setup after processing skills', async () => {
    const skill = 'ab-code-review'
    const canonical = installedSkillPath(target, skill)
    const claude = join(target, '.claude', 'skills', skill, 'SKILL.md')
    await mkdir(dirname(canonical), { recursive: true })
    await mkdir(dirname(claude), { recursive: true })
    await writeFile(canonical, '---\nname: ab-code-review\n---\ncanonical local copy\n')
    await writeFile(claude, '---\nname: ab-code-review\n---\ndistinct Claude copy\n')
    const lines: string[] = []
    let launches = 0

    const report = await init({
      interactive: true,
      stdout: (line) => lines.push(line),
      launcher: async () => {
        launches += 1
        return 0
      },
    })

    expect(report.exitCode).toBe(1)
    expect(report.discoveryConflicts).toHaveLength(1)
    expect(report.discoveryConflicts[0]?.skill).toBe(skill)
    expect(report.skills).toHaveLength(11)
    expect(existsSync(installedSkillPath(target, 'ab-verify-e2e'))).toBe(false)
    expect(launches).toBe(0)
    const output = lines.join('\n')
    expect(output).toContain(`.claude/skills/${skill}`)
    expect(output).toContain(`.agents/skills/${skill}`)
    expect(output).toContain('move or remove')
    expect(output).not.toContain('Starting setup agent')
  })

  test('writes a valid stack-neutral skeleton independent of manifests', async () => {
    const cargo = join(target, 'cargo')
    const node = join(target, 'node')
    await mkdir(cargo)
    await mkdir(node)
    await writeFile(join(cargo, 'Cargo.toml'), '[package]\nname = "fixture"\n')
    await writeFile(join(node, 'package.json'), '{ definitely invalid json')

    await abInit({ targetRepo: cargo, runtimes: TEST_RUNTIMES, env: {} })
    await abInit({ targetRepo: node, runtimes: TEST_RUNTIMES, env: {} })
    const cargoSource = await readFile(join(cargo, 'autobuild.toml'), 'utf8')
    const nodeSource = await readFile(join(node, 'autobuild.toml'), 'utf8')
    expect(nodeSource).toBe(cargoSource)

    const config = parseConfig(cargoSource)
    expect(config.commands).toEqual({})
    expect(config.verify).toEqual({ steps: [], stepConfigs: {} })
    expect(config.finalize).toEqual({ steps: [], stepConfigs: {} })
    expect(config.roles.default).toEqual({ runtime: 'claude' })
    expect(config.policy.maxReviewRounds).toBe(6)
    expect(cargoSource).not.toContain('bun install')
  })

  test('reports every probe and still installs when none is usable', async () => {
    const lines: string[] = []
    const runtimes: RuntimeRegistry = {
      claude: { ...production.claude!, initUsable: async () => false },
      codex: {
        ...production.codex!,
        initUsable: async () => {
          throw new Error('codex missing')
        },
      },
      pi: {
        ...production.pi!,
        initUsable: async () => ({ usable: false, reason: 'provider logged out' }),
      },
    }
    const report = await abInit({
      targetRepo: target,
      runtimes,
      env: {},
      stdout: (line) => lines.push(line),
      interactive: true,
    })
    expect(report.exitCode).toBe(0)
    expect(existsSync(join(target, 'autobuild.toml'))).toBe(true)
    expect(lines).toContain('  claude: unusable — runtime reported unavailable')
    expect(lines).toContain('  codex: unusable — probe failed: codex missing')
    expect(lines).toContain('  pi: unusable — provider logged out')
    expect(lines.join('\n')).toContain('No usable interactive runtime was detected')
  })

  test('launches the fixed-preference runtime with the same prompt as fallback and propagates exit', async () => {
    const fallback: string[] = []
    await init({ stdout: (line) => fallback.push(line) })
    const fallbackPrompt = fallback.at(-1)!

    await rm(target, { recursive: true, force: true })
    await mkdir(target)
    let invocation: SetupAgentInvocation | undefined
    const report = await init({
      interactive: true,
      env: { AB_BUILD: 'leak', HOME: '/home/test' },
      launcher: async (input) => {
        invocation = input
        return 23
      },
    })
    expect(report.exitCode).toBe(23)
    expect(invocation?.runtime).toBe('claude')
    expect(invocation?.cwd).toBe(target)
    expect(invocation?.prompt).toBe(fallbackPrompt)
    expect(invocation?.prompt).toContain('.agents/skills/ab-guide/references/setup.md')
    expect(invocation?.prompt).not.toContain('do **not** constrain the final arrangement')
    expect(invocation?.prompt).not.toContain('one groomed,\n   dispatchable ticket')
  })

  test('a partial distribution without the setup reference still installs and prints the pointer', async () => {
    const partial = await mkdtemp(join(tmpdir(), 'ab-init-partial-'))
    try {
      await cp(join(defaultDistRoot(), 'skills'), join(partial, 'skills'), { recursive: true })
      await cp(join(defaultDistRoot(), 'templates'), join(partial, 'templates'), {
        recursive: true,
      })
      await rm(join(partial, 'skills', 'guide', 'references', 'setup.md'))
      const lines: string[] = []

      const report = await init({ distRoot: partial, stdout: (line) => lines.push(line) })

      expect(report.exitCode).toBe(0)
      expect(existsSync(installedSkillFilePath(target, 'ab-guide', 'references/setup.md'))).toBe(
        false,
      )
      expect(lines.at(-1)).toContain('.agents/skills/ab-guide/references/setup.md')
    } finally {
      await rm(partial, { recursive: true, force: true })
    }
  })

  test('rerun preserves config and uses the review prompt', async () => {
    await init()
    const custom = 'baseBranch = "trunk"\n'
    await writeFile(join(target, 'autobuild.toml'), custom)
    let prompt = ''
    const report = await init({
      interactive: true,
      launcher: async (invocation) => {
        prompt = invocation.prompt
        return 0
      },
    })
    expect(report.config).toBe('skipped')
    expect(await readFile(join(target, 'autobuild.toml'), 'utf8')).toBe(custom)
    expect(prompt).toStartWith('Review and improve the existing autobuild.toml.')
  })

  test('rerun preserves local guide-reference edits unless force is explicit', async () => {
    await init()
    const file = 'references/setup.md'
    const path = installedSkillFilePath(target, 'ab-guide', file)
    const pristine = await readFile(pristineSkillFilePath(target, 'ab-guide', file), 'utf8')
    await writeFile(path, `${pristine}\nlocal setup rule\n`)
    expect((await init()).skills.find((entry) => entry.skill === 'ab-guide')?.action).toBe('kept')
    expect(await readFile(path, 'utf8')).toContain('local setup rule')
    expect(
      (await init({ force: true })).skills.find((entry) => entry.skill === 'ab-guide')?.action,
    ).toBe('overwritten')
    expect(await readFile(path, 'utf8')).toBe(pristine)
  })

  test('appends the local state ignore rule without rewriting existing bytes', async () => {
    await writeFile(join(target, '.gitignore'), 'dist/\n.env')
    await init()
    await init()
    expect(await readFile(join(target, '.gitignore'), 'utf8')).toBe('dist/\n.env\n.autobuild/\n')
  })
})

describe('init CLI', () => {
  function deps(): SessionlessCliDeps & { out: string[]; err: string[] } {
    const out: string[] = []
    const err: string[] = []
    return {
      workspacePath: target,
      processEnv: {},
      initRuntimes: TEST_RUNTIMES,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      out,
      err,
    }
  }

  test('runs sessionless and propagates setup child status', async () => {
    const d = deps()
    d.initInteractive = true
    d.initLauncher = async () => 17
    expect(await runCli(['init'], d)).toBe(17)
    expect(existsSync(join(target, 'autobuild.toml'))).toBe(true)
  })

  test.each([
    '--forge',
    '--ticket-source',
    '--workspace-provider',
    '--role-profile',
    '--no-interactive',
  ])('rejects removed flag %s with agent-driven guidance', async (flag) => {
    const d = deps()
    expect(await runCli(['init', flag], d)).toBe(1)
    expect(d.err.join('\n')).toContain(`${flag} was removed`)
    expect(d.err.join('\n')).toContain('hands setup to a coding agent')
  })

  test('help lists only the real init flag', async () => {
    const d = deps()
    expect(await runCli(['help', 'init'], d)).toBe(0)
    const help = d.out.join('\n')
    expect(help).toContain('ab init [target] [--force]')
    expect(help).toContain('stack-neutral')
    expect(help).not.toContain('--role-profile')
  })
})
