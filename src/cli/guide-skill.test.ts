/**
 * `ab-guide` content guards: the seam between prose and the live schema.
 *
 * The guide claims to document EVERY autobuild.toml field and EVERY shipped
 * skill (spec ACs). Prose cannot be type-checked, so these tests hold the
 * claim to the code: add a field to src/config/schema.ts or a directory to
 * skills/ without documenting it, and the guide fails here rather than
 * shipping a quiet lie.
 *
 * The anchors are deliberately STRUCTURAL, not substring checks. `dir` is a
 * substring of "directory"; `ab-plan` is a substring of `ab-plan-review`;
 * `steps`, `model`, `url`, `command`, `skill`, `source`, `start`, and `kind`
 * are ordinary words any config guide contains whether or not the field is
 * documented. A guard that passes by accident is not a guard. So each field
 * must appear as a table row (`| \`field\` |`) INSIDE its own table's section
 * — right format, right place.
 *
 * If a guard feels awkward to satisfy, fix the guide's structure, not the
 * anchor: loosening an anchor to a substring silently restores the vacuous
 * version.
 */
import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  imageHostSchema,
  prSchema,
  finalizeAgentStepSchema,
  finalizeCheckStepSchema,
  policySchema,
  roleSchema,
  serverSchema,
  ticketsSchema,
  TOP_LEVEL_KEYS,
  TOP_LEVEL_SCALARS,
  TOP_LEVEL_TABLES,
  verifyAgentStepSchema,
  verifyCheckStepSchema,
  workspaceSchema,
} from '../config/schema'
import { readDistSkills } from './init'

const DIST_ROOT = resolve(import.meta.dir, '..', '..')
const GUIDE_PATH = join(DIST_ROOT, 'skills', 'guide', 'SKILL.md')

const guide = await readFile(GUIDE_PATH, 'utf8')

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The heading→fields map is explicit rather than derived, so a new table in
 * the schema fails the completeness assertion below instead of being silently
 * skipped by a clever traversal.
 *
 * `verifySectionSchema` is a looseObject().transform(), whose `.shape` is not
 * readable through the transform wrapper — its one known key is spelled out,
 * and both step-kind schemas fold in because [verify.<step>] is a subtable of
 * [verify]. `kind` is in both unions; one documented row satisfies it.
 */
const TABLE_FIELDS: Record<string, string[]> = {
  pr: Object.keys(prSchema.shape),
  workspace: Object.keys(workspaceSchema.shape),
  // Open map: keys are user-chosen, so only the heading is required.
  commands: [],
  server: Object.keys(serverSchema.shape),
  verify: [
    'steps',
    ...Object.keys(verifyCheckStepSchema.shape),
    ...Object.keys(verifyAgentStepSchema.shape),
  ],
  finalize: [
    'steps',
    ...Object.keys(finalizeCheckStepSchema.shape),
    ...Object.keys(finalizeAgentStepSchema.shape),
  ],
  roles: Object.keys(roleSchema.shape),
  policy: Object.keys(policySchema.shape),
  tickets: Object.keys(ticketsSchema.shape),
}

/** The guide text under a level-three heading, up to the next one. */
function headingSection(heading: string): string | undefined {
  const start = guide.indexOf(heading)
  if (start === -1) return undefined
  const after = start + heading.length
  const next = guide.indexOf('\n###', after)
  return next === -1 ? guide.slice(after) : guide.slice(after, next)
}

function sectionFor(table: string): string | undefined {
  return headingSection(`### \`[${table}]\``)
}

describe('ab-guide — autobuild.toml coverage (AC6)', () => {
  test('documents every root scalar as a structural row', () => {
    const section = headingSection('### Root scalars')
    expect(section).toBeDefined()
    const missing = TOP_LEVEL_SCALARS.filter(
      (field) => !new RegExp(`^\\| \`${escapeRegex(field)}\` \\|`, 'm').test(section ?? ''),
    )
    expect(missing, `skills/guide/SKILL.md is missing root scalar rows for: ${missing.join(', ')}`).toEqual([])
  })

  test('the scalar/table maps cover exactly the live root surface', () => {
    expect([...TOP_LEVEL_SCALARS, ...TOP_LEVEL_TABLES].sort()).toEqual(
      [...TOP_LEVEL_KEYS].sort(),
    )
    // Adding a table to the schema without mapping it here would otherwise
    // skip it entirely — the guard must fail, not shrug.
    expect(Object.keys(TABLE_FIELDS).sort()).toEqual([...TOP_LEVEL_TABLES].sort())
  })

  test('every top-level table has a section heading', () => {
    const missing = TOP_LEVEL_TABLES.filter((table) => sectionFor(table) === undefined)
    expect(missing, `skills/guide/SKILL.md is missing a \`### \`[<table>]\`\` heading for: ${missing.join(', ')}`).toEqual([])
  })

  test('every field is a documented row in its own table\'s section', () => {
    const missing: string[] = []
    for (const [table, fields] of Object.entries(TABLE_FIELDS)) {
      const section = sectionFor(table)
      if (section === undefined) continue // reported by the heading test
      for (const field of fields) {
        const row = new RegExp(`^\\| \`${escapeRegex(field)}\` \\|`, 'm')
        if (!row.test(section)) {
          missing.push(`expected a row \`| \`${field}\` | …\` under \`### \`[${table}]\`\``)
        }
      }
    }
    expect(missing, `skills/guide/SKILL.md:\n${missing.join('\n')}`).toEqual([])
  })

  test('documents every nested [pr.imageHost] field', () => {
    const section = headingSection('### `[pr.imageHost]`')
    expect(section).toBeDefined()
    for (const field of Object.keys(imageHostSchema.shape)) {
      expect(section).toMatch(
        new RegExp('^\\| `' + escapeRegex(field) + '` \\|', 'm'),
      )
    }
  })
})

