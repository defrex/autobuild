import { describe, expect, test } from 'bun:test'
import packageJson from '../package.json'
import {
  type DocsAssetCheckEnvironment,
  type DocsAssetCheckOutput,
  findDocsAssetProblems,
  isImageAsset,
  isShippedDocument,
  runDocsAssetCheck,
  scanDocsAssets,
} from './docs-asset-check'

// The real boundary, not a copy of it: if `files` changes, these move with it.
const shippedFiles: readonly string[] = packageJson.files

function harness(
  entries: Record<string, string>,
  overrides: Partial<DocsAssetCheckEnvironment> = {},
) {
  // `package.json` leads so the stub's tracked order matches a real tree's,
  // where it is tracked alongside everything else.
  const tracked: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'autobuild', files: shippedFiles }),
    ...entries,
  }
  const stdout: string[] = []
  const stderr: string[] = []

  const env: DocsAssetCheckEnvironment = {
    listTrackedPaths: async () => Object.keys(tracked),
    readTextFile: async (path) => {
      const contents = tracked[path]
      if (contents === undefined) {
        throw new Error(`ENOENT: no stub for ${path}`)
      }
      return contents
    },
    ...overrides,
  }

  const output: DocsAssetCheckOutput = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  }

  return { env, output, stdout, stderr }
}

/** A tracked binary asset has no text content; nothing ever reads one. */
const binary = ''

describe('isShippedDocument', () => {
  test('Markdown inside an entry of package.json’s files is shipped', () => {
    for (const path of ['README.md', 'SPEC.md', 'docs/architecture.md', 'skills/guide/SKILL.md']) {
      expect(isShippedDocument(path, shippedFiles), path).toBe(true)
    }
  })

  test('Markdown outside those entries is not, including the vendored skill copies', () => {
    for (const path of [
      'AGENTS.md',
      'CHANGELOG.md',
      'CLAUDE.md',
      '.agents/skills/ab-guide/SKILL.md',
      '.agents/skills/.ab-pristine/ab-guide/SKILL.md',
    ]) {
      expect(isShippedDocument(path, shippedFiles), path).toBe(false)
    }
  })

  test('a directory entry does not capture a sibling that merely shares its prefix', () => {
    expect(isShippedDocument('docsfoo/x.md', shippedFiles)).toBe(false)
    expect(isShippedDocument('docs/x.md', shippedFiles)).toBe(true)
  })

  test('a shipped non-Markdown file is not a document', () => {
    expect(isShippedDocument('docs/assets/headline-wide.png', shippedFiles)).toBe(false)
    expect(isShippedDocument('src/markdown.ts', shippedFiles)).toBe(false)
  })
})

describe('isImageAsset', () => {
  test('recognises image extensions, case-insensitively', () => {
    for (const path of ['a.png', 'a.svg', 'a.PNG', 'a.Jpeg', 'docs/assets/b.webp']) {
      expect(isImageAsset(path), path).toBe(true)
    }
  })

  test('anything else is not an image', () => {
    for (const path of ['a.txt', 'a.json', 'docs/assets/notes', 'a.pngx']) {
      expect(isImageAsset(path), path).toBe(false)
    }
  })
})

