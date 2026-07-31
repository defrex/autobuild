import { describe, expect, test } from 'bun:test'
import { htmlImageTargets, markdownTargets, withoutFencedCode } from './markdown'

describe('withoutFencedCode', () => {
  test('blanks a backtick-fenced block and keeps the surrounding lines', () => {
    const source = ['before', '```sh', 'ab dispatch', '```', 'after'].join('\n')

    expect(withoutFencedCode(source)).toBe(['before', '', '', '', 'after'].join('\n'))
  })

  test('blanks a tilde-fenced block', () => {
    const source = ['before', '~~~', 'ab dispatch', '~~~', 'after'].join('\n')

    expect(withoutFencedCode(source)).toBe(['before', '', '', '', 'after'].join('\n'))
  })

  test('a tilde line inside a backtick fence does not close it', () => {
    const source = ['```', '~~~', '[a](a.md)', '```', '[b](b.md)'].join('\n')

    expect(markdownTargets(withoutFencedCode(source))).toEqual(['b.md'])
  })

  test('an indented fence still opens and closes', () => {
    const source = ['  ```', '  [a](a.md)', '  ```', '[b](b.md)'].join('\n')

    expect(markdownTargets(withoutFencedCode(source))).toEqual(['b.md'])
  })
})

describe('markdownTargets', () => {
  test('returns link and image targets in source order', () => {
    const source = 'See [the docs](docs/architecture.md) and ![a frame](docs/assets/wide.png).'

    expect(markdownTargets(source)).toEqual(['docs/architecture.md', 'docs/assets/wide.png'])
  })

  test('unwraps an angle-bracketed target', () => {
    expect(markdownTargets('[a](<docs/a file.md>)')).toEqual(['docs/a file.md'])
  })

  test('drops a title suffix in either quote style', () => {
    expect(markdownTargets('[a](docs/a.md "The title")')).toEqual(['docs/a.md'])
    expect(markdownTargets("[a](docs/a.md 'The title')")).toEqual(['docs/a.md'])
  })

  test('keeps schemes and fragments verbatim for the caller to classify', () => {
    const source = '[site](https://example.com) [anchor](#why) [both](docs/a.md#why)'

    expect(markdownTargets(source)).toEqual(['https://example.com', '#why', 'docs/a.md#why'])
  })

  test('a reference-style image is not seen — the documented approximation', () => {
    expect(markdownTargets('![alt][ref]\n\n[ref]: docs/assets/wide.png')).toEqual([])
  })
})

describe('htmlImageTargets', () => {
  test('extracts a double-quoted src', () => {
    expect(htmlImageTargets('<img src="docs/assets/wide.png" alt="a frame">')).toEqual([
      'docs/assets/wide.png',
    ])
  })

  test('extracts a single-quoted src, and tolerates attributes before it', () => {
    expect(htmlImageTargets("<img alt='a frame' width='600' src='docs/assets/wide.png'>")).toEqual([
      'docs/assets/wide.png',
    ])
  })

  test('matches case-insensitively and returns every tag in source order', () => {
    const source = '<IMG SRC="a.png">\ntext\n<img\n  src="b.png"\n>'

    expect(htmlImageTargets(source)).toEqual(['a.png', 'b.png'])
  })

  test('ignores a tag with no src and does not confuse a neighbouring attribute', () => {
    expect(htmlImageTargets('<img alt="no source"><img data-src="x.png">')).toEqual([])
  })
})