describe('ab-guide — finalize publication boundary', () => {
  test('keeps local commits, clean-worktree validation, and regular push kernel-owned', () => {
    const finalize = sectionFor('finalize')
    expect(finalize).toBeDefined()
    for (const contract of [
      'select and commit its files\nlocally and leave a clean worktree',
      'regular, non-force push through the Forge port',
      'the agent never pushes',
      'An unchanged `HEAD` creates and pushes no commit',
      'file an observation while the green build continues',
    ]) {
      expect(finalize).toContain(contract)
    }
  })
})

describe('ab-guide — shipped-skill coverage (AC10)', () => {
  test('canonical and pristine guide trees stay synchronized', async () => {
    const canonical = (await readDistSkills(DIST_ROOT)).find(
      (skill) => skill.name === 'guide',
    )
    expect(canonical).toBeDefined()
    expect(canonical!.files.map((file) => file.path)).toEqual(
      canonical!.files.map((file) => file.path).sort((a, b) => a.localeCompare(b)),
    )
    for (const file of canonical!.files) {
      const pristine = await readFile(
        join(
          DIST_ROOT,
          '.agents',
          'skills',
          '.ab-pristine',
          'ab-guide',
          ...file.path.split('/'),
        ),
        'utf8',
      )
      // The live installed tree is repository-editable by design; pristine is
      // the distribution baseline that must stay synchronized for upgrades.
      expect(pristine).toBe(file.content)
    }
  })

  test('every skill in the distribution has a row in the skills rundown', async () => {
    const skills = await readDistSkills(DIST_ROOT)
    expect(skills.length).toBeGreaterThan(1)
    const missing = skills
      .map((skill) => skill.installName)
      // The closing backtick is what stops `ab-plan` from being satisfied by
      // an `ab-plan-review` row.
      .filter((name) => !new RegExp(`^\\| \`${escapeRegex(name)}\` \\|`, 'm').test(guide))
    expect(missing, `skills/guide/SKILL.md is missing a rundown row for: ${missing.join(', ')}`).toEqual([])
  })
})

describe('ab-guide — ticket grooming coverage', () => {
  test('documents every configured-source write form and its state boundary', () => {
    for (const form of [
      'ab ticket create <title> --body <file> [--labels a,b] [--blocked-by id,id]',
      'ab ticket update <id> [--title <title>] [--body <file>] [--labels a,b]',
      'ab ticket block <id> <blocker-id>',
      'ab ticket unblock <id> <blocker-id>',
    ]) {
      expect(guide).toContain(form)
    }
    expect(guide).toContain('the first id is the ticket being changed')
    expect(guide).toContain('`transition()` remains its sole owner')
    expect(guide).toContain("`--labels ''`)")
  })
})

describe('ab-guide — durable build-control coverage', () => {
  test('documents every sessionless command form beside the dashboard controls', () => {
    const missing: string[] = []
    const forms: [string, RegExp][] = [
      ['pause', /`ab pause <slug> \[--store <ref>\]`/],
      ['resume', /`ab resume <slug> \[--store <ref>\]`/],
      [
        'auto-merge',
        /`ab auto-merge <slug> on\\\|off \[--store <ref>\]`/,
      ],
      ['answer guidance', /`ab answer <slug> <text> \[--store <ref>\]`/],
      ['answer retry', /`ab answer <slug> \[--store <ref>\]`/],
      ['abort', /`ab abort <slug> \[--store <ref>\]`/],
    ]
    for (const [name, form] of forms) {
      if (!form.test(guide)) missing.push(name)
    }
    expect(
      missing,
      `skills/guide/SKILL.md is missing build-control forms for: ${missing.join(', ')}`,
    ).toEqual([])
  })

  test('names the durable event behind every control', () => {
    for (const event of [
      'build.pause-requested',
      'build.resume-requested',
      'build.auto-merge-requested',
      'build.auto-merge-cancelled',
      'escalation.answered',
      'build.abort-requested',
    ]) {
      expect(guide).toContain(`\`${event}\``)
    }
  })
})

describe('ab-guide — source-agnostic ticket operations', () => {
  test('documents every command form and machine-readable option', () => {
    for (const form of [
      '`ab ticket create <title> --body <file> [--labels a,b] [--blocked-by id,id]`',
      '`ab ticket list [--state <state>] [--labels a,b] [--json]`',
      '`ab ticket show <id> [--json]`',
      '`ab ticket move <id> <state> [--json]`',
    ]) {
      expect(guide).toContain(form)
    }
    expect(guide).toContain('a `Ticket[]` for `list`')
    expect(guide).toContain('complete `Ticket` for `show` or `move`')
  })

  test('explains defaults, filters, body output, and source-owned validation', () => {
    for (const behavior of [
      "dispatch's configured ready state and source-aware",
      'only explicitly supplied',
      'every requested label must match',
      'body verbatim',
      'State names and ids are source-local',
      "invalid state fails with the\nsource's known states",
      'error naming both the\nid and configured source',
    ]) {
      expect(guide).toContain(behavior)
    }
  })
})

describe('ab-guide — model-invocable (AC3)', () => {
  test('installs as ab-guide with no disable-model-invocation key', async () => {
    const skills = await readDistSkills(DIST_ROOT)
    const installed = skills.find((skill) => skill.name === 'guide')
    expect(installed).toBeDefined()
    const lines = installed!.content.split('\n')
    const front = lines.slice(1, lines.indexOf('---', 1))
    expect(front).toContain('name: ab-guide')
    expect(front.some((line) => line.startsWith('disable-model-invocation:'))).toBe(false)
  })
})
