import type { Exec } from '../ports/workspace/git-worktree'
import { compilePathSelectors } from '../config/path-selectors'
import type { GeneratedGroup } from './generated-files'

/** Longest command-output tail a failure reason carries (the payload allows 4000). */
const REASON_TAIL_CHARS = 2000
const REASON_MAX_CHARS = 4000

export interface RegenerationDeps {
  exec: Exec
  workspacePath: string
  signal?: AbortSignal
}

export interface RegenerationInput {
  /** The recorded conflicted paths; the workspace must reproduce exactly these. */
  files: readonly string[]
  /** Declared commands that own every conflicted path, in declaration order. */
  groups: readonly GeneratedGroup[]
  /** Every declared `[[generated]]` selector: the only paths a command may write. */
  selectors: readonly string[]
  /** Commit whose committer supplies a missing `user.name`/`user.email`. */
  identitySource: string
}

export type RegenerationResult =
  | { outcome: 'resolved'; head: string }
  | { outcome: 'failed'; reason: string }

/** Shutdown arrived while a command ran: no outcome is known, so none is recorded. */
export class RegenerationInterrupted extends Error {
  constructor() {
    super('regeneration interrupted by shutdown')
    this.name = 'RegenerationInterrupted'
  }
}

class RegenerationFailure extends Error {}

/** Bound a failure reason to the event payload's limit. */
export function regenerationReason(text: string): string {
  const trimmed = text.trim() || 'regeneration failed'
  return trimmed.length > REASON_MAX_CHARS ? `${trimmed.slice(0, REASON_MAX_CHARS - 1)}…` : trimmed
}

function tail(text: string): string {
  return text.length > REASON_TAIL_CHARS ? `…${text.slice(-REASON_TAIL_CHARS)}` : text
}

const paths = (stdout: string) => stdout.split('\0').filter((path) => path !== '')

interface Snapshot {
  /** Worktree-versus-index differences, unmerged paths included. */
  worktree: Set<string>
  untracked: Set<string>
  /** Stage-0 index entries (`mode sha 0\tpath`): the clean staged replay edits. */
  index: string[]
}

/**
 * Resolve a reproduced cherry-pick conflict whose conflicted paths are all
 * declared generated files. Each conflicted file is reset to the replay
 * base's side, the declared commands rebuild them, and the result is
 * committed as the change's replay with its original message and author.
 * Clean edits the cherry-pick already staged are committed unchanged.
 *
 * A failed result leaves no command output behind: the index is restored
 * from a copy taken before any command ran, every untracked file the
 * commands introduced is deleted and every tracked path they touched is
 * restored from that index. The caller re-establishes the recorded conflict
 * for the agent; no broken result is ever committed.
 */
