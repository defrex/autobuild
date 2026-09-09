import { rename, writeFile } from 'node:fs/promises'

const readyFile = process.argv[2]
const marker = 'AUTOBUILD_BROWSER_SMOKE_RENDERED'

if (readyFile === undefined) {
  console.error('browser-smoke server startup failure: readiness file argument is required')
  process.exit(2)
}

try {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== '/') {
        return new Response('browser smoke page not found\n', { status: 404 })
      }
      return new Response(
        `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Autobuild browser smoke</title></head>
<body>
  <main id="browser-smoke-result">PENDING</main>
  <script>
    document.getElementById('browser-smoke-result').textContent = '${marker}'
  </script>
</body>
</html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      )
    },
  })

  const pendingFile = `${readyFile}.${process.pid}.tmp`
  await writeFile(pendingFile, `${server.port}\n`, { flag: 'wx' })
  await rename(pendingFile, readyFile)
  console.log(`browser-smoke server listening at http://${server.hostname}:${server.port}/`)
} catch (error) {
  console.error('browser-smoke server startup failure:', error)
  process.exit(1)
}
