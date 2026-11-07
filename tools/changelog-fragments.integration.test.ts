import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from './changelog-add'
import {
  addFragment,
  collectPendingChangelog,
  fragmentPath,
  parseFragment,
  renderFragment,
} from './changelog-fragments'

const scaffold = '# Changelog\n\n## Unreleased\n\n'
test('canonical fragment validation', () => {
  expect(renderFragment(99, 'https://example.test/99', 'Title')).toBe(
    '- [#99](https://example.test/99) — Title\n',
  )
  for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => fragmentPath(number)).toThrow()
  for (const [path, content] of [
    ['.changelog/099.md', renderFragment(99, 'url', 'Title')],
    ['.changelog/99.md', renderFragment(100, 'url', 'Title')],
    ['.changelog/99.md', '- [#99](url) — Title\nextra\n'],
  ])
    expect(() => parseFragment(path!, content!)).toThrow()
})

test('collects both sources numerically, preserves history, refuses duplicates and emptiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fragment-test-'))
  try {
    await expect(collectPendingChangelog(root, scaffold)).rejects.toThrow('no entries')
    const history = '## v1.0.0\n\nHistory\n'
    const legacy = `${scaffold}- [#99](url) — Legacy\n\nProse\n\n${history}`
    await Bun.write(join(root, '.changelog/100.md'), renderFragment(100, 'url', 'New'))
    const result = await collectPendingChangelog(root, legacy)
    expect(result.entries).toBe('- [#100](url) — New\n- [#99](url) — Legacy\n\nProse')
    expect(result.content.endsWith(history)).toBe(true)
    expect(result.paths).toEqual(['.changelog/100.md'])
    expect((await collectPendingChangelog(root, scaffold)).entries).toContain('[#100]')
    await Bun.write(join(root, '.changelog/99.md'), renderFragment(99, 'url', 'Duplicate'))
    await expect(collectPendingChangelog(root, legacy)).rejects.toThrow('Duplicate')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const released = (unreleased: string, history: string) =>
  `${scaffold}${unreleased}## v1.0.0\n\n- [#1](url) — First\n${history}`
const url = 'https://example.test/pull/42'
const entry = renderFragment(42, url, 'Title')
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

async function withRoot(changelog: string, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'fragment-add-test-'))
  try {
    await writeFile(join(root, 'CHANGELOG.md'), changelog)
    await run(root)
    expect(await readFile(join(root, 'CHANGELOG.md'), 'utf8')).toBe(changelog)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('adds a fragment when a release consumed the .changelog directory', async () => {
  await withRoot(released('', ''), async (root) => {
    const target = join(root, '.changelog/42.md')
    expect(await exists(join(root, '.changelog'))).toBe(false)
    expect(await addFragment(root, 42, url, 'Title')).toEqual({
      outcome: 'created',
      path: '.changelog/42.md',
    })
    expect(await readFile(target, 'utf8')).toBe(entry)
    expect(await addFragment(root, 42, url, 'Title')).toEqual({
      outcome: 'present',
      path: '.changelog/42.md',
    })
  })
})

test('adds beside existing fragments without touching them', async () => {
  await withRoot(released('', ''), async (root) => {
    const other = renderFragment(100, 'url', 'Other')
    await mkdir(join(root, '.changelog'))
    await writeFile(join(root, '.changelog/100.md'), other)
    expect((await addFragment(root, 42, url, 'Title')).outcome).toBe('created')
    expect(await readFile(join(root, '.changelog/42.md'), 'utf8')).toBe(entry)
    expect(await readFile(join(root, '.changelog/100.md'), 'utf8')).toBe(other)
  })
})

test('an existing fragment is an idempotent no-op, never rewritten', async () => {
  await withRoot(released('', ''), async (root) => {
    await mkdir(join(root, '.changelog'))
    await writeFile(join(root, '.changelog/42.md'), entry)
    expect((await addFragment(root, 42, url, 'Renamed')).outcome).toBe('present')
    expect(await readFile(join(root, '.changelog/42.md'), 'utf8')).toBe(entry)
  })
})

test('a released or unreleased CHANGELOG.md marker is present without creating .changelog', async () => {
  for (const changelog of [released('', `${entry}`), released(entry, '')])
    await withRoot(changelog, async (root) => {
      expect((await addFragment(root, 42, url, 'Title')).outcome).toBe('present')
      expect(await exists(join(root, '.changelog'))).toBe(false)
    })
})

test('malformed fragments, duplicates and invalid inputs write nothing', async () => {
  await withRoot(released('', ''), async (root) => {
    await mkdir(join(root, '.changelog'))
    await writeFile(join(root, '.changelog/42.md'), 'not an entry\n')
    await expect(addFragment(root, 42, url, 'Title')).rejects.toThrow('Malformed')
    expect(await readFile(join(root, '.changelog/42.md'), 'utf8')).toBe('not an entry\n')
  })
  await withRoot(released('', entry), async (root) => {
    await mkdir(join(root, '.changelog'))
    await writeFile(join(root, '.changelog/42.md'), entry)
    await expect(addFragment(root, 42, url, 'Title')).rejects.toThrow('Duplicate')
    expect(await readFile(join(root, '.changelog/42.md'), 'utf8')).toBe(entry)
  })
  await withRoot(released(entry, entry), async (root) => {
    await expect(addFragment(root, 42, url, 'Title')).rejects.toThrow('Duplicate')
    expect(await exists(join(root, '.changelog'))).toBe(false)
  })
  await withRoot(released('', ''), async (root) => {
    await expect(addFragment(root, 0, url, 'Title')).rejects.toThrow()
    await expect(addFragment(root, 42, url, 'Two\nlines')).rejects.toThrow()
    expect(await exists(join(root, '.changelog'))).toBe(false)
  })
})

test('changelog-add CLI reports outcomes and exit codes', async () => {
  await withRoot(released('', ''), async (root) => {
    expect(await main(['42', url, 'Title'], root)).toEqual({
      exitCode: 0,
      stdout: '{"outcome":"created","path":".changelog/42.md"}\n',
      stderr: '',
    })
    expect((await main(['42', url], root)).exitCode).toBe(2)
  })
  await withRoot(released(entry, entry), async (root) => {
    const result = await main(['42', url, 'Title'], root)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toStartWith('changelog-add: Duplicate changelog marker')
  })
})
