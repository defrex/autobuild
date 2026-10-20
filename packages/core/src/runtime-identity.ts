import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { distributionRoot } from './distribution'
import { AUTOBUILD_VERSION } from './store/remote/version'

/** Capture the distribution's source identity, never the target checkout. */
export function captureRuntimeIdentity(root = distributionRoot()) {
  let commit = 'unknown'
  try {
    const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (realpathSync(top) !== realpathSync(root)) throw new Error('not distribution Git metadata')
    commit =
      execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || 'unknown'
  } catch {
    // npm records the source commit in published manifests when available.
    try {
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      if (typeof manifest.gitHead === 'string' && /^[a-f0-9]{40,64}$/.test(manifest.gitHead))
        commit = manifest.gitHead
    } catch {
      /* Identity is diagnostic and must never block dispatch. */
    }
  }
  return Object.freeze({ version: AUTOBUILD_VERSION, commit })
}
export const RUNTIME_IDENTITY = captureRuntimeIdentity()
export function formatDispatcherError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `${message}; autobuild=${RUNTIME_IDENTITY.version}; commit=${RUNTIME_IDENTITY.commit}`
}
