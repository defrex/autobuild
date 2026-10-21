import { hostname } from 'node:os'
import {
  mkdirSync,
  existsSync,
  symlinkSync,
  readlinkSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  readdirSync,
  lstatSync,
  realpathSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const localHost = hostname()
interface Claim {
  host?: string
  pid: number
  start: string | null
  group?: boolean
}
interface Retention {
  current?: string
  previous?: string
  held: string[]
  claims: Record<string, { id: string; process: Claim; extensions?: string[] }>
}
function identity(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[19]!
  } catch {
    return null
  }
}
function alive(claim: Claim): boolean {
  if (claim.pid === 0 || (claim.host !== undefined && claim.host !== localHost)) return true
  try {
    process.kill(claim.group ? -claim.pid : claim.pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
  const start = identity(claim.pid)
  return !start || !claim.start || start === claim.start
}
function locked<T>(cache: string, operation: (state: Retention) => T): T {
  mkdirSync(cache, { recursive: true })
  const lock = join(cache, '.usage-lock')
  for (;;) {
    try {
      symlinkSync(
        JSON.stringify({ pid: process.pid, start: identity(process.pid), host: localHost }),
        lock,
      )
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const owner = JSON.parse(readlinkSync(lock)) as Claim
        if (owner.pid > 0 && !alive(owner)) {
          rmSync(lock, { force: true })
          continue
        }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  try {
    let state: Retention
    try {
      state = JSON.parse(readFileSync(join(cache, 'retention.json'), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      state = { held: [], claims: {} }
    }
    const result = operation(state)
    const temporary = join(cache, `.retention-${randomUUID()}`)
    writeFileSync(temporary, JSON.stringify(state))
    renameSync(temporary, join(cache, 'retention.json'))
    return result
  } finally {
    rmSync(lock, { force: true })
  }
}
export function looksCachedRuntime(root: string): boolean {
  return basename(root) === 'distribution' && /-[a-f0-9]{64}$/.test(basename(dirname(root)))
}
export function ownCachedRuntime(root: string): { cache: string; id: string } | undefined {
  if (!looksCachedRuntime(root)) return undefined
  const entry = dirname(root)
  let meta: { version?: number; root?: string; id?: string; digest?: string }
  try {
    meta = JSON.parse(readFileSync(join(entry, 'runtime.json'), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(entry)) return undefined
    throw new Error(`incomplete runtime metadata: ${root}`, { cause: error })
  }
  if (
    meta.version !== 1 ||
    meta.root !== resolve(root) ||
    meta.id !== basename(entry) ||
    !meta.digest ||
    !meta.id.endsWith(`-${meta.digest}`) ||
    realpathSync(root) !== resolve(root)
  )
    throw new Error(`invalid runtime metadata: ${root}`)
  if (readFileSync(join(root, 'tsconfig.json'), 'utf8') !== '{}\n')
    throw new Error(`invalid runtime compiler boundary: ${root}`)
  return { cache: dirname(entry), id: meta.id }
}
/** Spawn and publish its process identity under the pruning lock. A reservation
 * owned by this process survives spawn failure/crash conservatively. */
export function spawnUsingRuntime<T extends { pid: number }>(
  root: string,
  spawn: () => T,
  group = false,
): { child: T; release: () => void } {
  const runtime = ownCachedRuntime(root)
  if (!runtime) return { child: spawn(), release: () => {} }
  const key = randomUUID()
  const child = locked(runtime.cache, (state) => {
    // Persist an unknown-process reservation before crossing spawn. A crash
    // before identity publication must retain rather than delete live code.
    state.claims[key] = { id: runtime.id, process: { pid: 0, start: null } }
    const reservation = join(runtime.cache, `.retention-${randomUUID()}`)
    writeFileSync(reservation, JSON.stringify(state))
    renameSync(reservation, join(runtime.cache, 'retention.json'))
    let child: T
    try {
      child = spawn()
    } catch (error) {
      delete state.claims[key]
      const repaired = join(runtime.cache, `.retention-${randomUUID()}`)
      writeFileSync(repaired, JSON.stringify(state))
      renameSync(repaired, join(runtime.cache, 'retention.json'))
      throw error
    }
    state.claims[key] = {
      id: runtime.id,
      process: {
        pid: child.pid,
        start: identity(child.pid),
        host: localHost,
        ...(group ? { group: true } : {}),
      },
    }
    return child
  })
  return {
    child,
    release: () =>
      locked(runtime.cache, (state) => {
        delete state.claims[key]
      }),
  }
}
export function retainRuntime(root: string, held: boolean): void {
  const runtime = ownCachedRuntime(root)
  if (!runtime) throw new Error(`not a completed runtime: ${root}`)
  locked(runtime.cache, (state) => {
    state.held = state.held.filter((id) => id !== runtime.id)
    if (held) state.held.push(runtime.id)
  })
}
export function activateRuntime(root: string): void {
  const runtime = ownCachedRuntime(root)
  if (!runtime) throw new Error(`not a completed runtime: ${root}`)
  locked(runtime.cache, (state) => {
    if (state.current !== runtime.id) {
      state.previous = state.current
      state.current = runtime.id
    }
  })
}
export function pruneRuntimes(cache: string): void {
  locked(cache, (state) => {
    for (const [key, claim] of Object.entries(state.claims))
      if (!alive(claim.process)) delete state.claims[key]
    const keep = new Set([
      state.current,
      state.previous,
      ...state.held,
      ...Object.values(state.claims).map((c) => c.id),
    ])
    const liveExtensions = new Set(Object.values(state.claims).flatMap((c) => c.extensions ?? []))
    const extensions = join(cache, 'extensions')
    try {
      for (const id of readdirSync(extensions)) {
        if (!/^[a-f0-9]{64}$/.test(id)) continue
        const entry = join(extensions, id)
        if (liveExtensions.has(entry) || lstatSync(entry).isSymbolicLink()) continue
        let meta: { version?: number; digest?: string; core?: string }
        try {
          meta = JSON.parse(readFileSync(join(entry, 'extension.json'), 'utf8'))
        } catch {
          continue
        }
        if (
          meta.version !== 1 ||
          meta.digest !== id ||
          typeof meta.core !== 'string' ||
          !ownCachedRuntime(meta.core)
        )
          continue
        const tombstone = join(extensions, `.deleting-${randomUUID()}`)
        renameSync(entry, tombstone)
        rmSync(tombstone, { recursive: true, force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // Removal is restricted to completed entries owned by this cache. Unknown
    // files and preparations are never candidates.
    for (const id of readdirSync(cache)) {
      if (id.startsWith('.') || keep.has(id)) continue
      const entry = join(cache, id)
      if (lstatSync(entry).isSymbolicLink() || !lstatSync(entry).isDirectory()) continue
      let meta: { id?: string; root?: string; version?: number }
      try {
        meta = JSON.parse(readFileSync(join(entry, 'runtime.json'), 'utf8'))
      } catch {
        continue
      }
      if (meta.id !== id || meta.root !== join(entry, 'distribution') || meta.version !== 1)
        continue
      const tombstone = join(cache, `.deleting-${randomUUID()}`)
      renameSync(entry, tombstone)
      rmSync(tombstone, { recursive: true, force: true })
    }
    // A preparation may be copying a shared layer without executing it.
    // Conservatively defer layer cleanup while any such directory exists.
    if (!readdirSync(cache).some((name) => name.startsWith('.preparing-'))) {
      const needed = new Set<string>()
      for (const id of readdirSync(cache)) {
        if (id.startsWith('.')) continue
        try {
          const meta = JSON.parse(readFileSync(join(cache, id, 'runtime.json'), 'utf8'))
          if (typeof meta.dependencies === 'string') needed.add(meta.dependencies)
        } catch {}
      }
      const layers = join(cache, 'layers')
      try {
        for (const id of readdirSync(layers)) {
          if (!/^[a-f0-9]{64}$/.test(id) || needed.has(id)) continue
          const layer = join(layers, id)
          if (lstatSync(layer).isSymbolicLink()) continue
          try {
            if (!/^[a-f0-9]{64}$/.test(readFileSync(join(layer, 'digest'), 'utf8'))) continue
          } catch {
            continue
          }
          const tombstone = join(layers, `.deleting-${randomUUID()}`)
          renameSync(layer, tombstone)
          rmSync(tombstone, { recursive: true, force: true })
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  })
}

export function claimRuntimeForProcess(root: string, extension?: string): void {
  const runtime = ownCachedRuntime(root)
  if (!runtime) return
  locked(runtime.cache, (state) => {
    const key = `process-${process.pid}-${identity(process.pid)}-${runtime.id}`
    const extensions = new Set(state.claims[key]?.extensions ?? [])
    if (extension) extensions.add(extension)
    state.claims[key] = {
      id: runtime.id,
      process: { pid: process.pid, start: identity(process.pid), host: localHost },
      extensions: [...extensions],
    }
  })
}

export function reservePreparedRuntime(cache: string, id: string, owner = process.pid): void {
  locked(cache, (state) => {
    state.claims[`preparing-${owner}-${id}`] = {
      id,
      process: { pid: owner, start: identity(owner), host: localHost },
    }
  })
}
export function releasePreparedRuntime(root: string, owner = process.pid): void {
  const runtime = ownCachedRuntime(root)
  if (runtime)
    locked(runtime.cache, (state) => {
      delete state.claims[`preparing-${owner}-${runtime.id}`]
    })
}

/** Synchronous, short filesystem mutations only; shared with spawn and prune. */
export function mutateRuntimeCache<T>(cache: string, operation: () => T): T {
  return locked(cache, operation)
}

/** Validate and reserve an existing candidate in the same pruning critical section. */
export function reserveExistingRuntime(root: string): boolean {
  const cache = dirname(dirname(root))
  return locked(cache, (state) => {
    const runtime = ownCachedRuntime(root)
    if (!runtime || runtime.cache !== cache) return false
    state.claims[`preparing-${process.pid}-${runtime.id}`] = {
      id: runtime.id,
      process: { pid: process.pid, start: identity(process.pid), host: localHost },
    }
    return true
  })
}
