/**
 * Shared event-glob compilation (§15.3, AUT-342): the anchored glob matcher
 * `ab watch`, `ab wait`, and the `[orchestrator].wake` configuration use.
 * `*` matches any run of characters, `?` exactly one, everything else
 * verbatim (so the dots inside event type names are escaped). Every glob
 * must match at least one event type in one of the given catalogs, else a
 * validation error naming the glob is thrown.
 */
import { EVENT_TYPES } from './payloads'
import { REPOSITORY_EVENT_TYPES } from './repository'

export interface CompileEventGlobsOptions {
  /** Also accept matches in the repository-journal catalog (the `--repository`
   * behavior of `ab watch`/`ab wait`). */
  repository?: boolean
  usage: string
}

export function compileEventGlobs(
  globs: readonly string[],
  opts: CompileEventGlobsOptions,
): RegExp[] {
  return globs.map((glob) => {
    const source =
      '^' +
      [...glob]
        .map((char) => {
          if (char === '*') return '.*'
          if (char === '?') return '.'
          return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        })
        .join('') +
      '$'
    const regex = new RegExp(source)
    const inBuildCatalog = EVENT_TYPES.some((type) => regex.test(type))
    const inRepositoryCatalog =
      opts.repository === true && REPOSITORY_EVENT_TYPES.some((type) => regex.test(type))
    if (!inBuildCatalog && !inRepositoryCatalog) {
      throw new Error(
        `--event "${glob}" matches no known event type${
          opts.repository ? ' in the build or repository catalogs' : ' in the build event catalog'
        } — ${opts.usage}`,
      )
    }
    return regex
  })
}
