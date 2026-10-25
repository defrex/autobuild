/** Real native delegation HTTP/SQL parity with the unchanged TypeScript service. */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import type { SQL } from 'bun'
import type { BuildStore } from '../../../packages/core/src/store/types'
import { validateEventWrite } from '../../../packages/core/src/events/catalog'
import { validateRepositoryEventWrite } from '../../../packages/core/src/events/repository'
import {
  mintToken,
  verifyToken,
  type DelegatedTokenScope,
} from '../../../packages/core/src/store/remote/token'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import { createMachineAuth } from '../../../packages/hosted-store-service/src/machine-auth'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import { createOperatorServer } from '../../../packages/hosted-store-service/src/operator-server'
import { sources } from './fixture-core'
import { operatorClock } from './operator-fixtures'

const secret = 'offline-operator-fixture-secret',
  now = new Date(operatorClock)
type Authority =
  | 'admin'
  | 'internal'
  | 'owner'
  | 'dispatcher'
  | 'build-runner'
  | 'build-phase'
  | 'harvest-runner'
  | 'harvest-phase'
  | 'missing'
  | 'invalid'
  | 'expired-admin'
  | 'foreign-owner'
type End =
  | 'build-within'
  | 'build-expired'
  | 'phase-within'
  | 'phase-expired'
  | 'phase-suspended'
  | 'harvest-within'
  | 'harvest-expired'
  | 'harvest-suspended'
  | 'authorization-replaced'
  | 'session-predates'
  | 'stale-anchor'
  | 'revoked'
  | 'expired'
  | 'removed'