export async function regenerateConflict(
  deps: RegenerationDeps,
  input: RegenerationInput,
): Promise<RegenerationResult> {
  const git = async (args: string[], allowFailure = false) => {
    const result = await deps.exec(['git', '--literal-pathspecs', ...args], {
      cwd: deps.workspacePath,
    })
    if (result.exitCode !== 0 && !allowFailure)
      throw new Error(
        `regeneration git ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`,
      )
    return result
  }
  const snapshot = async (): Promise<Snapshot> => ({
    worktree: new Set(paths((await git(['diff', '--name-only', '-z'])).stdout)),
    untracked: new Set(
      paths((await git(['ls-files', '--others', '--exclude-standard', '-z'])).stdout),
    ),
    index: paths((await git(['ls-files', '-s', '-z'])).stdout).filter((entry) =>
      /^\d+ [0-9a-f]+ 0\t/.test(entry),
    ),
  })
  const files = [...input.files].sort()
  const conflicted = new Set(files)

  // 1. The recorded conflict, exactly.
  if ((await git(['rev-parse', '--verify', '-q', 'CHERRY_PICK_HEAD'], true)).exitCode !== 0)
    return { outcome: 'failed', reason: 'conflict did not reproduce: no cherry-pick in progress' }
  const unmerged = paths(
    (await git(['diff', '--name-only', '--diff-filter=U', '-z'])).stdout,
  ).sort()
  if (unmerged.join('\0') !== files.join('\0'))
    return {
      outcome: 'failed',
      reason: regenerationReason(
        `conflict did not reproduce: expected ${files.join(', ')}, found ${unmerged.join(', ') || 'none'}`,
      ),
    }

  // 2. Start every conflicted file from the replay base's side. Only the
  // worktree changes; the index stays unmerged until the result is staged.
  for (const file of files) {
    const stages = paths((await git(['ls-files', '-s', '-z', '--', file])).stdout)
    if (stages.some((entry) => /^\d+ [0-9a-f]+ 2\t/.test(entry)))
      await git(['checkout', '--ours', '--', file])
    else {
      const removed = await deps.exec(['rm', '-f', '--', file], { cwd: deps.workspacePath })
      if (removed.exitCode !== 0) throw new Error(`cannot remove ${file}: ${removed.stderr}`)
    }
  }

  // 2a. What exists before any command runs. The index is copied whole so a
  // failure can restore its unmerged entries, whoever changed them.
  const before = await snapshot()
  const declared = compilePathSelectors(input.selectors)
  const copy = async (from: string, to: string) => {
    const copied = await deps.exec(['cp', '--', from, to], { cwd: deps.workspacePath })
    if (copied.exitCode !== 0) throw new Error(`cannot copy ${from} to ${to}: ${copied.stderr}`)
  }
  const gitPath = async (name: string) =>
    (await git(['rev-parse', '--path-format=absolute', '--git-path', name])).stdout.trim()
  const indexFile = await gitPath('index')
  const indexBackup = await gitPath('ab-regeneration-index')
  await copy(indexFile, indexBackup)

  const cleanup = async () => {
    await copy(indexBackup, indexFile)
    const current = await snapshot()
    const created = [...current.untracked].filter((path) => !before.untracked.has(path))
    const directories = new Set<string>()
    for (const path of created) {
      const removed = await deps.exec(['rm', '-f', '--', path], { cwd: deps.workspacePath })
      if (removed.exitCode !== 0) throw new Error(`cannot remove ${path}: ${removed.stderr}`)
      for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1))
        directories.add(path.slice(0, at))
    }
    // Deepest first; rmdir refuses a directory that still holds anything.
    for (const directory of [...directories].sort((a, b) => b.length - a.length))
      await deps.exec(['rmdir', '--', directory], { cwd: deps.workspacePath })
    const touched = [...current.worktree].filter((path) => !conflicted.has(path))
    if (touched.length > 0) await git(['checkout', '--', ...touched])
    const after = await snapshot()
    const residue = [
      ...[...after.worktree].filter((path) => !conflicted.has(path)),
      ...[...after.untracked].filter((path) => !before.untracked.has(path)),
      ...[...before.untracked].filter((path) => !after.untracked.has(path)),
    ]
    if (residue.length > 0)
      throw new Error(`regeneration cleanup left changes behind: ${residue.join(', ')}`)
    if (after.index.join('\0') !== before.index.join('\0'))
      throw new Error('regeneration cleanup could not restore the staged replay edits')
  }

  try {
    // 3. The declared commands, once per group, in declaration order.
    for (const group of input.groups) {
      const result = await deps.exec(['sh', '-c', group.command], {
        cwd: deps.workspacePath,
        ...(deps.signal ? { signal: deps.signal } : {}),
      })
      if (deps.signal?.aborted) throw new RegenerationInterrupted()
      if (result.exitCode !== 0) {
        const output = [result.stdout, result.stderr].filter((text) => text !== '').join('\n')
        throw new RegenerationFailure(
          `\`${group.command}\` exited ${result.exitCode}${output.trim() ? `: ${tail(output.trim())}` : ''}`,
        )
      }
    }

    // 4. Only declared paths may change. Index-versus-HEAD differences are the
    // replay's clean staged edits and are deliberately not inspected.
    const after = await snapshot()
    const introduced = [...new Set([...after.worktree, ...after.untracked])]
      .filter((path) => !conflicted.has(path) && !before.untracked.has(path))
      .sort()
    const undeclared = introduced.filter((path) => !declared(path))
    if (undeclared.length > 0)
      throw new RegenerationFailure(
        `regeneration changed undeclared path(s): ${undeclared.join(', ')}`,
      )
    if (after.index.join('\0') !== before.index.join('\0'))
      throw new RegenerationFailure('a regeneration command staged changes itself')

    // 5. Stage exactly the regenerated paths.
    const staged = [...files, ...introduced]
    await git(['add', '-A', '--', ...staged])
    if ((await git(['ls-files', '-u'])).stdout.trim() !== '')
      throw new RegenerationFailure('unmerged paths remain after regeneration')

    // 6. No conflict markers in what would be committed. `=======` alone is a
    // legitimate setext heading underline, so only the outer markers count.
    const markers = await git(
      ['grep', '--cached', '-n', '-I', '-E', '^(<<<<<<<|>>>>>>>)( |$)', '--', ...staged],
      true,
    )
    if (markers.exitCode === 0)
      throw new RegenerationFailure(
        `regenerated files still contain conflict markers: ${tail(markers.stdout.trim())}`,
      )
    if (markers.exitCode !== 1)
      throw new RegenerationFailure(
        `cannot inspect regenerated files for conflict markers: ${markers.stderr.trim()}`,
      )

    // 7. Commit as the change's replay: its own message and author.
    const identity: string[] = []
    for (const [key, format] of [
      ['user.name', '%cn'],
      ['user.email', '%ce'],
    ] as const) {
      if ((await git(['config', '--get', key], true)).stdout.trim() === '')
        identity.push(
          '-c',
          `${key}=${(await git(['show', '-s', `--format=${format}`, input.identitySource])).stdout.trim()}`,
        )
    }
    const commit = await git(
      [
        ...identity,
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--no-verify',
        '--allow-empty',
        '--reuse-message=CHERRY_PICK_HEAD',
      ],
      true,
    )
    if (commit.exitCode !== 0)
      throw new RegenerationFailure(
        `cannot commit the regenerated replay: ${tail(commit.stderr.trim() || commit.stdout.trim())}`,
      )
    return { outcome: 'resolved', head: (await git(['rev-parse', 'HEAD'])).stdout.trim() }
  } catch (error) {
    if (!(error instanceof RegenerationFailure)) throw error
    await cleanup()
    return { outcome: 'failed', reason: regenerationReason(error.message) }
  } finally {
    await deps.exec(['rm', '-f', '--', indexBackup], { cwd: deps.workspacePath })
  }
}
