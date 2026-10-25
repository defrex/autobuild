import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { build, project, root } from './verify'
import { checkRoutes, checkFrameMatrix, frames, palette, probe } from './capture-cases'

interface Reply {
  result: { value: ReturnType<typeof probe> & boolean }
  exceptionDetails?: unknown
  root: { nodeId: number }
  nodeIds: number[]
  fonts: { glyphCount: number; familyName: string }[]
  data?: string
}

export async function capture() {
  checkRoutes(await Bun.file(join(project, 'src/routes.rs')).text())
  const config = await Bun.file(join(project, 'proa.config.json')).json()
  const sources = await Array.fromAsync(
    new Bun.Glob('src/{pages,endpoints}/**/*.rs').scan({ cwd: project }),
  )
  const source = (await Promise.all(sources.map((p) => Bun.file(join(project, p)).text()))).join(
    '\n',
  )
  if (config.database.driver !== 'none' || /sqlx|postgres|DATABASE_URL|state\.data/i.test(source))
    throw Error('Unsupported database capability; add a seed adapter; see tools/README.md')
  if (
    !source.includes('x-proa-dev-capability') ||
    !source.includes('ConnectInfo') ||
    !source.includes('PROA_DEV_AUTH')
  )
    throw Error(
      'Auth capture requires the supported server-issued loopback development session capability',
    )
  const capability = randomBytes(32).toString('hex')
  const binary = await build(true)
  const output = await mkdtemp(join(root, '.ab/proa-frames-'))
  console.log(`Evidence: ${output}`)
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const port = reservation.port!
  reservation.stop(true)
  // A clean cwd outside the checkout prevents dotenvy's ancestor search from
  // loading repository production settings. Assets remain the real worktree assets.
  const runtime = await mkdtemp(join(tmpdir(), 'proa-runtime-'))
  await symlink(join(project, 'public'), join(runtime, 'public'))
  const server = Bun.spawn([binary], {
    cwd: runtime,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PROA_HOST: '127.0.0.1',
      PORT: String(port),
      RUST_LOG: 'info',
      PROA_AUTH_URL: `http://127.0.0.1:${port}`,
      GITHUB_CLIENT_ID: 'capture-id',
      GITHUB_CLIENT_SECRET: randomBytes(32).toString('hex'),
      PROA_SESSION_SECRET: randomBytes(32).toString('hex'),
      AB_WEB_ALLOWED_EMAILS: 'operator@example.com',
      PROA_ENV: 'development',
      PROA_DEV_AUTH: 'true',
      PROA_DEV_AUTH_EMAIL: 'operator@example.com',
      PROA_DEV_AUTH_CAPABILITY: capability,
    },
    stdout: Bun.file(join(output, 'server.log')),
    stderr: Bun.file(join(output, 'server-errors.log')),
  })
  const refusalReservation = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(),
  })
  const refusalPort = refusalReservation.port!
  refusalReservation.stop(true)
  const refusalOrigin = `http://127.0.0.1:${refusalPort}`
  const refusalServer = Bun.spawn([binary], {
    cwd: runtime,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PROA_HOST: '127.0.0.1',
      PORT: String(refusalPort),
      PROA_AUTH_URL: refusalOrigin,
      GITHUB_CLIENT_ID: 'capture-id',
      GITHUB_CLIENT_SECRET: randomBytes(32).toString('hex'),
      PROA_SESSION_SECRET: randomBytes(32).toString('hex'),
      AB_WEB_ALLOWED_EMAILS: 'operator@example.com',
      PROA_ENV: 'development',
      PROA_DEV_AUTH: 'true',
      PROA_DEV_AUTH_EMAIL: 'refused@example.com',
      PROA_DEV_AUTH_CAPABILITY: capability,
    },
    stdout: Bun.file(join(output, 'refusal-server.log')),
    stderr: Bun.file(join(output, 'refusal-server-errors.log')),
  })
  const stopServer = () => {
    server.kill()
    refusalServer.kill()
  }
  process.once('SIGTERM', stopServer)
  process.once('SIGINT', stopServer)
  const origin = `http://127.0.0.1:${port}`
  try {
    let ready = false
    for (let i = 0; i < 200; i++) {
      if (server.exitCode !== null) throw Error('Server exited before readiness')
      try {
        if ((await fetch(`${origin}/readyz`)).ok && (await fetch(`${refusalOrigin}/readyz`)).ok) {
          ready = true
          break
        }
      } catch {}
      await Bun.sleep(50)
    }
    if (!ready) throw Error('Server readiness timeout')
    for (const path of ['/health', '/readyz', '/sign-in', '/static/styles.css'])
      if (!(await fetch(origin + path)).ok) throw Error(`Response smoke failed: ${path}`)
    return await captureFrames(origin, output, { capability, refusalOrigin })
  } finally {
    stopServer()
    await Promise.all([server.exited, refusalServer.exited])
    await rm(runtime, { recursive: true, force: true })
    process.removeListener('SIGTERM', stopServer)
    process.removeListener('SIGINT', stopServer)
  }
}

