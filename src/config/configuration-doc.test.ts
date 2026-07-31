/**
 * Human configuration-reference drift guards.
 *
 * Field names are structural table rows scoped to their own Markdown section;
 * loose substring checks would let ordinary prose accidentally satisfy the
 * contract. Every TOML fence is also classified and parsed, so examples cannot
 * drift into a shape the shipped loader rejects.
 */
import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  finalizeAgentStepSchema,
  finalizeCheckStepSchema,
  imageHostSchema,
  policySchema,
  prSchema,
  roleSchema,
  ticketsSchema,
  TOP_LEVEL_KEYS,
  TOP_LEVEL_SCALARS,
  TOP_LEVEL_TABLES,
  verifyAgentStepSchema,
  verifyCheckStepSchema,
  workspaceSchema,
} from './schema'
import { parseConfig } from './load'
import { CONFIG_RELOAD_CLASSIFICATION, RESTART_REQUIRED_CONFIG_PATHS } from './live'
import { resolvePlanVerifySteps } from '../kernel/plan-verify-selection'
import { createProductionRuntimes } from '../ports/runner/production'
import { createRuntimeResolver } from '../ports/runner/routing'

const ROOT = resolve(import.meta.dir, '..', '..')
const DOC_PATH = join(ROOT, 'docs', 'configuration.md')
const GUIDE_PATH = join(ROOT, 'skills', 'guide', 'SKILL.md')
const README_PATH = join(ROOT, 'README.md')
const [doc, guide, readme] = await Promise.all([
  readFile(DOC_PATH, 'utf8'),
  readFile(GUIDE_PATH, 'utf8'),
  readFile(README_PATH, 'utf8'),
])

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Exact heading contents, up to the next heading at the same or higher level. */
function headingSection(markdown: string, level: number, heading: string): string | undefined {
  const marker = `${'#'.repeat(level)} ${heading}`
  const lines = markdown.split('\n')
  const boundary = new RegExp(`^#{1,${level}} `)
  let fenced = false
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (!fenced && line === marker) {
      start = index
      break
    }
  }
  if (start === -1) return undefined

  fenced = false
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end]!
    if (line.startsWith('```')) {
      fenced = !fenced
    } else if (!fenced && boundary.test(line)) {
      break
    }
    end += 1
  }
  return lines.slice(start + 1, end).join('\n')
}

function paragraphContaining(markdown: string, text: string): string | undefined {
  return markdown.split(/\n\s*\n/).find((paragraph) => paragraph.includes(text))
}

function openMapEnumeration(summary: string): string[] {
  const marker = 'The open maps are '
  const start = summary.indexOf(marker)
  if (start === -1) return []

  let inCode = false
  let end = summary.length
  for (let index = start + marker.length; index < summary.length; index += 1) {
    const character = summary[index]
    if (character === '`') {
      inCode = !inCode
    } else if (character === '.' && !inCode) {
      end = index
      break
    }
  }

  return [...summary.slice(start + marker.length, end).matchAll(/`(\[[^`\n]+\])`/g)].map(
    (match) => match[1]!,
  )
}

function unique(fields: readonly string[]): string[] {
  return [...new Set(fields)]
}

/**
 * Explicit mapping is intentional. A new root table must be added here before
 * it can receive documentation coverage; transformed/open-map sections cannot
 * be traversed safely through Zod internals.
 */
const TABLE_HEADINGS: Record<string, string> = {
  pr: '`[pr]`',
  workspace: '`[workspace]`',
  commands: '`[commands]`',
  verify: '`[verify]` and `[verify.<step>]`',
  finalize: '`[finalize]` and `[finalize.<step>]`',
  roles: '`[roles]`',
  policy: '`[policy]`',
  tickets: '`[tickets]`',
}

const TABLE_FIELDS: Record<string, string[]> = {
  pr: Object.keys(prSchema.shape),
  workspace: Object.keys(workspaceSchema.shape),
  // Open map: command names are repository-defined.
  commands: [],
  // The transformed sections hide `steps`; strict variant schemas own the
  // remaining accepted fields.
  verify: unique([
    'steps',
    ...Object.keys(verifyCheckStepSchema.shape),
    ...Object.keys(verifyAgentStepSchema.shape),
  ]),
  finalize: unique([
    'steps',
    ...Object.keys(finalizeCheckStepSchema.shape),
    ...Object.keys(finalizeAgentStepSchema.shape),
  ]),
  // Open role names all contain this one strict shape.
  roles: Object.keys(roleSchema.shape),
  policy: Object.keys(policySchema.shape),
  tickets: Object.keys(ticketsSchema.shape),
}

function tableSection(table: string): string | undefined {
  const heading = TABLE_HEADINGS[table]
  return heading === undefined ? undefined : headingSection(doc, 2, heading)
}

function expectRows(
  location: string,
  section: string | undefined,
  fields: readonly string[],
): void {
  expect(section, `${location} section is missing`).toBeDefined()
  const missing = fields.filter(
    (field) => !new RegExp(`^\\| \`${escapeRegex(field)}\` \\|`, 'm').test(section ?? ''),
  )
  expect(
    missing,
    `${location} is missing structural field rows for: ${missing.join(', ')}`,
  ).toEqual([])
}

