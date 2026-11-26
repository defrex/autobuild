import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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

function packedFiles(manifest: Record<string, unknown>): string[] {
  const files = manifest.files
  if (!Array.isArray(files) || files.some((entry) => typeof entry !== 'string')) {
    throw new Error(
      'Autobuild packaging requires the root package.json to list its files as an array of paths',
    )
  }
  return files as string[]
}

/** Packs `root`'s `files` set with `bun pm pack`. `options.gzipLevel` (an
 * integer 0–9) sets the archive's deflate effort; omitted, Bun's default
 * applies and the command is unchanged. The level changes compressed bytes
 * only, never the extracted contents.
 *
 * `options.ownedSnapshot` declares `root` a private, caller-owned snapshot
 * whose manifest is already in packed form: nothing else writes to it during
 * the pack, and it declares none of `packedManifestOmittedFields`. Such a root
 * is packed in place, with no staging copy, and the packer never writes inside
 * it. A manifest that still declares an omitted field is refused rather than
 * rewritten, so a strip list that drifts from the caller's normalization fails
 * loudly instead of shipping the field. Without the option, `root` may be a
 * live source tree and is packed from an isolated staging copy. */
export async function packageDistribution(
  root: string,
  exec: PackagingExec = spawnExec,
  signal?: AbortSignal,
  filesystem: { mkdtemp(prefix: string): Promise<string>; rm: typeof rm } = { mkdtemp, rm },
  options: { gzipLevel?: number; ownedSnapshot?: boolean } = {},
): Promise<Uint8Array> {
  const { gzipLevel } = options
  if (gzipLevel !== undefined && (!Number.isInteger(gzipLevel) || gzipLevel < 0 || gzipLevel > 9))
    throw new Error('gzip level must be an integer from 0 to 9')
  if (options.ownedSnapshot) {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >
    packedFiles(manifest)
    for (const field of packedManifestOmittedFields)
      if (field in manifest)
        throw new Error(
          `owned snapshot manifest declares ${field}; normalize it before packing in place`,
        )
  }
  const staging = options.ownedSnapshot
    ? undefined
    : await filesystem.mkdtemp(join(tmpdir(), 'autobuild-pack-staging-'))
  let destination: string | undefined
  let failure: unknown
  let failed = false
  let bytes!: Uint8Array
  let errors: unknown[] = []
  try {
    destination = await filesystem.mkdtemp(join(tmpdir(), 'autobuild-pack-'))
    if (staging !== undefined) {
      // Pack from a staging copy of the repo's `files` set rather than the
      // repo root: the packed manifest must differ from the repo manifest
      // (above), and rewriting the repo manifest in place would leave a window
      // where tracked files are dirty. An owned snapshot skips this copy.
      const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<
        string,
        unknown
      >
      for (const entry of packedFiles(manifest)) {
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
    }
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
      staging ?? root,
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
