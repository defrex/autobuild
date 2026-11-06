/**
 * The Git a hosted dispatcher deployment ships (see `ship-git.ts`), found and
 * unpacked at run time. The Vercel Function runtime has no `git`, so every
 * kernel Git command of a dispatch tick is routed to this tree instead of the
 * host `PATH`.
 *
 * The tree carries its own glibc and dynamic loader, and every staged
 * executable's program interpreter is baked to `<root>/ld`, where `root` is a
 * fixed `/tmp` path recorded in the manifest. The bundle directory itself is
 * read-only and lives elsewhere, so the tree is copied to `root` once per
 * function instance before it can run.
 *
 * Kernel shell pipelines (`sh -c '… | git …'`) reach the same Git through a
 * `git` launcher, `<root>/shim/git`, that is put on their `PATH`. The shell and
 * the other host programs it starts keep the host's own libraries; only the
 * launcher applies the tree's environment, to Git alone.
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmod, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { distributionRoot } from '@defrex/autobuild/distribution'
import type { Exec } from '@defrex/autobuild/git-worktree'

export const SHIPPED_GIT_DIRECTORY = '.autobuild-git'
export const SHIPPED_GIT_PLATFORM = 'linux-x64'
/** The tree directory holding only the `git` launcher for shells. */
export const SHIPPED_GIT_SHIM_DIRECTORY = 'shim'
const COMPLETE_MARKER = '.complete'
/** Tree-confinement keys a caller can never override; the rest of
 * `shippedGitEnv` is a default. */
const FORCED_KEYS = ['GIT_EXEC_PATH', 'LD_LIBRARY_PATH', 'GIT_TEMPLATE_DIR', 'PATH'] as const

/** `.autobuild-git/manifest.json`. Paths other than `root` are relative to the
 * tree. */
export interface ShippedGitManifest {
  schema: 1
  platform: typeof SHIPPED_GIT_PLATFORM
  gitVersion: string
  glibcVersion: string
  /** Oldest Linux kernel the bundled glibc supports, `major.minor.patch`. */
  minimumKernel: string
  /** Absolute directory the tree must be copied to before it runs; every
   * staged executable's interpreter is `<root>/ld`. */
  root: string
  git: string
  execPath: string
  lib: string
  caBundle: string
  templates?: string
  files: string[]
  executables: string[]
  bytes: number
}

export interface ShippedGit {
  /** The materialized tree (the manifest's `root`). */
  root: string
  manifest: ShippedGitManifest
}

export type LocateShippedGitResult = { ok: true; git: ShippedGit } | { ok: false; reason: string }

/** Parse a `major.minor.patch` version prefix (`6.1.0-amzn…` → [6, 1, 0]). */
function versionParts(value: string): number[] {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value)
  if (!match) return []
  return [match[1], match[2], match[3]].map((part) => Number(part ?? 0))
}

export function kernelAtLeast(running: string, minimum: string): boolean {
  const have = versionParts(running)
  const need = versionParts(minimum)
  if (have.length === 0 || need.length === 0) return false
  for (let index = 0; index < 3; index++) {
    if (have[index]! !== need[index]!) return have[index]! > need[index]!
  }
  return true
}

export function parseShippedGitManifest(raw: string): ShippedGitManifest {
  const value = JSON.parse(raw) as Partial<ShippedGitManifest>
  if (value.schema !== 1) throw new Error(`unsupported manifest schema ${String(value.schema)}`)
  for (const key of [
    'platform',
    'gitVersion',
    'glibcVersion',
    'minimumKernel',
    'root',
    'git',
    'execPath',
    'lib',
    'caBundle',
  ] as const)
    if (typeof value[key] !== 'string' || value[key] === '')
      throw new Error(`manifest is missing ${key}`)
  if (!Array.isArray(value.files) || !Array.isArray(value.executables))
    throw new Error('manifest is missing its file lists')
  return value as ShippedGitManifest
}

function manifestHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** Copy the staged tree at `source` to `manifest.root`, unless a complete
 * copy of the same manifest is already there. Concurrent callers race on a
 * private temporary copy and one `rename`; the loser keeps the winner's tree. */
