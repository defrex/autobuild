import type { BuildDigest } from './types'

/** A remote store server that predates `GET /repos/{repo}/open-builds`.
 * Callers surface it; they never fall back to listing every build. */
export class OpenBuildsCapabilityError extends Error {
  readonly capability = 'open-builds'
  constructor(readonly repo: string) {
    super(
      `the store server has no open-builds capability for ${repo}: upgrade the server; listing every build instead is not allowed`,
    )
    this.name = 'OpenBuildsCapabilityError'
  }
}

/** Whether a build with this digest terminal belongs to the open set: every
 * build whose latest terminal fact is not `build.completed`. */
export function openBuildMember(terminal: BuildDigest['terminal']): boolean {
  return terminal !== 'done'
}
