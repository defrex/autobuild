/** Durable native/TypeScript connection interchange. No HTTP or browser claim. */
import { SQL } from 'bun'
import { strict as assert } from 'node:assert'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { PostgresConnectionStore } from '../../../packages/postgres-store/src/connections'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { migratePostgres } from '../../../packages/postgres-store/src/schema'
import { bridge } from './data-integration'
import { withDataServices } from './data-services'

export async function connectPersistenceIntegration(
  adminUrl: string,
  env: Record<string, string | undefined>,
) {
  const project = resolve(import.meta.dir, '..')
  const build = Bun.spawn(
    ['cargo', 'build', '--locked', '--example', 'connection-proof', '--message-format=json'],
    { cwd: project, env, stdout: 'pipe', stderr: 'inherit' },
  )
  const output = await new Response(build.stdout).text()
  if (await build.exited) throw Error('Native connection proof build failed')
  const executable = output
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find(
      (item) =>
        item.reason === 'compiler-artifact' &&
        item.target?.name === 'connection-proof' &&
        item.executable,
    )?.executable
  assert.ok(executable)
  const admin = new SQL(adminUrl, { max: 1 })
  const database = `proa_connection_${randomBytes(8).toString('hex')}`
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  const runtime = await mkdtemp(resolve(tmpdir(), 'proa-connection-proof-'))
  let sql: SQL | undefined, rust: Awaited<ReturnType<typeof bridge>> | undefined
  let created = false
  let now = new Date('2026-09-02T00:00:00.000Z')
  const repo = 'https://github.com/owner/connect-proof'
  const actor = 'operator@example.com'
  try {
    await admin.unsafe(`CREATE DATABASE ${database}`)
    created = true
    await migratePostgres(url.href)
    sql = new SQL(url.href, { max: 1 })
    const typescript = new PostgresConnectionStore(sql, () => now)
    const registry = new PostgresProjectRegistry(sql)
    const credentials = new PostgresCredentialStore(sql, registry)
    const startBridge = () => bridge({ ...env, AB_POSTGRES_URL: url.href }, runtime, [executable])
    rust = await startBridge()
    const native = async (op: string, fields: Record<string, unknown>) => {
      const result = await rust!.request({ op, now: now.toISOString(), ...fields })
      assert.equal(result.status, undefined, `native ${op} failed: ${result.error}`)
      return result.value
    }
    const proposal = () => {
      const id = randomBytes(16).toString('hex'),
        secret = randomBytes(32).toString('hex')
      return {
        credentialId: id,
        secret,
        digest: createHash('sha256').update(secret).digest('hex'),
        repo,
      }
    }
    // Rust request survives process replacement; TypeScript approves the same row.
    const first = proposal(),
      started = await native('start', first)
    assert.equal(started.repo, repo)
    assert.equal(started.status, 'pending')
    assert.match(started.code, /^[A-F0-9]{10}$/)
    await rust.close()
    rust = await startBridge()
    assert.equal((await typescript.lookup(started.code, actor))?.id, started.id)
    assert.equal((await typescript.decide(started.code, actor, true)).status, 'approved')
    assert.equal((await native('poll', started)).status, 'approved')
    assert.equal(
      (await credentials.authenticate(`abp_1_${first.credentialId}_${first.secret}`, now))?.repo,
      repo,
    )
    const firstToken = `abp_1_${first.credentialId}_${first.secret}`
    const status = await native('http', {
      method: 'GET',
      path: '/connect/v1/status',
      token: firstToken,
    })
    assert.deepEqual(status, {
      status: 200,
      body: { repo, credentialId: first.credentialId, accepted: true },
    })
    // Cancel is atomic with revocation and is readable by the TypeScript adapter.
    assert.equal((await native('cancel', started)).status, 'denied')
    assert.equal(
      await credentials.authenticate(`abp_1_${first.credentialId}_${first.secret}`, now),
      null,
    )
    now = new Date(now.getTime() + 5000)
    assert.equal((await typescript.poll(started.id, started.capability)).status, 'denied')
    // TypeScript request approved by Rust installs exactly the CLI-prepared digest.
    const second = proposal(),
      other = await typescript.start(second)
    assert.equal(
      (await native('decide', { code: other.code, actor, approve: true })).status,
      'approved',
    )
    assert.equal((await typescript.poll(other.id, other.capability)).status, 'approved')
    assert.equal(
      (await credentials.authenticate(`abp_1_${second.credentialId}_${second.secret}`, now))
        ?.createdBy,
      actor,
    )
    assert.equal(
      (await native('decide', { code: other.code, actor, approve: false })).status,
      'approved',
    )
    const secondToken = `abp_1_${second.credentialId}_${second.secret}`
    assert.equal(
      (await native('http', { method: 'POST', path: '/connect/v1/revoke', token: secondToken }))
        .status,
      200,
    )
    assert.equal(
      (await native('http', { method: 'GET', path: '/connect/v1/status', token: secondToken }))
        .status,
      401,
    )
    assert.equal(await credentials.authenticate(secondToken, now), null)
    const publicProposal = proposal()
    const httpStarted = await native('http', {
      method: 'POST',
      path: '/connect/v1/requests',
      contentType: 'application/json',
      body: JSON.stringify(publicProposal),
    })
    assert.equal(httpStarted.status, 200)
    assert.equal(httpStarted.body.interval, 5)
    assert.equal(
      httpStarted.body.verificationURL,
      `https://connect.example/connect?code=${httpStarted.body.code}`,
    )
    const httpPoll = await native('http', {
      method: 'POST',
      path: '/connect/v1/poll',
      contentType: 'application/json',
      body: JSON.stringify(httpStarted.body),
    })
    assert.equal(httpPoll.body.status, 'pending')
    const limited = await native('http', {
      method: 'POST',
      path: '/connect/v1/poll',
      contentType: 'application/json',
      body: JSON.stringify(httpStarted.body),
    })
    assert.deepEqual(limited, { status: 429, body: { error: 'poll again in five seconds' } })
    const httpCancel = await native('http', {
      method: 'POST',
      path: '/connect/v1/cancel',
      contentType: 'application/json',
      body: JSON.stringify(httpStarted.body),
    })
    assert.equal(httpCancel.body.status, 'denied')
    // Deny/expiry install no credential; lookup expiration is observational.
    const denied = await native('start', proposal())
    const lookedUp = await native('http', {
      method: 'POST',
      path: '/connect/v1/browser/lookup',
      actor,
      contentType: 'application/json',
      body: JSON.stringify({ code: ` ${denied.code.toLowerCase()} ` }),
    })
    assert.equal(lookedUp.body.connection.id, denied.id)
    const browserDenied = await native('http', {
      method: 'POST',
      path: '/connect/v1/browser/decide',
      actor,
      contentType: 'application/json',
      body: JSON.stringify({ code: denied.code, approve: false }),
    })
    assert.equal(browserDenied.body.connection.status, 'denied')
    const expired = await native('start', proposal())
    now = new Date(now.getTime() + 600000)
    assert.equal((await native('lookup', { code: expired.code, actor })).status, 'expired')
    assert.equal((await native('poll', expired)).status, 'expired')
    const count = await sql`SELECT count(*)::int AS n FROM project_credentials`
    assert.equal(count[0].n, 2)
    // Failed approval rolls back a newly registered project as well as decision.
    const collision = await native('start', {
      ...proposal(),
      credentialId: second.credentialId,
      repo: 'https://github.com/owner/collision',
    })
    const failure = await rust.request({
      op: 'decide',
      now: now.toISOString(),
      code: collision.code,
      actor,
      approve: true,
    })
    assert.equal(failure.status, 503)
    assert.equal(await registry.has(collision.repo), false)
    assert.equal((await typescript.lookup(collision.code, actor))?.status, 'pending')
    // Native approval racing a TypeScript cancellation always ends denied and
    // cannot leave a usable credential, regardless of lock acquisition order.
    const racedProposal = proposal()
    const raced = await native('start', racedProposal)
    await Promise.all([
      native('decide', { code: raced.code, actor, approve: true }),
      typescript.poll(raced.id, raced.capability, true),
    ])
    assert.equal((await typescript.lookup(raced.code, actor))?.status, 'denied')
    assert.equal(
      await credentials.authenticate(
        `abp_1_${racedProposal.credentialId}_${racedProposal.secret}`,
        now,
      ),
      null,
    )
    // Capability mismatch is indistinguishable from missing request.
    const unknown = await rust.request({
      op: 'poll',
      now: now.toISOString(),
      id: other.id,
      capability: '0'.repeat(64),
    })
    assert.deepEqual(unknown, { status: 404, error: 'unknown connection' })
    return {
      restart: true,
      crossLanguageApproval: true,
      cancelRevocation: true,
      expiry: true,
      collisionRollback: true,
    }
  } finally {
    await rust?.close()
    await sql?.close()
    if (created) await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`)
    await admin.close()
    await rm(runtime, { recursive: true, force: true })
  }
}
if (import.meta.main) console.log(await withDataServices(connectPersistenceIntegration))
