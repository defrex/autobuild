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
 * Nothing the judge inherits may name a protected location: the workspace,
 * its checkout, its Git common directory, the main checkout, or a local store.
 * The scratch base is checked against them before any material is written,
 * each root again after materialization (with Git discovery that fails
 * closed), and the judge's `ab` is a self-contained launcher written beside
 * the roots, never a path into the distribution.
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
import { sessionEnv, type JudgeLaunch } from '../ports/runner/session-env'
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
/** Where `ab judge prefer` saves a local judge's preference for the runner to
 * commit (the judge holds no store). */
export const JUDGE_PREFERENCE_OUTBOX = `${JUDGE_CONTEXT_DIR}/preference.json`
/** The launcher's name in the judge's launcher directory. */
export const JUDGE_LAUNCHER_NAME = 'ab'

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
   * no inherited repository selection leaks in, and from which the judge's
   * filtered `PATH` is derived. Defaults to `process.env`. */
  ambientEnv?: Readonly<Record<string, string | undefined>>
  /** The distribution's install form of `ab-judge`, used when the harness pin
   * predates the vendored copy. */
  distributionSkill: () => Promise<string>
  /** The self-contained, judge-only `ab` launcher's text. */
  judgeLauncher: () => Promise<string>
  /** The running distribution's root, which the launcher must not name. */
  distributionRoot?: string
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
  /** The real scratch base every other path is under. */
  base: string
  material: string
  /** The directory holding the judge's `ab` launcher, beside the roots. */
  launcherDir: string
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

/** Resolves `$1` physically whether it names a directory or a file; prints
 * nothing when it does not exist. */
export const REAL_ENTRY_PROBE =
  'if [ -d "$1" ]; then cd -P "$1" && pwd -P; ' +
  'elif [ -e "$1" ]; then d=$(cd -P "$(dirname "$1")" && pwd -P) && printf "%s/%s\\n" "$d" "$(basename "$1")"; fi'

/** Every location a judge must not be able to find through anything it
 * inherits, as real paths: the workspace, its checkout, its Git common
 * directory, the main checkout that owns that directory, and a local store. */
export async function judgeProtectedPaths(
  deps: PanelDeps,
  workspacePath: string,
  localStore?: string,
): Promise<string[]> {
  const located = await deps.exec(
    ['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
    { cwd: workspacePath, env: gitEnv(deps) },
  )
  if (located.exitCode !== 0)
    throw new PanelPreparationFailure('locating the workspace repository failed', tail(located))
  const [toplevel, common] = located.stdout.trim().split('\n')
  const candidates = [workspacePath, toplevel, common]
  if (common !== undefined && /\/\.git\/?$/.test(common))
    candidates.push(common.replace(/\/\.git\/?$/, ''))
  if (localStore !== undefined && localStore !== '') candidates.push(localStore)
  const out = new Set<string>()
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === '') continue
    const real = await deps.exec(['sh', '-c', REAL_ENTRY_PROBE, 'sh', candidate], {})
    const resolved = real.exitCode === 0 ? real.stdout.trim() : ''
    out.add(resolved !== '' ? resolved : candidate)
    // The lexical spelling is protected too: it reaches the same place.
    if (candidate.startsWith('/')) out.add(candidate.replace(/(.)\/+$/, '$1'))
  }
  return [...out]
}

/** Prints, one line per argument, the physical location the absolute path
 * reaches: every symlink it passes through followed, and any part that does
 * not exist appended to its deepest existing ancestor's real path. Prints an
 * empty line when a path cannot be resolved. */
export const PHYSICAL_PATHS_PROBE = `for p in "$@"; do
  rest=; r=; hops=0
  while :; do
    if [ -d "$p" ]; then r=$(cd -P "$p" 2>/dev/null && pwd -P) || r=; break; fi
    if [ -L "$p" ]; then
      hops=$((hops + 1)); [ "$hops" -le 40 ] || { r=; break; }
      t=$(readlink "$p") || { r=; break; }
      case $t in /*) p=$t ;; *) p=$(dirname "$p")/$t ;; esac
      continue
    fi
    rest=/$(basename "$p")$rest; p=$(dirname "$p")
  done
  if [ -n "$r" ]; then printf "%s%s\\n" "\${r%/}" "$rest"; else printf "\\n"; fi
done`

/** Paths per resolution probe, well inside one command line's limit. */
const PHYSICAL_PATHS_BATCH = 256

/** One absolute path an ambient value carries, and the spelling to hide when
 * it reaches a protected location: the piece of the value it starts in, so
 * an embedded path such as `-I/alias/include` is hidden by a spelling
 * bounded by separators. */