describe('findDocsAssetProblems', () => {
  test('an asset rendered by a shipped document has nothing to report', () => {
    const findings = findDocsAssetProblems(
      ['docs/assets/x.png'],
      [{ path: 'README.md', contents: '![a frame](docs/assets/x.png)\n' }],
    )

    expect(findings).toEqual([])
  })

  test('an asset nothing references is an orphan', () => {
    const findings = findDocsAssetProblems(
      ['docs/assets/x.png'],
      [{ path: 'README.md', contents: '# Autobuild\n' }],
    )

    expect(findings).toEqual([{ kind: 'orphan', asset: 'docs/assets/x.png' }])
  })

  test('a reference inside a fenced code block is sample text, not a rendering', () => {
    const findings = findDocsAssetProblems(
      ['docs/assets/x.png'],
      [{ path: 'README.md', contents: '```md\n![a frame](docs/assets/x.png)\n```\n' }],
    )

    expect(findings).toEqual([{ kind: 'orphan', asset: 'docs/assets/x.png' }])
  })

  test('a relative target from a nested document resolves against its directory', () => {
    const findings = findDocsAssetProblems(
      ['docs/assets/x.png'],
      [{ path: 'docs/architecture.md', contents: 'see ![it](assets/x.png)\n' }],
    )

    expect(findings).toEqual([])
  })

  test('a root-relative target resolves from the repository root', () => {
    const findings = findDocsAssetProblems(
      ['docs/assets/x.png'],
      [{ path: 'docs/architecture.md', contents: 'see ![it](/docs/assets/x.png)\n' }],
    )

    expect(findings).toEqual([])
  })

  test('a raw HTML img counts as a reference', () => {
    const findings = findDocsAssetProblems(
      ['docs/assets/x.png'],
      [
        {
          path: 'README.md',
          contents: '<div align="center">\n<img src="docs/assets/x.png">\n</div>\n',
        },
      ],
    )

    expect(findings).toEqual([])
  })

  test('schemes and bare fragments are ignored rather than resolved', () => {
    const findings = findDocsAssetProblems(
      [],
      [{ path: 'README.md', contents: '[a](https://example.com/docs/assets/x.png) [b](#why)\n' }],
    )

    expect(findings).toEqual([])
  })

  test('a reference to an untracked asset path is broken, and names document and target', () => {
    const findings = findDocsAssetProblems(
      ['docs/assets/x.png'],
      [{ path: 'README.md', contents: '![a](docs/assets/x.png) [b](docs/assets/gone.png)\n' }],
    )

    expect(findings).toEqual([
      {
        kind: 'broken',
        document: 'README.md',
        target: 'docs/assets/gone.png',
        resolved: 'docs/assets/gone.png',
      },
    ])
  })

  test('a fragment on an asset target is stripped before resolution', () => {
    const findings = findDocsAssetProblems(
      ['docs/assets/x.png'],
      [{ path: 'README.md', contents: '[a](docs/assets/x.png#top)\n' }],
    )

    expect(findings).toEqual([])
  })

  // The two directions applied to the same non-image file. They look redundant
  // — today the tracked set and the image set hold the same single file — but
  // merging them reports a live link to a tracked non-image as `broken`.
  describe('the tracked set and the image set are not the same set', () => {
    test('a tracked non-image linked from a shipped document yields nothing', () => {
      const findings = findDocsAssetProblems(
        ['docs/assets/notes.txt'],
        [{ path: 'README.md', contents: '[notes](docs/assets/notes.txt)\n' }],
      )

      expect(findings).toEqual([])
    })

    test('a tracked non-image nothing references yields nothing — orphan policy is images only', () => {
      const findings = findDocsAssetProblems(
        ['docs/assets/notes.txt'],
        [{ path: 'README.md', contents: '# Autobuild\n' }],
      )

      expect(findings).toEqual([])
    })

    test('an untracked non-image target is still broken', () => {
      const findings = findDocsAssetProblems(
        [],
        [{ path: 'README.md', contents: '[notes](docs/assets/notes.txt)\n' }],
      )

      expect(findings).toEqual([
        {
          kind: 'broken',
          document: 'README.md',
          target: 'docs/assets/notes.txt',
          resolved: 'docs/assets/notes.txt',
        },
      ])
    })
  })
})