interface MarkedToml {
  kind: 'config-fragment' | 'plan-front-matter' | 'complete-config'
  name?: string
  source: string
}

function markedTomlBlocks(): MarkedToml[] {
  const blocks: MarkedToml[] = []
  const pattern =
    /<!-- (config-fragment|plan-front-matter|complete-config)(?::([a-z0-9-]+))? -->\n```toml\n([\s\S]*?)\n```/g
  for (const match of doc.matchAll(pattern)) {
    blocks.push({
      kind: match[1] as MarkedToml['kind'],
      ...(match[2] !== undefined ? { name: match[2] } : {}),
      source: match[3]!,
    })
  }
  return blocks
}

const MINIMAL_TICKETS = '[tickets]\nsource = "file"\nreadyState = "ready"\n'

function hasTicketsTable(source: string): boolean {
  return /(?:^|\n)\[tickets\](?:\n|$)/.test(source)
}

describe('configuration strictness summaries', () => {
  test('enumerate the same complete open-map surface and its workspace exception', () => {
    const expectedSurfaces = [
      '[commands]',
      '[roles]',
      '[workspace.config]',
      '[verify.<step>]',
      '[finalize.<step>]',
    ]
    const summaries = [
      ['docs/configuration.md', paragraphContaining(doc, 'The open maps are')],
      ['skills/guide/SKILL.md', paragraphContaining(guide, 'The open maps are')],
    ] as const

    for (const [location, summary] of summaries) {
      expect(summary, `${location} strictness summary is missing`).toBeDefined()
      if (summary === undefined) continue
      expect(openMapEnumeration(summary), `${location} open-map enumeration drifted`).toEqual(
        expectedSurfaces,
      )
      expect(summary).toContain('plugin-owned')
      expect(summary).toContain('passed through unchanged')
      expect(summary).toMatch(/builtin `git-worktree` provider requires it to be\s+empty/)
      expect(summary).toMatch(/other known\s+table(?: is|s are) closed to unknown keys/)
    }
  })
})

