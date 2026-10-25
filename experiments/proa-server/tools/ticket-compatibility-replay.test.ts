import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { replayTicketCompatibility } from './ticket-compatibility-replay'
import type { TicketHttpFixtureCase } from './ticket-http-fixtures'

const response = (row: TicketHttpFixtureCase) =>
  Promise.resolve(Response.json(row.body, { status: row.status }))
test('compatibility replay forwards recorded versions, headers and input for every required case', async () => {
  const corpus = (await Bun.file(
    resolve(import.meta.dir, '../fixtures/ticket-http.json'),
  ).json()) as { cases: TicketHttpFixtureCase[] }
  let calls = 0
  const result = await replayTicketCompatibility(
    'test-bearer',
    async (row, init) => {
      expect(init.body).toBe(JSON.stringify(row.request))
      expect((init.headers as Record<string, string>)['x-autobuild-version']).toBe(row.version)
      calls++
      return response(row)
    },
    response,
  )
  expect(result.refused).toBe(corpus.cases.filter((row) => !row.supported).length)
  expect(result.projections).toBeGreaterThan(0)
  expect(calls).toBe(result.refused + result.projections)
})
test('compatibility replay rejects a native version gate regression', async () => {
  await expect(
    replayTicketCompatibility(
      'test-bearer',
      async (row) => (row.supported ? response(row) : Response.json(null)),
      response,
    ),
  ).rejects.toThrow('recorded refusal status')
})
test('compatibility replay rejects a native response projection regression', async () => {
  await expect(
    replayTicketCompatibility(
      'test-bearer',
      async (row) => (row.supported ? Response.json({ unexpected: true }) : response(row)),
      response,
    ),
  ).rejects.toThrow('source projection body')
})

test('recorded projections remain an independent anchor when both live handlers drift', async () => {
  const drift = async (row: TicketHttpFixtureCase) => {
    if (!row.supported || row.operation !== 'get') return response(row)
    return Response.json(
      { ...(row.body as object), body: 'drifted body bytes' },
      { status: row.status },
    )
  }
  await expect(replayTicketCompatibility('test-bearer', drift, drift)).rejects.toThrow(
    'recorded projection body',
  )
})
