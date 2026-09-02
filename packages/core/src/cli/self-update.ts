import semver from 'semver'
import type { ExecResult } from '../ports/workspace/git-worktree'
import { defaultDistRoot } from './init'
import { addUpgradeSelfUpdatePaths, UPGRADE_COMMIT_CONTEXT_ENV } from './upgrade-commit'
import {
  inspectInstallation,
  readDistributionIdentity,
  type BunForgeInstallation,
  type DistributionIdentity,
} from './installation'

export const SELF_UPDATE_HANDOFF_ENV = 'AB_SELF_UPDATE_HANDOFF'

export interface SelfUpdateCommandOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  signal?: AbortSignal
}

export type SelfUpdateCommand = (
  command: string[],
  options: SelfUpdateCommandOptions,
) => Promise<ExecResult>

export type SelfUpdateResult =
  | { kind: 'continue' }
  | { kind: 'handoff'; exitCode: number }
  | { kind: 'failed' }

export interface SelfUpdateOptions {
  targetRepo: string
  version?: string
  distRoot?: string
  env?: Record<string, string | undefined>
  stdout: (line: string) => void
  stderr: (line: string) => void
  command?: SelfUpdateCommand
  /** Baseline captured before this function may rewrite a local owner project. */
  upgradeCommitContextPath?: string
  /** Forward the operator's commit opt-out to the replacement binary. */
  noCommit?: boolean
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false
}

const processCommand: SelfUpdateCommand = async (command, options) => {
  if (signalAborted(options.signal)) throw new Error('command aborted')
  const proc = Bun.spawn(command, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const abort = (): void => {
    try {
      proc.kill()
    } catch {
      // The process may have exited between the abort and this callback.
    }
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  // Abort may have raced the spawn/listener boundary.
  if (signalAborted(options.signal)) abort()
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exitCode }
  } finally {
    options.signal?.removeEventListener('abort', abort)
  }
}

function commandFailure(label: string, result: ExecResult): string {
  return `${label} failed (exit ${result.exitCode}): ${
    result.stderr.trim() || result.stdout.trim() || '(no output)'
  }`
}

