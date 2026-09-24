/**
 * Doc-coverage tests moved from core's `configuration-doc.test.ts` (AUT-505):
 * the `[workspace.config]` key tables they pin now describe the schema that
 * lives in this package. Shared doc-parsing helpers (`headingSection`,
 * `expectRows`, and `parseConfig`) come from the `@defrex/autobuild/testing`
 * barrel.
 */
import { describe, expect, test } from 'bun:test'
import { type Dirent, readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { stringify } from 'smol-toml'
import { headingSection, expectRows, parseConfig } from '@defrex/autobuild/testing'
import {
  vercelSandboxConfigSchema,
  runtimeProvisioningEntrySchema,
  type RuntimeProvisioningEntry,
} from './schema'

// THREE levels up from packages/vercel-sandbox/src reaches the repository root.
const ROOT = resolve(import.meta.dir, '..', '..', '..')
const DOC_PATH = resolve(ROOT, 'docs', 'configuration.md')
const SETUP_DOC_PATH = resolve(ROOT, 'docs', 'setup.md')
const GUIDE_PATH = resolve(ROOT, 'skills', 'guide', 'SKILL.md')
const GUIDE_SETUP_PATH = resolve(ROOT, 'skills', 'guide', 'references', 'setup.md')
const AUTOBUILD_PATH = resolve(ROOT, 'autobuild.toml')
const [doc, guide, setupDoc, guideSetup, autobuildToml] = await Promise.all([
  readFile(DOC_PATH, 'utf8'),
  readFile(GUIDE_PATH, 'utf8'),
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
  'packages/vercel-sandbox/src/doc-coverage.test.ts',
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
    const config = parseConfig(autobuildToml, AUTOBUILD_PATH)
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
    ).toBe('packages/vercel-sandbox/src/doc-coverage.test.ts')

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
