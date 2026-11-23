import type { Exec } from './git-worktree'
import { classifyGitNetworkFailure, isForgeFailure } from '../forge-failure'
import type { ForgeRewrite, RestorationSkip, WorkspacePreservationHead } from '../types'
import { isArchiveRefusal } from '../../kernel/history-retention'

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** The replaced sha in the bounded record that equals or contains `sha`.
 * Replaced commits were published once and stay archived under
 * `<archivePrefix><sha>` or, where the forge refused that, as store copies
 * `restore` brings back; a remote workspace fetches only those it lacks.
 * Missing objects or unreadable archives mean "not covered", never an error. */
export async function supersedingReplacedHead(input: {
  exec: Exec
  workspacePath: string
  sha: string
  replaced: string[]
  /** Archive namespace of the replaced heads; absent skips forge lookup. */
  archivePrefix?: string
  local?: boolean
  /** Restores a replaced head from wherever its history is retained. */
  restore?: (sha: string) => Promise<boolean>
}): Promise<string | undefined> {
  if (!OID.test(input.sha) || !input.replaced.every((sha) => OID.test(sha)))
    throw new Error('invalid replaced head')
  if (
    input.archivePrefix !== undefined &&
    !/^refs\/autobuild\/archive\/[a-z0-9-]+\/$/.test(input.archivePrefix)
  )
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
  let first = await contain(newestFirst)
  if (first.covering || first.missing.length === 0) return first.covering
  if (input.restore) {
    const restored: string[] = []
    for (const sha of first.missing) if (await input.restore(sha)) restored.push(sha)
    const retried = await contain(restored)
    if (retried.covering) return retried.covering
    first = { covering: undefined, missing: first.missing.filter((sha) => !restored.includes(sha)) }
    if (first.missing.length === 0) return undefined
  }
  const prefix = input.archivePrefix
  if (input.local || prefix === undefined) return undefined
  const refs = first.missing.map((sha) => `${prefix}${sha}`)
  const listed = await run(['ls-remote', '--refs', 'origin', ...refs])
  if (listed.exitCode !== 0) return undefined
  const advertised = new Set(
    listed.stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter(([sha, ref]) => ref === `${prefix}${sha}`)
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
    const sha = ref.slice(prefix.length)
    const actual = await run(['rev-parse', '--verify', `${ref}^{commit}`])
    if (actual.exitCode === 0 && actual.stdout.trim() === sha) verified.push(sha)
  }
  return (await contain(verified)).covering
}

