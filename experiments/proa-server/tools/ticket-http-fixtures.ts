/** Actual TypeScript handler responses; source is an in-memory TicketSource.
 * This oracle deliberately does not claim PostgreSQL or native parity. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { FakeTicketSource } from '../../../packages/core/src/ports/tickets/fake'
import { createTicketServer } from '../../../packages/hosted-store-service/src/ticket-server'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
  RELEASE_LINE_PROTOCOLS,
  classifyClient,
  supportedClientRange,
} from '../../../packages/core/src/store/remote/index'
import * as old9 from '../../../packages/hosted-store-service/src/compatibility-fixtures/tickets-v0.9'
import * as old12 from '../../../packages/hosted-store-service/src/compatibility-fixtures/tickets-v0.12'
import * as old13 from '../../../packages/hosted-store-service/src/compatibility-fixtures/tickets-v0.13'
import { ticketOperationInputs } from './ticket-protocol-fixtures'
import type { HostedTicketOperation } from '../../../packages/core/src/ports/tickets/remote-protocol'

const file = resolve(import.meta.dir, '../fixtures/ticket-http.json')
const sources = [
  'packages/hosted-store-service/src/ticket-server.ts',
  'packages/hosted-store-service/src/compatibility-fixtures/tickets-v0.9.ts',
  'packages/hosted-store-service/src/compatibility-fixtures/tickets-v0.12.ts',
  'packages/hosted-store-service/src/compatibility-fixtures/tickets-v0.13.ts',
  'packages/core/src/ports/tickets/fake.ts',
]
export interface TicketHttpFixtureCase {
  version: string
  supported: boolean
  capabilities: Record<string, string>
  operation: HostedTicketOperation
  request: { context: { teamKey: string }; input: unknown }
  headers: Record<string, string>
  status: number
  body: unknown
  sourceCalls: number
  historicalDecode?: boolean
}
export async function ticketHttpContract() {
  const cases: TicketHttpFixtureCase[] = []
  for (const version of [AUTOBUILD_VERSION, '0.9.0', '0.12.0', '0.13.0', 'invalid']) {
    const supported = classifyClient(version, supportedClientRange()) === 'supported'
    for (const capabilities of [
      {},
      { tree: '1' },
      { revisions: '1' },
      { comments: '1' },
      { tree: '1', revisions: '1', comments: '1' },
      { tree: 'unknown', revisions: 'unknown', comments: 'unknown' },
    ]) {
      for (const [operation, input] of Object.entries(ticketOperationInputs)) {
        const source = new FakeTicketSource([
          {
            ref: { source: 'database', id: 'ENG-1', title: 'Ticket' },
            kind: 'work',
            revision: 'seed',
            title: 'Ticket',
            body: 'Body\n',
            state: 'ready',
            resolved: false,
            labels: [],
          },
        ])
        // Match the real database adapter's empty-comment get shape. This
        // exercises the independent comments capability in the recorded corpus.
        const get = source.get.bind(source)
        source.get = async (id) => {
          const ticket = await get(id)
          return ticket === null ? null : { ...ticket, comments: [] }
        }
        let sourceCalls = 0
        const server = createTicketServer({
          secret: 'offline-fixture',
          auth: { authenticate: async () => ({ kind: 'admin', user: 'fixture' }) },
          sourceFor: () => {
            sourceCalls++
            return source
          },
          statesFor: async () => ['triage', 'ready', 'doing', 'done'],
        })
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'x-autobuild-version': version,
          'x-autobuild-protocol-version':
            version === AUTOBUILD_VERSION
              ? REMOTE_STORE_PROTOCOL_VERSION
              : (RELEASE_LINE_PROTOCOLS[version.split('.').slice(0, 2).join('.')] ??
                REMOTE_STORE_PROTOCOL_VERSION),
        }
        for (const [name, value] of Object.entries(capabilities))
          headers[`x-autobuild-ticket-${name}`] = value
        const request = { context: { teamKey: 'ENG' }, input }
        const response = await server.fetch(
          new Request(`https://fixture/tickets/${operation}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(request),
          }),
        )
        const body: unknown = await response.json()
        let historicalDecode: boolean | undefined
        if (
          operation === 'get' &&
          response.status === 200 &&
          Object.keys(capabilities).length === 0
        ) {
          const schema =
            version === '0.9.0'
              ? old9.ticketWireSchema
              : version === '0.12.0'
                ? old12.ticketWireSchema
                : version === '0.13.0'
                  ? old13.ticketWireSchema
                  : undefined
          if (schema) {
            historicalDecode = schema.safeParse(body).success
            if (!historicalDecode) throw Error(`Historical decoder rejected ${version}`)
          }
        }
        if (!supported && sourceCalls !== 0)
          throw Error(`Refused version reached source: ${version}`)
        cases.push({
          version,
          supported,
          capabilities: Object.fromEntries(
            Object.entries(capabilities).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          operation: operation as HostedTicketOperation,
          request,
          headers,
          status: response.status,
          body,
          sourceCalls,
          ...(historicalDecode === undefined ? {} : { historicalDecode }),
        })
      }
    }
  }
  return {
    format: 1,
    scope: 'TypeScript HTTP oracle using FakeTicketSource; not a persistence proof',
    sources: Object.fromEntries(
      sources.map((path) => [
        path,
        createHash('sha256')
          .update(readFileSync(resolve(import.meta.dir, '../../..', path)))
          .digest('hex'),
      ]),
    ),
    cases,
  }
}
export async function checkTicketHttpContract() {
  if (
    !isDeepStrictEqual(
      await Bun.file(file).json(),
      JSON.parse(JSON.stringify(await ticketHttpContract())),
    )
  )
    throw Error('Ticket HTTP oracle drifted; run tools/ticket-http-fixtures.ts --write')
}
if (import.meta.main) {
  if (process.argv.includes('--write'))
    await Bun.write(file, `${JSON.stringify(await ticketHttpContract(), null, 2)}\n`)
  else await checkTicketHttpContract()
}
