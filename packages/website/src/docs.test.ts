import { expect, test } from 'bun:test'
import { prepareHeadings, renderDocsPage, type DocsPage } from './docs'

test('heading preparation preserves markup and existing anchors and avoids collisions', () => {
  const source =
    '<h2 id="a-b">Existing</h2><h2>A &amp; <code>B</code>!</h2><h2>A &amp; B?</h2><h2>&#x43; &#68; &quot;E&quot;</h2>'
  const prepared = prepareHeadings(source)
  expect(prepared.headings).toEqual([
    { id: 'a-b', label: 'Existing' },
    { id: 'a-b-2', label: 'A & B!' },
    { id: 'a-b-3', label: 'A & B?' },
    { id: 'c-d-e', label: 'C D "E"' },
  ])
  expect(prepared.html).toContain('<h2 id="a-b-2">A &amp; <code>B</code>!</h2>')
})

const page: DocsPage = {
  group: 'start',
  path: '/docs/',
  file: 'docs/index.html',
  label: 'Start',
  title: 'Start',
  description: 'Example',
  source: 'docs/start.md',
  order: 0,
  content: '<h2>Start</h2>',
}
test('docs renderer escapes page metadata', () => {
  const html = renderDocsPage({ ...page, title: '<unsafe>"&', description: '"<text>&' }, [page])
  expect(html).toContain('<title>&lt;unsafe&gt;&quot;&amp; · Autobuild docs</title>')
  expect(html).toContain('content="&quot;&lt;text&gt;&amp;"')
})
