/**
 * The paths each candidate head changes (SPEC §15 "Head path facts").
 *
 * The build that produces a candidate head records it once, before the write
 * that establishes the head: a `head.paths-recorded` event carrying a bounded
 * summary, deposited atomically with a `head-paths` artifact holding the
 * complete sets. Build state folds the summaries; the selectors here answer
 * "what does the current candidate head change" without git or store reads,
 * so the dispatcher's per-poll path never pays for the fact. `readHeadPaths`
 * is the explicit, once-per-candidate read of the complete sets.
 */
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { Actor } from '../events/envelope'
import type { EventEnvelope, EventWrite } from '../events/catalog'
import {
  HEAD_PATHS_ARTIFACT,
  HEAD_PATHS_PREVIEW,
  HEAD_PATHS_RECORDS,
} from '../events/head-paths-limits'
import { headPathsFor, type HeadPathsSource, type HeadPathsSummary } from './head-paths-state'
import type { Exec } from '../ports/workspace/git-worktree'
import { readBuildFacts, readBuildSelector } from '../store/reduced-reads'
import type { LeafRestackState } from './leaf-restack-state'
import type { ArtifactInput, ArtifactMeta, BuildStore } from '../store/types'
import type { BuildState } from './reducer'

export { HEAD_PATHS_ARTIFACT, HEAD_PATHS_PREVIEW, HEAD_PATHS_RECORDS }

export {
  candidateHead,
  candidateHeadPaths,
  foldHeadPaths,
  headPathsFor,
  type HeadPathsAnswer,
  type HeadPathsPayload,
  type HeadPathsSource,
  type HeadPathsSummary,
} from './head-paths-state'

// ── Complete sets (artifact) ─────────────────────────────────────────────────

const pathList = z.array(z.string().min(1))
export const headPathsArtifactSchema = z.strictObject({
  version: z.literal(1),
  head: z.string().min(1),
  destination: z.string().min(1),
  mergeBase: z.string().min(1),
  paths: pathList,
  resolution: z.strictObject({ paths: pathList }).optional(),
})
export type HeadPathsArtifact = z.infer<typeof headPathsArtifactSchema>

export class HeadPathsReadError extends Error {
  override readonly name = 'HeadPathsReadError'
}

function matchesSummary(
  paths: readonly string[],
  summary: { total: number; preview: readonly string[] },
): boolean {
  return (
    paths.length === summary.total && summary.preview.every((path, index) => paths[index] === path)
  )
}

/** The complete path sets behind one recorded summary: one artifact read. A
 * missing or mismatched artifact is a typed error, never a recomputation. */
