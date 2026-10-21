import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDocsIntegrity } from './docs-integrity-check'
import { renderDocsPage } from '../packages/website/src/docs'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
function page(title: string, body = '', slug?: string) {
  return `---\ntitle: ${title}\ngroup: start\norder: 1\ndescription: Example\n${slug === undefined ? '' : `slug: "${slug}"\n`}---\n# ${title}\n\n${body}`
}
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'docs-integrity-'))
  roots.push(root)
  await mkdir(join(root, 'docs'))
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, 'docs', name), text)
  return root
}

test('discovery, custom and empty slugs, private pages, encoded paths, queries and heading IDs', async () => {
  const root = await fixture({
    'home.md': page(
      'Home',
      '## Repeat\n\n## Repeat\n\n<a id="explicit"></a>\n\n[second](#repeat-2) [explicit](#explicit) [shell](#content) [custom](custom.md?q=x#destination) [route](/docs/custom%2Droute/?x=1#destination) [private](private%20page.md#private-heading) [asset](asset.txt) [home](/)',
      '',
    ),
    'custom.md': page('Custom', '## Destination', 'custom-route'),
    'private page.md': '# Private\n\n## Private heading',
    'asset.txt': 'asset',
  })
  expect(await checkDocsIntegrity({ root })).toEqual([])
})

test('each rendered navigation must cover discovery, even when pager still links the page', async () => {
  const root = await fixture({ 'home.md': page('Home'), 'new.md': page('New', '', 'fresh') })
  const findings = await checkDocsIntegrity({
    root,
    render: (page, pages) =>
      renderDocsPage(page, pages).replace(
        /<a href="\/docs\/fresh\/"[^>]*><span class="docs-marker"[\s\S]*?<\/a>/g,
        '',
      ),
  })
  expect(findings.join('\n')).toContain('navigation missing /docs/fresh/')
})

test('rejects broken links and fragments from authored Markdown, references and HTML', async () => {
  const root = await fixture({
    'a.md': page(
      'A',
      '[file](missing.md) [asset](missing.png) [route](/docs/absent/) [self](#absent) [cross](b.md#absent) [ref][bad]\n\n[bad]: missing.txt\n\n<a href="other.txt">HTML</a>\n\n[encoding](bad%ZZ.md)',
    ),
    'b.md': '# Private\n\n## Present',
  })
  const findings = (await checkDocsIntegrity({ root })).join('\n')
  for (const target of [
    'missing.md',
    'missing.png',
    '/docs/absent/',
    '#absent',
    'b.md#absent',
    'missing.txt',
    'other.txt',
    'bad%ZZ.md',
  ])
    expect(findings).toContain(target)
})

test('ignores fenced and inline code, external and protocol-relative links', async () => {
  const root = await fixture({
    'a.md': page(
      'A',
      '`[sample](missing.md)`\n\n```html\n<a href="missing.md">sample</a>\n```\n\n[external](https://example.test/a) [mail](mailto:a@example.test) [cdn](//example.test/a)',
      '',
    ),
  })
  expect(await checkDocsIntegrity({ root })).toEqual([])
})

test('fails closed for missing inputs, malformed metadata and duplicate routes', async () => {
  const root = await fixture({ 'a.md': page('A'), 'b.md': page('B', '', 'a') })
  expect((await checkDocsIntegrity({ root })).join()).toContain('duplicate route')
  await writeFile(join(root, 'docs/b.md'), '---\ntitle: [invalid]\n---\n# Invalid')
  expect((await checkDocsIntegrity({ root })).length).toBeGreaterThan(0)
  await rm(join(root, 'docs'), { recursive: true })
  expect((await checkDocsIntegrity({ root })).join()).toContain('Cannot check')
})

test('check command gates docs integrity after generated reference and parity checks', async () => {
  const pkg = JSON.parse(await readFile(join(import.meta.dir, '../package.json'), 'utf8'))
  expect(pkg.scripts.check).toContain(
    'bun tools/configuration-reference.ts --check && bun tools/docs-reference-sync.ts && bun tools/docs-integrity-check.ts',
  )
})

test('checks mobile navigation independently and rejects its unknown routes', async () => {
  const root = await fixture({ 'home.md': page('Home', '', '') })
  const findings = await checkDocsIntegrity({
    root,
    render: (page, pages) =>
      renderDocsPage(page, pages).replace(
        /(<div class="docs-menu-navigation"[^>]*>)[\s\S]*?(<div class="docs-site-links">)/,
        '$1<a href="/docs/unknown/">Unknown</a></div>$2',
      ),
  })
  expect(findings.join()).toContain('navigation missing /docs/')
  expect(findings.join()).toContain('missing website route /docs/unknown/')
})

test('unreadable Markdown targets and missing docs root fail closed', async () => {
  const root = await fixture({ 'home.md': page('Home', '[bad](directory.md#heading)', '') })
  await mkdir(join(root, 'docs/directory.md'))
  expect((await checkDocsIntegrity({ root })).length).toBeGreaterThan(0)
  expect(
    (await checkDocsIntegrity({ root, docsRoot: join(root, 'missing') })).length,
  ).toBeGreaterThan(0)
})
