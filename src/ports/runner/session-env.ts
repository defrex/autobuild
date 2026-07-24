/**
 * Build the environment passed to an agent runtime for one turn.
 *
 * Scoped values (AB_STORE, AB_PHASE, and so on) override the ambient process
 * environment. The distribution-owned launcher is then forced to the front of
 * PATH so an inherited executable with the public `ab` name cannot shadow the
 * Autobuild CLI. A fresh object is returned on every call; neither input nor
 * process.env is mutated, which keeps concurrent builds isolated.
 */
import { delimiter, resolve } from 'node:path'

/** Private command directory shipped by this Autobuild distribution. */
export const AGENT_BIN_DIR = resolve(import.meta.dir, '..', '..', '..', 'bin', 'agent')

export function sessionEnv(
  scoped: Readonly<Record<string, string>>,
  ambient: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(ambient)) {
    if (value !== undefined) env[key] = value
  }
  Object.assign(env, scoped)

  const inheritedPath = env.PATH
  const inheritedEntries =
    inheritedPath === undefined || inheritedPath === ''
      ? []
      : inheritedPath.split(delimiter).filter((entry) => entry !== AGENT_BIN_DIR)
  env.PATH = [AGENT_BIN_DIR, ...inheritedEntries].join(delimiter)

  return env
}
