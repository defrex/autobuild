import { buildFiles } from './build'

const TYPES: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'site.css': 'text/css; charset=utf-8',
  'site.js': 'text/javascript; charset=utf-8',
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3300),
  async fetch(request) {
    const path = new URL(request.url).pathname
    const name = path === '/' ? 'index.html' : path.slice(1)
    const files = await buildFiles()
    const body = files[name as keyof typeof files]
    if (body === undefined) return new Response('not found', { status: 404 })
    return new Response(body, { headers: { 'content-type': TYPES[name] ?? 'text/plain' } })
  },
})

console.log(`website dev server on ${server.url}`)
