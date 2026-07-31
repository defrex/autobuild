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
  ticketsSchema,
  TOP_LEVEL_KEYS,
  TOP_LEVEL_SCALARS,
  TOP_LEVEL_TABLES,
  verifyAgentStepSchema,
  verifyCheckStepSchema,
  workspaceSchema,
} from '../config/schema'
import { readDistSkills } from './init'
import { parseConfig } from '../config/load'
import { createProductionRuntimes } from '../ports/runner/production'
import { createRuntimeResolver } from '../ports/runner/routing'

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
    expect(
      missing,
      `skills/guide/SKILL.md is missing root scalar rows for: ${missing.join(', ')}`,
    ).toEqual([])
  })

  test('the scalar/table maps cover exactly the live root surface', () => {
    expect([...TOP_LEVEL_SCALARS, ...TOP_LEVEL_TABLES].sort()).toEqual([...TOP_LEVEL_KEYS].sort())
    // Adding a table to the schema without mapping it here would otherwise
    // skip it entirely — the guard must fail, not shrug.
    expect(Object.keys(TABLE_FIELDS).sort()).toEqual([...TOP_LEVEL_TABLES].sort())
  })

  test('every top-level table has a section heading', () => {
    const missing = TOP_LEVEL_TABLES.filter((table) => sectionFor(table) === undefined)
    expect(
      missing,
      `skills/guide/SKILL.md is missing a \`### \`[<table>]\`\` heading for: ${missing.join(', ')}`,
    ).toEqual([])
  })

  test('does not teach removed dev-server configuration', () => {
    expect(guide).not.toContain('`[server]`')
    expect(guide).not.toContain('`needsServer`')
    expect(guide).not.toContain('`ab server')
  })

  test("every field is a documented row in its own table's section", () => {
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
      expect(section).toMatch(new RegExp(`^\\| \`${escapeRegex(field)}\` \\|`, 'm'))
    }
  })
})

describe('ab-guide — worked config examples actually work', () => {
  test('every [roles] example names a runtime/model pair the SHIPPED runtimes serve', () => {
    // The guide has no fence-classification test, so a worked example here can
    // drift into a shape that parses and then fails eager resolution for anyone
    // who copies it. Runtime/model compatibility lives a layer past
    // `parseConfig`, in the registry-aware resolver, so this checks both.
    const fences = [...guide.matchAll(/```toml\n([\s\S]*?)\n```/g)]
      .map((match) => match[1]!)
      .filter((source) => source.includes('[roles.'))
    expect(fences.length).toBeGreaterThan(1)
    const registry = createProductionRuntimes().runtimes
    for (const source of fences) {
      const roles = parseConfig(
        `${source}\n\n[tickets]\nsource = "file"\nreadyState = "ready"\n`,
        'skills/guide/SKILL.md',
      ).roles
      expect(Object.keys(roles).length).toBeGreaterThan(0)
      // A fragment need not carry [roles.default]; supply the product default
      // so the per-field merge has a base, exactly as a real file would.
      expect(() =>
        createRuntimeResolver(registry, { default: { runtime: 'claude' }, ...roles }),
      ).not.toThrow()
    }
  })
})

describe('ab-guide — init behavior', () => {
  test('teaches the neutral skeleton and non-phase setup handoff', () => {
    const commands = sectionFor('commands')
    const setup = headingSection('## Setup and upgrades')
    expect(commands).toContain('Fresh init config deliberately leaves this map empty')
    expect(commands).toContain('deterministic init code never guesses')
    expect(setup).toContain('`claude`, `codex`, then `pi`')
    expect(setup).toContain('with empty\n  `[commands]`')
    expect(setup).toContain('[repository setup reference](references/setup.md)')
    expect(setup).toContain('Vendors 11 skills before handoff')
    expect(setup).toContain('(`ab-spec`, `ab-tickets`, `ab-guide`)')
    expect(setup).toContain('creates no build, session, event,\n  transcript, or BuildStore record')
  })
})

