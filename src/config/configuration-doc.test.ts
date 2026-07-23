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
  serverSchema,
  ticketsSchema,
  TOP_LEVEL_KEYS,
  TOP_LEVEL_SCALARS,
  TOP_LEVEL_TABLES,
  verifyAgentStepSchema,
  verifyCheckStepSchema,
  workspaceSchema,
} from './schema'
import { parseConfig } from './load'
import { resolvePlanVerifySteps } from '../kernel/plan-verify-selection'

const ROOT = resolve(import.meta.dir, '..', '..')
const DOC_PATH = join(ROOT, 'docs', 'configuration.md')
const README_PATH = join(ROOT, 'README.md')
const [doc, readme] = await Promise.all([
  readFile(DOC_PATH, 'utf8'),
  readFile(README_PATH, 'utf8'),
])

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Exact heading contents, up to the next heading at the same or higher level. */
function headingSection(
  markdown: string,
  level: number,
  heading: string,
): string | undefined {
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
  server: '`[server]`',
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
  server: Object.keys(serverSchema.shape),
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
    (field) =>
      !new RegExp(`^\\| \`${escapeRegex(field)}\` \\|`, 'm').test(section ?? ''),
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

describe('docs/configuration.md — schema coverage', () => {
  test('the explicit scalar/table maps cover exactly the root schema', () => {
    expect([...TOP_LEVEL_SCALARS, ...TOP_LEVEL_TABLES].sort()).toEqual(
      [...TOP_LEVEL_KEYS].sort(),
    )
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
    const fragments = markedTomlBlocks().filter(
      (block) => block.kind === 'config-fragment',
    )
    expect(fragments.length).toBeGreaterThan(1)
    for (const fragment of fragments) {
      const source = hasTicketsTable(fragment.source)
        ? fragment.source
        : `${fragment.source}\n\n${MINIMAL_TICKETS}`
      expect(
        () => parseConfig(source, `docs/configuration.md#${fragment.name ?? 'fragment'}`),
      ).not.toThrow()
    }
  })

  test('the delimited complete example parses as-is', () => {
    const examples = markedTomlBlocks().filter(
      (block) => block.kind === 'complete-config',
    )
    expect(examples).toHaveLength(1)
    expect(() =>
      parseConfig(examples[0]!.source, 'docs/configuration.md#complete-example'),
    ).not.toThrow()
  })

  test('the plan metadata example resolves against the complete config', () => {
    const plans = markedTomlBlocks().filter(
      (block) => block.kind === 'plan-front-matter',
    )
    const complete = markedTomlBlocks().find(
      (block) => block.kind === 'complete-config',
    )
    expect(plans).toHaveLength(1)
    expect(complete).toBeDefined()
    const config = parseConfig(complete!.source)
    expect(resolvePlanVerifySteps(`${plans[0]!.source}\n\n# Plan\n`, config)).toEqual([
      'types',
      'e2e',
    ])
  })
})

describe('README configuration entry points', () => {
  test('links the reference from Quickstart and Learn more', () => {
    const link = /\[[^\]\n]+\]\(docs\/configuration\.md\)/
    const quickstart = headingSection(readme, 2, 'Quickstart')
    const learnMore = headingSection(readme, 2, 'Learn more')
    expect(quickstart).toBeDefined()
    expect(quickstart).toMatch(link)
    expect(quickstart!.indexOf('ab init')).toBeLessThan(
      quickstart!.search(link),
    )
    expect(learnMore).toBeDefined()
    expect(learnMore).toMatch(link)
  })
})
