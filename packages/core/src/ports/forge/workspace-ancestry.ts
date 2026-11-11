import { gitOid } from '../../events/payloads'
import type { Forge } from '../types'
import type { Exec } from '../workspace/git-worktree'

/**
 * A remote guest has no forge credential, so the GitHub `compare` request
 * behind `isCommitAncestor` would go out anonymously and spend the shared
 * sandbox address's unauthenticated quota. The guest's workspace is a full
 * clone with an already-authorized Git read channel, so ancestry is proven
 * there instead: `merge-base --is-ancestor`, fetching both commits by SHA once
 * when either object is missing. Every other member passes through unchanged.
 * It makes no forge API request and no Store read.
 */
export function withWorkspaceAncestry(
  forge: Forge,
  deps: { exec: Exec; workspacePath: string },
): Forge {
  const isAncestor = (ancestor: string, descendant: string) =>
    deps.exec(['git', 'merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: deps.workspacePath,
    })
  const isCommitAncestor = async (ancestor: string, descendant: string): Promise<boolean> => {
    if (!gitOid.safeParse(ancestor).success || !gitOid.safeParse(descendant).success)
      throw new Error('invalid ancestry OID')
    let result = await isAncestor(ancestor, descendant)
    if (result.exitCode === 0) return true
    if (result.exitCode === 1) return false
    const fetched = await deps.exec(
      [
        'git',
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        '--refmap=',
        'origin',
        ancestor,
        descendant,
      ],
      { cwd: deps.workspacePath },
    )
    if (fetched.exitCode !== 0)
      throw new Error(
        `workspace ancestry fetch failed (exit ${fetched.exitCode}): ${fetched.stderr.trim()}`,
      )
    result = await isAncestor(ancestor, descendant)
    if (result.exitCode === 0) return true
    if (result.exitCode === 1) return false
    throw new Error(
      `workspace ancestry check failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    )
  }
  return new Proxy(forge, {
    get(target, key) {
      // Capability-preserving: a forge without ancestry proof keeps none.
      if (key === 'isCommitAncestor' && target.isCommitAncestor) return isCommitAncestor
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
