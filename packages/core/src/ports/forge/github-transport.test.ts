import { describe, expect, test } from 'bun:test'
import { createGitHubFetchTransport, GitHubApiError } from './github-transport'

/** A request recorder standing in for global fetch, answering from a
 * scripted response. Returns the captured URL/headers for assertions. */
function stubFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>): {
  calls: { url: string; init: RequestInit }[]
  restore: () => void
} {
  const calls: { url: string; init: RequestInit }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    return respond(url, init ?? {})
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = original) }
}

describe('createGitHubFetchTransport', () => {
  test('serializes request.query into the URL', async () => {
    const stub = stubFetch(
      () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    )
    try {
      const transport = createGitHubFetchTransport({ token: 't' })
      await transport('GET', 'repos/acme/app/contents/autobuild.toml', {
        query: { ref: 'dev' },
      })
      expect(stub.calls[0]?.url).toBe(
        'https://api.github.com/repos/acme/app/contents/autobuild.toml?ref=dev',
      )
    } finally {
      stub.restore()
    }
  })

  test('appends query parameters to an absolute URL that already carries one', async () => {
    const stub = stubFetch(() => new Response('', { status: 204 }))
    try {
      const transport = createGitHubFetchTransport({ token: 't' })
      await transport('GET', 'https://objects.example/asset.tgz?X-Amz-Signature=abc', {
        query: { ref: 'main' },
      })
      expect(stub.calls[0]?.url).toBe(
        'https://objects.example/asset.tgz?X-Amz-Signature=abc&ref=main',
      )
    } finally {
      stub.restore()
    }
  })

  test('delivers binary bodies as unmodified bytes (no text round-trip)', async () => {
    // Arbitrary non-UTF8 bytes — a text decode/re-encode would corrupt them
    // into replacement characters (f_0a8691c2).
    const payload = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x80, 0x81])
    const stub = stubFetch(
      () =>
        new Response(payload as unknown as BodyInit, {
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
    )
    try {
      const transport = createGitHubFetchTransport({ token: 't' })
      const response = await transport('GET', 'https://objects.example/autobuild-1.0.0.tgz')
      expect(response.bytes).toEqual(payload)
      expect(response.json).toBeUndefined()
    } finally {
      stub.restore()
    }
  })

  test('empty non-JSON bodies carry no bytes', async () => {
    const stub = stubFetch(() => new Response(null, { status: 204 }))
    try {
      const transport = createGitHubFetchTransport({ token: 't' })
      const response = await transport('DELETE', 'repos/acme/app/git/refs/heads/ab/x')
      expect(response.status).toBe(204)
      expect(response.bytes).toBeUndefined()
    } finally {
      stub.restore()
    }
  })

  test('non-JSON error bodies still yield an API message', async () => {
    const stub = stubFetch(() => new Response('<html>bad gateway</html>', { status: 502 }))
    try {
      const transport = createGitHubFetchTransport({ token: 't' })
      const error = await transport('GET', 'repos/acme/app').catch((e: unknown) => e)
      expect(error).toBeInstanceOf(GitHubApiError)
      expect((error as GitHubApiError).status).toBe(502)
      expect((error as GitHubApiError).message).toBe('<html>bad gateway</html>')
    } finally {
      stub.restore()
    }
  })

  test('sends the token, API version, and JSON bodies', async () => {
    const stub = stubFetch(
      () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    )
    try {
      const transport = createGitHubFetchTransport({ token: 'secret-token' })
      await transport('POST', 'repos/acme/app/pulls', { body: { title: 'hi' } })
      const init = stub.calls[0]!.init
      const headers = init.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer secret-token')
      expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28')
      expect(headers['Content-Type']).toBe('application/json')
      expect(init.body).toBe(JSON.stringify({ title: 'hi' }))
    } finally {
      stub.restore()
    }
  })
})
