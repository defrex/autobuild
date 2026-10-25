/** Explicit database proof, invoked by protocol-credentials.ts, not bun test tools.
 * This tests the Rust auth module and shared credential schema through a private
 * fixture bridge. It is not evidence that production Rust HTTP auth is mounted.
 */
import { SQL } from 'bun'
import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { withProtocolDatabase } from './protocol-harness'

const root = resolve(import.meta.dir, '../../..')
const baseline = '2030-01-01T00:00:00.000Z'
const at = (milliseconds: number) => new Date(Date.parse(baseline) + milliseconds).toISOString()

async function bridge(executable: string, environment: Record<string, string | undefined>) {
  const child = Bun.spawn([executable], {
    env: environment,
    stdin: 'pipe',
    stdout: 'pipe',
    // The bridge must not print secrets. Never write stdout into evidence files.
    stderr: 'inherit',
  })
  const lines = (async function* () {
    let pending = ''
    for await (const bytes of child.stdout) {
      pending += new TextDecoder().decode(bytes)
      while (pending.includes('\n')) {
        const index = pending.indexOf('\n')
        const line = pending.slice(0, index)
        pending = pending.slice(index + 1)
        try {
          yield JSON.parse(line)
        } catch {
          throw new Error('Rust credential bridge returned malformed JSON')
        }
      }
    }
    throw new Error(`Rust credential bridge closed (exit ${await child.exited})`)
  })()
  const next = async () => {
    const timer = setTimeout(() => child.kill(), 30_000)
    try {
      return (await lines.next()).value
    } finally {
      clearTimeout(timer)
    }
  }
  const close = async () => {
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), 10_000)
    try {
      const exit = await child.exited
      if (exit !== 0) throw new Error(`Rust credential bridge exited ${exit}`)
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    assert.deepEqual(await next(), { ready: true })
  } catch (error) {
    child.kill()
    await child.exited
    throw error
  }
  return {
    async request(command: Record<string, unknown>) {
      child.stdin.write(`${JSON.stringify(command)}\n`)
      await child.stdin.flush()
      return next()
    },
    close,
  }
}

