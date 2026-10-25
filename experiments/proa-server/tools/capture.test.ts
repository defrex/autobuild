import { expect, test } from 'bun:test'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureFrames, decodePng, expectedConnectCaptureResponse } from './capture'
import {
  checkRoutes,
  checkCaptureCapabilities,
  checkFrameMatrix,
  checkMachineNamespaces,
  machineNamespaces,
  frames,
  palette,
  dataFontFallback,
} from './capture-cases'
import { project } from './verify'

test('route inventory rejects new and unsupported route declarations', async () => {
  const source = await Bun.file(join(project, 'src/routes.rs')).text()
  const machine = await Bun.file(join(project, 'src/protocol/router.rs')).text()
  expect(() => checkRoutes(source, machine)).not.toThrow()
  expect(() => checkRoutes(`${source}\n.route("/new", get(page))`, machine)).toThrow('Unclassified')
  expect(() => checkRoutes(`${source}\n.route(path, get(page))`, machine)).toThrow('Unclassified')
  for (const declaration of [
    '.nest("/new",other)',
    '.route_service("/new",other)',
    '.merge(other)',
    'Route::page("/new",other)',
  ])
    expect(() => checkRoutes(`${source}\n${declaration}`, machine)).toThrow('Unclassified')
  expect(new Set(frames.map((f) => f.id)).size).toBe(96)
  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'])
      for (const state of ['open', 'closed'])
        expect(
          frames.some((f) => f.width === width && f.theme === theme && f.state === state),
        ).toBe(true)
})
test('machine namespaces and fallback services require explicit evidence classification', async () => {
  const source = await Bun.file(join(project, 'src/routes.rs')).text()
  const machine = await Bun.file(join(project, 'src/protocol/router.rs')).text()
  expect(Object.keys(machineNamespaces).sort()).toEqual([
    'builds',
    'credentials',
    'repos',
    'sessions',
    'streams',
    'tickets',
  ])
  expect(() =>
    checkMachineNamespaces(
      machine.replace(
        /(pub const MACHINE_NAMESPACES[^;]*?)"builds"/,
        '$1"builds", "future-namespace"',
      ),
    ),
  ).toThrow('Unclassified machine namespace')
  expect(() =>
    checkMachineNamespaces(
      machine.replace(/(pub const MACHINE_NAMESPACES[^;]*?)"builds"/, '$1NEW_NAMESPACE'),
    ),
  ).toThrow('Unclassified machine namespace')
  expect(() =>
    checkMachineNamespaces(
      machine.replace('pub const MACHINE_NAMESPACES', 'const MACHINE_NAMESPACES'),
    ),
  ).toThrow('Unclassified machine namespace')
  expect(() =>
    checkRoutes(
      source.replace('proa_server::connection::http::is_public_path(request.uri().path())', 'true'),
      machine,
    ),
  ).toThrow('Unclassified fallback')
  expect(() => checkRoutes(`${source}\n.fallback(other)`, machine)).toThrow('Unclassified fallback')
  expect(() => checkRoutes(`${source}\n.fallback_service(other)`, machine)).toThrow(
    'Unclassified fallback',
  )
  expect(() =>
    checkRoutes(
      source.replace('protocol::router::is_machine_path(request.uri().path())', 'true'),
      machine,
    ),
  ).toThrow('Unclassified fallback')
})
test('readiness preflight is classified separately from page database capabilities', async () => {
  const health = await Bun.file(join(project, 'src/endpoints/health.rs')).text()
  expect(() =>
    checkCaptureCapabilities('none', { 'src/endpoints/health.rs': health }),
  ).not.toThrow()
  expect(() => checkCaptureCapabilities('postgres', {})).toThrow('Unsupported database')
  expect(() => checkCaptureCapabilities('none', { 'src/pages/new.rs': 'state.data' })).toThrow(
    'Unsupported database',
  )
  expect(() =>
    checkCaptureCapabilities('none', {
      'src/endpoints/new.rs': 'reader.postgres()',
    }),
  ).toThrow('Unsupported database')
  expect(() =>
    checkCaptureCapabilities('none', {
      'src/endpoints/health.rs': `${health}\npub async fn extra(){let _=state.data;}`,
    }),
  ).toThrow('Unsupported database')
  expect(() =>
    checkCaptureCapabilities('none', {
      'src/endpoints/health.rs': health.replace(
        'reader.postgres().preflight()',
        'reader.postgres().query()',
      ),
    }),
  ).toThrow('Unsupported readiness')
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
            `<!doctype html><html data-theme="light"><head><link rel="stylesheet" href="/static/styles.css">${injection}</head><body><header>Autobuild proa/server <button id="account-trigger" aria-expanded="false">operator@example.com</button></header><main><h1>Builds</h1><p>No build data connected yet.</p><p>This experiment establishes the server and app shell. Builds will appear here when the event log is connected.</p></main></body></html>`,
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
      // Assert that the entire profile is absent, rather than rereading its cached port file.
      await expect(stat(join(output, 'profile'))).rejects.toThrow()
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

test('only stored multilingual text permits corresponding fallback glyphs', () => {
  expect(dataFontFallback('Noto Sans CJK JP', '日本語', true)).toBe(true)
  expect(dataFontFallback('Noto Color Emoji', '☕️ 🇺🇸', true)).toBe(true)
  expect(dataFontFallback('Noto Color Emoji', '☕️', false)).toBe(false)
  expect(dataFontFallback('Noto Sans CJK JP', '　', true)).toBe(false)
  expect(dataFontFallback('Noto Sans CJK JP', 'English', true)).toBe(false)
  expect(dataFontFallback('serif', '日本語', true)).toBe(false)
})

test('only exact documented connection error frames accept HTTP errors', () => {
  const codes = { unknown: '0000000000', error: 'INVALID' }
  expect(
    expectedConnectCaptureResponse(
      404,
      'http://local/connect?code=0000000000',
      'http://local',
      'http://backend',
      codes,
    ),
  ).toBe(true)
  expect(
    expectedConnectCaptureResponse(
      503,
      'http://backend/connect?code=INVALID',
      'http://local',
      'http://backend',
      codes,
    ),
  ).toBe(true)
  for (const url of [
    'http://other/connect?code=0000000000',
    'http://local/static/missing.css',
    'http://local/connect?code=unexpected',
  ])
    expect(expectedConnectCaptureResponse(404, url, 'http://local', 'http://backend', codes)).toBe(
      false,
    )
  expect(
    expectedConnectCaptureResponse(
      500,
      'http://local/connect?code=0000000000',
      'http://local',
      'http://backend',
      codes,
    ),
  ).toBe(false)
})

test('consent evidence never exports resumable grant handles', async () => {
  const { captureSeedForEvidence } = await import('./capture')
  const seed = {
    consent: { named: 'opaque-grant', used: 'consumed-grant' },
  } as unknown as import('./capture-seed').SeedEvidence
  const publicSeed = captureSeedForEvidence(seed)
  expect(publicSeed?.consent).toEqual({ named: '[REDACTED]', used: '[REDACTED]' })
  expect(seed.consent?.named).toBe('opaque-grant')
})

test('every public OAuth and MCP endpoint is classified separately from consent HTML', async () => {
  const { checkOAuthRoutes } = await import('./capture-cases')
  const source = await Bun.file(join(project, 'src/oauth/http.rs')).text()
  const router = await Bun.file(join(project, 'src/routes.rs')).text()
  expect(() => checkOAuthRoutes(source, router)).not.toThrow()
  expect(() =>
    checkOAuthRoutes(source.replace('"/api/auth/jwks"', '"/api/auth/new"'), router),
  ).toThrow('Unclassified')
  expect(() =>
    checkOAuthRoutes(source, router.replace('request.uri().path() == "/mcp"', 'false')),
  ).toThrow('Unclassified')
})
