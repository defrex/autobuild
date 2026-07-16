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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  abInit,
  defaultDistRoot,
  installedSkillPath,
  pristineSkillPath,
  rewriteSkillSource,
} from './init'
import { runCli, type SessionlessCliDeps } from './main'

const DIST_ROOT = resolve(import.meta.dir, '..', '..')

/** The 8 canonical skills shipped in the distribution (§16.3). */
const SKILL_NAMES = [
  'code-review',
  'finalize',
  'implement',
  'plan',
  'plan-review',
  'reconcile',
  'spec',
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

describe('abInit — fresh install', () => {
  test('installs all 8 skills namespaced ab-*, with pristine copies byte-identical', async () => {
    const report = await abInit({ targetRepo: target })

    expect(report.config).toBe('written')
    expect(report.skills).toEqual(
      SKILL_NAMES.map((name) => ({ skill: `ab-${name}`, action: 'installed' })),
    )
    for (const name of SKILL_NAMES) {
      const installed = await readFile(installedSkillPath(target, `ab-${name}`), 'utf8')
      const pristine = await readFile(pristineSkillPath(target, `ab-${name}`), 'utf8')
      expect(pristine).toBe(installed)
    }
  })

  test('frontmatter: name rewritten; disable-model-invocation everywhere EXCEPT ab-spec', async () => {
    await abInit({ targetRepo: target })
    for (const name of SKILL_NAMES) {
      const installed = await readFile(installedSkillPath(target, `ab-${name}`), 'utf8')
      const { front } = splitFrontmatter(installed)
      expect(front).toContain(`name: ab-${name}`)
      if (name === 'spec') {
        // The one model-invocable skill: a human conversation surface (§16.3).
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

  test('autobuild.toml is written from the template', async () => {
    await abInit({ targetRepo: target })
    const template = await readFile(join(DIST_ROOT, 'templates', 'autobuild.toml'), 'utf8')
    expect(await readFile(join(target, 'autobuild.toml'), 'utf8')).toBe(template)
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

describe('abInit — idempotence and safety', () => {
  test('re-init reports every skill unchanged and config skipped', async () => {
    await abInit({ targetRepo: target })
    const report = await abInit({ targetRepo: target })
    expect(report.config).toBe('skipped')
    expect(report.skills.map((s) => s.action)).toEqual(SKILL_NAMES.map(() => 'unchanged'))
  })

  test('an existing autobuild.toml is never clobbered', async () => {
    await abInit({ targetRepo: target })
    await writeFile(join(target, 'autobuild.toml'), '[project]\nbaseBranch = "trunk"\n')
    const report = await abInit({ targetRepo: target })
    expect(report.config).toBe('skipped')
    expect(await readFile(join(target, 'autobuild.toml'), 'utf8')).toBe(
      '[project]\nbaseBranch = "trunk"\n',
    )
  })

  test('re-init after a local edit keeps the edit (kept) — pristine untouched', async () => {
    await abInit({ targetRepo: target })
    const live = installedSkillPath(target, 'ab-plan')
    const pristineBefore = await readFile(pristineSkillPath(target, 'ab-plan'), 'utf8')
    const edited = (await readFile(live, 'utf8')) + '\nLocal repo standards here.\n'
    await writeFile(live, edited)

    const report = await abInit({ targetRepo: target })
    expect(report.skills.find((s) => s.skill === 'ab-plan')).toEqual({
      skill: 'ab-plan',
      action: 'kept',
    })
    expect(await readFile(live, 'utf8')).toBe(edited)
    expect(await readFile(pristineSkillPath(target, 'ab-plan'), 'utf8')).toBe(pristineBefore)
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

  test('prints a human-readable line for the config and each skill', async () => {
    const lines: string[] = []
    await abInit({ targetRepo: target, stdout: (line) => lines.push(line) })
    expect(lines[0]).toBe('autobuild.toml: written')
    expect(lines).toContain('ab-plan: installed')
    expect(lines).toHaveLength(1 + SKILL_NAMES.length)
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
      out,
      err,
    }
  }

  test('ab init works with NO store/env deps, defaulting the target to the cwd', async () => {
    const d = sessionless()
    expect(await runCli(['init'], d)).toBe(0)
    expect(existsSync(join(target, 'autobuild.toml'))).toBe(true)
    expect(existsSync(installedSkillPath(target, 'ab-plan'))).toBe(true)
    expect(d.out).toContain('ab-plan: installed')
  })

  test('ab init takes an explicit target and --force', async () => {
    const explicit = await mkdtemp(join(tmpdir(), 'ab-init-cli-'))
    try {
      const d = sessionless()
      expect(await runCli(['init', explicit], d)).toBe(0)
      await writeFile(installedSkillPath(explicit, 'ab-plan'), 'edited\n')
      expect(await runCli(['init', explicit, '--force'], d)).toBe(0)
      expect(d.out).toContain('ab-plan: overwritten')
    } finally {
      await rm(explicit, { recursive: true, force: true })
    }
  })

  test('ab init rejects unknown flags with usage feedback', async () => {
    const d = sessionless()
    expect(await runCli(['init', '--frobnicate'], d)).toBe(1)
    expect(d.err.join('\n')).toContain('usage: ab init [target] [--force]')
  })

  test('help works without session deps', async () => {
    const d = sessionless()
    expect(await runCli(['--help'], d)).toBe(0)
    expect(d.out.join('\n')).toContain('ab init [target] [--force]')
    expect(d.out.join('\n')).toContain('ab upgrade [target]')
  })

  test('session commands without session deps fail with agent feedback, not a crash', async () => {
    const d = sessionless()
    expect(await runCli(['context'], d)).toBe(1)
    expect(d.err.join('\n')).toContain("'ab context' runs inside a build session")
  })

  test('bin/ab.ts init works in a subprocess with NO AB_* env set', async () => {
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
    expect(existsSync(installedSkillPath(target, 'ab-spec'))).toBe(true)
  })
})
