import { seedConsentCapture } from './mcp-capture-seed'
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { withCaptureSeed, type SeedEvidence } from './capture-seed'
import type { BuildStore } from '../../../packages/core/src/store/types'
import { build, project, root } from './verify'
import { runExtendedBrowserProof } from './browser-extended-proof'
import {
  checkRoutes,
  checkOAuthRoutes,
  checkCaptureCapabilities,
  checkFrameMatrix,
  frames,
  palette,
  probe,
  dataFontFallback,
} from './capture-cases'

interface Reply {
  result: { value: ReturnType<typeof probe> & boolean }
  exceptionDetails?: unknown
  root: { nodeId: number }
  nodeIds: number[]
  fonts: { glyphCount: number; familyName: string }[]
  data?: string
}

export async function capture() {
  return withCaptureSeed((seedEnv, seed, store) => captureSeeded(seedEnv, seed, store))
}
async function captureSeeded(
  seedEnv: Record<string, string | undefined>,
  seed: SeedEvidence,
  store: BuildStore,
) {
  checkRoutes(
    await Bun.file(join(project, 'src/routes.rs')).text(),
    await Bun.file(join(project, 'src/protocol/router.rs')).text(),
  )
  checkOAuthRoutes(
    await Bun.file(join(project, 'src/oauth/http.rs')).text(),
    await Bun.file(join(project, 'src/routes.rs')).text(),
  )
  const sources = await Array.fromAsync(
    new Bun.Glob('src/{pages,endpoints}/**/*.rs').scan({ cwd: project }),
  )
  const sourceFiles = Object.fromEntries(
    await Promise.all(
      sources.map(async (path) => [path, await Bun.file(join(project, path)).text()] as const),
    ),
  )
  const source = Object.values(sourceFiles).join('\n')
  const config = await Bun.file(join(project, 'proa.config.json')).json()
  checkCaptureCapabilities(config.database.driver, sourceFiles)
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
  const reservation = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(),
  })
  const port = reservation.port!
  reservation.stop(true)
  // A clean cwd outside the checkout prevents dotenvy's ancestor search from
  // loading repository production settings. Assets remain the real worktree assets.
  const runtime = await mkdtemp(join(tmpdir(), 'proa-runtime-'))
  await symlink(join(project, 'public'), join(runtime, 'public'))
  const server = Bun.spawn([binary], {
    cwd: runtime,
    env: {
      ...seedEnv,
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PROA_HOST: '127.0.0.1',
      PORT: String(port),
      RUST_LOG: 'info,proa_server::data::reader=debug,proa_server::data::postgres=debug',
      PROA_AUTH_URL: `http://127.0.0.1:${port}`,
      GITHUB_CLIENT_ID: 'capture-id',
      GITHUB_CLIENT_SECRET: randomBytes(32).toString('hex'),
      PROA_SESSION_SECRET: randomBytes(32).toString('hex'),
      AB_WEB_ALLOWED_EMAILS: 'operator@example.com',
      AB_STORE_SECRET: randomBytes(32).toString('hex'),
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
      AB_STORE_SECRET: randomBytes(32).toString('hex'),
      PROA_ENV: 'development',
      PROA_DEV_AUTH: 'true',
      PROA_DEV_AUTH_EMAIL: 'refused@example.com',
      PROA_DEV_AUTH_CAPABILITY: capability,
    },
    stdout: Bun.file(join(output, 'refusal-server.log')),
    stderr: Bun.file(join(output, 'refusal-server-errors.log')),
  })
  const backendReservation = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(),
  })
  const backendPort = backendReservation.port!
  backendReservation.stop(true)
  const backendOrigin = `http://127.0.0.1:${backendPort}`
  const backendServer = Bun.spawn([binary], {
    cwd: runtime,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PROA_HOST: '127.0.0.1',
      PORT: String(backendPort),
      PROA_AUTH_URL: backendOrigin,
      GITHUB_CLIENT_ID: 'capture-id',
      GITHUB_CLIENT_SECRET: randomBytes(32).toString('hex'),
      PROA_SESSION_SECRET: randomBytes(32).toString('hex'),
      AB_WEB_ALLOWED_EMAILS: 'operator@example.com',
      AB_STORE_SECRET: randomBytes(32).toString('hex'),
      PROA_ENV: 'development',
      PROA_DEV_AUTH: 'true',
      PROA_DEV_AUTH_EMAIL: 'operator@example.com',
      PROA_DEV_AUTH_CAPABILITY: capability,
    },
    stdout: Bun.file(join(output, 'backend-unavailable-server.log')),
    stderr: Bun.file(join(output, 'backend-unavailable-server-errors.log')),
  })
  const stopServer = () => {
    server.kill()
    refusalServer.kill()
    backendServer.kill()
  }
  process.once('SIGTERM', stopServer)
  process.once('SIGINT', stopServer)
  const origin = `http://127.0.0.1:${port}`
  try {
    let ready = false
    for (let i = 0; i < 200; i++) {
      if (server.exitCode !== null) throw Error('Server exited before readiness')
      try {
        if (
          (await fetch(`${origin}/readyz`)).ok &&
          (await fetch(`${refusalOrigin}/readyz`)).ok &&
          (await fetch(`${backendOrigin}/readyz`)).ok
        ) {
          ready = true
          break
        }
      } catch {}
      await Bun.sleep(50)
    }
    if (!ready) throw Error('Server readiness timeout')
    for (const path of ['/health', '/readyz', '/sign-in', '/static/styles.css'])
      if (!(await fetch(origin + path)).ok) throw Error(`Response smoke failed: ${path}`)
    seed.consent = await seedConsentCapture(origin, capability, seedEnv.PROA_POSTGRES_WRITE_URL!)
    const captured = await captureFrames(origin, output, {
      capability,
      refusalOrigin,
      backendOrigin,
      seed,
      store,
    })
    const log = await Bun.file(join(output, 'server.log')).text()
    const reads = log.split('\n').flatMap((line) => {
      const match = line.replace(/\x1b\[[0-9;]*m/g, '').match(/suffix-read (\{.*\})/)
      return match ? [JSON.parse(match[1]!)] : []
    }) as { project: string; scope: string; after: number; rows: number }[]
    for (const scope of [
      'metadata:projects',
      'metadata:build-discovery',
      'metadata:streams:',
      'metadata:artifact:',
      'metadata:build-record:',
    ])
      if (!reads.some((read) => read.scope.startsWith(scope)))
        throw Error(`Missing actual SQL metadata evidence: ${scope}`)
    const events = reads.filter((read) => read.scope.startsWith('build:'))
    if (
      !events.some((read) => read.after > 0 && read.rows === 0) ||
      !events.some((read) => read.after > 0 && read.rows > 0)
    )
      throw Error('Missing actual SQL suffix/idle evidence')
    if (
      !reads.some(
        (read) => read.scope.startsWith('stream:') && read.after > 0 && read.rows === 0,
      ) ||
      !reads.some((read) => read.scope.startsWith('stream:') && read.after > 0 && read.rows > 0)
    )
      throw Error('Missing live transcript suffix evidence')
    const blobs = reads.filter((read) => read.scope.startsWith('artifact:'))
    const keys = blobs.map((read) => `${read.project}:${read.scope}`)
    if (new Set(keys).size !== keys.length) throw Error('Immutable artifact downloaded repeatedly')
    await Bun.write(join(output, 'sql-evidence.json'), JSON.stringify(reads, null, 2))
    return captured
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
  auth?: {
    capability: string
    refusalOrigin: string
    backendOrigin?: string
    seed?: SeedEvidence
    store?: BuildStore
  },
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
      await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, {
        method: 'PUT',
      })
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
    const intercept = (method: string, params: Record<string, unknown>) => {
      void send(method, params).catch((error: unknown) => {
        // Navigation or shutdown may retire a paused request before Chromium
        // receives its continuation. Every other CDP failure remains fatal.
        if (
          !(error instanceof Error) ||
          error.message !== '{"code":-32602,"message":"Invalid InterceptionId."}'
        )
          throw error
      })
    }
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
        if (
          r.params.resourceType === 'Other' &&
          [origin, auth?.refusalOrigin, auth?.backendOrigin]
            .filter(Boolean)
            .some((base) => r.params.request.url === `${base}/favicon.ico`)
        ) {
          intercept('Fetch.fulfillRequest', {
            requestId: r.params.requestId,
            responseCode: 204,
          })
          return
        }
        const local =
          r.params.request.url.startsWith(`${origin}/`) ||
          Boolean(auth && r.params.request.url.startsWith(`${auth.refusalOrigin}/`)) ||
          Boolean(auth?.backendOrigin && r.params.request.url.startsWith(`${auth.backendOrigin}/`))
        if (auth && r.params.request.url === `${auth.refusalOrigin}/auth/dev-session`) {
          intercept('Fetch.continueRequest', {
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
        intercept(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
          requestId: r.params.requestId,
          ...(local ? {} : { errorReason: 'BlockedByClient' }),
        })
      }
      if (
        r.method === 'Runtime.exceptionThrown' ||
        (r.method === 'Network.loadingFailed' && !r.params.canceled)
      )
        errors.push(JSON.stringify(r))
      if (
        r.method === 'Network.responseReceived' &&
        r.params.response.status >= 400 &&
        !expectedConnectCaptureResponse(
          r.params.response.status,
          r.params.response.url,
          origin,
          auth?.backendOrigin,
          auth?.seed?.connect,
        ) &&
        !(
          auth &&
          r.params.response.status === 403 &&
          r.params.response.url === `${auth.refusalOrigin}/auth/dev-session`
        ) &&
        !(
          auth &&
          r.params.response.status === 409 &&
          r.params.response.url === `${origin}/controls`
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
      const frameOrigin =
        frame.state === 'refused' && auth
          ? auth.refusalOrigin
          : frame.state === 'connect-error' && auth?.backendOrigin
            ? auth.backendOrigin
            : origin
      if (auth && !['sign-in', 'refused'].includes(frame.state)) {
        const issued = await fetch(`${frameOrigin}/auth/dev-session`, {
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
            url: frameOrigin,
            httpOnly: true,
            sameSite: 'Lax',
            path: '/',
          })
        }
      }
      const scenario = ['sign-in', 'refused'].includes(frame.state)
        ? 'auth-public'
        : frame.state === 'closed' || frame.state === 'open'
          ? 'prepareHappyScenario'
          : 'prepareScenario'
      const projectId = auth?.seed?.producers.find((p) => p.producer === scenario)?.project
      const detail = auth?.seed?.controls?.[frame.id] ?? auth?.seed?.detail
      const route =
        frame.state === 'detail' || frame.state.startsWith('control-')
          ? `/dashboard/builds/${detail?.slug ?? 'detail-case'}`
          : frame.route
      const query = frame.state.startsWith('consent-')
        ? `?${new URLSearchParams({ consent_code: auth?.seed?.consent?.[frame.state.slice(8)] ?? '' })}`
        : frame.state.startsWith('connect-')
          ? `?${new URLSearchParams({ code: auth?.seed?.connect?.[frame.state.slice(8)] ?? '' })}`
          : projectId && !['sign-in', 'refused'].includes(frame.state)
            ? `?${new URLSearchParams({ project: frame.state.startsWith('control-') ? detail!.project : projectId })}`
            : ''
      await send('Page.navigate', {
        url: frameOrigin + route + query,
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
      if (frame.state === 'detail')
        await evaluate("document.querySelectorAll('details').forEach(node=>node.open=true)")
      if (frame.state === 'open')
        await evaluate("document.querySelector('#account-trigger').click()")
      if (frame.state === 'control-confirmation') {
        await evaluate(`document.querySelector('button[value="confirm-abort"]').click()`)
        for (let i = 0; i < 100; i++) {
          if (
            await evaluate(`Boolean(document.querySelector('[data-control-form="confirmation"]'))`)
          )
            break
          await Bun.sleep(30)
        }
      }
      if (frame.state === 'control-refusal' && auth?.store && detail) {
        await auth.store.append(detail.slug, {
          actor: { kind: 'human', user: 'other@example.com' },
          type: 'escalation.answered',
          payload: {
            id: `${detail.slug}-question`,
            answer: 'Answered elsewhere',
            resolution: 'guidance',
          },
        })
        await evaluate(
          `document.querySelector('#answer-text').value='Keep this draft after the refusal';document.querySelector('button[value="guidance"]').click()`,
        )
        for (let i = 0; i < 100; i++) {
          if (await evaluate(`Boolean(document.querySelector('[data-control-error]'))`)) break
          await Bun.sleep(30)
        }
      }
      if (frame.state === 'control-refusal' || frame.state === 'control-confirmation') {
        await Bun.sleep(2400)
        const preserved =
          frame.state === 'control-refusal'
            ? await evaluate(
                `Boolean(document.querySelector('[data-control-error]')) && document.querySelector('#answer-text')?.value==='Keep this draft after the refusal'`,
              )
            : await evaluate(
                `Boolean(document.querySelector('[data-control-form="confirmation"]'))`,
              )
        if (!preserved) throw Error(`Polling erased ${frame.state}`)
        if (frame.state === 'control-refusal' && auth?.store && detail) {
          await auth.store.append(detail.slug, {
            actor: { kind: 'kernel' },
            type: 'build.paused',
            payload: {},
          })
          let refreshed = false
          for (let i = 0; i < 150; i++) {
            refreshed = Boolean(
              await evaluate(
                `Boolean(document.querySelector('button[value="resume"]')) && !document.querySelector('button[value="pause"]') && Boolean(document.querySelector('[data-control-error]')) && document.querySelector('#answer-text')?.value==='Keep this draft after the refusal'`,
              ),
            )
            if (refreshed) break
            await Bun.sleep(40)
          }
          if (!refreshed) throw Error('Refusal froze live action availability or lost its draft')
        }
      }
      const result = await evaluate(
        `(${probe.toString()})(${JSON.stringify(palette(reference, frame.theme))},${JSON.stringify(frame.state)},${JSON.stringify(frame.theme)})`,
      )
      const doc = await send('DOM.getDocument', { depth: -1 })
      const nodes = await send('DOM.querySelectorAll', {
        nodeId: doc.root.nodeId,
        selector: 'body *',
      })
      const fontContexts = (await evaluate(
        `Array.from(document.querySelectorAll('body *'),el=>({store:!!el.closest('[data-store-text]'),text:Array.from(el.childNodes).filter(n=>n.nodeType===3).map(n=>n.textContent).join(''),storedDescendants:el.closest('[data-store-text]')?el.textContent:Array.from(el.querySelectorAll('[data-store-text]')).map(n=>n.textContent).join('')}))`,
      )) as unknown as {
        store: boolean
        text: string
        storedDescendants: string
      }[]
      const fonts = new Set<string>()
      const dataFallbacks: { family: string; text: string }[] = []
      for (const [index, nodeId] of nodes.nodeIds.entries()) {
        const usage = await send('CSS.getPlatformFontsForNode', { nodeId })
        for (const font of usage.fonts)
          if (font.glyphCount) {
            fonts.add(font.familyName)
            if (!['Atkinson Hyperlegible Next', 'JetBrains Mono'].includes(font.familyName)) {
              const context = fontContexts[index]!
              if (dataFontFallback(font.familyName, context.text, context.store))
                dataFallbacks.push({
                  family: font.familyName,
                  text: context.text,
                })
              // Chromium also reports child glyphs against their containing block.
              // Every descendant is checked separately; this only avoids rejecting
              // its duplicate aggregate when the wrapper paints no direct text.
              else if (
                context.text.trim() ||
                !dataFontFallback(font.familyName, context.storedDescendants, true)
              )
                result.failures.push(
                  `Rendered fallback face: ${font.familyName} (${context.store ? 'store' : 'interface'}: ${context.text.slice(0, 160)})`,
                )
            }
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
        clip: {
          x: 0,
          y: 0,
          width: frame.width,
          height: result.height,
          scale: 1,
        },
      })
      const png = join(output, `${frame.id}.png`)
      const bytes = decodePng(shot.data)
      await Bun.write(png, bytes)
      inventory.push({
        ...frame,
        route: frame.state.startsWith('consent-')
          ? `${route}?consent_code=[REDACTED]`
          : route + query,
        scenario,
        project: projectId,
        build:
          frame.state === 'detail' || frame.state.startsWith('control-') ? detail?.slug : undefined,
        seed: captureSeedForEvidence(auth?.seed),
        png,
        probe: result,
        fonts: [...fonts],
        dataFallbacks,
      })
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
        if (
          await evaluate(
            "document.readyState==='complete' && Boolean(document.querySelector('[data-sign-out]'))",
          )
        )
          break
        await Bun.sleep(50)
      }
      await evaluate(
        "document.querySelector('#account-trigger').click(); document.querySelector('[data-sign-out] button').click()",
      )
      for (let i = 0; i < 100; i++) {
        if (await evaluate("Boolean(document.querySelector('[data-page=sign-in]'))")) break
        await Bun.sleep(50)
      }
      const replay = await fetch(origin, {
        headers: { cookie: pair },
        redirect: 'manual',
      })
      if (replay.status !== 307) throw Error('Logout did not revoke the copied session')
      if (errors.length) throw Error(errors.join('; '))
    }
    if (auth?.seed && auth.store) {
      const detail = auth.seed.detail
      const path = `/dashboard/builds/${detail.slug}?${new URLSearchParams({ project: detail.project })}`
      const issued = await fetch(`${origin}/auth/dev-session`, {
        method: 'POST',
        headers: { 'x-proa-dev-capability': auth.capability },
        redirect: 'manual',
      })
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
        })
      }
      const consentProof = []
      for (const decision of ['accept', 'deny']) {
        const consentCode = auth.seed?.consent?.[`browser-${decision}`]
        if (!consentCode) throw Error('Missing native consent proof seed')
        await send('Page.navigate', {
          url: `${origin}/oauth/consent?${new URLSearchParams({ consent_code: consentCode })}`,
        })
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await evaluate(`Boolean(document.querySelector('[data-consent-form]'))`)) break
          await Bun.sleep(30)
        }
        await evaluate(`document.querySelector('button[value="${decision}"]').click()`)
        let callback: URL | undefined
        for (let attempt = 0; attempt < 100; attempt++) {
          const current = new URL(String(await evaluate('location.href')))
          if (
            current.pathname === '/sign-in' &&
            (current.searchParams.has('code') || current.searchParams.has('error'))
          ) {
            callback = current
            break
          }
          await Bun.sleep(30)
        }
        if (callback?.searchParams.get('state') !== 'proa-consent-browser')
          throw Error('Native consent form did not reach the bound callback')
        if (decision === 'accept') {
          const response = await fetch(`${origin}/api/auth/mcp/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              client_id: auth.seed!.consent![`client-browser-${decision}`]!,
              redirect_uri: `${origin}/sign-in`,
              code: callback.searchParams.get('code')!,
              code_verifier: 'v'.repeat(43),
              resource: `${origin}/mcp`,
            }),
          })
          if (response.status !== 200)
            throw Error('Native consent authorization code was not redeemable')
          const tokens = await response.json()
          if (
            (
              await fetch(`${origin}/mcp`, {
                method: 'DELETE',
                headers: { authorization: `Bearer ${tokens.access_token}` },
              })
            ).status !== 200
          )
            throw Error('Native form did not authorize MCP')
        } else if (
          callback.searchParams.has('code') ||
          callback.searchParams.get('error') !== 'access_denied'
        )
          throw Error('Native denial issued a code')
        consentProof.push({
          decision,
          callbackBound: true,
          codeIssued: decision === 'accept',
          mcpAuthorized: decision === 'accept',
        })
      }
      await Bun.write(
        join(output, 'browser-consent-proof.json'),
        JSON.stringify(consentProof, null, 2),
      )
      const machineReply = await fetch(`${origin}/builds/${detail.slug}`, {
        headers: { accept: 'text/html' },
        redirect: 'manual',
      })
      if (
        machineReply.status !== 409 ||
        !machineReply.headers.get('content-type')?.startsWith('application/json') ||
        !(await machineReply.json()).error
      )
        throw Error('Machine build path entered browser routing')
      const browserReply = await fetch(origin + path, {
        headers: {
          cookie: issued.headers
            .getSetCookie()
            .map((line) => line.split(';')[0])
            .join('; '),
          accept: 'text/html',
        },
      })
      if (!browserReply.ok || !(await browserReply.text()).includes('data-page="build-detail"'))
        throw Error('Browser detail route did not render the seeded build')
      await send('Page.navigate', { url: origin + path })
      for (let i = 0; i < 100; i++) {
        if (await evaluate("Boolean(document.querySelector('[data-page=build-detail]'))")) break
        await Bun.sleep(50)
      }
      await evaluate('window.__documentIdentity=document')
      await auth.store.append(detail.slug, {
        actor: { kind: 'agent', role: 'implement', session: 'detail-session' },
        type: 'observation.recorded',
        payload: {
          id: 'live-evidence',
          kind: 'followup',
          summary: 'Live append evidence',
        },
      })
      const started = Date.now()
      let updated = false
      for (let i = 0; i < 100; i++) {
        if (
          await evaluate(
            "document.body.textContent.includes('live-evidence') && document===window.__documentIdentity",
          )
        ) {
          updated = true
          break
        }
        await Bun.sleep(50)
      }
      if (!updated || Date.now() - started > 5000)
        throw Error('Live event did not appear within five seconds in the same document')
      const stream = (await auth.store.listStreams({ kind: 'build', build: detail.slug })).find(
        (stream) => stream.label === 'session:detail-session',
      )
      if (!stream) throw Error('Missing live transcript seed')
      await evaluate("document.querySelectorAll('details').forEach(node=>node.open=true)")
      await auth.store.appendStreamParts(stream.id, [
        { type: 'text-delta', id: 'text', delta: ' Fresh transcript delta.' },
      ])
      let streamed = false
      for (let i = 0; i < 100; i++) {
        if (
          await evaluate(
            "document.body.textContent.includes('Fresh transcript delta.') && document===window.__documentIdentity && Boolean(document.querySelector('details[open]'))",
          )
        ) {
          streamed = true
          break
        }
        await Bun.sleep(50)
      }
      if (!streamed) throw Error('Live transcript suffix did not refresh in five seconds')
      // Drive the native forms in Chromium in both script modes. No synthetic
      // mutation endpoint is used: every click submits the rendered form.
      const formProof: unknown[] = []
      const outerHtml = async () => {
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            const doc = await send('DOM.getDocument', { depth: -1 })
            return (
              (await send('DOM.getOuterHTML', {
                nodeId: doc.root.nodeId,
              })) as unknown as {
                outerHTML: string
              }
            ).outerHTML
          } catch (error) {
            if (attempt === 9 || !String(error).includes('node')) throw error
            await Bun.sleep(30)
          }
        }
        throw Error('Browser document unavailable')
      }
      const click = async (selector: string) => {
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            const doc = await send('DOM.getDocument', { depth: -1 })
            const found = await send('DOM.querySelectorAll', {
              nodeId: doc.root.nodeId,
              selector,
            })
            const nodeId = found.nodeIds[0]
            if (!nodeId) throw Error(`Missing browser control: ${selector}`)
            await send('DOM.scrollIntoViewIfNeeded', { nodeId })
            const box = (await send('DOM.getBoxModel', {
              nodeId,
            })) as unknown as {
              model: { content: number[] }
            }
            const points = box.model.content
            const x = (points[0]! + points[2]!) / 2
            const y = (points[1]! + points[5]!) / 2
            await send('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x,
              y,
              button: 'left',
              clickCount: 1,
            })
            await send('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x,
              y,
              button: 'left',
              clickCount: 1,
            })
            return
          } catch (error) {
            if (attempt === 9 || !String(error).includes('node')) throw error
            // A real poll or navigation can retire a CDP node between reads.
            await Bun.sleep(30)
          }
        }
      }
      for (const mode of ['js', 'nojs']) {
        await send('Emulation.setScriptExecutionDisabled', {
          value: mode === 'nojs',
        })
        for (const action of [
          'pause',
          'cancel-pause',
          'resume',
          'abort',
          'discard',
          'guidance',
          'retry',
          'dismiss',
        ]) {
          const fixture = auth.seed.controls[`proof-${mode}-${action}`]!
          const before = (await auth.store.getEvents(fixture.slug)).length
          await send('Page.navigate', {
            url: `${origin}/dashboard/builds/${fixture.slug}?${new URLSearchParams({ project: fixture.project })}`,
          })
          let loaded = false
          for (let i = 0; i < 100; i++) {
            if (
              (await outerHtml()).includes(`<h1>${fixture.slug}</h1>`) &&
              (mode === 'nojs' || (await evaluate(`document.readyState==='complete'`)))
            ) {
              loaded = true
              break
            }
            await Bun.sleep(30)
          }
          if (!loaded) throw Error(`Browser proof did not load ${fixture.slug}`)
          if (mode === 'js') await evaluate('window.__controlDocument=document')
          if (action === 'guidance') {
            await click('#answer-text')
            await send('Input.insertText', {
              text: 'Continue with the approved plan.',
            })
            if (mode === 'js') {
              await Bun.sleep(2400)
              if (
                !(await evaluate(
                  `document.querySelector('#answer-text').value==='Continue with the approved plan.' && document.activeElement.id==='answer-text' && document.activeElement.selectionStart==='Continue with the approved plan.'.length`,
                ))
              )
                throw Error('Polling lost the guidance draft')
            }
          }
          if (action === 'abort' || action === 'discard') {
            await click(`button[value="confirm-${action}"]`)
            for (let i = 0; i < 100; i++) {
              if ((await outerHtml()).includes('name="confirmed"')) break
              await Bun.sleep(30)
            }
            if ((await auth.store.getEvents(fixture.slug)).length !== before)
              throw Error(`Destructive intent written before confirmation: ${mode} ${action}`)
          }
          await click(`button[value="${action}"]`)
          let delta = [] as Awaited<ReturnType<BuildStore['getEvents']>>
          for (let i = 0; i < 100; i++) {
            delta = (await auth.store.getEvents(fixture.slug)).slice(before)
            if (delta.length) break
            await Bun.sleep(30)
          }
          const expected = ['guidance', 'retry', 'dismiss'].includes(action)
            ? 'escalation.answered'
            : `build.${action === 'cancel-pause' ? 'resume' : action}-requested`
          if (!delta.some((event) => event.type === expected))
            throw Error(`Browser control did not write ${expected}: ${mode} ${action}`)
          if (
            delta.some(
              (event) =>
                event.actor.kind !== 'human' ||
                event.actor.user !== 'operator@example.com' ||
                'via' in event.actor,
            )
          )
            throw Error(`Browser identity mismatch: ${mode} ${action}`)
          if (mode === 'js') {
            for (let i = 0; i < 100; i++) {
              if (await evaluate(`Boolean(document.querySelector('[data-control-notice]'))`)) break
              await Bun.sleep(30)
            }
            if (!(await evaluate(`Boolean(document.querySelector('[data-control-notice]'))`)))
              throw Error(`Enhanced control did not render acknowledgment: ${action}`)
            if (!(await evaluate('document===window.__controlDocument')))
              throw Error(`Control reloaded document: ${action}`)
            if (action === 'pause') {
              await auth.store.append(fixture.slug, {
                actor: { kind: 'kernel' },
                type: 'build.paused',
                payload: {},
              })
              let refreshed = false
              for (let i = 0; i < 150; i++) {
                refreshed = Boolean(
                  await evaluate(
                    `Boolean(document.querySelector('button[value="resume"]')) && !document.querySelector('button[value="cancel-pause"]') && !document.querySelector('[data-control-notice]')`,
                  ),
                )
                if (refreshed) break
                await Bun.sleep(40)
              }
              if (!refreshed) throw Error('Pause acknowledgment froze live controls before Resume')
              if (!(await evaluate('document===window.__controlDocument')))
                throw Error('Pause acknowledgment reloaded the document')
              await auth.store.append(fixture.slug, {
                actor: {
                  kind: 'agent',
                  role: 'implement',
                  session: 'capture-later-question',
                },
                type: 'escalation.raised',
                payload: {
                  id: 'capture-later-question',
                  source: 'agent',
                  phase: 'implement',
                  refs: [],
                  question: 'A later question',
                },
              })
              let answerVisible = false
              for (let i = 0; i < 150; i++) {
                answerVisible = Boolean(
                  await evaluate(`Boolean(document.querySelector('[data-control-form="answer"]'))`),
                )
                if (answerVisible) break
                await Bun.sleep(40)
              }
              if (!answerVisible)
                throw Error('A later escalation did not reveal its live answer form')
            }
          }
          formProof.push({
            mode,
            action,
            events: delta.map((event) => event.type),
            identity: 'operator@example.com',
            ...(mode === 'js' && action === 'pause' ? { acknowledgedPauseOffersResume: true } : {}),
          })
        }
      }
      const extendedProof = await runExtendedBrowserProof({
        fixtures: auth.seed.extendedControls,
        store: auth.store,
        origin,
        driver: {
          scripts: async (enabled) => {
            await send('Emulation.setScriptExecutionDisabled', {
              value: !enabled,
            })
          },
          navigate: async (url) => {
            await send('Page.navigate', { url })
          },
          click,
          html: outerHtml,
          evaluate,
          type: async (selector, text) => {
            await click(selector)
            await send('Input.insertText', { text })
          },
        },
      })
      await Bun.write(
        join(output, 'browser-extended-proof.json'),
        JSON.stringify(extendedProof, null, 2),
      )
      const admissionFixture = auth.seed.controls['proof-js-pause']!
      const cookieHeader = issued.headers
        .getSetCookie()
        .filter((line) => !line.includes('Max-Age=0'))
        .map((line) => line.split(';')[0])
        .join('; ')
      const formHtml = await (
        await fetch(
          `${origin}/dashboard/builds/${admissionFixture.slug}?${new URLSearchParams({ project: admissionFixture.project })}`,
          { headers: { cookie: cookieHeader } },
        )
      ).text()
      const csrf = formHtml.match(/name="csrf" value="([^"]+)"/)?.[1]
      if (!csrf) throw Error('Browser CSRF field missing')
      const beforeAdmission = (await auth.store.getEvents(admissionFixture.slug)).length
      for (const [name, originHeader, token, projectId, expected] of [
        ['csrf', origin, 'wrong', admissionFixture.project, 403],
        ['origin', 'https://foreign.invalid', csrf, admissionFixture.project, 403],
        ['project', origin, csrf, auth.seed.producers[0]!.project, 404],
      ] as const) {
        const response = await fetch(`${origin}/controls`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            cookie: cookieHeader,
            origin: originHeader,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            csrf: token,
            project: projectId,
            slug: admissionFixture.slug,
            action: 'cancel-pause',
          }),
        })
        if (response.status !== expected)
          throw Error(`Browser ${name} boundary returned ${response.status}, expected ${expected}`)
        if ((await auth.store.getEvents(admissionFixture.slug)).length !== beforeAdmission)
          throw Error(`Browser ${name} refusal mutated state`)
        formProof.push({
          boundary: name,
          status: response.status,
          unchanged: true,
        })
      }
      await Bun.write(
        join(output, 'browser-control-proof.json'),
        JSON.stringify(formProof, null, 2),
      )
      await send('Emulation.setScriptExecutionDisabled', { value: false })
      await send('Page.navigate', { url: origin + path })
      await Bun.sleep(500)
      await Bun.sleep(4200)
      await send('Emulation.setScriptExecutionDisabled', { value: true })
      await send('Page.navigate', { url: origin + path })
      await Bun.sleep(500)
      const response = await fetch(origin + path, {
        headers: {
          cookie: issued.headers
            .getSetCookie()
            .map((line) => line.split(';')[0])
            .join('; '),
        },
      })
      if (!response.ok || !(await response.text()).includes('Stored spec'))
        throw Error('No-JS detail snapshot missing')
      const doc = await send('DOM.getDocument', { depth: -1 })
      const source = (await send('DOM.getOuterHTML', {
        nodeId: doc.root.nodeId,
      })) as unknown as {
        outerHTML: string
      }
      if (!source.outerHTML.includes('Stored spec') || !source.outerHTML.includes('data-sessions'))
        throw Error('No-JS detail DOM incomplete')
      await send('Page.navigate', {
        url: `${origin}/?${new URLSearchParams({ project: detail.project })}`,
      })
      await Bun.sleep(500)
      const listDoc = await send('DOM.getDocument', { depth: -1 })
      const listSource = (await send('DOM.getOuterHTML', {
        nodeId: listDoc.root.nodeId,
      })) as unknown as { outerHTML: string }
      if (
        !listSource.outerHTML.includes('root-node') ||
        !listSource.outerHTML.includes('unreadable')
      )
        throw Error('No-JS dashboard DOM incomplete')
      await send('Emulation.setScriptExecutionDisabled', { value: false })
    }
    if (inventory.length !== frames.length) throw Error('Incomplete frame matrix')
    await Bun.write(join(output, 'inventory.json'), JSON.stringify(inventory, null, 2))
    await Bun.write(
      join(output, 'verify-report.md'),
      `# Proa visual verification\n\nDeterministic probes passed for ${inventory.length} frames. Database: isolated loopback Postgres/S3, seeded before server startup through both scenario producers. ${auth?.seed ? JSON.stringify(captureSeedForEvidence(auth.seed)) : 'Fixture capture'}\n\nAuth: server-issued loopback development sessions; real refused issuance, public sign-in, protected Builds and account menu.\n\nAgent must open every PNG and append observations on palette, two faces, overflow, route content, shell/menu composition and reference fidelity.\n\nVisual verdict: PENDING\n`,
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
export function captureSeedForEvidence(seed?: SeedEvidence) {
  return (
    seed && {
      ...seed,
      consent:
        seed.consent &&
        Object.fromEntries(Object.keys(seed.consent).map((key) => [key, '[REDACTED]'])),
    }
  )
}
export function decodePng(data?: string) {
  const bytes = Buffer.from(data || '', 'base64')
  if (bytes.length < 100 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
    throw Error('Missing/empty PNG')
  return bytes
}
if (import.meta.main) console.log(await capture())

export function expectedConnectCaptureResponse(
  status: number,
  url: string,
  origin: string,
  backendOrigin?: string,
  codes?: Record<string, string>,
) {
  return (
    (status === 404 &&
      codes?.unknown !== undefined &&
      url === `${origin}/connect?${new URLSearchParams({ code: codes.unknown })}`) ||
    (status === 503 &&
      backendOrigin !== undefined &&
      codes?.error !== undefined &&
      url === `${backendOrigin}/connect?${new URLSearchParams({ code: codes.error })}`)
  )
}
