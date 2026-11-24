import { expect, test } from 'bun:test'

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
