import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
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
