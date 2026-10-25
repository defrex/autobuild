/** Native ticket asset family proof. Importing never starts database tests. */
import { strict as assert } from 'node:assert'
import { SQL } from 'bun'
import { gzipSync } from 'node:zlib'
import { HostedTicketSource } from '../../../packages/core/src/ports/tickets/remote'
import { RemoteBuildStore } from '../../../packages/core/src/store/remote/client'
import { MemoryBuildStore } from '../../../packages/core/src/store/memory'
import { buildCreatedWrite } from '../../../packages/core/src/store/contract'
import { prepareAssetSnapshots } from '../../../packages/core/src/store/ticket-asset-snapshots'
import { openPostgresTicketDatabase } from '../../../packages/postgres-store/src/tickets'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import { createMachineAuth } from '../../../packages/hosted-store-service/src/machine-auth'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'
import { assetFixtures } from './protocol-asset-fixtures'

export async function proveProtocolAssets(executable: string) {
  const checks: string[] = []
  let comparisons = 0
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (env) => {
      let now = new Date('2030-01-01T00:00:00.000Z')
      const clock = () => now
      const ts = await openPostgresBuildStoreFromEnv(env, { clock })
      const sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 })
      const running: Awaited<ReturnType<typeof startProtocolServer>>[] = []
      const start = async (overrides: Record<string, string | undefined> = {}) => {
        const server = await startProtocolServer({
          executable,
          env: { ...env, ...overrides },
          clock,
        })
        running.push(server)
        return { server, store: new RemoteBuildStore({ url: server.url, fetchFn: server.fetch }) }
      }
      const headers = {
        'content-type': 'application/json',
        'x-autobuild-version': AUTOBUILD_VERSION,
        'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
      }
      let failure: unknown
      try {
        const a = await start(),
          b = await start()
        const repo = 'asset-repo',
          ticket = 'TICK-1'
        const encoded = new TextEncoder()
        const file = (text: string) => ({
          kind: 'design',
          name: 'reference',
          layout: 'file' as const,
          entries: [{ type: 'file' as const, path: 'a.txt', content: encoded.encode(text) }],
        })
        const meta = await a.store.putTicketAsset(repo, ticket, file('native one'))
        assert.equal(meta.revision, 0)
        assert.deepEqual(
          await a.store.getTicketAsset(repo, ticket, 'design', 'reference'),
          await ts.getTicketAsset(repo, ticket, 'design', 'reference'),
        )
        assert.equal(await ts.getRepo(repo), null)
        assert.equal(await a.store.getRepoChangePosition(repo), '0')
        const fromTS = await ts.putTicketAsset(repo, ticket, file('typescript two'))
        assert.equal(fromTS.revision, 1)
        assert.deepEqual(
          await b.store.getTicketAsset(repo, ticket, 'design', 'reference'),
          await ts.getTicketAsset(repo, ticket, 'design', 'reference'),
        )
        const tree = {
          kind: 'design',
          name: 'tree',
          layout: 'tree' as const,
          entries: [
            { type: 'dir' as const, path: 'empty' },
            { type: 'file' as const, path: 'nul.bin', content: new Uint8Array([0, 255, 128, 10]) },
            { type: 'file' as const, path: 'zero', content: new Uint8Array() },
          ],
        }
        await a.store.putTicketAsset(repo, ticket, tree)
        assert.deepEqual(
          await b.store.getTicketAsset(repo, ticket, 'design', 'tree'),
          await ts.getTicketAsset(repo, ticket, 'design', 'tree'),
        )
        assert.deepEqual(
          await b.store.listTicketAssets(repo, ticket),
          await ts.listTicketAssets(repo, ticket),
        )
        checks.push(
          'asset writes precede repository journal; binary/empty/tree bytes and metadata cross-read both languages',
        )
        const mixed = await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            (i % 2 ? a.store : ts).putTicketAsset(repo, ticket, {
              ...file(String(i)),
              name: 'mixed',
            }),
          ),
        )
        assert.deepEqual(
          mixed.map((x) => x.revision).sort((a, b) => a - b),
          [0, 1, 2, 3, 4, 5, 6, 7],
        )
        assert.deepEqual(
          await b.store.listTicketAssets(repo, ticket, { revisions: true }),
          await ts.listTicketAssets(repo, ticket, { revisions: true }),
        )
        checks.push('mixed native/TypeScript advisory-lock revision assignment is contiguous')
        const removed = await a.store.removeTicketAsset(repo, ticket, 'design', 'reference')
        assert.deepEqual(removed, fromTS)
        assert.equal(await b.store.getTicketAsset(repo, ticket, 'design', 'reference'), null)
        assert.equal(await b.store.removeTicketAsset(repo, ticket, 'design', 'reference'), null)
        assert.equal((await b.store.putTicketAsset(repo, ticket, file('restored'))).revision, 3)
        assert.equal(
          (await a.store.getTicketAsset(repo, ticket, 'design', 'reference', 0))!.meta.revision,
          0,
        )
        checks.push(
          'removal consumes one tombstone revision, preserves history, is idempotent and restore skips tombstone',
        )
        const pinOf = (m: typeof meta) => ({
          kind: m.kind,
          name: m.name,
          revision: m.revision,
          layout: m.layout,
          size: m.size,
          fileCount: 1,
          dirCount: 0,
        })
        const create = buildCreatedWrite()
        const created = { ...create, payload: { ...create.payload, repo, assets: [pinOf(meta)] } }
        await a.store.createBuild({
          slug: 'asset-pinned',
          repo,
          ticket: create.payload.ticket,
          created,
        })
        assert.deepEqual(
          await b.store.getPinnedTicketAsset('asset-pinned', 'design', 'reference'),
          await ts.getPinnedTicketAsset('asset-pinned', 'design', 'reference'),
        )
        const pinnedEntry = (await b.store.getPinnedTicketAsset(
          'asset-pinned',
          'design',
          'reference',
        ))!.entries[0]!
        assert.equal(pinnedEntry.type, 'file')
        assert.equal(
          new TextDecoder().decode(pinnedEntry.type === 'file' ? pinnedEntry.content : undefined),
          'native one',
        )
        await a.store.append('asset-pinned', {
          actor: { kind: 'kernel' },
          type: 'spec.revised',
          payload: { artifact: { kind: 'spec', rev: 1 }, escalation: 1, assets: [] },
        })
        assert.equal(
          await b.store.getPinnedTicketAsset('asset-pinned', 'design', 'reference'),
          null,
        )
        assert.equal(
          (await b.store.getPinnedTicketAsset('asset-pinned', 'design', 'reference', 0))!.meta
            .revision,
          0,
        )
        assert.equal(
          await b.store.getPinnedTicketAsset('asset-pinned', 'design', 'reference', 1),
          null,
        )
        checks.push(
          'latest pin replacement and explicit historical pin lookup use durable build facts, not ticket latest state',
        )
        const source = new MemoryBuildStore()
        const content = new Uint8Array(700000)
        for (let i = 0; i < content.length; i++) content[i] = i % 251
        await source.putTicketAsset(repo, ticket, {
          kind: 'design',
          name: 'snapshot',
          layout: 'tree',
          entries: [
            { type: 'dir', path: 'empty' },
            { type: 'file', path: 'large.bin', content },
            { type: 'file', path: 'zero', content: new Uint8Array() },
          ],
        })
        const pins = await prepareAssetSnapshots(source, a.store, repo, ticket)
        await a.store.createBuild({
          slug: 'asset-snapshot',
          repo,
          ticket: create.payload.ticket,
          created: { ...create, payload: { ...create.payload, repo, assets: pins } },
        })
        assert.deepEqual(
          await b.store.getPinnedTicketAsset('asset-snapshot', 'design', 'snapshot'),
          await ts.getPinnedTicketAsset('asset-snapshot', 'design', 'snapshot'),
        )
        checks.push(
          'gzip manifest snapshot pins reconstruct independently stored chunks, empty files and directories',
        )
        const tickets = await openPostgresTicketDatabase(env.AB_POSTGRES_URL!)
        try {
          const hosted = await tickets
            .source({
              repo,
              teamKey: 'ASSET',
              lifecycle: { triage: 'triage', ready: 'ready', doing: 'doing', done: 'done' },
            })
            .create({ title: 'Asset alias fixture', body: 'Immutable identity snapshot fixture' })
          const rows =
            await sql`SELECT id FROM ab_tickets WHERE repo=${repo} AND readable_id=${hosted.ref.id}`
          const opaque = String(rows[0]!.id)
          const hostedMeta = await a.store.putTicketAsset(
            repo,
            hosted.ref.id.toLowerCase(),
            file('hosted bytes'),
          )
          assert.equal(hostedMeta.ticketId, hosted.ref.id)
          assert.equal((await ts.putTicketAsset(repo, opaque, file('hosted updated'))).revision, 1)
          assert.deepEqual(
            await b.store.getTicketAsset(repo, opaque, 'design', 'reference'),
            await ts.getTicketAsset(repo, hosted.ref.id.toLowerCase(), 'design', 'reference'),
          )
          const stored =
            await sql`SELECT ticket_id FROM ticket_assets WHERE repo=${repo} AND ticket_id=${opaque}`
          assert.equal(stored.length, 2)
          const hostedPins = await prepareAssetSnapshots(
            a.store,
            a.store,
            repo,
            opaque,
            hosted.ref.id,
          )
          const hostedTicket = { ...create.payload.ticket, source: 'hosted', id: opaque }
          await a.store.createBuild({
            slug: 'hosted-asset-pin',
            repo,
            ticket: hostedTicket,
            created: {
              ...create,
              payload: { ...create.payload, repo, ticket: hostedTicket, assets: hostedPins },
            },
          })
          await sql`UPDATE ab_tickets SET readable_id='ASSET-99' WHERE repo=${repo} AND id=${opaque}`
          assert.equal(
            (await b.store.getPinnedTicketAsset('hosted-asset-pin', 'design', 'reference'))!.meta
              .ticketId,
            'ASSET-99',
          )
          assert.deepEqual(
            await b.store.getPinnedTicketAsset('hosted-asset-pin', 'design', 'reference'),
            await ts.getPinnedTicketAsset('hosted-asset-pin', 'design', 'reference'),
          )
          assert.deepEqual(
            await b.store.listTicketAssets(repo, opaque),
            await ts.listTicketAssets(repo, 'asset-99'),
          )
          checks.push(
            'hosted aliases share canonical storage revisions; readable identity changes preserve historical snapshot pins',
          )
        } finally {
          await tickets.close()
        }
        const oracle = createStoreServer({ store: ts, clock })
        const compare = async (path: string, method: string, body?: unknown) => {
          const init = {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }
          const [actual, expected] = await Promise.all([
            a.server.fetch(`${a.server.url}${path}`, init),
            oracle.fetch(new Request(`http://oracle${path}`, init)),
          ])
          assert.deepEqual(
            { status: actual.status, body: await actual.json() },
            { status: expected.status, body: await expected.json() },
            `${method} ${path}`,
          )
          comparisons++
        }
        const baseSnapshot = {
          version: 1,
          meta: {
            repo,
            ticketId: ticket,
            kind: 'design',
            name: 'corruption',
            revision: 0,
            layout: 'tree',
            size: 0,
            createdAt: clock().toISOString(),
            entries: [{ type: 'dir', path: 'empty' }],
          },
          files: [],
        }
        for (const [index, manifest] of [
          { ...baseSnapshot, extra: true },
          {
            ...baseSnapshot,
            meta: { ...baseSnapshot.meta, entries: [{ type: 'dir', path: '../unsafe' }] },
          },
          { ...baseSnapshot, files: [{ path: 'extra', chunks: [] }] },
          { ...baseSnapshot, meta: { ...baseSnapshot.meta, repo: 'wrong-repo' } },
        ].entries()) {
          const snapshot = await a.store.putRepoArtifact(repo, {
            kind: `ticket-snapshot-bad${index}`,
            content: gzipSync(JSON.stringify(manifest)),
          })
          const pin = {
            kind: 'design',
            name: 'corruption',
            revision: 0,
            layout: 'tree' as const,
            size: 0,
            fileCount: 0,
            dirCount: 1,
            snapshot: { kind: snapshot.kind, revision: snapshot.revision },
          }
          const slug = `asset-corrupt-${index}`
          await a.store.createBuild({
            slug,
            repo,
            ticket: create.payload.ticket,
            created: { ...create, payload: { ...create.payload, repo, assets: [pin] } },
          })
          await compare(`/builds/${slug}/ticket-assets?kind=design&name=corruption`, 'GET')
        }
        const manifestBytes = Buffer.from(JSON.stringify(baseSnapshot)),
          middle = Math.floor(manifestBytes.length / 2)
        const concatenated = await a.store.putRepoArtifact(repo, {
          kind: 'ticket-snapshot-f00d',
          content: Buffer.concat([
            gzipSync(manifestBytes.subarray(0, middle)),
            gzipSync(manifestBytes.subarray(middle)),
          ]),
        })
        const concatPin = {
          kind: 'design',
          name: 'corruption',
          revision: 0,
          layout: 'tree' as const,
          size: 0,
          fileCount: 0,
          dirCount: 1,
          snapshot: { kind: concatenated.kind, revision: concatenated.revision },
        }
        await a.store.createBuild({
          slug: 'asset-concat-snapshot',
          repo,
          ticket: create.payload.ticket,
          created: { ...create, payload: { ...create.payload, repo, assets: [concatPin] } },
        })
        assert.deepEqual(
          await b.store.getPinnedTicketAsset('asset-concat-snapshot', 'design', 'corruption'),
          await ts.getPinnedTicketAsset('asset-concat-snapshot', 'design', 'corruption'),
        )
        await compare(
          '/builds/asset-concat-snapshot/ticket-assets?kind=design&name=corruption',
          'GET',
        )
        checks.push(
          'corrupt snapshot schema, structure, file membership and identity refusals preserve exact TypeScript errors',
        )
        for (const row of assetFixtures().cases) {
          if ('accepted' in (row.oracle as object)) continue
          const input = row.input as { entries: { type: string; path: string; size?: number }[] }
          if (input.entries.some((e) => (e.size ?? 0) > 1000)) continue
          await compare('/repos/asset-repo/tickets/TICK-1/assets', 'POST', {
            ...input,
            entries: input.entries.map((e) =>
              e.type === 'dir'
                ? e
                : {
                    type: 'file',
                    path: e.path,
                    contentBase64: Buffer.alloc(e.size ?? 0).toString('base64'),
                  },
            ),
          })
        }
        for (const contentBase64 of ['Zg', 'Zh==', ' Zg==', 'Zg==\n', '-_=='])
          await compare('/repos/asset-repo/tickets/TICK-1/assets', 'POST', {
            kind: 'design',
            name: 'bad',
            layout: 'file',
            entries: [{ type: 'file', path: 'a', contentBase64 }],
          })
        for (const path of [
          '/repos/asset-repo/tickets/TICK-1/assets',
          '/repos/asset-repo/tickets/TICK-1/assets?kind=design',
          '/repos/asset-repo/tickets/TICK-1/assets/file?kind=design&name=tree',
          '/repos/asset-repo/tickets/TICK-1/assets/file?kind=design&name=tree&path=empty',
          '/repos/asset-repo/tickets/TICK-1/assets?kind=design&name=missing&rev=0x10',
          '/repos/asset-repo/tickets/TICK-1/assets?kind=design&name=tree&rev=1.5',
        ])
          await compare(path, 'GET')
        checks.push(
          'shared structure/base64/body/query/file refusal text and status matches actual TypeScript HTTP',
        )
        const limitServer = await start({ PROA_TEST_ASSET_MAX_BYTES: '500000' })
        const limitedOracle = createStoreServer({
          store: ts,
          clock,
          maxTicketAssetRequestBytes: 500000,
        })
        const compareLimited = async (
          server: typeof a.server,
          oracle: ReturnType<typeof createStoreServer>,
          path: string,
          method: string,
          body?: unknown,
        ) => {
          const init = {
            method,
            headers,
            ...(body === undefined
              ? {}
              : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
          }
          const [actual, expected] = await Promise.all([
            server.fetch(`${server.url}${path}`, init),
            oracle.fetch(new Request(`http://oracle${path}`, init)),
          ])
          assert.deepEqual(
            { status: actual.status, body: await actual.json() },
            { status: expected.status, body: await expected.json() },
            `${method} ${path}`,
          )
          comparisons++
        }
        await compareLimited(
          limitServer.server,
          limitedOracle,
          '/repos/asset-repo/ticket-asset-limits',
          'GET',
        )
        await compareLimited(
          limitServer.server,
          limitedOracle,
          '/repos/asset-repo/tickets/DEPLOY-1/assets',
          'POST',
          {
            kind: 'design',
            name: 'decoded-limit',
            layout: 'file',
            entries: [
              { type: 'file', path: 'a', contentBase64: Buffer.alloc(134233).toString('base64') },
            ],
          },
        )
        const oversized = JSON.stringify({
          kind: 'design',
          name: 'encoded-limit',
          layout: 'tree',
          entries: [],
          padding: 'x'.repeat(500000),
        })
        await compareLimited(
          limitServer.server,
          limitedOracle,
          '/repos/asset-repo/tickets/DEPLOY-1/assets',
          'POST',
          oversized,
        )
        const tiny = await start({ PROA_TEST_ASSET_MAX_BYTES: '10000' }),
          tinyOracle = createStoreServer({ store: ts, clock, maxTicketAssetRequestBytes: 10000 })
        const manyFiles = Array.from({ length: 100 }, (_, index) => ({
          type: 'file' as const,
          path: `file-${index}`,
          content: new Uint8Array(),
        }))
        const manyBody = {
          kind: 'design',
          name: 'preflight',
          layout: 'tree',
          entries: manyFiles.map((entry) => ({
            type: 'file',
            path: entry.path,
            contentBase64: '',
          })),
        }
        await compareLimited(
          tiny.server,
          tinyOracle,
          '/repos/asset-repo/tickets/DEPLOY-1/assets',
          'POST',
          manyBody,
        )
        assert.equal(await ts.getTicketAsset(repo, 'DEPLOY-1', 'design', 'preflight'), null)
        await a.store.putTicketAsset(repo, 'DEPLOY-1', {
          kind: 'design',
          name: 'existing-large',
          layout: 'tree',
          entries: manyFiles,
        })
        await compareLimited(
          tiny.server,
          tinyOracle,
          '/repos/asset-repo/tickets/DEPLOY-1/assets?kind=design&name=existing-large',
          'GET',
        )
        await a.store.putTicketAsset(repo, 'DEPLOY-1', {
          kind: 'design',
          name: 'large-file',
          layout: 'file',
          entries: [{ type: 'file', path: 'large.bin', content: new Uint8Array(10000) }],
        })
        await compareLimited(
          tiny.server,
          tinyOracle,
          '/repos/asset-repo/tickets/DEPLOY-1/assets/file?kind=design&name=large-file&path=large.bin',
          'GET',
        )
        checks.push(
          'deployment ceilings advertise effective limits and refuse decoded/request/preflight-manifest/read-response overflow before mutation',
        )

        const broken = await start({ AB_S3_BUCKET: `missing-asset-${crypto.randomUUID()}` })
        const beforeFailurePosition = await a.store.getRepoChangePosition(repo)
        await assert.rejects(
          broken.store.putTicketAsset(repo, 'PROVIDER-FAIL', file('provider-failure')),
        )
        assert.deepEqual(await ts.listTicketAssets(repo, 'PROVIDER-FAIL', { revisions: true }), [])
        assert.equal(await a.store.getRepoChangePosition(repo), beforeFailurePosition)
        assert.equal(
          (await a.store.putTicketAsset(repo, 'PROVIDER-FAIL', file('recovered'))).revision,
          0,
        )
        checks.push(
          'actual S3 provider refusal publishes no manifest, revision or change position; successful recovery starts revision zero',
        )

        const optionalTS = await openPostgresBuildStoreFromEnv(env, { clock })
        try {
          await sql.unsafe(
            'ALTER TABLE ab_ticket_schema_migrations RENAME TO protocol_saved_ticket_marker',
          )
          try {
            await optionalTS.createBuild({
              slug: 'optional-hosted-assets',
              repo,
              ticket: { source: 'hosted', id: 'opaque-without-extension' },
            })
            assert.deepEqual(
              await b.store.getBuild('optional-hosted-assets'),
              await optionalTS.getBuild('optional-hosted-assets'),
            )
            assert.deepEqual(
              await b.store.listBuildsForRepo(repo),
              await optionalTS.listBuildsForRepo(repo),
            )
          } finally {
            await sql.unsafe(
              'ALTER TABLE protocol_saved_ticket_marker RENAME TO ab_ticket_schema_migrations',
            )
          }
          assert.deepEqual(
            await b.store.getBuild('hosted-asset-pin'),
            await optionalTS.getBuild('hosted-asset-pin'),
          )
        } finally {
          await optionalTS.close()
        }
        checks.push(
          'hosted build record/list reads tolerate an absent optional extension and rediscover restored readable identities',
        )

        const projects = new PostgresProjectRegistry(sql),
          credentials = new PostgresCredentialStore(sql, projects)
        const project = (await projects.add('https://github.com/proa/assets-auth', 'proof')).repo
        const credential = await credentials.issue(project, 'assets-proof')
        const authenticated = await start({ PROA_TEST_AUTH: 'project' })
        const authOracle = createStoreServer({
          store: ts,
          clock,
          auth: createMachineAuth({
            secret: 'isolated-assets-proof',
            credentials,
            projects,
            store: ts,
            clock,
          }),
        })
        const authHeaders = { ...headers, authorization: `Bearer ${credential.token}` }
        for (const [path, method, body] of [
          [`/repos/${encodeURIComponent(project)}/ticket-asset-limits`, 'GET', undefined],
          [
            `/repos/${encodeURIComponent(project)}/tickets/T-1/assets`,
            'POST',
            JSON.stringify({
              kind: 'design',
              name: 'a',
              layout: 'file',
              entries: [{ type: 'file', path: 'a', contentBase64: 'invalid' }],
            }),
          ],
          ['/repos/asset-repo/tickets/TICK-1/assets', 'POST', '{'],
          ['/repos/asset-repo/tickets/TICK-1/assets/list', 'GET', undefined],
          ['/builds/asset-pinned/ticket-assets?kind=design&name=reference', 'GET', undefined],
        ] as const) {
          const init = { method, headers: authHeaders, ...(body === undefined ? {} : { body }) }
          const [actual, expected] = await Promise.all([
            authenticated.server.fetch(`${authenticated.server.url}${path}`, init),
            authOracle.fetch(new Request(`http://oracle${path}`, init)),
          ])
          assert.deepEqual(
            { status: actual.status, body: await actual.json() },
            { status: expected.status, body: await expected.json() },
            path,
          )
          comparisons++
        }
        checks.push(
          'project credential ownership precedes malformed asset bodies and foreign indirect build pin reads',
        )
        // A ticket connection selects its own URL and bearer even when the build
        // connection points to another server/project. No local attachment fallback.
        const ticketDatabase = await openPostgresTicketDatabase(env.AB_POSTGRES_URL!)
        try {
          const ticketSource = ticketDatabase.source({
            repo: project,
            teamKey: 'ASSET',
            lifecycle: { triage: 'triage', ready: 'ready', doing: 'doing', done: 'done' },
          })
          const hosted = await ticketSource.create({
            title: 'Selected ticket endpoint',
            body: 'Selected service asset proof',
          })
          const opaque = String(
            (
              await sql`SELECT id FROM ab_tickets WHERE repo=${project} AND readable_id=${hosted.ref.id}`
            )[0]!.id,
          )
          const buildProject = (await projects.add('https://github.com/proa/build-assets', 'proof'))
            .repo
          const buildCredential = await credentials.issue(buildProject, 'build-proof')
          const buildEndpoint = await start({ PROA_TEST_AUTH: 'project' })
          const attempts: { url: string; bearer: string | null }[] = []
          const selected = new HostedTicketSource({
            url: authenticated.server.url,
            token: credential.token,
            teamKey: 'ASSET',
            fetchFn: async (input, init) => {
              attempts.push({
                url: String(input),
                bearer: new Headers(init?.headers).get('authorization'),
              })
              return authenticated.server.fetch(input, init)
            },
          })
          const alias = hosted.ref.id.toLowerCase()
          const written = await selected.assets.putTicketAsset(
            project,
            alias,
            file('selected ticket bytes'),
          )
          assert.equal(written.ticketId, hosted.ref.id)
          assert.equal(written.revision, 0)
          assert.deepEqual(
            await selected.assets.getTicketAsset(project, opaque, 'design', 'reference'),
            await ts.getTicketAsset(project, alias, 'design', 'reference'),
          )
          const viaBuild = new RemoteBuildStore({
            url: buildEndpoint.server.url,
            token: buildCredential.token,
            fetchFn: buildEndpoint.server.fetch,
          })
          await assert.rejects(
            viaBuild.getTicketAsset(project, alias, 'design', 'reference'),
            /wrong project/,
          )
          assert.ok(attempts.length >= 2)
          assert.ok(
            attempts.every(
              (item) =>
                item.url.startsWith(authenticated.server.url) &&
                item.bearer === `Bearer ${credential.token}`,
            ),
          )
          assert.notEqual(authenticated.server.url, buildEndpoint.server.url)
          assert.notEqual(credential.token, buildCredential.token)
          assert.equal(await ts.getTicketAsset(buildProject, alias, 'design', 'reference'), null)
          const storage =
            await sql`SELECT ticket_id FROM ticket_assets WHERE repo=${project} AND kind='design' AND name='reference'`
          assert.equal(storage.length, 1)
          assert.equal(storage[0]!.ticket_id, opaque)
          await selected.assets.removeTicketAsset(project, alias, 'design', 'reference')
          assert.equal(await ts.getTicketAsset(project, opaque, 'design', 'reference'), null)
          assert.equal(
            await selected.assets.getTicketAsset(project, alias, 'design', 'reference'),
            null,
          )
          assert.deepEqual(
            await selected.assets.getTicketAsset(project, alias, 'design', 'reference', 0),
            await ts.getTicketAsset(project, opaque, 'design', 'reference', 0),
          )
          assert.deepEqual(
            await selected.assets.listTicketAssets(project, opaque, { revisions: true }),
            await ts.listTicketAssets(project, alias, { revisions: true }),
          )
          checks.push(
            'selected ticket URL and bearer remain independent of a different build endpoint; readable/lowercase/opaque aliases share immutable revisions and tombstones without fallback',
          )
        } finally {
          await ticketDatabase.close()
        }
        const stable = await ts.listTicketAssets(repo, ticket, { revisions: true })
        now = new Date('2030-01-01T01:00:00.000Z')
        await sql.unsafe(
          `CREATE FUNCTION protocol_asset_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='commit-fail' THEN RAISE EXCEPTION 'proof asset commit failure'; END IF; RETURN NEW; END $$`,
        )
        await sql.unsafe(
          `CREATE CONSTRAINT TRIGGER protocol_asset_commit AFTER INSERT ON ticket_assets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION protocol_asset_commit_failure()`,
        )
        await compare('/repos/asset-repo/tickets/TICK-1/assets', 'POST', {
          kind: 'design',
          name: 'commit-fail',
          layout: 'file',
          entries: [{ type: 'file', path: 'a', contentBase64: 'YQ==' }],
        })
        assert.deepEqual(await ts.listTicketAssets(repo, ticket, { revisions: true }), stable)
        const restarted = await start()
        assert.deepEqual(
          await restarted.store.listTicketAssets(repo, ticket, { revisions: true }),
          stable,
        )
        assert.deepEqual(
          await restarted.store.getPinnedTicketAsset('asset-snapshot', 'design', 'snapshot'),
          await ts.getPinnedTicketAsset('asset-snapshot', 'design', 'snapshot'),
        )
        checks.push(
          'deferred SQL failure leaves all revisions unchanged; fresh native server reads metadata and snapshot pins',
        )
      } catch (error) {
        failure = error
      } finally {
        for (const server of running.reverse())
          await server.close().catch((error) => {
            failure ??= error
          })
        await ts.close().catch((error) => {
          failure ??= error
        })
        await sql.close().catch((error) => {
          failure ??= error
        })
      }
      if (failure) throw failure
    }),
  )
  return { comparisons, checks }
}
