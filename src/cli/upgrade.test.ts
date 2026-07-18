/**
 * `ab upgrade` tests (SPEC §16.3, D11): the classic vendoring problem —
 * three-way merge of pristine (base) × local edits (ours) × new default
 * (theirs), with the agent resolveConflict seam and the human escalation
 * path (conflicted, markers in the report, live file untouched).
 *
 * All merge cases run against FAKE distRoot fixtures built in temp dirs
 * (small controlled SKILL.md files), never the real skills/ content — the
 * real distribution only anchors init.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  abInit,
  installedSkillPath,
  pristineSkillPath,
  rewriteSkillSource,
} from './init'
import { runCli } from './main'
import { abUpgrade } from './upgrade'

const BODY = [
  '# alpha',
  '',
  'intro line one',
  'intro line two',
  'intro line three',
  'middle line one',
  'middle line two',
  'middle line three',
  'closing line one',
  'closing line two',
  'closing line three',
  '',
].join('\n')

let root: string
let target: string
let distV1: string
let distV2: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ab-upgrade-test-'))
  target = join(root, 'repo')
  distV1 = join(root, 'dist-v1')
  distV2 = join(root, 'dist-v2')
  await mkdir(target, { recursive: true })
  await writeDist(distV1, { alpha: BODY })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function skillSource(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${name} skill.\n---\n\n${body}`
}

/** Build a fake distribution root: skills/<name>/SKILL.md + a renderable template. */
async function writeDist(dist: string, skills: Record<string, string>): Promise<void> {
  await mkdir(join(dist, 'templates'), { recursive: true })
  await writeFile(
    join(dist, 'templates', 'autobuild.toml'),
    [
      '[project]',
      'baseBranch = "main"',
      '[commands]',
      '# @ab-init/package-script-commands',
      '[verify]',
      'steps = [',
      '# @ab-init/package-script-verify-steps',
      ']',
      '# @ab-init/package-script-verify-tables',
      '',
    ].join('\n'),
  )
  for (const [name, body] of Object.entries(skills)) {
    await mkdir(join(dist, 'skills', name), { recursive: true })
    await writeFile(join(dist, 'skills', name, 'SKILL.md'), skillSource(name, body))
  }
}

/** What init installs for a fixture skill — the rewritten frontmatter form. */
function installedForm(name: string, body: string): string {
  return rewriteSkillSource(skillSource(name, body), name)
}

async function install(): Promise<void> {
  await abInit({ targetRepo: target, distRoot: distV1 })
}

describe('abUpgrade — legacy project path migration', () => {
  test('moves the complete .agent tree before upgrading and repairs Claude links', async () => {
    const local = installedForm('alpha', BODY.replace('intro line one', 'intro line one (local)'))
    const pristine = installedForm('alpha', BODY)
    const oldRoot = join(target, '.agent', 'skills')
    const oldLive = join(oldRoot, 'ab-alpha', 'SKILL.md')
    const oldPristine = join(oldRoot, '.ab-pristine', 'ab-alpha', 'SKILL.md')
    const oldCustom = join(oldRoot, 'ab-custom', 'SKILL.md')
    await mkdir(dirname(oldLive), { recursive: true })
    await mkdir(dirname(oldPristine), { recursive: true })
    await mkdir(dirname(oldCustom), { recursive: true })
    await writeFile(oldLive, local)
    await writeFile(join(dirname(oldLive), 'notes.md'), 'supporting file\n')
    await writeFile(oldPristine, pristine)
    await writeFile(oldCustom, '---\nname: ab-custom\n---\nlocal addition\n')

    const claudeRoot = join(target, '.claude', 'skills')
    await mkdir(claudeRoot, { recursive: true })
    await symlink('../../.agent/skills/ab-alpha', join(claudeRoot, 'ab-alpha'), 'dir')
    await symlink('../../.agent/skills/ab-custom', join(claudeRoot, 'ab-custom'), 'dir')
    await writeDist(distV2, { alpha: BODY })

    const report = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    expect(report.skills).toEqual([
      { skill: 'ab-alpha', action: 'current' },
      {
        skill: 'ab-custom',
        action: 'unknown',
        detail: 'not in the distribution — left alone (local addition)',
      },
    ])
    expect(await readFile(installedSkillPath(target, 'ab-alpha'), 'utf8')).toBe(local)
    expect(await readFile(pristineSkillPath(target, 'ab-alpha'), 'utf8')).toBe(pristine)
    expect(
      await readFile(join(dirname(installedSkillPath(target, 'ab-alpha')), 'notes.md'), 'utf8'),
    ).toBe('supporting file\n')
    expect(await readFile(installedSkillPath(target, 'ab-custom'), 'utf8')).toContain(
      'local addition',
    )
    expect(existsSync(join(target, '.agent'))).toBe(false)
    expect(await readlink(join(claudeRoot, 'ab-alpha'))).toBe(
      '../../.agents/skills/ab-alpha',
    )
    expect(await readlink(join(claudeRoot, 'ab-custom'))).toBe(
      '../../.agents/skills/ab-custom',
    )
  })
})

