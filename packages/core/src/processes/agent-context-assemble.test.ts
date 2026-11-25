import { describe, expect, test } from 'bun:test'
import { fakeTree, type FakeTreeFile } from '../ports/forge/fake'
import { assembleAgentContext, contextKey, importTokens } from './agent-context-assemble'

const COMMIT = 'a'.repeat(40)

function assemble(files: Record<string, FakeTreeFile>) {
  const { entries, blobs } = fakeTree(files)
  const result = assembleAgentContext({
    commit: COMMIT,
    baseBranch: 'main',
    entries,
    blob: (oid) => blobs.get(oid),
  })
  expect(result.missing).toEqual([])
  return { ...result, record: result.record!, entries }
}

const skill = (name: string, body = `# ${name}`) => ({
  [`.agents/skills/${name}/SKILL.md`]: body,
})

describe('skills', () => {
  test('symlinked and byte-identical copies appear once with every install path', () => {
    const { record } = assemble({
      ...skill('ab-guide'),
      '.agents/skills/ab-guide/references/x.md': 'ref',
      '.claude/skills/ab-guide': { symlink: '../../.agents/skills/ab-guide' },
      ...skill('release', 'release body'),
      '.claude/skills/release/SKILL.md': 'release body',
    })
    expect(record.skills.map((entry) => [entry.name, entry.paths])).toEqual([
      ['ab-guide', ['.agents/skills/ab-guide', '.claude/skills/ab-guide']],
      ['release', ['.agents/skills/release', '.claude/skills/release']],
    ])
    expect(record.skills[0]!.files.map((file) => [file.path, file.text])).toEqual([
      ['SKILL.md', '# ab-guide'],
      ['references/x.md', 'ref'],
    ])
    expect(record.links).toEqual([
      { path: '.claude/skills/ab-guide', target: '../../.agents/skills/ab-guide' },
    ])
  })

  test('differing same-name skills stay separate; unprefixed skills are kept; dot and marker-less dirs are not', () => {
    const { record } = assemble({
      ...skill('impeccable', 'agents copy'),
      '.claude/skills/impeccable/SKILL.md': 'claude copy',
      ...skill('verify-docs'),
      '.agents/skills/.ab-pristine/ab-guide/SKILL.md': 'pristine',
      '.agents/skills/notes/README.md': 'not a skill',
    })
    expect(record.skills.map((entry) => entry.paths)).toEqual([
      ['.agents/skills/impeccable'],
      ['.agents/skills/verify-docs'],
      ['.claude/skills/impeccable'],
    ])
  })

  test('binary files round-trip through base64; unsafe links and submodules are omitted', () => {
    const binary = new Uint8Array([0xff, 0x00, 0xfe])
    const { record } = assemble({
      ...skill('x'),
      '.agents/skills/x/font.bin': binary,
      '.agents/skills/x/escape': { symlink: '../../../../etc/passwd' },
      '.agents/skills/x/gone': { symlink: 'missing.md' },
      '.agents/skills/x/vendor': { submodule: 'b'.repeat(40) },
    })
    const files = record.skills[0]!.files
    expect(files.find((file) => file.path === 'font.bin')?.base64).toBe(
      Buffer.from(binary).toString('base64'),
    )
    expect(record.omitted).toEqual([
      { path: '.agents/skills/x/escape', reason: 'outside-repository' },
      { path: '.agents/skills/x/gone', reason: 'dangling' },
      { path: '.agents/skills/x/vendor', reason: 'submodule' },
    ])
  })
})

describe('agent instructions', () => {
  test('AGENTS.md alone, CLAUDE.md instead, and same-file pairs collapse', () => {
    expect(assemble({ 'AGENTS.md': 'a' }).record.instructions.map((i) => i.paths)).toEqual([
      ['AGENTS.md'],
    ])
    expect(assemble({ 'CLAUDE.md': 'c' }).record.instructions.map((i) => i.paths)).toEqual([
      ['CLAUDE.md'],
    ])
    for (const claude of [{ symlink: 'AGENTS.md' }, 'same']) {
      const { record } = assemble({ 'AGENTS.md': 'same', 'CLAUDE.md': claude })
      expect(record.instructions.map((i) => [i.paths, i.text])).toEqual([
        [['AGENTS.md', 'CLAUDE.md'], 'same'],
      ])
    }
  })

  test('a differing pair is captured twice and nested files carry their directory', () => {
    const { record } = assemble({
      'AGENTS.md': 'agents',
      'CLAUDE.md': 'claude',
      'packages/web/AGENTS.md': 'web',
      ...skill('x'),
      '.agents/skills/x/AGENTS.md': 'inside a skill',
    })
    expect(record.instructions.map((i) => [i.paths, i.directory])).toEqual([
      [['AGENTS.md'], ''],
      [['CLAUDE.md'], ''],
      [['packages/web/AGENTS.md'], 'packages/web'],
    ])
  })
})

