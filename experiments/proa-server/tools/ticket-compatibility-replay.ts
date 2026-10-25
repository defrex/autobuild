/** The committed HTTP corpus must reach the native transport, not merely its
 * TypeScript producer. Refusals compare recorded bytes semantically; admitted
 * ticket projections compare the same real persisted source on both servers. */
import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import type { TicketHttpFixtureCase } from './ticket-http-fixtures'
import * as old9 from '../../../packages/hosted-store-service/src/compatibility-fixtures/tickets-v0.9'
import * as old12 from '../../../packages/hosted-store-service/src/compatibility-fixtures/tickets-v0.12'
import * as old13 from '../../../packages/hosted-store-service/src/compatibility-fixtures/tickets-v0.13'

type FetchFixture = (row: TicketHttpFixtureCase, init: RequestInit) => Promise<Response>
export function compatibilityReplayKind(row: TicketHttpFixtureCase) {
  return !row.supported
    ? 'refusal'
    : row.operation === 'get' || row.operation === 'list-ready'
      ? 'projection'
      : 'crud'
}
/** A fake's content hash and PostgreSQL's monotonic revision are intentionally
 * different generators. Preserve revision presence/type and every other field. */
export function normalizeFixtureRevision(body: unknown, operation: string): unknown {
  const copy = structuredClone(body) as Record<string, unknown> | null
  const ticket = (value: unknown) => {
    if (value === null || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (Object.hasOwn(record, 'revision')) {
      assert.equal(typeof record.revision, 'string')
      assert.ok((record.revision as string).length > 0)
      record.revision = '<generated-revision>'
    }
  }
  if (operation === 'list-ready') {
    assert.ok(Array.isArray(copy?.tickets))
    for (const value of copy.tickets) ticket(value)
  } else ticket(copy)
  return copy
}
export async function replayTicketCompatibility(
  bearer: string,
  native: FetchFixture,
  oracle: FetchFixture,
) {
  const corpus = (await Bun.file(
    resolve(import.meta.dir, '../fixtures/ticket-http.json'),
  ).json()) as { cases: TicketHttpFixtureCase[] }
  let refused = 0,
    projections = 0
  for (const row of corpus.cases) {
    const kind = compatibilityReplayKind(row)
    // CRUD mutations have their own independent-project differential proof.
    // This replay concerns version refusal and strict response projections.
    if (kind === 'crud') continue
    const init = {
      method: 'POST',
      headers: { ...row.headers, authorization: `Bearer ${bearer}` },
      body: JSON.stringify(row.request),
    }
    const response = await native(row, init)
    const actual: unknown = await response.json()
    const label = `${row.version} ${JSON.stringify(row.capabilities)} ${row.operation}`
    if (kind === 'refusal') {
      assert.equal(response.status, row.status, `${label}: recorded refusal status`)
      assert.deepEqual(actual, row.body, `${label}: recorded refusal body`)
      refused++
    } else {
      const expected = await oracle(row, init)
      const expectedBody: unknown = await expected.json()
      assert.equal(response.status, expected.status, `${label}: source projection status`)
      assert.deepEqual(actual, expectedBody, `${label}: source projection body`)
      assert.equal(response.status, row.status, `${label}: recorded projection status`)
      assert.deepEqual(
        normalizeFixtureRevision(actual, row.operation),
        normalizeFixtureRevision(row.body, row.operation),
        `${label}: recorded projection body`,
      )
      assert.equal(response.status, 200, `${label}: admitted projection`)
      // The released decoders remain frozen; a future release-window change
      // automatically exercises them when their version becomes admitted.
      if (Object.keys(row.capabilities).length === 0) {
        const old =
          row.version === '0.9.0'
            ? old9
            : row.version === '0.12.0'
              ? old12
              : row.version === '0.13.0'
                ? old13
                : undefined
        if (old) {
          const decoder =
            row.operation === 'get' ? old.ticketWireSchema : old.ticketListingWireSchema
          assert.equal(decoder.safeParse(actual).success, true, `${label}: frozen decoder`)
        }
      }
      projections++
    }
  }
  assert.equal(
    refused,
    corpus.cases.filter((row) => !row.supported).length,
    'every recorded refusal replayed',
  )
  assert.equal(
    projections,
    corpus.cases.filter((row) => compatibilityReplayKind(row) === 'projection').length,
    'every admitted read projection replayed',
  )
  assert.ok(refused > 0 && projections > 0)
  return { refused, projections }
}
