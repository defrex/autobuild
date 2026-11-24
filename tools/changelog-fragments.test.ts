import { expect, test } from 'bun:test'
import { fragmentPath, parseFragment, renderFragment } from './changelog-fragments'

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