describe('@path imports', () => {
  test('resolve relative to the importer, follow chains of any depth, and are never inlined', () => {
    const chain: Record<string, string> = {}
    for (let i = 1; i <= 7; i++) chain[`docs/hop${i}.md`] = i < 7 ? `next @hop${i + 1}.md` : 'end'
    const { record } = assemble({
      'packages/web/AGENTS.md': 'See @../../docs/hop1.md.',
      ...chain,
    })
    expect(record.imports.map((entry) => entry.path)).toEqual(Object.keys(chain).sort())
    expect(record.instructions[0]!.text).toBe('See @../../docs/hop1.md.')
    expect(record.instructions[0]!.imports).toEqual(['docs/hop1.md'])
    expect(record.imports[0]).toMatchObject({
      path: 'docs/hop1.md',
      importedBy: ['packages/web/AGENTS.md'],
      imports: ['docs/hop2.md'],
    })
  })

  test('aliases of one file in different directories each resolve their own imports', () => {
    const { record, dependencies } = assemble({
      'AGENTS.md': '@a/common.md @b/common.md @c/common.md',
      'shared.md': 'Follow @rules.md',
      'a/common.md': { symlink: '../shared.md' },
      'b/common.md': { symlink: '../shared.md' },
      c: { symlink: 'a' },
      'a/rules.md': 'rules for a',
      'b/rules.md': 'rules for b',
    })
    expect(record.imports.map((entry) => [entry.path, entry.importedBy, entry.imports])).toEqual([
      ['a/common.md', ['AGENTS.md'], ['a/rules.md']],
      ['a/rules.md', ['a/common.md'], []],
      ['b/common.md', ['AGENTS.md'], ['b/rules.md']],
      ['b/rules.md', ['b/common.md'], []],
    ])
    expect(record.instructions[0]!.imports).toEqual(['a/common.md', 'b/common.md'])
    expect(dependencies).toContain('b/rules.md')
    expect(record.imports.find((entry) => entry.path === 'b/rules.md')!.text).toBe('rules for b')
  })

  test('an alias of an instruction file in another directory resolves its own imports', () => {
    const { record, dependencies } = assemble({
      'AGENTS.md': '@a/common.md @CLAUDE.md',
      'CLAUDE.md': '@rules.md',
      'a/common.md': { symlink: '../CLAUDE.md' },
      'rules.md': 'root rules',
      'a/rules.md': 'alias rules',
    })
    expect(record.instructions.map((entry) => [entry.paths, entry.imports])).toEqual([
      [['AGENTS.md'], ['CLAUDE.md', 'a/common.md']],
      [['CLAUDE.md'], ['rules.md']],
    ])
    expect(record.imports.map((entry) => [entry.path, entry.importedBy, entry.imports])).toEqual([
      ['a/common.md', ['AGENTS.md'], ['a/rules.md']],
      ['a/rules.md', ['a/common.md'], []],
      ['rules.md', ['CLAUDE.md'], []],
    ])
    expect(dependencies).toContain('a/rules.md')
  })

  test('cycles terminate and mentions, code, emails and outside paths are not imports', () => {
    const mentions = Array.from({ length: 2000 }, (_, i) => `@person${i}`).join(' ')
    const { record, dependencies } = assemble({
      'AGENTS.md': [
        mentions,
        'Mail me@example.com or ping @defrex.',
        '`@code.md` stays code.',
        '```',
        '@fenced.md',
        '```',
        '@~/.claude/global.md @/etc/hosts @../outside.md',
        'Real: @a.md',
      ].join('\n'),
      'a.md': 'back to @AGENTS.md and @b.md',
      'b.md': 'and @a.md',
      'code.md': 'x',
      'fenced.md': 'x',
    })
    expect(record.imports.map((entry) => [entry.path, entry.imports])).toEqual([
      ['a.md', ['AGENTS.md', 'b.md']],
      ['b.md', ['a.md']],
    ])
    expect(record.omitted).toEqual([
      { path: '../outside.md', reason: 'outside-repository' },
      { path: '/etc/hosts', reason: 'outside-repository' },
      { path: '~/.claude/global.md', reason: 'outside-repository' },
    ])
    expect(dependencies).toContain('defrex')
    expect(dependencies).toContain('person1999')
  })

  test('importTokens skips fences and spans and strips trailing punctuation', () => {
    expect(importTokens('@a.md, (@b.md) x@c.md `@d.md`\n~~~\n@e.md\n~~~\n@f.md.')).toEqual([
      'a.md',
      'f.md',
    ])
  })
})

describe('canonical form and fingerprint', () => {
  const files = {
    ...skill('x'),
    '.claude/skills/x': { symlink: '../../.agents/skills/x' },
    'AGENTS.md': '@docs/guide.md',
    'docs/guide.md': 'guide',
    'src/main.ts': 'code',
  }

  test('shuffled tree order gives identical JSON', () => {
    const { entries, blobs } = fakeTree(files)
    const run = (list: typeof entries) =>
      JSON.stringify(
        assembleAgentContext({
          commit: COMMIT,
          baseBranch: 'main',
          entries: list,
          blob: (oid) => blobs.get(oid),
        }).record,
      )
    expect(run([...entries].reverse())).toBe(run(entries))
  })

  test('the key follows dependencies and ignores unrelated files', () => {
    const base = assemble(files)
    const key = (changes: Record<string, FakeTreeFile>) =>
      contextKey(fakeTree({ ...files, ...changes }).entries, base.dependencies)
    const original = contextKey(base.entries, base.dependencies)
    expect(key({ 'src/main.ts': 'changed' })).toBe(original)
    expect(key({ 'docs/guide.md': 'changed' })).not.toBe(original)
    // An unresolved import candidate that later appears changes the key.
    const pending = assemble({ 'AGENTS.md': '@later.md' })
    expect(pending.dependencies).toContain('later.md')
    expect(
      contextKey(
        fakeTree({ 'AGENTS.md': '@later.md', 'later.md': 'now' }).entries,
        pending.dependencies,
      ),
    ).not.toBe(contextKey(pending.entries, pending.dependencies))
  })
})
