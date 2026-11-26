import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

async function spawnExec(
  cmd: string[],
  options: { cwd: string; signal?: AbortSignal; env?: Record<string, string | undefined> },
) {
  const child = Bun.spawn(cmd, {
    cwd: options.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    signal: options.signal,
    ...(options.env ? { env: options.env } : {}),
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

/** Stages the manifest's positive `files` entries and the packed manifest
 * into `staging`, returning that manifest. Shared by the real pack and the
 * archive-free selection so both see one staging tree. */
async function stageDistribution(root: string, staging: string): Promise<Record<string, unknown>> {
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
  for (const entry of files as string[]) {
    // npm `files` entries may be negated globs (for example
    // `!packages/core/src/**/*.test.ts`, which keeps test files out of the
    // published package). Only positive entries name a path to stage: the
    // negations stay in the staged manifest and `bun pm pack` applies them,
    // so the packed set still excludes those paths.
    if (entry.startsWith('!')) continue
    const target = join(staging, entry)
    await mkdir(dirname(target), { recursive: true })
    await cp(join(root, entry), target, {
      recursive: true,
      errorOnExist: true,
      force: false,
    })
  }
  for (const field of packedManifestOmittedFields) delete manifest[field]
  await writeFile(join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
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
    await stageDistribution(root, staging)
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

const packedLine = /^packed \d+(?:\.\d+)?[KMGT]?B (.+)$/

/** Strictly parses `bun pm pack --dry-run` output (Bun 1.4: a banner, one
 * `packed <size> <path>` line per selected file, the archive name, then the
 * `Total files: N` and `Unpacked size` trailer). Any line or path it does not
 * recognize yields `undefined` so the caller packs a real archive instead of
 * trusting an incomplete listing. */
export function parsePackDryRun(stdout: string): string[] | undefined {
  const files: string[] = []
  const seen = new Set<string>()
  let total: number | undefined
  let phase: 'head' | 'files' | 'tail' = 'head'
  for (const line of stdout.split('\n')) {
    const packed = packedLine.exec(line)
    if (packed) {
      if (phase === 'tail') return undefined
      phase = 'files'
      const path = packed[1]!
      const segments = path.split('/')
      if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
        return undefined
      if (seen.has(path)) return undefined
      seen.add(path)
      files.push(path)
      continue
    }
    if (line === '') continue
    if (phase === 'head') {
      if (!line.startsWith('bun pack ')) return undefined
      continue
    }
    phase = 'tail'
    const count = /^Total files: (\d+)$/.exec(line)
    if (count) {
      if (total !== undefined) return undefined
      total = Number(count[1])
    } else if (
      !/^Unpacked size: \S+$/.test(line) &&
      !(line.endsWith('.tgz') && total === undefined)
    )
      return undefined
  }
  if (!files.length || total !== files.length || !seen.has('package.json')) return undefined
  return files
}

export interface DistributionSelection {
  /** The staging tree `bun pm pack` would archive. */
  staging: string
  /** Staging-relative paths of every file the pack selects. */
  files: string[]
  /** The staged (packed) manifest. */
  manifest: Record<string, unknown>
  /** `lstat` mode of each selected file in staging. */
  modes: Map<string, number>
}

const probeNames = ['.autobuild-mode-probe-directory', '.autobuild-mode-probe-file']

/** Selection environment: color would decorate the listing past the parser. */
function listingEnvironment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1' }
  delete env.FORCE_COLOR
  return env
}

/** Hands `use` the exact file set a real `bun pm pack` of `root` archives,
 * from the same staging tree, without writing an archive. Returns `undefined`
 * (the caller packs for real) wherever staged files could differ from what an
 * archive would carry, as observed on Bun 1.4.5:
 * - bundled dependencies and `workspace:`/`catalog:` specifiers, which Bun
 *   rewrites or augments (staging cannot resolve them, so the real pack fails
 *   on them and must keep failing the same way);
 * - a dry run that fails or prints a listing `parsePackDryRun` refuses;
 * - a listed path that is not a regular file under real staging directories
 *   (Bun drops symlinks and emits no directory entries);
 * - a creation mask that strips an execute bit from new files or directories,
 *   because extraction modes would then differ from staged modes.
 * Bun's other selection rules (nested ignore files, default exclusions) are
 * applied by the dry run itself. Staging failures throw exactly as
 * `packageDistribution` does. */
export async function withDistributionSelection<T>(
  root: string,
  use: (selection: DistributionSelection) => Promise<T>,
  exec: PackagingExec = spawnExec,
  signal?: AbortSignal,
  filesystem: { mkdtemp(prefix: string): Promise<string>; rm: typeof rm } = { mkdtemp, rm },
): Promise<T | undefined> {
  const staging = await filesystem.mkdtemp(join(tmpdir(), 'autobuild-pack-staging-'))
  let failure: unknown
  let failed = false
  let value: T | undefined
  let errors: unknown[] = []
  try {
    value = await (async () => {
      const manifest = await stageDistribution(root, staging)
      if (!rewriteFree(manifest)) return undefined
      const result = await exec(['bun', 'pm', 'pack', '--ignore-scripts', '--dry-run'], {
        cwd: staging,
        signal,
        env: listingEnvironment(),
      })
      if (result.exitCode !== 0) {
        signal?.throwIfAborted()
        return undefined
      }
      const files = parsePackDryRun(result.stdout)
      if (!files) return undefined
      const modes = new Map<string, number>()
      const directories = new Set<string>()
      for (const file of files) {
        const stat = await lstat(join(staging, file)).catch(() => undefined)
        if (!stat?.isFile()) return undefined
        modes.set(file, stat.mode)
        for (let at = file.indexOf('/'); at !== -1; at = file.indexOf('/', at + 1))
          directories.add(file.slice(0, at))
      }
      for (const directory of directories)
        if (!(await lstat(join(staging, directory))).isDirectory()) return undefined
      if (!(await creationKeepsExecute(staging, files))) return undefined
      return await use({ staging, files, manifest, modes })
    })()
  } catch (error) {
    failed = true
    failure = error
  } finally {
    const results = await Promise.allSettled([
      filesystem.rm(staging, { recursive: true, force: true }),
    ])
    errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  }
  if (errors.length)
    throw new AggregateError(
      failed ? [failure, ...errors] : errors,
      'Distribution packaging cleanup failed',
      failed ? { cause: failure } : undefined,
    )
  if (failed) throw failure
  return value
}

function rewriteFree(manifest: Record<string, unknown>): boolean {
  if (
    Object.hasOwn(manifest, 'bundleDependencies') ||
    Object.hasOwn(manifest, 'bundledDependencies')
  )
    return false
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const declared = manifest[section]
    if (declared === undefined) continue
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return false
    for (const specifier of Object.values(declared))
      if (
        typeof specifier !== 'string' ||
        specifier.startsWith('workspace:') ||
        specifier.startsWith('catalog:')
      )
        return false
  }
  return true
}

/** True when new files and directories in staging keep every execute bit,
 * so a non-root `tar -x` (which applies the creation mask) and a root one
 * (which keeps archive modes) both reproduce staged execute bits, and implied
 * directories carry `0o111`. Reads the effect, never `process.umask()`,
 * which would briefly change the mask under concurrent file creation. */
async function creationKeepsExecute(staging: string, files: string[]): Promise<boolean> {
  if (files.some((file) => probeNames.includes(file.split('/')[0]!))) return false
  const [directory, file] = probeNames.map((name) => join(staging, name)) as [string, string]
  try {
    await mkdir(directory, { mode: 0o777 })
    await writeFile(file, '', { mode: 0o777, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  return (
    ((await lstat(directory)).mode & 0o111) === 0o111 &&
    ((await lstat(file)).mode & 0o111) === 0o111
  )
}
