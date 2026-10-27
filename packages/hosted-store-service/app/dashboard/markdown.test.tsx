import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown, parseBlocks, safeHref } from './markdown'

const render = (source: string) => renderToStaticMarkup(<Markdown source={source} />)

test('block structure: headings start under the page heading, lists, quotes, rules and fences', () => {
  expect(
    parseBlocks(
      '# Title\n\npara one\ncontinued\n\n- a\n- b\n\n1. x\n2. y\n\n> quoted\n\n---\n\n```ts\nconst a = 1\n```',
    ).map((b) => b.kind),
  ).toEqual(['heading', 'paragraph', 'list', 'list', 'quote', 'rule', 'code'])
  const html = render('## Scope\n\nSplit it.\n\n1. one\n2. two')
  expect(html).toContain('<h5>Scope</h5>')
  expect(html).toContain('<ol><li>one</li><li>two</li></ol>')
  expect(render('```\n<b>x</b>\n```')).toContain('<pre class="block">&lt;b&gt;x&lt;/b&gt;</pre>')
})

test('inline code, emphasis and links; snake_case stays literal', () => {
  const html = render(
    'Use `ab_ticket_states` with **care** and *intent*, see [docs](https://example.com/x).',
  )
  expect(html).toContain('<code>ab_ticket_states</code>')
  expect(html).toContain('<strong>care</strong>')
  expect(html).toContain('<em>intent</em>')
  expect(html).toContain(
    '<a href="https://example.com/x" target="_blank" rel="noreferrer">docs</a>',
  )
  expect(render('rename snake_case_names here')).toContain('snake_case_names')
  expect(render('rename snake_case_names here')).not.toContain('<em>')
})

test('raw HTML stays text and unsafe link targets render as plain text', () => {
  const html = render('<script>alert(1)</script> [click](javascript:alert(1))')
  expect(html).not.toContain('<script>')
  expect(html).toContain('&lt;script&gt;')
  expect(html).not.toContain('href')
  expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c')
  expect(safeHref('data:text/html,x')).toBeUndefined()
})
