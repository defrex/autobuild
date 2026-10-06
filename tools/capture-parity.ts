/**
 * Pixel parity between the merge base and the working tree: runs the terminal
 * dashboard capture and the web dashboard capture on both and byte-compares
 * every PNG. A change that must leave every dashboard frame untouched (a read
 * path moving onto snapshots, a projection refactor) proves it here instead of
 * by eye.
 *
 *   bun tools/capture-parity.ts [--base <ref>]
 *
 * Exits nonzero when a frame differs, a frame exists on one side only, or a
 * capture fails (a missing Chromium is a failure, never a skip).
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoRoot } from './git-tracked'

const CAPTURES = [
  { name: 'terminal', command: ['bun', 'tools/dashboard-capture.ts'], dir: '.ab/dashboard-frames' },
  {
    name: 'web',
    command: ['bun', 'run', 'capture:web-dashboard'],
    dir: '.ab/web-dashboard-frames',
  },
] as const

export interface FrameComparison {
  missing: string[]
  extra: string[]
  differing: string[]
  compared: number
}

/** Compare two frame sets keyed by `<capture>/<file>` to their sha256. */
export function compareFrameSets(
  base: ReadonlyMap<string, string>,
  head: ReadonlyMap<string, string>,
): FrameComparison {
  const missing = [...base.keys()].filter((key) => !head.has(key)).sort()
  const extra = [...head.keys()].filter((key) => !base.has(key)).sort()
  const differing = [...base.keys()]
    .filter((key) => head.has(key) && base.get(key) !== head.get(key))
    .sort()
  return { missing, extra, differing, compared: base.size - missing.length }
}

async function run(cwd: string, command: readonly string[]): Promise<void> {
  const child = Bun.spawn([...command], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
  await new Response(child.stdout).text()
  if (exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed in ${cwd} (exit ${exitCode}): ${stderr.trim()}`)
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`)
  return stdout.trim()
}

async function hashFrames(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>()
  for (const capture of CAPTURES) {
    const dir = join(root, capture.dir)
    if (!existsSync(dir))
      throw new Error(`${capture.name} capture wrote no ${capture.dir} in ${root}`)
    for (const file of (await readdir(dir)).filter((entry) => entry.endsWith('.png')).sort()) {
      const bytes = await readFile(join(dir, file))
      hashes.set(`${capture.name}/${file}`, createHash('sha256').update(bytes).digest('hex'))
    }
  }
  return hashes
}

async function captureAll(root: string): Promise<Map<string, string>> {
  for (const capture of CAPTURES) await run(root, capture.command)
  return hashFrames(root)
}

export async function runCaptureParity(argv: readonly string[]): Promise<number> {
  const baseFlag = argv.indexOf('--base')
  const baseRef = baseFlag >= 0 ? (argv[baseFlag + 1] ?? 'main') : await defaultBase()
  const baseSha = await git(repoRoot, ['merge-base', 'HEAD', baseRef])
  const scratch = await mkdtemp(join(tmpdir(), 'capture-parity-'))
  const baseTree = join(scratch, 'base')
  try {
    await git(repoRoot, ['worktree', 'add', '--detach', baseTree, baseSha])
    // The base tree shares the installed dependencies; the lockfile is the same
    // unless this change edits it, which a parity check does not cover.
    for (const modules of ['node_modules', ...(await packageModules())]) {
      if (existsSync(join(repoRoot, modules)))
        await symlink(join(repoRoot, modules), join(baseTree, modules))
    }
    const base = await captureAll(baseTree)
    const head = await captureAll(repoRoot)
    const result = compareFrameSets(base, head)
    const clean =
      result.missing.length + result.extra.length + result.differing.length === 0 &&
      result.compared > 0
    for (const key of result.missing) console.error(`missing from the working tree: ${key}`)
    for (const key of result.extra) console.error(`only in the working tree: ${key}`)
    for (const key of result.differing) console.error(`differs from ${baseSha.slice(0, 8)}: ${key}`)
    console.log(
      clean
        ? `capture parity: ${result.compared} frames byte-identical to ${baseSha.slice(0, 8)}`
        : `capture parity FAILED against ${baseSha.slice(0, 8)} (${result.compared} compared)`,
    )
    return clean ? 0 : 1
  } finally {
    await git(repoRoot, ['worktree', 'remove', '--force', baseTree]).catch(() => undefined)
    await rm(scratch, { recursive: true, force: true })
  }
}

/** The remote default branch when there is one, else the local `main`. */
async function defaultBase(): Promise<string> {
  for (const ref of ['origin/main', 'main']) {
    if (
      await git(repoRoot, ['rev-parse', '--verify', '--quiet', ref]).then(
        () => true,
        () => false,
      )
    )
      return ref
  }
  return 'main'
}

async function packageModules(): Promise<string[]> {
  const packages = await readdir(join(repoRoot, 'packages')).catch(() => [])
  return packages.map((name) => join('packages', name, 'node_modules'))
}

if (import.meta.main) {
  runCaptureParity(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    },
  )
}
