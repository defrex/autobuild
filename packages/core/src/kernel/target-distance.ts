import type { EventPayload } from '../events/payloads'
import type { Exec } from '../ports/workspace/git-worktree'
import type { Forge } from '../ports/types'

/** Advisory destination-only commits, pinned to both immutable tips. */
export async function sampleTargetDistance(input: {
  branch: string
  sha: string
  buildBranch: string
  localPath?: string
  exec: Exec
  forge: Pick<Forge, 'compareBranches'>
}): Promise<EventPayload<'target.distance'>> {
  const { branch, sha, buildBranch, localPath, exec, forge } = input
  const unknown = { branch, sha, head: null, count: null }
  if (localPath) {
    const git = async (...args: string[]) => {
      const result = await exec(['git', ...args], { cwd: localPath })
      if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args[0]} failed`)
      return result.stdout.trim()
    }
    const head = await git('rev-parse', '--verify', `refs/heads/${buildBranch}^{commit}`)
    if (!/^[a-f0-9]{40,64}$/.test(head)) return unknown
    const object = await exec(['git', 'cat-file', '-e', `${sha}^{commit}`], { cwd: localPath })
    if (object.exitCode !== 0)
      await git('fetch', '--no-tags', '--no-write-fetch-head', '--refmap=', 'origin', sha)
    const output = await git('rev-list', '--count', `${head}..${sha}`)
    if (!/^\d+$/.test(output)) return unknown
    const count = Number(output)
    if (!Number.isSafeInteger(count) || count < 0) return unknown
    if ((await git('rev-parse', '--verify', `refs/heads/${buildBranch}^{commit}`)) !== head)
      return unknown
    return { branch, sha, head, count }
  }
  if (!forge.compareBranches) return unknown
  const compared = await forge.compareBranches(buildBranch, branch)
  if (
    compared.headSha !== sha ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(compared.parentSha) ||
    !Number.isSafeInteger(compared.ahead) ||
    compared.ahead < 0
  )
    return unknown
  return { branch, sha, head: compared.parentSha, count: compared.ahead }
}