/** Boundary-only Git inspection. Inventory traverses the unpublished change,
 * while immutable archive acknowledgement proves the tip and its ancestry.
 * Where the forge refuses the archive ref, `retain` keeps the head as a
 * BuildStore copy instead. With `neverExecuted`, a non-zero object probe means
 * the checkout lacks that object: a missing base preserves nothing, and a
 * missing `HEAD`, branch or candidate is skipped. Traversal failures, and a
 * head neither the forge nor the store keeps, stay strict. */
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
  /** No execution ever started in this environment, so it holds no
   * unpublished work and absent objects are not an error. */
  neverExecuted?: boolean
  /** Keeps a head the forge refused to archive as a BuildStore copy over
   * `base` and resolves to the copy's actual exclusion base; throws when it
   * cannot. Absent, a refusal stays an error. */
  retain?: (input: {
    exec: Exec
    workspacePath: string
    sha: string
    base: string
  }) => Promise<string>
  /** Restores a replaced head kept as a store copy, for supersession checks. */
  restore?: (sha: string) => Promise<boolean>
}): Promise<WorkspacePreservationHead[]> {
  const git = async (args: string[], optional = false) => {
    const result = await input.exec(['git', ...args], { cwd: input.workspacePath })
    if (result.exitCode !== 0 && !(optional && result.exitCode === 1))
      throw new Error(`workspace preservation git ${args.join(' ')} failed: ${result.stderr}`)
    return result
  }
  // An object probe: present, or (only for a never-executed checkout) absent.
  const probe = (args: string[], optional = false) =>
    input.neverExecuted
      ? input.exec(['git', ...args], { cwd: input.workspacePath })
      : git(args, optional)
  const branch = await probe(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${input.branch}^{commit}`],
    true,
  )
  const head = await probe(['rev-parse', '--verify', 'HEAD^{commit}'])
  const heads: WorkspacePreservationHead[] = []
  const branchSha = branch.exitCode === 0 ? branch.stdout.trim() : undefined
  const headSha = head.exitCode === 0 ? head.stdout.trim() : undefined
  const candidates = [
    ...new Set([
      ...(branchSha ? [branchSha] : []),
      ...(headSha ? [headSha] : []),
      ...input.candidates,
    ]),
  ]
  // The base is the authoritative branch (or recorded immutable initial base),
  // never an arbitrary local remote-tracking cache.
  if ((await probe(['cat-file', '-e', `${input.base}^{commit}`])).exitCode !== 0) return []
  for (const sha of candidates) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha))
      throw new Error('invalid preservation candidate')
    if ((await probe(['cat-file', '-e', `${sha}^{commit}`])).exitCode !== 0) continue
    const commits = (await git(['rev-list', sha, `^${input.base}`])).stdout
      .trim()
      .split('\n')
      .filter(Boolean)
    if (commits.length === 0) continue
    const remoteRef = `refs/autobuild/archive/${input.slug}/${sha}`
    let location: { remoteRef: string } | { storeBase: string }
    try {
      await input.archive({ workspacePath: input.workspacePath, ref: remoteRef, sha })
      location = { remoteRef }
    } catch (error) {
      if (!input.retain || !isArchiveRefusal(error)) throw error
      try {
        location = {
          storeBase: await input.retain({
            exec: input.exec,
            workspacePath: input.workspacePath,
            sha,
            base: input.base,
          }),
        }
      } catch (copy) {
        throw new Error(
          `workspace preservation of ${sha} failed: archive refused (${error instanceof Error ? error.message : String(error)}); BuildStore copy failed (${copy instanceof Error ? copy.message : String(copy)})`,
          { cause: copy },
        )
      }
    }
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
        restore: input.restore,
      })) !== undefined
    const role = sha === branchSha && !superseded ? 'branch' : 'producer'
    heads.push(
      'remoteRef' in location
        ? { sha, remoteRef: location.remoteRef, role, commits }
        : { sha, role, commits, storeBase: location.storeBase },
    )
  }
  return heads
}

/** Fetch only recorded immutable refs, or restore recorded store copies
 * through `restoreStored`. Attaching an unpublished branch is safe only over
 * an ancestor; detached producer objects never move the branch. Branch heads
 * the branch contains, or that a replaced head in the bounded record covers,
 * are classified before any mutation and skipped. */
export async function restoreGitCommits(input: {
  exec: Exec
  workspacePath: string
  branch: string
  heads: WorkspacePreservationHead[]
  /** The build's bounded replaced-head record, newest last. */
  replaced?: string[]
  local?: boolean
  /** Restores a commit kept as a BuildStore copy (a `storeBase` head, or a
   * replaced head the forge refused to archive). */
  restoreStored?: (sha: string) => Promise<boolean>
  /** Archive namespace for replaced heads when no head names one. */
  slug?: string
}): Promise<{ skipped: RestorationSkip[] }> {
  const skipped: RestorationSkip[] = []
  const git = async (args: string[], optional = false) => {
    const result = await input.exec(['git', ...args], { cwd: input.workspacePath })
    if (result.exitCode !== 0 && !optional)
      throw new Error(`workspace restoration git ${args.join(' ')} failed: ${result.stderr}`)
    return result
  }
  for (const head of input.heads) {
    if (head.storeBase !== undefined) {
      if (!OID.test(head.sha) || !OID.test(head.storeBase))
        throw new Error('invalid workspace restoration store copy')
      if ((await git(['cat-file', '-e', `${head.sha}^{commit}`], true)).exitCode !== 0) {
        if (!input.restoreStored || !(await input.restoreStored(head.sha)))
          throw new Error(`workspace restoration store copy for ${head.sha} is unavailable`)
      }
    } else if (head.remoteRef === undefined) throw new Error('invalid workspace restoration ref')
    else await fetchArchived(head.remoteRef, head.sha)
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
    // Every head of one receipt shares the build's archive namespace.
    const archived = input.heads.find((h) => h.remoteRef !== undefined)
    const archivePrefix =
      archived?.remoteRef !== undefined
        ? archived.remoteRef.slice(0, -archived.sha.length)
        : input.slug !== undefined
          ? `refs/autobuild/archive/${input.slug}/`
          : undefined
    if (
      input.replaced?.length &&
      (await supersedingReplacedHead({
        exec: input.exec,
        workspacePath: input.workspacePath,
        sha: head.sha,
        replaced: input.replaced,
        archivePrefix,
        local: input.local,
        restore: input.restoreStored,
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

  async function fetchArchived(remoteRef: string, sha: string) {
    if (
      !/^refs\/autobuild\/archive\/[a-z0-9-]+\/[0-9a-f]+$/.test(remoteRef) ||
      !remoteRef.endsWith(`/${sha}`)
    )
      throw new Error('invalid workspace restoration ref')
    const head = { remoteRef, sha }
    if (!input.local) {
      const fetched = await git(
        [
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          '--refmap=',
          'origin',
          `+${head.remoteRef}:${head.remoteRef}`,
        ],
        true,
      )
      if (fetched.exitCode !== 0)
        throw new Error(
          `workspace restoration archive ref ${head.remoteRef} could not be fetched from origin: ${fetched.stderr}`,
        )
    }
    const resolveArgs = ['rev-parse', '--verify', '--quiet', `${head.remoteRef}^{commit}`]
    const resolved = await git(resolveArgs, true)
    const actual = resolved.stdout.trim()
    if (resolved.exitCode === 1 || (resolved.exitCode === 0 && !actual))
      throw new Error(
        `workspace restoration archive ref ${head.remoteRef} is missing from the ${input.local ? 'local repository' : 'repository after fetching from origin'}`,
      )
    if (resolved.exitCode !== 0)
      throw new Error(
        `workspace restoration git ${resolveArgs.join(' ')} failed: ${resolved.stderr}`,
      )
    if (actual !== head.sha) throw new Error(`workspace restoration ref ${head.remoteRef} changed`)
  }
}

/** Trusted exact-resource probe shared by hosted and local recovery. A thin
 * replay pack completes only over its exclusion base `replayBase`, which the
 * published target branch holds; it is fetched first when absent. A copy that
 * cannot restore the candidate proves it unavailable (`false`, so recovery
 * retires and redoes it); transport failures stay errors, so recovery defers. */
export async function inspectGitCandidate(input: {
  exec: Exec
  workspacePath: string
  sha: string
  branch: string
  archiveRef: string
  local?: boolean
  replayPack?: string
  replayBase?: string
  targetBranch?: string
}): Promise<boolean> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.sha)) throw new Error('invalid candidate SHA')
  if (input.replayBase !== undefined && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.replayBase))
    throw new Error('invalid replay base SHA')
  const git = async (args: string[], optional = false) => {
    const r = await input.exec(['git', ...args], { cwd: input.workspacePath })
    if (r.exitCode !== 0 && !optional) throw new Error(`candidate probe failed: ${r.stderr}`)
    return r
  }
  const present = async (sha: string) =>
    (await git(['cat-file', '-e', `${sha}^{commit}`], true)).exitCode === 0
  if (await present(input.sha)) return true
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
  if (!/^[A-Za-z0-9+/=]+$/.test(input.replayPack)) return false
  if (input.replayBase !== undefined && !(await present(input.replayBase))) {
    if (!input.local && input.targetBranch !== undefined) {
      let fetched: Awaited<ReturnType<Exec>>
      try {
        fetched = await git(
          [
            'fetch',
            '--no-tags',
            '--no-write-fetch-head',
            '--refmap=',
            'origin',
            `refs/heads/${input.targetBranch}`,
          ],
          true,
        )
      } catch (error) {
        throw classifyGitNetworkFailure(error)
      }
      if (fetched.exitCode !== 0) {
        const classified = classifyGitNetworkFailure(new Error(fetched.stderr || fetched.stdout))
        if (isForgeFailure(classified)) throw classified
      }
    }
    // The target no longer contains the base: the copy cannot complete.
    if (!(await present(input.replayBase))) return false
  }
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
    // index-pack applies legacy full packs and current thin packs alike.
    const r = await input.exec(
      [
        'bash',
        '-o',
        'pipefail',
        '-c',
        'base64 -d "$1" | git index-pack --stdin --fix-thin',
        'restore-replay',
        path,
      ],
      { cwd: input.workspacePath },
    )
    if (r.exitCode !== 0) return false
    return present(input.sha)
  } finally {
    await input.exec(['rm', '-f', path], { cwd: input.workspacePath })
  }
}
