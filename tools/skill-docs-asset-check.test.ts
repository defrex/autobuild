import { describe, expect, test } from 'bun:test'
import {
  findSkillDocsAssetProblems,
  isRepoLocalSkillDoc,
  realEnvironment,
  runSkillDocsAssetCheck,
  scanSkillDocsAssets,
  skillDocsAssetMentions,
  type SkillDocsAssetCheckEnvironment,
  type SkillDocsAssetCheckOutput,
} from './skill-docs-asset-check'

// A stable stand-in for the real canonical inventory; the boundary tests at
// the bottom exercise the real one.
const canonicalNames = ['ab-code-review', 'ab-plan'] as const

/** A tracked binary asset has no text content; nothing ever reads one. */
const binary = ''

function harness(
  entries: Record<string, string>,
  overrides: Partial<SkillDocsAssetCheckEnvironment> = {},
) {
  const tracked = { ...entries }
  const stdout: string[] = []
  const stderr: string[] = []

  const env: SkillDocsAssetCheckEnvironment = {
    listTrackedPaths: async () => Object.keys(tracked),
    listCanonicalSkillNames: async () => canonicalNames,
    readTextFile: async (path) => {
      const contents = tracked[path]
      if (contents === undefined) {
        throw new Error(`ENOENT: no stub for ${path}`)
      }
      return contents
    },
    ...overrides,
  }

  const output: SkillDocsAssetCheckOutput = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  }

  return { env, output, stdout, stderr }
}

describe('isRepoLocalSkillDoc', () => {
  test('canonical install names are excluded, at any depth', () => {
    for (const path of [
      '.agents/skills/ab-plan/SKILL.md',
      '.agents/skills/ab-plan/references/setup.md',
    ]) {
      expect(isRepoLocalSkillDoc(path, canonicalNames), path).toBe(false)
    }
  })

  test('the pristine baseline tree is excluded, canonical or not', () => {
    for (const path of [
      '.agents/skills/.ab-pristine/ab-plan/SKILL.md',
      '.agents/skills/.ab-pristine/readme-headline/SKILL.md',
    ]) {
      expect(isRepoLocalSkillDoc(path, canonicalNames), path).toBe(false)
    }
  })

  test('non-Markdown files are excluded', () => {
    expect(
      isRepoLocalSkillDoc('.agents/skills/impeccable/agents/openai.yaml', canonicalNames),
    ).toBe(false)
  })

  test('each repo-local skill is included, including ab- names with no canonical entry', () => {
    for (const path of [
      '.agents/skills/readme-headline/SKILL.md',
      '.agents/skills/impeccable/SKILL.md',
      '.agents/skills/impeccable/reference/craft.md',
      '.agents/skills/ab-finalize-changelog/SKILL.md',
    ]) {
      expect(isRepoLocalSkillDoc(path, canonicalNames), path).toBe(true)
    }
  })

  test('anything outside the vendored skills tree is excluded', () => {
    for (const path of ['README.md', '.agents/skills/loose.md', '.agents/skills']) {
      expect(isRepoLocalSkillDoc(path, canonicalNames), path).toBe(false)
    }
  })
})

