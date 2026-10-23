import { expect, test } from 'bun:test'
import { REPO_URL } from './constants'
import { renderSiteHeader } from './site-header'

for (const section of ['home', 'docs'] as const) {
  test(`${section} shares the site navigation and accessible disclosure`, () => {
    const html = renderSiteHeader(section)
    expect(html).toContain('<a class="site-wordmark" href="/">Autobuild</a>')
    expect(html.includes('class="site-path"')).toBe(section === 'docs')
    const nav = html.match(/<nav[\s\S]*?<\/nav>/)![0]
    expect(nav.match(/aria-current="page"/g)).toHaveLength(1)
    expect(nav).toContain(`href="${section === 'home' ? '/' : '/docs/'}" aria-current="page"`)
    for (const href of ['/', '/docs/', REPO_URL]) expect(nav).toContain(`href="${href}"`)
    expect(nav).not.toContain('CHANGELOG.md')
    const id = html.match(/aria-controls="([^"]+)"/)![1]
    expect(nav).toContain(`id="${id}"`)
    expect(html).toContain('type="button" aria-expanded="false"')
    expect(html).toContain('class="site-rule" aria-hidden="true">─')
  })
}

test('docs slot stays inside the existing disclosure before site links; Home ignores it', () => {
  const slot = '<div>docs groups</div>'
  expect(renderSiteHeader('home', slot)).toBe(renderSiteHeader('home'))
  const nav = renderSiteHeader('docs', slot).match(/<nav[\s\S]*?<\/nav>/)![0]
  expect(nav.indexOf(slot)).toBeGreaterThan(0)
  expect(nav.indexOf(slot)).toBeLessThan(nav.indexOf('href="/"'))
  expect(nav.match(/<nav/g)).toHaveLength(1)
  expect(nav).toContain('aria-label="Documentation menu"')
})
