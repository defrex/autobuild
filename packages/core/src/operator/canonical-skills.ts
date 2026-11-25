/**
 * The canonical skills bundled with the serving Autobuild, in install form —
 * what `ab init` would vendor. The context tools serve them when a
 * repository has no captured agent context.
 *
 * `cli/init` is imported dynamically so the registry's static import graph
 * never pulls its filesystem code into a bundle that does not call it. The
 * result is memoized per process; a failure is not, so a later call retries.
 */
import { AUTOBUILD_VERSION } from '../store/remote/version'
import type { CanonicalSkillBundle } from './agent-context-serve'

let bundle: Promise<CanonicalSkillBundle> | undefined

export function defaultCanonicalSkills(): Promise<CanonicalSkillBundle> {
  if (bundle === undefined) {
    const attempt = (async () => {
      const { defaultDistRoot, readDistSkills } = await import('../cli/init')
      const root = defaultDistRoot()
      try {
        return { version: AUTOBUILD_VERSION, skills: await readDistSkills(root) }
      } catch (error) {
        throw new Error(
          `canonical skills unavailable at ${root}/skills: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
    })()
    bundle = attempt
    void attempt.catch(() => {
      if (bundle === attempt) bundle = undefined
    })
  }
  return bundle
}