export async function runCredentialProof(
  executable: string,
  adminUrl: string,
  environment: Record<string, string | undefined>,
) {
  await withProtocolDatabase(adminUrl, environment, async (env) => {
    const sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 })
    let rust: Awaited<ReturnType<typeof bridge>> | undefined
    try {
      const projects = new PostgresProjectRegistry(sql)
      const credentials = new PostgresCredentialStore(sql, projects)
      const a = (await projects.add('https://github.com/proa/auth-a', 'credential proof')).repo
      const b = (await projects.add('https://github.com/proa/auth-b', 'credential proof')).repo
      rust = await bridge(executable, env)
      const request = (op: string, fields: Record<string, unknown> = {}) =>
        rust!.request({ op, now: baseline, ...fields })
      const credentialCli = Bun.spawn(
        [
          'bun',
          'packages/hosted-store-service/src/bin.ts',
          'credentials',
          'issue',
          a,
          '--user',
          'TS owner',
        ],
        { cwd: root, env, stdout: 'pipe', stderr: 'pipe' },
      )
      // Capture only in memory; do not expose stdout in assertion diagnostics.
      const [issuedText, _diagnostics, exit] = await Promise.all([
        new Response(credentialCli.stdout).text(),
        new Response(credentialCli.stderr).text(),
        credentialCli.exited,
      ])
      assert.equal(exit, 0, 'TypeScript credential CLI issue failed')
      let issued: { token: string; credential: { id: string } }
      try {
        issued = JSON.parse(issuedText)
      } catch {
        throw new Error('TypeScript credential CLI returned malformed JSON')
      }
      const token = issued.token
      const first = await request('authenticate', { token })
      assert.equal(first.value.id, issued.credential.id)
      assert.equal(first.value.createdBy, 'TS owner')
      assert.equal(first.value.repo, a)
      assert.equal(first.value.purpose, 'project-owner')
      assert.equal(first.value.lastUsedAt, baseline)
      assert.deepEqual(await credentials.authenticate(token, new Date(baseline)), first.value)
      assert.equal(
        (await request('authenticate', { token, now: at(59_999) })).value.lastUsedAt,
        baseline,
      )
      assert.equal(
        (await request('authenticate', { token, now: at(60_000) })).value.lastUsedAt,
        at(60_000),
      )
      assert.equal(
        (await request('authenticate', { token, now: at(1) })).value.lastUsedAt,
        at(60_000),
        'clock rollback must not move heartbeat backward',
      )
      const reverse = await request('issue', {
        repo: b,
        user: ' Rust dispatcher ',
        purpose: 'dispatcher',
      })
      const reverseMeta = await credentials.authenticate(reverse.token, new Date(baseline))
      assert.equal(reverseMeta?.id, reverse.id)
      assert.equal(reverseMeta?.repo, b)
      assert.equal(reverseMeta?.createdBy, 'Rust dispatcher')
      assert.equal(reverseMeta?.purpose, 'dispatcher')
      assert.deepEqual((await request('authenticate', { token: reverse.token })).value, reverseMeta)
      assert.deepEqual(await request('bearer'), {
        status: 401,
        kind: 'auth',
        error: 'missing bearer credential',
      })
      assert.deepEqual(
        await request('bearer', {
          authorization: `Bearer abp_1_${'0'.repeat(32)}_${'f'.repeat(64)}`,
        }),
        { status: 401, kind: 'auth', error: 'unknown or revoked credential' },
      )
      assert.equal((await request('bearer', { authorization: 'Bearer old-token' })).status, 401)
      await sql`UPDATE project_credentials SET expires_at = ${at(60_000)} WHERE id = ${issued.credential.id}`
      assert.equal(
        (await request('authenticate', { token, now: at(59_999) })).value.id,
        issued.credential.id,
      )
      assert.deepEqual(
        await request('bearer', { authorization: `Bearer ${token}`, now: at(60_000) }),
        { status: 401, kind: 'auth', error: 'unknown or revoked credential' },
      )
      await sql`UPDATE project_credentials SET expires_at = NULL WHERE id = ${issued.credential.id}`
      await credentials.revoke(a, issued.credential.id, 'TS owner')
      assert.deepEqual(await request('bearer', { authorization: `Bearer ${token}` }), {
        status: 401,
        kind: 'auth',
        error: 'unknown or revoked credential',
      })
      await projects.remove(a, 'TS owner')
      // Invalid/revoked authentication precedes the removed-project diagnostic.
      assert.equal((await request('bearer', { authorization: `Bearer ${token}` })).status, 401)
      await projects.remove(b, 'TS owner')
      assert.deepEqual(await request('bearer', { authorization: `Bearer ${reverse.token}` }), {
        status: 403,
        kind: 'auth',
        error: 'project not registered',
      })
      // Same process, next request observes a newly restored project too.
      await projects.add(b, 'TS owner')
      assert.equal((await request('authenticate', { token: reverse.token })).value.id, reverse.id)
      await credentials.revoke(b, reverse.id, 'TS owner')
      assert.equal((await request('authenticate', { token: reverse.token })).value, null)
    } finally {
      try {
        await rust?.close()
      } finally {
        await sql.close()
      }
    }
  })
  console.log(
    'Credential module proof passed: TypeScript CLI → Rust; Rust → TypeScript; immediate expiry/revocation/removal and last-use boundary. No HTTP conformance claimed.',
  )
}

/** Real HTTP authorization proof using the shared native machine constructor.
 * The normal browser binary mount and signed delegation remain separate work.
 */
