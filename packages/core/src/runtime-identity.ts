import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { RuntimeIdentity } from './events/runtime'
import { execFileSync } from 'node:child_process'
import { distributionRoot } from './distribution'
import { AUTOBUILD_VERSION } from './store/remote/version'

/** Capture the distribution's source identity, never the target checkout. */
export function captureRuntimeIdentity(root = distributionRoot()) {
  let commit = 'unknown'
  let version = AUTOBUILD_VERSION
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    if (typeof manifest.version === 'string') version = manifest.version
  } catch {}
  let location = resolve(root)
  try {
    location = realpathSync(location)
  } catch {}
  let kind: 'source' | 'package' = 'package'
  try {
    const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (realpathSync(top) !== realpathSync(root)) throw new Error('not distribution Git metadata')
    kind = 'source'
    commit =
      execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || 'unknown'
  } catch {
    // npm records the source commit in published manifests when available.
    try {
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      if (
        typeof manifest.gitHead === 'string' &&
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.gitHead)
      )
        commit = manifest.gitHead
    } catch {
      /* Identity is diagnostic and must never block dispatch. */
    }
  }
  return Object.freeze({
    version,
    commit,
    source: Object.freeze({ kind, location }),
  }) satisfies RuntimeIdentity
}
export const RUNTIME_IDENTITY = captureRuntimeIdentity()
export function formatDispatcherError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `${message}; autobuild=${RUNTIME_IDENTITY.version}; commit=${RUNTIME_IDENTITY.commit}`
}
