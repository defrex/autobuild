import { expect, test } from 'bun:test'
import { handleRequest } from './dev'

test('dev HTTP serves directory indexes, explicit files, redirects and 404s', async () => {
  const server = Bun.serve({ port: 0, fetch: handleRequest })
  try {
    for (const path of [
      '/',
      '/index.html',
      '/docs/',
      '/docs/index.html',
      '/docs/getting-started/',
      '/docs/getting-started/index.html',
    ]) {
      const response = await fetch(new URL(path, server.url))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(await response.text()).toContain('<!doctype html>')
    }
    for (const path of ['/docs', '/docs/getting-started']) {
      const response = await fetch(new URL(`${path}?source=test`, server.url), {
        redirect: 'manual',
      })
      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe(
        new URL(`${path}/?source=test`, server.url).toString(),
      )
    }
    const css = await fetch(new URL('/site.css', server.url))
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toContain('text/css')
    for (const path of ['/missing', '/missing/', '/docs/missing/', '/constructor'])
      expect((await fetch(new URL(path, server.url))).status).toBe(404)
  } finally {
    server.stop(true)
  }
})
