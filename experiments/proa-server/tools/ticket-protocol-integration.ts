/** Maintained native read-transport parity against actual TypeScript handlers.
 * Includes released ticket version/capability replay and registration-bound grants/policy.
 */
import { SQL } from 'bun'
import { parseConfig } from '../../../packages/core/src/config/load'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { strict as assert } from 'node:assert'
import { mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PostgresTicketSource } from '../../../packages/postgres-store/src/tickets'
import { PostgresTicketGrantStore } from '../../../packages/postgres-store/src/ticket-grants'
import { PostgresTicketPolicyStore } from '../../../packages/postgres-store/src/ticket-policy'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { createTicketServer } from '../../../packages/hosted-store-service/src/ticket-server'
import {
  createMachineAuth,
  MachineAuthError,
} from '../../../packages/hosted-store-service/src/machine-auth'
import { mintToken } from '../../../packages/core/src/store/remote/token'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { buildProtocolExecutables, startProtocolServer } from './protocol-server-harness'
import { cachePath } from './verify'
import { replayTicketCompatibility } from './ticket-compatibility-replay'

const policy = {
  version: 1,
  tickets: {
    source: 'hosted',
    teamKey: 'ENG',
    triageState: 'triage',
    readyState: 'ready',
    claimedState: 'doing',
    doneState: 'done',
    createState: 'triage',
    proposalState: 'triage',
  },
} as const
const lifecycle = { triage: 'triage', ready: 'ready', doing: 'doing', done: 'done' }

