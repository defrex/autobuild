import { isValidGitBranchName } from '../kernel/origin'
import { createHash, randomUUID } from 'node:crypto'
import { readDistributionIdentity } from './installation'
import { lockDependency, lockPackageRecord, githubDependency } from './installation'
import semver from 'semver'
import type { Forge } from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'

export const TARGET_CHECK_INTERVAL_MS = 60_000
export type UpgradeTarget = {
  mode: 'pinned' | 'installed'
  key: string
  version?: string
  source: string
  base?: string
  sha?: string
  dependency?: string
  record?: unknown[]
  installRoot?: string
}
export class TargetResolutionError extends Error {
  constructor(
    public readonly target: UpgradeTarget,
    message: string,
  ) {
    super(message)
  }
}
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** Both blobs come from one authoritative commit. No checkout or tracking-ref fallback. */
export async function resolveUpgradeTarget(input: {
  checkout: string
  base: string
  originalInstall: string
  forge: Forge
  exec: Exec
  signal?: AbortSignal
}): Promise<UpgradeTarget> {
  let target: UpgradeTarget = {
    mode: 'pinned',
    key: fingerprint([input.base]),
    source: input.base,
    base: input.base,
  }
  const exec = input.forge.kernelExec ?? input.exec
  const destinationRef = `refs/autobuild/upgrade/${randomUUID()}`
  try {
    if (!isValidGitBranchName(input.base)) throw new Error('invalid upgrade base branch')
    let sha: string
    if (input.forge.snapshotBase) {
      sha = await input.forge.snapshotBase({
        workspacePath: input.checkout,
        base: input.base,
        destinationRef,
      })
    } else {
      if (!input.forge.kernelExec)
        throw new Error('forge has no authoritative base snapshot transport')
      const fetch = await exec(
        [
          'git',
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          '--refmap=',
          'origin',
          `+refs/heads/${input.base}:${destinationRef}`,
        ],
        { cwd: input.checkout, signal: input.signal },
      )
      if (fetch.exitCode !== 0) throw new Error('authoritative base fetch failed')
      const tip = await exec(['git', 'rev-parse', '--verify', `${destinationRef}^{commit}`], {
        cwd: input.checkout,
        signal: input.signal,
      })
      if (tip.exitCode !== 0) throw new Error('authoritative base commit unavailable')
      sha = tip.stdout.trim()
    }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))
      throw new Error('invalid authoritative base commit')
    target = { ...target, sha }
    const blob = async (name: string, optional = false) => {
      const result = await exec(['git', 'show', `${sha}:${name}`], { cwd: input.checkout })
      if (result.exitCode === 0) return result.stdout
      if (optional) {
        const tree = await exec(['git', 'ls-tree', sha, '--', name], { cwd: input.checkout })
        if (tree.exitCode === 0 && tree.stdout.trim() === '') return undefined
      }
      throw new Error(`cannot read authoritative ${name}`)
    }
    const manifestText = await blob('package.json', true)
    target.key = fingerprint([input.base, manifestText])
    const manifest = manifestText === undefined ? {} : object(JSON.parse(manifestText))
    const name = '@defrex/autobuild'
    const declarations = (['dependencies', 'devDependencies'] as const).flatMap((section) => {
      const value = object(manifest[section])[name]
      return value === undefined ? [] : [{ section, value }]
    })
    if (!declarations.length) {
      target = {
        mode: 'installed',
        source: input.originalInstall,
        installRoot: input.originalInstall,
        key: fingerprint(input.originalInstall),
      }
      const installed = await readDistributionIdentity(input.originalInstall)
      // Source mode deliberately remains a fixed snapshot in this increment.
      target.version = installed.version
      target.key = fingerprint([target.source, installed.version, installed.commit])
      return target
    }
    const lockText = await blob('bun.lock')
    target.key = fingerprint([input.base, manifestText, lockText])
    const lock = object(Bun.JSONC.parse(lockText!))
    for (const { section, value } of declarations) {
      if (typeof value !== 'string')
        throw new Error('conflicting Autobuild dependency declarations')
      if (lockDependency(lock, name, section) !== value)
        throw new Error('authoritative manifest and Bun lock dependency disagree')
    }
    const dependency = declarations[0]!.value as string
    const record = lockPackageRecord(lock, name)
    if (!record || typeof record[0] !== 'string')
      throw new Error('missing locked Autobuild package')
    target = { ...target, dependency, record, key: fingerprint(['pinned', declarations, record]) }
    const prefix = `${name}@`
    if (!record[0].startsWith(prefix)) throw new Error('invalid locked Autobuild package')
    const locked = record[0].slice(prefix.length)
    const forge = githubDependency(dependency)
    if (forge) {
      if (
        declarations.some(({ value }) => {
          const other = githubDependency(value)
          return !other || other.owner !== forge.owner || other.repository !== forge.repository
        })
      )
        throw new Error('conflicting Autobuild forge declarations')
      if (!new RegExp(`^github:${forge.owner}/${forge.repository}#[a-f0-9]{7,40}$`).test(locked))
        throw new Error('invalid locked Autobuild forge commit')
      return target
    }
    if (
      typeof record[1] !== 'string' ||
      semver.valid(locked) !== locked ||
      declarations.some(
        ({ value }) => typeof value !== 'string' || !semver.satisfies(locked, value),
      )
    )
      throw new Error('unsupported Autobuild dependency or manifest/lock version mismatch')
    target.version = locked
    return target
  } catch (error) {
    throw new TargetResolutionError(target, error instanceof Error ? error.message : String(error))
  } finally {
    await exec(['git', 'update-ref', '-d', destinationRef], { cwd: input.checkout }).catch(() => {})
  }
}
