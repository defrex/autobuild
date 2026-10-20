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
    for (const href of ['/', '/docs/', REPO_URL, `${REPO_URL}/blob/main/CHANGELOG.md`])
      expect(nav).toContain(`href="${href}"`)
    const id = html.match(/aria-controls="([^"]+)"/)![1]
    expect(nav).toContain(`id="${id}"`)
    expect(html).toContain('type="button" aria-expanded="false"')
    expect(html).toContain('class="site-rule" aria-hidden="true">─')
  })
}
