import { join } from 'node:path'
import { connectedProject } from './connect'
import { parseConfig } from '../config/load'
import { ProjectCredentials } from './project-credentials'
import { LocalCredentials } from '../accounts/local-credentials'
import { transaction, authorizationUrl, exchangeCode } from '../accounts/chatgpt-oauth'
import type { Exec } from '../ports/workspace/git-worktree'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '../store/remote/version'

export async function abAccountsLogin(
  name: string,
  opts: {
    cwd: string
    env: Record<string, string | undefined>
    exec: Exec
    print: (s: string) => void
    destination?: 'local' | 'project'
    signal?: AbortSignal
    browser?: (url: string) => Promise<void>
  },
): Promise<void> {
  const project = await connectedProject(opts)
  const account = parseConfig(project.text).accounts[name]
  if (account?.kind !== 'chatgpt-subscription')
    throw new Error('Select a declared ChatGPT subscription account')
  const destination = opts.destination ?? (project.service ? 'project' : 'local')
  if (destination === 'project' && !project.service)
    throw new Error('Project login requires ab connect')
  const credential =
    destination === 'project'
      ? new ProjectCredentials(opts.env).load(project.service!, project.repo)
      : undefined
  if (destination === 'project' && !credential)
    throw new Error('Missing project credential; run ab connect')
  const local = new LocalCredentials(join(project.checkout, '.autobuild'))
  // Host identity is nonsecret. Project credentials themselves are never written here.
  let hostId: string
  if (destination === 'project') {
    if (local.load(name))
      throw new Error(
        'A local credential already owns this account; use a separate account for the project',
      )
    const response = await fetch(
      `${project.service}/secrets/v1/chatgpt-host?repo=${encodeURIComponent(project.repo)}`,
      {
        headers: {
          authorization: `Bearer ${credential!.token}`,
          [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
        },
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      },
    )
    if (!response.ok) throw new Error('Project host identity unavailable')
    const result = await response.json()
    if (
      result?.version !== 1 ||
      typeof result.hostId !== 'string' ||
      !/^urn:uuid:[0-9a-f-]{36}$/.test(result.hostId)
    )
      throw new Error('Invalid project host identity')
    hostId = result.hostId
  } else hostId = local.hostId()
  const previous = destination === 'local' ? local.load(name)?.state : undefined
  opts.print(
    `Continue with ChatGPT: account ${JSON.stringify(name)}, destination ${destination === 'local' ? 'local dispatcher' : 'connected project'}.`,
  )
  const signal = AbortSignal.any([
    AbortSignal.timeout(300000),
    ...(opts.signal ? [opts.signal] : []),
  ])
  let resolveCallback!: (url: URL) => void
  let rejectCallback!: (error: Error) => void
  const received = new Promise<URL>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })
  void received.catch(() => {})
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== '/auth/callback') return new Response('Not found', { status: 404 })
      resolveCallback(url)
      return new Response('Return to the terminal to complete sign-in.', {
        headers: { 'cache-control': 'no-store' },
      })
    },
  })
  const abort = () => rejectCallback(new Error('ChatGPT sign-in cancelled or timed out'))
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) throw new Error('Sign-in cancelled')
    const t = transaction(`http://127.0.0.1:${server.port}/auth/callback`, hostId, previous)
    const url = authorizationUrl(t)
    const opening = (async () => {
      if (opts.browser) await opts.browser(url)
      else {
        const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
        const result = await opts.exec([command, url], { cwd: opts.cwd })
        if (result.exitCode !== 0) throw new Error('Unable to open system browser')
      }
    })()
    void opening.catch(() => {})
    await Promise.race([opening, received.then(() => {})])
    const state = await exchangeCode(t, await received, signal)
    if (destination === 'local') local.install(name, account, state)
    else {
      const response = await fetch(`${project.service}/secrets/v1/chatgpt`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${credential!.token}`,
          [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          version: 1,
          repo: project.repo,
          name: account.credentialEnv,
          state,
        }),
      })
      if (!response.ok) throw new Error('Project sign-in write failed')
      const result = await response.json()
      if (result?.version !== 1 || result?.ok !== true)
        throw new Error('Project sign-in write not acknowledged')
    }
    opts.print(`ChatGPT account ${JSON.stringify(name)} saved for ${destination}.`)
  } catch {
    throw new Error(
      `ChatGPT sign-in failed for account ${JSON.stringify(name)}; run ab accounts login again`,
    )
  } finally {
    signal.removeEventListener('abort', abort)
    await server.stop(true)
  }
}
