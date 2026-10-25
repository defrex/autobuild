/** Native ticket writes read back through the unchanged TypeScript adapter. */
import { SQL } from 'bun'
import type { OperatorOperationWitness } from './operator-coverage-types'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { PostgresTicketSource } from '../../../packages/postgres-store/src/tickets'
import { PostgresTicketPolicyStore } from '../../../packages/postgres-store/src/ticket-policy'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import manifest from '../../../package.json'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { migratePostgres } from '../../../packages/postgres-store/src/schema'
import {
  createTicket,
  updateTicket,
  moveTicket,
  changeBlockers,
  TicketOperationError,
} from '../../../packages/core/src/ports/tickets/operations'
import { TicketRevisionConflict } from '../../../packages/core/src/ports/tickets/revision'
import type { TicketUpdate } from '../../../packages/core/src/ports/types'
import { updateTicketTarget } from '../../../packages/core/src/kernel/node-parent'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { validateEventWrite } from '../../../packages/core/src/events/catalog'
import { bridge } from './data-integration'
import { withDataServices } from './data-services'
import { createOperatorServer } from '../../../packages/hosted-store-service/src/operator-server'
import { OperatorQueryError } from '../../../packages/core/src/operator/query'

/** Declared probes are checked at the HTTP boundary and on successful replay completion. */
export function ticketHttpScenarios() {
  return [
    ['create', 'POST', ''],
    ['patch', 'PATCH', '/ENG-1'],
    ['stale', 'PATCH', '/ENG-1'],
    ['unknown-field', 'POST', ''],
    ['refusal-state', 'GET', '?state=unknown'],
    ['refusal-blank', 'PATCH', '/ENG-1'],
    ['refusal-block', 'POST', '/ENG-1/block'],
    ['refusal-unblock', 'POST', '/ENG-1/unblock'],
    ['states', 'GET', '/states'],
    ['list', 'GET', ''],
    ['detail', 'GET', '/ENG-1'],
    ['state-create', 'POST', '/states'],
    ['states-readback', 'GET', '/states'],
    ['move', 'POST', '/ENG-1/move'],
    ['move-readback', 'GET', '/ENG-1'],
    ['blocker-create', 'POST', ''],
    ['block', 'POST', '/ENG-1/block'],
    ['block-readback', 'GET', '/ENG-1'],
    ['unblock', 'POST', '/ENG-1/unblock'],
    ['unblock-readback', 'GET', '/ENG-1'],
    ['revoked', 'GET', '/ENG-1'],
  ].map(([name, method, path]) => ({
    id: `ticket-http-${name}`,
    method: method!,
    path: `tickets${path}`,
  }))
}

