import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'

export interface Identity {
  pid: number
  parent: number
  ticks: string
}
export interface LaunchRecord {
  version: 1
  sha: string
  dirty: boolean
  host: string
  pid: number
  ticks: string
  boot: string
}
export interface Status {
  dispatcher: {
    state: string
    holder: { run: string; pid: number | null; host: string | null } | null
  }
}
export async function command(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${args.join(' ')} failed (${code}): ${err.trim()}`)
  return out.trim()
}
export async function canonicalRoot(cwd: string): Promise<string> {
  const common = await command(cwd, [
    'git',
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ])
  return realpath(dirname(common))
}
export function parseStat(pid: number, stat: string): Identity {
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/)
  const parent = Number(fields[1])
  const ticks = fields[19]
  if (!Number.isInteger(parent) || parent < 0 || !ticks || !/^\d+$/.test(ticks))
    throw new Error('invalid proc identity')
  return { pid, parent, ticks }
}
export async function procIdentity(pid: number): Promise<Identity> {
  return parseStat(pid, await readFile(`/proc/${pid}/stat`, 'utf8'))
}
export function validRecord(value: unknown): value is LaunchRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as LaunchRecord
  return (
    r.version === 1 &&
    typeof r.sha === 'string' &&
    /^[a-f0-9]{40}$/.test(r.sha) &&
    typeof r.dirty === 'boolean' &&
    typeof r.host === 'string' &&
    Number.isInteger(r.pid) &&
    r.pid > 0 &&
    typeof r.ticks === 'string' &&
    /^\d+$/.test(r.ticks) &&
    typeof r.boot === 'string' &&
    /^[a-f0-9-]{36}$/.test(r.boot)
  )
}
export async function capture(root: string): Promise<LaunchRecord> {
  if (process.platform !== 'linux') throw new Error('Linux process identity is required')
  const identity = await procIdentity(process.pid)
  const record: LaunchRecord = {
    version: 1,
    sha: await command(root, ['git', 'rev-parse', 'HEAD']),
    dirty: (await command(root, ['git', 'status', '--porcelain', '--untracked-files=no'])) !== '',
    host: hostname(),
    pid: process.pid,
    ticks: identity.ticks,
    boot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
  }
  if (!validRecord(record)) throw new Error('Could not capture launch identity')
  const directory = join(root, '.autobuild/dispatcher-starts')
  await mkdir(directory, { recursive: true })
  const destination = join(directory, `${record.boot}-${record.pid}-${record.ticks}.json`)
  const temporary = `${destination}.tmp`
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx' })
  await rename(temporary, destination)
  return record
}
export interface Evidence {
  status(): Promise<Status>
  identity(pid: number): Promise<Identity>
  boot(): Promise<string>
  host: string
  records(): Promise<unknown[]>
  git(args: string[]): Promise<string>
}
export async function inspect(e: Evidence): Promise<string> {
  const initial = await e.status()
  const head = await e.git(['rev-parse', 'HEAD'])
  const main = await e.git(['rev-parse', 'refs/heads/main'])
  const holder = initial.dispatcher.holder
  const lines = [
    `Holder run: ${holder?.run ?? 'none'} (${initial.dispatcher.state})`,
    'Dispatcher starting SHA: unknown',
    `Checkout HEAD: ${head}`,
    `Local main: ${main}${main === head ? '' : ' (differs from checkout HEAD)'}`,
  ]
  const unknown = (reason: string) => [...lines, `Comparison: unknown — ${reason}`].join('\n')
  if (initial.dispatcher.state !== 'held' || !holder) return unknown('no held dispatcher')
  if (holder.host !== e.host || holder.pid === null)
    return unknown('holder is foreign or has no local PID')
  try {
    const boot = await e.boot()
    const records = (await e.records()).filter(validRecord)
    const chain: Identity[] = []
    let pid = holder.pid
    let record: LaunchRecord | undefined
    while (pid > 0 && chain.length < 128 && !chain.some((p) => p.pid === pid)) {
      const identity = await e.identity(pid)
      chain.push(identity)
      record = records.find(
        (r) => r.pid === pid && r.ticks === identity.ticks && r.boot === boot && r.host === e.host,
      )
      if (record) break
      pid = identity.parent
    }
    if (!record)
      return unknown(
        'no valid launch record matches live process ancestry (legacy launch or unavailable evidence)',
      )
    for (const identity of chain) {
      const again = await e.identity(identity.pid)
      if (again.ticks !== identity.ticks || again.parent !== identity.parent)
        return unknown('process identity changed; retry')
    }
    const after = await e.status()
    if (
      after.dispatcher.state !== 'held' ||
      after.dispatcher.holder?.run !== holder.run ||
      after.dispatcher.holder.pid !== holder.pid ||
      after.dispatcher.holder.host !== holder.host ||
      (await e.boot()) !== boot
    )
      return unknown('holder changed; retry')
    if (
      (await e.git(['rev-parse', 'HEAD'])) !== head ||
      (await e.git(['rev-parse', 'refs/heads/main'])) !== main
    )
      return unknown('checkout changed; retry')
    await e.git(['cat-file', '-e', `${record.sha}^{commit}`])
    lines[1] = `Dispatcher starting SHA: ${record.sha}${record.dirty ? ' (captured base only; dirty launch)' : ''}`
    if (record.dirty) return unknown('dirty launch cannot identify exact running revision')
    if (record.sha === head) return [...lines, 'Comparison: equal'].join('\n')
    let relation = 'different (divergent history or dispatcher ahead of checkout)'
    try {
      await e.git(['merge-base', '--is-ancestor', record.sha, head])
      relation = 'different (dispatcher behind checkout HEAD)'
    } catch {
      /* A non-ancestor is deliberately not called behind. */
    }
    return [
      ...lines,
      `Comparison: ${relation}`,
      `Inspect changes: git diff --name-only ${record.sha} ${head}`,
      `Inspect local main: git log --oneline ${record.sha}..main`,
      `Changed files against local main: git diff --name-only ${record.sha} main`,
    ].join('\n')
  } catch (error) {
    return unknown(
      `evidence unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
export async function check(cwd = process.cwd()): Promise<string> {
  const root = await canonicalRoot(cwd)
  return inspect({
    status: async () =>
      JSON.parse(await command(root, ['bun', 'bin/ab.ts', 'repository', 'status', '--json'])),
    identity: procIdentity,
    host: hostname(),
    boot: async () => {
      if (process.platform !== 'linux') throw new Error('process inspection requires Linux')
      return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    },
    records: async () => {
      const directory = join(root, '.autobuild/dispatcher-starts')
      let names: string[]
      try {
        names = await readdir(directory)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
      return Promise.all(
        names
          .filter((name) => name.endsWith('.json'))
          .map(async (name) => {
            try {
              return JSON.parse(await readFile(join(directory, name), 'utf8'))
            } catch {
              return null
            }
          }),
      )
    },
    git: (args) => command(root, ['git', ...args]),
  })
}
if (import.meta.main) {
  try {
    console.log(await check(resolve(process.cwd())))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