describe('docs/configuration.md — schema coverage', () => {
  test('the explicit scalar/table maps cover exactly the root schema', () => {
    expect([...TOP_LEVEL_SCALARS, ...TOP_LEVEL_TABLES].sort()).toEqual([...TOP_LEVEL_KEYS].sort())
    expect(Object.keys(TABLE_HEADINGS).sort()).toEqual([...TOP_LEVEL_TABLES].sort())
    expect(Object.keys(TABLE_FIELDS).sort()).toEqual([...TOP_LEVEL_TABLES].sort())
  })

  test('documents every root scalar as a row in Root scalars', () => {
    expectRows(
      'docs/configuration.md / Root scalars',
      headingSection(doc, 2, 'Root scalars'),
      TOP_LEVEL_SCALARS,
    )
  })

  test('gives every top-level table an exact section and every field its own row', () => {
    for (const table of TOP_LEVEL_TABLES) {
      expectRows(
        `docs/configuration.md / [${table}]`,
        tableSection(table),
        TABLE_FIELDS[table] ?? [],
      )
    }
    expect(tableSection('commands')).toMatch(/^\| `<name>` \|/m)
  })

  test('keeps the hot/restart contract exhaustive and documented', () => {
    const section = headingSection(doc, 2, 'Reloading a running dispatcher')
    expect(section).toBeDefined()
    const classifiedRoots = Object.keys(CONFIG_RELOAD_CLASSIFICATION)
    expect(classifiedRoots.sort()).toEqual([...TOP_LEVEL_KEYS].sort())

    const classified: Array<{ path: string; behavior: 'hot' | 'restart' }> = []
    const visit = (value: unknown, path: string[] = []): void => {
      if (value === 'hot' || value === 'restart') {
        classified.push({ path: path.join('.'), behavior: value })
        return
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, [...path, key])
      }
    }
    visit(CONFIG_RELOAD_CLASSIFICATION)
    const hotTokens = classified
      .filter((entry) => entry.behavior === 'hot')
      .map((entry) =>
        !entry.path.includes('.') && !(TOP_LEVEL_SCALARS as readonly string[]).includes(entry.path)
          ? `[${entry.path}]`
          : entry.path,
      )
    expect(
      classified.filter((entry) => entry.behavior === 'restart').map((entry) => entry.path),
    ).toEqual([...RESTART_REQUIRED_CONFIG_PATHS])
    for (const token of [...hotTokens, ...RESTART_REQUIRED_CONFIG_PATHS]) {
      expect(section, `reload documentation is missing ${token}`).toContain(`\`${token}\``)
    }
  })

  test('pins the main-checkout boundary and last-valid reload recovery contract', () => {
    const surfaces = [
      ['docs/configuration.md', headingSection(doc, 2, 'Reloading a running dispatcher')],
      ['skills/guide/SKILL.md', paragraphContaining(guide, '**Live configuration**')],
    ] as const

    for (const [location, section] of surfaces) {
      expect(section, `${location} live-config contract is missing`).toBeDefined()
      expect(section).toMatch(/main checkout/)
      expect(section).toMatch(/(?:action|start) boundary/)
      expect(section).toMatch(/pipeline step/)
      expect(section).toMatch(/(?:missing|unreadable)/)
      expect(section).toMatch(/last valid (?:configuration )?snapshot/)
      expect(section).toMatch(/restor(?:e|ing)[\s\S]*valid[\s\S]*resume/i)
      expect(section).toMatch(/(?:not interrupted|without interrupting)/)
      expect(section).toMatch(/build worktree/)
    }
  })

  test('documents every nested [pr.imageHost] field structurally', () => {
    expectRows(
      'docs/configuration.md / [pr.imageHost]',
      headingSection(doc, 3, '`[pr.imageHost]`'),
      Object.keys(imageHostSchema.shape),
    )
  })

  test('does not teach any superseded table token', () => {
    for (const token of [
      '[dashboardFrames]',
      '[project]',
      '[dispatcher]',
      '[harvest]',
      '[outer]',
      '[agent]',
      '[server]',
      'needsServer',
      'ab server',
    ]) {
      expect(doc).not.toContain(token)
    }
  })
})

