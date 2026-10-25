/** Read-only TypeScript ticket wire oracle for the native transport. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  HOSTED_TICKET_OPERATIONS,
  hostedTicketRequestSchemas,
  hostedTicketPolicySchema,
} from '../../../packages/core/src/ports/tickets/remote-protocol'

// Deliberately explicit: a new operation must get a classified valid example.
export const ticketOperationInputs = {
  'mutate-if-revision': {
    id: 'ENG-1',
    expectedRevision: '1',
    mutation: { kind: 'update', patch: { title: 'Changed' } },
  },
  'list-ready': {},
  states: {},
  'add-state': { name: 'review', about: 'Review' },
  get: { id: 'ENG-1' },
  claim: { id: 'ENG-1' },
  comment: { id: 'ENG-1', body: 'Comment\n' },
  transition: { id: 'ENG-1', state: 'done' },
  create: { draft: { title: 'Ticket', body: 'Body\n' } },
  update: { id: 'ENG-1', patch: { title: 'Changed' } },
  'add-blocker': { id: 'ENG-1', blockerId: 'ENG-2' },
  'remove-blocker': { id: 'ENG-1', blockerId: 'ENG-2' },
  'dependency-states': { ids: ['ENG-2', 'ENG-1', 'ENG-2'] },
} satisfies Record<keyof typeof hostedTicketRequestSchemas, unknown>

const fixturePath = resolve(import.meta.dir, '../fixtures/ticket-protocol.json')
const context = { teamKey: 'ENG', repo: 'owner/repo' }
const sourcePaths = [
  'packages/core/src/ports/tickets/remote-protocol.ts',
  'packages/hosted-store-service/src/ticket-server.ts',
  'packages/postgres-store/src/ticket-policy.ts',
  'packages/postgres-store/src/ticket-grants.ts',
]

export function ticketProtocolContract() {
  if (
    !isDeepStrictEqual(
      Object.keys(ticketOperationInputs).sort(),
      [...HOSTED_TICKET_OPERATIONS].sort(),
    )
  )
    throw Error('Unclassified ticket operation')
  const cases = HOSTED_TICKET_OPERATIONS.flatMap((operation) => {
    const schema = hostedTicketRequestSchemas[operation]
    const input = ticketOperationInputs[operation]
    const valid = { context, input }
    if (!schema.safeParse(valid).success) throw Error(`Invalid oracle seed: ${operation}`)
    const probes: [string, unknown][] = [
      ['valid', valid],
      ['null', null],
      ['missing-context', { input }],
      ['missing-input', { context }],
      ['unknown-envelope', { ...valid, extra: true }],
      ['unknown-context', { context: { ...context, extra: true }, input }],
      ['unknown-input', { context, input: { ...input, extra: true } }],
      ['empty-team', { context: { teamKey: '' }, input }],
      ['null-input', { context, input: null }],
    ]
    for (const [key, value] of Object.entries(input)) {
      probes.push([`null-${key}`, { context, input: { ...input, [key]: null } }])
      const missing = { ...input } as Record<string, unknown>
      delete missing[key]
      probes.push([`missing-${key}`, { context, input: missing }])
      probes.push([`wrong-type-${key}`, { context, input: { ...input, [key]: 42 } }])
      if (typeof value === 'string')
        probes.push([`empty-${key}`, { context, input: { ...input, [key]: '' } }])
    }
    const nested = (name: string, input: unknown) => probes.push([name, { context, input }])
    if (operation === 'update' || operation === 'create') {
      const field = operation === 'create' ? 'draft' : 'patch'
      for (const [name, value] of Object.entries({
        empty: {},
        unknown: { future: true },
        kind: { kind: 'other' },
        target: { target: ' \uFEFF' },
        title: { title: '' },
        labels: { labels: [1, null, 'valid'] },
        nullable: { target: null },
      }))
        nested(`nested-${name}`, { ...input, [field]: value })
    }
    if (operation === 'create') {
      for (const options of [
        null,
        {},
        { requestedId: '' },
        { requestedId: 1 },
        { state: null },
        { idempotencyKey: 1 },
        { extra: true },
      ])
        nested(`options-${JSON.stringify(options)}`, { ...input, options })
    }
    if (operation === 'mutate-if-revision') {
      for (const mutation of [
        {},
        { kind: 'other' },
        { kind: 'update', patch: {} },
        { kind: 'transition', state: '' },
        { kind: 'blockers', operation: 'other', ids: [1] },
        { kind: 'update', patch: { target: null } },
      ])
        nested(`mutation-${JSON.stringify(mutation)}`, { ...input, mutation })
    }
    return probes.map(([name, request]) => {
      const result = schema.safeParse(request)
      return {
        operation,
        name,
        request,
        ...(result.success ? { output: result.data } : { issues: result.error.issues }),
      }
    })
  })
  const policy = {
    version: 1,
    tickets: {
      source: 'hosted',
      teamKey: 'ENG',
      readyState: 'ready',
      triageState: 'triage',
      claimedState: 'doing',
      doneState: 'done',
      createState: 'triage',
      proposalState: 'triage',
    },
  }
  const policies = [
    policy,
    { ...policy, secret: 'forbidden' },
    { ...policy, version: 2 },
    ...Object.keys(policy.tickets).map((key) => ({
      ...policy,
      tickets: { ...policy.tickets, [key]: '' },
    })),
  ].map((request) => {
    const result = hostedTicketPolicySchema.safeParse(request)
    return {
      request,
      ...(result.success ? { output: result.data } : { issues: result.error.issues }),
    }
  })
  return {
    format: 1,
    scope:
      'request-schema oracle; HTTP, persistence, grants and historical response parity require integration evidence',
    sources: Object.fromEntries(
      sourcePaths.map((path) => [
        path,
        createHash('sha256')
          .update(readFileSync(resolve(import.meta.dir, '../../..', path)))
          .digest('hex'),
      ]),
    ),
    operations: HOSTED_TICKET_OPERATIONS,
    cases,
    policies,
  }
}

export async function checkTicketProtocolContract() {
  const expected = JSON.parse(JSON.stringify(ticketProtocolContract()))
  if (!isDeepStrictEqual(await Bun.file(fixturePath).json(), expected))
    throw Error('Ticket protocol oracle drifted; run tools/ticket-protocol-fixtures.ts --write')
}

if (import.meta.main) {
  if (process.argv.includes('--write'))
    await Bun.write(
      fixturePath,
      `${JSON.stringify(ticketProtocolContract(), null, 2).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`,
    )
  else await checkTicketProtocolContract()
}