export async function captureFrames(
  origin: string,
  output: string,
  auth?: { capability: string; refusalOrigin: string },
) {
  checkFrameMatrix(frames)
  let browser: ReturnType<typeof Bun.spawn> | undefined
  let socket: WebSocket | undefined
  const profile = join(output, 'profile')
  const cleanup = () => {
    socket?.close()
    browser?.kill()
  }
  process.once('SIGTERM', cleanup)
  process.once('SIGINT', cleanup)
  try {
    await mkdir(profile)
    browser = Bun.spawn(
      [
        process.env.CHROMIUM_BIN || '/usr/bin/chromium',
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-background-networking',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        'about:blank',
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    let debugPort = ''
    for (let i = 0; i < 200; i++) {
      if (browser.exitCode !== null) throw Error('Chromium exited before readiness')
      try {
        debugPort = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]!
        break
      } catch {
        await Bun.sleep(50)
      }
    }
    if (!debugPort) throw Error('Chromium startup timeout')
    const target = (await (
      await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })
    ).json()) as { webSocketDebuggerUrl: string }
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    socket = ws
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(Error('CDP connection failed'))
    })
    let sequence = 0
    const pending = new Map<number, { resolve: (v: Reply) => void; reject: (e: Error) => void }>()
    const errors: string[] = []
    const send = (method: string, params: Record<string, unknown> = {}): Promise<Reply> =>
      new Promise((resolve, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(Error(`CDP timeout: ${method}`))
        }, 10000)
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer)
            resolve(v)
          },
          reject: (e) => {
            clearTimeout(timer)
            reject(e)
          },
        })
        ws.send(JSON.stringify({ id, method, params }))
      })
    ws.onmessage = (event) => {
      const r = JSON.parse(String(event.data))
      const p = pending.get(r.id)
      if (p) {
        pending.delete(r.id)
        r.error ? p.reject(Error(JSON.stringify(r.error))) : p.resolve(r.result)
        return
      }
      if (r.method === 'Fetch.requestPaused') {
        // Chromium invents an implicit favicon request for pages with no icon.
        // It is not an application asset; leave explicit Image requests checked.
        if (r.params.resourceType === 'Other' && r.params.request.url === `${origin}/favicon.ico`) {
          void send('Fetch.fulfillRequest', { requestId: r.params.requestId, responseCode: 204 })
          return
        }
        const local =
          r.params.request.url.startsWith(`${origin}/`) ||
          Boolean(auth && r.params.request.url.startsWith(`${auth.refusalOrigin}/`))
        if (auth && r.params.request.url === `${auth.refusalOrigin}/auth/dev-session`) {
          void send('Fetch.continueRequest', {
            requestId: r.params.requestId,
            method: 'POST',
            headers: [
              ...Object.entries(r.params.request.headers).map(([name, value]) => ({ name, value })),
              { name: 'x-proa-dev-capability', value: auth.capability },
            ],
          })
          return
        }
        if (!local) errors.push(`External request: ${r.params.request.url}`)
        void send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
          requestId: r.params.requestId,
          ...(local ? {} : { errorReason: 'BlockedByClient' }),
        })
      }
      if (r.method === 'Runtime.exceptionThrown' || r.method === 'Network.loadingFailed')
        errors.push(JSON.stringify(r))
      if (
        r.method === 'Network.responseReceived' &&
        r.params.response.status >= 400 &&
        !(
          auth &&
          r.params.response.status === 403 &&
          r.params.response.url === `${auth.refusalOrigin}/auth/dev-session`
        )
      )
        errors.push(`HTTP ${r.params.response.status}: ${r.params.response.url}`)
    }
    for (const method of [
      'Page.enable',
      'Runtime.enable',
      'Network.enable',
      'DOM.enable',
      'CSS.enable',
      'Fetch.enable',
    ])
      await send(method)
    const evaluate = async (expression: string) => {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    const reference = await Bun.file(join(project, 'design/ansi/index.html')).text()
    const inventory = []
    for (const frame of frames) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: frame.width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: frame.theme }],
      })
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `window.__captureFrame=${JSON.stringify(frame.id)};localStorage.setItem('proa-theme',${JSON.stringify(frame.theme)})`,
      })
      await send('Network.clearBrowserCookies')
      if (auth && (frame.state === 'closed' || frame.state === 'open')) {
        const issued = await fetch(`${origin}/auth/dev-session`, {
          method: 'POST',
          headers: { 'x-proa-dev-capability': auth.capability },
          redirect: 'manual',
        })
        if (issued.status !== 303) throw Error('Development issuer refused capture identity')
        for (const line of issued.headers.getSetCookie()) {
          if (line.includes('Max-Age=0')) continue
          const [pair] = line.split(';')
          const at = pair!.indexOf('=')
          await send('Network.setCookie', {
            name: pair!.slice(0, at),
            value: pair!.slice(at + 1),
            url: origin,
            httpOnly: true,
            sameSite: 'Lax',
            path: '/',
          })
        }
      }
      await send('Page.navigate', {
        url: (frame.state === 'refused' && auth ? auth.refusalOrigin : origin) + frame.route,
      })
      let loaded = false
      for (let i = 0; i < 200; i++) {
        if (
          await evaluate(
            `window.__captureFrame === ${JSON.stringify(frame.id)} && document.readyState === 'complete' && Boolean(document.querySelector('${frame.state === 'sign-in' || frame.state === 'refused' ? '[data-page="sign-in"]' : '#account-trigger'}'))`,
          )
        ) {
          loaded = true
          break
        }
        await Bun.sleep(50)
      }
      if (!loaded) throw Error('Page readiness timeout')
      await evaluate(
        `document.documentElement.dataset.theme=${JSON.stringify(frame.theme)};Promise.all([document.fonts.load('16px "Atkinson Hyperlegible Next"'),document.fonts.load('16px "JetBrains Mono"')]).then(()=>document.fonts.ready)`,
      )
      if (frame.state === 'open')
        await evaluate("document.querySelector('#account-trigger').click()")
      const result = await evaluate(
        `(${probe.toString()})(${JSON.stringify(palette(reference, frame.theme))},${JSON.stringify(frame.state)},${JSON.stringify(frame.theme)})`,
      )
      const doc = await send('DOM.getDocument', { depth: -1 })
      const nodes = await send('DOM.querySelectorAll', {
        nodeId: doc.root.nodeId,
        selector: 'body *',
      })
      const fonts = new Set<string>()
      for (const nodeId of nodes.nodeIds) {
        const usage = await send('CSS.getPlatformFontsForNode', { nodeId })
        for (const font of usage.fonts)
          if (font.glyphCount) {
            fonts.add(font.familyName)
            if (!['Atkinson Hyperlegible Next', 'JetBrains Mono'].includes(font.familyName))
              result.failures.push(`Rendered fallback face: ${font.familyName}`)
          }
      }
      if (!fonts.size || !result.textElements)
        result.failures.push('Missing rendered text/font evidence')
      if (errors.length) result.failures.push(...errors)
      if (result.failures.length) throw Error(`${frame.id}: ${result.failures.join('; ')}`)
      if (result.height > 32768) throw Error('Page exceeds capture height limit')
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: frame.width, height: result.height, scale: 1 },
      })
      const png = join(output, `${frame.id}.png`)
      const bytes = decodePng(shot.data)
      await Bun.write(png, bytes)
      inventory.push({ ...frame, png, probe: result, fonts: [...fonts] })
      if (auth && frame.state === 'open') {
        const behavior = await evaluate(`(() => {
          const trigger = document.querySelector('#account-trigger');
          const panel = document.querySelector('#account-panel');
          const opposite = ${JSON.stringify(frame.theme === 'light' ? 'dark' : 'light')};
          panel.querySelector('[data-choice="' + opposite + '"]').click();
          if (document.documentElement.dataset.theme !== opposite || localStorage.getItem('proa-theme') !== opposite || !panel.hidden || document.activeElement !== trigger) return false;
          trigger.click();
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          if (!panel.hidden || document.activeElement !== trigger) return false;
          trigger.click(); document.body.click();
          return panel.hidden && trigger.getAttribute('aria-expanded') === 'false';
        })()`)
        if (!behavior) throw Error('Theme/disclosure behavior failed under CSP')
      }
    }
    if (auth) {
      const issued = await fetch(`${origin}/auth/dev-session`, {
        method: 'POST',
        headers: { 'x-proa-dev-capability': auth.capability },
        redirect: 'manual',
      })
      const line = issued.headers
        .getSetCookie()
        .find((c) => c.startsWith('proa-session=') && !c.includes('Max-Age=0'))!
      const pair = line.split(';')[0]!
      await send('Network.clearBrowserCookies')
      await send('Network.setCookie', {
        name: 'proa-session',
        value: pair.slice(pair.indexOf('=') + 1),
        url: origin,
        httpOnly: true,
        sameSite: 'Lax',
      })
      await send('Page.navigate', { url: origin })
      for (let i = 0; i < 100; i++) {
        if (await evaluate("Boolean(document.querySelector('[data-sign-out]'))")) break
        await Bun.sleep(50)
      }
      await evaluate(
        "document.querySelector('#account-trigger').click(); document.querySelector('[data-sign-out] button').click()",
      )
      for (let i = 0; i < 100; i++) {
        if (await evaluate("Boolean(document.querySelector('[data-page=sign-in]'))")) break
        await Bun.sleep(50)
      }
      const replay = await fetch(origin, { headers: { cookie: pair }, redirect: 'manual' })
      if (replay.status !== 307) throw Error('Logout did not revoke the copied session')
      if (errors.length) throw Error(errors.join('; '))
    }
    if (inventory.length !== frames.length) throw Error('Incomplete frame matrix')
    await Bun.write(join(output, 'inventory.json'), JSON.stringify(inventory, null, 2))
    await Bun.write(
      join(output, 'verify-report.md'),
      `# Proa visual verification\n\nDeterministic probes passed for ${inventory.length} frames. Database: none. Auth: server-issued loopback development sessions; real refused issuance, public sign-in, protected Builds and account menu.\n\nAgent must open every PNG and append observations on palette, two faces, overflow, route content, shell/menu composition and reference fidelity.\n\nVisual verdict: PENDING\n`,
    )
    return output
  } finally {
    cleanup()
    if (browser) await browser.exited
    process.removeListener('SIGTERM', cleanup)
    process.removeListener('SIGINT', cleanup)
    await rm(profile, { recursive: true, force: true })
  }
}
export function decodePng(data?: string) {
  const bytes = Buffer.from(data || '', 'base64')
  if (bytes.length < 100 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
    throw Error('Missing/empty PNG')
  return bytes
}
if (import.meta.main) console.log(await capture())
