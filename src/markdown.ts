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
 * and a `"title"` suffix is dropped, so `[a](<b.md> "T")` yields `b.md`.
 */
export function markdownTargets(markdown: string): string[] {
  const targets: string[] = []
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1]!.trim()
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
    target = target.split(/\s+["']/u, 1)[0]!
    targets.push(target)
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
