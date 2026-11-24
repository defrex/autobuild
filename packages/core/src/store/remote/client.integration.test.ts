import { describe, expect, test } from 'bun:test'
import { agentActor } from '../../events/envelope'
import { READ_CATALOG_IDENTITY } from '../../events/compatibility'
import { CATALOG_IDENTITY_HEADER } from './version'
import { eventEnvelopeWireSchema } from './protocol'
import { RemoteBuildStore } from './client'

/** Only event pages and requested URLs are needed by the polling scenario. */
function fakeFetch(pages: ReturnType<typeof wireEvent>[][]) {
  const calls: string[] = []
  const fetchFn = (async (input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push(url)
    const events = pages.shift()
    if (!events) throw new Error('fakeFetch: no canned page left')
    return Response.json(
      {
        events,
        cursor: events.at(-1)?.seq ?? Number(new URL(url).searchParams.get('since') ?? 0),
        hasMore: false,
      },
      { headers: { [CATALOG_IDENTITY_HEADER]: READ_CATALOG_IDENTITY } },
    )
  }) as typeof fetch
  return { fetchFn, calls }
}

/** Predicate poll with a deadline, for the subscribe-loop tests. */
async function waitFor(predicate: () => boolean, message: string, deadlineMs = 2_000) {
  const deadline = performance.now() + deadlineMs
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${message}`)
    await Bun.sleep(2)
  }
}

const T0 = '2026-07-15T12:00:00.000Z'
const AGENT = agentActor('implement', 's_test')

function wireEvent(over: Record<string, unknown> = {}) {
  return eventEnvelopeWireSchema.parse({
    build: 'build-a',
    seq: 1,
    ts: T0,
    actor: AGENT,
    type: 'observation.recorded',
    payload: { id: 'o_1', kind: 'followup', summary: 'sample observation' },
    ...over,
  })
}

describe('subscribe waits (AUT-334)', () => {
  test('since pages forward across reads and delivery stays in order', async () => {
    const first = wireEvent({ seq: 1 })
    const second = wireEvent({ seq: 2 })
    const { fetchFn, calls } = fakeFetch([[first], [second], []])
    const store = new RemoteBuildStore({ url: 'http://store.test', fetchFn })
    const seen: number[] = []
    const stop = store.subscribe('build-a', { waitSeconds: 0, pollMs: 5 }, (event) =>
      seen.push(event.seq),
    )
    try {
      await waitFor(() => calls.length >= 2 && seen.length === 2, 'two delivered events')
      expect(calls[1]).toBe('http://store.test/builds/build-a/events?since=1')
      expect(seen).toEqual([1, 2])
    } finally {
      stop()
    }
  })
})
