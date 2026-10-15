import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { access, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse } from 'smol-toml'
import {
  normalizeConnectionRepository,
  normalizeServiceURL,
  type ConnectionStarted,
  type ConnectionOutcome,
} from '../connection'
import type { Exec } from '../ports/workspace/git-worktree'
import { resolveMainRepo } from './repo-state'
import { ProjectCredentials } from './project-credentials'

interface ConnectOptions {
  cwd: string
  env: Record<string, string | undefined>
  exec: Exec
  print: (message: string) => void
  signal?: AbortSignal
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  browser?: (url: string) => Promise<void>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}
function requireOperator(env: ConnectOptions['env']) {
  if (
    ['AB_BUILD', 'AB_PHASE', 'AB_SESSION', 'AB_HARVEST', 'AB_REPO'].some(
      (key) => env[key] !== undefined,
    )
  )
    throw new Error('connect and disconnect are unavailable inside build or harvest sessions')
}
async function project(opts: ConnectOptions) {
  requireOperator(opts.env)
  const checkout = await resolveMainRepo(opts.cwd, opts.exec)
  const remote = await opts.exec(['git', 'remote', 'get-url', 'origin'], { cwd: checkout })
  if (remote.exitCode !== 0 || !remote.stdout.trim())
    throw new Error('A network origin remote is required; add an origin before running ab connect')
  const repo = normalizeConnectionRepository(remote.stdout.trim())
  const path = join(checkout, 'autobuild.toml')
  const text = await readFile(path, 'utf8')
  const table = parse(text)
  const store = table.store as { url?: unknown } | undefined
  if (store && (typeof store !== 'object' || Array.isArray(store)))
    throw new Error('Invalid [store] configuration')
  const service = store?.url === undefined ? undefined : normalizeServiceURL(String(store.url))
  return { checkout, repo, path, text, table, service }
}
async function request(
  opts: ConnectOptions,
  service: string,
  path: string,
  body?: unknown,
  token?: string,
) {
  const response = await (opts.fetch ?? fetch)(`${service}/connect/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  })
  return response
}
async function revoke(opts: ConnectOptions, service: string, token: string) {
  const response = await request(opts, service, 'revoke', {}, token)
  if (!response.ok && response.status !== 401)
    throw new Error('Remote revocation failed; retry ab disconnect when the service is reachable')
}
async function atomicConfig(path: string, before: string, after: string) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, after, { flag: 'wx' })
    if ((await readFile(path, 'utf8')) !== before)
      throw new Error('autobuild.toml changed during connection; retry ab connect')
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}
export async function abConnect(raw: string | undefined, opts: ConnectOptions): Promise<void> {
  const p = await project(opts)
  const credentials = new ProjectCredentials(opts.env)
  if (raw === undefined) {
    if (!p.service) {
      opts.print(
        `Project: ${p.repo}\nService: unconfigured\nCredential: missing; run ab connect <url>`,
      )
      return
    }
    const entry = credentials.load(p.service, p.repo)
    let status = 'missing; run ab connect'
    if (entry) {
      try {
        const response = await request(opts, p.service, 'status', undefined, entry.token)
        if (response.ok) {
          const body = (await response.json()) as {
            repo?: string
            credentialId?: string
            accepted?: boolean
          }
          if (body.repo !== p.repo || body.credentialId !== entry.id || body.accepted !== true)
            throw new Error('Invalid status response')
        }
        status = response.ok
          ? 'accepted'
          : response.status === 401 || response.status === 403
            ? 'rejected; run ab connect'
            : 'unreachable'
      } catch {
        status = 'unreachable'
      }
    }
    opts.print(`Service: ${p.service}\nProject: ${p.repo}\nCredential: ${status}`)
    return
  }
  const service = normalizeServiceURL(raw)
  if (p.service && p.service !== service)
    throw new Error(
      'Configured [store] url differs; update it explicitly before connecting to another service',
    )
  await access(p.path, constants.W_OK)
  await access(dirname(p.path), constants.W_OK)
  const previous = credentials.load(service, p.repo)
  const id = randomBytes(16).toString('hex'),
    secret = randomBytes(32).toString('hex')
  const token = `abp_1_${id}_${secret}`
  const response = await request(opts, service, 'requests', {
    repo: p.repo,
    credentialId: id,
    digest: createHash('sha256').update(secret).digest('hex'),
  })
  if (!response.ok)
    throw new Error('Could not start connection approval; verify the web-enabled service URL')
  const started = (await response.json()) as ConnectionStarted
  if (
    !/^[a-f0-9]{32}$/.test(started.id) ||
    !/^[a-f0-9]{64}$/.test(started.capability) ||
    !/^[A-F0-9]{10}$/.test(started.code) ||
    !Number.isFinite(Date.parse(started.expiresAt))
  )
    throw new Error('Invalid connection response')
  const verification = `${service}/connect?code=${started.code}`
  opts.print(`Approve project ${p.repo}\nOpen ${verification}\nCode: ${started.code}`)
  try {
    if (opts.browser) await opts.browser(verification)
    else {
      const command =
        process.platform === 'darwin'
          ? ['open', verification]
          : process.platform === 'win32'
            ? ['rundll32', 'url.dll,FileProtocolHandler', verification]
            : ['xdg-open', verification]
      const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' })
      child.unref()
    }
  } catch {
    opts.print('Browser could not be opened. Use the URL and code on another device.')
  }
  const capability = { id: started.id, capability: started.capability }
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const interval = Math.max(5, Math.min(30, started.interval || 5)) * 1000
  let approved = false
  let configChanged = false
  let saved = false
  try {
    let outcome: ConnectionOutcome | undefined
    while (!opts.signal?.aborted && now() <= Date.parse(started.expiresAt) + interval) {
      await sleep(interval)
      const polled = await request(opts, service, 'poll', capability)
      if (polled.status === 429) continue
      if (!polled.ok) throw new Error('Approval polling failed; retry ab connect')
      outcome = (await polled.json()) as ConnectionOutcome
      if (outcome.status !== 'pending') break
    }
    if (!outcome || outcome.status === 'pending' || opts.signal?.aborted) {
      const cancelled = await request(opts, service, 'cancel', capability)
      if (!cancelled.ok)
        throw new Error(
          'Could not confirm cancellation; use the owner credential list to check this connection',
        )
      opts.print(
        opts.signal?.aborted
          ? 'Connection cancelled; local configuration unchanged.'
          : 'Connection timed out; local configuration unchanged.',
      )
      return
    }
    if (outcome.status !== 'approved') {
      opts.print(`Connection ${outcome.status}; local configuration unchanged.`)
      return
    }
    approved = true
    if (outcome.repo !== p.repo || outcome.credentialId !== id)
      throw new Error('Approval identity mismatch')
    if (!p.service) {
      // Dotted root key also supports an existing empty [store] table after it.
      const after = `store.url = ${JSON.stringify(service)}\n${p.text}`
      const parsed = parse(after)
      if ((parsed.store as { url?: string })?.url !== service)
        throw new Error('Cannot safely update [store] url; add it manually and retry')
      await atomicConfig(p.path, p.text, after)
      configChanged = true
    }
    credentials.save({ service, repo: p.repo, id, token })
    saved = true
    if (previous) {
      try {
        await revoke(opts, service, previous.token)
      } catch {
        opts.print(
          `Connected, but the previous credential ${previous.id} could not be revoked; revoke it using the service administrative tools.`,
        )
      }
    }
    opts.print(`Connected ${p.repo} to ${service}.`)
    if (configChanged) opts.print(`Updated ${p.path}; review and commit this non-secret setting.`)
  } catch (error) {
    if (!saved) {
      try {
        const cancelled = await request(opts, service, 'cancel', capability)
        if (!cancelled.ok) throw new Error()
      } catch {
        opts.print(
          `Could not confirm remote cleanup for credential ${id}; check the service administrative credential list.`,
        )
      }
      if (configChanged) {
        try {
          await atomicConfig(p.path, `store.url = ${JSON.stringify(service)}\n${p.text}`, p.text)
        } catch {
          opts.print('Restore [store] url manually if needed; configuration changed concurrently.')
        }
      }
    }
    throw new Error(
      approved
        ? 'Connection could not be saved; previous credential retained. Repair local storage and run ab connect again.'
        : (error as Error).message,
    )
  }
}
export async function abDisconnect(opts: ConnectOptions): Promise<void> {
  const p = await project(opts)
  if (!p.service) throw new Error('No configured service')
  const credentials = new ProjectCredentials(opts.env)
  const entry = credentials.load(p.service, p.repo)
  if (!entry) {
    opts.print('No stored credential; project configuration and service data retained.')
    return
  }
  await revoke(opts, p.service, entry.token)
  credentials.remove(p.service, p.repo)
  opts.print('Disconnected; project registration, data, and [store] url retained.')
}
