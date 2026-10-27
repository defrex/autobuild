import { Database } from 'bun:sqlite'
import { sensitiveAccountValues } from './sensitive'
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Account } from '../config/accounts'
import { chatgptStateSchema, credentialValues, type ChatGPTState } from './chatgpt-state'

export interface LocalCredential {
  version: 1
  generation: string
  descriptor: Account
  state: ChatGPTState
  status: 'ready' | 'refreshing' | 'failed'
  owner?: string
}
const error = () =>
  new Error('ChatGPT credential storage unavailable; check permissions and sign in again')
/** Shared main-checkout state. All operations fail closed on unsafe existing files. */
export class LocalCredentials {
  readonly directory: string
  readonly sensitive = new Set<string>()
  constructor(stateRoot: string) {
    this.directory = join(stateRoot, 'accounts')
  }
  private prepare() {
    mkdirSync(dirname(this.directory), { recursive: true, mode: 0o700 })
    const parent = lstatSync(dirname(this.directory))
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.())
      throw error()
    mkdirSync(this.directory, { mode: 0o700, recursive: true })
    const info = lstatSync(this.directory)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o777) !== 0o700 ||
      info.uid !== process.getuid?.()
    )
      throw error()
  }
  private path(name: string) {
    return join(this.directory, `${Buffer.from(name).toString('hex')}.json`)
  }
  private read<T>(path: string): T | undefined {
    this.prepare()
    let fd: number
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error()
    }
    try {
      const info = fstatSync(fd)
      if (
        !info.isFile() ||
        (info.mode & 0o777) !== 0o600 ||
        info.uid !== process.getuid?.() ||
        info.size > 300000
      )
        throw error()
      return JSON.parse(readFileSync(fd, 'utf8')) as T
    } catch {
      throw error()
    } finally {
      closeSync(fd)
    }
  }
  private write(path: string, value: unknown) {
    this.prepare()
    this.read(path)
    const temporary = `${path}.${randomUUID()}`
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify(value))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      renameSync(temporary, path)
    } finally {
      try {
        unlinkSync(temporary)
      } catch {
        /* moved */
      }
    }
    const directory = openSync(this.directory, constants.O_RDONLY)
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  }
  /** SQLite's filesystem lock is released by the OS on process death.
   * Only locking lives here; the protected atomic records remain authoritative. */
  locked<T>(_name: string, operation: () => T): T {
    this.prepare()
    const path = join(this.directory, 'locks.sqlite')
    try {
      const fd = openSync(path, 'wx', 0o600)
      closeSync(fd)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw error()
    }
    const info = lstatSync(path)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o777) !== 0o600 ||
      info.uid !== process.getuid?.()
    )
      throw error()
    const db = new Database(path)
    try {
      db.exec('PRAGMA busy_timeout=1000')
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = operation()
        db.exec('COMMIT')
        return result
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    } finally {
      db.close()
    }
  }
  hostId(): string {
    return this.locked('__host', () => {
      const path = join(this.directory, 'host.json')
      const old = this.read<{ id: string }>(path)
      if (old) {
        if (!/^urn:uuid:[0-9a-f-]{36}$/.test(old.id)) throw error()
        return old.id
      }
      const id = `urn:uuid:${randomUUID()}`
      this.write(path, { id })
      return id
    })
  }
  load(name: string): LocalCredential | undefined {
    const record = this.read<LocalCredential>(this.path(name))
    if (!record) return undefined
    if (
      record.version !== 1 ||
      typeof record.generation !== 'string' ||
      !['ready', 'refreshing', 'failed'].includes(record.status) ||
      record.descriptor.kind !== 'chatgpt-subscription'
    )
      throw error()
    record.state = chatgptStateSchema.parse(record.state)
    credentialValues(record.state).forEach((v) => {
      this.sensitive.add(v)
      sensitiveAccountValues.add(v)
    })
    return record
  }
  save(name: string, record: LocalCredential): void {
    credentialValues(record.state).forEach((v) => {
      this.sensitive.add(v)
      sensitiveAccountValues.add(v)
    })
    this.write(this.path(name), record)
  }
  install(name: string, descriptor: Account, state: ChatGPTState): void {
    this.locked(name, () => {
      const old = this.load(name)
      this.save(name, {
        version: 1,
        generation: randomUUID(),
        descriptor,
        state,
        status: 'ready',
        ...(old?.owner ? { owner: old.owner } : {}),
      })
    })
  }
}
