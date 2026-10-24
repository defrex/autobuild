import { expect, test } from 'bun:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureFrames, decodePng } from './capture'
import { checkRoutes, checkFrameMatrix, frames, palette } from './capture-cases'
import { project } from './verify'

test('route inventory rejects new and unsupported route declarations', async () => {
  const source = await Bun.file(join(project, 'src/routes.rs')).text()
  expect(() => checkRoutes(source)).not.toThrow()
  expect(() => checkRoutes(`${source}\n.route("/new", get(page))`)).toThrow('Unclassified')
  expect(() => checkRoutes(`${source}\n.route(path, get(page))`)).toThrow('Unclassified')
  expect(new Set(frames.map((f) => f.id)).size).toBe(8)
  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'])
      for (const state of ['open', 'closed'])
        expect(
          frames.some((f) => f.width === width && f.theme === theme && f.state === state),
        ).toBe(true)
})
test('palette comes from immutable reference for each ground', async () => {
  const ref = await Bun.file(join(project, 'design/ansi/index.html')).text()
  expect(palette(ref, 'light')).toContain('#fbfbfc')
  expect(palette(ref, 'dark')).toContain('#101219')
})

// Real Chromium fixture pages exercise the same probes and request policy as capture.
for (const [name, injection, expected] of [
  ['color', '<style>h1 {color:rgb(1,2,3)!important}</style>', 'Forbidden color'],
  ['font', '<style>h1 {font-family:serif!important}</style>', 'Forbidden font'],
  ['overflow', '<style>main {width:1600px!important}</style>', 'overflow'],
  [
    'content',
    '<script>addEventListener("DOMContentLoaded",()=>document.querySelector("h1").remove())</script>',
    'Missing Builds heading',
  ],
  ['external', '<img src="https://example.invalid/pixel">', 'External request'],
  ['asset', '<script src="/missing.js"></script>', 'HTTP 404'],
  ['exception', '<script>throw Error("fixture exception")</script>', 'Runtime.exceptionThrown'],
] as const)
  test(`capture rejects ${name} fixture and cleans profile`, async () => {
    const output = await mkdtemp(join(tmpdir(), 'proa-fixture-'))
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/') {
          // Fixture uses scaffold markup and real local fonts/CSS, with one intentional defect.
          return new Response(
            `<!doctype html><html data-theme="light"><head><link rel="stylesheet" href="/static/styles.css">${injection}</head><body><header>Autobuild proa/server <button id="account-trigger" aria-expanded="false">Experiment menu</button></header><main><h1>Builds</h1><p>No build data connected yet.</p><p>This experiment establishes the server and app shell. Builds will appear here when the event log is connected.</p></main></body></html>`,
            { headers: { 'content-type': 'text/html' } },
          )
        }
        if (path === '/static/styles.css')
          return new Response(await Bun.file(join(project, 'styles/ansi.css')).text(), {
            headers: { 'content-type': 'text/css' },
          })
        if (path.startsWith('/static/'))
          return new Response(Bun.file(join(project, 'public', path.slice(8))))
        return new Response('', { status: 404 })
      },
    })
    try {
      await expect(captureFrames(`http://127.0.0.1:${server.port}`, output)).rejects.toThrow(
        expected,
      )
      await expect(readFile(join(output, 'profile/DevToolsActivePort'))).rejects.toThrow()
    } finally {
      server.stop(true)
      await rm(output, { recursive: true, force: true })
    }
  }, 30000)

test('missing matrix entries and missing screenshots cannot pass', () => {
  expect(() => checkFrameMatrix(frames.slice(1))).toThrow('Incomplete frame matrix')
  expect(() => checkFrameMatrix([...frames, frames[0]!])).toThrow('Duplicate frame')
  for (const data of [undefined, '', Buffer.from('not an image').toString('base64')])
    expect(() => decodePng(data)).toThrow('Missing/empty PNG')
})
test('failed Chromium startup cleans its profile', async () => {
  const output = await mkdtemp(join(tmpdir(), 'proa-startup-fixture-'))
  const previous = process.env.CHROMIUM_BIN
  process.env.CHROMIUM_BIN = '/bin/false'
  try {
    await expect(captureFrames('http://127.0.0.1:1', output)).rejects.toThrow(
      'Chromium exited before readiness',
    )
    await expect(readFile(join(output, 'profile/DevToolsActivePort'))).rejects.toThrow()
  } finally {
    if (previous === undefined) delete process.env.CHROMIUM_BIN
    else process.env.CHROMIUM_BIN = previous
    await rm(output, { recursive: true, force: true })
  }
})
