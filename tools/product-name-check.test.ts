import { describe, expect, test } from 'bun:test'
import {
  findProductNameViolations,
  type ProductNameCheckEnvironment,
  type ProductNameCheckOutput,
  runProductNameCheck,
  scanTrackedPaths,
  type TrackedPathKind,
} from './product-name-check'

// Every offending spelling in this file is assembled from parts so the test
// does not trip the check it is testing.
const twoWord = ['Auto', 'Build'].join(' ')
const hyphenated = ['Auto', 'build'].join('-')
const tabbed = ['auto', 'build'].join('\t')

// Must stay byte-identical to the check's own allowance for the Linear team.
const allowedLine = `teamKey = "AUT"                 # Linear team key ("${hyphenated}")`

describe('findProductNameViolations', () => {
  test('a tree that spells the name as one word has nothing to report', () => {
    const violations = findProductNameViolations([
      { path: 'README.md', contents: '# Autobuild\n\nRun `autobuild` from the repo root.\n' },
      { path: 'src/skills.ts', contents: '/** Repo-installed Autobuild skills. */\n' },
    ])

    expect(violations).toEqual([])
  })

  test('reports the path, line number, and line text of a two-word spelling', () => {
    const violations = findProductNameViolations([
      { path: 'src/cli/dashboard/render.ts', contents: `one\ntwo\npaint('${twoWord}', 'bold')\n` },
    ])

    expect(violations).toEqual([
      {
        path: 'src/cli/dashboard/render.ts',
        line: 3,
        text: `paint('${twoWord}', 'bold')`,
      },
    ])
  })

  test('catches hyphenated and tab-separated spellings, and matches case-insensitively', () => {
    const violations = findProductNameViolations([
      { path: 'docs/a.md', contents: `The ${hyphenated} pipeline\n` },
      { path: 'docs/b.md', contents: `column\t${tabbed}\n` },
      { path: 'docs/c.md', contents: `${['AUTO', 'BUILD'].join(' ')}\n` },
    ])

    expect(violations.map((violation) => violation.path)).toEqual([
      'docs/a.md',
      'docs/b.md',
      'docs/c.md',
    ])
  })

  test('does not match across a line break, so a wrapped prose line is not a false positive', () => {
    const violations = findProductNameViolations([
      { path: 'docs/wrap.md', contents: 'a sentence ending in auto\nbuild starts the next line\n' },
    ])

    expect(violations).toEqual([])
  })

  test('reports a violation once per line, with CRLF endings stripped', () => {
    const violations = findProductNameViolations([
      { path: 'docs/crlf.md', contents: `intro\r\n${twoWord} and ${twoWord} again\r\n` },
    ])

    expect(violations).toEqual([
      { path: 'docs/crlf.md', line: 2, text: `${twoWord} and ${twoWord} again` },
    ])
  })

  describe('the external-quotation allowance', () => {
    test('exempts the Linear team line in autobuild.toml', () => {
      expect(
        findProductNameViolations([{ path: 'autobuild.toml', contents: allowedLine }]),
      ).toEqual([])
    })

    test('a different line in the same file still fails', () => {
      const violations = findProductNameViolations([
        { path: 'autobuild.toml', contents: `${allowedLine}\n# the ${twoWord} pipeline\n` },
      ])

      expect(violations).toEqual([
        { path: 'autobuild.toml', line: 2, text: `# the ${twoWord} pipeline` },
      ])
    })

    test('a reworded version of the exempt line fails — the whole line must match', () => {
      const violations = findProductNameViolations([
        { path: 'autobuild.toml', contents: `teamKey = "AUT" # Linear team key ("${hyphenated}")` },
      ])

      expect(violations).toHaveLength(1)
    })

    test('the exempt line in a different file fails — the path must match too', () => {
      const violations = findProductNameViolations([
        { path: 'docs/config.md', contents: allowedLine },
      ])

      expect(violations).toEqual([{ path: 'docs/config.md', line: 1, text: allowedLine }])
    })

    test('a second occurrence of the exempt line in its own file is still exempt, but nothing else is', () => {
      const violations = findProductNameViolations([
        { path: 'autobuild.toml', contents: `${allowedLine}\n${allowedLine}\n${hyphenated}\n` },
      ])

      expect(violations).toEqual([{ path: 'autobuild.toml', line: 3, text: hyphenated }])
    })
  })
})

interface StubEntry {
  type: TrackedPathKind
  target?: string
  bytes?: Uint8Array
}

function harness(
  entries: Record<string, StubEntry>,
  overrides: Partial<ProductNameCheckEnvironment> = {},
) {
  const readFileCalls: string[] = []
  const readLinkCalls: string[] = []
  const stdout: string[] = []
  const stderr: string[] = []

  const entryFor = (path: string): StubEntry => {
    const entry = entries[path]
    if (!entry) {
      throw new Error(`unexpected path ${path}`)
    }
    return entry
  }

  const env: ProductNameCheckEnvironment = {
    listTrackedPaths: async () => Object.keys(entries),
    lstat: async (path) => entryFor(path).type,
    readLink: async (path) => {
      readLinkCalls.push(path)
      const { target } = entryFor(path)
      if (target === undefined) {
        throw new Error(`stub has no link target for ${path}`)
      }
      return target
    },
    readFile: async (path) => {
      readFileCalls.push(path)
      const { bytes } = entryFor(path)
      if (bytes === undefined) {
        throw new Error(`stub has no bytes for ${path}`)
      }
      return bytes
    },
    ...overrides,
  }

  const output: ProductNameCheckOutput = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  }

  return { env, output, readFileCalls, readLinkCalls, stderr, stdout }
}

