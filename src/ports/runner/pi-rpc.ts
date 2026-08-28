import { fileURLToPath } from 'node:url'
import type { PiCatalogEntry } from '../../cli/models'
import { classifyProviderError } from './provider-error'
import type { PiModelRef, PiSession, PiTurn } from './pi'

export const PI_BRIDGE_PATH = fileURLToPath(new URL('./pi-bridge.js', import.meta.url))
const CATALOG_PREFIX = 'autobuild-pi-catalog:'

export interface PiRpcInvocation {
  args: string[]
  cwd: string
  env: Record<string, string>
}

export interface PiRpcProcess {
  write(line: string): void
  closeInput(): void
  output: AsyncIterable<Uint8Array | string>
  stderr: Promise<string>
  exited: Promise<number>
  kill(signal?: number): void
}

export type PiRpcSpawnFn = (invocation: PiRpcInvocation) => PiRpcProcess

export const spawnPiRpc: PiRpcSpawnFn = (invocation) => {
  const proc = Bun.spawn(['pi', ...invocation.args], {
    cwd: invocation.cwd,
    env: invocation.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    write(line) {
      proc.stdin.write(line)
      proc.stdin.flush()
    },
    closeInput() {
      proc.stdin.end()
    },
    output: proc.stdout,
    stderr: new Response(proc.stderr).text(),
    exited: proc.exited,
    kill(signal) {
      proc.kill(signal)
    },
  }
}

export class JsonlDecoder {
  private readonly decoder = new TextDecoder()
  private buffer = ''

  push(chunk: Uint8Array | string): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
    return this.takeLines(false)
  }

  end(): string[] {
    this.buffer += this.decoder.decode()
    return this.takeLines(true)
  }

  private takeLines(final: boolean): string[] {
    const lines: string[] = []
    while (true) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) break
      let line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length > 0) lines.push(line)
    }
    if (final && this.buffer.length > 0) {
      lines.push(this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer)
      this.buffer = ''
    }
    return lines
  }
}

type JsonRecord = Record<string, unknown>

interface PendingResponse {
  command: string
  resolve: (value: JsonRecord) => void
  reject: (error: Error) => void
}

interface TurnCapture {
  text: string[]
  failure?: string
  settled: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

export class PiRpcClient implements PiSession {
  readonly sessionId: string
  private nextId = 0
  private closed = false
  private fatal: Error | undefined
  private readonly pending = new Map<string, PendingResponse>()
  private readonly notifications = new Set<(value: JsonRecord) => void>()
  private activeTurn: TurnCapture | undefined

  private constructor(
    private readonly process: PiRpcProcess,
    sessionId: string,
    private readonly configuredTools: readonly string[],
  ) {
    this.sessionId = sessionId
    void this.readOutput()
    void process.exited.then((code) => {
      if (!this.closed)
        void this.fail(new Error(`pi runtime: RPC process exited with code ${code}`))
    })
  }

  static async launch(
    invocation: PiRpcInvocation,
    spawn: PiRpcSpawnFn = spawnPiRpc,
    configuredTools: readonly string[] = [],
  ): Promise<PiRpcClient> {
    const process = spawn(invocation)
    const client = new PiRpcClient(process, crypto.randomUUID(), configuredTools)
    try {
      const state = await client.command('get_state')
      const data = record(state.data)
      const id = typeof data?.sessionId === 'string' ? data.sessionId : undefined
      if (id === undefined || id.length === 0)
        throw new Error('pi runtime: RPC get_state returned no sessionId')
      Object.defineProperty(client, 'sessionId', { value: id })
      return client
    } catch (error) {
      await client.dispose()
      throw error
    }
  }

