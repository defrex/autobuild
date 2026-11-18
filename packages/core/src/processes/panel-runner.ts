/**
 * One judge panel run's filesystem half (SPEC §13.1.1, RFC 0005 §8). Each
 * pending judge gets its own root outside any repository, holding the two
 * variants as plain trees labeled `A/` and `B/` in the judge's order, its
 * brief, and the `ab-judge` skill copied from the harness pin. Both variants
 * carry the harness pin's exact bytes on every harness path.
 *
 * The variants are checked out from a private bare Git directory whose object
 * store borrows the workspace's through `objects/info/alternates`. That
 * material lives beside the judge roots, never inside one, and is removed
 * before any judge session starts, so nothing under a judge's root links back
 * to the repository. Every Git and shell operation goes through the injected
 * `Exec`, so the sequence is unit-testable.
 *
 * Nothing here writes to the store: `BuildRunner.runPanel` supplies the
 * durable steps through `PanelLoopHooks`.
 */
import { createHash } from 'node:crypto'
import type { EventPayload } from '../events/payloads'
import { harnessDiff, parseLsTree, type TreeEntry } from '../kernel/measurement'
import {
  awaitingReclaim,
  completable,
  countedFailures,
  drawOrder,
  judgments,
  labelSides,
  PANEL_JUDGE_ATTEMPTS,
  panelWinRate,
  pendingJudges,
  type PanelJudgeOutcome,
  type PanelOrder,
  type PanelRunState,
  type PanelSide,
} from '../kernel/panel'
import type { Exec, ExecResult } from '../ports/workspace/git-worktree'

/** Longest output tail a failure carries. */
const OUTPUT_TAIL_CHARS = 4_000
/** Paths per `update-index` invocation, so argv stays bounded. */
const PATH_BATCH = 200
/** Attributes that would alter checked-out bytes are unset for every path:
 * the variants carry exactly the committed blobs. Read from the private Git
 * directory, they take precedence over any in-tree `.gitattributes`. */
export const NEUTRAL_ATTRIBUTES = '* -text -eol -filter -ident -working-tree-encoding\n'
/** Where the pinned `ab-judge` skill is read from at the harness pin. */
export const PINNED_JUDGE_SKILL = '.agents/skills/ab-judge/SKILL.md'
/** Where it is installed in a judge root, for every runtime's discovery. */
export const JUDGE_SKILL_INSTALLS = [
  '.agents/skills/ab-judge/SKILL.md',
  '.claude/skills/ab-judge/SKILL.md',
] as const
/** The judge's scratch directory in its root (`AB_CONTEXT_DIR`). */
export const JUDGE_CONTEXT_DIR = '.ab/judge'
export const JUDGE_BRIEF = `${JUDGE_CONTEXT_DIR}/brief.json`

const GIT_CONFIG = ['-c', 'core.autocrlf=false', '-c', 'core.symlinks=true']
/** Resolves `$TMPDIR`, or `/tmp` when it is unset or empty, to a real path. */
export const TMPDIR_PROBE = 'd=$TMPDIR; [ -n "$d" ] || d=/tmp; cd "$d" && pwd -P'

export class PanelPreparationFailure extends Error {
  constructor(
    readonly reason: string,
    readonly outputTail = '',
  ) {
    super(reason)
  }
}

function tail(result: Pick<ExecResult, 'stdout' | 'stderr'>): string {
  const text = [result.stderr, result.stdout].filter((part) => part !== '').join('\n')
  return text.length <= OUTPUT_TAIL_CHARS ? text : `…${text.slice(-OUTPUT_TAIL_CHARS)}`
}

function batches<T>(items: readonly T[]): T[][] {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += PATH_BATCH)
    out.push(items.slice(index, index + PATH_BATCH))
  return out
}

function digest(...parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
}

export interface PanelDeps {
  exec: Exec
  /** The ambient environment whose `GIT_*` keys every Git command clears, so
   * no inherited repository selection leaks in. Defaults to `process.env`. */
  ambientEnv?: Readonly<Record<string, string | undefined>>
  /** The distribution's install form of `ab-judge`, used when the harness pin
   * predates the vendored copy. */
  distributionSkill: () => Promise<string>
}

export interface PanelVariants {
  /** The workspace whose Git common directory holds every commit. */
  workspacePath: string
  candidate: string
  baseline: string
  harnessPin: string
  harness: readonly string[]
}

