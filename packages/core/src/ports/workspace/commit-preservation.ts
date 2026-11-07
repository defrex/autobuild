import type { Exec } from './git-worktree'
import type { ForgeRewrite, RestorationSkip, WorkspacePreservationHead } from '../types'

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** The replaced sha in the bounded record that equals or contains `sha`.
 * Replaced commits were published once and stay archived under
 * `<archivePrefix><sha>`; a remote workspace fetches only those it lacks.
 * Missing objects or unreadable archives mean "not covered", never an error. */
export async function supersedingReplacedHead(input: {
  exec: Exec
  workspacePath: string
  sha: string
  replaced: string[]
  archivePrefix: string
  local?: boolean
}): Promise<string | undefined> {
  if (!OID.test(input.sha) || !input.replaced.every((sha) => OID.test(sha)))
    throw new Error('invalid replaced head')
  if (!/^refs\/autobuild\/archive\/[a-z0-9-]+\/$/.test(input.archivePrefix))
    throw new Error('invalid replaced head archive prefix')
  if (input.replaced.includes(input.sha)) return input.sha
  const run = (args: string[]) => input.exec(['git', ...args], { cwd: input.workspacePath })
  const newestFirst = [...input.replaced].reverse()
  const contain = async (candidates: string[]) => {
    const missing: string[] = []
    for (const replaced of candidates) {
      const result = await run(['merge-base', '--is-ancestor', input.sha, replaced])
      if (result.exitCode === 0) return { covering: replaced, missing }
      if (result.exitCode !== 1) missing.push(replaced)
    }
    return { covering: undefined, missing }
  }
  const first = await contain(newestFirst)
  if (first.covering || input.local || first.missing.length === 0) return first.covering
  const refs = first.missing.map((sha) => `${input.archivePrefix}${sha}`)
  const listed = await run(['ls-remote', '--refs', 'origin', ...refs])
  if (listed.exitCode !== 0) return undefined
  const advertised = new Set(
    listed.stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter(([sha, ref]) => ref === `${input.archivePrefix}${sha}`)
      .map(([, ref]) => ref!),
  )
  const fetchable = refs.filter((ref) => advertised.has(ref))
  if (fetchable.length === 0) return undefined
  const fetched = await run([
    'fetch',
    '--no-tags',
    '--no-write-fetch-head',
    '--refmap=',
    'origin',
    ...fetchable.map((ref) => `+${ref}:${ref}`),
  ])
  if (fetched.exitCode !== 0) return undefined
  const verified: string[] = []
  for (const ref of fetchable) {
    const sha = ref.slice(input.archivePrefix.length)
    const actual = await run(['rev-parse', '--verify', `${ref}^{commit}`])
    if (actual.exitCode === 0 && actual.stdout.trim() === sha) verified.push(sha)
  }
  return (await contain(verified)).covering
}

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
  /** Shas a recorded rewrite replaced; a local branch they cover is
   * archived as a producer so restoration never moves the branch to it. */
  replaced?: string[]
  local?: boolean
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
    const superseded =
      sha === branchSha &&
      !!input.replaced?.length &&
      (await supersedingReplacedHead({
        exec: input.exec,
        workspacePath: input.workspacePath,
        sha,
        replaced: input.replaced,
        archivePrefix: `refs/autobuild/archive/${input.slug}/`,
        local: input.local,
      })) !== undefined
    heads.push({
      sha,
      remoteRef,
      role: sha === branchSha && !superseded ? 'branch' : 'producer',
      commits,
    })
  }
  return heads
}

/** Fetch only recorded immutable refs. Attaching an unpublished branch is safe
 * only over an ancestor; detached producer objects never move the branch.
 * Branch heads the branch contains, or that a replaced head in the bounded
 * record covers, are classified before any mutation and skipped. */
export async function restoreGitCommits(input: {
  exec: Exec
  workspacePath: string
  branch: string
  heads: WorkspacePreservationHead[]
  /** The build's bounded replaced-head record, newest last. */
  replaced?: string[]
  local?: boolean
}): Promise<{ skipped: RestorationSkip[] }> {
  const skipped: RestorationSkip[] = []
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
    const preservedAncestor =
      current === head.sha ||
      (await git(['merge-base', '--is-ancestor', head.sha, current], true)).exitCode === 0
    if (preservedAncestor) {
      skipped.push({ sha: head.sha, reason: 'contained' })
      continue
    }
    if (
      input.replaced?.length &&
      (await supersedingReplacedHead({
        exec: input.exec,
        workspacePath: input.workspacePath,
        sha: head.sha,
        replaced: input.replaced,
        archivePrefix: head.remoteRef.slice(0, -head.sha.length),
        local: input.local,
      })) !== undefined
    ) {
      skipped.push({ sha: head.sha, reason: 'superseded' })
      continue
    }
    const currentAncestor = await git(['merge-base', '--is-ancestor', current, head.sha], true)
    if (currentAncestor.exitCode !== 0)
      throw new Error('workspace restoration would overwrite divergent branch work')
    const status = await git(['status', '--porcelain'])
    if (status.stdout.trim()) throw new Error('workspace restoration requires a clean checkout')
    await git(['update-ref', ref, head.sha, current])
    const attached = (await git(['symbolic-ref', '--quiet', 'HEAD'], true)).stdout.trim()
    if (attached === ref) await git(['reset', '--hard', head.sha])
  }
  return { skipped }
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
