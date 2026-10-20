import { observePresence, originalForeign, type LandingEvidence } from './change-presence'
import type { Exec } from '../ports/workspace/git-worktree'
import { buildTrailers, validateBuildSlug } from './build-identity'

export interface NodeGit {
  exec: Exec
  workspacePath: string
}
export interface NodeChange {
  sha: string
  /** Merges are always foreign, even when their side history contains identities. */
  build?: string
  mainline?: 1
}
export interface NodeMergeProof {
  sha: string
  parent: string
  identities: string[]
  build?: string
  missing: string[]
}
export interface NodeInventory {
  head: string
  builds: string[]
  contributions?: string[]
  /** Only commits above this node's durable contribution boundary. */
  foreign: string[]
}
export interface NodeReplayInputs {
  oldBase: string
  oldHead: string
  parent: string
  changes: NodeChange[]
  upstreamBuilds: string[]
  merges: NodeMergeProof[]
}
async function git(deps: NodeGit, args: string[], allowFailure = false) {
  const result = await deps.exec(['git', ...args], { cwd: deps.workspacePath })
  if (!allowFailure && result.exitCode !== 0)
    throw new Error(`node replay git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result
}
async function output(deps: NodeGit, args: string[]) {
  return (await git(deps, args)).stdout.trim()
}
export interface HistoryCommit {
  sha: string
  parents: string[]
  message: string
}
/** Git commit messages cannot contain NUL. Read metadata in one process per
 * history/range, including merge parents, rather than spawning per commit. */
export async function history(
  deps: NodeGit,
  revisions: string[],
  options: string[] = [],
): Promise<HistoryCommit[]> {
  const raw = (
    await git(deps, [
      'log',
      '--no-show-signature',
      '--no-notes',
      '-z',
      '--format=%H%x00%P%x00%B',
      ...options,
      ...revisions,
      '--',
    ])
  ).stdout
  if (raw === '') return []
  const fields = raw.split('\0')
  if (fields.pop() !== '' || fields.length % 3 !== 0)
    throw new Error('invalid node history metadata')
  const commits: HistoryCommit[] = []
  for (let index = 0; index < fields.length; index += 3) {
    const sha = fields[index]!
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) throw new Error('invalid node history commit')
    commits.push({
      sha,
      parents: fields[index + 1] === '' ? [] : fields[index + 1]!.split(' '),
      message: fields[index + 2]!,
    })
  }
  return commits
}
function messageIdentity(sha: string, message: string): string | undefined {
  const trailers = buildTrailers(message)
  if (trailers.length === 0) return undefined
  if (trailers.length !== 1)
    throw new Error(`ambiguous build identity on ${sha}: ${trailers.join(', ')}`)
  try {
    validateBuildSlug(trailers[0]!)
  } catch {
    throw new Error(`invalid build identity on ${sha}: ${JSON.stringify(trailers[0])}`)
  }
  return trailers[0]
}
async function identity(deps: NodeGit, sha: string): Promise<string | undefined> {
  return messageIdentity(sha, await output(deps, ['show', '-s', '--format=%B', sha]))
}
async function reachableBuilds(deps: NodeGit, revisions: string[]): Promise<Set<string>> {
  const result = new Set<string>()
  for (const commit of await history(deps, revisions)) {
    const build = messageIdentity(commit.sha, commit.message)
    if (build !== undefined) result.add(build)
  }
  return result
}

/** Freeze every merge proof before replaying even the first contribution. A
 * side identity must exist in the sampled parent, never merely in a prefix. */
export async function prepareNodeReplay(
  deps: NodeGit,
  input: { oldBase: string; oldHead: string; parent: string },
  evidence: {
    aliases: Map<string, string>
    landings: LandingEvidence[]
    upstream?: Set<string>
  } = { aliases: new Map(), landings: [] },
): Promise<NodeReplayInputs> {
  if (
    (await git(deps, ['merge-base', '--is-ancestor', input.oldBase, input.oldHead], true))
      .exitCode !== 0
  )
    throw new Error(
      `node head ${input.oldHead} no longer descends from contribution base ${input.oldBase}`,
    )
  const upstream = await reachableBuilds(deps, [input.parent])
  for (const id of evidence.landings.length
    ? await observePresence(deps, input.parent, evidence.landings, evidence.aliases)
    : [])
    if (id.startsWith('build:')) upstream.add(id.slice('build:'.length))
  const changes: NodeChange[] = []
  const merges: NodeMergeProof[] = []
  for (const commit of await history(
    deps,
    [`${input.oldBase}..${input.oldHead}`],
    ['--reverse', '--first-parent'],
  )) {
    const { sha, parents, message } = commit
    if (parents.length > 1) {
      const mergeBuild = messageIdentity(sha, message)
      const identities = await reachableBuilds(deps, [...parents.slice(1), '--not', parents[0]!])
      const sorted = [...identities].sort()
      merges.push({
        sha,
        parent: input.parent,
        ...(mergeBuild === undefined ? {} : { build: mergeBuild }),
        identities: sorted,
        missing: sorted.filter((build) => !upstream.has(build)),
      })
      // Flatten the complete first-parent delta. Side commits never become
      // independent items, and the merge never creates their identities.
      changes.push({ sha, mainline: 1 })
    } else {
      const build = messageIdentity(sha, message)
      changes.push({ sha, ...(build === undefined ? {} : { build }) })
    }
  }
  return { ...input, changes, upstreamBuilds: [...upstream].sort(), merges }
}
export function assertSafeNodeReplay(input: NodeReplayInputs): void {
  const identified = input.merges.filter((merge) => merge.build !== undefined)
  if (identified.length > 0)
    throw new Error(
      `node restack refused: identity-bearing merge is anomalous: ${identified.map((merge) => `${merge.sha} carries Autobuild-Build: ${merge.build}`).join('; ')}`,
    )
  const unsafe = input.merges.filter((merge) => merge.missing.length > 0)
  if (unsafe.length > 0)
    throw new Error(
      `node restack refused at parent ${input.parent}: ${unsafe.map((merge) => `merge ${merge.sha} would lose build identities ${merge.missing.join(', ')}`).join('; ')}`,
    )
}
export async function nodeInventory(
  deps: NodeGit,
  head: string,
  contributionBase: string,
): Promise<NodeInventory> {
  const foreign: string[] = []
  const contributions = new Set<string>()
  for (const commit of await history(
    deps,
    [`${contributionBase}..${head}`],
    ['--reverse', '--first-parent'],
  )) {
    const identity = messageIdentity(commit.sha, commit.message)
    if (commit.parents.length > 1 || identity === undefined) foreign.push(commit.sha)
    else contributions.add(identity)
  }
  return {
    head,
    builds: [...(await reachableBuilds(deps, [head]))].sort(),
    contributions: [...contributions].sort(),
    foreign,
  }
}

/** Run one item only. The caller persists inputs first and retains the result
 * before its receipt. Public refs are never changed here. */
export async function replayNodeChange(
  deps: NodeGit,
  inputs: NodeReplayInputs,
  index: number,
  base: string,
  evidence: {
    aliases: Map<string, string>
    landings: LandingEvidence[]
    upstream?: Set<string>
  } = { aliases: new Map(), landings: [] },
): Promise<
  | { kind: 'dropped'; head: string; reason: 'upstream-identity' | 'upstream-commit' }
  | { kind: 'replayed'; head: string }
  | { kind: 'conflict'; base: string; files: string[] }
> {
  assertSafeNodeReplay(inputs)
  const change = inputs.changes[index]
  if (change === undefined) throw new Error(`missing node replay item ${index}`)
  if (change.build !== undefined && inputs.upstreamBuilds.includes(change.build))
    return { kind: 'dropped', head: base, reason: 'upstream-identity' }
  const present =
    evidence.upstream ??
    new Set(await observePresence(deps, inputs.parent, evidence.landings, evidence.aliases, true))
  const changeIdentity =
    change.build === undefined
      ? `foreign:${originalForeign(change.sha, evidence.aliases)}`
      : `build:${change.build}`
  if (present.has(changeIdentity))
    return {
      kind: 'dropped',
      head: base,
      reason: change.build === undefined ? 'upstream-commit' : 'upstream-identity',
    }
  if ((await output(deps, ['status', '--porcelain'])) !== '')
    throw new Error('node replay requires a clean worktree')
  await git(deps, ['checkout', '--detach', base])
  const config = ['-c', 'commit.gpgsign=false']
  for (const [key, format] of [
    ['user.name', '%cn'],
    ['user.email', '%ce'],
  ]) {
    if ((await git(deps, ['config', '--get', key!], true)).stdout.trim() === '')
      config.push(
        '-c',
        `${key}=${await output(deps, ['show', '-s', `--format=${format}`, change.sha])}`,
      )
  }
  const result = await git(
    deps,
    [
      ...config,
      'cherry-pick',
      '--allow-empty',
      ...(change.mainline === undefined ? [] : ['-m', '1']),
      change.sha,
    ],
    true,
  )
  if (result.exitCode !== 0) {
    const files = (await git(deps, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout
      .split('\0')
      .filter(Boolean)
      .sort()
    if (files.length) return { kind: 'conflict', base, files }
    const pending = await git(deps, ['rev-parse', '--verify', 'CHERRY_PICK_HEAD'], true)
    if (
      pending.exitCode !== 0 ||
      pending.stdout.trim() !== change.sha ||
      (await output(deps, ['diff', '--cached', '--name-only'])) !== ''
    )
      throw new Error(`node replay failed: ${result.stderr || result.stdout}`)
    await git(deps, [...config, 'commit', '--allow-empty', '--no-edit'])
  }
  if (change.mainline !== undefined) {
    // Preflight refuses identity-bearing merges. Validate again so neither
    // replay nor conflict resolution can introduce or reinterpret an identity.
    const trailers = buildTrailers(await output(deps, ['show', '-s', '--format=%B', 'HEAD']))
    if (trailers.length > 0)
      throw new Error(
        `foreign merge ${change.sha} carries a build identity; operator review required`,
      )
  }
  const head = await output(deps, ['rev-parse', 'HEAD'])
  await validateNodeChange(deps, change, base, head)
  return { kind: 'replayed', head }
}
export async function validateNodeChange(
  deps: NodeGit,
  change: NodeChange,
  base: string,
  head: string,
): Promise<void> {
  if ((await output(deps, ['show', '-s', '--format=%P', head])) !== base)
    throw new Error(`node item ${change.sha} requires exactly one parent ${base}`)
  const actual = await identity(deps, head)
  if (actual !== change.build) throw new Error(`node item ${change.sha} changed build identity`)
  if ((await output(deps, ['status', '--porcelain'])) !== '')
    throw new Error('node item completion requires a clean worktree')
}
