import type { RepositoryStatus } from '../packages/core/src/cli/repository-status'
import { formatRuntimeIdentity } from '../packages/core/src/events/runtime'
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
  upgrades?: UpgradeStatus['upgrades']
  rollbackHold?: UpgradeStatus['rollbackHold']
  dispatcher: {
    state: string
    holder: {
      run: string
      pid: number | null
      host: string | null
      runtime?: import('../packages/core/src/events/runtime').RuntimeIdentity | null
    } | null
  }
}
export type UpgradeStatus = Pick<RepositoryStatus, 'upgrades' | 'rollbackHold'>
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
/** Compare durable generation evidence independently of local launcher correlation. */
export async function inspect(e: Evidence): Promise<string> {
  const initial = await e.status()
  // Capture bytes before another read: injected readers may reuse mutable projections.
  const snapshot = (s: Status) =>
    JSON.stringify({
      dispatcher: {
        state: s.dispatcher.state,
        holder: s.dispatcher.holder && {
          run: s.dispatcher.holder.run,
          pid: s.dispatcher.holder.pid,
          host: s.dispatcher.holder.host,
          runtime: s.dispatcher.holder.runtime,
        },
      },
      upgrades: s.upgrades,
      rollbackHold: s.rollbackHold,
    })
  const before = snapshot(initial)
  const head = await e.git(['rev-parse', 'HEAD'])
  const main = await e.git(['rev-parse', 'refs/heads/main'])
  const holder = initial.dispatcher.state === 'held' ? initial.dispatcher.holder : null
  const runtime = holder?.runtime
  const runs = initial.upgrades?.runs ?? {}
  const current = holder ? runs[holder.run] : undefined
  const incoming = holder
    ? Object.values(runs).find((s) => s.request?.payload.successor === holder.run && s.takeover)
    : undefined
  const target =
    current?.resolved?.payload.target ??
    current?.detected?.payload.target ??
    current?.prepared?.payload.target ??
    current?.handoff?.payload.target ??
    current?.failure?.payload.target ??
    incoming?.handoff?.payload.target
  const lines = [
    `Holder run: ${holder?.run ?? 'none'} (${initial.dispatcher.state})`,
    `Running generation: ${formatRuntimeIdentity(runtime ?? null)}`,
    `Upgrade mode: ${holder ? (target?.mode ?? 'unknown') : 'unknown (no held dispatcher)'}`,
    `Checkout HEAD: ${head}`,
    `Local main: ${main}${main === head ? '' : ' (differs from checkout HEAD)'}`,
    'Local main may differ from remote main; a difference alone does not require restart.',
  ]
  for (const [run, state] of Object.entries(runs)) {
    if (state.handoff) {
      const h = state.handoff.payload
      lines.push(
        `${state.completed ? 'Completed handoff (history)' : 'Active handoff'} ${run} → ${state.request?.payload.successor ?? h.successor ?? 'unknown'}: ${formatRuntimeIdentity(h.from)} → ${formatRuntimeIdentity(h.to)}; ${state.takeover ? 'taken over' : 'awaiting takeover'}; draining ${
          Object.entries(state.outstanding)
            .map(([slug, instance]) => `${slug} (${instance})`)
            .join(', ') || 'none'
        }; deadline ${state.deadline ?? 'unknown'}`,
      )
    } else if (state.request)
      lines.push(
        `Pending handoff ${run} → ${state.request.payload.successor}: ${formatRuntimeIdentity(state.request.payload.from)} → ${formatRuntimeIdentity(state.request.payload.to)}; awaiting handoff`,
      )
    if (state.failure) lines.push(`Upgrade failure ${run}: ${state.failure.payload.reason}`)
  }
  if (initial.upgrades?.lastRollback) {
    const r = initial.upgrades.lastRollback.payload
    lines.push(
      `Last rollback (history): ${formatRuntimeIdentity(r.failed)} → ${formatRuntimeIdentity(r.restored)}; ${r.reason}`,
    )
  }
  lines.push(
    initial.rollbackHold
      ? `Active rollback hold: ${initial.rollbackHold.payload.target.key}; failed ${formatRuntimeIdentity(initial.rollbackHold.payload.failed)}`
      : 'Active rollback hold: none',
  )
  let launcher = 'unavailable — no held local dispatcher'
  if (holder?.host === e.host && holder.pid !== null) {
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
          (r) =>
            r.pid === pid && r.ticks === identity.ticks && r.boot === boot && r.host === e.host,
        )
        if (record) break
        pid = identity.parent
      }
      if (!record)
        throw new Error(
          'no valid launch record matches live process ancestry (legacy launch or unavailable evidence)',
        )
      for (const identity of chain) {
        const again = await e.identity(identity.pid)
        if (again.ticks !== identity.ticks || again.parent !== identity.parent)
          throw new Error('process identity changed; retry')
      }
      if ((await e.boot()) !== boot) throw new Error('boot changed; retry')
      launcher = `PID ${record.pid}; captured launch base ${record.sha}${record.dirty ? ' (captured base only; dirty launch)' : ''}; not the current runtime revision`
    } catch (error) {
      launcher = `unavailable — ${error instanceof Error ? error.message : String(error)}`
    }
  }
  lines.push(`Local launcher evidence: ${launcher}`)
  const commit = runtime?.commit
  if (!holder || !commit || commit === 'unknown')
    lines.push('Comparison: unknown — no recorded current runtime commit')
  else {
    try {
      await e.git(['cat-file', '-e', `${commit}^{commit}`])
      for (const [name, revision] of [
        ['checkout HEAD', head],
        ['local main', main],
      ]) {
        let relation = 'equal'
        if (commit !== revision) {
          relation = 'different (divergent history or dispatcher ahead of checkout)'
          try {
            await e.git(['merge-base', '--is-ancestor', commit, revision!])
            relation = `different (dispatcher behind ${name})`
          } catch {
            /* Non-ancestor. */
          }
        }
        lines.push(`Comparison: ${relation} [${name}]`)
      }
      lines.push(
        `Inspect changes: git diff --name-only ${commit} ${head}`,
        `Inspect local main: git log --oneline ${commit}..main`,
        `Changed files against local main: git diff --name-only ${commit} main`,
      )
    } catch (error) {
      lines.push(`Comparison: unknown — runtime Git object unavailable: ${String(error)}`)
    }
  }
  if (
    snapshot(await e.status()) !== before ||
    (await e.git(['rev-parse', 'HEAD'])) !== head ||
    (await e.git(['rev-parse', 'refs/heads/main'])) !== main
  )
    return 'Comparison: unknown — holder/runtime/upgrade or checkout changed during inspection; unstable snapshot; retry'
  return lines.join('\n')
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
