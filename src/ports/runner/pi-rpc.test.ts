import { describe, expect, test } from 'bun:test'
import {
  createPiRpcSession,
  JsonlDecoder,
  PI_BRIDGE_PATH,
  PiRpcClient,
  type PiRpcInvocation,
  type PiRpcProcess,
  type PiRpcSpawnFn,
} from './pi-rpc'

class AsyncQueue implements AsyncIterable<Uint8Array | string> {
  private values: Array<Uint8Array | string> = []
  private waiters: Array<(value: IteratorResult<Uint8Array | string>) => void> = []
  private ended = false

  push(value: Uint8Array | string): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter({ value, done: false })
    else this.values.push(value)
  }

  end(): void {
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array | string> {
    return {
      next: async () => {
        const value = this.values.shift()
        if (value !== undefined) return { value, done: false }
        if (this.ended) return { value: undefined, done: true }
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

function fakeRpc(): {
  spawn: PiRpcSpawnFn
  calls: Record<string, unknown>[]
  invocation: () => PiRpcInvocation
} {
  const calls: Record<string, unknown>[] = []
  let invocation: PiRpcInvocation | undefined
  const spawn: PiRpcSpawnFn = (value) => {
    invocation = value
    const output = new AsyncQueue()
    let stats = 0
    let resolveExit!: (code: number) => void
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve
    })
    const process: PiRpcProcess = {
      write(line) {
        const command = JSON.parse(line) as Record<string, unknown>
        calls.push(command)
        const response = (data?: unknown): string =>
          `${JSON.stringify({
            id: command.id,
            type: 'response',
            command: command.type,
            success: true,
            ...(data !== undefined ? { data } : {}),
          })}\n`
        if (command.type === 'get_state') {
          output.push(response({ sessionId: 'local-pi-session' }))
        } else if (command.type === 'get_session_stats') {
          const tokens = stats++ === 0 ? { input: 10, output: 2 } : { input: 14, output: 5 }
          output.push(response({ tokens }))
        } else if (command.type === 'prompt') {
          const message = String(command.message)
          if (message.startsWith('/autobuild-models ')) {
            const request = JSON.parse(
              Buffer.from(message.split(' ')[1]!, 'base64url').toString('utf8'),
            ) as { nonce: string }
            const entries = Buffer.from(
              JSON.stringify([{ provider: 'local-custom', id: 'new-model' }]),
              'utf8',
            ).toString('base64url')
            output.push(
              `${JSON.stringify({
                type: 'extension_ui_request',
                method: 'notify',
                message: `autobuild-pi-catalog:stale-nonce:${entries}`,
              })}\n${JSON.stringify({
                type: 'extension_ui_request',
                method: 'notify',
                message: `autobuild-pi-catalog:${request.nonce}:${entries}`,
              })}\n`,
            )
            output.push(response())
          } else {
            output.push(response())
          }
          if (
            !message.startsWith('/autobuild-configure ') &&
            !message.startsWith('/autobuild-models ')
          ) {
            const records = [
              {
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: 'hello ' },
              },
              {
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: 'world' },
              },
              { type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } },
              { type: 'agent_settled' },
            ].map((record) => `${JSON.stringify(record)}\n`)
            output.push(records[0]!.slice(0, 17))
            output.push(records[0]!.slice(17) + records.slice(1).join(''))
          }
        }
      },
      closeInput() {
        output.end()
      },
      output,
      stderr: Promise.resolve(''),
      exited,
      kill() {
        output.end()
        resolveExit(0)
      },
    }
    return process
  }
  return {
    spawn,
    calls,
    invocation: () => {
      if (invocation === undefined) throw new Error('not spawned')
      return invocation
    },
  }
}