describe('scanDocsAssets', () => {
  test('only documents the repository ships can keep an asset alive', async () => {
    const reference = '![a frame](docs/assets/x.png)\n'
    const unshipped = harness({
      'docs/assets/x.png': binary,
      'AGENTS.md': reference,
      'CHANGELOG.md': reference,
      '.agents/skills/ab-guide/SKILL.md': reference,
    })

    expect(await scanDocsAssets(unshipped.env)).toEqual([
      { kind: 'orphan', asset: 'docs/assets/x.png' },
    ])

    const shipped = harness({
      'docs/assets/x.png': binary,
      'AGENTS.md': reference,
      'README.md': reference,
    })

    expect(await scanDocsAssets(shipped.env)).toEqual([])
  })

  test('orphan policy covers images only, and matches the extension case-insensitively', async () => {
    const stub = harness({
      'docs/assets/notes.txt': 'not rendered by anything\n',
      'docs/assets/x.PNG': binary,
      'README.md': '# Autobuild\n',
    })

    expect(await scanDocsAssets(stub.env)).toEqual([{ kind: 'orphan', asset: 'docs/assets/x.PNG' }])
  })

  test('a tracked non-image reaches the core, so a live link to it is not broken', async () => {
    const stub = harness({
      'docs/assets/notes.txt': 'sample data\n',
      'README.md': '[notes](docs/assets/notes.txt)\n',
    })

    expect(await scanDocsAssets(stub.env)).toEqual([])
  })

  test('a tracked source file mentioning an asset path is not a reference', async () => {
    // `tools/product-name-check.test.ts` carries `docs/assets/headline-wide.png`
    // as a stub path; a substring scan would count it and let a real orphan pass.
    const stub = harness({
      'docs/assets/x.png': binary,
      'tools/product-name-check.test.ts': "harness({ 'docs/assets/x.png': binary })\n",
      'README.md': '# Autobuild\n',
    })

    expect(await scanDocsAssets(stub.env)).toEqual([{ kind: 'orphan', asset: 'docs/assets/x.png' }])
  })

  test('never reads a path outside the shipped Markdown set', async () => {
    const read: string[] = []
    const stub = harness({ 'docs/assets/x.png': binary, 'README.md': '![a](docs/assets/x.png)\n' })
    const env: DocsAssetCheckEnvironment = {
      ...stub.env,
      readTextFile: async (path) => {
        read.push(path)
        return stub.env.readTextFile(path)
      },
    }

    await scanDocsAssets(env)

    expect(read).toEqual(['package.json', 'README.md'])
  })
})

describe('runDocsAssetCheck', () => {
  test('a clean tree exits 0 and says nothing', async () => {
    const stub = harness({
      'docs/assets/x.png': binary,
      'README.md': '![a frame](docs/assets/x.png)\n',
    })

    expect(await runDocsAssetCheck(stub.env, stub.output)).toBe(0)
    expect(stub.stdout).toEqual([])
    expect(stub.stderr).toEqual([])
  })

  test('reports every finding on stdout and the convention on stderr', async () => {
    const stub = harness({
      'docs/assets/x.png': binary,
      'README.md': '[gone](docs/assets/gone.png)\n',
    })

    expect(await runDocsAssetCheck(stub.env, stub.output)).toBe(1)
    expect(stub.stdout.join('')).toContain('docs/assets/x.png: tracked, but no document')
    expect(stub.stdout.join('')).toContain('README.md: docs/assets/gone.png')
    expect(stub.stderr.join('')).toContain('or stop tracking it')
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

    expect(await runDocsAssetCheck(stub.env, stub.output)).toBe(1)
    expect(stub.stderr.join('')).toContain('not a git repository')
  })

  test('a failing read exits non-zero rather than reporting a clean tree', async () => {
    const stub = harness({ 'README.md': '# Autobuild\n' })
    const env: DocsAssetCheckEnvironment = {
      ...stub.env,
      readTextFile: async (path) => {
        if (path === 'README.md') {
          throw new Error('EACCES: permission denied')
        }
        return stub.env.readTextFile(path)
      },
    }

    expect(await runDocsAssetCheck(env, stub.output)).toBe(1)
    expect(stub.stderr.join('')).toContain('EACCES')
  })

  test('a package.json whose files array is missing or malformed fails closed', async () => {
    for (const contents of [
      '{ "name": "autobuild" }',
      '{ "files": "docs" }',
      '{ "files": [] }',
      '{ "files": ["docs", 7] }',
      'not json at all',
    ]) {
      const stub = harness({ 'package.json': contents, 'docs/assets/x.png': binary })

      expect(await runDocsAssetCheck(stub.env, stub.output), contents).toBe(1)
      // Never "every asset is an orphan", which is what a defaulted empty set
      // would produce.
      expect(stub.stdout, contents).toEqual([])
    }
  })
})
