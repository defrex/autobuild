import { expect, test } from 'bun:test'
import type { DocsPage } from './docs'
import { docsBaselineEntry, docsBaselineFileName, renderDocsBaseline } from './docs-baseline'

function page(source: string, overrides: Partial<DocsPage> = {}): DocsPage {
  const slug = source.replace(/^docs\/|\.md$/g, '')
  return {
    title: `Title ${slug}`,
    description: `About ${slug}.`,
    group: 'concepts',
    order: 1,
    label: `Label ${slug}`,
    source,
    path: `/docs/${slug}/`,
    file: `docs/${slug}/index.html`,
    content: `<h2>Heading ${slug}</h2>\n<p>Words for ${slug}.</p>\n<pre><code>bun ${slug}\n</code></pre>\n`,
    ...overrides,
  }
}

test('baseline entries decode entities and capture text, headings, code and metadata', () => {
  const entry = docsBaselineEntry(
    page('docs/alpha.md', {
      content:
        '<h2>A &amp; <code>B</code></h2>\n<p>One   &#x43;\n two &#68; &quot;q&quot;</p>\n<pre><code class="language-sh">a &lt;b&gt;\n</code></pre>\n',
    }),
  )
  expect(entry).toEqual({
    path: '/docs/alpha/',
    label: 'Label alpha',
    title: 'Title alpha',
    group: 'concepts',
    description: 'About alpha.',
    textHash: new Bun.CryptoHasher('sha256').update('A & B One C two D "q" a <b>').digest('hex'),
    headings: ['A & B'],
    code: ['a <b>'],
  })
  expect(Object.keys(entry)).toEqual([
    'path',
    'label',
    'title',
    'group',
    'description',
    'textHash',
    'headings',
    'code',
  ])
})

test('each page change rewrites only that page file', () => {
  const pages = [page('docs/alpha.md'), page('docs/beta.md')]
  const before = renderDocsBaseline(pages)
  const beta = pages[1]!
  for (const changed of [
    { content: beta.content.replace('Words for', 'Other words for') },
    { content: beta.content.replace('Heading beta', 'Renamed') },
    { content: beta.content.replace('bun beta', 'bun other') },
    { title: 'New title' },
    { description: 'New description.' },
  ]) {
    const after = renderDocsBaseline([pages[0]!, { ...beta, ...changed }])
    expect(after.get('alpha.json')).toBe(before.get('alpha.json')!)
    expect(after.get('beta.json')).not.toBe(before.get('beta.json')!)
  }
})

test('rendering is deterministic, named by source stem, and rejects duplicate stems', () => {
  const pages = [page('docs/alpha.md', { path: '/docs/' }), page('docs/beta.md')]
  const first = renderDocsBaseline(pages)
  expect(renderDocsBaseline(pages)).toEqual(first)
  expect([...first.keys()]).toEqual(['alpha.json', 'beta.json'])
  for (const text of first.values()) expect(text.endsWith('}\n')).toBe(true)
  expect(docsBaselineFileName(pages[0]!)).toBe('alpha.json')
  expect(() => renderDocsBaseline([pages[0]!, page('docs/alpha.md')])).toThrow(
    'duplicate docs baseline file alpha.json',
  )
})
