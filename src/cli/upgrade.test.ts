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
  defaultDistRoot,
  installedSkillPath,
  pristineSkillPath,
  readDistSkills,
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

  test('a validated local-biased resolution keeps clean edits from both sides and advances pristine', async () => {
    await install()
    const live = installedSkillPath(target, 'ab-alpha')
    const localBody = BODY
      .replace('intro line one', 'intro line one (unrelated local)')
      .replace('middle line two', 'middle line two (local conflict)')
    const localText = installedForm('alpha', localBody)
    await writeFile(live, localText)
    const upstreamBody = BODY
      .replace('middle line two', 'middle line two (upstream conflict)')
      .replace('closing line three', 'closing line three (incoming clean edit)')
    const incomingText = installedForm('alpha', upstreamBody)
    await writeDist(distV2, { alpha: upstreamBody })
    const pristineBefore = await readFile(pristineSkillPath(target, 'ab-alpha'), 'utf8')
    const resolvedText = installedForm(
      'alpha',
      BODY
        .replace('intro line one', 'intro line one (unrelated local)')
        .replace('middle line two', 'middle line two (local conflict)')
        .replace('closing line three', 'closing line three (incoming clean edit)'),
    )

    const calls: Array<{ skill: string; base: string; local: string; incoming: string }> = []
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
    expect(await readFile(pristineSkillPath(target, 'ab-alpha'), 'utf8')).toBe(
      incomingText,
    )
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
    const incomingBody = markerBody.replace(
      'conflict target',
      'conflict target (incoming)',
    )
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
    const localText = installedForm('alpha', BODY.replace('middle line two', 'middle line two (local)'))
    await writeFile(live, localText)
    await writeDist(distV2, { alpha: BODY.replace('middle line two', 'middle line two (upstream)') })

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
            .replace(
              'closing line three',
              'closing line three (incoming clean edit)',
            ),
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
        BODY
          .replace('intro line one', 'intro line one (unrelated local)')
          .replace('middle line two', 'middle line two (local conflict)'),
      )
      await writeFile(live, local)
      await writeDist(nextDist, {
        alpha: BODY
          .replace('middle line two', 'middle line two (upstream conflict)')
          .replace('closing line three', 'closing line three (incoming clean edit)'),
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
  test('the real CLI seam reports resolved and preserves the documented local bias', async () => {
    const repo = join(root, 'cli-resolved')
    const fixture = await seedRealPlanConflict(repo)
    const out: string[] = []
    const err: string[] = []
    let factoryCalls = 0

    const code = await runCli(['upgrade', repo], {
      workspacePath: target,
      processEnv: { UPGRADE_TOKEN: 'secret' },
      upgradeResolverFactory: (opts) => {
        factoryCalls += 1
        expect(opts.targetRepo).toBe(repo)
        expect(opts.env['UPGRADE_TOKEN']).toBe('secret')
        return async (input) => {
          expect(input).toEqual({
            skill: 'ab-plan',
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
    expect(err).toEqual([])
    expect(factoryCalls).toBe(1)
    expect(out).toContain('ab-plan: resolved')
    expect(await readFile(installedSkillPath(repo, 'ab-plan'), 'utf8')).toBe(
      fixture.resolved,
    )
    expect(await readFile(pristineSkillPath(repo, 'ab-plan'), 'utf8')).toBe(
      fixture.incoming,
    )
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
    expect(await readFile(installedSkillPath(repo, 'ab-plan'), 'utf8')).toBe(
      fixture.local,
    )
    expect(await readFile(pristineSkillPath(repo, 'ab-plan'), 'utf8')).toBe(
      fixture.base,
    )
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
      expect(await readFile(installedSkillPath(repo, 'ab-plan'), 'utf8')).toBe(
        fixture.local,
      )
      expect(await readFile(pristineSkillPath(repo, 'ab-plan'), 'utf8')).toBe(
        fixture.base,
      )
    }
  })

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