export async function materializeShippedGit(
  source: string,
  manifest: ShippedGitManifest,
  raw: string,
): Promise<void> {
  const root = manifest.root
  const shim = shippedGitShim({ root, manifest })
  // The launcher is part of the tree's identity, so a tree an older
  // deployment unpacked without it reads as stale and is replaced.
  const hash = manifestHash(`${raw}\0${shim}`)
  const complete = async () => {
    try {
      return (await readFile(join(root, COMPLETE_MARKER), 'utf8')) === hash
    } catch {
      return false
    }
  }
  if (await complete()) return
  const temporary = `${root}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    await mkdir(dirname(root), { recursive: true })
    await rm(temporary, { recursive: true, force: true })
    await cp(source, temporary, { recursive: true, dereference: true })
    for (const file of manifest.executables) await chmod(join(temporary, file), 0o755)
    await mkdir(join(temporary, SHIPPED_GIT_SHIM_DIRECTORY), { recursive: true })
    await writeFile(join(temporary, SHIPPED_GIT_SHIM_DIRECTORY, 'git'), shim, { mode: 0o755 })
    await chmod(join(temporary, SHIPPED_GIT_SHIM_DIRECTORY, 'git'), 0o755)
    await writeFile(join(temporary, COMPLETE_MARKER), hash)
    try {
      await rename(temporary, root)
    } catch (error) {
      // Another instance won the rename. Its tree is good when complete; a
      // stale or partial one (a different deployment's crash) is replaced.
      if (await complete()) return
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
      await rm(root, { recursive: true, force: true })
      await rename(temporary, root)
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export interface LocateShippedGitOptions {
  /** Directories that may hold `.autobuild-git/`; the first one wins. */
  roots?: readonly string[]
  platform?: string
  arch?: string
  /** The running kernel release (`os.release()`). */
  kernel?: string
}

/** Find the deployment's shipped Git and make it runnable. Each failure names
 * its cause: no manifest, wrong platform, a kernel older than the bundled
 * glibc supports, or a `/tmp` that cannot hold the tree. */
export async function locateShippedGit(
  options: LocateShippedGitOptions = {},
): Promise<LocateShippedGitResult> {
  const roots = [...new Set(options.roots ?? [distributionRoot(), process.cwd()])]
  let found: { directory: string; raw: string } | undefined
  for (const root of roots) {
    const directory = join(root, SHIPPED_GIT_DIRECTORY)
    try {
      found = { directory, raw: await readFile(join(directory, 'manifest.json'), 'utf8') }
      break
    } catch {
      // Try the next root.
    }
  }
  if (!found)
    return {
      ok: false,
      reason: `no ${SHIPPED_GIT_DIRECTORY}/manifest.json under ${roots.join(', ')}`,
    }
  let manifest: ShippedGitManifest
  try {
    manifest = parseShippedGitManifest(found.raw)
  } catch (error) {
    return {
      ok: false,
      reason: `invalid ${found.directory}/manifest.json: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  if (`${platform}-${arch}` !== manifest.platform)
    return {
      ok: false,
      reason: `shipped Git targets ${manifest.platform}, but this runtime is ${platform}-${arch}`,
    }
  const kernel = options.kernel ?? release()
  if (!kernelAtLeast(kernel, manifest.minimumKernel))
    return {
      ok: false,
      reason: `shipped Git needs Linux ${manifest.minimumKernel} or newer, but this runtime is ${kernel}`,
    }
  try {
    await materializeShippedGit(found.directory, manifest, found.raw)
    await stat(join(manifest.root, manifest.git))
  } catch (error) {
    return {
      ok: false,
      reason: `could not unpack shipped Git to ${manifest.root} (is /tmp writable?): ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return { ok: true, git: { root: manifest.root, manifest } }
}

let memo: Promise<LocateShippedGitResult> | undefined
/** `locateShippedGit` once per process; a failure is retried next time. */
export function locateShippedGitOnce(): Promise<LocateShippedGitResult> {
  memo ??= locateShippedGit()
  const attempt = memo
  void attempt.then((result) => {
    if (!result.ok && memo === attempt) memo = undefined
  })
  return attempt
}

/** The environment that runs the shipped Git and confines it to its own tree:
 * its libraries, its helpers, its CA bundle, no system or global config, and
 * HTTPS as the only transport, so it never starts a host program (a shell,
 * ssh, a credential helper) under the bundled glibc. */
export function shippedGitEnv(
  git: ShippedGit,
  inherited: { PATH?: string } = {},
): Record<string, string> {
  const { root, manifest } = git
  return {
    GIT_EXEC_PATH: join(root, manifest.execPath),
    LD_LIBRARY_PATH: join(root, manifest.lib),
    GIT_SSL_CAINFO: join(root, manifest.caBundle),
    ...(manifest.templates !== undefined
      ? { GIT_TEMPLATE_DIR: join(root, manifest.templates) }
      : {}),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ALLOW_PROTOCOL: 'https',
    PATH: [join(root, dirname(manifest.git)), inherited.PATH]
      .filter((entry) => entry !== undefined && entry !== '')
      .join(':'),
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** The `<root>/shim/git` launcher: it applies `shippedGitEnv` (without `PATH`)
 * to Git alone and runs the shipped binary. Forced keys are assigned; the
 * others keep a caller's value, as they do for direct `git`. */
export function shippedGitShim(git: ShippedGit): string {
  const forced = new Set<string>(FORCED_KEYS)
  const lines = ['#!/bin/sh']
  for (const [key, value] of Object.entries(shippedGitEnv(git))) {
    if (key === 'PATH') continue
    lines.push(
      forced.has(key)
        ? `export ${key}=${shellQuote(value)}`
        : `[ -n "\${${key}+set}" ] || ${key}=${shellQuote(value)}; export ${key}`,
    )
  }
  lines.push(`exec ${shellQuote(join(git.root, git.manifest.git))} "$@"`, '')
  return lines.join('\n')
}

/** Route `git` commands to the shipped Git. Everything else (the `gh` probe, a
 * kernel `sh -c` pipeline) runs on the host's own libraries, with the tree's
 * `shim/` first on `PATH` so a `git` it starts is the shipped one. Caller-provided
 * `GIT_SSL_CAINFO` and `GIT_ALLOW_PROTOCOL` win; the library path, exec path and
 * config isolation always come from the tree. `kernelExec`'s `GIT_CONFIG_*`
 * keys pass through. */
export function shippedGitExec(base: Exec, git: ShippedGit, inherited: { PATH?: string }): Exec {
  const env = shippedGitEnv(git, inherited)
  const shim = join(git.root, SHIPPED_GIT_SHIM_DIRECTORY)
  return (cmd, opts) => {
    if (cmd[0] !== 'git') {
      const path = [shim, opts.env?.PATH ?? inherited.PATH]
        .filter((entry) => entry !== undefined && entry !== '')
        .join(':')
      return base(cmd, { ...opts, env: { ...opts.env, PATH: path } })
    }
    const merged: Record<string, string | undefined> = { ...env, ...opts.env }
    for (const key of FORCED_KEYS) if (env[key] !== undefined) merged[key] = env[key]
    return base([join(git.root, git.manifest.git), ...cmd.slice(1)], { ...opts, env: merged })
  }
}
