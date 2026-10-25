/** Maintained native read-transport parity against actual TypeScript handlers.
 * This checkpoint does not claim writes, grants, legacy config or connect parity.
 */
import { SQL } from 'bun'
import { strict as assert } from 'node:assert'
import { mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PostgresTicketSource } from '../../../packages/postgres-store/src/tickets'
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
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (env) => {
      const sql = new SQL(env.AB_POSTGRES_URL!, { max: 4 })
      const clock = () => new Date('2030-01-01T00:00:00.000Z')
      const projects = new PostgresProjectRegistry(sql)
      const credentials = new PostgresCredentialStore(sql, projects)
      const policies = new PostgresTicketPolicyStore(sql)
      const repo = 'https://github.com/proa/ticket-reads'
      const foreign = 'https://github.com/proa/ticket-foreign'
      const secret = 'isolated-ticket-read-test-signing-key'
      let native: Awaited<ReturnType<typeof startProtocolServer>> | undefined
      try {
        await projects.add(repo, 'ticket proof')
        await projects.add(foreign, 'ticket proof')
        await policies.put(repo, policy, 'ticket proof')
        const source = new PostgresTicketSource(sql, { repo, teamKey: 'ENG' }, lifecycle)
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
        const oracle = createTicketServer({
          secret,
          clock,
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
            return source
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
          return body
        }
        const request = (
          input: unknown,
          context: unknown = { teamKey: 'client-must-not-override-policy' },
        ) => JSON.stringify({ context, input })
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
        await projects.remove(repo, 'ticket proof')
        await compare('get', request({ id: first.ref.id }), {}, 403)
      } finally {
        await native?.close()
        await sql.close()
      }
    }),
  )
  return {
    assertions,
    checks: [
      'states/get/list/dependencies match real TypeScript handler over shared PostgreSQL',
      'nullable get, unfiltered listing, alias lookup, ordered duplicate dependencies and all independent capability combinations',
      'project/admin admission, cross-project/internal refusal and authorization before JSON parsing',
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