export interface PanelPaths {
  material: string
  judgeRoot(judge: number): string
}

/** Every Git command's environment: inherited `GIT_*` cleared, then the
 * scoped values applied. */
function gitEnv(
  deps: PanelDeps,
  scoped: Record<string, string> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const key of Object.keys(deps.ambientEnv ?? process.env))
    if (key.startsWith('GIT_')) env[key] = undefined
  env.GIT_CEILING_DIRECTORIES = undefined
  env.GIT_DIR = undefined
  env.GIT_WORK_TREE = undefined
  env.GIT_INDEX_FILE = undefined
  return { ...env, ...scoped }
}

async function realPath(exec: Exec, path: string): Promise<string> {
  const result = await exec(['sh', '-c', 'cd "$1" && pwd -P', 'sh', path], {})
  if (result.exitCode !== 0)
    throw new PanelPreparationFailure(`cannot resolve ${path}`, tail(result))
  return result.stdout.trim()
}

/** The deterministic, side-free paths of one panel: no path names a SHA, the
 * candidate or the baseline. A rerun on the same build and panel reuses them,
 * so a crashed predecessor's leftovers are cleared. */
export async function panelPaths(exec: Exec, build: string, panel: string): Promise<PanelPaths> {
  const result = await exec(['sh', '-c', TMPDIR_PROBE], {})
  if (result.exitCode !== 0)
    throw new PanelPreparationFailure('cannot resolve the temporary directory', tail(result))
  const tmp = result.stdout.trim()
  return {
    material: `${tmp}/autobuild-panel-${digest(build, panel)}`,
    judgeRoot: (judge) => `${tmp}/autobuild-judge-${digest(build, panel, judge)}`,
  }
}

/** Write one file through the shell, its content passed in the environment. */
async function writeFile(exec: Exec, path: string, content: string): Promise<void> {
  const result = await exec(
    ['sh', '-c', 'mkdir -p "$(dirname "$1")" && printf %s "$AB_FILE_CONTENT" > "$1"', 'sh', path],
    { env: { AB_FILE_CONTENT: content } },
  )
  if (result.exitCode !== 0)
    throw new PanelPreparationFailure(`writing ${path} failed`, tail(result))
}

export interface PanelMaterial {
  dir: string
  gitDir: string
  /** The scratch index holding each side, named by an opaque counter. */
  indexes: Record<PanelSide, string>
}

/** The shared material for one launch wave: a private bare Git directory over
 * the workspace's objects and one scratch index per side, each side's harness
 * entries replaced by the pin's. */
export async function preparePanelMaterial(
  deps: PanelDeps,
  variants: PanelVariants,
  dir: string,
): Promise<PanelMaterial> {
  const { exec } = deps
  const run = async (
    cmd: string[],
    what: string,
    opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
  ): Promise<ExecResult> => {
    const result = await exec(cmd, opts)
    if (result.exitCode !== 0) throw new PanelPreparationFailure(`${what} failed`, tail(result))
    return result
  }
  const ws = { cwd: variants.workspacePath, env: gitEnv(deps) }
  await exec(['rm', '-rf', dir], {})
  await run(['mkdir', '-p', dir], 'creating the panel material directory')
  const common = (
    await run(
      ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      'locating the workspace Git directory',
      ws,
    )
  ).stdout.trim()
  for (const sha of new Set([variants.candidate, variants.baseline, variants.harnessPin])) {
    const present = await exec(['git', 'cat-file', '-e', `${sha}^{commit}`], ws)
    if (present.exitCode !== 0)
      await run(['git', 'fetch', '--no-tags', 'origin', sha], `fetching ${sha}`, ws)
  }
  const gitDir = `${dir}/git`
  await run(['git', 'init', '--bare', '-q', gitDir], 'creating the private Git directory', {
    env: gitEnv(deps),
  })
  await writeFile(exec, `${gitDir}/objects/info/alternates`, `${common}/objects\n`)
  await writeFile(exec, `${gitDir}/info/attributes`, NEUTRAL_ATTRIBUTES)

  const tree = async (sha: string): Promise<TreeEntry[]> =>
    parseLsTree((await run(['git', 'ls-tree', '-r', '-z', sha], `listing ${sha}`, ws)).stdout)
  const pinFiles = await tree(variants.harnessPin)
  const pinned = new Map(pinFiles.map((entry) => [entry.path, entry]))
  const indexes = {} as Record<PanelSide, string>
  let counter = 0
  for (const side of ['candidate', 'baseline'] as const) {
    counter += 1
    const index = `${dir}/index-${counter}`
    indexes[side] = index
    const sha = variants[side]
    const env = gitEnv(deps, { GIT_DIR: gitDir, GIT_INDEX_FILE: index })
    await run(['git', ...GIT_CONFIG, 'read-tree', sha], `reading the tree of ${sha}`, { env })
    if (sha === variants.harnessPin) continue
    const { restore, remove } = harnessDiff(pinFiles, await tree(sha), variants.harness)
    for (const paths of batches(remove))
      await run(
        ['git', ...GIT_CONFIG, 'update-index', '--force-remove', '--', ...paths],
        'removing unpinned harness files',
        { env },
      )
    for (const paths of batches(restore))
      await run(
        [
          'git',
          ...GIT_CONFIG,
          'update-index',
          '--add',
          ...paths.flatMap((path) => {
            const entry = pinned.get(path)!
            return ['--cacheinfo', `${entry.mode},${entry.object},${path}`]
          }),
        ],
        'restoring pinned harness files',
        { env },
      )
  }
  return { dir, gitDir, indexes }
}

