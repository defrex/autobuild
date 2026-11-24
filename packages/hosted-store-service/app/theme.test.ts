import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { applyTheme, THEME_BOOTSTRAP, THEME_KEY, themePreference } from './theme'

function harness(stored: unknown, denied = false) {
  const attrs = new Map<string, string>()
  const root = {
    setAttribute: (key: string, value: string) => attrs.set(key, value),
    removeAttribute: (key: string) => attrs.delete(key),
  }
  const storage = {
    getItem: (key: string) => {
      expect(key).toBe(THEME_KEY)
      if (denied) throw new Error('denied')
      return stored
    },
  }
  return {
    attrs,
    root,
    run: () =>
      runInNewContext(THEME_BOOTSTRAP, {
        document: { documentElement: root },
        localStorage: storage,
      }),
  }
}
for (const choice of [null, '', 'bad', 'system', 'light', 'dark']) {
  test(`pre-paint validates ${choice}`, () => {
    const h = harness(choice)
    h.run()
    expect(h.attrs.get('data-theme')).toBe(
      choice === 'light' || choice === 'dark' ? choice : undefined,
    )
    expect(themePreference(choice)).toBe(
      choice === 'light' || choice === 'dark' ? choice : 'system',
    )
  })
}
test('System removes explicit preference, allowing live OS media changes', () => {
  const h = harness('dark')
  h.run()
  applyTheme('light', h.root as unknown as HTMLElement)
  expect(h.attrs.get('data-theme')).toBe('light')
  applyTheme('system', h.root as unknown as HTMLElement)
  expect(h.attrs.has('data-theme')).toBe(false)
})
test('storage denial does not prevent first paint or explicit changes', () => {
  const h = harness(null, true)
  expect(h.run).not.toThrow()
  applyTheme('dark', h.root as unknown as HTMLElement)
  expect(h.attrs.get('data-theme')).toBe('dark')
})
