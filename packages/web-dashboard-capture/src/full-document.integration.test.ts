import { expect, test } from 'bun:test'
import { documentClip, screenshotBytes } from './full-document'

test('document clip preserves width and initial viewport ground', () => {
  expect(documentClip(390, 1800, 2400.2)).toEqual({
    x: 0,
    y: 0,
    width: 390,
    height: 2401,
    scale: 1,
  })
  expect(documentClip(1440, 1600, 400).height).toBe(1600)
  for (const height of [undefined, NaN, Infinity, 0, -1])
    expect(() => documentClip(390, 900, height)).toThrow()
})

test('screenshot rejects empty, malformed and mismatched PNGs', () => {
  for (const data of [undefined, '', 'garbage'])
    expect(() => screenshotBytes(data, 390, 2000)).toThrow()
  const header = Buffer.alloc(24)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(header)
  header.write('IHDR', 12)
  header.writeUInt32BE(390, 16)
  header.writeUInt32BE(2000, 20)
  expect(screenshotBytes(header.toString('base64'), 390, 2000)).toEqual(header)
  expect(() => screenshotBytes(header.toString('base64'), 390, 900)).toThrow()
})

test('debugger requests settle on protocol error, socket loss, timeout and cleanup', async () => {
  const { debuggerRequests } = await import('./full-document')
  for (const cause of ['reply', 'close', 'error', 'timeout', 'cleanup', 'send']) {
    const ws = {
      send: (_data: string) => {
        if (cause === 'send') throw Error('gone')
      },
      onclose: null,
      onerror: null,
      onmessage: null,
    } as unknown as WebSocket
    const protocol = debuggerRequests(ws, () => 5)
    const request = protocol.send('Page.captureScreenshot')
    const assertion = expect(request).rejects.toThrow()
    if (cause === 'reply')
      ws.onmessage?.call(ws, {
        data: JSON.stringify({ id: 1, error: { message: 'bad clip' } }),
      } as MessageEvent)
    if (cause === 'close') ws.onclose?.call(ws, {} as CloseEvent)
    if (cause === 'error') ws.onerror?.call(ws, {} as Event)
    if (cause === 'cleanup') protocol.close()
    await assertion
    protocol.close()
    await expect(protocol.send('Page.getLayoutMetrics')).rejects.toThrow('capture ended')
    // A fresh attempt has no retained failure or pending request IDs.
    const retry = debuggerRequests(ws, () => 100)
    if (cause !== 'send') {
      const reply = retry.send('Page.getLayoutMetrics')
      ws.onmessage?.call(ws, {
        data: JSON.stringify({ id: 1, result: { cssContentSize: { height: 2400 } } }),
      } as MessageEvent)
      expect((await reply).cssContentSize?.height).toBe(2400)
    }
    retry.close()
  }
})

test('early browser exit is reported and reaped before another attempt', async () => {
  const { fullDocumentScreenshot } = await import('./full-document')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const profile = await mkdtemp(join(tmpdir(), 'capture-exit-test-'))
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        fullDocumentScreenshot(
          '/bin/false',
          'about:blank',
          join(profile, 'out.png'),
          390,
          900,
          profile,
        ),
      ).rejects.toThrow('Chromium exited 1')
    }
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})

test('debugger requests forward protocol events and still resolve replies', async () => {
  const { debuggerRequests } = await import('./full-document')
  const ws = {
    send: (_data: string) => {},
    onclose: null,
    onerror: null,
    onmessage: null,
  } as unknown as WebSocket
  const events: [string, Record<string, unknown>][] = []
  const protocol = debuggerRequests(
    ws,
    () => 100,
    (method, params) => events.push([method, params]),
  )
  const reply = protocol.send('Runtime.enable')
  ws.onmessage?.call(ws, {
    data: JSON.stringify({
      method: 'Runtime.exceptionThrown',
      params: { exceptionDetails: { exceptionId: 1, text: 'Uncaught' } },
    }),
  } as MessageEvent)
  ws.onmessage?.call(ws, { data: JSON.stringify({ id: 1, result: {} }) } as MessageEvent)
  await expect(reply).resolves.toEqual({})
  expect(events).toEqual([
    ['Runtime.exceptionThrown', { exceptionDetails: { exceptionId: 1, text: 'Uncaught' } }],
  ])
  protocol.close()
})

test('client load errors name each exception and harness failure on one line', async () => {
  const { clientLoadErrors, settleTimeoutMessage } = await import('./full-document')
  const harness = {
    mounted: true,
    settled: true,
    rendered: true,
    unserved: [],
    requests: [],
    waiting: '',
    ticks: 4,
    frames: 2,
    distinct: 0,
  }
  expect(
    clientLoadErrors({
      exceptions: [
        {
          exceptionId: 1,
          text: 'Uncaught',
          description: 'ReferenceError: Bun is not defined\n    at index.js:4:5',
          url: 'file:///out/index.js',
          lineNumber: 3,
          columnNumber: 4,
        },
      ],
      harness: { ...harness, mounted: false, settled: false },
    }),
  ).toEqual([
    'Uncaught ReferenceError: Bun is not defined (file:///out/index.js:4:5)',
    'the page never mounted',
  ])
  expect(clientLoadErrors({ exceptions: [], harness })).toEqual([])
  expect(
    clientLoadErrors({
      exceptions: [],
      harness: { ...harness, rendered: false, unserved: ['GET /x'] },
    }),
  ).toEqual(['the page rendered nothing', 'unserved request GET /x: add a fixture response for it'])
  expect(clientLoadErrors({ exceptions: [], timeout: 'harness did not settle: null' })).toEqual([
    'harness did not settle: null',
  ])
  expect(
    settleTimeoutMessage(
      {
        ...harness,
        settled: false,
        rendered: false,
        requests: ['GET /a', 'GET /a'],
        distinct: 1,
        waiting: 'animation frame',
        ticks: 3,
        frames: 0,
      },
      20_000,
    ),
  ).toBe(
    'harness did not settle within 20000 ms: still waiting for animation frame (ticks 3, frames 0, requests 2, distinct 1)',
  )
  expect(settleTimeoutMessage(null, 3_000)).toBe(
    'harness did not settle within 3000 ms: the harness never started',
  )
})