export async function runCredentialHttpProof(
  executable: string,
  adminUrl: string,
  environment: Record<string, string | undefined>,
) {
  const { startProtocolServer } = await import('./protocol-server-harness')
  const { AUTOBUILD_VERSION, REMOTE_STORE_PROTOCOL_VERSION } = await import(
    '../../../packages/core/src/store/remote/version'
  )
  const { openPostgresBuildStoreFromEnv } = await import(
    '../../../packages/postgres-store/src/config'
  )
  await withProtocolDatabase(adminUrl, environment, async (env) => {
    const sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 })
    let server: Awaited<ReturnType<typeof startProtocolServer>> | undefined
    let fixtures: Awaited<ReturnType<typeof openPostgresBuildStoreFromEnv>> | undefined
    const clock = () => new Date(baseline)
    try {
      const projects = new PostgresProjectRegistry(sql)
      const credentials = new PostgresCredentialStore(sql, projects)
      const a = (await projects.add('https://github.com/proa/http-auth-a', 'proof')).repo
      const b = (await projects.add('https://github.com/proa/http-auth-b', 'proof')).repo
      const owner = await credentials.issue(a, 'owner')
      const other = await credentials.issue(b, 'other')
      server = await startProtocolServer({
        executable,
        env: { ...env, PROA_TEST_AUTH: 'project' },
        clock,
      })
      const request = async (
        path: string,
        token: string | undefined,
        method = 'GET',
        body?: string,
      ) => {
        const response = await server!.fetch(`${server!.url}${path}`, {
          method,
          headers: {
            'x-autobuild-version': AUTOBUILD_VERSION,
            'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          ...(body === undefined ? {} : { body }),
        })
        return { status: response.status, body: await response.json() }
      }
      assert.deepEqual(await request('/builds', undefined), {
        status: 401,
        body: { kind: 'auth', error: 'missing bearer credential' },
      })
      assert.deepEqual(await request('/builds', 'abp_1_invalid'), {
        status: 401,
        body: { kind: 'auth', error: 'unknown or revoked credential' },
      })
      const first = await request(
        '/builds',
        owner.token,
        'POST',
        JSON.stringify({ slug: 'requested', repo: a, branch: 'untrusted-branch' }),
      )
      const second = await request(
        '/builds',
        other.token,
        'POST',
        JSON.stringify({ slug: 'requested', repo: b }),
      )
      assert.equal(first.status, 201)
      assert.equal(second.status, 201)
      assert.notEqual(first.body.slug, 'requested')
      assert.notEqual(first.body.slug, second.body.slug)
      assert.equal(first.body.branch, `ab/${first.body.slug}`)
      assert.deepEqual(await request('/builds', owner.token), { status: 200, body: [first.body] })
      assert.deepEqual(await request('/builds', other.token), { status: 200, body: [second.body] })
      const foreign = await request(`/builds/${second.body.slug}`, owner.token)
      assert.deepEqual(foreign, {
        status: 404,
        body: {
          kind: 'not-found',
          error: 'resource unavailable: unknown resource or wrong project',
        },
      })
      assert.deepEqual(await request('/builds/not-a-real-build', owner.token), foreign)
      assert.deepEqual(
        await request(`/builds/${second.body.slug}/events`, owner.token, 'POST', '{'),
        foreign,
      )
      assert.deepEqual(
        await request(`/repos/${encodeURIComponent(b)}/events`, owner.token, 'POST', '{'),
        { status: 403, body: { kind: 'auth', error: 'wrong project' } },
      )
      // TypeScript fixture setup isolates the indirect session ownership check;
      // this is not a substitute method in the unchanged BuildStore contract.
      fixtures = await openPostgresBuildStoreFromEnv(env)
      const session = await fixtures.createSession({ repo: b, operator: 'fixture' })
      assert.deepEqual(
        await request(`/sessions/${session.id}/events`, owner.token, 'POST', '{'),
        foreign,
      )
      await sql`UPDATE project_credentials SET expires_at = ${baseline} WHERE id = ${owner.credential.id}`
      assert.deepEqual(await request('/builds', owner.token), {
        status: 401,
        body: { kind: 'auth', error: 'unknown or revoked credential' },
      })
      await sql`UPDATE project_credentials SET expires_at = NULL WHERE id = ${owner.credential.id}`
      assert.equal((await request('/builds', owner.token)).status, 200)
      await credentials.revoke(a, owner.credential.id, 'proof')
      assert.deepEqual(await request('/builds', owner.token), {
        status: 401,
        body: { kind: 'auth', error: 'unknown or revoked credential' },
      })
      await projects.remove(b, 'proof')
      assert.deepEqual(await request('/builds', other.token), {
        status: 403,
        body: { kind: 'auth', error: 'project not registered' },
      })
      await server.close()
      server = await startProtocolServer({
        executable,
        env: { ...env, PROA_TEST_AUTH: 'project' },
        clock,
      })
      assert.equal((await request('/builds', owner.token)).status, 401)
      assert.equal((await request('/builds', other.token)).status, 403)
    } finally {
      try {
        await server?.close()
      } finally {
        try {
          await fixtures?.close()
        } finally {
          await sql.close()
        }
      }
    }
  })
  console.log(
    'Credential HTTP proof passed: project filtering, authoritative build identities, indirect ownership before body parsing, immediate expiry/revocation/removal and restart continuity.',
  )
}