interface AmbientPath {
  path: string
  spelling: string
}

/** Every absolute path an ambient value or `PATH` entry carries: in the whole
 * value, each line, and each piece between separators, the path from the
 * first `/` on. */
function ambientPaths(ambient: Readonly<Record<string, string | undefined>>): AmbientPath[] {
  const found = new Map<string, AmbientPath>()
  for (const value of Object.values(ambient)) {
    if (value === undefined) continue
    for (const spelling of [value, ...value.split(/\r?\n/), ...value.split(/[\s:;,='"]+/)]) {
      const at = spelling.indexOf('/')
      const path = at === -1 ? '' : spelling.slice(at)
      // A multiline path is found line by line: the probe answers in lines.
      if (path === '' || path === '/' || /[\r\n]/.test(path)) continue
      found.set(`${path}\0${spelling}`, { path, spelling })
    }
  }
  return [...found.values()]
}

/** The lexical spellings in the ambient environment that reach a protected
 * location but are not already hidden by the real paths: a symlinked
 * checkout, a symlinked ancestor, a link to a file inside it, or a path
 * embedded after a prefix such as `-I`. Hiding them as well keeps an
 * inherited value such as `INIT_CWD=/work/alias` or `CFLAGS=-I/work/alias`
 * from leading a judge back into the repository. A path that cannot be
 * resolved is hidden too. */
export async function judgeAmbientAliases(
  deps: PanelDeps,
  protectedPaths: readonly string[],
): Promise<string[]> {
  const aliases = new Set<string>()
  const unresolved: AmbientPath[] = []
  for (const found of ambientPaths(deps.ambientEnv ?? process.env)) {
    if (insideProtected(found.path, protectedPaths) === undefined) unresolved.push(found)
    // A literal path the real locations name only behind a prefix.
    else if (found.spelling !== found.path) aliases.add(found.spelling)
  }
  const paths = [...new Set(unresolved.map((found) => found.path))]
  const physical = new Map<string, string>()
  for (let at = 0; at < paths.length; at += PHYSICAL_PATHS_BATCH) {
    const batch = paths.slice(at, at + PHYSICAL_PATHS_BATCH)
    const result = await deps.exec(['sh', '-c', PHYSICAL_PATHS_PROBE, 'sh', ...batch], {})
    const lines = result.stdout.split('\n').slice(0, -1)
    if (result.exitCode !== 0 || lines.length !== batch.length)
      throw new PanelPreparationFailure(
        "resolving the inherited environment's paths failed",
        tail(result),
      )
    batch.forEach((path, index) => {
      physical.set(path, lines[index]!)
    })
  }
  for (const found of unresolved) {
    const resolved = physical.get(found.path)!
    if (resolved === '' || insideProtected(resolved, protectedPaths) !== undefined)
      aliases.add(found.spelling)
  }
  return [...aliases]
}

/** The protected location `path` is at or under, if any. */
export function insideProtected(
  path: string,
  protectedPaths: readonly string[],
): string | undefined {
  return protectedPaths.find((root) => path === root || path.startsWith(`${root}/`))
}

/** Refuse a scratch location that is protected, or from which Git finds a
 * repository. Discovery crosses filesystem boundaries, and only a clean
 * "not a git repository" counts as outside: any other failure refuses. */
async function scratchRefusal(
  deps: PanelDeps,
  path: string,
  what: string,
  protectedPaths: readonly string[],
): Promise<string | undefined> {
  const real = await realPath(deps.exec, path)
  if (insideProtected(real, protectedPaths) !== undefined)
    return `${what} is inside the repository, its Git directory or the local store; point TMPDIR outside any repository`
  const found = await deps.exec(['git', 'rev-parse', '--git-dir'], {
    cwd: path,
    env: gitEnv(deps, { GIT_DISCOVERY_ACROSS_FILESYSTEM: '1' }),
  })
  if (found.exitCode === 0)
    return `${what} is inside a git repository; point TMPDIR outside any repository`
  if (!/not a git repository/i.test(found.stderr))
    return `${what} could not be proven to be outside every git repository; point TMPDIR outside any repository`
  return undefined
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
    base: tmp,
    material: `${tmp}/autobuild-panel-${digest(build, panel)}`,
    launcherDir: `${tmp}/autobuild-judge-bin-${digest(build, panel, 'bin')}`,
    judgeRoot: (judge) => `${tmp}/autobuild-judge-${digest(build, panel, judge)}`,
  }
}

/** Code units per launcher write. */
const LAUNCHER_CHUNK = 32 * 1024

/** Write the judge's `ab` launcher into its own directory, refusing launcher
 * text that names a protected location or the distribution. */
export async function writeJudgeLauncher(
  deps: PanelDeps,
  dir: string,
  protectedPaths: readonly string[],
): Promise<void> {
  const text = await deps.judgeLauncher()
  const named = [...protectedPaths, ...(deps.distributionRoot ? [deps.distributionRoot] : [])]
  if (named.some((path) => path !== '' && path !== '/' && text.includes(path)))
    throw new PanelPreparationFailure(
      'the judge launcher names the repository or the Autobuild distribution; refusing to expose it to a judge',
    )
  await deps.exec(['rm', '-rf', dir], {})
  const path = `${dir}/${JUDGE_LAUNCHER_NAME}`
  // One environment value is limited to 128 KiB, so the launcher is written
  // in chunks small enough at three UTF-8 bytes per code unit.
  for (let at = 0, first = true; at < text.length || first; first = false) {
    let end = Math.min(text.length, at + LAUNCHER_CHUNK)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1
    const result = await deps.exec(
      [
        'sh',
        '-c',
        `mkdir -p "$(dirname "$1")" && printf %s "$AB_FILE_CONTENT" ${first ? '>' : '>>'} "$1"`,
        'sh',
        path,
      ],
      { env: { AB_FILE_CONTENT: text.slice(at, end) } },
    )
    if (result.exitCode !== 0)
      throw new PanelPreparationFailure(`writing ${path} failed`, tail(result))
    at = end
  }
  const made = await deps.exec(['chmod', '0755', path], {})
  if (made.exitCode !== 0)
    throw new PanelPreparationFailure('making the judge launcher executable failed', tail(made))
}

/** Prints the path `$2` resolves to through PATH `$1`, then its physical
 * path with every symlink followed; exits non-zero when it is not found or
 * cannot be resolved. */
export const EXECUTABLE_PROBE = `p=$( (PATH=$1; command -v "$2") ) || exit 3
case $p in /*) ;; *) exit 3 ;; esac
printf "%s\\n" "$p"
hops=0
while [ -L "$p" ]; do
  hops=$((hops + 1)); [ "$hops" -le 40 ] || exit 4
  t=$(readlink "$p") || exit 4
  case $t in /*) p=$t ;; *) p=$(dirname "$p")/$t ;; esac
done
d=$(cd -P "$(dirname "$p")" && pwd -P) || exit 4
printf "%s/%s\\n" "$d" "$(basename "$p")"`

/** Refuse a judge launch whose interpreter or runtime executable is missing
 * from the judge's filtered PATH or resolves only inside a protected
 * location, which would name it in the judge's process arguments. */
export async function checkJudgeExecutables(
  deps: PanelDeps,
  executables: readonly string[],
  launch: JudgeLaunch,
): Promise<string | undefined> {
  const path = sessionEnv({ AB_JUDGE: 'probe' }, deps.ambientEnv ?? process.env, launch).PATH!
  for (const name of executables) {
    const found = await deps.exec(['sh', '-c', EXECUTABLE_PROBE, 'judge-exec', path, name], {})
    if (found.exitCode !== 0)
      return `the judge's ${name} executable was not found outside the repository; install it outside any repository`
    const resolved = found.stdout.split('\n').filter((line) => line !== '')
    if (resolved.some((entry) => insideProtected(entry, launch.hide) !== undefined))
      return `the judge's ${name} executable resolves only inside a protected location; install it outside the repository`
  }
  return undefined
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
  // `update-index` needs a work tree; this empty one is never checked out to.
  const workTree = `${dir}/tree`
  await run(['git', 'init', '--bare', '-q', gitDir], 'creating the private Git directory', {
    env: gitEnv(deps),
  })
  await run(['mkdir', '-p', workTree], 'creating the panel material directory')
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
    const env = gitEnv(deps, { GIT_DIR: gitDir, GIT_INDEX_FILE: index, GIT_WORK_TREE: workTree })
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

/**
 * Lists, one absolute path per line, every symlink under the real root `$1`
 * whose physical resolution leaves that root: each hop is followed with
 * `readlink` and its directory resolved physically with `cd -P`, and a link whose
 * directory cannot be resolved or that loops is listed too, so the check fails
 * closed. Links that stay inside the root print nothing.
 */
export const ESCAPING_LINKS_PROBE = `find "$1" -type l -exec sh -c '
root=$1; shift
for link do
  p=$link; hops=0
  while [ -L "$p" ]; do
    hops=$((hops + 1))
    [ "$hops" -le 40 ] || { printf "%s\\n" "$link"; continue 2; }
    t=$(readlink "$p") || { printf "%s\\n" "$link"; continue 2; }
    case $t in /*) p=$t ;; *) p=$(dirname "$p")/$t ;; esac
    d=$(cd -P "$(dirname "$p")" 2>/dev/null && pwd -P) || { printf "%s\\n" "$link"; continue 2; }
    p=$d/$(basename "$p")
  done
  if [ -d "$p" ]; then p=$(cd -P "$p" && pwd -P) || { printf "%s\\n" "$link"; continue; }; fi
  case $p in "$root" | "$root"/*) ;; *) printf "%s\\n" "$link" ;; esac
done' sh "$1" {} +`

/** Refuse a judge root inside a protected location, one from which Git finds
 * or cannot rule out a repository, or one holding a checked-out symlink that
 * resolves outside it, which could lead a judge back to the repository.
 * Internal links are kept. Returns the refusal, or undefined. */
export async function checkJudgeRoot(
  deps: PanelDeps,
  root: string,
  protectedPaths: readonly string[],
): Promise<string | undefined> {
  const refusal = await scratchRefusal(deps, root, 'judge root', protectedPaths)
  if (refusal !== undefined) return refusal
  const rootPath = await realPath(deps.exec, root)
  const links = await deps.exec(['sh', '-c', ESCAPING_LINKS_PROBE, 'judge-links', rootPath], {})
  if (links.exitCode !== 0)
    throw new PanelPreparationFailure('checking the judge root for symlinks failed', tail(links))
  const escaping = links.stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (line.startsWith(`${rootPath}/`) ? line.slice(rootPath.length + 1) : line))
  if (escaping.length > 0)
    return `a variant holds symlinks that resolve outside its judge root: ${escaping.slice(0, 5).join(', ')}${escaping.length > 5 ? ', …' : ''}`
  return undefined
}

/** Remove every judge root and the material directory. */
export async function removePanelPaths(
  deps: PanelDeps,
  paths: PanelPaths,
  judges: number,
): Promise<void> {
  const roots = Array.from({ length: judges }, (_, index) => paths.judgeRoot(index + 1))
  await deps
    .exec(['rm', '-rf', paths.material, paths.launcherDir, ...roots], {})
    .catch(() => undefined)
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
  /** Close a crashed predecessor's judge session, first committing any
   * preference it saved in its root. */
  reclaim(judge: number, session: string, root: string): Promise<void>
  /** Start the judge's session in its sealed root with its launch context;
   * resolves with its outcome once `panel.judged` (if any) and
   * `panel.judge-ended` are recorded. */
  launch(
    judge: number,
    order: PanelOrder,
    root: string,
    judgeLaunch: JudgeLaunch,
  ): Promise<PanelJudgeOutcome>
  random(): number
  shutdownSignal?: AbortSignal
}

export interface PanelRunInput extends PanelVariants {
  build: string
  panel: string
  purpose: string
  rubric: string
  judges: number
  /** A local store's path, protected like the repository. */
  localStore?: string
  /** The judge runtime's executable, when it spawns one by name. */
  runtimeExecutable?: string
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
    const protectedPaths = await judgeProtectedPaths(deps, input.workspacePath, input.localStore)
    paths = await panelPaths(deps.exec, input.build, input.panel)
    // Before anything is written: material holds a path to the common
    // directory, so the base itself must be outside every protected location.
    const base = await scratchRefusal(deps, paths.base, 'the judge scratch base', protectedPaths)
    if (base !== undefined) return { kind: 'failed', reason: base }
    // Nothing the judge inherits may name a protected location, whether by
    // its real path or by a symlinked spelling found in the environment.
    const hide = [...protectedPaths, ...(await judgeAmbientAliases(deps, protectedPaths))]
    const launch: JudgeLaunch = { hide, binDir: paths.launcherDir }
    const executables = await checkJudgeExecutables(
      deps,
      ['bun', ...(input.runtimeExecutable !== undefined ? [input.runtimeExecutable] : [])],
      launch,
    )
    if (executables !== undefined) return { kind: 'failed', reason: executables }
    await writeJudgeLauncher(deps, paths.launcherDir, protectedPaths)
    const judgeRoots = paths
    for (;;) {
      let run = await hooks.read()
      for (const { judge, session } of awaitingReclaim(run))
        await hooks.reclaim(judge, session, judgeRoots.judgeRoot(judge))
      run = await hooks.read()
      for (const judged of completable(run)) await hooks.complete(judged)
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
        const refusal = await checkJudgeRoot(deps, root, protectedPaths)
        if (refusal !== undefined) return { kind: 'failed', reason: refusal }
      }
      const outcomes = await Promise.all(
        wave.map(({ judge, order, root }) => hooks.launch(judge, order, root, launch)),
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
