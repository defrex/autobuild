import { ticketProject } from './testing/ticket-project'
import { expect, test } from 'bun:test'
import { describeTicketSourceContract, FakeTicketSource } from '@defrex/autobuild/plugin-sdk'
import { HostedTicketSource } from './remote-tickets'
import { createHostedStoreService } from './service'

const now = new Date('2026-01-01T00:00:00.000Z')
const secret = 'hosted-ticket-contract-secret'
const env = {
  AB_STORE_SECRET: secret,
  AB_POSTGRES_URL: 'postgres://unused/injected',
  AB_BLOB_BACKEND: 's3',
  AB_S3_BUCKET: 'unused',
  AB_S3_REGION: 'unused',
  AB_S3_ACCESS_KEY_ID: 'unused',
  AB_S3_SECRET_ACCESS_KEY: 'unused',
}

describeTicketSourceContract('hosted service composition', async () => {
  const backend = new FakeTicketSource([], { doneState: 'Done' })
  const project = await ticketProject('https://github.com/acme/tickets', secret, () => now)
  const service = createHostedStoreService({
    ...project,
    env,
    clock: () => now,
    sourceFor: () => backend,
  })
  const token = project.token
  return {
    source: new HostedTicketSource({
      url: 'https://hosted.example',
      token,
      teamKey: 'ENG',
      claimedState: 'Doing',
      createState: 'Triage',
      fetchFn: (input, init) => {
        if (input instanceof Request) return service.fetch(new Request(input, init))
        return service.fetch(new Request(input.toString(), init))
      },
    }),
    states: { ready: 'Ready', claimed: 'Doing', completed: 'Done' },
    editableLabel: 'autobuild',
  }
})

test.each([true, undefined])('real hosted transport preserves listing hint %s', async (hint) => {
  const backend = new FakeTicketSource([])
  backend.listReady = async () => ({
    tickets: [
      {
        ref: { source: 'linear', id: 'ENG-1', title: 'Example' },
        title: 'Example',
        body: 'Spec',
        resolved: false,
        labels: [],
        blockedBy: ['ENG-2'],
        ...(hint === undefined ? {} : { blockersResolved: hint }),
      },
    ],
    diagnostics: [],
  })
  const project = await ticketProject('https://github.com/acme/tickets', secret, () => now)
  const service = createHostedStoreService({
    ...project,
    env,
    clock: () => now,
    sourceFor: () => backend,
  })
  const token = project.token
  const source = new HostedTicketSource({
    url: 'https://hosted.example',
    token,
    teamKey: 'ENG',
    fetchFn: (input, init) => service.fetch(new Request(input.toString(), init)),
  })
  const ticket = (await source.listReady({})).tickets[0]!
  expect(ticket.blockersResolved).toBe(hint)
  expect(Object.hasOwn(ticket, 'blockersResolved')).toBe(hint !== undefined)
})