/** Recreate one judge root and check out both labels, A first, then B. */
export async function materializeJudge(
  deps: PanelDeps,
  material: PanelMaterial,
  root: string,
  order: PanelOrder,
): Promise<void> {
  const { exec } = deps
  await exec(['rm', '-rf', root], {})
  const made = await exec(['mkdir', '-p', `${root}/A`, `${root}/B`], {})
  if (made.exitCode !== 0)
    throw new PanelPreparationFailure('creating a judge root failed', tail(made))
  const sides = labelSides(order)
  for (const label of ['A', 'B'] as const) {
    const result = await exec(['git', ...GIT_CONFIG, 'checkout-index', '-a', '-f'], {
      cwd: `${root}/${label}`,
      env: gitEnv(deps, {
        GIT_DIR: material.gitDir,
        GIT_INDEX_FILE: material.indexes[sides[label]],
        GIT_WORK_TREE: `${root}/${label}`,
      }),
    })
    if (result.exitCode !== 0)
      throw new PanelPreparationFailure(`checking out variant ${label} failed`, tail(result))
  }
}

/** The judge's brief: everything `ab judge context` presents, and nothing
 * that names a side. */
export async function writeBrief(
  deps: PanelDeps,
  root: string,
  brief: { judge: number; purpose: string; rubric: string },
): Promise<void> {
  await writeFile(deps.exec, `${root}/${JUDGE_BRIEF}`, `${JSON.stringify(brief, null, 2)}\n`)
}

/** Install `ab-judge` into a judge root as regular files, from the harness
 * pin's vendored copy, so a candidate cannot rewrite its own judges'
 * instructions; the distribution's copy when the pin predates it. */
export async function installJudgeSkill(
  deps: PanelDeps,
  workspacePath: string,
  root: string,
  harnessPin: string,
): Promise<void> {
  const pinned = await deps.exec(
    ['git', 'cat-file', 'blob', `${harnessPin}:${PINNED_JUDGE_SKILL}`],
    {
      cwd: workspacePath,
      env: gitEnv(deps),
    },
  )
  const content = pinned.exitCode === 0 ? pinned.stdout : await deps.distributionSkill()
  for (const path of JUDGE_SKILL_INSTALLS) await writeFile(deps.exec, `${root}/${path}`, content)
}

/** Remove the shared material before any judge session starts. */
export async function sealPanelMaterial(deps: PanelDeps, material: PanelMaterial): Promise<void> {
  const removed = await deps.exec(['rm', '-rf', material.dir], {})
  if (removed.exitCode !== 0)
    throw new PanelPreparationFailure('removing the panel material failed', tail(removed))
}

/** Refuse a judge root inside the workspace, or one from which Git finds any
 * repository. Returns the refusal, or undefined. */
export async function checkJudgeRoot(
  deps: PanelDeps,
  root: string,
  workspacePath: string,
): Promise<string | undefined> {
  const [rootPath, workspace] = [
    await realPath(deps.exec, root),
    await realPath(deps.exec, workspacePath),
  ]
  if (rootPath === workspace || rootPath.startsWith(`${workspace}/`))
    return 'judge root is inside the workspace; point TMPDIR outside any repository'
  const found = await deps.exec(['git', 'rev-parse', '--git-dir'], {
    cwd: root,
    env: gitEnv(deps),
  })
  if (found.exitCode === 0)
    return 'judge root is inside a git repository; point TMPDIR outside any repository'
  return undefined
}