export async function ticketProtocolReadIntegration(executable: string) {
  let assertions = 0
  let compatibilityReplay: { refused: number; projections: number } | undefined
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (env) => {
      const sql = new SQL(env.AB_POSTGRES_URL!, { max: 4 })
      const clock = () => new Date('2030-01-01T00:00:00.000Z')
      const projects = new PostgresProjectRegistry(sql)
      const credentials = new PostgresCredentialStore(sql, projects)
      const policies = new PostgresTicketPolicyStore(sql)
      const grants = new PostgresTicketGrantStore(sql)
      const repo = 'https://github.com/proa/ticket-reads'
      const foreign = 'https://github.com/proa/ticket-foreign'
      const secret = 'isolated-ticket-read-test-signing-key'
      let native: Awaited<ReturnType<typeof startProtocolServer>> | undefined
      try {
        await projects.add(repo, 'ticket proof')
        await projects.add(foreign, 'ticket proof')
        await policies.put(repo, policy, 'ticket proof')
        const source = new PostgresTicketSource(sql, { repo, teamKey: 'ENG', lifecycle }, lifecycle)
        const first = await source.create({
          title: 'First',
          body: '\nBody bytes  \n',
          labels: ['one'],
        })
        const second = await source.create({
          title: 'Second',
          body: 'Done ticket',
          labels: ['two'],
          blockedBy: [first.ref.id],
        })
        await source.transition(second.ref.id, 'done')
        await source.comment(first.ref.id, 'A comment\n')
        const { token } = await credentials.issue(repo, 'ticket proof')
        const adminToken = mintToken(secret, {
          version: 1,
          ownerAdmin: { user: 'owner' },
          exp: Date.parse('2040-01-01'),
        })
        const internalToken = mintToken(secret, {
          version: 1,
          internalOperator: { repo, user: 'operator' },
          exp: Date.parse('2040-01-01'),
        })
        let expectedSource = source
        const oracle = createTicketServer({
          secret,
          clock,
          policy: {
            get: async (selected) => {
              if (!(await projects.has(selected)))
                throw new MachineAuthError(403, 'project not registered')
              return policies.get(selected)
            },
            put: async (selected, value, writer) => {
              if (!(await projects.has(selected)))
                throw new MachineAuthError(403, 'project not registered')
              await policies.put(selected, value, writer)
            },
          },
          grants,
          auth: createMachineAuth({ secret, clock, credentials, projects }),
          sourceFor: async (context, principal) => {
            const selected = context.repo ?? ('repo' in principal ? principal.repo : undefined)
            if (!selected)
              throw new MachineAuthError(
                403,
                'owner ticket requests require context.repo naming a registered project',
              )
            if (!(await projects.has(selected)))
              throw new MachineAuthError(403, 'project not registered')
            return expectedSource
          },
        })
        native = await startProtocolServer({
          executable,
          env: { ...env, PROA_TEST_AUTH: 'project', PROA_TEST_SECRET: secret },
          clock,
        })
        const headers = {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-autobuild-version': AUTOBUILD_VERSION,
          'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
        }
        const createdIds = new Set<string>()
        const compare = async (
          operation: string,
          raw: string,
          extra: Record<string, string> = {},
          expectedStatus = 200,
        ) => {
          const init = { method: 'POST', headers: { ...headers, ...extra }, body: raw }
          const actual = await native!.fetch(`${native!.url}/tickets/${operation}`, init)
          const expected = await oracle.fetch(
            new Request(`http://oracle/tickets/${operation}`, init),
          )
          assert.equal(actual.status, expectedStatus, `${operation} native status`)
          assert.equal(expected.status, expectedStatus, `${operation} oracle status`)
          const body = await actual.json()
          assert.deepEqual(body, await expected.json(), `${operation} parity`)
          assertions++
          // Source clocks are not injectable in the TS adapter. Give newly
          // created rows equivalent ordered fixture timestamps before list
          // comparisons, rather than sorting away the protocol's row ordering.
          if (operation === 'create' && actual.status === 201 && !createdIds.has(body.ref.id)) {
            createdIds.add(body.ref.id)
            const createdAt = new Date(
              Date.parse('2030-01-01T00:00:00.000Z') + assertions,
            ).toISOString()
            await sql`UPDATE ab_tickets SET created_at=${createdAt} WHERE readable_id=${body.ref.id} AND repo IN (${repo},${foreign})`
          }
          return body
        }
        const request = (
          input: unknown,
          context: unknown = { teamKey: 'client-must-not-override-policy' },
        ) => JSON.stringify({ context, input })
        const compatibilityRepo = 'https://github.com/proa/ticket-compatibility'
        await projects.add(compatibilityRepo, 'ticket proof')
        await policies.put(compatibilityRepo, policy, 'ticket proof')
        const compatibilitySource = new PostgresTicketSource(
          sql,
          { repo: compatibilityRepo, teamKey: 'ENG', lifecycle },
          lifecycle,
        )
        await compatibilitySource.create(
          { title: 'Ticket', body: 'Body\n', labels: [] },
          { state: 'ready' },
        )
        const compatibilityCredential = await credentials.issue(compatibilityRepo, 'ticket proof')
        const beforeCompatibility = await compatibilitySource.listReady({})
        expectedSource = compatibilitySource
        const compatibility = await replayTicketCompatibility(
          compatibilityCredential.token,
          (row, init) => native!.fetch(`${native!.url}/tickets/${row.operation}`, init),
          (row, init) => oracle.fetch(new Request(`http://oracle/tickets/${row.operation}`, init)),
        )
        assert.deepEqual(
          await compatibilitySource.listReady({}),
          beforeCompatibility,
          'version refusals never mutate seeded tickets',
        )
        expectedSource = source
        compatibilityReplay = compatibility
        assertions += compatibility.refused + compatibility.projections
        for (const selector of [
          'ssh://git@GITHUB.COM/proa/ticket-reads',
          'git://GITHUB.COM/proa/ticket-reads',
        ]) {
          await compare('get', request({ id: first.ref.id }, { teamKey: 'ENG', repo: selector }))
          await compare('states', request({}, { teamKey: 'ENG', repo: selector }))
        }
        const removedPolicyRepo = 'https://github.com/proa/ticket-policy-removed'
        await projects.add(removedPolicyRepo, 'ticket proof')
        await projects.remove(removedPolicyRepo, 'ticket proof')
        for (const selector of [
          'https://github.com/proa/ticket-policy-never-registered',
          removedPolicyRepo,
        ]) {
          for (const input of [null, policy])
            await compare(
              'policy',
              request(input, { teamKey: 'ENG', repo: selector }),
              { authorization: `Bearer ${adminToken}` },
              403,
            )
        }
        await compare('states', request({}))
        const listing = await compare('list-ready', request({}))
        assert.equal(listing.tickets.length, 2, 'absent state is unfiltered')
        assert.equal((await compare('list-ready', request({ state: 'DONE' }))).tickets.length, 1)
        assert.equal((await compare('list-ready', request({ labels: ['one'] }))).tickets.length, 1)
        await compare('get', request({ id: first.ref.id.toLowerCase() }))
        await compare('get', request({ id: 'ENG-999' }))
        await compare(
          'dependency-states',
          request({ ids: [second.ref.id, 'ENG-999', first.ref.id, second.ref.id] }),
        )
        for (let mask = 0; mask < 8; mask++) {
          await compare('get', request({ id: first.ref.id }), {
            'x-autobuild-ticket-tree': mask & 1 ? '1' : 'unknown',
            'x-autobuild-ticket-revisions': mask & 2 ? '1' : 'unknown',
            'x-autobuild-ticket-comments': mask & 4 ? '1' : 'unknown',
          })
        }
        await compare('get', request({ id: first.ref.id }, { teamKey: 'ENG', repo }), {
          authorization: `Bearer ${adminToken}`,
        })
        await compare(
          'get',
          request({ id: first.ref.id }),
          { authorization: `Bearer ${adminToken}` },
          403,
        )
        await compare(
          'get',
          request({ id: first.ref.id }, { teamKey: 'ENG', repo: foreign }),
          {},
          403,
        )
        await compare('get', '{', { authorization: '' }, 401)
        await compare('get', '{', { authorization: `Bearer ${internalToken}` }, 403)
        await compare('get', '{', {}, 400)
        await compare('get', request({ id: '' }), {}, 400)
        await compare(
          'get',
          JSON.stringify({ context: { teamKey: 'ENG' }, input: { id: first.ref.id, extra: true } }),
          {},
          400,
        )
        await compare('list-ready', request({ state: 'absent' }), {}, 400)
        // Writes run against equivalent independent projects, preventing one
        // service's mutation from manufacturing the other's expected result.
        const mirror = new PostgresTicketSource(
          sql,
          { repo: foreign, teamKey: 'ENG', lifecycle },
          lifecycle,
        )
        await mirror.create({ title: 'First', body: '\nBody bytes  \n', labels: ['one'] })
        await mirror.create({
          title: 'Second',
          body: 'Done ticket',
          labels: ['two'],
          blockedBy: [first.ref.id],
        })
        await mirror.transition(second.ref.id, 'done')
        await mirror.comment(first.ref.id, 'A comment\n')
        expectedSource = mirror
        const revisionHeaders = { 'x-autobuild-ticket-revisions': '1' }
        await compare('add-state', request({ name: 'review', about: ' Review work ' }))
        await compare('states', request({}))
        await compare('add-state', request({ name: 'review' }), {}, 400)
        await compare('claim', request({ id: 'ENG-999' }))
        await compare('claim', request({ id: second.ref.id }))
        await compare('claim', request({ id: first.ref.id }))
        await compare('claim', request({ id: first.ref.id }))
        await compare('get', request({ id: first.ref.id }), revisionHeaders)
        await compare('comment', request({ id: first.ref.id, body: 'Machine comment\n' }))
        await compare('get', request({ id: first.ref.id }), revisionHeaders)
        const comments = (await source.get(first.ref.id))!.comments!
        assert.equal(comments.at(-1)!.body, 'Machine comment\n')
        assert.equal((await source.get(first.ref.id))!.body, '\nBody bytes  \n')
        assert.ok(Number.isFinite(Date.parse(comments.at(-1)!.createdAt)))
        await compare('comment', request({ id: 'ENG-999', body: '' }), {}, 404)
        await compare(
          'update',
          request({ id: first.ref.id, patch: { title: 'Updated', labels: ['one', 'extra'] } }),
        )
        await compare('get', request({ id: first.ref.id }), revisionHeaders)
        await compare('update', request({ id: first.ref.id, patch: { body: '  ' } }), {}, 500)
        await compare('transition', request({ id: first.ref.id, state: 'review' }))
        await compare('add-blocker', request({ id: first.ref.id, blockerId: second.ref.id }))
        await compare(
          'add-blocker',
          request({ id: first.ref.id, blockerId: first.ref.id }),
          {},
          500,
        )
        await compare('remove-blocker', request({ id: first.ref.id, blockerId: 'ENG-999' }))
        const revision = (await source.get(first.ref.id))!.revision
        await compare(
          'mutate-if-revision',
          request({
            id: first.ref.id,
            expectedRevision: revision,
            mutation: { kind: 'update', patch: { body: 'Guarded body' } },
          }),
        )
        await compare(
          'mutate-if-revision',
          request({
            id: first.ref.id,
            expectedRevision: revision,
            mutation: { kind: 'transition', state: 'done' },
          }),
          {},
          409,
        )
        const currentRevision = (await source.get(first.ref.id))!.revision
        await compare(
          'mutate-if-revision',
          request({
            id: first.ref.id,
            expectedRevision: currentRevision,
            mutation: { kind: 'blockers', operation: 'unblock', ids: [second.ref.id, 'ENG-999'] },
          }),
          {},
          404,
        )
        await compare('get', request({ id: first.ref.id }), revisionHeaders)
        assert.equal(
          (await source.get(first.ref.id))!.revision,
          currentRevision,
          'failed guarded blocker batch is atomic',
        )
        await compare(
          'mutate-if-revision',
          request({
            id: first.ref.id,
            expectedRevision: currentRevision,
            mutation: {
              kind: 'blockers',
              operation: 'unblock',
              ids: [second.ref.id, second.ref.id],
            },
          }),
        )
        await compare(
          'create',
          request({
            draft: { title: 'Requested', body: '' },
            options: { requestedId: 'ENG-20', idempotencyKey: 'stable-create' },
          }),
          revisionHeaders,
          201,
        )
        await compare(
          'create',
          request({
            draft: { title: 'Adopt existing', body: 'ignored' },
            options: { requestedId: 'ENG-22', idempotencyKey: 'stable-create' },
          }),
          revisionHeaders,
          201,
        )
        await compare(
          'create',
          request({ draft: { title: 'Occupied', body: '' }, options: { requestedId: 'ENG-20' } }),
          {},
          500,
        )
        await compare(
          'create',
          request({
            draft: { title: 'Foreign id allocates', body: 'text' },
            options: { requestedId: 'OTHER-9' },
          }),
          revisionHeaders,
          201,
        )
        await compare(
          'create',
          request({
            draft: { title: 'Missing blocker', body: 'text', blockedBy: ['ENG-999'] },
            options: { requestedId: 'ENG-9999' },
          }),
          {},
          404,
        )
        await compare(
          'create',
          request({ draft: { title: 'After rollback', body: 'text' } }),
          revisionHeaders,
          201,
        )
        await compare(
          'create',
          request({ draft: { title: 'Node', body: 'node', kind: 'node' } }),
          { ...revisionHeaders, 'x-autobuild-ticket-tree': '1' },
          201,
        )
        await compare(
          'create',
          request({ draft: { title: 'Child', body: 'child', target: 'eng-23' } }),
          { ...revisionHeaders, 'x-autobuild-ticket-tree': '1' },
          201,
        )
        await compare('update', request({ id: 'ENG-23', patch: { kind: 'work' } }), {}, 400)
        await compare('list-ready', request({}), {
          ...revisionHeaders,
          'x-autobuild-ticket-tree': '1',
        })
        const nativeOnly = async (operation: string, input: unknown) => {
          const response = await native!.fetch(`${native!.url}/tickets/${operation}`, {
            method: 'POST',
            headers: { ...headers, ...revisionHeaders },
            body: request(input),
          })
          return { status: response.status, body: await response.json() }
        }
        const racingCreates = await Promise.all(
          [0, 1].map(() =>
            nativeOnly('create', {
              draft: { title: 'Concurrent create', body: 'one ticket' },
              options: { idempotencyKey: 'concurrent-create' },
            }),
          ),
        )
        assert.deepEqual(
          racingCreates[0],
          racingCreates[1],
          'duplicate native creates adopt one ticket',
        )
        const racingId = racingCreates[0]!.body.ref.id
        const claims = await Promise.all([0, 1].map(() => nativeOnly('claim', { id: racingId })))
        assert.deepEqual(
          claims.map((r) => r.body.claimed).sort(),
          [false, true],
          'one competing claim wins',
        )
        const before = (await source.get(racingId))!
        const guarded = await Promise.all(
          ['left', 'right'].map((body) =>
            nativeOnly('mutate-if-revision', {
              id: racingId,
              expectedRevision: before.revision,
              mutation: { kind: 'update', patch: { body } },
            }),
          ),
        )
        assert.deepEqual(
          guarded.map((r) => r.status).sort(),
          [200, 409],
          'one competing guarded write wins',
        )
        const after = (await source.get(racingId))!
        assert.equal(BigInt(after.revision), BigInt(before.revision) + 1n)
        assert.ok(['left', 'right'].includes(after.body))
        assertions += 3
        const legacyRepo = 'https://github.com/proa/legacy-ticket-config'
        await projects.add(legacyRepo, 'ticket proof')
        const legacyCredential = await credentials.issue(legacyRepo, 'ticket proof')
        const legacyStore = await openPostgresBuildStoreFromEnv(env, { clock })
        try {
          const config = parseConfig(
            '[tickets]\nsource="hosted"\nteamKey="OLD"\nreadyState="Old ready"\n[verify]\nsteps=[]\n[finalize]\nsteps=[]',
          )
          const { verify, finalize, ...root } = config
          await legacyStore.ensureRepo(legacyRepo)
          const artifact = await legacyStore.putRepoArtifact(legacyRepo, {
            kind: 'dispatcher-effective-config',
            content: JSON.stringify({
              ...root,
              verify: { steps: verify.steps },
              finalize: { steps: finalize.steps },
            }),
          })
          await legacyStore.appendRepo(legacyRepo, {
            actor: { kind: 'dispatcher' },
            type: 'dispatcher.run-started',
            payload: {
              run: 'legacy-config-proof',
              pid: 1,
              roleWarnings: [],
              effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
            },
          })
          const legacyReply = await native!.fetch(`${native!.url}/tickets/states`, {
            method: 'POST',
            headers: { ...headers, authorization: `Bearer ${legacyCredential.token}` },
            body: request({}),
          })
          assert.equal(legacyReply.status, 200)
          const legacyNames = (await legacyReply.json()).map((v: { name: string }) => v.name)
          assert.ok(legacyNames.includes('Old ready'))
          assert.ok(legacyNames.includes('Backlog'))
          const publish = await native!.fetch(`${native!.url}/tickets/policy`, {
            method: 'POST',
            headers: { ...headers, authorization: `Bearer ${legacyCredential.token}` },
            body: request(policy),
          })
          assert.equal(publish.status, 200)
          const seeded = await sql`SELECT name FROM ab_ticket_states WHERE repo=${legacyRepo}`
          assert.ok(
            seeded.some((r: { name: string }) => r.name === 'Old ready'),
            'legacy names retained on publication',
          )
          assertions += 2
        } finally {
          await legacyStore.close()
        }
        await compare('policy', request(null, { teamKey: 'ENG', repo }))
        await compare(
          'policy',
          request({ ...policy, forbidden: true }, { teamKey: 'ENG', repo }),
          {},
          400,
        )
        await compare('policy', request(policy, { teamKey: 'ENG', repo }))
        await compare(
          'policy',
          request(null, { teamKey: 'ENG', repo }),
          { authorization: `Bearer ${internalToken}` },
          403,
        )
        const ticketRequest = async (operation: string, body: unknown, bearer = token) => {
          const response = await native!.fetch(`${native!.url}/tickets/${operation}`, {
            method: 'POST',
            headers: { ...headers, authorization: `Bearer ${bearer}` },
            body: JSON.stringify(body),
          })
          return { status: response.status, body: await response.json() }
        }
        const runner = await ticketRequest('grants', {
          action: 'issue',
          repo,
          execution: 'proof',
          kind: 'runner',
        })
        assert.equal(runner.status, 201)
        assert.deepEqual(await grants.authenticate(runner.body.token, clock()), runner.body.grant)
        const nativeGrantRead = await ticketRequest(
          'get',
          { context: { teamKey: 'ENG' }, input: { id: 'ENG-999' } },
          runner.body.token,
        )
        assert.equal(nativeGrantRead.status, 200)
        const phase = await ticketRequest(
          'grants',
          { action: 'issue', repo, execution: 'proof', kind: 'phase' },
          runner.body.token,
        )
        assert.equal(phase.status, 201)
        assert.deepEqual(await grants.authenticate(phase.body.token, clock()), phase.body.grant)
        assert.equal(
          (
            await ticketRequest(
              'create',
              { context: { teamKey: 'ENG' }, input: { draft: { title: 'Denied', body: '' } } },
              phase.body.token,
            )
          ).status,
          403,
        )
        assert.equal(
          (
            await ticketRequest(
              'create',
              {
                context: { teamKey: 'ENG' },
                input: {
                  draft: { title: 'Denied', body: '' },
                  options: { requestedId: 'ENG-500' },
                },
              },
              runner.body.token,
            )
          ).status,
          403,
        )
        assert.equal(
          (
            await ticketRequest(
              'grants',
              { action: 'issue', repo, execution: 'other', kind: 'phase' },
              runner.body.token,
            )
          ).status,
          403,
        )
        assert.equal(
          (
            await ticketRequest('grants', {
              action: 'issue',
              repo,
              execution: 'proof',
              kind: 'phase',
            })
          ).status,
          403,
        )
        const tsRunner = await grants.issue(repo, 'typescript', 'runner', null, clock())
        assert.equal(
          (
            await ticketRequest(
              'get',
              { context: { teamKey: 'ENG' }, input: { id: 'ENG-999' } },
              tsRunner.token,
            )
          ).status,
          200,
        )
        assert.equal(
          (await ticketRequest('grants', { action: 'renew', repo }, runner.body.token)).status,
          200,
        )
        assert.equal(
          (await ticketRequest('grants', { action: 'revoke', repo }, runner.body.token)).status,
          200,
        )
        assert.equal(
          (
            await ticketRequest(
              'get',
              { context: { teamKey: 'ENG' }, input: { id: 'ENG-999' } },
              phase.body.token,
            )
          ).status,
          401,
        )
        assertions += 13
        await projects.remove(repo, 'ticket proof')
        await compare('get', request({ id: first.ref.id }), {}, 403)
        await projects.add(repo, 'ticket proof')
        await compare('policy', request(null, { teamKey: 'ENG', repo }), {
          authorization: `Bearer ${adminToken}`,
        })
        assert.equal(await grants.authenticate(tsRunner.token, clock()), null)
        assert.equal(
          (
            await ticketRequest(
              'get',
              { context: { teamKey: 'ENG' }, input: { id: 'ENG-999' } },
              tsRunner.token,
            )
          ).status,
          401,
        )
        assertions += 2
      } finally {
        await native?.close()
        await sql.close()
      }
    }),
  )
  return {
    assertions,
    compatibilityReplay,
    checks: [
      'all recorded refused-version/capability cases and admitted read projections replay against native HTTP; frozen decoders retained',
      'states/get/list/dependencies match real TypeScript handler over shared PostgreSQL',
      'nullable get, unfiltered listing, alias lookup, ordered duplicate dependencies and all independent capability combinations',
      'project/admin admission, cross-project/internal refusal and authorization before JSON parsing',
      'all 13 CRUD operations including prepared state/comment/claim, guarded conflict and blocker rollback, requested ids, creation adoption, counter rollback and node constraints',
      'concurrent native duplicate creates, claims and guarded writes prove one durable winner via TypeScript reads',
      'registration-bound policy publication, legacy effective-config fallback, mixed-language runner/phase grants and parent revocation',
    ],
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '../../..')
  const common = Bun.spawnSync(['git', 'rev-parse', '--git-common-dir'], { cwd: root })
  if (common.exitCode) throw Error('Cannot resolve ticket integration cache')
  const target =
    process.env.CARGO_TARGET_DIR ||
    cachePath(await realpath(resolve(root, common.stdout.toString().trim())))
  const environment = { ...process.env, CARGO_TARGET_DIR: target }
  if (!process.argv.includes('--caller-holds-lock')) {
    await mkdir(target, { recursive: true })
    const child = Bun.spawn(
      ['flock', join(target, '.verify.lock'), 'bun', import.meta.filename, '--caller-holds-lock'],
      { env: environment, stdout: 'inherit', stderr: 'inherit' },
    )
    if (await child.exited) throw Error('Ticket protocol read integration failed')
  } else {
    const { server } = await buildProtocolExecutables(environment)
    console.log(JSON.stringify(await ticketProtocolReadIntegration(server)))
  }
}