describe('abUpgrade — the four pristine-based cases', () => {
  test('new default == pristine → local stands (current), even when edited', async () => {
    await install()
    const live = installedSkillPath(target, 'ab-alpha')
    const edited = BODY.replace('intro line one', 'intro line one (local)')
    await writeFile(live, installedForm('alpha', edited))
    const pristineBefore = await readFile(pristineSkillPath(target, 'ab-alpha'), 'utf8')

    // v2 ships the SAME alpha content as v1.
    await writeDist(distV2, { alpha: BODY })
    const report = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    expect(report.skills).toEqual([{ skill: 'ab-alpha', action: 'current' }])
    expect(await readFile(live, 'utf8')).toBe(installedForm('alpha', edited))
    expect(await readFile(pristineSkillPath(target, 'ab-alpha'), 'utf8')).toBe(pristineBefore)
  })

  test('local == pristine (no edits) → new default adopted wholesale, pristine advanced', async () => {
    await install()
    const upstream = BODY.replace('closing line three', 'closing line three (upstream)')
    await writeDist(distV2, { alpha: upstream })

    const report = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    expect(report.skills).toEqual([{ skill: 'ab-alpha', action: 'adopted' }])
    const expected = installedForm('alpha', upstream)
    expect(await readFile(installedSkillPath(target, 'ab-alpha'), 'utf8')).toBe(expected)
    expect(await readFile(pristineSkillPath(target, 'ab-alpha'), 'utf8')).toBe(expected)
  })

  test('both diverged in different regions → clean merge keeps both; pristine becomes the new default', async () => {
    await install()
    const live = installedSkillPath(target, 'ab-alpha')
    const localBody = BODY.replace('intro line one', 'intro line one (local)')
    await writeFile(live, installedForm('alpha', localBody))
    const upstreamBody = BODY.replace('closing line three', 'closing line three (upstream)')
    await writeDist(distV2, { alpha: upstreamBody })

    const report = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    expect(report.skills).toEqual([{ skill: 'ab-alpha', action: 'merged' }])
    const merged = await readFile(live, 'utf8')
    expect(merged).toContain('intro line one (local)')
    expect(merged).toContain('closing line three (upstream)')
    expect(merged).not.toContain('<<<<<<<')
    expect(await readFile(pristineSkillPath(target, 'ab-alpha'), 'utf8')).toBe(
      installedForm('alpha', upstreamBody),
    )
  })

  test('both changed the same region → resolver gets exact base/local/incoming; its output is written', async () => {
    await install()
    const live = installedSkillPath(target, 'ab-alpha')
    const localText = installedForm('alpha', BODY.replace('middle line two', 'middle line two (local)'))
    await writeFile(live, localText)
    const upstreamBody = BODY.replace('middle line two', 'middle line two (upstream)')
    await writeDist(distV2, { alpha: upstreamBody })
    const pristineBefore = await readFile(pristineSkillPath(target, 'ab-alpha'), 'utf8')

    const calls: Array<{ skill: string; base: string; local: string; incoming: string }> = []
    const report = await abUpgrade({
      targetRepo: target,
      distRoot: distV2,
      resolveConflict: async (input) => {
        calls.push(input)
        return 'resolved by the agent\n'
      },
    })

    expect(report.skills).toEqual([{ skill: 'ab-alpha', action: 'resolved' }])
    expect(calls).toEqual([
      {
        skill: 'ab-alpha',
        base: pristineBefore,
        local: localText,
        incoming: installedForm('alpha', upstreamBody),
      },
    ])
    expect(await readFile(live, 'utf8')).toBe('resolved by the agent\n')
    expect(await readFile(pristineSkillPath(target, 'ab-alpha'), 'utf8')).toBe(
      installedForm('alpha', upstreamBody),
    )
  })

  test('resolver null → local file byte-untouched, conflicted report carries the markers', async () => {
    await install()
    const live = installedSkillPath(target, 'ab-alpha')
    const localText = installedForm('alpha', BODY.replace('middle line two', 'middle line two (local)'))
    await writeFile(live, localText)
    await writeDist(distV2, { alpha: BODY.replace('middle line two', 'middle line two (upstream)') })
    const pristineBefore = await readFile(pristineSkillPath(target, 'ab-alpha'), 'utf8')

    const report = await abUpgrade({
      targetRepo: target,
      distRoot: distV2,
      resolveConflict: async () => null,
    })

    expect(report.skills).toHaveLength(1)
    const entry = report.skills[0]!
    expect(entry.skill).toBe('ab-alpha')
    expect(entry.action).toBe('conflicted')
    // The merge-markered text travels in the report — never the live file.
    expect(entry.detail).toContain('<<<<<<< local')
    expect(entry.detail).toContain('middle line two (local)')
    expect(entry.detail).toContain('middle line two (upstream)')
    expect(entry.detail).toContain('>>>>>>> upstream')
    expect(await readFile(live, 'utf8')).toBe(localText)
    expect(await readFile(pristineSkillPath(target, 'ab-alpha'), 'utf8')).toBe(pristineBefore)
  })

  test('no resolver at all behaves like a null resolver', async () => {
    await install()
    const live = installedSkillPath(target, 'ab-alpha')
    const localText = installedForm('alpha', BODY.replace('middle line two', 'middle line two (local)'))
    await writeFile(live, localText)
    await writeDist(distV2, { alpha: BODY.replace('middle line two', 'middle line two (upstream)') })

    const report = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    expect(report.skills[0]!.action).toBe('conflicted')
    expect(await readFile(live, 'utf8')).toBe(localText)
  })
})

