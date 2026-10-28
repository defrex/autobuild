import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export function documentClip(width: number, viewportHeight: number, contentHeight: unknown) {
  if (typeof contentHeight !== 'number' || !Number.isFinite(contentHeight) || contentHeight <= 0)
    throw Error('invalid document height')
  return { x: 0, y: 0, width, height: Math.max(viewportHeight, Math.ceil(contentHeight)), scale: 1 }
}

export function screenshotBytes(data: unknown, width: number, height: number): Buffer {
  if (typeof data !== 'string' || !data.length) throw Error('empty screenshot data')
  const png = Buffer.from(data, 'base64')
  if (
    png.length < 24 ||
    !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
    png.toString('ascii', 12, 16) !== 'IHDR' ||
    png.readUInt32BE(16) !== width ||
    png.readUInt32BE(20) !== height
  )
    throw Error('invalid screenshot PNG dimensions')
  return png
}

/** Runs in Chromium after the final reload; uses the production backdrop rule. */
export async function prepareConfirmationDialogs() {
  const dialogs = [...document.querySelectorAll<HTMLDialogElement>('dialog.confirm-dialog[open]')]
  for (const dialog of dialogs) {
    if (!dialog.matches(':modal')) {
      dialog.close()
      dialog.showModal()
    }
  }
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
  const probe = document.createElement('span')
  document.body.append(probe)
  try {
    const normalize = (color: string) => {
      probe.style.backgroundColor = color
      return getComputedStyle(probe).backgroundColor
    }
    return dialogs.map((dialog) => {
      const ground = getComputedStyle(dialog).getPropertyValue('--ground').trim()
      const expected = normalize(`color-mix(in srgb, ${ground} 72%, transparent)`)
      const backdrop = normalize(getComputedStyle(dialog, '::backdrop').backgroundColor)
      // Compare browser-resolved channels and alpha, independent of CSS serialization.
      const pixel = (color: string) => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')!
        context.fillStyle = color
        context.fillRect(0, 0, 1, 1)
        return [...context.getImageData(0, 0, 1, 1).data]
      }
      const actualPixel = pixel(backdrop)
      if (!dialog.open || !dialog.matches(':modal')) throw Error('Confirmation is not modal')
      if (!actualPixel[3] || JSON.stringify(actualPixel) !== JSON.stringify(pixel(expected)))
        throw Error(`Confirmation backdrop mismatch: ${backdrop}; expected ${expected}`)
      return { modal: true, backdrop, expected }
    })
  } finally {
    probe.remove()
  }
}

export const confirmationPreparationExpression = `(${prepareConfirmationDialogs.toString()})()`

type Reply = {
  result?: { value?: unknown }
  exceptionDetails?: unknown
  cssContentSize?: { height: number }
  data?: string
  errorText?: string
}

