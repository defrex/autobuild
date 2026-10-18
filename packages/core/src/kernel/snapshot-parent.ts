import type { RestackDeps } from './reconcile-restack'
import { isValidGitBranchName } from './origin'

export async function snapshotParent(
  deps: Pick<RestackDeps, 'forge' | 'exec' | 'workspacePath'>,
  base: string,
  destinationRef: string,
) {
  const input = { workspacePath: deps.workspacePath, base, destinationRef }
  if (deps.forge.snapshotBase) return deps.forge.snapshotBase(input)
  if (!isValidGitBranchName(base)) throw new Error('invalid node parent branch')
  // Like leaf target snapshots, Git-transport forges fetch into a private ref.
  // The dispatcher supplies the forge's credentialed kernel execution seam.
  const fetched = await deps.exec(
    [
      'git',
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      '--refmap=',
      'origin',
      `+refs/heads/${base}:${destinationRef}`,
    ],
    { cwd: deps.workspacePath },
  )
  if (fetched.exitCode !== 0) throw new Error(fetched.stderr)
  const head = await deps.exec(['git', 'rev-parse', '--verify', `${destinationRef}^{commit}`], {
    cwd: deps.workspacePath,
  })
  if (head.exitCode !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head.stdout.trim()))
    throw new Error('node parent snapshot did not resolve to a commit')
  return head.stdout.trim()
}
