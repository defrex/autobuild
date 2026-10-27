import { Fragment, type ReactNode } from 'react'

/**
 * Ticket bodies rendered as a safe Markdown subset: headings, paragraphs,
 * lists, quotes, rules, fenced code, and inline code, emphasis and links.
 * Output is React elements only, so raw HTML in a body stays text, and links
 * keep only http(s) and mailto targets.
 */
export function Markdown({ source, className }: { source: string; className?: string }) {
  return <div className={className ? `markdown ${className}` : 'markdown'}>{blocks(source)}</div>
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'rule' }

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      i++
      continue
    }
    const fence = line.match(/^\s*(```|~~~)/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!))
        body.push(lines[i++]!)
      i++
      out.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/)
    if (heading) {
      out.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! })
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ kind: 'rule' })
      i++
      continue
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i]!))
        body.push(lines[i++]!.replace(/^\s*>\s?/, ''))
      out.push({ kind: 'quote', text: body.join(' ') })
      continue
    }
    const item = line.match(LIST_ITEM)
    if (item) {
      const ordered = /\d/.test(item[1]!)
      const items: string[] = []
      while (i < lines.length) {
        const next = lines[i]!.match(LIST_ITEM)
        if (next && /\d/.test(next[1]!) === ordered) items.push(next[2]!)
        else if (lines[i]!.trim() && /^\s+/.test(lines[i]!) && items.length)
          items[items.length - 1] += ` ${lines[i]!.trim()}`
        else break
        i++
      }
      out.push({ kind: 'list', ordered, items })
      continue
    }
    const body: string[] = []
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,6}\s|\s*(```|~~~)|\s*>)/.test(lines[i]!) &&
      !LIST_ITEM.test(lines[i]!)
    )
      body.push(lines[i++]!.trim())
    out.push({ kind: 'paragraph', text: body.join(' ') })
  }
  return out
}

function blocks(source: string): ReactNode[] {
  return parseBlocks(source).map((block, index) => {
    const key = `${block.kind}-${index}`
    switch (block.kind) {
      case 'heading': {
        // Ticket headings sit under the page's own h2/h3, so they start at h4.
        const Tag = `h${Math.min(6, block.level + 3)}` as 'h4' | 'h5' | 'h6'
        return <Tag key={key}>{inline(block.text)}</Tag>
      }
      case 'paragraph':
        return <p key={key}>{inline(block.text)}</p>
      case 'quote':
        return <blockquote key={key}>{inline(block.text)}</blockquote>
      case 'code':
        return (
          <pre key={key} className="block">
            {block.text}
          </pre>
        )
      case 'rule':
        return <hr key={key} />
      case 'list': {
        const Tag = block.ordered ? 'ol' : 'ul'
        return (
          <Tag key={key}>
            {block.items.map((text, item) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: list items have no identity beyond position
              <li key={item}>{inline(text)}</li>
            ))}
          </Tag>
        )
      }
    }
    return null
  })
}

// Underscore emphasis needs word boundaries so `snake_case_names` stay literal.
const INLINE =
  /`([^`]+)`|\*\*(.+?)\*\*|(?<!\w)__(.+?)__(?!\w)|\*([^*\s][^*]*?)\*|(?<!\w)_([^_\s][^_]*?)_(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)/g

export function safeHref(href: string): string | undefined {
  return /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : undefined
}

function inline(text: string): ReactNode {
  const parts: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0
    if (at > last) parts.push(text.slice(last, at))
    const [whole, code, strong, strong2, em, em2, label, href] = match
    const key = `${at}-${whole.length}`
    if (code !== undefined) parts.push(<code key={key}>{code}</code>)
    else if (strong !== undefined || strong2 !== undefined)
      parts.push(<strong key={key}>{inline(strong ?? strong2!)}</strong>)
    else if (em !== undefined || em2 !== undefined)
      parts.push(<em key={key}>{inline(em ?? em2!)}</em>)
    else if (label !== undefined) {
      const target = safeHref(href!)
      parts.push(
        target ? (
          <a key={key} href={target} target="_blank" rel="noreferrer">
            {inline(label)}
          </a>
        ) : (
          <Fragment key={key}>{inline(label)}</Fragment>
        ),
      )
    }
    last = at + whole.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}
