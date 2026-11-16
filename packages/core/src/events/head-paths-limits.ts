/** Bounds of the `head.paths-recorded` summary. A leaf module so the payload
 * schema and `kernel/head-paths.ts` share them without an import cycle. */

/** The most changed (or resolution) paths an event or build state carries.
 * The complete sets live in the `head-paths` artifact. */
export const HEAD_PATHS_PREVIEW = 100

/** The most per-head summaries build state keeps, newest last. */
export const HEAD_PATHS_RECORDS = 4

/** The build artifact kind holding a head's complete path sets. */
export const HEAD_PATHS_ARTIFACT = 'head-paths'

export const HEAD_PATHS_SOURCES = [
  'finalize',
  'finalize-step',
  'restack',
  'reconcile',
  'node-rewrite',
  'integration',
] as const
