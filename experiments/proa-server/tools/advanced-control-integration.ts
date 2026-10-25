/** Replay advanced TypeScript control scenarios through native HTTP and read
 * every native artifact through the actual TypeScript PostgreSQL/blob adapters. */
import { strict as assert } from 'node:assert'
import { gunzipSync } from 'node:zlib'
import type { SQL } from 'bun'
import type { BuildStore } from '../../../packages/core/src/store/types'
import { validateEventWrite } from '../../../packages/core/src/events/catalog'
import { validateRepositoryEventWrite } from '../../../packages/core/src/events/repository'
import { reduceBuild } from '../../../packages/core/src/kernel/reducer'
import { readAssetSnapshot } from '../../../packages/core/src/store/ticket-asset-snapshots'
import { PostgresTicketSource } from '../../../packages/postgres-store/src/tickets'
import { mintToken } from '../../../packages/core/src/store/remote/token'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { operatorClock, operatorRepo } from './operator-fixtures'
import {
  advancedLifecycle,
  advancedBindings,
  advancedSnapshot,
  checkAdvancedCorpus,
} from './advanced-control-fixtures'
function project(value: unknown, repo: string, prefix: string): unknown {
  if (typeof value === 'string')
    return value
      .replaceAll(operatorRepo, repo)
      .replaceAll('advanced-build', `${prefix}-build`)
      .replaceAll('advanced-contribution', `${prefix}-contribution`)
      .replaceAll('advanced-open', `${prefix}-open`)
  if (Array.isArray(value)) return value.map((item) => project(item, repo, prefix))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, project(item, repo, prefix)]),
    )
  return value
}
async function snapshotOrder(store: BuildStore, repo: string, slugs: string[]) {
  const kinds: string[] = []
  for (const slug of slugs) {
    const state = reduceBuild(await store.getEvents(slug))
    for (const pin of state.pinnedAssets) {
      if (!pin.snapshot) continue
      const manifest = await store.getRepoArtifact(repo, pin.snapshot.kind, pin.snapshot.revision)
      assert.ok(manifest, 'native snapshot manifest is readable through TypeScript')
      const decoded = JSON.parse(gunzipSync(manifest.content).toString('utf8')) as {
        files: { chunks: { kind: string }[] }[]
        meta: {
          repo: string
          ticketId: string
          kind: string
          name: string
          revision: number
          layout: string
          size: number
          entries: unknown[]
        }
      }
      for (const file of decoded.files) for (const chunk of file.chunks) kinds.push(chunk.kind)
      kinds.push(pin.snapshot.kind)
      // This is the actual core consumer and verifies manifest metadata,
      // chunk identities, byte lengths, hashes and the reconstructed asset.
      const record = await store.getBuild(slug)
      assert.equal(decoded.meta.repo, repo, `${slug}: manifest repo`)
      assert.equal(decoded.meta.ticketId, record!.ticket!.id, `${slug}: manifest ticket`)
      for (const key of ['kind', 'name', 'revision', 'layout', 'size'] as const)
        assert.equal(decoded.meta[key], pin[key], `${slug}: manifest ${key}`)
      await readAssetSnapshot(store, repo, record!.ticket!.id, pin)
    }
  }
  return kinds
}
export async function replayAdvancedControls(options: {
  sql: SQL
  store: BuildStore
  address: string
}) {
  const corpus = await checkAdvancedCorpus()
  const checked: string[] = []
  for (const original of corpus.fixtures) {
    const prefix = `advanced-${original.id}`
    const repo = `advanced-fixture/${original.id}`
    const fixture = project(original, repo, prefix) as typeof original
    const [registration] =
      await options.sql`INSERT INTO project_journal(seq,repo,action,actor,ts) VALUES(nextval('project_journal_seq'),${repo},'added','fixture',${operatorClock}) RETURNING seq`
    if (fixture.ticketBackend)
      await options.sql`INSERT INTO project_ticket_policy(repo,registration,policy,writer,updated_at) VALUES(${repo},${registration.seq},${{ tickets: fixture.config.tickets }},'fixture',${operatorClock})`
    const tickets = new PostgresTicketSource(
      options.sql,
      { repo, teamKey: 'ENG', lifecycle: advancedLifecycle },
      advancedLifecycle,
    )
    for (const ticket of fixture.tickets) {
      await tickets.create(
        {
          kind: ticket.kind,
          target: ticket.target,
          title: ticket.title,
          body: ticket.body,
          labels: ticket.labels,
        },
        { requestedId: ticket.ref.id },
      )
      await tickets.transition(ticket.ref.id, ticket.state!)
      if (fixture.id === 'revise-hosted-legacy-alias' && ticket.ref.id === 'ENG-1')
        await options.sql`UPDATE ab_tickets SET id='storage-ticket-1' WHERE repo=${repo} AND readable_id='ENG-1'`
    }
    for (const input of fixture.inputs) {
      await options.store.createBuild(input)
      const seed = fixture.seed.builds.find((build) => build.record!.slug === input.slug)!
      for (const event of seed.events.slice(1))
        await options.store.append(input.slug, validateEventWrite(event))
      for (const artifact of seed.artifacts)
        await options.store.putArtifact(input.slug, {
          kind: artifact.meta.kind,
          content: Buffer.from(artifact.base64, 'base64'),
          metadata: artifact.meta.metadata,
        })
    }
    await options.store.ensureRepo(repo)
    for (const event of fixture.seed.repository)
      await options.store.appendRepo(repo, validateRepositoryEventWrite(event))
    for (const asset of fixture.assetSeeds) {
      await options.store.putTicketAsset(repo, asset.ticketId, {
        kind: asset.kind,
        name: asset.name,
        layout: asset.layout,
        entries: asset.entries.map((entry) =>
          entry.type === 'dir'
            ? entry
            : { type: 'file', path: entry.path, content: Buffer.from(entry.base64, 'base64') },
        ),
      })
      if (asset.removed)
        await options.store.removeTicketAsset(repo, asset.ticketId, asset.kind, asset.name)
    }
    const token = mintToken('offline-operator-fixture-secret', {
      version: 1,
      internalOperator: { repo, user: 'operator@example.com' },
      exp: new Date(operatorClock).getTime() + 60000,
    })
    const response = await fetch(
      `${options.address}/operator/v1/repos/${encodeURIComponent(repo)}/${fixture.request.path}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-autobuild-version': AUTOBUILD_VERSION,
          'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify(fixture.request.body),
      },
    )
    const body: unknown = await response.json()
    assert.equal(response.status, fixture.status, `${fixture.id}: ${JSON.stringify(body)}`)
    assert.deepEqual(body, fixture.body, `${fixture.id}: HTTP response`)
    const slugs = fixture.inputs.map((input) => input.slug)
    const kinds = await snapshotOrder(options.store, repo, slugs)
    const actual = await advancedSnapshot(options.store, repo, slugs, kinds)
    for (const build of actual.builds) build.events.forEach(validateEventWrite)
    actual.repository.forEach(validateRepositoryEventWrite)
    const normalized = JSON.parse(
      JSON.stringify(advancedBindings(actual, kinds, actual.manifestHashes)),
    ) as typeof actual
    assert.deepEqual(
      normalized,
      fixture.after,
      `${fixture.id}: native bytes/metadata/events/state read through TypeScript`,
    )
    checked.push(fixture.id)
  }
  return checked
}