describe('abUpgrade — missing pristine record (pre-record install)', () => {
  test('local == new default → adopted; pristine record created', async () => {
    await install()
    await rm(dirname(pristineSkillPath(target, 'ab-alpha')), { recursive: true })

    // v2 ships the same content the repo already has.
    await writeDist(distV2, { alpha: BODY })
    const report = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    expect(report.skills).toHaveLength(1)
    expect(report.skills[0]!.action).toBe('adopted')
    expect(report.skills[0]!.detail).toContain('no pristine record')
    expect(await readFile(pristineSkillPath(target, 'ab-alpha'), 'utf8')).toBe(
      installedForm('alpha', BODY),
    )
  })

  test('local != new default → conflicted, no silent clobber', async () => {
    await install()
    await rm(dirname(pristineSkillPath(target, 'ab-alpha')), { recursive: true })
    const live = installedSkillPath(target, 'ab-alpha')
    const localBefore = await readFile(live, 'utf8')

    await writeDist(distV2, { alpha: BODY.replace('intro line one', 'intro line one (upstream)') })
    const report = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    expect(report.skills).toHaveLength(1)
    expect(report.skills[0]!.action).toBe('conflicted')
    expect(report.skills[0]!.detail).toContain('no pristine record')
    expect(await readFile(live, 'utf8')).toBe(localBefore)
    expect(existsSync(pristineSkillPath(target, 'ab-alpha'))).toBe(false)
  })
})

describe('abUpgrade — distribution vs local skill sets', () => {
  test('a distribution-new skill is installed fresh, like init', async () => {
    await install()
    await writeDist(distV2, { alpha: BODY, beta: '# beta\n\nbeta body\n' })

    const report = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    expect(report.skills).toEqual([
      { skill: 'ab-alpha', action: 'current' },
      { skill: 'ab-beta', action: 'installed' },
    ])
    const installed = await readFile(installedSkillPath(target, 'ab-beta'), 'utf8')
    expect(installed).toBe(installedForm('beta', '# beta\n\nbeta body\n'))
    expect(installed).toContain('name: ab-beta')
    expect(installed).toContain('disable-model-invocation: true')
    expect(await readFile(pristineSkillPath(target, 'ab-beta'), 'utf8')).toBe(installed)
  })

  test('an installed ab-* skill absent from the distribution is untouched and reported unknown', async () => {
    await install()
    const customPath = installedSkillPath(target, 'ab-custom')
    await mkdir(dirname(customPath), { recursive: true })
    await writeFile(customPath, '---\nname: ab-custom\n---\nlocal addition\n')

    await writeDist(distV2, { alpha: BODY })
    const report = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    expect(report.skills).toEqual([
      { skill: 'ab-alpha', action: 'current' },
      {
        skill: 'ab-custom',
        action: 'unknown',
        detail: 'not in the distribution — left alone (local addition)',
      },
    ])
    expect(await readFile(customPath, 'utf8')).toBe('---\nname: ab-custom\n---\nlocal addition\n')
  })

  test('upgrade into a repo with nothing installed installs everything fresh', async () => {
    await writeDist(distV2, { alpha: BODY })
    const report = await abUpgrade({ targetRepo: target, distRoot: distV2 })
    expect(report.skills).toEqual([{ skill: 'ab-alpha', action: 'installed' }])
    expect(existsSync(pristineSkillPath(target, 'ab-alpha'))).toBe(true)
  })
})

describe('runCli routing — ab upgrade outside a session', () => {
  test('ab upgrade <target> works with no store/env deps and prints per-skill lines', async () => {
    await install()
    // The CLI cannot inject a fixture distRoot, so this runs against the
    // REAL distribution: its skills aren't installed in the fixture repo and
    // install fresh, while the fixture's ab-alpha is absent upstream and
    // reports unknown — enough to prove sessionless routing end to end.
    const out: string[] = []
    const err: string[] = []
    const code = await runCli(['upgrade', target], {
      workspacePath: target,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    })
    // The default distRoot is the REAL distribution: its skills are not
    // installed in this fixture repo, so they install fresh — proving the
    // command routes and runs without any session deps.
    expect(err).toEqual([])
    expect(code).toBe(0)
    expect(out).toContain('ab-plan: installed')
    // The fixture's own skill is not in the real distribution → unknown.
    expect(out.some((line) => line.startsWith('ab-alpha: unknown'))).toBe(true)
  })

  test('ab upgrade rejects extra arguments with usage feedback', async () => {
    const err: string[] = []
    const code = await runCli(['upgrade', target, 'extra'], {
      workspacePath: target,
      stdout: () => {},
      stderr: (line) => err.push(line),
    })
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('usage: ab upgrade [target]')
  })
})
