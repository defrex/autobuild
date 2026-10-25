/** Lossless asset paths, labels, historical envelopes and compressed pins. */
import { strict as assert } from 'node:assert'
import { SQL } from 'bun'
import { MemoryBuildStore } from '../../../packages/core/src/store/memory'
import { buildCreatedWrite } from '../../../packages/core/src/store/contract'
import { prepareAssetSnapshots } from '../../../packages/core/src/store/ticket-asset-snapshots'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'
export async function proveProtocolAssetUnicode(executable: string) {
  let comparisons = 0
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (env) => {
      const clock = () => new Date('2030-01-01T00:00:00.000Z'),
        ts = await openPostgresBuildStoreFromEnv(env, { clock }),
        sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 })
      const native = await startProtocolServer({ executable, env, clock }),
        oracle = createStoreServer({ store: ts, clock })
      const headers = {
        'content-type': 'application/json',
        'x-autobuild-version': AUTOBUILD_VERSION,
        'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
      }
      const path = '/repos/unicode-assets/tickets/TICK-1/assets'
      const compare = async (suffix: string, body?: unknown, status = 200) => {
        const init = {
          method: body === undefined ? 'GET' : 'POST',
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }
        const a = await native.fetch(native.url + path + suffix, init)
        if (a.status === 201)
          await sql`DELETE FROM ticket_assets WHERE repo='unicode-assets' AND ticket_id='TICK-1' AND kind='design' AND name='reference' AND revision=(SELECT MAX(revision) FROM ticket_assets WHERE repo='unicode-assets' AND ticket_id='TICK-1' AND kind='design' AND name='reference')`
        const b = await oracle.fetch(new Request(`http://oracle${path}${suffix}`, init))
        const actual = { status: a.status, body: await a.json() },
          expected = { status: b.status, body: await b.json() }
        assert.deepEqual(actual, expected, `${suffix} ${JSON.stringify(body)}`)
        assert.equal(a.status, status)
        comparisons++
        return actual.body
      }
      try {
        await ts.ensureRepo('unicode-assets')
        const base = {
          kind: 'design',
          name: 'reference',
          layout: 'file',
          entries: [{ type: 'file', path: 'a', contentBase64: 'YQ==' }],
        }
        for (const kind of ['\ud800', '\udfff', '💩']) await compare('', { ...base, kind }, 422)
        for (const path of ['\ud800', '\udfff', 'a\ud800'])
          await compare(
            '',
            { ...base, entries: [{ type: 'file', path, contentBase64: 'YQ==' }] },
            201,
          )
        await compare(
          '',
          {
            ...base,
            layout: 'tree',
            entries: [
              { type: 'dir', path: '\ud800' },
              { type: 'dir', path: '\ud800' },
            ],
          },
          422,
        )
        await compare(
          '',
          {
            ...base,
            layout: 'tree',
            entries: [
              { type: 'file', path: '\ud800', contentBase64: 'YQ==' },
              { type: 'dir', path: '\ud800/a' },
            ],
          },
          422,
        )
        await compare(
          '',
          {
            ...base,
            entries: [
              {
                type: 'file',
                path: `${'a'.repeat(39)}💩${'a'.repeat(220)}`,
                contentBase64: 'YQ==',
              },
            ],
          },
          422,
        )
        await compare('/remove', { kind: '\ud800', name: 'reference' })
        // Install the historical inner-JSON envelope accepted by the source json helper.
        const bytes = new TextEncoder().encode('a'),
          hash = (
            await ts.putRepoArtifact('unicode-assets', { kind: 'envelope-content', content: bytes })
          ).blobRef
        const entries = [
          { type: 'file', path: '\ud800', size: 1, blobRef: hash },
          { type: 'dir', path: '�' },
        ]
        await sql`DELETE FROM ticket_assets WHERE repo='unicode-assets' AND ticket_id='TICK-1'`
        const envelope = JSON.stringify(entries)
        await sql`INSERT INTO ticket_assets(repo,ticket_id,kind,name,revision,layout,manifest,size,removed,created_at) VALUES('unicode-assets','TICK-1','design','reference',0,'tree',${envelope}::jsonb,1,false,${clock().toISOString()})`
        await compare('?kind=design&name=reference')
        await compare('/list')
        await compare('/file?kind=design&name=reference&path=%EF%BF%BD', undefined, 404)
        // Compare remove independently: native consumes the row, so restore before TS.
        const request = {
          method: 'POST',
          headers,
          body: JSON.stringify({ kind: 'design', name: 'reference' }),
        }
        const removed = await native.fetch(`${native.url + path}/remove`, request)
        const actual = { status: removed.status, body: await removed.json() }
        await sql`DELETE FROM ticket_assets WHERE repo='unicode-assets' AND ticket_id='TICK-1' AND revision=1`
        const sourceRemoved = await oracle.fetch(
          new Request(`http://oracle${path}/remove`, request),
        )
        assert.deepEqual(actual, { status: sourceRemoved.status, body: await sourceRemoved.json() })
        comparisons++
        const limited = await startProtocolServer({
          executable,
          env: { ...env, PROA_TEST_ASSET_MAX_BYTES: '500' },
          clock,
        })
        const limitedOracle = createStoreServer({
            store: ts,
            clock,
            maxTicketAssetRequestBytes: 500,
          }),
          wire = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => limitedOracle.fetch(r) })
        try {
          const plain = JSON.stringify({
            ...base,
            name: 'ceiling',
            entries: [{ type: 'file', path: 'a', contentBase64: '' }],
          })
          const cases = [
            Buffer.concat([
              Buffer.from([239, 187, 191]),
              Buffer.from(plain + ' '.repeat(500 - Buffer.byteLength(plain))),
            ]),
            Buffer.concat([
              Buffer.from([239, 187, 191]),
              Buffer.from(plain + ' '.repeat(501 - Buffer.byteLength(plain))),
            ]),
          ]
          const prefix = Buffer.from(`${plain.slice(0, -1)},"discarded":"`),
            suffix = Buffer.from('"}')
          for (const size of [500, 501]) {
            const raw = Buffer.concat([prefix, Buffer.from([255]), suffix])
            cases.push(Buffer.concat([raw, Buffer.alloc(size - (raw.length + 2), 32)]))
          }
          for (const body of cases) {
            await sql`DELETE FROM ticket_assets WHERE repo='unicode-assets' AND ticket_id='TICK-1' AND name='ceiling'`
            const init = { method: 'POST', headers, body }
            const a = await limited.fetch(limited.url + path, init)
            if (a.status === 201)
              await sql`DELETE FROM ticket_assets WHERE repo='unicode-assets' AND ticket_id='TICK-1' AND name='ceiling'`
            const b = await fetch(new URL(path, wire.url), init)
            assert.deepEqual(
              { status: a.status, body: await a.json() },
              { status: b.status, body: await b.json() },
            )
            comparisons++
          }
        } finally {
          wire.stop(true)
          await limited.close()
        }
        const source = new MemoryBuildStore(),
          create = buildCreatedWrite(),
          ticket = create.payload.ticket.id
        await source.putTicketAsset('unicode-assets', ticket, {
          kind: 'design',
          name: 'pinned',
          layout: 'tree',
          entries: [
            { type: 'file', path: '\ud800', content: bytes },
            { type: 'dir', path: '�' },
            { type: 'file', path: 'pair-💩', content: new Uint8Array() },
          ],
        })
        const pins = await prepareAssetSnapshots(source, ts, 'unicode-assets', ticket)
        await ts.createBuild({
          slug: 'unicode-snapshot',
          repo: 'unicode-assets',
          ticket: create.payload.ticket,
          created: {
            ...create,
            payload: { ...create.payload, repo: 'unicode-assets', assets: pins },
          },
        })
        const snapshotPath = '/builds/unicode-snapshot/ticket-assets?kind=design&name=pinned'
        const a = await native.fetch(native.url + snapshotPath, { headers }),
          b = await oracle.fetch(new Request(`http://oracle${snapshotPath}`, { headers }))
        assert.deepEqual(
          { status: a.status, body: await a.json() },
          { status: b.status, body: await b.json() },
        )
        assert.equal(a.status, 200)
        comparisons++
        const snapshot = await ts.getPinnedTicketAsset('unicode-snapshot', 'design', 'pinned')
        assert.equal(snapshot?.entries[0]?.path, '\ud800')
      } finally {
        await native.close()
        await ts.close()
        await sql.close()
      }
    }),
  )
  return {
    comparisons,
    groups: [
      'UTF16 label/path errors',
      'manifest JSON string envelopes',
      'historical manifest envelope',
      'exact path equality',
      'tombstone response',
      'gzip snapshot paths',
      'decoded UTF8/BOM deployment ceilings',
    ],
  }
}