describe('ab-guide — dispatch dashboard summary', () => {
  test('documents the live queue and pressure-counter grammar', () => {
    const section = headingSection('## Dispatch dashboard')
    expect(section).toBeDefined()
    const compact = section?.replace(/\s+/g, ' ') ?? ''
    expect(compact).toContain('`queue <depth> | active <current>/<limit> | obs <current>/<limit>`')
    expect(compact).toContain('`queue` is the ready-ticket queue depth')
    expect(compact).toContain(
      '`active` is the current nonterminal-build count against root `capacity`',
    )
    expect(compact).toContain(
      '`obs` is the current count of recorded observation occurrences not yet claimed by a Harvest snapshot against `[policy].harvestThreshold`',
    )
    expect(compact).toContain('conditional yellow `repository PAUSED` segment')
    expect(compact).toContain('only queued rows gain a yellow `(held)` modifier beside `QUEUED`')
    expect(compact).toContain(
      'intake being off without that hold shows neither `repository PAUSED` nor `(held)`',
    )
    expect(compact).toContain(
      'an already-paused repository shows `repository PAUSED` and `(held)` on its first paint',
    )
    expect(compact).not.toContain('basename, queue depth, and active-build count')
  })
})

describe('ab-guide — persistence marking', () => {
  /**
   * The guide and the three review skills must give one answer about what
   * `persists` means, because an agent reads whichever it reaches first. The
   * two phrases below are literal shared text: `review-skills.test.ts`
   * asserts them against `plan-review`, `code-review`, and `harvest-review`,
   * this asserts them against `ab-guide`, so neither side can be reworded
   * alone.
   */
  const SHARED_WITH_REVIEW_SKILLS = [
    'still present in the work under review',
    'defect class whose reported instance was fixed is fresh work and starts its own chain',
  ]

  test('the `[policy]` section scopes `stallRounds` to a surviving disagreement', () => {
    const section = sectionFor('policy')
    expect(section).toBeDefined()
    const compact = section?.replace(/\s+/g, ' ') ?? ''
    for (const claim of [
      '`stallRounds` counts *persistence chains*, which reviewers mark and the kernel only follows.',
      "A finding's `persists` ids name prior-round findings whose defect is still present in the work under review; a new instance of a defect class whose reported instance was fixed is fresh work and starts its own chain, however closely it resembles its predecessor.",
      'So the counter measures a producer/reviewer stalemate rather than a defect category the loop keeps converging on, and the kernel decides only whether a marked chain has survived the threshold — never whether two findings are the same disagreement.',
      ...SHARED_WITH_REVIEW_SKILLS,
    ]) {
      expect(compact).toContain(claim)
    }
  })
})

