import type { Exec } from './git-worktree'
import type { ForgeRewrite, WorkspacePreservationHead } from '../types'

/** Boundary-only Git inspection. Inventory traverses the unpublished change,
 * while immutable archive acknowledgement proves the tip and its ancestry. */
export async function preserveGitCommits(input: {
  exec: Exec
  workspacePath: string
  branch: string
  slug: string
  base: string
  candidates: string[]
  archive: ForgeRewrite['archive']
}): Promise<WorkspacePreservationHead[]> {
  const git = async (args: string[], optional = false) => {
    const result = await input.exec(['git', ...args], { cwd: input.workspacePath })
    if (result.exitCode !== 0 && !(optional && result.exitCode === 1))
      throw new Error(`workspace preservation git ${args.join(' ')} failed: ${result.stderr}`)
    return result
  }
  const branch = await git(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${input.branch}^{commit}`],
    true,
  )
  const head = await git(['rev-parse', '--verify', 'HEAD^{commit}'])
  const heads: WorkspacePreservationHead[] = []
  const branchSha = branch.exitCode === 0 ? branch.stdout.trim() : undefined
  const candidates = [
    ...new Set([...(branchSha ? [branchSha] : []), head.stdout.trim(), ...input.candidates]),
  ]
  // The base is the authoritative branch (or recorded immutable initial base),
  // never an arbitrary local remote-tracking cache.
  await git(['cat-file', '-e', `${input.base}^{commit}`])
  for (const sha of candidates) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha))
      throw new Error('invalid preservation candidate')
    await git(['cat-file', '-e', `${sha}^{commit}`])
    const commits = (await git(['rev-list', sha, `^${input.base}`])).stdout
      .trim()
      .split('\n')
      .filter(Boolean)
    if (commits.length === 0) continue
    const remoteRef = `refs/autobuild/archive/${input.slug}/${sha}`
    await input.archive({ workspacePath: input.workspacePath, ref: remoteRef, sha })
    heads.push({ sha, remoteRef, role: sha === branchSha ? 'branch' : 'producer', commits })
  }
  return heads
}

/** Fetch only recorded immutable refs. Attaching an unpublished branch is safe
 * only over an ancestor; detached producer objects never move the branch. */
export async function restoreGitCommits(input: {
  exec: Exec
  workspacePath: string
  branch: string
  heads: WorkspacePreservationHead[]
  local?: boolean
}): Promise<void> {
  const git = async (args: string[], optional = false) => {
    const result = await input.exec(['git', ...args], { cwd: input.workspacePath })
    if (result.exitCode !== 0 && !optional)
      throw new Error(`workspace restoration git ${args.join(' ')} failed: ${result.stderr}`)
    return result
  }
  for (const head of input.heads) {
    if (
      !/^refs\/autobuild\/archive\/[a-z0-9-]+\/[0-9a-f]+$/.test(head.remoteRef) ||
      !head.remoteRef.endsWith(`/${head.sha}`)
    )
      throw new Error('invalid workspace restoration ref')
    if (!input.local)
      await git([
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        '--refmap=',
        'origin',
        `+${head.remoteRef}:${head.remoteRef}`,
      ])
    const actual = (
      await git(['rev-parse', '--verify', `${head.remoteRef}^{commit}`])
    ).stdout.trim()
    if (actual !== head.sha) throw new Error(`workspace restoration ref ${head.remoteRef} changed`)
    for (const sha of [head.sha, ...head.commits]) await git(['cat-file', '-e', `${sha}^{commit}`])
    if (head.role !== 'branch') continue
    const ref = `refs/heads/${input.branch}`
    const current = (await git(['rev-parse', '--verify', ref])).stdout.trim()
    if (current === head.sha) continue
    const preservedAncestor = await git(['merge-base', '--is-ancestor', head.sha, current], true)
    if (preservedAncestor.exitCode === 0) continue
    const currentAncestor = await git(['merge-base', '--is-ancestor', current, head.sha], true)
    if (currentAncestor.exitCode !== 0)
      throw new Error('workspace restoration would overwrite divergent branch work')
    const status = await git(['status', '--porcelain'])
    if (status.stdout.trim()) throw new Error('workspace restoration requires a clean checkout')
    await git(['update-ref', ref, head.sha, current])
    const attached = (await git(['symbolic-ref', '--quiet', 'HEAD'], true)).stdout.trim()
    if (attached === ref) await git(['reset', '--hard', head.sha])
  }
}

/** Trusted exact-resource probe shared by hosted and local recovery. */
export async function inspectGitCandidate(input: {
  exec: Exec
  workspacePath: string
  sha: string
  branch: string
  archiveRef: string
  local?: boolean
  replayPack?: string
}): Promise<boolean> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.sha)) throw new Error('invalid candidate SHA')
  const git = async (args: string[], optional = false) => {
    const r = await input.exec(['git', ...args], { cwd: input.workspacePath })
    if (r.exitCode !== 0 && !optional) throw new Error(`candidate probe failed: ${r.stderr}`)
    return r
  }
  if ((await git(['cat-file', '-e', `${input.sha}^{commit}`], true)).exitCode === 0) return true
  for (const ref of [`refs/heads/${input.branch}`, input.archiveRef]) {
    const r = await git(
      input.local
        ? ['rev-parse', '--verify', '--quiet', ref]
        : ['ls-remote', '--refs', 'origin', ref],
      true,
    )
    if (r.exitCode !== 0) {
      if (input.local && r.exitCode === 1) continue
      throw new Error(`candidate ref inspection failed: ${r.stderr}`)
    }
    const actual = r.stdout.trim().split(/\s+/)[0]
    if (actual !== input.sha) continue
    if (!input.local)
      await git(['fetch', '--no-tags', '--no-write-fetch-head', '--refmap=', 'origin', ref])
    await git(['cat-file', '-e', `${input.sha}^{commit}`])
    return true
  }
  if (!input.replayPack) return false
  if (!/^[A-Za-z0-9+/=]+$/.test(input.replayPack)) throw new Error('invalid retained replay pack')
  const temporary = await input.exec(['mktemp'], { cwd: input.workspacePath })
  const path = temporary.stdout.trim()
  if (temporary.exitCode !== 0 || !path) throw new Error('cannot stage replay pack')
  try {
    for (let offset = 0; offset < input.replayPack.length; offset += 16384) {
      const r = await input.exec(
        [
          'sh',
          '-c',
          'printf %s "$1" >> "$2"',
          'replay-chunk',
          input.replayPack.slice(offset, offset + 16384),
          path,
        ],
        { cwd: input.workspacePath },
      )
      if (r.exitCode !== 0) throw new Error('cannot stage replay pack')
    }
    const r = await input.exec(
      [
        'bash',
        '-o',
        'pipefail',
        '-c',
        'base64 -d "$1" | git unpack-objects -q',
        'restore-replay',
        path,
      ],
      { cwd: input.workspacePath },
    )
    if (r.exitCode !== 0) throw new Error('cannot restore replay pack')
    await git(['cat-file', '-e', `${input.sha}^{commit}`])
    return true
  } finally {
    await input.exec(['rm', '-f', path], { cwd: input.workspacePath })
  }
}