describe('skillDocsAssetMentions', () => {
  const document = (contents: string) => ({
    path: '.agents/skills/readme-headline/SKILL.md',
    contents,
  })

  test('link targets resolve as docs-asset-check resolves them', () => {
    const relative = skillDocsAssetMentions(document('![f](../../../docs/assets/x.png)\n'))
    expect(relative).toEqual([
      { target: '../../../docs/assets/x.png', resolved: 'docs/assets/x.png' },
    ])

    const rootRelative = skillDocsAssetMentions(document('![f](/docs/assets/x.png)\n'))
    expect(rootRelative).toEqual([{ target: '/docs/assets/x.png', resolved: 'docs/assets/x.png' }])
  })

  test('a bare inline-code mention is repo-root-relative as written', () => {
    expect(skillDocsAssetMentions(document('writes to `docs/assets/x.png`.\n'))).toEqual([
      { target: 'docs/assets/x.png', resolved: 'docs/assets/x.png' },
    ])
  })

  test('a ../-prefixed inline-code mention resolves against the document directory', () => {
    const fromSkillRoot = skillDocsAssetMentions(document('see `../../../docs/assets/x.png`\n'))
    expect(fromSkillRoot).toEqual([
      { target: '../../../docs/assets/x.png', resolved: 'docs/assets/x.png' },
    ])

    const fromReference = skillDocsAssetMentions({
      path: '.agents/skills/impeccable/reference/craft.md',
      contents: 'see `../../../../docs/assets/x.png`\n',
    })
    expect(fromReference).toEqual([
      { target: '../../../../docs/assets/x.png', resolved: 'docs/assets/x.png' },
    ])
  })

  test('a ./-prefixed inline-code mention is repo-root-relative like the bare form', () => {
    expect(skillDocsAssetMentions(document('writes to `./docs/assets/x.png`.\n'))).toEqual([
      { target: './docs/assets/x.png', resolved: 'docs/assets/x.png' },
    ])
  })

  test('a .././ mixture resolves like its plain ../ form', () => {
    expect(skillDocsAssetMentions(document('see `../../.././docs/assets/x.png`\n'))).toEqual([
      { target: '../../.././docs/assets/x.png', resolved: 'docs/assets/x.png' },
    ])
  })

  test('a trailing-slash mention names a directory and is deliberately ignored', () => {
    for (const contents of [
      'screenshots in `docs/assets/screenshots/`.\n',
      'screenshots in `./docs/assets/x/`.\n',
      'screenshots in `../../../docs/assets/screenshots/`.\n',
    ]) {
      expect(skillDocsAssetMentions(document(contents)), contents).toEqual([])
    }
  })

  test('the widened ./ prefix keeps the tail of a longer path from becoming a mention', () => {
    for (const contents of [
      'served from `static/./docs/assets/gone.png` today\n',
      'fetched from `host./docs/assets/gone.png` today\n',
    ]) {
      expect(skillDocsAssetMentions(document(contents)), contents).toEqual([])
    }
  })

  test('a fenced code block is sample text and is never scanned', () => {
    const contents = '```\ndocs/assets/gone.png\n```\n'
    expect(skillDocsAssetMentions(document(contents))).toEqual([])
  })

  test('a URL inside inline code is not a mention', () => {
    const contents = 'fetch `https://example.com/docs/assets/gone.png` for the sample\n'
    expect(skillDocsAssetMentions(document(contents))).toEqual([])
  })

  test('a bare docs/assets prefix with no filename is not a mention', () => {
    for (const contents of ['the `docs/assets` directory\n', 'the `docs/assets/` directory\n']) {
      expect(skillDocsAssetMentions(document(contents)), contents).toEqual([])
    }
  })

  test('the tail of a longer path is not a mention', () => {
    const contents = 'served from `static/docs/assets/gone.png` today\n'
    expect(skillDocsAssetMentions(document(contents))).toEqual([])
  })

  test('fragments are stripped from targets and scheme targets are ignored', () => {
    expect(skillDocsAssetMentions(document('[a](/docs/assets/x.png#top)\n'))).toEqual([
      { target: '/docs/assets/x.png#top', resolved: 'docs/assets/x.png' },
    ])
    expect(skillDocsAssetMentions(document('[a](https://host/docs/assets/gone.png)\n'))).toEqual([])
  })

  test('references landing outside docs/assets are out of scope', () => {
    const contents = [
      '[dispatcher](../../../docs/hosted-dispatcher.md)',
      'call `packages/core/src/cli/init.ts`',
      'sibling `../../docs/assets/gone.png`',
      '',
      '',
    ].join('\n')
    expect(skillDocsAssetMentions(document(contents))).toEqual([])
  })

  test('trailing punctuation is not swallowed into a mention', () => {
    const contents = 'writes to `docs/assets/x.png`, then verifies it.\n'
    expect(skillDocsAssetMentions(document(contents))).toEqual([
      { target: 'docs/assets/x.png', resolved: 'docs/assets/x.png' },
    ])
  })

  test('raw HTML img targets count as references', () => {
    const contents = '<img src="../../../docs/assets/x.png">\n'
    expect(skillDocsAssetMentions(document(contents))).toEqual([
      { target: '../../../docs/assets/x.png', resolved: 'docs/assets/x.png' },
    ])
  })
})

