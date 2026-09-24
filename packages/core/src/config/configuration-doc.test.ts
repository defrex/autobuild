/**
 * Human configuration-reference drift guards.
 *
 * Field names are structural table rows scoped to their own Markdown section;
 * loose substring checks would let ordinary prose accidentally satisfy the
 * contract. Every TOML fence is also classified and parsed, so examples cannot
 * drift into a shape the shipped loader rejects.
 */
import { describe, expect, test } from 'bun:test'
import { stringify } from 'smol-toml'
import { type Dirent, readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import {
  type RuntimeProvisioningEntry,
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
  vercelSandboxConfigSchema,
  runtimeProvisioningEntrySchema,
  workspaceSchema,
} from './schema'
import { parseConfig } from './load'
import { CONFIG_RELOAD_CLASSIFICATION, RESTART_REQUIRED_CONFIG_PATHS } from './live'
import { resolvePlanVerifySteps } from '../kernel/plan-verify-selection'
import { createProductionRuntimes } from '../ports/runner/production'
import { createRuntimeResolver } from '../ports/runner/routing'

const ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const DOC_PATH = join(ROOT, 'docs', 'configuration.md')
const SETUP_DOC_PATH = join(ROOT, 'docs', 'setup.md')
const GUIDE_PATH = join(ROOT, 'skills', 'guide', 'SKILL.md')
const GUIDE_SETUP_PATH = join(ROOT, 'skills', 'guide', 'references', 'setup.md')
const README_PATH = join(ROOT, 'README.md')
const AUTOBUILD_PATH = join(ROOT, 'autobuild.toml')
const [doc, guide, readme, setupDoc, guideSetup, autobuildToml] = await Promise.all([
  readFile(DOC_PATH, 'utf8'),
  readFile(GUIDE_PATH, 'utf8'),
  readFile(README_PATH, 'utf8'),
  readFile(SETUP_DOC_PATH, 'utf8'),
  readFile(GUIDE_SETUP_PATH, 'utf8'),
  readFile(AUTOBUILD_PATH, 'utf8'),
])

/**
 * Render a value as a TOML basic-string assignment, matching the doc fence
 * bytes.
 *
 * Contract: single-line basic strings only. Escaping is smol-toml's canonical
 * basic-string form — the same library that parses these files — so the
 * helper is a general TOML basic-string renderer: backslash, double quote,
 * and every control character are escaped, with the compact \b/\t/\f/\n/\r
 * forms where defined and `\uXXXX` (lowercase hex) otherwise, DEL included.
 * Non-ASCII passes through raw, as in TOML and the doc fences.
 *
 * Multi-line/triple-quoted TOML values are out of contract: doc fences
 * render a multi-line command as a triple-quoted block whose bytes this
 * one-line renderer can never match, so a raw TOML line break — LF or
 * CRLF — throws instead of deriving expectation bytes that can only
 * mismatch. A lone raw CR is not a TOML line break: it renders as the
 * compact \r escape in a single-line basic string, matching what
 * smol-toml produces for the same value. The suite must not call this
 * helper with a multi-line value; the guard makes a violation loud.
 * `key` must be a bare key (today's call sites: install, preflight).
 */
function tomlBasicStringLine(key: string, value: string): string {
  if (/[\n]/.test(value)) {
    throw new Error(
      `tomlBasicStringLine(${key}): value contains a line break — the helper renders single-line TOML basic strings only; multi-line/triple-quoted values are out of contract`,
    )
  }
  return stringify({ [key]: value }).replace(/\n$/, '')
}

/**
 * Version pinned by a raw-text setup.md install line. Applies only to the raw
 * doc surfaces — the AUT-455 regex shape expects the literal
 * `install = "npm install …"` prefix that exists only in the file text.
 */
function versionFromDocInstallLine(surface: string, location: string): string {
  const version =
    /install = "npm install --global --ignore-scripts @earendil-works\/pi-coding-agent@([^"\\\s]+)"/.exec(
      surface,
    )?.[1]
  if (version === undefined) {
    throw new Error(`${location} does not pin a pi-coding-agent version on its install line`)
  }
  return version
}

/**
 * Version pinned by a parsed runtimeProvisioning install command. Applies only
 * to `parseConfig` output — parsed values carry no TOML `install = "` line
 * prefix, so the doc helper above must never be applied to them.
 */
