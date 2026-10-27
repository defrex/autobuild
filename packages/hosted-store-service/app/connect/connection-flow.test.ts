import { expect, test } from 'bun:test'
import { createConnectionLookup } from './connection-flow'

function fixture() {
  const requests: { body: string; resolve: (response: Response) => void }[] = []
  const results: unknown[] = [],
    errors: string[] = [],
    paths: string[] = [],
    checking: boolean[] = []
  const flow = createConnectionLookup({
    request: ((_url: unknown, init: RequestInit) =>
      new Promise<Response>((resolve) => {
        requests.push({ body: String(init.body), resolve })
      })) as typeof fetch,
    resolved: (result) => results.push(result),
    failed: (message) => errors.push(message),
    navigate: (path) => paths.push(path),
    checking: (value) => checking.push(value),
  })
  return { flow, requests, results, errors, paths, checking }
}
const body = (status = 'pending') => ({
  connection: { code: 'ABCDEF1234', repo: 'example/repo', status },
  assignment: 'new',
  assignedOrganization: null,
  organizations: [],
})
test('initial/manual lookup normalizes, deduplicates and returns acknowledged outcomes', async () => {
  for (const status of ['pending', 'expired', 'approved', 'denied']) {
    const f = fixture()
    const run = f.flow.lookup('abcdef1234')
    expect(f.flow.lookup('ABCDEF1234')).toBe(run)
    expect(f.requests).toHaveLength(1)
    expect(JSON.parse(f.requests[0]!.body)).toEqual({ code: 'ABCDEF1234' })
    f.requests[0]!.resolve(Response.json(body(status)))
    await run
    expect(f.results).toEqual([body(status)])
    expect(f.checking).toEqual([true, false])
  }
})
test('malformed input makes no request and unknown/error outcomes remain actionable', async () => {
  const invalid = fixture()
  await invalid.flow.lookup('invalid')
  expect(invalid.requests).toHaveLength(0)
  expect(invalid.errors).toEqual(['Enter the ten-character connection code.'])
  for (const [payload, status, message] of [
    [{ connection: null }, 200, 'Unknown connection code'],
    [{ error: 'too many code lookups' }, 429, 'too many code lookups'],
  ] as const) {
    const f = fixture()
    const run = f.flow.lookup('abcdef1234')
    f.requests[0]!.resolve(Response.json(payload, { status }))
    await run
    expect(f.errors[0]).toContain(message)
    expect(f.results).toEqual([])
  }
})
test('401 returns through sign-in to the normalized automatic lookup', async () => {
  const f = fixture()
  const run = f.flow.lookup('abcdef1234')
  f.requests[0]!.resolve(new Response(null, { status: 401 }))
  await run
  expect(f.paths).toEqual(['/sign-in?returnTo=%2Fconnect%3Fcode%3DABCDEF1234'])
  const returned = fixture()
  const retry = returned.flow.lookup(
    new URL(
      `https://example.com${decodeURIComponent(f.paths[0]!.split('returnTo=')[1]!)}`,
    ).searchParams.get('code')!,
  )
  returned.requests[0]!.resolve(Response.json(body()))
  await retry
  expect(returned.results).toEqual([body()])
})
test('late lookup results, errors and auth redirects cannot overwrite newer input', async () => {
  for (const response of [
    Response.json(body()),
    new Response(null, { status: 401 }),
    Response.json({ error: 'late error' }, { status: 500 }),
  ]) {
    const f = fixture()
    const first = f.flow.lookup('abcdef1234')
    f.flow.invalidate()
    const second = f.flow.lookup('123456789a')
    f.requests[1]!.resolve(Response.json(body('approved')))
    await second
    f.requests[0]!.resolve(response)
    await first
    expect(f.results).toEqual([body('approved')])
    expect(f.paths).toEqual([])
    expect(f.errors).toEqual([])
  }
})