describe('findSkillDocsAssetProblems', () => {
  test('an inline-code mention of a tracked asset has nothing to report', () => {
    const findings = findSkillDocsAssetProblems(
      ['docs/assets/x.png'],
      [
        {
          path: '.agents/skills/readme-headline/SKILL.md',
          contents: 'writes `docs/assets/x.png`.\n',
        },
      ],
    )

    expect(findings).toEqual([])
  })

  test('an inline-code mention of an untracked asset is broken, naming document and mention', () => {
    const findings = findSkillDocsAssetProblems(
      ['docs/assets/x.png'],
      [
        {
          path: '.agents/skills/readme-headline/SKILL.md',
          contents: 'writes `docs/assets/gone.png`.\n',
        },
      ],
    )

    expect(findings).toEqual([
      {
        kind: 'broken',
        document: '.agents/skills/readme-headline/SKILL.md',
        target: 'docs/assets/gone.png',
        resolved: 'docs/assets/gone.png',
      },
    ])
  })

  test('a ./-prefixed inline-code mention of an untracked asset is broken, naming the written form', () => {
    const findings = findSkillDocsAssetProblems(
      [],
      [
        {
          path: '.agents/skills/readme-headline/SKILL.md',
          contents: 'writes `./docs/assets/gone.png`.\n',
        },
      ],
    )

    expect(findings).toEqual([
      {
        kind: 'broken',
        document: '.agents/skills/readme-headline/SKILL.md',
        target: './docs/assets/gone.png',
        resolved: 'docs/assets/gone.png',
      },
    ])
  })

  test('a directory mention with a trailing slash is ignored, not reported broken', () => {
    for (const contents of [
      'screenshots in `docs/assets/screenshots/`.\n',
      'screenshots in `./docs/assets/x/`.\n',
      'screenshots in `../../../docs/assets/screenshots/`.\n',
    ]) {
      const findings = findSkillDocsAssetProblems(
        [],
        [{ path: '.agents/skills/readme-headline/SKILL.md', contents }],
      )

      expect(findings, contents).toEqual([])
    }
  })

  test('a tracked link target passes and an untracked one is broken', () => {
    const tracked = findSkillDocsAssetProblems(
      ['docs/assets/x.png'],
      [
        {
          path: '.agents/skills/readme-headline/SKILL.md',
          contents: '![f](../../../docs/assets/x.png)\n',
        },
      ],
    )

    expect(tracked).toEqual([])

    const untracked = findSkillDocsAssetProblems(
      ['docs/assets/x.png'],
      [
        {
          path: '.agents/skills/readme-headline/SKILL.md',
          contents: '![f](../../../docs/assets/gone.png)\n',
        },
      ],
    )

    expect(untracked).toEqual([
      {
        kind: 'broken',
        document: '.agents/skills/readme-headline/SKILL.md',
        target: '../../../docs/assets/gone.png',
        resolved: 'docs/assets/gone.png',
      },
    ])
  })

  test('a tracked non-image mentioned in inline code is not broken', () => {
    const findings = findSkillDocsAssetProblems(
      ['docs/assets/notes.txt'],
      [
        {
          path: '.agents/skills/readme-headline/SKILL.md',
          contents: 'reads `docs/assets/notes.txt`.\n',
        },
      ],
    )

    expect(findings).toEqual([])
  })

  test('findings come per occurrence, link targets before inline-code mentions', () => {
    const contents =
      'mentions `docs/assets/gone.png` first\n\nthen ![f](../../../docs/assets/also-gone.png)\n'
    const findings = findSkillDocsAssetProblems(
      [],
      [{ path: '.agents/skills/readme-headline/SKILL.md', contents }],
    )

    expect(findings).toEqual([
      {
        kind: 'broken',
        document: '.agents/skills/readme-headline/SKILL.md',
        target: '../../../docs/assets/also-gone.png',
        resolved: 'docs/assets/also-gone.png',
      },
      {
        kind: 'broken',
        document: '.agents/skills/readme-headline/SKILL.md',
        target: 'docs/assets/gone.png',
        resolved: 'docs/assets/gone.png',
      },
    ])
  })

  test('duplicate mentions of the same path are each reported', () => {
    const contents = '`docs/assets/gone.png` and again `docs/assets/gone.png`\n'
    const findings = findSkillDocsAssetProblems(
      [],
      [{ path: '.agents/skills/readme-headline/SKILL.md', contents }],
    )

    expect(findings).toHaveLength(2)
    for (const finding of findings) {
      expect(finding).toEqual({
        kind: 'broken',
        document: '.agents/skills/readme-headline/SKILL.md',
        target: 'docs/assets/gone.png',
        resolved: 'docs/assets/gone.png',
      })
    }
  })
})

describe('scanSkillDocsAssets', () => {
  test('only repo-local skill documents are scanned, in neither direction otherwise', async () => {
    const stub = harness(
      {
        '.agents/skills/ab-plan/SKILL.md':
          '![f](../../../docs/assets/gone.png) and `docs/assets/also-gone.png`\n',
        '.agents/skills/.ab-pristine/ab-plan/SKILL.md':
          '![f](../../../../docs/assets/gone.png) and `docs/assets/also-gone.png`\n',
        '.agents/skills/readme-headline/SKILL.md': '`docs/assets/also-gone.png`\n',
      },
      { listCanonicalSkillNames: async () => ['ab-plan'] },
    )

    expect(await scanSkillDocsAssets(stub.env)).toEqual([
      {
        kind: 'broken',
        document: '.agents/skills/readme-headline/SKILL.md',
        target: 'docs/assets/also-gone.png',
        resolved: 'docs/assets/also-gone.png',
      },
    ])
  })

  test('a clean repo-local tree passes', async () => {
    const stub = harness({
      'docs/assets/x.png': binary,
      '.agents/skills/readme-headline/SKILL.md': 'writes `docs/assets/x.png`.\n',
      '.agents/skills/ab-plan/SKILL.md': '![f](../../../docs/assets/elsewhere.png)\n',
    })

    expect(await scanSkillDocsAssets(stub.env)).toEqual([])
  })

  test('never reads a path outside the in-scope document set', async () => {
    const read: string[] = []
    const stub = harness({
      'docs/assets/x.png': binary,
      'README.md': 'see `docs/assets/x.png`\n',
      '.agents/skills/readme-headline/SKILL.md': 'see `docs/assets/x.png`\n',
    })
    const env: SkillDocsAssetCheckEnvironment = {
      ...stub.env,
      readTextFile: async (path) => {
        read.push(path)
        return stub.env.readTextFile(path)
      },
    }

    await scanSkillDocsAssets(env)

    expect(read).toEqual(['.agents/skills/readme-headline/SKILL.md'])
  })
})

