import { SECRET_NAME_EXPLANATION } from '../secret-name'
import { connectedProject } from './connect'
import { ProjectCredentials } from './project-credentials'
import type { Exec } from '../ports/workspace/git-worktree'
import { decodeSecretMetadata, validateSecretName, validateSecretValue } from '../project-secrets'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '../store/remote/version'
/** Raw mode disables terminal echo before listening. Restore the exact prior state on every exit. */
export async function readSecretInput(
  input: NodeJS.ReadStream = process.stdin,
  prompt: (s: string) => void = (s) => {
    process.stderr.write(s)
  },
): Promise<string> {
  if (!input.isTTY) {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of input) {
      const b = Buffer.from(chunk)
      size += b.length
      if (size > 65538) throw new Error('Secret input too large')
      chunks.push(b)
    }
    return Buffer.concat(chunks)
      .toString()
      .replace(/\r?\n$/, '')
  }
  const wasPaused = input.isPaused()
  const wasRaw = input.isRaw
  input.setRawMode(true)
  try {
    prompt('Secret value: ')
  } catch {
    input.setRawMode(wasRaw)
    throw new Error('Secret input failed')
  }
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = (error?: Error) => {
      input.off('data', data)
      input.off('end', end)
      input.off('error', failed)
      process.off('SIGINT', cancel)
      input.setRawMode(wasRaw)
      if (wasPaused) input.pause()
      else input.resume()
      prompt('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const cancel = () => finish(new Error('Secret input cancelled'))
    const end = () => finish(new Error('Secret input ended'))
    const failed = () => finish(new Error('Secret input failed'))
    const data = (chunk: Buffer) => {
      for (const c of chunk.toString()) {
        if (c === '\x03') {
          cancel()
          return
        }
        if (c === '\x04') {
          end()
          return
        }
        if (c === '\r' || c === '\n') {
          finish()
          return
        }
        if (c === '\x7f' || c === '\b') value = value.slice(0, -1)
        else value += c
        if (Buffer.byteLength(value) > 65536) {
          finish(new Error('Secret input too large'))
          return
        }
      }
    }
    input.on('data', data)
    input.once('end', end)
    input.once('error', failed)
    process.once('SIGINT', cancel)
    input.resume()
  })
}
export async function abSecrets(
  operation: string | undefined,
  name: string | undefined,
  opts: {
    cwd: string
    env: Record<string, string | undefined>
    exec: Exec
    print: (s: string) => void
    json?: boolean
    readValue?: () => Promise<string>
    fetch?: (input: string, init?: RequestInit) => Promise<Response>
  },
): Promise<void> {
  if (
    !['list', 'set', 'remove'].includes(operation ?? '') ||
    (operation === 'list' ? name !== undefined : name === undefined)
  )
    throw new Error('usage: ab secrets list [--json] | set NAME | remove NAME')
  if (name !== undefined) {
    try {
      validateSecretName(name)
    } catch {
      throw new Error(SECRET_NAME_EXPLANATION)
    }
  }
  const project = await connectedProject(opts)
  if (!project.service) throw new Error('No connected build service; run ab connect <url>')
  const credential = new ProjectCredentials(opts.env).load(project.service, project.repo)
  if (!credential) throw new Error('Missing saved project credential; run ab connect')
  const body: Record<string, unknown> = { version: 1, repo: project.repo, name }
  if (operation === 'set') {
    const value = await (opts.readValue ?? readSecretInput)()
    validateSecretValue(value)
    body.value = value
  }
  let response: Response
  try {
    response = await (opts.fetch ?? fetch)(
      `${project.service}/secrets/v1/${operation}${operation === 'list' ? `?repo=${encodeURIComponent(project.repo)}` : ''}`,
      {
        method: operation === 'list' ? 'GET' : 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${credential.token}`,
          [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
        },
        ...(operation === 'list' ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      },
    )
  } catch {
    throw new Error('Project secrets request failed')
  }
  if (!response.ok) throw new Error(`Project secrets request refused (${response.status})`)
  try {
    const result = await response.json()
    if (
      !result ||
      typeof result !== 'object' ||
      Object.keys(result).length !== 2 ||
      result.version !== 1
    )
      throw new Error()
    if (operation === 'list') {
      if (!Array.isArray(result.secrets)) throw new Error()
      const secrets: ReturnType<typeof decodeSecretMetadata>[] =
        result.secrets.map(decodeSecretMetadata)
      opts.print(
        opts.json
          ? JSON.stringify({ version: 1, secrets })
          : secrets
              .map(
                (s) =>
                  `${s.name}\t${s.status}\t${s.owner}\t${s.setAt}\t${s.fingerprint}\t${s.lastSuppliedAt ?? 'never supplied'}${s.warnings?.length ? `\t${s.warnings.join(', ')}` : ''}`,
              )
              .join('\n') || 'No project secrets.',
      )
    } else {
      if (result.ok !== true) throw new Error()
      opts.print(`Secret ${operation === 'set' ? 'saved' : 'removed'}.`)
    }
  } catch {
    throw new Error('Invalid project secrets response')
  }
}