describe('ab-guide — review severity calibration', () => {
  /**
   * `headingSection()` stops at the next `###`, which for a level-two heading
   * with no level-three children would run past two later `##` sections. This
   * slices `## The lifecycle` to the next level-two heading instead, so
   * asserting placement inside it is a real claim. `\n## ` cannot match a
   * `###` heading, so the scan is safe.
   */
  function lifecycleSection(): string | undefined {
    const heading = '## The lifecycle'
    const start = guide.indexOf(heading)
    if (start === -1) return undefined
    const after = start + heading.length
    const next = guide.indexOf('\n## ', after)
    return next === -1 ? guide.slice(after) : guide.slice(after, next)
  }

  /**
   * The guide and the two review skills must give one answer about what
   * severity measures, because an agent reads whichever it reaches first. The
   * four phrases below are literal shared text: `review-skills.test.ts`
   * asserts them against `plan-review` and `code-review`, this asserts them
   * against `ab-guide`, so neither side can be reworded alone.
   */
  const SHARED_WITH_REVIEW_SKILLS = [
    "the spec's acceptance criteria and the realistic operating conditions of the work under review",
    'puts no acceptance criterion at risk, breaks no stated invariant, and is unreachable under realistic input is `ab observe`, not a finding',
    'raise a bar the spec set',
    'does not promise to handle is `minor` or an observation, unless a security boundary, an acceptance criterion, or a stated invariant makes it material',
  ]

  test('the lifecycle section rates findings by proportion to the spec', () => {
    const section = lifecycleSection()
    expect(section).toBeDefined()
    const compact = section?.replace(/\s+/g, ' ') ?? ''
    for (const claim of [
      '**Review severity is proportion to the spec.**',
      '`blocking` names an acceptance criterion the defect defeats, `important` names a criterion or stated invariant it puts at material risk.',
      'work carrying such observations is approvable',
      ...SHARED_WITH_REVIEW_SKILLS,
    ]) {
      expect(compact).toContain(claim)
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
  test('canonical guide tree remains deterministic while repo-vendored copies may diverge', async () => {
    const canonical = (await readDistSkills(DIST_ROOT)).find((skill) => skill.name === 'guide')
    expect(canonical).toBeDefined()
    expect(canonical!.files.map((file) => file.path)).toEqual(
      canonical!.files.map((file) => file.path).sort((a, b) => a.localeCompare(b)),
    )
  })

  test('every skill in the distribution has a row in the skills rundown', async () => {
    const skills = await readDistSkills(DIST_ROOT)
    expect(skills).toHaveLength(11)
    const missing = skills
      .map((skill) => skill.installName)
      // The closing backtick is what stops `ab-plan` from being satisfied by
      // an `ab-plan-review` row.
      .filter((name) => !new RegExp(`^\\| \`${escapeRegex(name)}\` \\|`, 'm').test(guide))
    expect(
      missing,
      `skills/guide/SKILL.md is missing a rundown row for: ${missing.join(', ')}`,
    ).toEqual([])
  })
})

describe('ab-guide — ticket grooming coverage', () => {
  test('documents every configured-source write form and its state boundary', () => {
    for (const form of [
      'ab ticket create <title> --body <file> [--state <state>] [--labels a,b] [--blocked-by id,id]',
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

describe('ab-guide — repository settings status', () => {
  test('documents the sessionless form, all settings, and empty-journal defaults', () => {
    const compact = guide.replace(/\s+/g, ' ')
    for (const contract of [
      '`ab repository status [--json] [--store <ref>]`',
      'ticket intake (`intake`, default `true`)',
      'repository-wide pause (`paused`, default `false`)',
      'claim-time auto-merge default (`defaultAutoMerge`, default `false`)',
      'repository with no journal row',
      'writes no state',
      'starts no dispatcher work',
    ]) {
      expect(compact).toContain(contract)
    }
  })
})

describe('ab-guide — durable build-control coverage', () => {
  test('documents every sessionless command form beside the dashboard controls', () => {
    const missing: string[] = []
    const forms: [string, RegExp][] = [
      ['pause', /`ab pause <slug> \[--store <ref>\]`/],
      ['resume', /`ab resume <slug> \[--store <ref>\]`/],
      ['auto-merge', /`ab auto-merge <slug> on\\\|off \[--store <ref>\]`/],
      ['answer guidance', /`ab answer <slug> <text> \[--store <ref>\]`/],
      ['answer retry', /`ab answer <slug> \[--store <ref>\]`/],
      ['abort', /`ab abort <slug> \[--store <ref>\]`/],
      ['pause all', /`ab pause --all \[--store <ref>\] \[--json\]`/],
      ['resume all', /`ab resume --all \[--store <ref>\] \[--json\]`/],
    ]
    for (const [name, form] of forms) {
      if (!form.test(guide)) missing.push(name)
    }
    expect(
      missing,
      `skills/guide/SKILL.md is missing build-control forms for: ${missing.join(', ')}`,
    ).toEqual([])
  })

  test('states both verify escalation guidance routes and bare retry behavior', () => {
    const compact = guide.replace(/\s+/g, ' ')
    for (const contract of [
      "guidance answering an agent verifier's own `ab escalate` returns to that same `verify:<step>`",
      '`verify.started.feedback`',
      'materializes as `.ab/guidance.json`',
      'the cited start carries it durably across any pre-launch recovery',
      'the matching `session.started` consumes it once after launch',
      'policy escalation after exhausted failed verify reports instead goes to `implement` and outranks the pending report',
      'A bare retry on either path carries no guidance',
    ]) {
      expect(compact).toContain(contract)
    }
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

  // The operator-side account of `ab answer` has to join up with the agent-side
  // contract the receiving skills state, or the guide teaches a mechanism that
  // appears to end at the event log.
  test('says where an answer lands for the agent and which phase consumes it', () => {
    const section = headingSection('### Durable build controls: CLI and dashboard')
    expect(section).toBeDefined()
    for (const claim of [
      '`.ab/guidance.json`',
      'feeds the next `plan` round',
      'An escalation from `implement` or `code-review`',
      "An agent verifier's own escalation feeds the next run of that same",
      'policy escalation instead feeds the next `implement` round and takes',
      "A producer round's feedback is exclusive",
    ]) {
      expect(section ?? '').toContain(claim)
    }
    expect(section ?? '').not.toContain('A direct verifier escalation is a known gap')
  })
})

describe('ab-guide — source-agnostic ticket operations', () => {
  test('documents every command form and machine-readable option', () => {
    for (const form of [
      '`ab ticket create <title> --body <file> [--state <state>] [--labels a,b] [--blocked-by id,id]`',
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
      'Without `--state`, the source uses `[tickets].createState`',
      'passed through unchanged',
      'validates it before creating anything',
      'checked before the single create call',
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
