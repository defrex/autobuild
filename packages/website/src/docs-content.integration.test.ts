import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDocsPages } from './docs-content'
import { buildFiles } from './build'

const article = (extra = '', body = '## Section\n\nWords **bold** and *emphasis*.') =>
  `---\ntitle: Example\ngroup: guides\norder: 1\ndescription: Example description\n${extra}\n---\n\n# Example\n\n${body}\n`

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'docs-content-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('discovery sorts groups, orders and filenames and leaves unmarked references unpublished', async () => {
  await fixture(async (root) => {
    for (const name of [
      'website',
      'hosted-dispatcher-cutover-validation',
      'vercel-sandbox-rollout-probe',
    ])
      await Bun.write(join(root, `${name}.md`), '# Private')
    await Bun.write(join(root, 'z.md'), article('slug: ""'))
    await Bun.write(join(root, 'a.md'), article())
    await Bun.write(join(root, 'first.md'), article().replace('guides', 'start'))
    const pages = await loadDocsPages(root)
    expect(pages.map((p) => p.path)).toEqual(['/docs/first/', '/docs/a/', '/docs/'])
    expect(pages[1]!.content).toContain('<strong>bold</strong>')
    expect(pages[1]!.content).toContain('<em>emphasis</em>')
    expect(pages[1]!.content).not.toContain('<h1')
    const files = await buildFiles(root)
    expect(Object.keys(files).filter((p) => p.startsWith('docs/'))).toHaveLength(3)
    for (const name of [
      'website',
      'hosted-dispatcher-cutover-validation',
      'vercel-sandbox-rollout-probe',
    ]) {
      expect(files['docs/a/index.html']).not.toContain(`/docs/${name}/`)
      expect(`docs/${name}/index.html` in files).toBe(false)
    }
    await rm(join(root, 'a.md'))
    expect('docs/a/index.html' in (await buildFiles(root))).toBe(false)
  })
})

test('Markdown links resolve public routes, queries and fragments, and repository references without altering code', async () => {
  await fixture(async (root) => {
    await Bun.write(join(root, 'other.md'), article())
    await Bun.write(join(root, 'reference.md'), '# Reference')
    await Bun.write(
      join(root, 'example.md'),
      article(
        '',
        '[Public](other.md?x=1&y=2#section) [Ref](reference.md#ref) [External](https://example.com) [Here](#section)\n\n```sh\n<a href="other.md"> & code\n```\n\n`[link](other.md)`',
      ),
    )
    const pages = await loadDocsPages(root)
    const content = pages.find((p) => p.path === '/docs/example/')!.content
    expect(content).toContain('href="/docs/other/?x=1&amp;y=2#section"')
    expect(content).toContain(`/blob/main/${root.split('/').at(-1)}/reference.md#ref`)
    expect(content).toContain('href="https://example.com"')
    expect(content).toContain('href="#section"')
    expect(content).toContain(
      '<pre class="terminal"><code class="language-sh">&lt;a href=&quot;other.md&quot;&gt; &amp; code\n</code></pre>',
    )
    expect(content).toContain('<code>[link](other.md)</code>')
    await rm(join(root, 'other.md'))
    await expect(loadDocsPages(root)).rejects.toThrow('missing Markdown target')
  })
})

test.each([
  ['title: Example', 'title: 42'],
  ['description: Example description', 'description: []'],
  ['group: guides', 'group: unknown'],
  ['order: 1', 'order: "1"'],
  ['order: 1', 'order: .inf'],
  ['# Example', '# Different'],
])('invalid public metadata fails: %s', async (from, to) => {
  await fixture(async (root) => {
    await Bun.write(join(root, 'bad.md'), article().replace(from, to))
    await expect(loadDocsPages(root)).rejects.toThrow()
  })
})

test('unsafe slugs, duplicate routes, labels, unclosed frontmatter and second h1 fail closed', async () => {
  await fixture(async (root) => {
    for (const extra of ['slug: ../bad', 'slug: [bad]', 'label: 42', 'label: ""']) {
      await Bun.write(join(root, 'bad.md'), article(extra))
      await expect(loadDocsPages(root)).rejects.toThrow()
    }
    await Bun.write(join(root, 'bad.md'), '---\ntitle: Bad')
    await expect(loadDocsPages(root)).rejects.toThrow('unclosed')
    await Bun.write(join(root, 'bad.md'), article('', '# Example'))
    await expect(loadDocsPages(root)).rejects.toThrow('opening h1')
    await Bun.write(join(root, 'bad.md'), article('slug: same'))
    await Bun.write(join(root, 'other.md'), article('slug: same'))
    await expect(loadDocsPages(root)).rejects.toThrow('duplicate route')
  })
})
