import { constants } from 'node:fs'
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { drainStack, forEachBounded, TREE_IO_CONCURRENCY } from './cli/bounded-io'

async function spawnExec(cmd: string[], options: { cwd: string; signal?: AbortSignal }) {
  const child = Bun.spawn(cmd, {
    cwd: options.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    signal: options.signal,
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

type PackagingExec = typeof spawnExec

async function execOrThrow(
  cmd: string[],
  cwd: string,
  exec: PackagingExec,
  signal?: AbortSignal,
): Promise<string> {
  const result = await exec(cmd, { cwd, signal })
  if (result.exitCode !== 0) {
    throw new Error(
      `${cmd.join(' ')} exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
    )
  }
  return result.stdout.trim()
}

/** Manifest fields that name repo-local packaging state and must never reach
 * the packed distribution manifest. `patchedDependencies` entries are resolved
 * by bun against the consuming project's root, and bun 1.4.0 panics
 * (`Option::unwrap`, exit 134) when a consumed manifest declares a patch for a
 * package the consumer tree contains — so a packed manifest carrying the
 * repo's better-auth patch declaration breaks any consumer that installs
 * autobuild next to better-auth. The packed artifact ships no patched
 * package, so the declaration is stripped from the packed manifest while the
 * repo manifest keeps it for workspace installs. The strip is an enforced
 * invariant, not a local detail: the `patchedDependencies` rule in
 * `tools/workspace-manifest-check.ts` rejects a root manifest whose packed
 * dependency set contains a patched package, and the negative control in
 * `packages/core/src/plugin-sdk/package.integration.test.ts` (the packed-distribution
 * better-auth canary) pins the consumed-manifest failure shape this strip
 * guards, so removing the field from this list fails the suite loudly.
 *
 * `devDependencies` is stripped for two reasons. First, the workspace link
 * specifiers it may carry (for example the root's
 * `@defrex/autobuild-postgres-store: workspace:*`) cannot be resolved in the
 * staging tree — it stages only the manifest's `files` set, with no
 * `bun.lock`, no `node_modules`, and no workspace packages — so `bun pm pack`
 * fails there with "Failed to resolve workspace version". Second, the guest
 * installs the distribution with `bun install --production --ignore-scripts`,
 * which ignores devDependencies entirely; the packed artifact ships no
 * dev-only tooling, so the declaration is dead weight in the packed manifest
 * while the repo manifest keeps it for workspace installs. */
const packedManifestOmittedFields = ['patchedDependencies', 'devDependencies'] as const

/** Gzip level for an archive that is extracted at once and discarded, never
 * stored or sent anywhere (the packaged source fingerprint). Its compressed
 * bytes are pure overhead: level 0 keeps valid gzip framing for `tar -xzf`
 * while spending no CPU on deflate, which at Bun's default level 9 dominates
 * the pack. */
export const SCRATCH_ARCHIVE_GZIP_LEVEL = 0

/** Gzip level for a locally prepared runtime archive, kept under `.autobuild`
 * and possibly uploaded to a guest. Level 2 packs in well under half the time
 * of the default level 9 for an archive only slightly larger, so dispatcher
 * starts and upgrade handoffs stop paying maximum deflate effort. Its own
 * digest is taken from the bytes it produces. */
export const RUNTIME_ARCHIVE_GZIP_LEVEL = 2

/** The filesystem operations {@link stageDistributionFiles} uses, with the
 * `node:fs/promises` signatures it calls them with. */
export interface StagingFilesystem {
  lstat(path: string): Promise<{
    mode: number
    isDirectory(): boolean
    isFile(): boolean
  }>
  readdir(path: string): Promise<string[]>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>
  copyFile(source: string, target: string, mode: number): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  cp(source: string, target: string, options: typeof stagingCopyOptions): Promise<void>
}

const nodeStagingFilesystem: StagingFilesystem = {
  lstat,
  readdir: (path) => readdir(path),
  mkdir,
  copyFile,
  chmod,
  cp,
}

const stagingCopyOptions = { recursive: true, errorOnExist: true, force: false } as const

function entriesOverlap(staging: string, entries: readonly string[]): boolean {
  const normalized = entries.map((entry) => relative(staging, join(staging, entry)))
  if (normalized.some((path) => path === '' || path.startsWith('..') || isAbsolute(path)))
    return true
  for (const a of normalized)
    for (const b of normalized)
      if (a !== b ? b.startsWith(a + sep) : normalized.indexOf(a) !== normalized.lastIndexOf(a))
        return true
  return false
}

/** Copies each positive `files` entry of `root` to the same relative path under
 * a fresh `staging` directory, with the result `cp(source, target, { recursive:
 * true, errorOnExist: true, force: false })` per entry produces.
 *
 * Disjoint entries are walked by one bounded pool: directory children are
 * queued as plain items, so at most `limit` filesystem operations are in flight
 * across and within entries however many files they hold. The walker creates
 * directories and copies regular files itself, giving each file its source
 * mode (`& 0o7777`) and, after every copy has finished, each directory its
 * source mode deepest level first so a read-only directory is restricted only
 * once its descendants exist. Every other entry kind (symlinks, FIFOs,
 * sockets, devices) is handed to `cp` with the same options, keeping its
 * semantics exactly. Overlapping, duplicate, empty or escaping entries keep
 * the serial per-entry `cp` loop in manifest order, so merges and overlap
 * errors behave as before.
 *
 * After the first failure no operation starts, and the promise settles only
 * once every started operation has settled, so the caller can remove staging
 * without racing an outstanding write. */
export async function stageDistributionFiles(
  root: string,
  staging: string,
  entries: readonly string[],
  fs: StagingFilesystem = nodeStagingFilesystem,
  limit = TREE_IO_CONCURRENCY,
): Promise<void> {
  if (entriesOverlap(staging, entries)) {
    for (const entry of entries) {
      const target = join(staging, entry)
      await fs.mkdir(dirname(target), { recursive: true })
      await fs.cp(join(root, entry), target, stagingCopyOptions)
    }
    return
  }
  type Item = { source: string; target: string; depth: number }
  const directories: Array<Array<{ target: string; mode: number }>> = []
  await drainStack<Item>(
    entries.map((entry) => ({ source: join(root, entry), target: join(staging, entry), depth: 0 })),
    limit,
    async ({ source, target, depth }, push) => {
      const status = await fs.lstat(source)
      if (depth === 0) await fs.mkdir(dirname(target), { recursive: true })
      if (status.isDirectory()) {
        await fs.mkdir(target)
        const level = directories[depth] ?? []
        directories[depth] = level
        level.push({ target, mode: status.mode & 0o7777 })
        for (const name of await fs.readdir(source))
          push({ source: join(source, name), target: join(target, name), depth: depth + 1 })
      } else if (status.isFile()) {
        await fs.copyFile(source, target, constants.COPYFILE_EXCL)
        await fs.chmod(target, status.mode & 0o7777)
      } else {
        await fs.cp(source, target, stagingCopyOptions)
      }
    },
  )
  for (let depth = directories.length - 1; depth >= 0; depth--)
    await forEachBounded(directories[depth] ?? [], limit, ({ target, mode }) =>
      fs.chmod(target, mode),
    )
}

/** Packs `root`'s `files` set with `bun pm pack`. `options.gzipLevel` (an
 * integer 0–9) sets the archive's deflate effort; omitted, Bun's default
 * applies and the command is unchanged. The level changes compressed bytes
 * only, never the extracted contents. */
export async function packageDistribution(
  root: string,
  exec: PackagingExec = spawnExec,
  signal?: AbortSignal,
  filesystem: { mkdtemp(prefix: string): Promise<string>; rm: typeof rm } = { mkdtemp, rm },
  options: { gzipLevel?: number } = {},
): Promise<Uint8Array> {
  const { gzipLevel } = options
  if (gzipLevel !== undefined && (!Number.isInteger(gzipLevel) || gzipLevel < 0 || gzipLevel > 9))
    throw new Error('gzip level must be an integer from 0 to 9')
  const staging = await filesystem.mkdtemp(join(tmpdir(), 'autobuild-pack-staging-'))
  let destination: string | undefined
  let failure: unknown
  let failed = false
  let bytes!: Uint8Array
  let errors: unknown[] = []
  try {
    destination = await filesystem.mkdtemp(join(tmpdir(), 'autobuild-pack-'))
    // Pack from a staging copy of the repo's `files` set rather than the repo
    // root: the packed manifest must differ from the repo manifest (above), and
    // rewriting the repo manifest in place would leave a window where tracked
    // files are dirty.
    const manifestPath = join(root, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    const files = manifest.files
    if (!Array.isArray(files) || files.some((entry) => typeof entry !== 'string')) {
      throw new Error(
        'Autobuild packaging requires the root package.json to list its files as an array of paths',
      )
    }
    // npm `files` entries may be negated globs (for example
    // `!packages/core/src/**/*.test.ts`, which keeps test files out of the
    // published package). Only positive entries name a path to stage: the
    // negations stay in the staged manifest and `bun pm pack` applies them,
    // so the packed set still excludes those paths.
    await stageDistributionFiles(
      root,
      staging,
      (files as string[]).filter((entry) => !entry.startsWith('!')),
    )
    for (const field of packedManifestOmittedFields) delete manifest[field]
    await writeFile(join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await execOrThrow(
      [
        'bun',
        'pm',
        'pack',
        '--ignore-scripts',
        ...(gzipLevel === undefined ? [] : ['--gzip-level', String(gzipLevel)]),
        '--destination',
        destination,
      ],
      staging,
      exec,
      signal,
    )
    const archives = (await readdir(destination)).filter((name) => name.endsWith('.tgz'))
    if (archives.length !== 1)
      throw new Error('Autobuild packaging did not produce exactly one archive')
    bytes = new Uint8Array(await readFile(join(destination, archives[0]!)))
  } catch (error) {
    failed = true
    failure = error
  } finally {
    const results = await Promise.allSettled(
      [staging, destination]
        .filter((path): path is string => path !== undefined)
        .map((path) => filesystem.rm(path, { recursive: true, force: true })),
    )
    errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  }
  if (errors.length)
    throw new AggregateError(
      failed ? [failure, ...errors] : errors,
      'Distribution packaging cleanup failed',
      failed ? { cause: failure } : undefined,
    )
  if (failed) throw failure
  return bytes
}
