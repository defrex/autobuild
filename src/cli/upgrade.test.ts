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
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  abInit,
  defaultDistRoot,
  installedSkillFilePath,
  installedSkillPath,
  pristineSkillFilePath,
  pristineSkillPath,
  readDistSkills,
  rewriteSkillSource,
} from './init'
import { parseConfig } from '../config/load'
import { runCli } from './main'
import { SELF_UPDATE_HANDOFF_ENV } from './self-update'
import { abUpgrade } from './upgrade'
import type { TerminalInput, TerminalInputEvent, TerminalOut } from './terminal'
import { createTerminalModeController } from './terminal-restore'
import { spawnExec } from '../ports/workspace/git-worktree'

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
async function writeDist(
  dist: string,
  skills: Record<string, string>,
  supportFiles: Record<string, Record<string, string>> = {},
): Promise<void> {
  await mkdir(join(dist, 'templates'), { recursive: true })
  await writeFile(
    join(dist, 'templates', 'autobuild.toml'),
    [
      'baseBranch = "main"',
      'capacity = 1',
      '# @ab-init/forge',
      '[commands]',
      '# @ab-init/package-script-commands',
      '[verify]',
      '# @ab-init/package-script-verify-steps',
      '# @ab-init/package-script-verify-tables',
      '# @ab-init/roles-start',
      '[roles.default]',
      'runtime = "claude"',
      '# @ab-init/roles-end',
      '# @ab-init/tickets-start',
      '[tickets]',
      'source = "file"',
      'readyState = "ready"',
      '# @ab-init/tickets-end',
      '',
    ].join('\n'),
  )
  for (const [name, body] of Object.entries(skills)) {
    await mkdir(join(dist, 'skills', name), { recursive: true })
    await writeFile(join(dist, 'skills', name, 'SKILL.md'), skillSource(name, body))
    for (const [path, content] of Object.entries(supportFiles[name] ?? {})) {
      const destination = join(dist, 'skills', name, ...path.split('/'))
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, content)
    }
  }
}

/** What init installs for a fixture skill — the rewritten frontmatter form. */
function installedForm(name: string, body: string): string {
  return rewriteSkillSource(skillSource(name, body), name)
}

async function install(): Promise<void> {
  await abInit({ targetRepo: target, distRoot: distV1 })
}

function replaceRequired(text: string, from: string, to: string): string {
  expect(text).toContain(from)
  return text.replace(from, to)
}

/** Seed one conflict against the real distribution for runCli-level tests. */
async function seedRealPlanConflict(repo: string): Promise<{
  base: string
  local: string
  incoming: string
  resolved: string
}> {
  await mkdir(repo, { recursive: true })
  const plan = (await readDistSkills(defaultDistRoot())).find(
    (skill) => skill.installName === 'ab-plan',
  )
  if (plan === undefined) throw new Error('real distribution has no ab-plan fixture')
  const incoming = plan.content
  const heading = '# /ab-plan <build>'
  const conflict = '- **Approach** — the shape of the change and why this shape, in a few'
  const incomingOnly = 'Park the build for a human:'
  const baseConflict = '- **Approach** — the old default wording for this section'
  const localConflict = '- **Approach** — keep this repository-specific planning standard'

  let base = replaceRequired(incoming, conflict, baseConflict)
  base = replaceRequired(base, incomingOnly, 'Ask a human to repair the ticket:')
  let local = replaceRequired(base, baseConflict, localConflict)
  local = replaceRequired(local, heading, '# /ab-plan <build> — local house style')
  let resolved = replaceRequired(incoming, conflict, localConflict)
  resolved = replaceRequired(resolved, heading, '# /ab-plan <build> — local house style')

  const livePath = installedSkillPath(repo, 'ab-plan')
  const pristinePath = pristineSkillPath(repo, 'ab-plan')
  await mkdir(dirname(livePath), { recursive: true })
  await mkdir(dirname(pristinePath), { recursive: true })
  await writeFile(livePath, local)
  await writeFile(pristinePath, base)
  return { base, local, incoming, resolved }
}