interface Scenario {
  id: string
  authority: Authority
  target?:
    | 'build-runner'
    | 'build-phase'
    | 'harvest-runner'
    | 'harvest-phase'
    | 'missing-build'
    | 'missing-session'
    | 'wrong-holder'
    | 'missing-execution'
  end?: End
  raw?: string
  body?: unknown
  version?: string | null
}
export function delegationSeamScenarios(): Scenario[] {
  const result: Scenario[] = []
  for (const authority of [
    'admin',
    'internal',
    'owner',
    'dispatcher',
    'build-runner',
    'build-phase',
    'harvest-runner',
    'harvest-phase',
  ] as Authority[]) {
    result.push({ id: `${authority}-build-phase`, authority, target: 'build-phase' })
    result.push({ id: `${authority}-harvest-phase`, authority, target: 'harvest-phase' })
  }
  for (const target of [
    'build-runner',
    'harvest-runner',
    'missing-build',
    'missing-session',
    'wrong-holder',
    'missing-execution',
  ] as const)
    result.push({ id: `admin-${target}`, authority: 'admin', target })
  result.push(
    { id: 'version-before-auth', authority: 'missing', raw: '{', version: null },
    { id: 'invalid-version-before-body', authority: 'admin', raw: '{', version: 'garbage' },
    { id: 'auth-before-invalid-json', authority: 'missing', raw: '{' },
    { id: 'invalid-bearer', authority: 'invalid', target: 'build-runner' },
    { id: 'expired-admin', authority: 'expired-admin', target: 'build-runner' },
    { id: 'invalid-json', authority: 'admin', raw: '{' },
    { id: 'body-null', authority: 'admin', body: null },
    { id: 'body-array', authority: 'admin', body: [] },
    {
      id: 'target-unknown-field',
      authority: 'admin',
      body: { kind: 'build-runner', id: 'missing', future: true },
    },
    { id: 'target-empty-id', authority: 'admin', body: { kind: 'build-runner', id: '' } },
    { id: 'target-wrong-kind', authority: 'admin', body: { kind: 'build', id: 'missing' } },
    { id: 'foreign-owner', authority: 'foreign-owner', target: 'build-phase' },
  )
  for (const end of [
    'build-within',
    'build-expired',
    'phase-within',
    'phase-expired',
    'phase-suspended',
  ] as End[])
    result.push({ id: `admin-${end}`, authority: 'admin', target: 'build-phase', end })
  for (const end of [
    'harvest-within',
    'harvest-expired',
    'harvest-suspended',
    'authorization-replaced',
  ] as End[])
    result.push({
      id: `harvest-runner-${end}`,
      authority: 'harvest-runner',
      target: 'harvest-phase',
      end,
    })
  for (const end of ['session-predates', 'stale-anchor'] as End[])
    result.push({
      id: `build-runner-${end}`,
      authority: 'build-runner',
      target: 'build-phase',
      end,
    })
  for (const end of ['revoked', 'expired', 'removed'] as End[])
    result.push({ id: `owner-${end}`, authority: 'owner', target: 'build-phase', end })
  result.push({ id: 'runner-cannot-widen', authority: 'build-runner', target: 'build-runner' })
  return result
}
export async function replayNativeDelegation(options: {
  sql: SQL
  store: BuildStore
  address: string
  spawnServer?: (settings: {
    secret?: string
  }) => Promise<{ address: string; close: () => Promise<void> }>
}) {
  const registry = new PostgresProjectRegistry(options.sql),
    credentials = new PostgresCredentialStore(options.sql, registry),
    checked: string[] = []
  const auth = createMachineAuth({
    secret,
    projects: registry,
    credentials,
    store: options.store,
    clock: () => now,
  })
  const oracle = createStoreServer({ store: options.store, auth, secret, clock: () => now })
  const operator = createOperatorServer({
    store: options.store,
    auth,
    projects: registry,
    secret,
    clock: () => now,
  })
  for (const scenario of delegationSeamScenarios()) {
    const repo = `https://github.com/delegation-fixture/${scenario.id}`,
      foreign = `https://github.com/delegation-foreign/${scenario.id}`,
      slug = `delegation-${scenario.id}`,
      run = `harvest-${scenario.id}`,
      execution = `execution-${scenario.id}`,
      holder = `holder-${scenario.id}`
    await registry.add(repo, 'fixture-owner')
    await registry.add(foreign, 'fixture-owner')
    const owner = await credentials.issue(repo, 'owner@example.com'),
      dispatcher = await credentials.issue(repo, 'dispatcher@example.com', {
        purpose: 'dispatcher',
      }),
      foreignOwner = await credentials.issue(foreign, 'foreign@example.com')
    const ticket = { source: 'file', id: 'file-1', title: 'Delegation seam fixture' }
    await options.store.createBuild({
      slug,
      repo,
      ticket,
      created: {
        actor: { kind: 'dispatcher' },
        type: 'build.created',
        payload: { repo, ticket, baseBranch: 'main' },
      },
    })
    const append = async (
      type: string,
      payload: unknown,
      actor: unknown = { kind: 'kernel' },
      at?: string,
    ) => {
      const event = await options.store.append(slug, validateEventWrite({ type, payload, actor }))
      if (at) await options.sql`UPDATE events SET ts=${at} WHERE build=${slug} AND seq=${event.seq}`
      return event
    }
    const appendRepo = async (
      type: string,
      payload: unknown,
      actor: unknown = { kind: 'kernel' },
      at?: string,
    ) => {
      const event = await options.store.appendRepo(
        repo,
        validateRepositoryEventWrite({ type, payload, actor }),
      )
      if (at)
        await options.sql`UPDATE repo_events SET ts=${at} WHERE repo=${repo} AND seq=${event.seq}`
      return event
    }
    await append('runner.attached', {
      instance: 'fixture-runner',
      host: 'test-host',
      resumedFromSeq: 0,
    })
    await append('session.started', {
      session: 'fixture-phase',
      role: 'implement',
      runner: 'test',
      phase: 'implement',
      round: 1,
    })
    await options.store.ensureRepo(repo)
    await options.store.claimRepoLease(repo, holder, 60000)
    await appendRepo('harvest.started', {
      run,
      observations: [{ build: slug, seq: 1 }],
      scan: { kind: 'harvest-scan', rev: 0 },
    })
    await appendRepo(
      'harvest.execution.authorized',
      { execution, run, launch: 'started', leaseHolder: holder },
      { kind: 'dispatcher' },
    )
    await appendRepo('harvest.session.started', {
      run,
      session: 'fixture-harvest-phase',
      role: 'harvest',
      runner: 'test',
      step: 'synthesize',
      round: 1,
      args: [],
    })
    const within = new Date(now.getTime() - 59999).toISOString(),
      ended = new Date(now.getTime() - 60000).toISOString()
    if (scenario.end?.startsWith('build-'))
      await append('build.aborted', {}, undefined, scenario.end === 'build-within' ? within : ended)
    if (scenario.end?.startsWith('phase-')) {
      if (scenario.end === 'phase-suspended')
        await append('session.suspended', {
          session: 'fixture-phase',
          phase: 'implement',
          round: 1,
          cause: 'pause',
          activeMs: 1,
          transcript: { kind: 'transcript', rev: 0 },
        })
      else
        await append(
          'session.ended',
          {
            session: 'fixture-phase',
            transcript: { kind: 'transcript', rev: 0 },
            usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
          },
          undefined,
          scenario.end === 'phase-within' ? within : ended,
        )
    }
    if (scenario.end === 'harvest-within' || scenario.end === 'harvest-expired')
      await appendRepo(
        'harvest.execution.released',
        {
          execution,
          environmentId: 'environment',
          snapshots: { outcome: 'confirmed', deleted: 0 },
        },
        { kind: 'dispatcher' },
        scenario.end === 'harvest-within' ? within : ended,
      )
    if (scenario.end === 'harvest-suspended')
      await appendRepo('harvest.session.suspended', {
        run,
        session: 'fixture-harvest-phase',
        cause: 'shutdown',
        transcript: { kind: 'transcript', rev: 0 },
      })
    if (scenario.end === 'authorization-replaced')
      await appendRepo(
        'harvest.execution.authorized',
        { execution, run, launch: 'resumed', leaseHolder: holder },
        { kind: 'dispatcher' },
      )
    if (scenario.end === 'session-predates')
      await append('runner.attached', {
        instance: 'new-runner',
        host: 'test-host',
        resumedFromSeq: 3,
      })
    if (scenario.end === 'revoked')
      await options.sql`UPDATE project_credentials SET revoked_at=${operatorClock} WHERE id=${owner.credential.id}`
    if (scenario.end === 'expired')
      await options.sql`UPDATE project_credentials SET expires_at=${new Date(now.getTime() - 1).toISOString()} WHERE id=${owner.credential.id}`
    if (scenario.end === 'removed') await registry.remove(repo, 'fixture-owner')
    let claims: DelegatedTokenScope['delegation'] | undefined, token: string | undefined
    switch (scenario.authority) {
      case 'admin':
        token = mintToken(secret, {
          version: 1,
          ownerAdmin: { user: 'admin@example.com' },
          exp: now.getTime() + 60000,
        })
        break
      case 'expired-admin':
        token = mintToken(secret, {
          version: 1,
          ownerAdmin: { user: 'admin@example.com' },
          exp: now.getTime() - 1,
        })
        break
      case 'internal':
        token = mintToken(secret, {
          version: 1,
          internalOperator: { user: 'operator@example.com', repo },
          exp: now.getTime() + 60000,
        })
        break
      case 'owner':
        token = owner.token
        break
      case 'dispatcher':
        token = dispatcher.token
        break
      case 'foreign-owner':
        token = foreignOwner.token
        break
      case 'invalid':
        token = 'not-a-valid-credential'
        break
      case 'missing':
        break
      default: {
        const build = scenario.authority.startsWith('build')
        claims = {
          repo,
          kind: scenario.authority,
          id: build ? slug : run,
          anchor:
            scenario.end === 'stale-anchor'
              ? 999
              : scenario.end === 'session-predates'
                ? 4
                : scenario.authority.endsWith('-runner')
                  ? 2
                  : 3,
          ...(!build ? { execution } : {}),
          ...(scenario.authority === 'harvest-runner' ? { leaseHolder: holder } : {}),
          ...(scenario.authority.endsWith('-phase')
            ? { session: build ? 'fixture-phase' : 'fixture-harvest-phase' }
            : {}),
        }
        token = mintToken(secret, { version: 2, delegation: claims })
      }
    }
    const targets = {
      'build-runner': { kind: 'build-runner', id: slug },
      'build-phase': { kind: 'build-phase', id: slug, session: 'fixture-phase' },
      'harvest-runner': { kind: 'harvest-runner', id: run, repo, execution, leaseHolder: holder },
      'harvest-phase': { kind: 'harvest-phase', id: run, repo, session: 'fixture-harvest-phase' },
      'missing-build': { kind: 'build-runner', id: `missing-${slug}` },
      'missing-session': { kind: 'build-phase', id: slug, session: 'missing' },
      'wrong-holder': { kind: 'harvest-runner', id: run, repo, execution, leaseHolder: 'wrong' },
      'missing-execution': {
        kind: 'harvest-runner',
        id: run,
        repo,
        execution: 'missing',
        leaseHolder: holder,
      },
    }
    const body =
      scenario.body === undefined ? targets[scenario.target ?? 'build-runner'] : scenario.body
    const headers: Record<string, string> = {
      'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
      'content-type': 'application/json',
      ...(scenario.version === null
        ? {}
        : { 'x-autobuild-version': scenario.version ?? AUTOBUILD_VERSION }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    }
    const init = { method: 'POST', headers, body: scenario.raw ?? JSON.stringify(body) }
    const before = await options.store.getEvents(slug),
      beforeRepo = await options.store.getRepoEvents(repo)
    const expected = await oracle.fetch(
        new Request('http://oracle.invalid/credentials/delegate', init),
      ),
      response = await fetch(`${options.address}/credentials/delegate`, init)
    const expectedBody = (await expected.json()) as { token?: string },
      actualBody = (await response.json()) as { token?: string }
    assert.equal(
      response.status,
      expected.status,
      `${scenario.id}: delegation status ${JSON.stringify(actualBody)}`,
    )
    assert.deepEqual(actualBody, expectedBody, `${scenario.id}: exact token/refusal bytes`)
    assert.equal(
      response.headers.get('content-type'),
      expected.headers.get('content-type'),
      `${scenario.id}: exact response content type`,
    )
    if (actualBody.token) {
      const decoded = verifyToken(secret, actualBody.token, now)
      assert.ok(decoded && 'version' in decoded)
      assert.equal(decoded.version, 2, `${scenario.id}: TS verifies Rust-issued HMAC scope`)
      const path = `/operator/v1/repos/${encodeURIComponent(repo)}/builds`,
        operatorHeaders = { ...headers, authorization: `Bearer ${actualBody.token}` }
      const nativeOperator = await fetch(`${options.address}${path}`, { headers: operatorHeaders }),
        expectedOperator = await operator.fetch(
          new Request(`http://oracle.invalid${path}`, { headers: operatorHeaders }),
        )
      assert.equal(
        nativeOperator.status,
        expectedOperator.status,
        `${scenario.id}: delegated operator status`,
      )
      assert.deepEqual(
        await nativeOperator.json(),
        await expectedOperator.json(),
        `${scenario.id}: delegated operator refusal`,
      )
    }
    assert.deepEqual(
      await options.store.getEvents(slug),
      before,
      `${scenario.id}: issuance wrote build events`,
    )
    assert.deepEqual(
      await options.store.getRepoEvents(repo),
      beforeRepo,
      `${scenario.id}: issuance wrote repository events`,
    )
    checked.push(scenario.id)
  }
  if (options.spawnServer) {
    const server = await options.spawnServer({})
    try {
      const headers = {
        'x-autobuild-version': AUTOBUILD_VERSION,
        'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
      }
      const response = await fetch(`${server.address}/credentials/delegate`, {
        method: 'POST',
        headers,
        body: '{',
      })
      const unavailable = createStoreServer({ store: options.store, clock: () => now }),
        expected = await unavailable.fetch(
          new Request('http://oracle.invalid/credentials/delegate', {
            method: 'POST',
            headers,
            body: '{',
          }),
        )
      assert.equal(response.status, expected.status)
      assert.deepEqual(await response.json(), await expected.json())
      assert.equal(response.headers.get('content-type'), expected.headers.get('content-type'))
      checked.push('unconfigured-issuance-unavailable')
    } finally {
      await server.close()
    }
  }
  return {
    cases: checked,
    sourceClosureSha256: createHash('sha256').update(JSON.stringify(sources())).digest('hex'),
    unconfiguredServer: !!options.spawnServer,
  }
}

if (import.meta.main) {
  const { SQL } = await import('bun'),
    { resolve } = await import('node:path'),
    { mkdtemp, rm } = await import('node:fs/promises'),
    { tmpdir } = await import('node:os')
  const { withDataServices } = await import('./data-services'),
    { bridge } = await import('./data-integration'),
    { migratePostgres } = await import('../../../packages/postgres-store/src/schema'),
    { openPostgresBuildStoreFromEnv } = await import('../../../packages/postgres-store/src/config')
  await withDataServices(async (adminUrl, environment) => {
    const project = resolve(import.meta.dir, '..'),
      name = `proa_delegation_${crypto.randomUUID().replaceAll('-', '')}`,
      admin = new SQL(adminUrl, { max: 1 }),
      url = new URL(adminUrl),
      runtime = await mkdtemp(resolve(tmpdir(), 'proa-delegation-proof-'))
    url.pathname = `/${name}`
    const env = { ...environment, AB_POSTGRES_URL: url.href, AB_STORE_SECRET: secret }
    let created = false,
      sql: SQL | undefined,
      store: Awaited<ReturnType<typeof openPostgresBuildStoreFromEnv>> | undefined,
      failure: unknown,
      evidence: Awaited<ReturnType<typeof replayNativeDelegation>> | undefined
    const children: Awaited<ReturnType<typeof bridge>>[] = []
    try {
      const child = Bun.spawn(
        ['cargo', 'build', '--locked', '--example', 'operator-proof', '--message-format=json'],
        { cwd: project, env, stdout: 'pipe', stderr: 'inherit' },
      )
      const output = await new Response(child.stdout).text()
      if (await child.exited) throw new Error('Native delegation proof build failed')
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
          item.target?.name === 'operator-proof' &&
          item.executable
        )
          executable = item.executable
      }
      if (!executable) throw new Error('Cargo did not report delegation proof executable')
      await admin.unsafe(`CREATE DATABASE ${name}`)
      created = true
      await migratePostgres(url.href)
      sql = new SQL(url.href, { max: 1 })
      store = await openPostgresBuildStoreFromEnv(env, { clock: () => now })
      const spawn = async (settings: { secret?: string }) => {
        const native = await bridge({ ...env, AB_STORE_SECRET: settings.secret }, runtime, [
          executable!,
        ])
        children.push(native)
        const address = (await native.request({ op: 'http-address' })).value as string
        const close = native.close.bind(native)
        let closing: Promise<void> | undefined
        native.close = () => {
          closing ??= close()
          return closing
        }
        return { address, close: () => native.close() }
      }
      const main = await spawn({ secret })
      evidence = await replayNativeDelegation({
        sql,
        store,
        address: main.address,
        spawnServer: spawn,
      })
    } catch (error) {
      failure = error
    } finally {
      for (const close of [
        ...children.map((child) => () => child.close()),
        () => store?.close(),
        () => sql?.close(),
        () => (created ? admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`) : undefined),
        () => admin.close(),
        () => rm(runtime, { recursive: true, force: true }),
      ]) {
        try {
          await close()
        } catch (error) {
          failure ??= error
        }
      }
    }
    if (failure) throw failure
    console.log(JSON.stringify({ checkpoint: 'native-delegation-http', ...evidence }))
  })
}