const project = resolve(import.meta.dir, '..')
const config = {
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
const now = '2026-09-02T00:00:00.000Z'

async function build(env: Record<string, string | undefined>) {
  const child = Bun.spawn(
    ['cargo', 'build', '--locked', '--example', 'ticket-proof', '--message-format=json'],
    { cwd: project, env, stdout: 'pipe', stderr: 'inherit' },
  )
  const output = await new Response(child.stdout).text()
  if (await child.exited) throw new Error('Native ticket proof build failed')
  let executable: string | undefined
  for (const line of output.split('\n').filter(Boolean)) {
    const item = JSON.parse(line) as {
      reason: string
      target?: { name: string }
      executable?: string
      message?: { rendered?: string }
    }
    if (item.message?.rendered) process.stderr.write(item.message.rendered)
    if (
      item.reason === 'compiler-artifact' &&
      item.target?.name === 'ticket-proof' &&
      item.executable
    )
      executable = item.executable
  }
  if (!executable) throw new Error('Cargo did not report ticket proof executable')
  return executable
}
function normalizeFailure(error: unknown) {
  if (error instanceof TicketRevisionConflict)
    return { status: 409, body: { kind: 'conflict', error: error.message } }
  if (error instanceof TicketOperationError)
    return {
      status: error.code === 'not-found' ? 404 : 409,
      body: { kind: error.code, error: error.message, code: error.code },
    }
  return {
    status: 409,
    body: {
      kind: 'refusal',
      error: error instanceof Error ? error.message : String(error),
      code: 'refusal',
    },
  }
}

export async function ticketIntegration(adminUrl: string, env: Record<string, string | undefined>) {
  const executable = await build(env)
  const suffix = crypto.randomUUID().replaceAll('-', '')
  const database = `proa_tickets_${suffix}`,
    role = `proa_ticket_writer_${suffix}`
  const password = crypto.randomUUID(),
    admin = new SQL(adminUrl, { max: 1 })
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  const runtime = await mkdtemp(resolve(tmpdir(), 'proa-ticket-proof-'))
  let targetStore: Awaited<ReturnType<typeof openPostgresBuildStoreFromEnv>> | undefined
  let sql: SQL | undefined,
    rust: Awaited<ReturnType<typeof bridge>> | undefined,
    competitor: Awaited<ReturnType<typeof bridge>> | undefined
  let http: ReturnType<typeof Bun.spawn> | undefined
  let created = false,
    roleCreated = false
  const claims: string[] = []
  const witnesses: OperatorOperationWitness[] = []
  let failure: unknown
  let evidence:
    | {
        checkpoint: string
        claims: string[]
        httpParity: boolean
        claimedNodeRetargeting: boolean
        witnesses: OperatorOperationWitness[]
      }
    | undefined
  try {
    await admin.unsafe(`CREATE DATABASE ${database}`)
    created = true
    await migratePostgres(url.href)
    sql = new SQL(url.href, { max: 1 })
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
    roleCreated = true
    await sql.unsafe(`GRANT CONNECT ON DATABASE ${database} TO ${role}`)
    await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`)
    await sql.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`)
    await sql.unsafe(
      `GRANT INSERT, UPDATE ON ab_tickets, ab_ticket_counters, ab_ticket_states TO ${role}`,
    )
    await sql.unsafe(`GRANT INSERT, DELETE ON ab_ticket_blockers TO ${role}`)
    await sql.unsafe(
      `GRANT UPDATE ON project_credentials, builds, repo_change_positions TO ${role}`,
    )
    await sql.unsafe(`GRANT INSERT ON events, repo_change_positions TO ${role}`)
    const writerUrl = new URL(url)
    writerUrl.username = role
    writerUrl.password = password
    const writerEnv = { ...env, AB_POSTGRES_URL: writerUrl.href }
    rust = await bridge(writerEnv, runtime, [executable])
    competitor = await bridge(writerEnv, runtime, [executable])
    const native = (op: string, fields: Record<string, unknown> = {}) =>
      rust!.request({ op, repo: 'native', config, now, ...fields })
    const source = new PostgresTicketSource(
      sql,
      { repo: 'oracle', teamKey: 'ENG', lifecycle },
      lifecycle,
    )
    const readback = new PostgresTicketSource(
      sql,
      { repo: 'native', teamKey: 'ENG', lifecycle },
      lifecycle,
    )
    const compare = async (
      op: string,
      fields: Record<string, unknown>,
      oracle: () => Promise<unknown>,
    ) => {
      const actual = await native(op, fields)
      let expected: unknown
      try {
        expected = { value: await oracle() }
      } catch (error) {
        expected = normalizeFailure(error)
      }
      assert.deepEqual(actual, expected, `ticket differential ${op} ${JSON.stringify(fields)}`)
      return actual
    }
    const parent = { kind: 'node' as const, title: 'Parent', body: 'Node body\n  preserved\n' }
    const child = {
      title: 'Child',
      body: 'Work body\n  preserved\n',
      target: 'ENG-1',
      labels: ['a', 'b'],
    }
    await compare('create', { draft: parent }, () => createTicket(source, parent))
    await compare('create', { draft: child }, () => createTicket(source, child))
    assert.deepEqual(await readback.get('ENG-2'), await source.get('ENG-2'))
    claims.push(
      'Native creates preserve body bytes, kind, canonical target, labels and initial revisions through the TypeScript adapter',
    )
    await compare(
      'update',
      { id: 'ENG-2', patch: { body: '\n updated  \n' }, expectedRevision: '1' },
      () => updateTicket(source, 'ENG-2', { body: '\n updated  \n' }, true, '1'),
    )
    await compare(
      'update',
      { id: 'ENG-2', patch: { labels: ['b', 'a', 'a'] }, expectedRevision: '2' },
      () => updateTicket(source, 'ENG-2', { labels: ['b', 'a', 'a'] }, true, '2'),
    )
    await compare('update', { id: 'ENG-2', patch: { title: 'stale' }, expectedRevision: '1' }, () =>
      updateTicket(source, 'ENG-2', { title: 'stale' }, true, '1'),
    )
    await compare('update', { id: 'ENG-2', patch: { title: '  ' } }, () =>
      updateTicket(source, 'ENG-2', { title: '  ' }, true),
    )
    await compare('update', { id: 'ENG-2', patch: { future: true } }, () =>
      updateTicket(source, 'ENG-2', { future: true } as TicketUpdate, true),
    )
    await compare('move', { id: 'eng-2', state: 'READY', expectedRevision: '2' }, () =>
      moveTicket(source, 'eng-2', 'READY', '2'),
    )
    await compare('move', { id: 'ENG-2', state: 'unknown' }, () =>
      moveTicket(source, 'ENG-2', 'unknown'),
    )
    await compare('update', { id: 'ENG-2', patch: { title: ' ', body: ' ' } }, () =>
      updateTicket(source, 'ENG-2', { title: ' ', body: ' ' }, true),
    )
    claims.push(
      'Revision guarded update/move and stale/invalid refusal bytes match TypeScript; label set reorder does not bump revision',
    )
    await compare('block', { id: 'ENG-2', ids: ['ENG-1'], expectedRevision: '3' }, () =>
      changeBlockers(source, 'ENG-2', ['ENG-1'], 'block', '3'),
    )
    await compare('block', { id: 'ENG-2', ids: ['ENG-1', 'missing'], expectedRevision: '4' }, () =>
      changeBlockers(source, 'ENG-2', ['ENG-1', 'missing'], 'block', '4'),
    )
    await compare('block', { id: 'ENG-2', ids: ['ENG-2'], expectedRevision: '4' }, () =>
      changeBlockers(source, 'ENG-2', ['ENG-2'], 'block', '4'),
    )
    await compare('unblock', { id: 'ENG-2', ids: ['ENG-1'], expectedRevision: '4' }, () =>
      changeBlockers(source, 'ENG-2', ['ENG-1'], 'unblock', '4'),
    )
    assert.deepEqual(await readback.get('ENG-2'), await source.get('ENG-2'))
    await compare('block', { id: 'ENG-2', ids: ['missing'], expectedRevision: '1' }, () =>
      changeBlockers(source, 'ENG-2', ['missing'], 'block', '1'),
    )
    await compare('unblock', { id: 'ENG-2', ids: ['missing'], expectedRevision: '1' }, () =>
      changeBlockers(source, 'ENG-2', ['missing'], 'unblock', '1'),
    )
    claims.push(
      'Guarded blocker batches validate every id before mutation and preserve revision on refused or duplicate writes',
    )
    await compare('update', { id: 'ENG-1', patch: { kind: 'work' } }, () =>
      updateTicket(source, 'ENG-1', { kind: 'work' }, true),
    )
    await compare('update', { id: 'ENG-1', patch: { target: 'ENG-1' } }, () =>
      updateTicket(source, 'ENG-1', { target: 'ENG-1' }, true),
    )
    await compare('update', { id: 'ENG-1', patch: { target: 'ENG-2' } }, () =>
      updateTicket(source, 'ENG-1', { target: 'ENG-2' }, true),
    )
    await compare('create', { draft: { title: 'bad', body: 'bad', blockedBy: ['missing'] } }, () =>
      createTicket(source, { title: 'bad', body: 'bad', blockedBy: ['missing'] }),
    )
    claims.push(
      'Graph lock enforces node-only targets, demotion and cycle refusal without partial changes',
    )
    await compare('states', {}, () => source.listStates())
    await compare('state', { name: 'icebox', about: '  Later work  ' }, () =>
      source.addState('icebox', { about: '  Later work  ' }),
    )
    await compare('state', { name: 'icebox' }, () => source.addState('icebox'))
    await compare('state', { name: 'Invalid State' }, () => source.addState('Invalid State'))
    await compare('state', { name: 'bad-purpose', about: 'two\nlines' }, () =>
      source.addState('bad-purpose', { about: 'two\nlines' }),
    )
    claims.push(
      'State discovery, ordering, uniqueness, creation and purpose validation match the unchanged hosted adapter',
    )
    const third = { title: 'Third blocker', body: 'Blocker body' }
    await compare('create', { draft: third }, () => createTicket(source, third))
    await compare('block', { id: 'ENG-2', ids: ['ENG-1', 'ENG-3'] }, () =>
      changeBlockers(source, 'ENG-2', ['ENG-1', 'ENG-3'], 'block'),
    )
    assert.equal((await readback.get('ENG-2'))?.revision, '7')
    await compare('unblock', { id: 'ENG-2', ids: ['ENG-1', 'ENG-3'], expectedRevision: '7' }, () =>
      changeBlockers(source, 'ENG-2', ['ENG-1', 'ENG-3'], 'unblock', '7'),
    )
    claims.push(
      'Unguarded blocker batches retain per-id commit and revision boundaries while guarded batches increment once',
    )
    // Two native connections contend on the TypeScript-compatible ticket row lock.
    const raceA = native('update', {
      id: 'ENG-2',
      expectedRevision: '8',
      patch: { title: 'race-a' },
    })
    const raceB = competitor.request({
      op: 'update',
      repo: 'native',
      config,
      now,
      id: 'ENG-2',
      expectedRevision: '8',
      patch: { title: 'race-b' },
    })
    const race = await Promise.all([raceA, raceB])
    assert.equal(race.filter((r) => r.value).length, 1)
    assert.equal(race.filter((r) => r.status === 409 && r.body?.kind === 'conflict').length, 1)
    const raced = await readback.get('ENG-2')
    assert.equal(raced?.revision, '9')
    assert.ok(['race-a', 'race-b'].includes(raced!.title))
    claims.push(
      'Independent native writers serialize revision checks under the parent row lock and exactly one same-revision writer wins',
    )
    await rust.close()
    rust = await bridge(writerEnv, runtime, [executable])
    const recovered = await native('get', { id: 'ENG-2' })
    assert.deepEqual(recovered.value, raced)
    const registry = new PostgresProjectRegistry(sql)
    await registry.add('https://github.com/acme/policy', 'test-owner')
    const published = {
      version: 1 as const,
      tickets: { ...config.tickets, readyState: 'Ready published' },
    }
    await new PostgresTicketPolicyStore(sql).put(
      'https://github.com/acme/policy',
      published,
      'test-owner',
    )
    const policy = await native('policy', {
      repo: 'https://github.com/acme/policy',
      config: undefined,
    })
    assert.equal(policy.value.ready, 'Ready published')
    claims.push(
      'Restart reads retain native results and published registration-scoped policy works without build effectiveConfig',
    )
    targetStore = await openPostgresBuildStoreFromEnv(
      { ...env, AB_POSTGRES_URL: url.href },
      { clock: () => new Date(now) },
    )
    const targetConfig = { ...config, baseBranch: 'main', forge: 'local-git' }
    const targetSources = Object.fromEntries(
      ['native-target', 'oracle-target'].map((repo) => [
        repo,
        new PostgresTicketSource(sql!, { repo, teamKey: 'ENG', lifecycle }, lifecycle),
      ]),
    )
    for (const [repo, targetSource] of Object.entries(targetSources)) {
      await createTicket(targetSource, {
        kind: 'node',
        title: 'Moving node',
        body: 'Node specification',
      })
      await createTicket(targetSource, {
        kind: 'node',
        title: 'Destination node',
        body: 'Node specification',
      })
      await createTicket(targetSource, { title: 'Claimed work', body: 'Work specification' })
      for (const [id, kind, suffix] of [
        ['ENG-1', 'node', 'a'],
        ['ENG-2', 'node', 'b'],
        ['ENG-3', 'work', 'work'],
      ] as const) {
        const slug = `${repo}-${suffix}`,
          ticket = { source: 'database', id, title: (await targetSource.get(id))!.title }
        await targetStore.createBuild({
          slug,
          repo,
          ticket,
          branch: `ab/${slug}`,
          created: {
            actor: { kind: 'dispatcher' },
            type: 'build.created',
            payload: { ticket, repo, baseBranch: 'main', kind },
          },
        })
        if (kind === 'node') {
          await targetStore.append(slug, {
            actor: { kind: 'dispatcher' },
            type: 'node.opening',
            payload: { branch: `ab/${slug}`, parent: 'main', sha: 'opening' },
          })
          await targetStore.append(slug, {
            actor: { kind: 'dispatcher' },
            type: 'node.opened',
            payload: { sha: 'opening' },
          })
        }
      }
    }
    const nativeTarget = (id: string, patch: TicketUpdate, expectedRevision?: string) =>
      native('target', { repo: 'native-target', config: targetConfig, id, patch, expectedRevision })
    const oracleTarget = async (id: string, patch: TicketUpdate, expectedRevision?: string) => {
      try {
        return {
          value: await updateTicketTarget(
            {
              store: targetStore!,
              repo: 'oracle-target',
              source: targetSources['oracle-target']!,
              configuredSource: 'hosted',
              root: 'main',
              supportsRetarget: async () => true,
            },
            id,
            patch,
            expectedRevision,
          ),
        }
      } catch (error) {
        return normalizeFailure(error)
      }
    }
    assert.equal((await native('get', { repo: 'native-target', id: 'ENG-2' })).value.kind, 'node')
    assert.deepEqual(
      await nativeTarget('ENG-3', { target: 'ENG-2' }),
      await oracleTarget('ENG-3', { target: 'ENG-2' }),
    )
    await sql`UPDATE builds SET node_writer_holder='test-other',node_writer_expires_at=${new Date(Date.parse(now) + 60_000).toISOString()},node_writer_ttl_ms=60000 WHERE slug IN ('native-target-a','oracle-target-a')`
    assert.deepEqual(
      await nativeTarget('ENG-1', { target: 'ENG-2' }, '1'),
      await oracleTarget('ENG-1', { target: 'ENG-2' }, '1'),
    )
    await sql`UPDATE builds SET node_writer_holder=NULL,node_writer_expires_at=NULL,node_writer_ttl_ms=NULL WHERE slug IN ('native-target-a','oracle-target-a')`
    assert.deepEqual(
      await nativeTarget('ENG-1', { target: 'ENG-2' }, '1'),
      await oracleTarget('ENG-1', { target: 'ENG-2' }, '1'),
    )
    const nativeEvents = await targetStore.getEvents('native-target-a'),
      oracleEvents = await targetStore.getEvents('oracle-target-a')
    const nativeReservation = nativeEvents.at(-1)!,
      oracleReservation = oracleEvents.at(-1)!
    assert.equal(nativeReservation.type, 'node.parent-requested')
    validateEventWrite(nativeReservation)
    const normalizeReservation = (event: { actor: unknown; type: string; payload: unknown }) =>
      JSON.parse(
        JSON.stringify({ actor: event.actor, type: event.type, payload: event.payload })
          .replaceAll(/(?:native|oracle)-target/g, 'target')
          .replace(/parent-[a-f0-9-]{36}/g, 'parent-BOUND'),
      )
    assert.deepEqual(
      normalizeReservation(nativeReservation),
      normalizeReservation(oracleReservation),
    )
    assert.deepEqual(
      await nativeTarget('ENG-1', { target: null }, '2'),
      await oracleTarget('ENG-1', { target: null }, '2'),
    )
    const [lease] = await sql`SELECT node_writer_holder FROM builds WHERE slug='native-target-a'`
    assert.equal(lease.node_writer_holder, null)
    claims.push(
      'Claimed work target refusal and native node-parent reservation payload/order match TypeScript; pending operations refuse and writer leases release',
    )
    // Clear the completed test request by the actual dispatcher cancellation fact,
    // then give the destination a pending opposite edge. Both edges count.
    for (const repo of ['native-target', 'oracle-target']) {
      const events = await targetStore.getEvents(`${repo}-a`)
      const reservation = events.find((event) => event.type === 'node.parent-requested')!
      await targetStore.append(`${repo}-a`, {
        actor: { kind: 'dispatcher' },
        type: 'node.parent-cancelled',
        payload: { id: (reservation.payload as { id: string }).id, reason: 'test cancellation' },
      })
      const destination = await targetSources[repo]!.get('ENG-1')
      await targetStore.append(`${repo}-b`, {
        actor: { kind: 'dispatcher' },
        type: 'node.parent-requested',
        payload: {
          id: 'opposite',
          old: { target: null, branch: 'main' },
          next: {
            target: { ticket: destination!.ref, build: `${repo}-a` },
            branch: `ab/${repo}-a`,
          },
          revision: '1',
        },
      })
    }
    // Provider ticket A already points at B; clearing to root is safe and leaves
    // the effective claim parent unchanged until dispatcher acceptance.
    assert.deepEqual(
      await nativeTarget('ENG-1', { target: null }, '2'),
      await oracleTarget('ENG-1', { target: null }, '2'),
    )
    assert.deepEqual(
      await nativeTarget('ENG-1', { target: 'ENG-2' }, '3'),
      await oracleTarget('ENG-1', { target: 'ENG-2' }, '3'),
    )
    claims.push(
      'Opposite pending parent edges reject cycles with exact TypeScript refusal; root retargets never borrow a pending provider move',
    )

    const httpRepo = 'https://github.com/acme/ticket-http'
    await registry.add(httpRepo, 'http-owner@example.com')
    await new PostgresTicketPolicyStore(sql).put(
      httpRepo,
      { version: 1, tickets: config.tickets },
      'http-owner@example.com',
    )
    const credential = await new PostgresCredentialStore(sql, registry).issue(
      httpRepo,
      'http-owner@example.com',
    )
    http = Bun.spawn([executable, '--http'], {
      cwd: runtime,
      env: writerEnv,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'inherit',
    })
    const output = http.stdout as ReadableStream<Uint8Array>
    const first = await output.getReader().read()
    const ready = JSON.parse(new TextDecoder().decode(first.value)) as { origin: string }
    const headers = {
      authorization: `Bearer ${credential.token}`,
      'x-autobuild-version': manifest.version,
      'x-autobuild-protocol-version': '5',
      'content-type': 'application/json',
    }
    const httpCall = async (name: string, method: string, path: string, body?: unknown) => {
      const id = `ticket-http-${name}`
      const declared = ticketHttpScenarios().find((item) => item.id === id)
      assert.ok(declared, `undeclared HTTP probe ${id}`)
      assert.equal(declared.method, method, id)
      assert.equal(declared.path, `tickets${path}`, id)
      assert.ok(!witnesses.some((item) => item.id === id), `duplicate HTTP probe ${id}`)
      const response = await fetch(
        `${ready.origin}/operator/v1/repos/${encodeURIComponent(httpRepo)}/tickets${path}`,
        { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      )
      assert.equal(response.headers.get('content-type'), 'application/json;charset=utf-8')
      const result = { status: response.status, body: await response.json() }
      witnesses.push({
        suite: 'ticket-http',
        id,
        method,
        path: `tickets${path}`,
        requestBody: body,
        status: result.status,
        responseBody: result.body,
      })
      return result
    }
    const createdHttp = await httpCall('create', 'POST', '', {
      title: 'HTTP native',
      body: '\n body \n',
    })
    assert.equal(createdHttp.status, 201)
    const httpReadback = new PostgresTicketSource(
      sql,
      { repo: httpRepo, teamKey: 'ENG', lifecycle },
      lifecycle,
    )
    const createdTicket = { ...(await httpReadback.get('ENG-1')) }
    delete createdTicket.comments
    assert.deepEqual(createdHttp.body, {
      ticket: createdTicket,
      blockers: [],
      build: null,
    })
    const patchedHttp = await httpCall('patch', 'PATCH', '/ENG-1', {
      title: 'HTTP patched',
      expectedRevision: '1',
    })
    assert.equal(patchedHttp.status, 200)
    assert.deepEqual(patchedHttp.body, {
      ticket: await httpReadback.get('ENG-1'),
      blockers: [],
      build: null,
    })
    const staleHttp = await httpCall('stale', 'PATCH', '/ENG-1', {
      title: 'stale',
      expectedRevision: '1',
    })
    assert.deepEqual(staleHttp, {
      status: 409,
      body: {
        kind: 'conflict',
        error: 'ticket "ENG-1" changed: expected revision 1, current revision 2',
      },
    })
    const unknownHttp = await httpCall('unknown-field', 'POST', '', {
      title: 'bad',
      body: 'bad',
      unknown: true,
    })
    assert.equal(unknownHttp.status, 400)
    assert.equal(unknownHttp.body.kind, 'validation')

    const tsTicketServer = createOperatorServer({
      projects: registry,
      store: targetStore,
      secret: 'test-ticket-oracle',
      auth: {
        authenticate: async () => ({
          kind: 'internal',
          repo: httpRepo,
          user: 'http-owner@example.com',
        }),
      },
      ticketBackend: {
        contextFor: async (repo) => ({ repo, tickets: config.tickets, teamKey: 'ENG' }),
        sourceFor: () => httpReadback,
        statesFor: async () => (await httpReadback.listStates()).map((state) => state.name),
      },
    })
    for (const [name, method, path, body] of [
      ['refusal-state', 'GET', '?state=unknown', undefined],
      ['refusal-blank', 'PATCH', '/ENG-1', { title: ' ', body: ' ' }],
      ['refusal-block', 'POST', '/ENG-1/block', { blockerIds: ['missing'], expectedRevision: '1' }],
      [
        'refusal-unblock',
        'POST',
        '/ENG-1/unblock',
        { blockerIds: ['missing'], expectedRevision: '1' },
      ],
    ] as const) {
      const response = await tsTicketServer.fetch(
        new Request(
          `http://oracle.test/operator/v1/repos/${encodeURIComponent(httpRepo)}/tickets${path}`,
          { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
        ),
      )
      assert.deepEqual(
        await httpCall(name, method, path, body),
        { status: response.status, body: await response.json() },
        `ticket refusal precedence ${path}`,
      )
    }
    // Read-only routes compare the actual TS HTTP registry over the same durable rows.
    const compareHttpRead = async (name: string, path: string) => {
      const expected = await tsTicketServer.fetch(
        new Request(
          `http://oracle.test/operator/v1/repos/${encodeURIComponent(httpRepo)}/tickets${path}`,
          { headers },
        ),
      )
      assert.deepEqual(await httpCall(name, 'GET', path), {
        status: expected.status,
        body: await expected.json(),
      })
    }
    for (const [name, path] of [
      ['states', '/states'],
      ['list', ''],
      ['detail', '/ENG-1'],
    ] as const)
      await compareHttpRead(name, path)
    const customState = await httpCall('state-create', 'POST', '/states', {
      name: 'waiting-http',
      about: 'HTTP state proof',
    })
    assert.deepEqual(customState, {
      status: 201,
      body: {
        state: { name: 'waiting-http', tickets: 0, about: 'HTTP state proof' },
        created: true,
      },
    })
    await compareHttpRead('states-readback', '/states')
    for (const [name, path, body] of [
      ['move', '/ENG-1/move', { state: 'ready', expectedRevision: '2' }],
      ['block', '/ENG-1/block', { blockerIds: ['ENG-2'] }],
      ['unblock', '/ENG-1/unblock', { blockerIds: ['ENG-2'] }],
    ] as const) {
      if (path.endsWith('/block')) {
        const blocker = await httpCall('blocker-create', 'POST', '', {
          title: 'HTTP blocker',
          body: 'Blocker body',
        })
        assert.equal(blocker.status, 201)
      }
      const changed = await httpCall(name, 'POST', path, body)
      assert.equal(changed.status, 200, path)
      const expected = await tsTicketServer.fetch(
        new Request(
          `http://oracle.test/operator/v1/repos/${encodeURIComponent(httpRepo)}/tickets/ENG-1`,
          { headers },
        ),
      )
      assert.deepEqual(changed.body, await expected.json(), path)
      await compareHttpRead(`${name}-readback`, '/ENG-1')
    }
    // Exercise production's published-policy fallback refusal with the same
    // typed query failure that service.ts emits for external ticket sources.
    for (const provider of ['file', 'linear']) {
      const message = `Tickets for project "native" live in its own "${provider}" ticket source, accessed directly by its dispatcher.`
      const externalServer = createOperatorServer({
        projects: registry,
        store: targetStore,
        secret: 'test-ticket-oracle',
        auth: { authenticate: async () => ({ kind: 'admin', user: 'http-owner@example.com' }) },
        ticketBackend: {
          contextFor: async (repo) => ({
            repo,
            tickets: { source: provider as 'file' | 'linear', readyState: 'ready' },
            teamKey: 'ENG',
          }),
          sourceFor: () => {
            throw new OperatorQueryError('external-ticket-source', message)
          },
          statesFor: () => [],
        },
      })
      // The typed server maps the backing context failure without changing it.
      const response = await externalServer.fetch(
        new Request(
          `http://oracle.test/operator/v1/repos/${encodeURIComponent(httpRepo)}/tickets`,
          { headers },
        ),
      )
      assert.deepEqual(
        await native('policy', { config: { tickets: { source: provider, readyState: 'ready' } } }),
        { status: response.status, body: await response.json() },
      )
    }
    claims.push(
      'Actual TypeScript HTTP refusal parity covers unknown listing state, aggregated blank patch issues, blocker-existence-before-revision precedence and external-source query errors',
    )
    await sql`UPDATE project_credentials SET revoked_at=now() WHERE id=${credential.credential.id}`
    assert.equal((await httpCall('revoked', 'GET', '/ENG-1')).status, 401)
    claims.push(
      'Real authenticated Rust HTTP ticket creates and guarded updates persist through TypeScript; strict unknown-field rejection, stale refusal and next-request credential revocation hold',
    )

    assert.deepEqual(
      witnesses.map((item) => item.id),
      ticketHttpScenarios().map((item) => item.id),
      'complete ticket HTTP probe manifest',
    )
    evidence = {
      checkpoint: 'native-ticket-storage',
      claims,
      httpParity: true,
      witnesses,
      claimedNodeRetargeting: true,
    }
    console.log(JSON.stringify(evidence))
  } catch (error) {
    failure = error
  } finally {
    const errors: unknown[] = []
    for (const close of [
      async () => {
        if (http?.exitCode === null) {
          http.kill('SIGTERM')
          await http.exited
        }
      },
      () => rust?.close(),
      () => competitor?.close(),
      () => targetStore?.close(),
      () => sql?.close(),
      () => (created ? admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`) : undefined),
      () => (roleCreated ? admin.unsafe(`DROP ROLE ${role}`) : undefined),
      () => admin.close(),
      () => rm(runtime, { recursive: true, force: true }),
    ]) {
      try {
        await close()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) failure ??= new AggregateError(errors, 'Ticket proof cleanup failed')
  }
  if (failure) throw failure
  if (!evidence) throw new Error('Ticket proof did not produce evidence')
  return evidence
}
if (import.meta.main) await withDataServices(ticketIntegration)
