import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

test('theme bootstrap runs in head and hydration exception is confined to html', () => {
  const source = readFileSync(new URL('./layout.tsx', import.meta.url), 'utf8')
  expect(source.indexOf('__html: THEME_BOOTSTRAP')).toBeLessThan(source.indexOf('<body>'))
  expect(source.match(/suppressHydrationWarning/g)).toHaveLength(1)
  expect(source).toContain('next/font/local')
  expect(source).not.toContain('next/font/google')
})