describe('Pi RPC JSONL', () => {
  test('splits only LF records and accepts fragmented UTF-8 plus CRLF', () => {
    const decoder = new JsonlDecoder()
    expect(decoder.push('{"a":"x\u2028y"}\r')).toEqual([])
    expect(decoder.push('\n{"b":')).toEqual(['{"a":"x\u2028y"}'])
    expect(decoder.push('2}\n')).toEqual(['{"b":2}'])
    expect(decoder.end()).toEqual([])
  })

  test('correlates commands, waits for settlement, and diffs cumulative usage', async () => {
    const fake = fakeRpc()
    const session = await createPiRpcSession({
      cwd: '/repo',
      model: { provider: 'future-provider', id: 'future-model' },
      tools: ['read', 'bash'],
      extensions: ['SubAgents'],
      skill: 'ab-plan',
      env: { PATH: '/bin' },
      spawn: fake.spawn,
    })
    const turn = await session.prompt('/skill:ab-plan rpc-build', {
      AB_PHASE: 'plan@2',
      AB_SESSION: 's_2',
    })

    expect(session.sessionId).toBe('local-pi-session')
    expect(turn).toEqual({
      text: 'hello world',
      usage: { inputTokens: 4, outputTokens: 3 },
    })
    expect(fake.invocation().args).toEqual([
      '--mode',
      'rpc',
      '--no-session',
      '--no-approve',
      '--no-context-files',
      '--no-prompt-templates',
      '--no-themes',
      '--model',
      'future-provider/future-model',
      '--no-skills',
      '--skill',
      '/repo/.agents/skills/ab-plan',
      '--extension',
      PI_BRIDGE_PATH,
    ])
    const configure = String(
      fake.calls.find((call) => String(call.message).startsWith('/autobuild-configure '))?.message,
    )
    const encoded = configure.split(' ')[1]!
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toEqual({
      environment: { AB_PHASE: 'plan@2', AB_SESSION: 's_2' },
      extensions: ['SubAgents'],
      tools: ['read', 'bash'],
    })
    await session.dispose()
  })

  test('forwards abort and waits for the RPC agent to settle', async () => {
    const output = new AsyncQueue()
    const calls: Record<string, unknown>[] = []
    let resolveExit!: (code: number) => void
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve
    })
    const spawn: PiRpcSpawnFn = () => ({
      write(line) {
        const command = JSON.parse(line) as Record<string, unknown>
        calls.push(command)
        const respond = (data?: unknown) =>
          output.push(
            `${JSON.stringify({
              id: command.id,
              type: 'response',
              command: command.type,
              success: true,
              ...(data !== undefined ? { data } : {}),
            })}\n`,
          )
        if (command.type === 'get_state') respond({ sessionId: 'abort-session' })
        else if (command.type === 'get_session_stats') respond({ tokens: { input: 0, output: 0 } })
        else if (command.type === 'prompt') respond()
        else if (command.type === 'abort') {
          respond()
          output.push(
            `${JSON.stringify({
              type: 'message_end',
              message: { role: 'assistant', stopReason: 'aborted' },
            })}\n${JSON.stringify({ type: 'agent_settled' })}\n`,
          )
        }
      },
      closeInput() {
        output.end()
      },
      output,
      stderr: Promise.resolve(''),
      exited,
      kill() {
        output.end()
        resolveExit(0)
      },
    })
    const client = await PiRpcClient.launch(
      { args: ['--mode', 'rpc'], cwd: '/repo', env: {} },
      spawn,
    )
    const controller = new AbortController()
    const turn = client.prompt('keep running', {}, controller.signal)
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort(new Error('phase deadline'))
    await expect(turn).rejects.toThrow('phase deadline')
    expect(calls.some((call) => call.type === 'abort')).toBe(true)
    await client.dispose()
  })

  test('correlates a bridge catalog notification and ignores stale nonces', async () => {
    const fake = fakeRpc()
    const client = await PiRpcClient.launch(
      { args: ['--mode', 'rpc'], cwd: '/repo', env: {} },
      fake.spawn,
    )
    expect(await client.catalog(false)).toEqual([{ provider: 'local-custom', id: 'new-model' }])
    await client.dispose()
  })

  test('pins hermetic discovery flags for a tool-free session', async () => {
    const fake = fakeRpc()
    const session = await createPiRpcSession({
      cwd: '/repo',
      tools: [],
      extensions: [],
      env: {},
      spawn: fake.spawn,
    })
    expect(fake.invocation().args).toContain('--no-tools')
    expect(fake.invocation().args).toContain('--no-extensions')
    expect(fake.invocation().args).not.toContain('--skill')
    await session.dispose()
  })
})