export async function readHeadPaths(
  store: Pick<BuildStore, 'getArtifact'>,
  slug: string,
  record: HeadPathsSummary,
): Promise<{ paths: string[]; resolution?: { paths: string[] } }> {
  const where = `${HEAD_PATHS_ARTIFACT}@${record.artifact.rev} for head ${record.head}`
  const artifact = await store.getArtifact(slug, HEAD_PATHS_ARTIFACT, record.artifact.rev)
  if (artifact === null) throw new HeadPathsReadError(`${where} is missing`)
  let content: HeadPathsArtifact
  try {
    content = headPathsArtifactSchema.parse(JSON.parse(new TextDecoder().decode(artifact.content)))
  } catch (error) {
    throw new HeadPathsReadError(
      `${where} is malformed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (
    content.head !== record.head ||
    content.destination !== record.destination ||
    content.mergeBase !== record.mergeBase ||
    !matchesSummary(content.paths, record) ||
    (content.resolution === undefined) !== (record.resolution === undefined) ||
    (content.resolution !== undefined &&
      !matchesSummary(content.resolution.paths, record.resolution!))
  )
    throw new HeadPathsReadError(`${where} does not match its recorded summary`)
  return {
    paths: content.paths,
    ...(content.resolution === undefined
      ? {}
      : { resolution: { paths: content.resolution.paths } }),
  }
}

// ── Git computation ──────────────────────────────────────────────────────────

/** Parse `git diff --name-only -z`; malformed output fails closed. */
export function parseNulChangedPaths(output: string): string[] {
  if (output.length === 0) return []
  if (!output.endsWith('\0')) {
    throw new Error('git diff --name-only -z returned non-NUL-terminated output')
  }
  const paths = output.slice(0, -1).split('\0')
  if (paths.some((path) => path.length === 0)) {
    throw new Error('git diff --name-only -z returned an empty path entry')
  }
  return paths
}

function sortedUnique(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort()
}

async function run(exec: Exec, cwd: string, args: string[]) {
  return exec(['git', ...args], { cwd })
}

async function gitOut(exec: Exec, cwd: string, args: string[]): Promise<string> {
  const result = await run(exec, cwd, args)
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.join(' ')} exited ${result.exitCode}: ` +
        `${result.stderr.trim() || result.stdout.trim() || '(no output)'}`,
    )
  return result.stdout
}

/** Every path that differs between two tree-ish values. `--no-renames` lists
 * a rename as its deletion and its addition, so both paths count. */
async function diffPaths(exec: Exec, cwd: string, from: string, to: string): Promise<string[]> {
  return sortedUnique(
    parseNulChangedPaths(
      await gitOut(exec, cwd, ['diff', '--no-renames', '--name-only', '-z', from, to, '--']),
    ),
  )
}

/** The paths `head` changes against its merge base with `destination`. */
export async function computeChangedPaths(
  exec: Exec,
  cwd: string,
  input: { head: string; destination: string },
): Promise<{ mergeBase: string; paths: string[] }> {
  for (const commit of [input.head, input.destination])
    await gitOut(exec, cwd, ['cat-file', '-e', `${commit}^{commit}`])
  const base = await run(exec, cwd, ['merge-base', input.destination, input.head])
  if (base.exitCode !== 0 || base.stdout.trim() === '')
    throw new Error(
      `head ${input.head} has no merge base with destination ${input.destination}` +
        (base.stderr.trim() ? `: ${base.stderr.trim()}` : ''),
    )
  const mergeBase = base.stdout.trim().split('\n')[0]!
  return { mergeBase, paths: await diffPaths(exec, cwd, mergeBase, input.head) }
}

/** One replayed change: `change` replayed onto `onto` as a three-way merge
 * with base `parent` (the change's mainline parent), resolved into `head`. */
export interface ResolutionInput {
  change: string
  parent: string
  mainline?: number
  onto: string
  head: string
}

function unsupportedMergeTree(result: { exitCode: number; stderr: string }): boolean {
  return (
    result.exitCode === 129 ||
    /usage: git merge-tree|unknown option|unrecognized argument/i.test(result.stderr)
  )
}

/**
 * The tree of the purely mechanical replay of `change` onto `onto`, conflict
 * markers included. `git merge-tree --write-tree --merge-base` computes it
 * without touching any worktree; older Git rebuilds the identical three-way
 * merge in a temporary detached worktree, leaving the caller's untouched,
 * and ignores any resolutions rerere recorded whatever the operator's config.
 */
export async function mechanicalTree(
  exec: Exec,
  cwd: string,
  input: Omit<ResolutionInput, 'head'>,
  opts: { mergeBaseOption?: boolean } = {},
): Promise<string> {
  const parent = (
    await gitOut(exec, cwd, ['rev-parse', '--verify', `${input.parent}^{commit}`])
  ).trim()
  if (opts.mergeBaseOption !== false) {
    const result = await run(exec, cwd, [
      'merge-tree',
      '--write-tree',
      '--no-messages',
      `--merge-base=${parent}`,
      input.onto,
      input.change,
    ])
    if (result.exitCode === 0 || result.exitCode === 1) {
      const tree = result.stdout.split('\n')[0]?.trim() ?? ''
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree))
        throw new Error(`git merge-tree returned no tree: ${JSON.stringify(result.stdout)}`)
      return tree
    }
    if (!unsupportedMergeTree(result))
      throw new Error(`git merge-tree exited ${result.exitCode}: ${result.stderr.trim()}`)
  }
  return worktreeReplayTree(exec, cwd, input)
}

async function worktreeReplayTree(
  exec: Exec,
  cwd: string,
  input: Omit<ResolutionInput, 'head' | 'parent'>,
): Promise<string> {
  const path = join(tmpdir(), `autobuild-head-paths-${randomUUID()}`)
  await gitOut(exec, cwd, ['worktree', 'add', '--detach', path, input.onto])
  try {
    const picked = await run(exec, path, [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'rerere.enabled=false',
      'cherry-pick',
      '--no-commit',
      ...(input.mainline === undefined ? [] : ['-m', String(input.mainline)]),
      input.change,
    ])
    if (picked.exitCode !== 0) {
      const unmerged = await gitOut(exec, path, ['diff', '--name-only', '--diff-filter=U', '-z'])
      if (unmerged === '')
        throw new Error(
          `mechanical replay of ${input.change} failed: ${picked.stderr.trim() || picked.stdout.trim()}`,
        )
    }
    await gitOut(exec, path, ['add', '-A'])
    return (await gitOut(exec, path, ['write-tree'])).trim()
  } finally {
    await run(exec, cwd, ['worktree', 'remove', '--force', path])
    await run(exec, cwd, ['worktree', 'prune'])
  }
}

/** The union of the paths each resolved head edits beyond its mechanical
 * replay. Changes that arrived cleanly from the destination do not count. */
export async function computeResolutionPaths(
  exec: Exec,
  cwd: string,
  items: readonly ResolutionInput[],
  opts: { mergeBaseOption?: boolean } = {},
): Promise<string[]> {
  const paths: string[] = []
  for (const item of items)
    paths.push(
      ...(await diffPaths(exec, cwd, await mechanicalTree(exec, cwd, item, opts), item.head)),
    )
  return sortedUnique(paths)
}

/** The base a leaf's landing candidate is judged against, exactly as
 * `leafLandingCandidate` defines it; the contribution base before any. */