describe('upgrade distribution fixture', () => {
  test('init leaves verification empty instead of interpreting package scripts', async () => {
    await writeFile(join(target, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }))

    await install()

    const config = parseConfig(await readFile(join(target, 'autobuild.toml'), 'utf8'))
    expect(config.commands).toEqual({})
    expect(config.verify).toEqual({ steps: [], stepConfigs: {} })
  })
})

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
    expect(await readlink(join(claudeRoot, 'ab-alpha'))).toBe('../../.agents/skills/ab-alpha')
    expect(await readlink(join(claudeRoot, 'ab-custom'))).toBe('../../.agents/skills/ab-custom')
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

  test('a validated local-biased resolution keeps clean edits from both sides and advances pristine', async () => {
    await install()
    const live = installedSkillPath(target, 'ab-alpha')
    const localBody = BODY.replace('intro line one', 'intro line one (unrelated local)').replace(
      'middle line two',
      'middle line two (local conflict)',
    )
    const localText = installedForm('alpha', localBody)
    await writeFile(live, localText)
    const upstreamBody = BODY.replace(
      'middle line two',
      'middle line two (upstream conflict)',
    ).replace('closing line three', 'closing line three (incoming clean edit)')
    const incomingText = installedForm('alpha', upstreamBody)
    await writeDist(distV2, { alpha: upstreamBody })
    const pristineBefore = await readFile(pristineSkillPath(target, 'ab-alpha'), 'utf8')
    const resolvedText = installedForm(
      'alpha',
      BODY.replace('intro line one', 'intro line one (unrelated local)')
        .replace('middle line two', 'middle line two (local conflict)')
        .replace('closing line three', 'closing line three (incoming clean edit)'),
    )

    const calls: Array<{
      skill: string
      path: string
      base: string
      local: string
      incoming: string
    }> = []
    const report = await abUpgrade({
      targetRepo: target,
      distRoot: distV2,
      resolveConflict: async (input) => {
        calls.push(input)
        return resolvedText
      },
    })

    expect(report.skills).toEqual([{ skill: 'ab-alpha', action: 'resolved' }])
    expect(calls).toEqual([
      {
        skill: 'ab-alpha',
        path: 'SKILL.md',
        base: pristineBefore,
        local: localText,
        incoming: incomingText,
      },
    ])
    expect(await readFile(live, 'utf8')).toBe(resolvedText)
    expect(resolvedText).toContain('middle line two (local conflict)')
    expect(resolvedText).toContain('intro line one (unrelated local)')
    expect(resolvedText).toContain('closing line three (incoming clean edit)')
    expect(resolvedText).not.toContain('<<<<<<<')
    expect(await readFile(pristineSkillPath(target, 'ab-alpha'), 'utf8')).toBe(incomingText)
  })

  test('marker-documentation lines are protected content, not merge structure', async () => {
    const markerBody = [
      '# alpha',
      '',
      'This skill documents a literal Git opener:',
      '<<<<<<< local',
      'protected marker documentation',
      'ordinary content after the marker-looking line',
      '',
      ...Array.from({ length: 12 }, (_value, index) => `stable context ${index + 1}`),
      'conflict target',
      'tail remains clean',
      '',
    ].join('\n')
    await writeDist(distV1, { alpha: markerBody })
    await install()
    const live = installedSkillPath(target, 'ab-alpha')
    const pristinePath = pristineSkillPath(target, 'ab-alpha')
    const local = installedForm(
      'alpha',
      markerBody.replace('conflict target', 'conflict target (local)'),
    )
    const incomingBody = markerBody.replace('conflict target', 'conflict target (incoming)')
    const incoming = installedForm('alpha', incomingBody)
    const resolved = installedForm(
      'alpha',
      markerBody.replace('conflict target', 'conflict target (local)'),
    )
    await writeFile(live, local)
    await writeDist(distV2, { alpha: incomingBody })
    const pristine = await readFile(pristinePath, 'utf8')

    const rejected = await abUpgrade({
      targetRepo: target,
      distRoot: distV2,
      resolveConflict: async () =>
        resolved.replace(
          '<<<<<<< local\nprotected marker documentation\nordinary content after the marker-looking line',
          'agent deleted the marker-looking clean region',
        ),
    })

    expect(rejected.skills[0]?.action).toBe('conflicted')
    expect(rejected.skills[0]?.detail).toContain('already-clean merge region')
    expect(await readFile(live, 'utf8')).toBe(local)
    expect(await readFile(pristinePath, 'utf8')).toBe(pristine)

    const accepted = await abUpgrade({
      targetRepo: target,
      distRoot: distV2,
      resolveConflict: async () => resolved,
    })

    expect(accepted.skills).toEqual([{ skill: 'ab-alpha', action: 'resolved' }])
    expect(await readFile(live, 'utf8')).toBe(resolved)
    expect(resolved).toContain(
      '<<<<<<< local\nprotected marker documentation\nordinary content after the marker-looking line',
    )
    expect(resolved).not.toContain('ab-upgrade-local-')
    expect(await readFile(pristinePath, 'utf8')).toBe(incoming)
  })

  test('resolver null → local file byte-untouched, conflicted report carries the markers', async () => {
    await install()
    const live = installedSkillPath(target, 'ab-alpha')
    const localText = installedForm(
      'alpha',
      BODY.replace('middle line two', 'middle line two (local)'),
    )
    await writeFile(live, localText)
    await writeDist(distV2, {
      alpha: BODY.replace('middle line two', 'middle line two (upstream)'),
    })
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
    expect(entry.detail).toMatch(/<<<<<<< ab-upgrade-local-[0-9a-f-]+/)
    expect(entry.detail).toContain('middle line two (local)')
    expect(entry.detail).toContain('middle line two (upstream)')
    expect(entry.detail).toMatch(/>>>>>>> ab-upgrade-incoming-[0-9a-f-]+/)
    expect(await readFile(live, 'utf8')).toBe(localText)
    expect(await readFile(pristineSkillPath(target, 'ab-alpha'), 'utf8')).toBe(pristineBefore)
  })

  test('no resolver at all behaves like a null resolver', async () => {
    await install()
    const live = installedSkillPath(target, 'ab-alpha')
    const localText = installedForm(
      'alpha',
      BODY.replace('middle line two', 'middle line two (local)'),
    )
    await writeFile(live, localText)
    await writeDist(distV2, {
      alpha: BODY.replace('middle line two', 'middle line two (upstream)'),
    })

    const report = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    expect(report.skills[0]!.action).toBe('conflicted')
    expect(report.skills[0]!.detail).toContain('agent resolution unavailable')
    expect(await readFile(live, 'utf8')).toBe(localText)
  })

  test('declined, failed, wrapped, marked, and incomplete proposals all fail safe', async () => {
    const cases: Array<{
      name: string
      resolve: (local: string) => Promise<string | null>
      reason: string
    }> = [
      {
        name: 'declined',
        resolve: async () => null,
        reason: 'agent declined',
      },
      {
        name: 'failed',
        resolve: async () => {
          throw new Error('provider unavailable')
        },
        reason: 'agent resolution failed: provider unavailable',
      },
      {
        name: 'wrapped',
        resolve: async (local) => `Here is the result:\n${local}`,
        reason: 'must begin at byte 0',
      },
      {
        name: 'marked',
        resolve: async (local) =>
          local
            .replace(
              'middle line two (local conflict)',
              '<<<<<<< local\nmiddle line two (local conflict)\n=======\nmiddle line two (upstream conflict)\n>>>>>>> upstream',
            )
            .replace('closing line three', 'closing line three (incoming clean edit)'),
        reason: 'contains a Git conflict-marker line',
      },
      {
        name: 'incomplete',
        resolve: async (local) => local,
        reason: 'already-clean merge region',
      },
    ]

    for (const entry of cases) {
      const repo = join(root, `repo-${entry.name}`)
      const oldDist = join(root, `old-${entry.name}`)
      const nextDist = join(root, `next-${entry.name}`)
      await mkdir(repo, { recursive: true })
      await writeDist(oldDist, { alpha: BODY })
      await abInit({ targetRepo: repo, distRoot: oldDist })
      const live = installedSkillPath(repo, 'ab-alpha')
      const pristinePath = pristineSkillPath(repo, 'ab-alpha')
      const local = installedForm(
        'alpha',
        BODY.replace('intro line one', 'intro line one (unrelated local)').replace(
          'middle line two',
          'middle line two (local conflict)',
        ),
      )
      await writeFile(live, local)
      await writeDist(nextDist, {
        alpha: BODY.replace('middle line two', 'middle line two (upstream conflict)').replace(
          'closing line three',
          'closing line three (incoming clean edit)',
        ),
      })
      const pristine = await readFile(pristinePath, 'utf8')
      const out: string[] = []

      const report = await abUpgrade({
        targetRepo: repo,
        distRoot: nextDist,
        resolveConflict: () => entry.resolve(local),
        stdout: (line) => out.push(line),
      })

      expect(report.skills[0]?.action).toBe('conflicted')
      expect(report.skills[0]?.detail).toContain(entry.reason)
      expect(report.skills[0]?.detail).toContain('<<<<<<< ab-upgrade-local-')
      expect(out.join('\n')).toContain(
        `merge by hand against .agents/skills/.ab-pristine/ab-alpha/SKILL.md`,
      )
      expect(await readFile(live, 'utf8')).toBe(local)
      expect(await readFile(pristinePath, 'utf8')).toBe(pristine)
      expect(local).not.toContain('<<<<<<<')
    }
  })
})

