import { z } from 'zod'
import { documentSchema } from './reference-metadata'

/**
 * The intentionally small path-selector grammar (§16.1): positive,
 * repository-relative globs with literal characters, `*`, `?`, and `**` only
 * as a complete path segment. Reject every ambiguous/unsafe form at config
 * load rather than allowing a typo to become a never-running safety gate.
 */
export function pathSelectorError(pattern: string): string | undefined {
  if (pattern.length === 0) return 'path selectors must be nonempty'
  if (pattern.includes('\0')) return 'path selectors must not contain NUL bytes'
  if (pattern.startsWith('/') || /^[A-Za-z]:\//.test(pattern)) {
    return 'path selectors must be repository-relative, not absolute'
  }
  if (pattern.includes('\\')) {
    return 'path selectors use Git-style "/" separators; backslashes and escapes are unsupported'
  }
  if (pattern.startsWith('!')) {
    return 'path selectors are positive globs; negation is unsupported'
  }
  if (/[[\]{}]/.test(pattern)) {
    return 'path selectors support only literal characters, *, ?, and whole-segment **; character classes and brace expansion are unsupported'
  }
  if (/[?*+@!]\(/.test(pattern)) {
    return 'path selectors support only literal characters, *, ?, and whole-segment **; extglobs are unsupported'
  }

  const segments = pattern.split('/')
  if (segments.some((segment) => segment.length === 0)) {
    return 'path selectors must not contain empty path segments'
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return 'path selectors must not contain "." or ".." traversal segments'
  }
  if (segments.some((segment) => segment.includes('**') && segment !== '**')) {
    return 'the ** wildcard must occupy a complete path segment'
  }
  return undefined
}

export const pathSelectorSchema = z.string().superRefine((pattern, ctx) => {
  const message = pathSelectorError(pattern)
  if (message !== undefined) ctx.addIssue({ code: 'custom', message })
})

documentSchema(pathSelectorSchema, {
  constraints:
    'Positive repository-relative globs with literal characters, *, ?, and whole-segment ** only. No NUL, absolute paths, backslashes, negation, empty or traversal segments, character classes, brace expansion or extglobs.',
})

/**
 * Compile validated selectors into one any-match predicate. Fail-closed for
 * direct callers: Bun.Glob is never asked to interpret syntax outside the
 * documented subset. Matching is case-sensitive.
 */
export function compilePathSelectors(
  selectors: readonly string[],
  describe: (selector: string, error: string) => string = (selector, error) =>
    `invalid path selector ${JSON.stringify(selector)}: ${error}`,
): (path: string) => boolean {
  for (const selector of selectors) {
    const error = pathSelectorError(selector)
    if (error !== undefined) throw new Error(describe(selector, error))
  }
  const globs = selectors.map((selector) => new Bun.Glob(selector))
  return (path) => globs.some((glob) => glob.match(path))
}