export async function leafLandingBase(
  store: BuildStore,
  slug: string,
  restack: Pick<LeafRestackState, 'completed' | 'initialBase'>,
): Promise<string> {
  const base =
    restack.completed?.targetBase ??
    restack.initialBase ??
    (await readBuildSelector(store, slug, 'verifyDiffBase'))
  if (base === undefined)
    throw new Error("cannot record the head's changed paths: this build has no landing base")
  return base
}

// ── Recording ────────────────────────────────────────────────────────────────

export interface HeadPathsInput {
  source: HeadPathsSource
  head: string
  destination: string
  /** Reconcile-produced heads only. An empty list records an empty resolution;
   * undefined records none. */
  resolution?: readonly ResolutionInput[]
}

/** Compute the complete facts for one head. */
export async function computeHeadPaths(
  exec: Exec,
  cwd: string,
  input: HeadPathsInput,
  opts: { mergeBaseOption?: boolean } = {},
): Promise<HeadPathsArtifact> {
  const { mergeBase, paths } = await computeChangedPaths(exec, cwd, input)
  return {
    version: 1,
    head: input.head,
    destination: input.destination,
    mergeBase,
    paths,
    ...(input.resolution === undefined
      ? {}
      : { resolution: { paths: await computeResolutionPaths(exec, cwd, input.resolution, opts) } }),
  }
}

function summary(paths: readonly string[]) {
  return { total: paths.length, preview: paths.slice(0, HEAD_PATHS_PREVIEW) }
}

/** The atomic deposit for computed facts: the complete artifact and the
 * event carrying its bounded summary. */
export function headPathsWrite(
  facts: HeadPathsArtifact,
  source: HeadPathsSource,
  actor: Actor,
): {
  artifacts: ArtifactInput[]
  makeEvent: (deposited: ArtifactMeta[]) => EventWrite<'head.paths-recorded'>
} {
  return {
    artifacts: [{ kind: HEAD_PATHS_ARTIFACT, content: JSON.stringify(facts) }],
    makeEvent: (deposited) => ({
      actor,
      type: 'head.paths-recorded',
      payload: {
        source,
        head: facts.head,
        destination: facts.destination,
        mergeBase: facts.mergeBase,
        ...summary(facts.paths),
        ...(facts.resolution === undefined ? {} : { resolution: summary(facts.resolution.paths) }),
        artifact: { kind: HEAD_PATHS_ARTIFACT, rev: deposited[0]!.revision },
      },
    }),
  }
}

export type HeadPathsDeposit = (
  artifacts: ArtifactInput[],
  makeEvent: (deposited: ArtifactMeta[]) => EventWrite<'head.paths-recorded'>,
) => Promise<{ event: EventEnvelope<'head.paths-recorded'> } | null>

export interface RecordHeadPathsDeps {
  store: BuildStore
  slug: string
  exec: Exec
  workspacePath: string
  actor: Actor
}

/**
 * Record a produced head's paths once. Returns the existing summary when the
 * head is already recorded, the new envelope on a deposit, or null when a
 * conditional deposit (`expectedSeq`) missed. Git and deposit failures throw:
 * a head is never published silently unrecorded.
 */
export async function recordHeadPaths(
  deps: RecordHeadPathsDeps,
  input: HeadPathsInput & {
    /** Build state to dedupe against; read when omitted. */
    state?: Pick<BuildState, 'headPaths'>
    expectedSeq?: number
    deposit?: HeadPathsDeposit
    mergeBaseOption?: boolean
  },
): Promise<
  | { recorded: 'existing'; record: HeadPathsSummary }
  | {
      recorded: 'appended'
      event: EventEnvelope<'head.paths-recorded'>
      /** The complete sets just deposited, so callers never re-read them. */
      facts: HeadPathsArtifact
    }
  | null
> {
  const state = input.state ?? (await readBuildFacts(deps.store, deps.slug)).value.state
  const existing = headPathsFor(state, input.head)
  if (existing.recorded) return { recorded: 'existing', record: existing.record }
  const facts = await computeHeadPaths(deps.exec, deps.workspacePath, input, {
    ...(input.mergeBaseOption === undefined ? {} : { mergeBaseOption: input.mergeBaseOption }),
  })
  const { artifacts, makeEvent } = headPathsWrite(facts, input.source, deps.actor)
  const deposit: HeadPathsDeposit =
    input.deposit ??
    ((items, make) =>
      input.expectedSeq === undefined
        ? deps.store.appendWithArtifacts(deps.slug, items, make)
        : deps.store.appendWithArtifactsIfCurrent(deps.slug, input.expectedSeq, items, make))
  const deposited = await deposit(artifacts, makeEvent)
  return deposited === null ? null : { recorded: 'appended', event: deposited.event, facts }
}

/** A non-null `recordHeadPaths` result. */
export type RecordedHeadPaths = NonNullable<Awaited<ReturnType<typeof recordHeadPaths>>>
