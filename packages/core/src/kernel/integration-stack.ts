import type { Exec } from '../ports/workspace/git-worktree'
import { buildTrailers } from './build-identity'

/** A node has no wrapper identity: every commit retains its contributing build. */
export async function inspectIntegrationStack(
  exec: Exec,
  cwd: string,
  parent: string,
  head: string,
): Promise<string[]> {
  const ancestry = await exec(['git', 'merge-base', '--is-ancestor', parent, head], { cwd })
  if (ancestry.exitCode !== 0)
    throw new Error('integration stack is not a fast-forward of its verified parent')
  const range = await exec(
    ['git', 'log', '--reverse', '--format=%H%x00%P%x00%B%x00', `${parent}..${head}`, '--'],
    { cwd },
  )
  if (range.exitCode !== 0) throw new Error('cannot inspect integration stack')
  const fields = range.stdout.split('\0')
  const builds: string[] = []
  let previous = parent
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const sha = fields[index]!.trim()
    const parents = fields[index + 1]!.trim()
    const identities = buildTrailers(fields[index + 2]!)
    if (parents !== previous || identities.length !== 1 || builds.includes(identities[0]!))
      throw new Error(
        'integration stack requires a linear range with one unique build identity per commit',
      )
    builds.push(identities[0]!)
    previous = sha
  }
  if (!builds.length || previous !== head)
    throw new Error('integration stack has no complete owned range')
  return builds
}
