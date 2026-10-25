import { test, expect } from 'bun:test'
import { beginProtocolCoverage, observeProtocolResponse } from './protocol-route-coverage'

test('responses cannot publish route coverage before their enclosing assertions pass', async () => {
  const coverage = beginProtocolCoverage()
  await expect(
    coverage.proof('failed-body-assertion', async () => {
      await observeProtocolResponse(
        'GET',
        'http://native/builds/demo/events?since=0',
        Response.json([]),
      )
      expect(coverage.report()).toBeUndefined()
    }),
  ).rejects.toThrow('Cannot claim coverage before assertions finish')
  expect(coverage.report().covered.size).toBe(0)
  expect(() => coverage.assertComplete()).toThrow('Untested protocol routes:')
})
test('coverage requires admitted status and JSON, then matches the actual dynamic route', async () => {
  const coverage = beginProtocolCoverage()
  await coverage.proof('asserted-http', async () => {
    await observeProtocolResponse('GET', 'http://native/builds/a/events?since=0', Response.json([]))
    await observeProtocolResponse(
      'POST',
      'http://native/builds/a/events',
      Response.json({ error: 'invalid' }, { status: 400 }),
    )
    await observeProtocolResponse('GET', 'http://native/unlisted', Response.json({}))
  })
  expect([...coverage.report().covered]).toEqual(['GET /builds/:slug/events'])
  await expect(
    coverage.proof('non-json', async () => {
      await observeProtocolResponse('GET', 'http://native/repos/a', new Response('html'))
    }),
  ).rejects.toThrow('Protocol coverage requires JSON')
  expect([...coverage.report().covered]).toEqual(['GET /builds/:slug/events'])
})
