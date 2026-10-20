import { REPO_URL } from './constants'

/** One masthead for the public site's Home and Docs sections. */
export function renderSiteHeader(section: 'home' | 'docs', docsNavigation?: string): string {
  const links = [
    ['home', '/', 'Home'],
    ['docs', '/docs/', 'Docs'],
    ['changelog', `${REPO_URL}/blob/main/CHANGELOG.md`, 'Changelog'],
    ['github', REPO_URL, 'GitHub ↗'],
  ]
    .map(
      ([key, href, label]) =>
        `<a href="${href}"${key === section ? ' aria-current="page"' : ''}>${label}</a>`,
    )
    .join('')
  return `<header class="site-header" data-site-header>
<div class="site-masthead"><div class="site-brand"><a class="site-wordmark" href="/">Autobuild</a>${section === 'docs' ? '<span class="site-slash">/</span><a class="site-path" href="/docs/">docs</a>' : ''}</div>
<button id="site-menu-trigger" class="site-menu" type="button" aria-expanded="false" aria-controls="site-navigation" data-site-menu>Menu ▾</button>
<nav id="site-navigation" class="site-nav" aria-label="Site">${section === 'docs' && docsNavigation ? `<div class="docs-menu-navigation" role="group" aria-label="Documentation menu">${docsNavigation}</div><div class="docs-site-links">${links}</div>` : links}</nav></div>
<div class="site-rule" aria-hidden="true">${'─'.repeat(400)}</div>
</header>`
}