function versionFromInstallCommand(command: string): string {
  const version = /@earendil-works\/pi-coding-agent@([^"\\\s]+)/.exec(command)?.[1]
  if (version === undefined) {
    throw new Error(
      `runtimeProvisioning install command does not pin a pi-coding-agent version: ${command}`,
    )
  }
  return version
}

/**
 * AUT-471: repository-wide scan for `@earendil-works/pi-coding-agent@<version>`
 * pins. The two-surface cross-check below guards only the setup.md copies;
 * this scan extends the same contract to every file pinning the literal in an
 * install or preflight line, with autobuild.toml's
 * `[workspace.config.runtimeProvisioning.pi]` block as the single source of
 * truth. Both patterns are pinned byte shapes:
 *
 * - the install pattern requires the `npm install …` line context, keeping
 *   prose quotes and changelog history out;
 * - the preflight pattern is anchored to a `preflight =` TOML assignment and
 *   matches exactly the escaped-quote (`\\"`) byte form shared by
 *   autobuild.toml and every doc copy — never a raw-quote template in test
 *   source.
 *
 * If a future site adopts a different quoting style, the completeness floor in
 * the scan test fails loudly and forces a deliberate regex update instead of
 * silently losing coverage.
 */
const PI_PIN_INSTALL_LINE = /npm install [^"'`]*@earendil-works\/pi-coding-agent@([^"'\s\\]+)/
const PI_PIN_PREFLIGHT_LINE = /^preflight = "test \\"\$\(pi --version\)\\" = \\"([^"\\]+)\\"/

/** Directories the Pi-pin walk never descends into. */
const PI_PIN_WALK_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.ab',
  '.autobuild',
  '.autobuild-dist',
  '.next',
  '.vercel',
  'dist',
  'coverage',
])

/** Files excluded from the Pi-pin walk, by repo-relative path. */
const PI_PIN_WALK_SKIP_FILES = new Set([
  // This guard's own source: its regex literals and the synthetic-fixture
  // templates contain the exact matched byte shapes, so the scan would flag
  // the very file that implements it. Guard-internal literals are deliberately
  // uncovered; the scan test pins this path so a rename fails loudly.
  'packages/core/src/config/configuration-doc.test.ts',
  // Historical record: a quoted old install line is correct history, not drift.
  'CHANGELOG.md',
])

/**
 * The nine enumerated pinning sites (plan-time grep, AUT-471). The scan test's
 * completeness floor requires an install-line and a preflight-line match at
 * the expected version in each of them, so the floor doubles as the
 * machine-checked form of the grep-at-implementation-time requirement.
 */
const PI_PIN_SURFACES = [
  'autobuild.toml',
  'docs/configuration.md',
  'docs/setup.md',
  'skills/guide/SKILL.md',
  'skills/guide/references/setup.md',
  '.agents/skills/ab-guide/SKILL.md',
  '.agents/skills/ab-guide/references/setup.md',
  '.agents/skills/.ab-pristine/ab-guide/SKILL.md',
  '.agents/skills/.ab-pristine/ab-guide/references/setup.md',
] as const

interface PiPinScan {
  /** `file:line … pins … expected …` for every diverging install or preflight pin. */
  divergences: string[]
  /** Repo-relative paths with at least one install line pinning the expected version. */
  installPinned: ReadonlySet<string>
  /** Repo-relative paths with at least one preflight line pinning the expected version. */
  preflightPinned: ReadonlySet<string>
}

/** Pure scan over a path→content map; unit-tested on synthetic fixtures below. */
function scanPiInstallPins(files: ReadonlyMap<string, string>, expectedVersion: string): PiPinScan {
  const divergences: string[] = []
  const installPinned = new Set<string>()
  const preflightPinned = new Set<string>()
  for (const [path, content] of files) {
    const lines = content.split('\n')
    for (const [index, line] of lines.entries()) {
      const lineNumber = index + 1
      const install = PI_PIN_INSTALL_LINE.exec(line)
      if (install !== null) {
        const found = install[1]!
        if (found === expectedVersion) {
          installPinned.add(path)
        } else {
          divergences.push(
            `${path}:${lineNumber} install line pins @earendil-works/pi-coding-agent@${found}, expected ${expectedVersion} (autobuild.toml runtimeProvisioning.pi)`,
          )
        }
      }
      const preflight = PI_PIN_PREFLIGHT_LINE.exec(line)
      if (preflight !== null) {
        const found = preflight[1]!
        if (found === expectedVersion) {
          preflightPinned.add(path)
        } else {
          divergences.push(
            `${path}:${lineNumber} preflight pins ${found}, expected ${expectedVersion} (autobuild.toml runtimeProvisioning.pi)`,
          )
        }
      }
    }
  }
  return { divergences, installPinned, preflightPinned }
}

/**
 * Walk the repository from `root`, pruning skipped directories and files.
 * Symlinks are never followed: the walk vouches for real tree members only.
 * Unreadable or binary files are skipped here; the completeness floor still
 * requires every enumerated surface, so a site that becomes unreadable fails
 * loudly in the scan test.
 */
function walkRepositoryFiles(root: string): Map<string, string> {
  const files = new Map<string, string>()
  const visit = (directory: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!PI_PIN_WALK_SKIP_DIRS.has(entry.name)) visit(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      const repoPath = relative(root, fullPath).split(sep).join('/')
      if (PI_PIN_WALK_SKIP_FILES.has(repoPath)) continue
      try {
        const bytes = readFileSync(fullPath)
        // Cheap binary sniff: a NUL byte in the leading block means this is
        // not a doc surface; decoding it cannot produce a pin anyway.
        if (bytes.subarray(0, 8000).includes(0)) continue
        files.set(repoPath, bytes.toString('utf8'))
      } catch {
        // Unreadable: the walk cannot vouch for it; the floor catches a
        // skipped enumerated surface.
      }
    }
  }
  visit(root)
  return files
}

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
  orchestrator: '`[orchestrator]`',
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
  orchestrator: ['enabled', 'model', 'invocationBudgetSeconds', 'approvals', 'wake', 'sandbox'],
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

describe('Vercel runtime provisioning documentation', () => {
  test('covers every built-in and nested provisioning field structurally', () => {
    const section = headingSection(doc, 3, 'Vercel Sandbox')
    expectRows(
      'docs/configuration.md Vercel Sandbox',
      section,
      Object.keys(vercelSandboxConfigSchema.shape),
    )
    expectRows(
      'docs/configuration.md runtime provisioning',
      section,
      Object.keys(runtimeProvisioningEntrySchema.shape),
    )
    expect(section).toContain('@earendil-works/pi-coding-agent@0.84.4')
    expect(section).toContain('AI_GATEWAY_API_KEY')
    expect(section).toContain('plugin')
  })

  test('pins the delivered preflight example in every canonical surface', () => {
    // The delivered runtimeProvisioning preflight refreshes the model catalog
    // (`&& pi update --models`); a bare exact-version preflight copied from
    // these surfaces would silently lose that refresh. Both expected lines are
    // derived from autobuild.toml's [workspace.config.runtimeProvisioning.pi]
    // block — the delivered configuration — so any change to the shipped
    // install or preflight command without a matching doc update fails here,
    // in either direction. The helper re-escapes into TOML basic-string form,
    // reproducing the raw `\"` escape bytes the doc fences use.
    const config = parseConfig(autobuildToml)
    const pi = vercelSandboxConfigSchema.parse(config.workspace.config).runtimeProvisioning.pi
    if (pi === undefined) {
      throw new Error('autobuild.toml has no [workspace.config.runtimeProvisioning.pi] block')
    }

    const surfaces = [
      ['docs/configuration.md Vercel Sandbox', headingSection(doc, 3, 'Vercel Sandbox')],
      ['docs/setup.md', setupDoc],
      ['skills/guide/SKILL.md', guide],
      ['skills/guide/references/setup.md', guideSetup],
    ] as const

    for (const [location, surface] of surfaces) {
      expect(surface, `${location} is missing`).toBeDefined()
      expect(
        surface,
        `${location} install example drifted from the delivered runtimeProvisioning command`,
      ).toContain(tomlBasicStringLine('install', pi.install))
      expect(
        surface,
        `${location} preflight example drifted from the delivered runtimeProvisioning command`,
      ).toContain(tomlBasicStringLine('preflight', pi.preflight))
    }
  })

  test('keeps the two setup.md copies byte-identical', () => {
    // docs/setup.md and the skill reference are checked-in duplicates: the
    // skill copy ships verbatim inside the guide skill, so any one-sided edit
    // silently diverges what user repos read. Full-file parity is the chosen
    // granularity — the strongest option, and the one that makes any single
    // copy edit fail.
    expect(
      setupDoc,
      'docs/setup.md and skills/guide/references/setup.md drifted apart; apply the edit to both copies',
    ).toBe(guideSetup)
  })

  test("cross-checks the doc Pi version against autobuild.toml's runtimeProvisioning install line", () => {
    // AUT-455's pin derives each surface's version from its own install line,
    // so a bump that updates every doc copy but stales autobuild.toml (or the
    // reverse) passes everywhere. This test is the cross-check: the raw-text
    // doc install lines are pinned against the parsed repository config, and
    // the config's own preflight is pinned against its install line so every
    // version literal in the doc examples matches autobuild.toml.
    // This loop covers only the two setup.md copies; the sibling walk test
    // below is the complete guard across every pinning site (AUT-471).
    const parsed = parseConfig(autobuildToml, AUTOBUILD_PATH)
    const config = parsed.workspace.config as {
      runtimeProvisioning?: Record<string, RuntimeProvisioningEntry>
    }
    const pi = config.runtimeProvisioning?.pi
    if (pi === undefined) {
      throw new Error('autobuild.toml is missing [workspace.config.runtimeProvisioning.pi]')
    }
    const version = versionFromInstallCommand(pi.install)
    for (const [location, surface] of [
      ['docs/setup.md', setupDoc],
      ['skills/guide/references/setup.md', guideSetup],
    ] as const) {
      expect(
        versionFromDocInstallLine(surface, location),
        `${location} install-line version drifted from autobuild.toml's runtimeProvisioning.pi install line`,
      ).toBe(version)
    }
    // The parsed preflight carries real `"` characters (the TOML `\\"` escape
    // bytes are unescaped by parsing), so match plain quotes around the
    // interpolated version — never the raw-file `\\"` form.
    expect(pi.preflight, 'autobuild.toml preflight drifted from its own install line').toContain(
      `= "${version}"`,
    )
  })

  test('cross-checks every repository file pinning the install or preflight literal', () => {
    // AUT-471: the two-surface loop above guards only the setup.md copies.
    // Five more surfaces pin the same literal — docs/configuration.md's Vercel
    // Sandbox example, skills/guide/SKILL.md, and the .agents self-install and
    // pristine copies of the guide skill — and the spec requires coverage for
    // any additional site a grep finds at implementation time, forever. Rather
    // than an enumeration that can itself go stale, this walk scans the whole
    // repository and asserts every install/preflight pin equals autobuild.toml's
    // runtimeProvisioning.pi version, failing once with every diverging
    // file:line. The completeness floor at the end requires install and
    // preflight matches in every enumerated site, so regex rot or a changed
    // line shape fails loudly instead of silently covering nothing.
    const parsed = parseConfig(autobuildToml, AUTOBUILD_PATH)
    const config = parsed.workspace.config as {
      runtimeProvisioning?: Record<string, RuntimeProvisioningEntry>
    }
    const pi = config.runtimeProvisioning?.pi
    if (pi === undefined) {
      throw new Error('autobuild.toml is missing [workspace.config.runtimeProvisioning.pi]')
    }
    const version = versionFromInstallCommand(pi.install)

    // The host file sits on the walk's skip list; if it moves or renames, the
    // exclusion would dangle silently and the fixtures below would be scanned
    // as if they were real pins — fail instead.
    expect(
      relative(ROOT, import.meta.path)
        .split(sep)
        .join('/'),
      'the Pi-pin scan test file moved; update PI_PIN_WALK_SKIP_FILES',
    ).toBe('packages/core/src/config/configuration-doc.test.ts')

    const scan = scanPiInstallPins(walkRepositoryFiles(ROOT), version)
    expect(
      scan.divergences,
      `Pi version pins diverged from autobuild.toml's runtimeProvisioning.pi (${version}):\n${scan.divergences.join('\n')}`,
    ).toEqual([])

    const uncovered = PI_PIN_SURFACES.filter(
      (surface) => !scan.installPinned.has(surface) || !scan.preflightPinned.has(surface),
    )
    expect(
      uncovered,
      'the Pi-pin walk lost install/preflight coverage of enumerated sites; a line shape changed — update the pinned regexes deliberately',
    ).toEqual([])
  })
})

describe('tomlBasicStringLine — basic-string rendering', () => {
  test('derives the delivered install/preflight lines byte-identically', () => {
    expect(
      tomlBasicStringLine(
        'install',
        'npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.84.4',
      ),
    ).toBe(
      'install = "npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.84.4"',
    )
    expect(
      tomlBasicStringLine('preflight', 'test "$(pi --version)" = "0.84.4" && pi update --models'),
    ).toBe('preflight = "test \\"$(pi --version)\\" = \\"0.84.4\\" && pi update --models"')
    expect(tomlBasicStringLine('k', '')).toBe('k = ""')
  })

  test('escapes control characters per the TOML basic-string rules', () => {
    // Pinned forms are smol-toml stringify's canonical forms: compact \t
    // where defined, lowercase-hex \uXXXX otherwise (DEL included).
    expect(tomlBasicStringLine('k', 'a\tb\u007Fc\u000Bd')).toBe('k = "a\\tb\\u007fc\\u000bd"')
  })

  test('escapes backslash and quote', () => {
    expect(tomlBasicStringLine('k', 'a\\b"c')).toBe('k = "a\\\\b\\"c"')
  })

  test('renders a lone raw CR as an escaped single-line value', () => {
    // A lone CR is not a TOML line break (TOML line breaks are LF or
    // CRLF), so it renders like any other control character, in smol-toml's
    // compact \r form inside a single-line basic string.
    expect(tomlBasicStringLine('k', 'a\rb')).toBe('k = "a\\rb"')
  })

  test('refuses values with TOML line breaks (LF or CRLF) instead of deriving unmatchable bytes', () => {
    expect(() => tomlBasicStringLine('k', 'one\ntwo')).toThrow(/single-line/)
    expect(() => tomlBasicStringLine('k', 'one\r\ntwo')).toThrow(/single-line/)
  })
})

describe('Pi install-pin scan — synthetic fixtures', () => {
  const EXPECTED = '0.84.4'
  const installLine = (version: string): string =>
    `install = "npm install --global --ignore-scripts @earendil-works/pi-coding-agent@${version}"`
  // Byte form taken verbatim from autobuild.toml's preflight line: a TOML
  // basic string whose quotes are raw backslash-quote escapes in the file.
  const preflightLine = (version: string): string =>
    `preflight = "test \\"$(pi --version)\\" = \\"${version}\\" && pi update --models"`

  test('reports a diverging install line with its path and line number', () => {
    const scan = scanPiInstallPins(
      new Map([
        ['docs/setup.md', `line one\n${installLine(EXPECTED)}\n${installLine('0.83.0')}`],
        ['unrelated.md', 'no pins here'],
      ]),
      EXPECTED,
    )
    expect(scan.divergences).toEqual([
      'docs/setup.md:3 install line pins @earendil-works/pi-coding-agent@0.83.0, expected 0.84.4 (autobuild.toml runtimeProvisioning.pi)',
    ])
    expect(scan.installPinned).toEqual(new Set(['docs/setup.md']))
  })

  test('reports a diverging preflight token', () => {
    const scan = scanPiInstallPins(
      new Map([['docs/setup.md', `${installLine(EXPECTED)}\n${preflightLine('0.83.0')}`]]),
      EXPECTED,
    )
    expect(scan.divergences).toEqual([
      'docs/setup.md:2 preflight pins 0.83.0, expected 0.84.4 (autobuild.toml runtimeProvisioning.pi)',
    ])
    expect(scan.preflightPinned).toEqual(new Set())
  })

  test('parses the escaped-quote preflight byte form', () => {
    const scan = scanPiInstallPins(
      new Map([['autobuild.toml', `${installLine(EXPECTED)}\n${preflightLine(EXPECTED)}`]]),
      EXPECTED,
    )
    expect(scan.divergences).toEqual([])
    expect(scan.installPinned).toEqual(new Set(['autobuild.toml']))
    expect(scan.preflightPinned).toEqual(new Set(['autobuild.toml']))
  })

  test('a raw-quote preflight template is never matched', () => {
    // The scan reads raw file bytes, where the pin is the escaped-quote TOML
    // assignment form. A raw-quote template like the one in
    // tools/vercel-consumer-config.test.ts begins with `expect(`, not
    // `preflight =`, so the anchored pattern cannot produce a false divergence.
    const scan = scanPiInstallPins(
      new Map([
        ['fixture.test.ts', 'expect(preflight).toContain(`test "$(pi --version)" = "0.83.0"`)'],
      ]),
      EXPECTED,
    )
    expect(scan.divergences).toEqual([])
  })
})

describe('configuration strictness summaries', () => {
  test('enumerate the same complete open-map surface and its workspace exception', () => {
    const expectedSurfaces = [
      '[commands]',
      '[roles]',
      '[workspace.config]',
      '[workspace.config.runtimeProvisioning]',
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
