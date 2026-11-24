import { expect, test } from 'bun:test'
import { deleteHostedProject, deletionUnknown } from './api'
const repo = 'https://github.com/acme/one'
// The final case arms a real one-millisecond abort timeout; the pure preview
// checks live in deletion.test.ts.
test('every ambiguous response has the same safe error; acknowledgment preserves body/token contract', async () => {
  const original = globalThis.fetch
  try {
    for (const response of [
      () => new Response('An error occurred', { status: 502 }),
      () => new Response(''),
      () => Response.json({ deleted: false }),
      () => Response.json({}),
      () => Response.json({ error: 'stale' }, { status: 412 }),
      () => {
        throw new Error('offline')
      },
    ]) {
      globalThis.fetch = (async () => response()) as unknown as typeof fetch
      await expect(deleteHostedProject(repo, 'one')).rejects.toThrow(deletionUnknown)
    }
    globalThis.fetch = (async (_url: unknown, options?: RequestInit) => {
      expect(options?.body).toBe(JSON.stringify({ repo }))
      expect(options?.headers).toMatchObject({ 'if-match': 'one' })
      return Response.json({ deleted: true })
    }) as unknown as typeof fetch
    await deleteHostedProject(repo, 'one')
    globalThis.fetch = ((_url: unknown, options?: RequestInit) =>
      new Promise((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(new Error('abort'))),
      )) as unknown as typeof fetch
    await expect(deleteHostedProject(repo, 'one', 1)).rejects.toThrow(deletionUnknown)
  } finally {
    globalThis.fetch = original
  }
})
