import { describeTicketSourceContract, FakeTicketSource } from 'autobuild/plugin-sdk'
import { HostedTicketSource } from 'autobuild/remote-tickets'
import { mintToken } from 'autobuild/remote-store'
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
  const service = createHostedStoreService({
    env,
    clock: () => now,
    sourceFor: () => backend,
  })
  const token = mintToken(secret, {
    operator: true,
    session: '*',
    exp: now.getTime() + 60_000,
  })
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
