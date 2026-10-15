import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  fstatSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { normalizeServiceURL } from '../connection'
import { normalizeGitRemoteUrl } from '../kernel/origin'

export interface ProjectCredential {
  service: string
  repo: string
  id: string
  token: string
}
export class ProjectCredentials {
  readonly directory: string
  constructor(env: Record<string, string | undefined> = process.env) {
    const root = env.XDG_CONFIG_HOME
    if (root && !isAbsolute(root))
      throw new Error('XDG_CONFIG_HOME must be absolute for project credentials')
    this.directory = join(
      root ||
        (env.HOME && isAbsolute(env.HOME) ? join(env.HOME, '.config') : join(homedir(), '.config')),
      'autobuild',
      'credentials',
    )
  }
  private path(service: string, repo: string): string {
    return join(
      this.directory,
      `${createHash('sha256')
        .update(JSON.stringify([normalizeServiceURL(service), normalizeGitRemoteUrl(repo)]))
        .digest('hex')}.json`,
    )
  }
  private guard(path: string): boolean {
    try {
      const info = lstatSync(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe credential file')
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  load(service: string, repo: string): ProjectCredential | undefined {
    try {
      const path = this.path(service, repo)
      if (!this.guard(path)) return undefined
      const directory = lstatSync(this.directory)
      if (directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700) throw new Error()
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      let entry: ProjectCredential
      try {
        if ((fstatSync(fd).mode & 0o777) !== 0o600) throw new Error()
        entry = JSON.parse(readFileSync(fd, 'utf8'))
      } finally {
        closeSync(fd)
      }
      if (
        entry.service !== normalizeServiceURL(service) ||
        entry.repo !== normalizeGitRemoteUrl(repo) ||
        typeof entry.id !== 'string' ||
        typeof entry.token !== 'string' ||
        !/^[a-f0-9]{32}$/.test(entry.id) ||
        !new RegExp(`^abp_1_${entry.id}_[a-f0-9]{64}$`).test(entry.token)
      )
        throw new Error()
      return entry
    } catch {
      throw new Error(
        'Cannot read project credential; repair user credential storage and run ab connect',
      )
    }
  }
  save(entry: ProjectCredential): void {
    const path = this.path(entry.service, entry.repo)
    let temporary: string | undefined
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      if (lstatSync(this.directory).isSymbolicLink()) throw new Error()
      chmodSync(this.directory, 0o700)
      this.guard(path)
      temporary = `${path}.${randomUUID()}`
      const fd = openSync(temporary, 'wx', 0o600)
      try {
        writeFileSync(fd, `${JSON.stringify(entry)}\n`)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, path)
    } catch {
      throw new Error('Cannot save project credential; check user credential directory permissions')
    } finally {
      if (temporary) {
        try {
          unlinkSync(temporary)
        } catch {
          /* renamed or absent */
        }
      }
    }
  }
  remove(service: string, repo: string): void {
    const path = this.path(service, repo)
    if (this.guard(path)) unlinkSync(path)
  }
}
export function projectToken(
  service: string,
  repo: string,
  env: Record<string, string | undefined>,
): string | undefined {
  if (env.AB_TOKEN !== undefined && env.AB_TOKEN !== '') return env.AB_TOKEN
  try {
    normalizeServiceURL(service)
  } catch {
    return undefined
  }
  return new ProjectCredentials(env).load(service, repo)?.token
}
