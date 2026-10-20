/** Serialize only the authored article, using its rendered, entity-decoded DOM. */
export function articleMarkdown(article: Element, canonicalPageUrl: string): string {
  // Inline punctuation stays readable unless Markdown can interpret it as markup.
  const escapeText = (text: string): string => text.replace(/[\\`*_[\]<>]|!(?=\[)/g, '\\$&')
  // Paragraphs and bare container text can otherwise become headings or lists.
  // Heading text already follows our emitted heading marker and needs no such escape.
  const escapeBlockStart = (text: string): string =>
    text
      .replace(/^(#{1,6}(?=\s|$)|[-+](?=\s|$)|-(?=--[-\s]*$))/, '\\$&')
      .replace(/^(\d+)([.)])(?=\s|$)/, '$1\\$2')
  const run = (text: string): number =>
    Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const children = (node: Node): string => [...node.childNodes].map(inline).join('')
  const excluded = (node: Element): boolean =>
    node.matches('[data-markdown-exclude], .docs-eyebrow')
  const inline = (node: Node): string => {
    if (node.nodeType === 3) return escapeText((node.textContent ?? '').replace(/\s+/g, ' '))
    if (!(node instanceof Element) || excluded(node)) return ''
    const text = children(node)
    switch (node.tagName) {
      case 'STRONG':
      case 'B':
        return `**${text}**`
      case 'EM':
      case 'I':
        return `*${text}*`
      case 'CODE': {
        const value = (node.textContent ?? '').replace(/\r?\n/g, ' ')
        const ticks = '`'.repeat(run(value) + 1)
        const pad = /^`|`$/.test(value) || (/^ .* $/.test(value) && /[^ ]/.test(value)) ? ' ' : ''
        return `${ticks}${pad}${value}${pad}${ticks}`
      }
      case 'A': {
        const href = node.getAttribute('href')
        if (!href) return text
        const url = new URL(href, canonicalPageUrl).href.replace(/[<>\\]/g, (c) =>
          encodeURIComponent(c),
        )
        return `[${text}](<${url}>)`
      }
      case 'BR':
        return '  \n'
      default:
        return text
    }
  }
  const list = (element: Element): string => {
    let number = Number(element.getAttribute('start') ?? 1)
    return [...element.children]
      .filter((child) => child.tagName === 'LI')
      .map((item) => {
        if (item.hasAttribute('value')) number = Number(item.getAttribute('value'))
        const marker = element.tagName === 'OL' ? `${number++}. ` : '- '
        const body = blocks([...item.childNodes]).trim()
        return marker + body.replace(/\n/g, `\n${' '.repeat(marker.length)}`)
      })
      .join('\n')
  }
  const blocks = (nodes: Node[]): string => {
    const output: string[] = []
    let pending = ''
    const flush = (): void => {
      if (pending.trim()) output.push(escapeBlockStart(pending.trim()))
      pending = ''
    }
    for (const node of nodes) {
      if (!(node instanceof Element)) {
        pending += inline(node)
        continue
      }
      if (excluded(node)) continue
      const tag = node.tagName
      if (/^H[1-6]$/.test(tag)) {
        flush()
        output.push(`${'#'.repeat(Number(tag[1]))} ${children(node).trim()}`)
      } else if (tag === 'PRE') {
        flush()
        const code = node.querySelector('code') ?? node
        const value = code.textContent ?? ''
        const fence = '`'.repeat(Math.max(3, run(value) + 1))
        const language =
          [...code.classList].find((name) => name.startsWith('language-'))?.slice(9) ?? ''
        output.push(`${fence}${language}\n${value}${value.endsWith('\n') ? '' : '\n'}${fence}`)
      } else if (tag === 'UL' || tag === 'OL') {
        flush()
        output.push(list(node))
      } else if (tag === 'P') {
        flush()
        output.push(escapeBlockStart(children(node).trim()))
      } else if (['DIV', 'SECTION', 'ARTICLE'].includes(tag)) {
        flush()
        output.push(blocks([...node.childNodes]))
      } else pending += inline(node)
    }
    flush()
    return output.filter(Boolean).join('\n\n')
  }
  return `${blocks([...article.childNodes])}\n`
}