describe('abUpgrade — complete skill trees', () => {
  const reference = 'references/authoring.md'
  const baseReference = [
    '# Authoring',
    '',
    'intro one',
    'intro two',
    'middle one',
    'middle two',
    'closing one',
    'closing two',
    '',
  ].join('\n')

  test('a missing SKILL.md never lets upgrade clobber a customized distributed sibling', async () => {
    await writeDist(distV1, { alpha: BODY }, { alpha: { [reference]: baseReference } })
    await install()
    const rootSkill = installedSkillPath(target, 'ab-alpha')
    const live = installedSkillFilePath(target, 'ab-alpha', reference)
    const pristine = pristineSkillFilePath(target, 'ab-alpha', reference)
    const pristineBefore = await readFile(pristine, 'utf8')
    await rm(rootSkill)
    await writeFile(live, `${baseReference}local appendix\n`)
    await writeDist(distV2, { alpha: BODY }, { alpha: { [reference]: baseReference } })

    const report = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    expect(report.skills[0]?.action).toBe('adopted')
    expect(existsSync(rootSkill)).toBe(true)
    expect(await readFile(live, 'utf8')).toBe(`${baseReference}local appendix\n`)
    expect(await readFile(pristine, 'utf8')).toBe(pristineBefore)
  })

  test('an upgrade delivers a newly distributed reference to an old install', async () => {
    await install()
    await writeDist(distV2, { alpha: BODY }, { alpha: { [reference]: baseReference } })

    const report = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    expect(report.skills).toEqual([{ skill: 'ab-alpha', action: 'adopted' }])
    expect(await readFile(installedSkillFilePath(target, 'ab-alpha', reference), 'utf8')).toBe(
      baseReference,
    )
    expect(await readFile(pristineSkillFilePath(target, 'ab-alpha', reference), 'utf8')).toBe(
      baseReference,
    )
  })

  test('auxiliary files use the same clean three-way merge model', async () => {
    await writeDist(distV1, { alpha: BODY }, { alpha: { [reference]: baseReference } })
    await install()
    const live = installedSkillFilePath(target, 'ab-alpha', reference)
    await writeFile(live, baseReference.replace('intro one', 'intro one (local)'))
    const incoming = baseReference.replace('closing two', 'closing two (upstream)')
    await writeDist(distV2, { alpha: BODY }, { alpha: { [reference]: incoming } })

    const report = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    expect(report.skills).toEqual([{ skill: 'ab-alpha', action: 'merged' }])
    const merged = await readFile(live, 'utf8')
    expect(merged).toContain('intro one (local)')
    expect(merged).toContain('closing two (upstream)')
    expect(await readFile(pristineSkillFilePath(target, 'ab-alpha', reference), 'utf8')).toBe(
      incoming,
    )
  })

  test('auxiliary conflicts are path-qualified, locally resolved, and need no frontmatter', async () => {
    await writeDist(distV1, { alpha: BODY }, { alpha: { [reference]: baseReference } })
    await install()
    const live = installedSkillFilePath(target, 'ab-alpha', reference)
    const local = baseReference.replace('middle two', 'middle two (local)')
    const incoming = baseReference.replace('middle two', 'middle two (upstream)')
    await writeFile(live, local)
    await writeDist(distV2, { alpha: BODY }, { alpha: { [reference]: incoming } })
    const calls: string[] = []

    const report = await abUpgrade({
      targetRepo: target,
      distRoot: distV2,
      resolveConflict: async (input) => {
        calls.push(input.path)
        return local
      },
    })

    expect(calls).toEqual([reference])
    expect(report.skills).toEqual([{ skill: 'ab-alpha', action: 'resolved' }])
    expect(await readFile(live, 'utf8')).toBe(local)
    expect(await readFile(pristineSkillFilePath(target, 'ab-alpha', reference), 'utf8')).toBe(
      incoming,
    )
  })

  test('conflicted stdout selects the actual conflict rather than an earlier non-conflict detail', async () => {
    await writeDist(distV1, { alpha: BODY }, { alpha: { [reference]: baseReference } })
    await install()
    await rm(pristineSkillPath(target, 'ab-alpha'))
    await writeFile(
      installedSkillFilePath(target, 'ab-alpha', reference),
      baseReference.replace('middle two', 'middle two (local)'),
    )
    await writeDist(
      distV2,
      { alpha: BODY },
      {
        alpha: {
          [reference]: baseReference.replace('middle two', 'middle two (incoming)'),
        },
      },
    )
    const lines: string[] = []

    const report = await abUpgrade({
      targetRepo: target,
      distRoot: distV2,
      stdout: (line) => lines.push(line),
    })

    expect(report.skills[0]?.action).toBe('conflicted')
    expect(report.skills[0]?.detail).toContain(
      'SKILL.md: no pristine record; local already matches the new default',
    )
    expect(lines).toContain(
      'ab-alpha: conflicted — agent resolution unavailable; kept your local file ' +
        '(merge by hand against ' +
        '.agents/skills/.ab-pristine/ab-alpha/references/authoring.md)',
    )
  })

  test('upstream removal deletes an unedited file but preserves local customization and extras', async () => {
    const uneditedReference = 'references/removed.md'
    await writeDist(
      distV1,
      { alpha: BODY },
      {
        alpha: {
          [reference]: baseReference,
          [uneditedReference]: 'upstream-owned\n',
        },
      },
    )
    await install()
    const live = installedSkillFilePath(target, 'ab-alpha', reference)
    const pristine = pristineSkillFilePath(target, 'ab-alpha', reference)
    const unedited = installedSkillFilePath(target, 'ab-alpha', uneditedReference)
    const uneditedPristine = pristineSkillFilePath(target, 'ab-alpha', uneditedReference)
    const extra = installedSkillFilePath(target, 'ab-alpha', 'references/local.md')
    await writeFile(live, `${baseReference}local appendix\n`)
    await writeFile(extra, 'repo-only\n')
    await writeDist(distV2, { alpha: BODY })

    const report = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    expect(report.skills[0]?.action).toBe('merged')
    expect(report.skills[0]?.detail).toContain(`${reference}: upstream removed`)
    expect(await readFile(live, 'utf8')).toContain('local appendix')
    expect(existsSync(pristine)).toBe(false)
    expect(existsSync(unedited)).toBe(false)
    expect(existsSync(uneditedPristine)).toBe(false)
    expect(await readFile(extra, 'utf8')).toBe('repo-only\n')
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

  test.each(['claude-to-agents', 'agents-to-claude'] as const)(
    'fresh and repeated upgrades preserve aliased skill roots: %s',
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
      await writeDist(distV2, {
        alpha: BODY,
        beta: '# beta\n\nbeta body\n',
      })

      const first = await abUpgrade({ targetRepo: target, distRoot: distV2 })
      const pristineBefore = new Map(
        await Promise.all(
          ['ab-alpha', 'ab-beta'].map(
            async (skill) =>
              [skill, await readFile(pristineSkillPath(target, skill), 'utf8')] as const,
          ),
        ),
      )
      const lines: string[] = []
      const second = await abUpgrade({
        targetRepo: target,
        distRoot: distV2,
        stdout: (line) => lines.push(line),
      })

      expect(first.exitCode).toBe(0)
      expect(first.skills.every((entry) => entry.action === 'installed')).toBe(true)
      expect(second.exitCode).toBe(0)
      expect(second.discoveryConflicts).toEqual([])
      expect(lines.join('\n')).not.toContain('conflicting legacy pristine files remain')
      for (const skill of ['ab-alpha', 'ab-beta']) {
        expect(await readFile(pristineSkillPath(target, skill), 'utf8')).toBe(
          pristineBefore.get(skill)!,
        )
        expect(await readFile(installedSkillPath(target, skill), 'utf8')).toBe(
          await readFile(join(target, '.claude', 'skills', skill, 'SKILL.md'), 'utf8'),
        )
        expect((await lstat(join(target, '.claude', 'skills', skill))).isSymbolicLink()).toBe(false)
        expect(existsSync(join(target, '.agents', 'skills', skill, skill))).toBe(false)
      }
    },
  )
})

describe('abUpgrade — fixed retired skills', () => {
  const retiredBodies = {
    setup: '# setup\n\nold setup guidance\n',
    'verify-e2e': '# verify e2e\n\nold sample verifier\n',
  }

  async function installOldDistribution(): Promise<void> {
    await writeDist(distV1, { alpha: BODY, ...retiredBodies })
    await install()
    await writeDist(distV2, { alpha: BODY })
  }

  test('removes exact pristine copies and Autobuild-owned discovery links once', async () => {
    await installOldDistribution()
    const ownedLinks = new Map<string, string>()
    for (const name of ['ab-setup', 'ab-verify-e2e']) {
      const discovery = join(target, '.claude', 'skills', name)
      const linkText = await readlink(discovery)
      expect(resolve(dirname(discovery), linkText)).toBe(
        resolve(dirname(installedSkillPath(target, name))),
      )
      ownedLinks.set(name, linkText)
    }

    const first = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    expect(first.skills).toEqual([
      { skill: 'ab-alpha', action: 'current' },
      {
        skill: 'ab-setup',
        action: 'removed',
        detail: 'retired distribution skill; installed tree matched pristine',
      },
      {
        skill: 'ab-verify-e2e',
        action: 'removed',
        detail: 'retired distribution skill; installed tree matched pristine',
      },
    ])
    for (const name of ['ab-setup', 'ab-verify-e2e']) {
      expect(ownedLinks.get(name)).toBeDefined()
      expect(existsSync(installedSkillPath(target, name))).toBe(false)
      expect(existsSync(pristineSkillPath(target, name))).toBe(false)
      await expect(lstat(join(target, '.claude', 'skills', name))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    }

    const second = await abUpgrade({ targetRepo: target, distRoot: distV2 })
    expect(second.skills).toEqual([{ skill: 'ab-alpha', action: 'current' }])
  })

  test('surfaces and preserves a foreign Claude symlink while retiring an exact canonical tree', async () => {
    await installOldDistribution()
    const name = 'ab-setup'
    const discovery = join(target, '.claude', 'skills', name)
    const foreignTarget = join(target, 'user-skills', 'retired-setup')
    const foreignLinkText = '../../user-skills/retired-setup'
    const sentinel = Buffer.from('user-owned symlink target bytes\n')
    await rm(discovery, { force: true })
    await mkdir(foreignTarget, { recursive: true })
    await writeFile(join(foreignTarget, 'sentinel.bin'), sentinel)
    await symlink(foreignLinkText, discovery, 'dir')

    const first = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    expect(first.exitCode).toBe(1)
    expect(first.skills.find((entry) => entry.skill === name)).toEqual({
      skill: name,
      action: 'kept',
      detail:
        'retired canonical tree matched pristine and was removed; user-owned Claude discovery entry remains',
    })
    expect(first.discoveryConflicts).toHaveLength(1)
    expect(first.discoveryConflicts[0]?.skill).toBe(name)
    expect(first.discoveryConflicts[0]?.message).toContain('is a foreign symlink')
    expect(existsSync(installedSkillPath(target, name))).toBe(false)
    expect(existsSync(pristineSkillPath(target, name))).toBe(false)
    expect((await lstat(discovery)).isSymbolicLink()).toBe(true)
    expect(await readlink(discovery)).toBe(foreignLinkText)
    expect(await readFile(join(foreignTarget, 'sentinel.bin'))).toEqual(sentinel)

    const second = await abUpgrade({ targetRepo: target, distRoot: distV2 })
    expect(second).toEqual({
      skills: [{ skill: 'ab-alpha', action: 'current' }],
      discoveryConflicts: [],
      exitCode: 0,
    })
    expect((await lstat(discovery)).isSymbolicLink()).toBe(true)
    expect(await readlink(discovery)).toBe(foreignLinkText)
    expect(await readFile(join(foreignTarget, 'sentinel.bin'))).toEqual(sentinel)
  })

  test('surfaces and preserves a distinct Claude directory while retiring an exact canonical tree', async () => {
    await installOldDistribution()
    const name = 'ab-setup'
    const discovery = join(target, '.claude', 'skills', name)
    const sentinel = Buffer.from('user-owned Claude bytes\n')
    await rm(discovery, { recursive: true, force: true })
    await mkdir(discovery, { recursive: true })
    await writeFile(join(discovery, 'sentinel.bin'), sentinel)

    const first = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    expect(first.exitCode).toBe(1)
    expect(first.skills.find((entry) => entry.skill === name)).toEqual({
      skill: name,
      action: 'kept',
      detail:
        'retired canonical tree matched pristine and was removed; user-owned Claude discovery entry remains',
    })
    expect(first.discoveryConflicts).toHaveLength(1)
    expect(first.discoveryConflicts[0]?.skill).toBe(name)
    expect(first.discoveryConflicts[0]?.message).toContain('.claude/skills/ab-setup')
    expect(existsSync(installedSkillPath(target, name))).toBe(false)
    expect(existsSync(pristineSkillPath(target, name))).toBe(false)
    expect((await lstat(discovery)).isSymbolicLink()).toBe(false)
    expect(await readFile(join(discovery, 'sentinel.bin'))).toEqual(sentinel)

    const second = await abUpgrade({ targetRepo: target, distRoot: distV2 })
    expect(second).toEqual({
      skills: [{ skill: 'ab-alpha', action: 'current' }],
      discoveryConflicts: [],
      exitCode: 0,
    })
    expect((await lstat(discovery)).isSymbolicLink()).toBe(false)
    expect(await readFile(join(discovery, 'sentinel.bin'))).toEqual(sentinel)
  })

  test('cleans surviving provenance and an owned dangling link when the live tree is missing', async () => {
    await installOldDistribution()
    const name = 'ab-setup'
    const discovery = join(target, '.claude', 'skills', name)
    await rm(dirname(installedSkillPath(target, name)), { recursive: true, force: true })
    expect((await lstat(discovery)).isSymbolicLink()).toBe(true)

    const first = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    expect(first.exitCode).toBe(0)
    expect(first.skills.find((entry) => entry.skill === name)).toEqual({
      skill: name,
      action: 'removed',
      detail: 'retired distribution skill; installed tree was already missing',
    })
    expect(existsSync(pristineSkillPath(target, name))).toBe(false)
    await expect(lstat(discovery)).rejects.toMatchObject({ code: 'ENOENT' })

    const second = await abUpgrade({ targetRepo: target, distRoot: distV2 })
    expect(second.skills).toEqual([{ skill: 'ab-alpha', action: 'current' }])
    expect(second.exitCode).toBe(0)
    await expect(lstat(discovery)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('keeps edited trees and local support files, then relinquishes pristine ownership', async () => {
    await installOldDistribution()
    await writeFile(
      installedSkillPath(target, 'ab-setup'),
      `${await readFile(installedSkillPath(target, 'ab-setup'), 'utf8')}local edit\n`,
    )
    const localFile = installedSkillFilePath(target, 'ab-verify-e2e', 'references/local.md')
    await mkdir(dirname(localFile), { recursive: true })
    await writeFile(localFile, 'repository-owned\n')

    const first = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    expect(first.skills.find((entry) => entry.skill === 'ab-setup')).toEqual({
      skill: 'ab-setup',
      action: 'kept',
      detail: 'locally customized: SKILL.md has local edits',
    })
    expect(first.skills.find((entry) => entry.skill === 'ab-verify-e2e')).toEqual({
      skill: 'ab-verify-e2e',
      action: 'kept',
      detail: 'locally customized: references is a repository-local addition',
    })
    for (const name of ['ab-setup', 'ab-verify-e2e']) {
      expect(existsSync(installedSkillPath(target, name))).toBe(true)
      expect(existsSync(pristineSkillPath(target, name))).toBe(false)
      expect((await lstat(join(target, '.claude', 'skills', name))).isSymbolicLink()).toBe(true)
    }

    const second = await abUpgrade({ targetRepo: target, distRoot: distV2 })
    expect(second.skills).toEqual([{ skill: 'ab-alpha', action: 'current' }])
  })

  test('keeps retired skills still referenced by verify or finalize configuration', async () => {
    await installOldDistribution()
    await writeFile(
      join(target, 'autobuild.toml'),
      [
        'baseBranch = "main"',
        '[commands]',
        '[verify]',
        'steps = ["legacy-setup"]',
        '[verify.legacy-setup]',
        'kind = "agent"',
        'skill = "ab-setup"',
        '[finalize]',
        'steps = ["legacy-e2e"]',
        '[finalize.legacy-e2e]',
        'kind = "agent"',
        'skill = "ab-verify-e2e"',
        '[roles.default]',
        'runtime = "claude"',
        '[tickets]',
        'source = "file"',
        'readyState = "ready"',
        '',
      ].join('\n'),
    )

    const report = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    for (const name of ['ab-setup', 'ab-verify-e2e']) {
      expect(report.skills.find((entry) => entry.skill === name)).toEqual({
        skill: name,
        action: 'kept',
        detail: 'still referenced by autobuild.toml as an agent step skill',
      })
      expect(existsSync(installedSkillPath(target, name))).toBe(true)
      expect(existsSync(pristineSkillPath(target, name))).toBe(false)
    }
  })

  test('keeps candidates when config cannot be inspected safely', async () => {
    await installOldDistribution()
    await writeFile(join(target, 'autobuild.toml'), '[verify\ninvalid')

    const first = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    for (const name of ['ab-setup', 'ab-verify-e2e']) {
      const entry = first.skills.find((candidate) => candidate.skill === name)
      expect(entry?.action).toBe('kept')
      expect(entry?.detail).toContain('could not safely inspect autobuild.toml references')
      expect(existsSync(installedSkillPath(target, name))).toBe(true)
      expect(existsSync(pristineSkillPath(target, name))).toBe(false)
    }

    const second = await abUpgrade({ targetRepo: target, distRoot: distV2 })
    expect(second.skills).toEqual([{ skill: 'ab-alpha', action: 'current' }])
  })

  test('never removes or reports a same-named repository-authored skill without pristine provenance', async () => {
    await install()
    const local = installedSkillPath(target, 'ab-setup')
    await mkdir(dirname(local), { recursive: true })
    await writeFile(local, '---\nname: ab-setup\n---\nrepository authored\n')
    await writeDist(distV2, { alpha: BODY })

    const report = await abUpgrade({ targetRepo: target, distRoot: distV2 })

    expect(report.skills).toEqual([{ skill: 'ab-alpha', action: 'current' }])
    expect(await readFile(local, 'utf8')).toContain('repository authored')
  })
})

describe('runCli routing — ab upgrade outside a session', () => {
  test('returns nonzero after reporting every discovery conflict and processing later skills', async () => {
    await writeDist(distV2, {
      alpha: BODY,
      beta: '# beta\n\nbeta body\n',
      gamma: '# gamma\n\ngamma body\n',
    })
    for (const [name, body] of [
      ['alpha', BODY],
      ['beta', '# beta\n\nbeta body\n'],
    ] as const) {
      const installName = `ab-${name}`
      const canonical = installedSkillPath(target, installName)
      const claude = join(target, '.claude', 'skills', installName, 'SKILL.md')
      await mkdir(dirname(canonical), { recursive: true })
      await mkdir(dirname(claude), { recursive: true })
      await writeFile(canonical, installedForm(name, body))
      await writeFile(claude, `---\nname: ${installName}\n---\ndistinct Claude copy\n`)
    }
    const out: string[] = []

    const code = await runCli(['upgrade', target, '--no-self-update'], {
      workspacePath: target,
      distributionRoot: distV2,
      stdout: (line) => out.push(line),
      stderr: () => {},
    })

    expect(code).toBe(1)
    expect(out).toContain('ab-alpha: adopted')
    expect(out).toContain('ab-beta: adopted')
    expect(out).toContain('ab-gamma: installed')
    expect(existsSync(installedSkillPath(target, 'ab-gamma'))).toBe(true)
    const output = out.join('\n')
    expect(output).toContain('Claude discovery conflicts:')
    expect(output).toContain('.claude/skills/ab-alpha')
    expect(output).toContain('.claude/skills/ab-beta')
    expect(output.match(/move or remove/g)).toHaveLength(2)
  })

  test('the real CLI seam reports resolved and preserves the documented local bias', async () => {
    const repo = join(root, 'cli-resolved')
    const fixture = await seedRealPlanConflict(repo)
    const out: string[] = []
    const err: string[] = []
    let factoryCalls = 0

    const code = await runCli(['upgrade', repo, '--no-commit'], {
      workspacePath: target,
      processEnv: { UPGRADE_TOKEN: 'secret' },
      upgradeResolverFactory: (opts) => {
        factoryCalls += 1
        expect(opts.targetRepo).toBe(repo)
        expect(opts.env.UPGRADE_TOKEN).toBe('secret')
        return async (input) => {
          expect(input).toEqual({
            skill: 'ab-plan',
            path: 'SKILL.md',
            base: fixture.base,
            local: fixture.local,
            incoming: fixture.incoming,
          })
          return fixture.resolved
        }
      },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    })

    expect(code).toBe(0)
    expect(err).toEqual([
      'self-update skipped: running from a source checkout (.git is present); merging skills with the installed distribution',
    ])
    expect(factoryCalls).toBe(1)
    expect(out).toContain('ab-plan: resolved')
    expect(await readFile(installedSkillPath(repo, 'ab-plan'), 'utf8')).toBe(fixture.resolved)
    expect(await readFile(pristineSkillPath(repo, 'ab-plan'), 'utf8')).toBe(fixture.incoming)
    expect(fixture.resolved).toContain('keep this repository-specific planning standard')
    expect(fixture.resolved).toContain('local house style')
    expect(fixture.resolved).toContain('Park the build for a human:')
    expect(fixture.resolved).not.toContain('<<<<<<<')
  })

  test('resolver absence reaches the actionable byte-preserving conflicted outcome', async () => {
    const repo = join(root, 'cli-unavailable')
    const fixture = await seedRealPlanConflict(repo)
    const out: string[] = []

    const code = await runCli(['upgrade', repo], {
      workspacePath: target,
      stdout: (line) => out.push(line),
      stderr: () => {},
    })

    expect(code).toBe(0)
    expect(out.join('\n')).toContain('ab-plan: conflicted — agent resolution unavailable')
    expect(out.join('\n')).toContain(
      'merge by hand against .agents/skills/.ab-pristine/ab-plan/SKILL.md',
    )
    expect(await readFile(installedSkillPath(repo, 'ab-plan'), 'utf8')).toBe(fixture.local)
    expect(await readFile(pristineSkillPath(repo, 'ab-plan'), 'utf8')).toBe(fixture.base)
  })

  test('declined, thrown, prose-wrapped, and marked CLI proposals all stay fail-safe', async () => {
    const cases: Array<{
      name: string
      resolve: (resolved: string) => Promise<string | null>
      reason: string
    }> = [
      { name: 'decline', resolve: async () => null, reason: 'agent declined' },
      {
        name: 'throw',
        resolve: async () => {
          throw new Error('completion failed')
        },
        reason: 'agent resolution failed: completion failed',
      },
      {
        name: 'prose',
        resolve: async (resolved) => `Resolved file follows:\n${resolved}`,
        reason: 'must begin at byte 0',
      },
      {
        name: 'markers',
        resolve: async (resolved) =>
          resolved.replace(
            '- **Approach** — keep this repository-specific planning standard',
            '<<<<<<< local\nlocal\n=======\nincoming\n>>>>>>> upstream',
          ),
        reason: 'contains a Git conflict-marker line',
      },
    ]

    for (const entry of cases) {
      const repo = join(root, `cli-${entry.name}`)
      const fixture = await seedRealPlanConflict(repo)
      const out: string[] = []
      const code = await runCli(['upgrade', repo], {
        workspacePath: target,
        upgradeResolverFactory: () => () => entry.resolve(fixture.resolved),
        stdout: (line) => out.push(line),
        stderr: () => {},
      })

      expect(code).toBe(0)
      expect(out.join('\n')).toContain('ab-plan: conflicted —')
      expect(out.join('\n')).toContain(entry.reason)
      expect(await readFile(installedSkillPath(repo, 'ab-plan'), 'utf8')).toBe(fixture.local)
      expect(await readFile(pristineSkillPath(repo, 'ab-plan'), 'utf8')).toBe(fixture.base)
    }
  })

  test('interactive Ctrl-C cancels one file byte-safely and continues to a later skill', async () => {
    const repo = join(root, 'cli-cancel')
    const oldDist = join(root, 'cancel-old')
    const nextDist = join(root, 'cancel-next')
    await mkdir(repo, { recursive: true })
    await writeDist(oldDist, { alpha: BODY, beta: BODY.replace('# alpha', '# beta') })
    await abInit({ targetRepo: repo, distRoot: oldDist })

    const locals = new Map<string, string>()
    const pristineBefore = new Map<string, string>()
    for (const skill of ['ab-alpha', 'ab-beta']) {
      const live = installedSkillPath(repo, skill)
      const pristine = pristineSkillPath(repo, skill)
      const local = (await readFile(live, 'utf8')).replace(
        'middle line two',
        'middle line two (local)',
      )
      await writeFile(live, local)
      locals.set(skill, local)
      pristineBefore.set(skill, await readFile(pristine, 'utf8'))
    }
    await writeDist(nextDist, {
      alpha: BODY.replace('middle line two', 'middle line two (incoming)'),
      beta: BODY.replace('# alpha', '# beta').replace(
        'middle line two',
        'middle line two (incoming)',
      ),
    })

    let handler: ((event: TerminalInputEvent) => void) | undefined
    const input: TerminalInput & { starts: number; cleanups: number } = {
      starts: 0,
      cleanups: 0,
      start(onInput): () => void {
        input.starts += 1
        handler = onInput
        return () => {
          input.cleanups += 1
          handler = undefined
        }
      },
    }
    const raw: string[] = []
    const write = (chunk: string): void => {
      raw.push(chunk)
    }
    const terminal: TerminalOut = {
      interactive: true,
      columns: 100,
      rows: 24,
      write,
      modes: createTerminalModeController(write),
    }
    const calls: string[] = []
    let cancelledSignal: AbortSignal | undefined
    const out: string[] = []
    const code = await runCli(['upgrade', repo, '--no-self-update'], {
      workspacePath: repo,
      distributionRoot: nextDist,
      terminal,
      input,
      upgradeResolverFactory: () => async (conflict, options) => {
        calls.push(conflict.skill)
        if (conflict.skill === 'ab-alpha') {
          cancelledSignal = options?.signal
          queueMicrotask(() => handler?.({ type: 'interrupt' }))
          return new Promise(() => {})
        }
        return locals.get(conflict.skill)!
      },
      stdout: (line) => out.push(line),
      stderr: () => {},
    })

    expect(code).toBe(0)
    expect(calls).toEqual(['ab-alpha', 'ab-beta'])
    expect(cancelledSignal?.aborted).toBe(true)
    expect(out[0]).toContain(
      'ab-alpha: conflicted — agent resolution failed: upgrade conflict resolution cancelled by human',
    )
    expect(out[1]).toBe('ab-beta: resolved')
    expect(await readFile(installedSkillPath(repo, 'ab-alpha'), 'utf8')).toBe(
      locals.get('ab-alpha')!,
    )
    expect(await readFile(pristineSkillPath(repo, 'ab-alpha'), 'utf8')).toBe(
      pristineBefore.get('ab-alpha')!,
    )
    expect(await readFile(installedSkillPath(repo, 'ab-beta'), 'utf8')).toBe(locals.get('ab-beta')!)
    expect(input.starts).toBe(2)
    expect(input.cleanups).toBe(2)
    expect(raw.join('')).toContain('Resolving ab-alpha/SKILL.md')
    expect(raw.join('')).toContain('Resolving ab-beta/SKILL.md')
  })

  test('ab upgrade <target> works with no store/env deps and prints per-skill lines', async () => {
    await install()
    // The CLI cannot inject a fixture distRoot, so this runs against the
    // REAL distribution: its skills aren't installed in the fixture repo and
    // install fresh, while the fixture's ab-alpha is absent upstream and
    // reports unknown — enough to prove sessionless routing end to end.
    const out: string[] = []
    const err: string[] = []
    const code = await runCli(['upgrade', target, '--no-commit'], {
      workspacePath: target,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    })
    // The default distRoot is the REAL distribution: its skills are not
    // installed in this fixture repo, so they install fresh — proving the
    // command routes and runs without any session deps.
    expect(err).toEqual([
      'self-update skipped: running from a source checkout (.git is present); merging skills with the installed distribution',
    ])
    expect(code).toBe(0)
    expect(out).toContain('ab-plan: installed')
    // The fixture's own skill is not in the real distribution → unknown.
    expect(out.some((line) => line.startsWith('ab-alpha: unknown'))).toBe(true)
  })

  test('commits a clean target by default and --no-commit leaves the same merge dirty', async () => {
    const oldDist = join(root, 'commit-old')
    const nextDist = join(root, 'commit-next')
    await writeDist(oldDist, { alpha: BODY })
    await writeDist(nextDist, {
      alpha: BODY.replace('middle line two', 'middle line two upgraded'),
    })

    for (const noCommit of [false, true]) {
      const repo = join(root, noCommit ? 'commit-off' : 'commit-on')
      await mkdir(repo)
      await abInit({ targetRepo: repo, distRoot: oldDist })
      await spawnExec(['git', 'init', '-q'], { cwd: repo })
      await spawnExec(['git', 'config', 'user.name', 'Upgrade Test'], { cwd: repo })
      await spawnExec(['git', 'config', 'user.email', 'upgrade@example.test'], { cwd: repo })
      await spawnExec(['git', 'add', '.'], { cwd: repo })
      await spawnExec(['git', 'commit', '-qm', 'initial'], { cwd: repo })
      const before = (await spawnExec(['git', 'rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()

      const code = await runCli(
        ['upgrade', repo, '--no-self-update', ...(noCommit ? ['--no-commit'] : [])],
        {
          workspacePath: repo,
          distributionRoot: nextDist,
          stdout: () => {},
          stderr: () => {},
        },
      )

      expect(code).toBe(0)
      const after = (await spawnExec(['git', 'rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()
      const status = (await spawnExec(['git', 'status', '--porcelain'], { cwd: repo })).stdout
      if (noCommit) {
        expect(after).toBe(before)
        expect(status).toContain('.agents/skills/ab-alpha/SKILL.md')
      } else {
        expect(after).not.toBe(before)
        expect(status).toBe('')
        expect(
          (await spawnExec(['git', 'log', '-1', '--format=%B'], { cwd: repo })).stdout,
        ).toContain('- ab-alpha: adopted')
      }
    }
  })

  test('a replacement child without the pre-update handoff baseline leaves every upgrade change uncommitted', async () => {
    const oldDist = join(root, 'handoff-old')
    const nextDist = join(root, 'handoff-next')
    const repo = join(root, 'handoff-repo')
    await writeDist(oldDist, { alpha: BODY })
    await writeDist(nextDist, {
      alpha: BODY.replace('middle line two', 'middle line two upgraded'),
    })
    await mkdir(repo)
    await abInit({ targetRepo: repo, distRoot: oldDist })
    await writeFile(join(repo, 'package.json'), '{"dependencies":{"autobuild":"old"}}\n')
    await writeFile(join(repo, 'bun.lock'), '{"lock":"old"}\n')
    await writeFile(join(repo, 'staged.txt'), 'old staged\n')
    await writeFile(join(repo, 'unstaged.txt'), 'old unstaged\n')
    await spawnExec(['git', 'init', '-q'], { cwd: repo })
    await spawnExec(['git', 'config', 'user.name', 'Upgrade Test'], { cwd: repo })
    await spawnExec(['git', 'config', 'user.email', 'upgrade@example.test'], { cwd: repo })
    await spawnExec(['git', 'add', '.'], { cwd: repo })
    await spawnExec(['git', 'commit', '-qm', 'initial'], { cwd: repo })
    const before = (await spawnExec(['git', 'rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()

    // Simulate an older parent that updated its local Bun owner project, then
    // launched the newer child with the handoff marker but no commit context.
    await writeFile(join(repo, 'package.json'), '{"dependencies":{"autobuild":"new"}}\n')
    await writeFile(join(repo, 'bun.lock'), '{"lock":"new"}\n')
    await writeFile(join(repo, 'staged.txt'), 'operator staged\n')
    await spawnExec(['git', 'add', 'staged.txt'], { cwd: repo })
    await writeFile(join(repo, 'unstaged.txt'), 'operator unstaged\n')
    await writeFile(join(repo, 'untracked.txt'), 'operator untracked\n')

    const out: string[] = []
    const err: string[] = []
    const code = await runCli(['upgrade', repo], {
      workspacePath: repo,
      distributionRoot: nextDist,
      processEnv: { [SELF_UPDATE_HANDOFF_ENV]: '1' },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    })

    expect(code).toBe(0)
    expect((await spawnExec(['git', 'rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()).toBe(
      before,
    )
    expect(out).toContain('ab-alpha: adopted')
    expect(out).not.toContain('ab upgrade: committed upgrade-owned changes')
    expect(err.join('\n')).toContain('automatic commit suppressed for cross-version compatibility')
    expect(err.join('\n')).toContain('parent binary did not provide a pre-self-update Git baseline')
    expect(err.join('\n')).toContain(
      'all upgrade-owned changes remain uncommitted for the operator',
    )
    expect(await readFile(join(repo, 'package.json'), 'utf8')).toContain('"autobuild":"new"')
    expect(await readFile(join(repo, 'bun.lock'), 'utf8')).toContain('"lock":"new"')
    expect(await readFile(installedSkillPath(repo, 'ab-alpha'), 'utf8')).toContain(
      'middle line two upgraded',
    )
    const status = (await spawnExec(['git', 'status', '--porcelain'], { cwd: repo })).stdout
    expect(status).toContain(' M .agents/skills/ab-alpha/SKILL.md')
    expect(status).toContain(' M package.json')
    expect(status).toContain(' M bun.lock')
    expect(status).toContain('M  staged.txt')
    expect(status).toContain(' M unstaged.txt')
    expect(status).toContain('?? untracked.txt')
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
