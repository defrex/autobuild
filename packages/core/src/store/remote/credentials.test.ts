/** Credential delegation: a refusal carries the server's stated reason, and
 * an empty or unreadable body never masks the refusal itself. */
import { afterEach, describe, expect, test } from 'bun:test'
import { delegateCredential } from './credentials'

const original = globalThis.fetch
const calls: { url: string; init: RequestInit }[] = []
function answer(respond: () => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return respond()
  }) as typeof fetch
}
afterEach(() => {
  globalThis.fetch = original
  calls.length = 0
})

const target = { kind: 'build-runner', id: 'remote-node' } as const
const delegate = () => delegateCredential('https://store.example.test/', 'parent-token', target)

describe('delegateCredential', () => {
  test('a JSON refusal names the status and the server reason', async () => {
    answer(() => Response.json({ kind: 'auth', error: 'resource unavailable' }, { status: 404 }))
    await expect(delegate()).rejects.toThrow(
      new Error('credential delegation refused (404): resource unavailable'),
    )
  })

  test('an empty refusal body yields the status-only message', async () => {
    answer(() => new Response(null, { status: 404 }))
    await expect(delegate()).rejects.toThrow(new Error('credential delegation refused (404)'))
  })

  test('a plain-text refusal body is the reason', async () => {
    answer(() => new Response('upstream down\n', { status: 502 }))
    await expect(delegate()).rejects.toThrow(
      new Error('credential delegation refused (502): upstream down'),
    )
  })

  test('a plain-text reason is bounded', async () => {
    answer(() => new Response('x'.repeat(5_000), { status: 500 }))
    await expect(delegate()).rejects.toThrow(
      new Error(`credential delegation refused (500): ${'x'.repeat(200)}`),
    )
  })

  test('an unreadable refusal body yields the status-only message', async () => {
    answer(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error('stream broke'))
            },
          }),
          { status: 500 },
        ),
    )
    await expect(delegate()).rejects.toThrow(new Error('credential delegation refused (500)'))
  })

  test('success returns the delegated token and posts the target', async () => {
    answer(() => Response.json({ token: 't' }))
    expect(await delegate()).toBe('t')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://store.example.test/credentials/delegate')
    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(target)
  })

  test('a missing parent token fails closed without a request', async () => {
    answer(() => Response.json({ token: 't' }))
    await expect(
      delegateCredential('https://store.example.test', undefined, target),
    ).rejects.toThrow(new Error('credential delegation requires parent authority'))
    expect(calls).toHaveLength(0)
  })
})
