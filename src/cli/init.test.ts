import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfig } from '../config/load'
import { createProductionRuntimes } from '../ports/runner/production'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import {
  abInit,
  claudeSkillPath,
  installedSkillPath,
  MODEL_INVOCABLE_SKILLS,
  pristineSkillPath,
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
    expect(report.skills.some((entry) => entry.skill === 'ab-setup')).toBe(true)
    expect(MODEL_INVOCABLE_SKILLS).toContain('setup')

    for (const { skill } of report.skills) {
      const live = await readFile(installedSkillPath(target, skill), 'utf8')
      expect(await readFile(pristineSkillPath(target, skill), 'utf8')).toBe(live)
      expect((await lstat(claudeSkillPath(target, skill))).isSymbolicLink()).toBe(true)
      expect(await readlink(claudeSkillPath(target, skill))).toBe(`../../.agents/skills/${skill}`)
    }
    expect(await readFile(join(target, '.gitignore'), 'utf8')).toBe('.autobuild/\n')
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
    expect(invocation?.prompt).toContain('do **not** constrain the final arrangement')
    expect(invocation?.prompt).toContain('one groomed,\n   dispatchable ticket')
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

  test('rerun preserves local skill edits unless force is explicit', async () => {
    await init()
    const path = installedSkillPath(target, 'ab-setup')
    const pristine = await readFile(pristineSkillPath(target, 'ab-setup'), 'utf8')
    await writeFile(path, `${pristine}\nlocal setup rule\n`)
    expect((await init()).skills.find((entry) => entry.skill === 'ab-setup')?.action).toBe('kept')
    expect(await readFile(path, 'utf8')).toContain('local setup rule')
    expect(
      (await init({ force: true })).skills.find((entry) => entry.skill === 'ab-setup')?.action,
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
