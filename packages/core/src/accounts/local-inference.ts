import { sensitiveAccountValues } from './sensitive'
import { randomBytes } from 'node:crypto'
import type { LocalCredentials } from './local-credentials'

/** A per-launch capability gates a fixed Responses endpoint. It never refreshes. */
export function localInference(
  credentials: LocalCredentials,
  name: string,
  fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch,
) {
  credentials.load(name)
  const capability = randomBytes(32).toString('hex')
  credentials.sensitive.add(capability)
  sensitiveAccountValues.add(capability)
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 16000000,
    async fetch(request) {
      const url = new URL(request.url)
      if (
        request.method !== 'POST' ||
        url.pathname !== '/v1/responses' ||
        url.search ||
        request.headers.get('authorization') !== `Bearer ${capability}`
      )
        return new Response(null, { status: 403 })
      try {
        const record = credentials.load(name)
        if (!record || record.status === 'failed' || record.state.expiresAt <= Date.now())
          return new Response(null, { status: 401 })
        const body = await request.text()
        if (body.length > 16000000) return new Response(null, { status: 413 })
        const response = await fetcher('https://api.openai.com/v1/responses', {
          method: 'POST',
          redirect: 'error',
          signal: request.signal,
          headers: {
            authorization: `Bearer ${record.state.accessToken}`,
            'content-type': 'application/json',
          },
          body,
        })
        if (response.status === 401) {
          await response.body?.cancel()
          credentials.locked(name, () => {
            const current = credentials.load(name)
            if (
              current?.generation === record.generation &&
              current.state.accessToken === record.state.accessToken
            )
              credentials.save(name, { ...current, status: 'failed' })
          })
          return Response.json(
            {
              error: { code: 'invalid_token', message: 'ChatGPT account rejected; sign in again' },
            },
            { status: 401 },
          )
        }
        // Never relay a provider diagnostic containing the host bearer into the child.
        const decoder = new TextDecoder()
        let pending = ''
        const needles = () =>
          [...credentials.sensitive]
            .flatMap((s) => [s, JSON.stringify(s).slice(1, -1)])
            .sort((a, b) => b.length - a.length)
        const clean = (value: string) => {
          for (const secret of needles()) value = value.split(secret).join('[REDACTED]')
          return value
        }
        const filtered = response.body?.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              pending = clean(pending + decoder.decode(chunk, { stream: true }))
              let retained = 0
              for (const secret of needles())
                for (let n = 1; n < secret.length && n <= pending.length; n++)
                  if (pending.endsWith(secret.slice(0, n))) retained = Math.max(retained, n)
              const output = retained ? pending.slice(0, -retained) : pending
              if (output) controller.enqueue(new TextEncoder().encode(output))
              pending = retained ? pending.slice(-retained) : ''
            },
            flush(controller) {
              controller.enqueue(new TextEncoder().encode(clean(pending + decoder.decode())))
            },
          }),
        )
        return new Response(filtered, {
          status: response.status,
          headers: {
            'content-type': response.headers.get('content-type') ?? 'text/event-stream',
            'cache-control': 'no-store',
          },
        })
      } catch {
        return new Response(null, { status: 401 })
      }
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    capability,
    close: () => server.stop(true),
  }
}
