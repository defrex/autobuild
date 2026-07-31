/**
 * Approximate Markdown reference extraction, shared by the checks that ask
 * "does this link point at something that exists?".
 *
 * These are regexes, not a CommonMark parser. Reference-style targets
 * (`![alt][ref]`) and targets containing parentheses are invisible to them.
 * Both callers are link-existence checks, where an unseen reference fails
 * toward a loud complaint rather than a silent pass, so the approximation is
 * safe — but a false report is a signal to widen the parser, never to delete
 * the thing it failed to see.
 */

/**
 * Blanks out fenced code blocks, preserving line count. A target inside a fence
 * is sample text, not a rendered reference. Backtick and tilde fences are
 * tracked separately so a `~~~` line inside a ``` block does not close it.
 */
export function withoutFencedCode(markdown: string): string {
  const lines = markdown.split('\n')
  let fence: '`' | '~' | undefined
  return lines
    .map((line) => {
      const opening = line.match(/^\s*(`{3,}|~{3,})/)
      if (opening) {
        const marker = opening[1]![0] as '`' | '~'
        if (fence === undefined) fence = marker
        else if (fence === marker) fence = undefined
        return ''
      }
      return fence === undefined ? line : ''
    })
    .join('\n')
}

/**
 * Inline link and image targets, in source order. Angle brackets are unwrapped
 * and a title suffix is dropped, so `[a](<b.md> "T")` yields `b.md`.
 */
export function markdownTargets(markdown: string): string[] {
  const targets: string[] = []
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const inline = match[1]!.trim()
    // An angle-bracketed destination runs to its closing `>`, and whatever
    // follows is the title. The two must be read together: unwrapping first
    // fails whenever a title is present (the text no longer ends in `>`), and
    // splitting the title off first would truncate a bracketed destination that
    // legitimately contains whitespace and a quote. A `<` with no closing `>`
    // is malformed, and falls through to the unbracketed reading.
    const closing = inline.startsWith('<') ? inline.indexOf('>') : -1
    targets.push(closing === -1 ? inline.split(/\s+["']/u, 1)[0]! : inline.slice(1, closing))
  }
  return targets
}

/**
 * `src` attributes of raw `<img>` tags, in source order. Kept separate from
 * `markdownTargets` so callers that only care about Markdown syntax keep their
 * existing behaviour: Markdown permits raw HTML, and this repository's README
 * already mixes it in, so a centred hero image would otherwise be invisible.
 */
export function htmlImageTargets(markdown: string): string[] {
  const targets: string[] = []
  for (const match of markdown.matchAll(/<img\b[^>]*?\ssrc\s*=\s*("([^"]*)"|'([^']*)')/giu)) {
    targets.push((match[2] ?? match[3])!.trim())
  }
  return targets
}
