/**
 * Build the environment passed to an agent runtime for one turn.
 *
 * Scoped values (AB_STORE, AB_PHASE, and so on) override the ambient process
 * environment. A judge session (scoped `AB_JUDGE`) drops every ambient
 * `AB_*` and `GIT_*` key and `PWD`/`OLDPWD` first. The distribution-owned launcher is then forced to the front of
 * PATH so an inherited executable with the public `ab` name cannot shadow the
 * Autobuild CLI. A fresh object is returned on every call; neither input nor
 * process.env is mutated, which keeps concurrent builds isolated.
 */
import { delimiter } from 'node:path'
import { distributionPath } from '../../distribution'

/** Private command directory shipped by this Autobuild distribution. */
export const AGENT_BIN_DIR = distributionPath('bin', 'agent')

export function sessionEnv(
  scoped: Readonly<Record<string, string>>,
  ambient: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(ambient)) {
    if (value !== undefined) env[key] = value
  }
  delete env.AB_TICKET_TOKEN
  delete env.AB_TICKET_URL
  delete env.AB_TOKEN
  // A judge session inherits no Autobuild identity, no Git selection and no
  // working-directory hint from the dispatcher: only its scoped values reach
  // it (SPEC §13.1.1).
  if (scoped.AB_JUDGE !== undefined)
    for (const key of Object.keys(env))
      if (key.startsWith('AB_') || key.startsWith('GIT_') || key === 'PWD' || key === 'OLDPWD')
        delete env[key]
  Object.assign(env, scoped)
  delete env.AB_DISPATCH_GENERATION

  const inheritedPath = env.PATH
  const inheritedEntries =
    inheritedPath === undefined || inheritedPath === ''
      ? []
      : inheritedPath.split(delimiter).filter((entry) => entry !== AGENT_BIN_DIR)
  env.PATH = [AGENT_BIN_DIR, ...inheritedEntries].join(delimiter)

  return env
}