const text = (contents: string): StubEntry => ({
  type: { kind: 'file' },
  bytes: new TextEncoder().encode(contents),
})

const symlink = (target: string): StubEntry => ({ type: { kind: 'symlink' }, target })

describe('scanTrackedPaths', () => {
  test('a symlink to a directory is scanned as its target text and never read as a file', async () => {
    const stub = harness({
      '.claude/skills/ab-guide': symlink('../../.agents/skills/ab-guide'),
      'src/skills.ts': text('/** Autobuild skills. */\n'),
    })

    const report = await scanTrackedPaths(stub.env)

    expect(report.violations).toEqual([])
    expect(stub.readFileCalls).toEqual(['src/skills.ts'])
    expect(stub.readLinkCalls).toEqual(['.claude/skills/ab-guide'])
    expect(report.tally).toEqual({ tracked: 2, text: 1, symlink: 1, binary: 0, missing: 0 })
  })

  test('a symlink to a file is scanned as its target text, not the linked file’s contents', async () => {
    const stub = harness({
      'AGENTS.md': text(`# The ${twoWord} repository\n`),
      'CLAUDE.md': symlink('AGENTS.md'),
    })

    const report = await scanTrackedPaths(stub.env)

    // The violation belongs to AGENTS.md's own tracked path, reported once —
    // not twice, and not against the link.
    expect(report.violations).toEqual([
      { path: 'AGENTS.md', line: 1, text: `# The ${twoWord} repository` },
    ])
    expect(stub.readFileCalls).toEqual(['AGENTS.md'])
  })

  test('a symlink whose target text carries the wrong spelling is reported', async () => {
    const stub = harness({ 'docs/link': symlink(`../${hyphenated}/SKILL.md`) })

    const report = await scanTrackedPaths(stub.env)

    expect(report.violations).toEqual([
      { path: 'docs/link', line: 1, text: `../${hyphenated}/SKILL.md` },
    ])
  })

  test('a regular file containing a NUL byte is treated as binary and skipped', async () => {
    const encoded = new TextEncoder().encode(`\0PNG${twoWord}`)
    const stub = harness({
      'docs/assets/headline-wide.png': { type: { kind: 'file' }, bytes: encoded },
    })

    const report = await scanTrackedPaths(stub.env)

    expect(report.violations).toEqual([])
    expect(report.tally).toEqual({ tracked: 1, text: 0, symlink: 0, binary: 1, missing: 0 })
  })

  test('a tracked path that no longer exists in the working tree is skipped', async () => {
    const stub = harness({ 'src/gone.ts': { type: { kind: 'missing' } } })

    const report = await scanTrackedPaths(stub.env)

    expect(report.violations).toEqual([])
    expect(report.tally).toEqual({ tracked: 1, text: 0, symlink: 0, binary: 0, missing: 1 })
    expect(stub.readFileCalls).toEqual([])
  })

  test('a path of an unexpected type fails closed and names the path', async () => {
    const stub = harness({
      'vendor/submodule': { type: { kind: 'unsupported', found: 'directory' } },
    })

    await expect(scanTrackedPaths(stub.env)).rejects.toThrow(/vendor\/submodule.*directory/)
  })
})

describe('runProductNameCheck', () => {
  test('reports every violation on stdout and the convention on stderr', async () => {
    const stub = harness({
      'src/cli/dashboard/render.ts': text(`paint('${twoWord}')\n`),
      'skills/guide/SKILL.md': text(`the ${hyphenated} guide\n`),
    })

    expect(await runProductNameCheck(stub.env, stub.output)).toBe(1)
    expect(stub.stdout).toEqual([
      `src/cli/dashboard/render.ts:1: paint('${twoWord}')\n`,
      `skills/guide/SKILL.md:1: the ${hyphenated} guide\n`,
    ])
    expect(stub.stderr.join('')).toContain('skills/guide/SKILL.md')
    // The tally is reported on failure so a wrong skip is visible, not silent.
    expect(stub.stderr.join('')).toContain('Scanned 2 text files and 0 symlinks')
  })

  test('a clean tree exits 0 and says nothing', async () => {
    const stub = harness({ 'README.md': text('# Autobuild\n') })

    expect(await runProductNameCheck(stub.env, stub.output)).toBe(0)
    expect(stub.stdout).toEqual([])
    expect(stub.stderr).toEqual([])
  })

  test('a failing enumeration exits non-zero rather than reporting a clean tree', async () => {
    const stub = harness(
      {},
      {
        listTrackedPaths: async () => {
          throw new Error('git ls-files exited with status 128: not a git repository')
        },
      },
    )

    expect(await runProductNameCheck(stub.env, stub.output)).toBe(1)
    expect(stub.stderr.join('')).toContain('not a git repository')
  })

  test('a failing read exits non-zero rather than reporting a clean tree', async () => {
    const stub = harness(
      { 'src/locked.ts': text('') },
      {
        readFile: async () => {
          throw new Error('EACCES: permission denied')
        },
      },
    )

    expect(await runProductNameCheck(stub.env, stub.output)).toBe(1)
    expect(stub.stderr.join('')).toContain('EACCES')
  })
})