/** Remove every judge root and the material directory. */
export async function removePanelPaths(
  deps: PanelDeps,
  paths: PanelPaths,
  judges: number,
): Promise<void> {
  const roots = Array.from({ length: judges }, (_, index) => paths.judgeRoot(index + 1))
  await deps.exec(['rm', '-rf', paths.material, ...roots], {}).catch(() => undefined)
}

// ── The run loop ─────────────────────────────────────────────────────────────

export type PanelResult =
  | { kind: 'judged'; winRate: number; judgments: Array<EventPayload<'panel.judged'>> }
  | { kind: 'failed'; reason: string; outputTail?: string }
  | { kind: 'interrupted' }

/** The durable steps the loop needs, supplied by `BuildRunner.runPanel`. */
export interface PanelLoopHooks {
  /** One reduced read of the run's state. */
  read(): Promise<PanelRunState>
  /** Record a saved preference's judgment without a session. */
  complete(judged: EventPayload<'panel.judged'>): Promise<void>
  /** Close a crashed predecessor's judge session. */
  reclaim(judge: number, session: string): Promise<void>
  /** Start the judge's session in its sealed root; resolves with its outcome
   * once `panel.judged` (if any) and `panel.judge-ended` are recorded. */
  launch(judge: number, order: PanelOrder, root: string): Promise<PanelJudgeOutcome>
  random(): number
  shutdownSignal?: AbortSignal
}

export interface PanelRunInput extends PanelVariants {
  build: string
  panel: string
  purpose: string
  rubric: string
  judges: number
}

/**
 * Run the panel to a result: complete saved preferences, reclaim dangling
 * sessions, then launch every pending judge concurrently, wave by wave, until
 * every judge has a judgment, one judge exhausts its attempts, or shutdown.
 */
export async function runPanelJudges(
  deps: PanelDeps,
  input: PanelRunInput,
  hooks: PanelLoopHooks,
): Promise<PanelResult> {
  let paths: PanelPaths | undefined
  try {
    paths = await panelPaths(deps.exec, input.build, input.panel)
    for (;;) {
      let run = await hooks.read()
      for (const judged of completable(run)) await hooks.complete(judged)
      for (const { judge, session } of awaitingReclaim(run)) await hooks.reclaim(judge, session)
      run = await hooks.read()
      for (const judge of pendingJudges(run)) {
        const failures = countedFailures(run, judge)
        if (failures.length >= PANEL_JUDGE_ATTEMPTS)
          return {
            kind: 'failed',
            reason: `judge ${judge} failed ${failures.length} times; last outcome ${failures.at(-1)}`,
          }
      }
      const pending = pendingJudges(run)
      if (pending.length === 0) {
        const recorded = judgments(run)
        return { kind: 'judged', winRate: panelWinRate(recorded), judgments: recorded }
      }
      if (hooks.shutdownSignal?.aborted) return { kind: 'interrupted' }

      const material = await preparePanelMaterial(deps, input, paths.material)
      const wave: Array<{ judge: number; order: PanelOrder; root: string }> = []
      for (const judge of pending) {
        const order = drawOrder(hooks.random)
        const root = paths.judgeRoot(judge)
        await materializeJudge(deps, material, root, order)
        await writeBrief(deps, root, { judge, purpose: input.purpose, rubric: input.rubric })
        await installJudgeSkill(deps, input.workspacePath, root, input.harnessPin)
        wave.push({ judge, order, root })
      }
      await sealPanelMaterial(deps, material)
      for (const { root } of wave) {
        const refusal = await checkJudgeRoot(deps, root, input.workspacePath)
        if (refusal !== undefined) return { kind: 'failed', reason: refusal }
      }
      const outcomes = await Promise.all(
        wave.map(({ judge, order, root }) => hooks.launch(judge, order, root)),
      )
      if (outcomes.includes('interrupted') || hooks.shutdownSignal?.aborted)
        return { kind: 'interrupted' }
    }
  } catch (error) {
    if (error instanceof PanelPreparationFailure)
      return { kind: 'failed', reason: error.reason, outputTail: error.outputTail }
    throw error
  } finally {
    if (paths !== undefined) await removePanelPaths(deps, paths, input.judges)
  }
}