export function releaseVersion(response: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(response)
  } catch (error) {
    throw new Error(
      `GitHub returned invalid release JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const tag =
    typeof parsed === 'object' && parsed !== null && 'tag_name' in parsed
      ? (parsed as { tag_name?: unknown }).tag_name
      : undefined
  if (typeof tag !== 'string' || !tag.startsWith('v')) {
    throw new Error('GitHub release has no v<semver> tag_name')
  }
  const version = tag.slice(1)
  if (semver.valid(version) !== version) {
    throw new Error(`GitHub release tag is not v<semver>: ${tag}`)
  }
  return version
}

function releaseApiPath(
  installation: Pick<BunForgeInstallation, 'owner' | 'repository'>,
  version?: string,
): string {
  return version === undefined
    ? `repos/${installation.owner}/${installation.repository}/releases/latest`
    : `repos/${installation.owner}/${installation.repository}/releases/tags/v${version}`
}

function exactRequestedVersion(value: string): string {
  if (semver.valid(value) !== value) {
    throw new Error(`--version must be an exact semver version: ${value}`)
  }
  return value
}

function warn(options: SelfUpdateOptions, reason: string): SelfUpdateResult {
  options.stderr(`self-update skipped: ${reason}; merging skills with the installed distribution`)
  return { kind: 'continue' }
}

function fail(options: SelfUpdateOptions, reason: string): SelfUpdateResult {
  options.stderr(`self-update failed: ${reason}`)
  return { kind: 'failed' }
}

function forward(output: string, sink: (line: string) => void): void {
  const text = output.replace(/\n$/, '')
  if (text !== '') sink(text)
}

export interface AvailableReleaseOptions {
  distRoot?: string
  signal?: AbortSignal
  command?: SelfUpdateCommand
}

/** Silently determine whether this installation has a newer published release.
 * This read-only courtesy intentionally collapses every unsupported install,
 * command failure, malformed response, and cancellation to no result. */
export async function availableRelease(
  options: AvailableReleaseOptions = {},
): Promise<string | undefined> {
  const command = options.command ?? processCommand
  try {
    if (signalAborted(options.signal)) return undefined
    const distRoot = options.distRoot ?? defaultDistRoot()
    const identity = await readDistributionIdentity(distRoot)
    if (identity.sourceCheckout || signalAborted(options.signal)) return undefined

    const globalBin = await command(['bun', 'pm', 'bin', '-g'], { signal: options.signal })
    if (
      globalBin.exitCode !== 0 ||
      globalBin.stdout.trim() === '' ||
      signalAborted(options.signal)
    ) {
      return undefined
    }

    const inspection = await inspectInstallation({
      distRoot,
      globalBin: globalBin.stdout.trim(),
    })
    if (inspection.kind !== 'bun-forge' || signalAborted(options.signal)) return undefined
    const install = inspection.installation
    const release = await command(['gh', 'api', releaseApiPath(install)], {
      signal: options.signal,
    })
    if (release.exitCode !== 0 || signalAborted(options.signal)) return undefined
    const published = releaseVersion(release.stdout)
    return semver.gt(published, install.version) ? published : undefined
  } catch {
    return undefined
  }
}

/** Update the running Bun forge distribution, or explicitly decide that the
 * caller may continue with the current one. A successful install has exactly
 * one legal continuation: a fresh process from the replaced distribution. */
export async function selfUpdate(options: SelfUpdateOptions): Promise<SelfUpdateResult> {
  const command = options.command ?? processCommand
  const invoke: SelfUpdateCommand = async (argv, commandOptions) => {
    try {
      return await command(argv, commandOptions)
    } catch (error) {
      return {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 127,
      }
    }
  }
  const distRoot = options.distRoot ?? defaultDistRoot()
  const explicit = options.version !== undefined
  let requested: string | undefined
  try {
    requested = options.version === undefined ? undefined : exactRequestedVersion(options.version)
  } catch (error) {
    options.stderr(error instanceof Error ? error.message : String(error))
    return { kind: 'failed' }
  }

  let identity: DistributionIdentity
  try {
    identity = await readDistributionIdentity(distRoot)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (explicit) {
      options.stderr(`self-update failed: ${reason}`)
      return { kind: 'failed' }
    }
    return warn(options, reason)
  }
  if (identity.sourceCheckout) {
    return warn(options, 'running from a source checkout (.git is present)')
  }

  const globalBinResult = await invoke(['bun', 'pm', 'bin', '-g'], {})
  if (globalBinResult.exitCode !== 0 || globalBinResult.stdout.trim() === '') {
    const reason = commandFailure('determining Bun global installation', globalBinResult)
    return explicit ? fail(options, reason) : warn(options, reason)
  }

  const inspection = await inspectInstallation({
    distRoot,
    globalBin: globalBinResult.stdout.trim(),
  })
  if (inspection.kind !== 'bun-forge') {
    return explicit ? fail(options, inspection.reason) : warn(options, inspection.reason)
  }
  const install = inspection.installation

  const apiPath = releaseApiPath(install, requested)
  const release = await invoke(['gh', 'api', apiPath], {})
  if (release.exitCode !== 0) {
    const reason = commandFailure(
      `resolving ${requested === undefined ? 'latest' : `v${requested}`} release`,
      release,
    )
    if (explicit) {
      options.stderr(`self-update failed: ${reason}`)
      return { kind: 'failed' }
    }
    return warn(options, reason)
  }

  let resolved: string
  try {
    resolved = releaseVersion(release.stdout)
    if (requested !== undefined && resolved !== requested) {
      throw new Error(`GitHub returned v${resolved} for requested release v${requested}`)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (explicit) {
      options.stderr(`self-update failed: ${reason}`)
      return { kind: 'failed' }
    }
    return warn(options, reason)
  }

  if (resolved === install.version || (!explicit && semver.gte(install.version, resolved))) {
    options.stdout(
      resolved === install.version
        ? `Autobuild ${install.version} is already installed.`
        : `Autobuild ${install.version} is newer than the latest release v${resolved}; keeping it.`,
    )
    return { kind: 'continue' }
  }

  const dependency = `github:${install.owner}/${install.repository}#v${resolved}`
  let updateCommand: string[]
  if (install.scope === 'global') {
    options.stdout(`Updating Autobuild's global Bun installation to v${resolved}.`)
    updateCommand = ['bun', 'add', '--global', dependency]
  } else {
    options.stdout(
      `Updating Autobuild to v${resolved} in ${install.ownerRoot}; Bun will rewrite ${install.ownerManifest} and ${install.ownerLock}.`,
    )
    updateCommand = ['bun', 'add', '--cwd', install.ownerRoot, dependency]
  }

  const update = await invoke(updateCommand, {})
  if (update.exitCode !== 0) {
    const reason = commandFailure(`installing v${resolved}`, update)
    if (explicit) {
      options.stderr(`self-update failed: ${reason}`)
      return { kind: 'failed' }
    }
    return warn(options, reason)
  }

  let updated: DistributionIdentity
  try {
    updated = await readDistributionIdentity(distRoot)
    // Injected command fixtures do not rewrite disk; a real successful Bun
    // operation must. Keep the check injectable by accepting the old identity
    // only when the command seam itself was supplied.
    if (options.command === undefined && updated.version !== resolved) {
      throw new Error(
        `Bun reported success but the installed package is ${updated.version}, expected ${resolved}`,
      )
    }
  } catch (error) {
    options.stderr(
      `self-update failed after installation: ${error instanceof Error ? error.message : String(error)}`,
    )
    return { kind: 'failed' }
  }

  let handoffCommitContextPath = options.upgradeCommitContextPath
  let handoffNoCommit = options.noCommit === true
  if (install.scope === 'global') {
    options.stdout(`Installed Autobuild v${resolved} in Bun's global package-manager scope.`)
  } else {
    options.stdout(
      `Installed Autobuild v${resolved}; Bun updated ${install.ownerManifest} and ${install.ownerLock}.`,
    )
    if (options.upgradeCommitContextPath !== undefined) {
      try {
        await addUpgradeSelfUpdatePaths(options.upgradeCommitContextPath, [
          install.ownerManifest,
          install.ownerLock,
        ])
      } catch (error) {
        options.stderr(
          `ab upgrade did not commit: could not preserve the pre-update Git baseline for handoff: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        handoffCommitContextPath = undefined
        handoffNoCommit = true
      }
    }
  }

  const childArgs = ['bun', updated.binaryPath, 'upgrade', options.targetRepo]
  if (handoffNoCommit) childArgs.push('--no-commit')
  const child = await invoke(childArgs, {
    env: {
      ...options.env,
      [SELF_UPDATE_HANDOFF_ENV]: '1',
      ...(handoffCommitContextPath === undefined
        ? {}
        : { [UPGRADE_COMMIT_CONTEXT_ENV]: handoffCommitContextPath }),
    },
  })
  forward(child.stdout, options.stdout)
  forward(child.stderr, options.stderr)
  return { kind: 'handoff', exitCode: child.exitCode }
}
