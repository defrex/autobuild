import { expect, test } from 'bun:test'
import { escapeHtml } from '../packages/core/src/web/page'
import { FRAME_META } from '../packages/core/src/web/protocol'
import { overviewFrame, RUNNING_SLUG } from '../packages/ui/src/app/fixtures'
import { startUiWebFixtureServer } from './ui-web-capture'

test('the fixture server serves the pages, bundle, overview stream and analytics with no store', async () => {
  const server = await startUiWebFixtureServer()
  const overview = JSON.stringify(overviewFrame())
  let stopped = false
  try {
    const page = await fetch(server.url)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain(`<meta name="${FRAME_META}" content="${escapeHtml(overview)}">`)
    expect(html).toContain('github.com/acme/app')

    expect((await fetch(new URL(`/builds/${RUNNING_SLUG}`, server.url))).status).toBe(200)
    const timeline = await fetch(new URL(`/api/builds/${RUNNING_SLUG}/timeline`, server.url))
    expect(((await timeline.json()) as { row: { slug: string } }).row.slug).toBe(RUNNING_SLUG)
    const analytics = await fetch(new URL('/api/analytics?window=7d', server.url))
    expect(((await analytics.json()) as { gantt: { rows: unknown[] } }).gantt.rows).toHaveLength(25)

    for (const file of server.manifest.files) {
      const asset = await fetch(new URL(`/assets/${file.path}`, server.url))
      expect(asset.status).toBe(200)
      expect(asset.headers.get('content-type')).toBe(file.type)
      expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(0)
    }

    const controller = new AbortController()
    const events = await fetch(new URL('/events', server.url), { signal: controller.signal })
    const reader = events.body!.getReader()
    let text = ''
    while (!text.includes('\n\n')) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    controller.abort()
    expect(text.startsWith('event: model\ndata: ')).toBe(true)
    expect(JSON.parse(text.split('\n')[1]!.slice('data: '.length))).toEqual(overviewFrame())

    const port = new URL(server.url).port
    await server.stop()
    stopped = true
    const again = Bun.serve({
      hostname: '127.0.0.1',
      port: Number(port),
      fetch: () => new Response(''),
    })
    again.stop(true)
  } finally {
    if (!stopped) await server.stop()
  }
})
