import { buildFiles } from './build'

const TYPES: Record<string, string> = {
  'site.css': 'text/css; charset=utf-8',
  'site.js': 'text/javascript; charset=utf-8',
  'og.png': 'image/png',
}

/** Shared directory-index semantics for the development server and route tests. */
export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const files = await buildFiles()
  if (!path.endsWith('/') && `${path.slice(1)}/index.html` in files) {
    url.pathname += '/'
    return Response.redirect(url.toString(), 308)
  }
  const name = path.endsWith('/') ? `${path.slice(1)}index.html` : path.slice(1)
  const body = Object.hasOwn(files, name) ? files[name as keyof typeof files] : undefined
  if (body === undefined) return new Response('not found', { status: 404 })
  return new Response(body, {
    headers: {
      'content-type': name.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : (TYPES[name] ?? 'text/plain'),
    },
  })
}

if (import.meta.main) {
  const server = Bun.serve({ port: Number(process.env.PORT ?? 3300), fetch: handleRequest })
  console.log(`website dev server on ${server.url}`)
}