describe('runSkillDocsAssetCheck', () => {
  test('a clean tree exits 0 and says nothing', async () => {
    const stub = harness({
      'docs/assets/x.png': binary,
      '.agents/skills/readme-headline/SKILL.md': 'writes `docs/assets/x.png`.\n',
    })

    expect(await runSkillDocsAssetCheck(stub.env, stub.output)).toBe(0)
    expect(stub.stdout).toEqual([])
    expect(stub.stderr).toEqual([])
  })

  test('reports every finding on stdout and the convention on stderr', async () => {
    const stub = harness({
      '.agents/skills/readme-headline/SKILL.md': 'writes `docs/assets/gone.png`.\n',
    })

    expect(await runSkillDocsAssetCheck(stub.env, stub.output)).toBe(1)
    expect(stub.stdout.join('')).toContain(
      '.agents/skills/readme-headline/SKILL.md: docs/assets/gone.png',
    )
    expect(stub.stderr.join('')).toContain('drop the mention')
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

    expect(await runSkillDocsAssetCheck(stub.env, stub.output)).toBe(1)
    expect(stub.stderr.join('')).toContain('not a git repository')
    expect(stub.stdout).toEqual([])
  })

  test('a failing canonical inventory exits non-zero rather than scanning everything', async () => {
    const stub = harness(
      {
        'docs/assets/x.png': binary,
        '.agents/skills/readme-headline/SKILL.md': 'writes `docs/assets/x.png`.\n',
      },
      {
        listCanonicalSkillNames: async () => {
          throw new Error('ENOENT: no skills directory')
        },
      },
    )

    expect(await runSkillDocsAssetCheck(stub.env, stub.output)).toBe(1)
    expect(stub.stderr.join('')).toContain('no skills directory')
    expect(stub.stdout).toEqual([])
  })

  test('a failing read exits non-zero rather than reporting a clean tree', async () => {
    const stub = harness({ '.agents/skills/readme-headline/SKILL.md': '# t\n' })
    const env: SkillDocsAssetCheckEnvironment = {
      ...stub.env,
      readTextFile: async (path) => {
        if (path === '.agents/skills/readme-headline/SKILL.md') {
          throw new Error('EACCES: permission denied')
        }
        return stub.env.readTextFile(path)
      },
    }

    expect(await runSkillDocsAssetCheck(env, stub.output)).toBe(1)
    expect(stub.stderr.join('')).toContain('EACCES')
  })
})

describe('real repository boundary', () => {
  test('the real tree passes the real check', async () => {
    expect(await scanSkillDocsAssets(realEnvironment)).toEqual([])
  })

  test('scope derivation and inline-code extraction stay wired to the recorded evidence', async () => {
    const names = await realEnvironment.listCanonicalSkillNames()
    expect(names).toContain('ab-plan')
    expect(names).not.toContain('readme-headline')

    const path = '.agents/skills/readme-headline/SKILL.md'
    expect(isRepoLocalSkillDoc(path, names)).toBe(true)

    const contents = await realEnvironment.readTextFile(path)
    expect(skillDocsAssetMentions({ path, contents })).toEqual([
      { target: 'docs/assets/headline-wide.png', resolved: 'docs/assets/headline-wide.png' },
      { target: 'docs/assets/headline-wide.png', resolved: 'docs/assets/headline-wide.png' },
    ])
  })

  test('a removed recorded asset fails with exactly the two findings the criterion demands', async () => {
    const path = '.agents/skills/readme-headline/SKILL.md'
    const contents = await realEnvironment.readTextFile(path)

    const findings = findSkillDocsAssetProblems([], [{ path, contents }])

    expect(findings).toEqual([
      {
        kind: 'broken',
        document: path,
        target: 'docs/assets/headline-wide.png',
        resolved: 'docs/assets/headline-wide.png',
      },
      {
        kind: 'broken',
        document: path,
        target: 'docs/assets/headline-wide.png',
        resolved: 'docs/assets/headline-wide.png',
      },
    ])
  })
})