/** Request ownership is local to one socket: every terminal path clears its timers. */
export function debuggerRequests(
  ws: Pick<WebSocket, 'send' | 'onclose' | 'onerror' | 'onmessage'>,
  timeout: () => number,
) {
  let sequence = 0
  let failure: Error | undefined
  const pending = new Map<
    number,
    { resolve: (reply: Reply) => void; reject: (error: Error) => void }
  >()
  const fail = (error: Error) => {
    failure = error
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  ws.onclose = () => fail(Error('Chromium debugger closed'))
  ws.onerror = () => fail(Error('Chromium debugger failed'))
  ws.onmessage = (event) => {
    try {
      const reply = JSON.parse(String(event.data))
      const request = pending.get(reply.id)
      if (!request) return
      pending.delete(reply.id)
      if (reply.error) request.reject(Error(JSON.stringify(reply.error)))
      else request.resolve(reply.result)
    } catch {
      fail(Error('invalid Chromium debugger reply'))
    }
  }
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Reply>((resolve, reject) => {
      if (failure) {
        reject(failure)
        return
      }
      const duration = timeout()
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(Error(`${method} timed out`))
      }, duration)
      pending.set(id, {
        resolve: (reply) => {
          clearTimeout(timer)
          resolve(reply)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        ws.send(JSON.stringify({ id, method, params }))
      } catch {
        pending.get(id)?.reject(Error('Chromium send failed'))
        pending.delete(id)
      }
    })
  return { send, close: () => fail(Error('Chromium capture ended')) }
}

/** One bounded browser lifetime; callers own fresh profiles and retries. */
export async function fullDocumentScreenshot(
  chromium: string,
  url: string,
  pngPath: string,
  width: number,
  height: number,
  profile: string,
) {
  const proc = Bun.spawn(
    [
      chromium,
      '--headless=new',
      '--hide-scrollbars',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      '--run-all-compositor-stages-before-draw',
      '--disable-features=PaintHolding',
      '--force-device-scale-factor=1',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdout: 'ignore', stderr: 'ignore', timeout: 90_000 },
  )
  let socket: WebSocket | undefined
  let protocol: ReturnType<typeof debuggerRequests> | undefined
  const deadline = Date.now() + 90_000
  const assertLive = () => {
    if (proc.exitCode !== null) throw Error(`Chromium exited ${proc.exitCode}`)
    if (Date.now() >= deadline) throw Error('Chromium capture timed out')
  }
  try {
    let port = ''
    while (!port) {
      assertLive()
      try {
        port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]!
      } catch {
        await Bun.sleep(50)
      }
    }
    const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: 'PUT',
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    })
    if (!response.ok) throw Error(`Chromium target: ${response.status}`)
    const target = (await response.json()) as { webSocketDebuggerUrl: string }
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    socket = ws
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error('Chromium debugger connection timed out')),
        10_000,
      )
      ws.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      ws.onerror = ws.onclose = () => {
        clearTimeout(timer)
        reject(Error('Chromium debugger connection failed'))
      }
    })
    protocol = debuggerRequests(ws, () => {
      assertLive()
      return Math.min(10_000, deadline - Date.now())
    })
    const send = protocol.send
    const evaluate = async (expression: string) => {
      const reply = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      if (reply.exceptionDetails)
        throw Error(`Chromium evaluation failed: ${JSON.stringify(reply.exceptionDetails)}`)
      return reply.result?.value
    }
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    // Match CLI foreground-page behavior, including native input autofocus.
    await send('Page.bringToFront')
    // Native form controls can retain fallback glyphs from their first layout.
    // Reload with both packaged faces cached before measuring or capturing.
    for (let load = 0; load < 2; load++) {
      if (load === 1) {
        await evaluate('document.documentElement.dataset.captureReload = "true"')
        await send('Page.reload')
      } else {
        const navigation = await send('Page.navigate', { url })
        if (navigation.errorText) throw Error(navigation.errorText)
      }
      while (
        !(await evaluate(
          `location.href === ${JSON.stringify(url)} && document.readyState === 'complete' && !document.documentElement.dataset.captureReload`,
        ))
      ) {
        assertLive()
        await Bun.sleep(50)
      }
      await evaluate(
        `(async () => { await document.fonts.ready; for (const face of ['ANSI sans', 'ANSI mono']) { const loaded = await document.fonts.load('16px "' + face + '"'); if (!loaded.length || loaded.some(f => f.status !== 'loaded')) throw Error('Missing packaged font: ' + face); } await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return true; })()`,
      )
    }
    const confirmations = await evaluate(confirmationPreparationExpression)
    const metrics = await send('Page.getLayoutMetrics')
    const clip = documentClip(width, height, metrics.cssContentSize?.height)
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip,
    })
    await writeFile(pngPath, screenshotBytes(shot.data, width, clip.height))
    return { width, height: clip.height, confirmations }
  } finally {
    protocol?.close()
    socket?.close()
    proc.kill()
    await proc.exited
  }
}
