import { expect, test } from 'bun:test'
import { abWeb } from '../cli/web'
import { runCli } from '../cli/main'
import type { WebModelHub } from './hub'
import type { Exec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import type { BuildStore } from '../store/types'

const REPO = '/web/repo'

const fakeExec: Exec = async (cmd) =>
  cmd[1] === 'remote'
    ? { stdout: '', stderr: "error: No such remote 'origin'\n", exitCode: 2 }
    : { stdout: `${REPO}/.git\n${REPO}/.git\n${REPO}\n`, stderr: '', exitCode: 0 }

const READ = /^(get|list|read|load|count|close)/u

/** A store that records every call and fails the test on any non-read. */
function recordingStore() {
  const store = new MemoryBuildStore()
  const calls: string[] = []
  const writes: string[] = []
  const proxy = new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const name = String(key)
        calls.push(name)
        if (!READ.test(name)) writes.push(name)
        return Reflect.apply(value, target, args)
      }
    },
  }) as BuildStore
  return { store, proxy, calls, writes }
}

async function serve(argv: { json?: boolean; host?: string; port?: number } = {}) {
  const recorded = recordingStore()
  await recorded.store.ensureRepo(REPO)
  const out: string[] = []
  const err: string[] = []
  const controller = new AbortController()
  let listening!: (value: { url: string; hub: WebModelHub }) => void
  const ready = new Promise<{ url: string; hub: WebModelHub }>((resolve) => {
    listening = resolve
  })
  const running = abWeb({
    targetRepo: REPO,
    env: {},
    exec: fakeExec,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    json: argv.json ?? true,
    ...(argv.host !== undefined ? { host: argv.host } : {}),
    ...(argv.port !== undefined ? { port: argv.port } : {}),
    openStore: () => recorded.proxy,
    signal: controller.signal,
    onListening: listening,
  })
  const { url, hub } = await Promise.race([
    ready,
    running.then(() => {
      throw new Error(`ab web exited early: ${err.join('\n')}`)
    }),
  ])
  const stop = async () => {
    controller.abort()
    await running
  }
  return { ...recorded, out, err, url, hub, stop }
}

/** Send a raw HTTP/1.1 request so the Host header is exactly what we say. */
async function raw(url: string, lines: string[]): Promise<string> {
  const { hostname, port } = new URL(url)
  let received = ''
  const { promise, resolve } = Promise.withResolvers<string>()
  const socket = await Bun.connect({
    hostname,
    port: Number(port),
    socket: {
      data(_, chunk) {
        received += new TextDecoder().decode(chunk)
      },
      close() {
        resolve(received)
      },
      error() {
        resolve(received)
      },
    },
  })
  socket.write(`${lines.join('\r\n')}\r\nConnection: close\r\n\r\n`)
  return promise
}

test('ab web --json prints exactly one URL line and serves the page without store reads', async () => {
  const web = await serve()
  try {
    expect(web.out).toHaveLength(1)
    expect(web.out[0]).toMatch(/^\{"url":"http:\/\/127\.0\.0\.1:\d+\/"\}$/)
    expect(JSON.parse(web.out[0]!).url).toBe(web.url)
    expect(web.err).toEqual([])
    web.calls.length = 0
    const page = await fetch(web.url)
    expect(page.status).toBe(200)
    const csp = page.headers.get('content-security-policy')!
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]!
    expect(await page.text()).toContain(`<meta property="csp-nonce" nonce="${nonce}">`)
    const asset = await fetch(new URL('/assets/app.js', web.url))
    expect(asset.status).toBe(200)
    expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(1000)
    expect(web.calls).toEqual([])
  } finally {
    await web.stop()
  }
  expect(web.writes).toEqual([])
})

test('a foreign Host is refused', async () => {
  const web = await serve()
  try {
    const { host } = new URL(web.url)
    const refused = await raw(web.url, ['GET / HTTP/1.1', 'Host: evil.example'])
    expect(refused.startsWith('HTTP/1.1 403')).toBe(true)
    const accepted = await raw(web.url, ['GET / HTTP/1.1', `Host: ${host}`])
    expect(accepted.startsWith('HTTP/1.1 200')).toBe(true)
  } finally {
    await web.stop()
  }
})

test('--host beyond loopback warns and turns the Host check off', async () => {
  const web = await serve({ host: '0.0.0.0', json: false })
  try {
    expect(web.err).toHaveLength(1)
    expect(web.err[0]).toContain('--host 0.0.0.0 serves beyond loopback with no access control')
    expect(web.out).toEqual([`ab web: serving ${REPO} at ${web.url}`])
    expect(web.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    const response = await raw(web.url, ['GET / HTTP/1.1', 'Host: build-box.lan'])
    expect(response.startsWith('HTTP/1.1 200')).toBe(true)
  } finally {
    await web.stop()
  }
})

test('an occupied --port fails clearly with a nonzero exit', async () => {
  const web = await serve()
  try {
    const port = Number(new URL(web.url).port)
    const out: string[] = []
    const err: string[] = []
    const code = await runCli(['web', '--port', String(port), '--json'], {
      workspacePath: REPO,
      exec: fakeExec,
      openStore: () => new MemoryBuildStore(),
      processEnv: {},
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    })
    expect(code).not.toBe(0)
    expect(out).toEqual([])
    expect(err.join('\n')).toContain(`port ${port} is already in use on 127.0.0.1`)
  } finally {
    await web.stop()
  }
})

test('the event stream pushes a model frame and releases its subscriber on disconnect', async () => {
  const web = await serve()
  try {
    const controller = new AbortController()
    const response = await fetch(new URL('/events', web.url), { signal: controller.signal })
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader = response.body!.getReader()
    let text = ''
    while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value)
    expect(text.startsWith('event: model\ndata: ')).toBe(true)
    const frame = JSON.parse(text.split('\n')[1]!.slice('data: '.length))
    expect(frame.repository.repo).toBe(REPO)
    expect(web.hub.subscribers).toBe(1)
    controller.abort()
    for (let i = 0; i < 100 && web.hub.subscribers > 0; i++) await Bun.sleep(10)
    expect(web.hub.subscribers).toBe(0)
  } finally {
    await web.stop()
  }
  expect(web.writes).toEqual([])
})

test('HEAD /events answers with stream headers and joins nothing', async () => {
  const web = await serve()
  try {
    web.calls.length = 0
    const { host } = new URL(web.url)
    const response = await raw(web.url, ['HEAD /events HTTP/1.1', `Host: ${host}`])
    expect(response.startsWith('HTTP/1.1 200')).toBe(true)
    expect(response.toLowerCase()).toContain('content-type: text/event-stream')
    expect(web.hub.subscribers).toBe(0)
    await web.hub.join()
    expect(web.calls).toEqual([])
  } finally {
    await web.stop()
  }
})

test('ab web takes no lease, registers no presence and writes nothing', async () => {
  const web = await serve()
  try {
    const response = await fetch(new URL('/events', web.url))
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
  } finally {
    await web.stop()
  }
  expect(web.writes).toEqual([])
  for (const name of web.calls) expect(name).not.toMatch(/lease|presence|append|put|ensure/i)
})