describe('docs/configuration.md — executable examples', () => {
  test('classifies every TOML fence', () => {
    const rawFences = [...doc.matchAll(/```toml\n[\s\S]*?\n```/g)]
    const marked = markedTomlBlocks()
    expect(marked.length).toBeGreaterThan(1)
    expect(marked).toHaveLength(rawFences.length)
  })

  test('every repository-config fragment composes with the required scaffold', () => {
    const fragments = markedTomlBlocks().filter((block) => block.kind === 'config-fragment')
    expect(fragments.length).toBeGreaterThan(1)
    for (const fragment of fragments) {
      const source = hasTicketsTable(fragment.source)
        ? fragment.source
        : `${fragment.source}\n\n${MINIMAL_TICKETS}`
      expect(() =>
        parseConfig(source, `docs/configuration.md#${fragment.name ?? 'fragment'}`),
      ).not.toThrow()
    }
  })

  test('every documented [roles] pair is one the SHIPPED runtimes actually serve', () => {
    // Parsing is not enough: runtime/model compatibility is checked by the
    // registry-aware eager resolver, a layer `parseConfig` never reaches. A
    // documented `runtime = "pi"` with an unqualified `model = "gpt-…"` parses
    // cleanly and then fails `ab dispatch` for anyone who copies it — which is
    // exactly what a worked example must not do.
    const blocks = markedTomlBlocks().filter(
      (block) => block.kind === 'config-fragment' || block.kind === 'complete-config',
    )
    const registry = createProductionRuntimes().runtimes
    let checked = 0
    for (const block of blocks) {
      const source = hasTicketsTable(block.source)
        ? block.source
        : `${block.source}\n\n${MINIMAL_TICKETS}`
      const roles = parseConfig(source, `docs/configuration.md#${block.name ?? 'fragment'}`).roles
      if (Object.keys(roles).length === 0) continue
      checked += 1
      // A fragment need not carry [roles.default]; supply the documented
      // product default so the merge has a base, exactly as a real file would.
      expect(() =>
        createRuntimeResolver(registry, { default: { runtime: 'claude' }, ...roles }),
      ).not.toThrow()
    }
    expect(checked).toBeGreaterThan(1)
  })

  test('the delimited complete example parses as-is', () => {
    const examples = markedTomlBlocks().filter((block) => block.kind === 'complete-config')
    expect(examples).toHaveLength(1)
    expect(() =>
      parseConfig(examples[0]!.source, 'docs/configuration.md#complete-example'),
    ).not.toThrow()
  })

  test('the plan metadata example resolves against the complete config', () => {
    const plans = markedTomlBlocks().filter((block) => block.kind === 'plan-front-matter')
    const complete = markedTomlBlocks().find((block) => block.kind === 'complete-config')
    expect(plans).toHaveLength(1)
    expect(complete).toBeDefined()
    const config = parseConfig(complete!.source)
    expect(resolvePlanVerifySteps(`${plans[0]!.source}\n\n# Plan\n`, config)).toEqual([
      'types',
      'e2e',
    ])
  })
})

describe('docs/configuration.md — init behavior', () => {
  test('documents the stack-neutral skeleton and agent handoff', () => {
    const section = headingSection(doc, 2, 'What `ab init` generates')
    expect(section).toBeDefined()
    expect(section).toContain('stack-neutral skeleton')
    expect(section).toContain('product preference `claude`, then `codex`, then `pi`')
    expect(section).toContain('empty `[commands]`')
    expect(section).toContain('same setup pointer prompt verbatim')
    expect(section).toContain('.agents/skills/ab-guide/references/setup.md')
    expect(section).toContain('11 skills')
    expect(section).toContain('only `ab-spec`, `ab-tickets`, and `ab-guide`')
    expect(section).toContain('does not reconcile or overwrite')
    expect(section).not.toContain('bun run lint')
    expect(section).not.toContain('--role-profile')
  })
})

describe('README configuration entry points', () => {
  test('links the reference from Quickstart and Learn more', () => {
    const link = /\[[^\]\n]+\]\(docs\/configuration\.md\)/
    const quickstart = headingSection(readme, 2, 'Quickstart')
    const learnMore = headingSection(readme, 2, 'Learn more')
    expect(quickstart).toBeDefined()
    expect(quickstart).toMatch(link)
    expect(quickstart!.indexOf('ab init')).toBeLessThan(quickstart!.search(link))
    expect(learnMore).toBeDefined()
    expect(learnMore).toMatch(link)
  })
})
