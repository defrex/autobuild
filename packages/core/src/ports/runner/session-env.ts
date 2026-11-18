/**
 * Build the environment passed to an agent runtime for one turn.
 *
 * Scoped values (AB_STORE, AB_PHASE, and so on) override the ambient process
 * environment. A judge session (scoped `AB_JUDGE`) drops every ambient
 * `AB_*` and `GIT_*` key and `PWD`/`OLDPWD` first. The distribution-owned launcher is then forced to the front of
 * PATH so an inherited executable with the public `ab` name cannot shadow the
 * Autobuild CLI. A judge launch (`judgeLaunch`) goes further: every ambient
 * value naming a hidden location (the repository, its Git common directory,
 * the local store) is dropped, hidden `PATH` entries are filtered out, and the
 * judge's own launcher directory replaces the distribution's, so nothing the
 * judge inherits names a protected path (SPEC §13.1.1). A fresh object is
 * returned on every call; neither input nor process.env is mutated, which
 * keeps concurrent builds isolated.
 */
import { delimiter } from 'node:path'
import { distributionPath } from '../../distribution'

/** Private command directory shipped by this Autobuild distribution. */
export const AGENT_BIN_DIR = distributionPath('bin', 'agent')

/** A judge session's launch: the locations nothing it inherits may name, and
 * the scratch directory holding its self-contained `ab` launcher. */
export interface JudgeLaunch {
  hide: readonly string[]
  binDir: string
}

const NAME_CHAR = /[A-Za-z0-9._~-]/

/** Whether `value` names `path` anywhere in it: an occurrence neither
 * continued nor preceded by a file-name character, so `/repo` names `/repo/x`
 * and `a:/repo` but not `/repo-other`, `/repo.bak` or `/x/repo`. */
export function namesPath(value: string, path: string): boolean {
  if (path === '' || path === '/') return false
  for (let at = value.indexOf(path); at !== -1; at = value.indexOf(path, at + 1)) {
    const before = at === 0 ? undefined : value[at - 1]!
    const next = value[at + path.length]
    if (
      (before === undefined || !NAME_CHAR.test(before)) &&
      (next === undefined || !NAME_CHAR.test(next))
    )
      return true
  }
  return false
}

/** Whether a PATH entry is at or under one of the hidden locations. */
function underAny(entry: string, hide: readonly string[]): boolean {
  return hide.some((path) => entry === path || entry.startsWith(`${path}/`))
}

export function sessionEnv(
  scoped: Readonly<Record<string, string>>,
  ambient: Readonly<Record<string, string | undefined>> = process.env,
  judgeLaunch?: JudgeLaunch,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(ambient)) {
    if (value !== undefined) env[key] = value
  }
  delete env.AB_TICKET_TOKEN
  delete env.AB_TICKET_URL
  delete env.AB_TOKEN
  const judge = scoped.AB_JUDGE !== undefined
  // A judge session inherits no Autobuild identity, no Git selection and no
  // working-directory hint from the dispatcher: only its scoped values reach
  // it (SPEC §13.1.1).
  if (judge)
    for (const key of Object.keys(env))
      if (key.startsWith('AB_') || key.startsWith('GIT_') || key === 'PWD' || key === 'OLDPWD')
        delete env[key]
  const launch = judge ? judgeLaunch : undefined
  if (launch !== undefined)
    for (const [key, value] of Object.entries(env))
      if (key !== 'PATH' && launch.hide.some((path) => namesPath(value, path))) delete env[key]
  Object.assign(env, scoped)
  delete env.AB_DISPATCH_GENERATION

  const binDir = launch?.binDir ?? AGENT_BIN_DIR
  const inheritedPath = env.PATH
  const inheritedEntries =
    inheritedPath === undefined || inheritedPath === ''
      ? []
      : inheritedPath
          .split(delimiter)
          .filter(
            (entry) =>
              entry !== binDir &&
              (launch === undefined ||
                (entry !== AGENT_BIN_DIR && entry !== '' && !underAny(entry, launch.hide))),
          )
  env.PATH = [binDir, ...inheritedEntries].join(delimiter)

  return env
}