  async prompt(text: string, env: Record<string, string>, signal?: AbortSignal): Promise<PiTurn> {
    if (this.activeTurn !== undefined)
      throw new Error('pi runtime: concurrent RPC prompts are not supported')
    if (signal?.aborted) throw abortReason(signal)

    await this.configure(env)
    const before = await this.stats()
    let resolve!: () => void
    let reject!: (error: Error) => void
    const settled = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    const capture: TurnCapture = { text: [], settled, resolve, reject }
    this.activeTurn = capture

    let aborting: Promise<unknown> | undefined
    const onAbort = (): void => {
      aborting ??= this.command('abort').catch(() => undefined)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await this.command('prompt', { message: text })
      await capture.settled
      if (aborting !== undefined) await aborting
      if (signal?.aborted) throw abortReason(signal)
      const after = await this.stats()
      return {
        text: capture.text.join(''),
        usage: {
          inputTokens: tokenDelta(after.input, before.input),
          outputTokens: tokenDelta(after.output, before.output),
        },
        ...(capture.failure !== undefined
          ? { failure: classifyProviderError(capture.failure) }
          : {}),
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (this.activeTurn === capture) this.activeTurn = undefined
    }
  }

  async catalog(availableOnly: boolean): Promise<PiCatalogEntry[]> {
    const nonce = crypto.randomUUID()
    const payload = encode({ nonce, availableOnly })
    const prefix = `${CATALOG_PREFIX}${nonce}:`
    const matches: string[] = []
    const listener = (event: JsonRecord): void => {
      if (event.type !== 'extension_ui_request' || event.method !== 'notify') return
      const message = typeof event.message === 'string' ? event.message : ''
      if (message.startsWith(prefix)) matches.push(message.slice(prefix.length))
    }
    this.notifications.add(listener)
    try {
      await this.command('prompt', { message: `/autobuild-models ${payload}` })
      await Promise.resolve()
      if (matches.length === 0) throw new Error('pi runtime: missing model-catalog bridge response')
      if (matches.length > 1) throw new Error('pi runtime: duplicate model-catalog bridge response')
      try {
        return parseCatalog(decode(matches[0]!))
      } catch (error) {
        throw asError(error, 'pi runtime: malformed model-catalog bridge response')
      }
    } finally {
      this.notifications.delete(listener)
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.process.closeInput()
    this.process.kill()
    await Promise.race([this.process.exited.catch(() => -1), delay(1_000)])
  }

  private async configure(environment: Record<string, string>): Promise<void> {
    await this.command('prompt', {
      message: `/autobuild-configure ${encode({
        environment,
        tools: this.configuredTools,
      })}`,
    })
  }

  private async stats(): Promise<{ input: number; output: number }> {
    const response = await this.command('get_session_stats')
    const data = record(response.data)
    const tokens = record(data?.tokens)
    return { input: token(tokens?.input), output: token(tokens?.output) }
  }

  private command(type: string, fields: JsonRecord = {}): Promise<JsonRecord> {
    if (this.fatal !== undefined) return Promise.reject(this.fatal)
    if (this.closed) return Promise.reject(new Error('pi runtime: RPC process is closed'))
    const id = `ab-${++this.nextId}`
    return new Promise((resolve, reject) => {
      this.pending.set(id, { command: type, resolve, reject })
      try {
        this.process.write(`${JSON.stringify({ id, type, ...fields })}\n`)
      } catch (error) {
        this.pending.delete(id)
        reject(asError(error, 'pi runtime: failed to write RPC command'))
      }
    })
  }

  private async readOutput(): Promise<void> {
    const decoder = new JsonlDecoder()
    try {
      for await (const chunk of this.process.output) {
        for (const line of decoder.push(chunk)) this.receive(line)
      }
      for (const line of decoder.end()) this.receive(line)
    } catch (error) {
      await this.fail(asError(error, 'pi runtime: failed to read RPC output'))
    }
  }

  private receive(line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      void this.fail(new Error(`pi runtime: malformed JSONL from RPC process: ${line}`))
      return
    }
    if (!isRecord(value)) {
      void this.fail(new Error('pi runtime: RPC process emitted a non-object JSON record'))
      return
    }
    if (value.type === 'response' && typeof value.id === 'string') {
      const pending = this.pending.get(value.id)
      if (pending === undefined) return
      this.pending.delete(value.id)
      if (value.command !== pending.command) {
        pending.reject(new Error(`pi runtime: RPC response command mismatch for ${value.id}`))
      } else if (value.success !== true) {
        pending.reject(
          new Error(
            typeof value.error === 'string' ? value.error : `pi RPC ${pending.command} failed`,
          ),
        )
      } else {
        pending.resolve(value)
      }
      return
    }

    for (const listener of this.notifications) listener(value)
    const capture = this.activeTurn
    if (capture === undefined) return
    if (value.type === 'message_update') {
      const update = record(value.assistantMessageEvent)
      if (update?.type === 'text_delta' && typeof update.delta === 'string')
        capture.text.push(update.delta)
    }
    if (value.type === 'message_end') {
      const message = record(value.message)
      if (message?.role === 'assistant') {
        const stopReason = typeof message.stopReason === 'string' ? message.stopReason : undefined
        if (stopReason === 'error' || stopReason === 'aborted') {
          capture.failure =
            typeof message.errorMessage === 'string' && message.errorMessage.length > 0
              ? message.errorMessage
              : `pi runtime: assistant turn ended with stopReason "${stopReason}"`
        } else if (stopReason !== undefined) {
          capture.failure = undefined
        }
      }
    }
    if (value.type === 'agent_settled') capture.resolve()
  }

  private async fail(error: Error): Promise<void> {
    if (this.fatal !== undefined) return
    this.fatal = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.activeTurn?.reject(error)
    if (!this.closed) this.process.kill()
  }
}

export interface PiRpcSessionOptions {
  cwd: string
  model?: PiModelRef
  tools: readonly string[]
  args: readonly string[]
  skill?: string
  env: Record<string, string>
  spawn?: PiRpcSpawnFn
}

export async function createPiRpcSession(opts: PiRpcSessionOptions): Promise<PiSession> {
  const args = [
    '--mode',
    'rpc',
    '--no-session',
    '--no-approve',
    '--no-context-files',
    '--no-prompt-templates',
    '--no-themes',
  ]
  if (opts.model !== undefined) args.push('--model', `${opts.model.provider}/${opts.model.id}`)
  // `--tools` filters both builtin and package tools out of Pi's registry.
  // Keep the complete registry for build sessions and let the bridge activate
  // exactly the configured builtin/package subset before every agent prompt.
  if (opts.tools.length === 0) args.push('--no-tools')
  args.push('--no-skills')
  if (opts.skill !== undefined) args.push('--skill', `${opts.cwd}/.agents/skills/${opts.skill}`)
  // Disable ambient discovery unconditionally. Explicit repeatable
  // --extension paths in configured args still load alongside the bridge.
  args.push('--no-extensions', '--extension', PI_BRIDGE_PATH)
  args.push(...opts.args)
  return PiRpcClient.launch({ args, cwd: opts.cwd, env: opts.env }, opts.spawn, opts.tools)
}

export async function readLocalPiCatalog(opts: {
  cwd: string
  env: Record<string, string>
  availableOnly: boolean
  spawn?: PiRpcSpawnFn
}): Promise<PiCatalogEntry[]> {
  const client = await PiRpcClient.launch(
    {
      args: [
        '--mode',
        'rpc',
        '--no-session',
        '--no-approve',
        '--no-context-files',
        '--no-tools',
        '--no-skills',
        '--no-extensions',
        '--no-prompt-templates',
        '--no-themes',
        '--extension',
        PI_BRIDGE_PATH,
      ],
      cwd: opts.cwd,
      env: opts.env,
    },
    opts.spawn,
  )
  try {
    return await client.catalog(opts.availableOnly)
  } finally {
    await client.dispose()
  }
}

function parseCatalog(value: unknown): PiCatalogEntry[] {
  if (!Array.isArray(value)) throw new Error('catalog is not an array')
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.provider !== 'string' || typeof entry.id !== 'string') {
      throw new Error('catalog entry is malformed')
    }
    return { provider: entry.provider, id: entry.id }
  })
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decode(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

function record(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function token(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

function tokenDelta(after: number, before: number): number {
  return Math.max(0, Math.round(after - before))
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('pi runtime: prompt aborted')
}

function asError(error: unknown, prefix: string): Error {
  return new Error(`${prefix}: ${error instanceof Error ? error.message : String(error)}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
