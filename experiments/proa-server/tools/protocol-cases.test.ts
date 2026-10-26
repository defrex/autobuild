import { expect, test } from 'bun:test'
import { assertProtocolCoverage, excludedProtocols, protocolCases } from './protocol-cases'

test('inventory retains shared, indirect and current-client-only route families', () => {
  const keys = protocolCases.map(({ method, path }) => `${method} ${path}`)
  expect(new Set(keys).size).toBe(keys.length)
  for (const key of [
    'POST /credentials/delegate',
    'POST /builds/:slug/node-writer/claim',
    'POST /builds/:slug/deposits/conditional',
    'GET /repos/:repo/change-position',
    'POST /repos/:repo/operator-presence',
    'DELETE /repos/:repo/operator-presence/:id',
    'GET /repos/:repo/build-digests',
    'GET /repos/:repo/tickets/:id/assets/file',
    'GET /builds/:slug/ticket-assets/file',
    'POST /sessions/:id/events/conditional',
    'GET /streams/:stream/chunks',
  ])
    expect(keys).toContain(key)
  expect(excludedProtocols).toHaveLength(4)
  expect(protocolCases.filter((row) => row.gate === 'public').map((row) => row.path)).toEqual([
    '/health',
  ])
})

test('coverage cannot pass on an empty or partial HTTP assertion registry', () => {
  expect(() => assertProtocolCoverage(new Set())).toThrow('Untested protocol routes:')
  const keys = new Set(protocolCases.map(({ method, path }) => `${method} ${path}`))
  assertProtocolCoverage(keys)
  keys.delete('GET /streams/:stream/chunks')
  expect(() => assertProtocolCoverage(keys)).toThrow('GET /streams/:stream/chunks')
})

test('inventory includes every explicit dispatch case in the TypeScript family handlers', async () => {
  const source = await Bun.file(
    new URL('../../../packages/hosted-store-service/src/remote-store-server.ts', import.meta.url),
  ).text()
  const keys = new Set(protocolCases.map(({ method, path }) => `${method} ${path}`))
  for (const [handler, prefix] of [
    ['buildRoute', '/builds/:slug'],
    ['repoRoute', '/repos/:repo'],
    ['sessionRoute', '/sessions/:id'],
    ['ticketAssetRoute', '/repos/:repo/tickets/:id/assets'],
  ]) {
    const start = source.indexOf(`async function ${handler}(`)
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('\n  async function ', start + 1)
    const body = source.slice(start, end === -1 ? undefined : end)
    const declarations = [...body.matchAll(/case '(GET|POST|PUT) ([^']*)':/g)]
    expect(declarations.length).toBeGreaterThan(0)
    for (const declaration of declarations) {
      const suffix = declaration[2] === 'record' ? '' : declaration[2]
      expect(keys.has(`${declaration[1]} ${prefix}${suffix ? `/${suffix}` : ''}`)).toBe(true)
    }
  }
})
