/** Signed-token/issuance proof over real Rust HTTP and shared PostgreSQL facts.
 * Raw credentials/tokens stay in memory; returned evidence contains counts only. */
import { strict as assert } from 'node:assert'
import { isDeepStrictEqual } from 'node:util'
import { SQL } from 'bun'
import { connect } from 'node:net'
import { sampleEventWrite } from '../../../packages/core/src/store/contract'
import {
  mintToken,
  verifyToken,
  type DelegatedTokenScope,
} from '../../../packages/core/src/store/remote/token'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import { createMachineAuth } from '../../../packages/hosted-store-service/src/machine-auth'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'

async function rawAuthorizationRequest(
  url: string,
  path: string,
  authorization: Uint8Array,
  extraHeaders: readonly { name: string; value: Uint8Array }[] = [],
): Promise<{ status: number; body: unknown }> {
  const target = new URL(url)
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const socket = connect({ host: '127.0.0.1', port: Number(target.port) }, () =>
      socket.write(
        Buffer.concat([
          Buffer.from(
            `GET ${path} HTTP/1.1\r\nHost: localhost\r\nx-autobuild-version: ${AUTOBUILD_VERSION}\r\nx-autobuild-protocol-version: ${REMOTE_STORE_PROTOCOL_VERSION}\r\nAuthorization: `,
          ),
          Buffer.from(authorization),
          ...extraHeaders.flatMap((header) => [
            Buffer.from(`\r\n${header.name}: `),
            Buffer.from(header.value),
          ]),
          Buffer.from('\r\nConnection: close\r\n\r\n'),
        ]),
      ),
    )
    socket.setTimeout(10000, () => socket.destroy(new Error('Raw authorization probe timed out')))
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      size += chunk.length
      if (size > 65536) {
        socket.destroy(new Error('Raw authorization response exceeded bound'))
        return
      }
      chunks.push(chunk)
    })
    socket.on('end', () => {
      try {
        const data = Buffer.concat(chunks),
          boundary = data.indexOf('\r\n\r\n')
        assert.ok(boundary >= 0)
        const head = data.subarray(0, boundary).toString('latin1')
        let body = data.subarray(boundary + 4)
        if (/transfer-encoding:\s*chunked/i.test(head)) {
          const decoded: Buffer[] = []
          let position = 0
          while (position < body.length) {
            const line = body.indexOf('\r\n', position)
            assert.ok(line >= position)
            const length = Number.parseInt(body.subarray(position, line).toString('ascii'), 16)
            position = line + 2
            if (length === 0) break
            decoded.push(body.subarray(position, position + length))
            position += length + 2
          }
          body = Buffer.concat(decoded)
        }
        resolve({ status: Number(head.split(' ')[1]), body: JSON.parse(body.toString('utf8')) })
      } catch (error) {
        reject(error)
      }
    })
  })
}

export async function proveProtocolDelegation(executable: string) {
  const checks: string[] = []
  let comparisons = 0
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (env) => {
      let time = Date.parse('2030-01-01T00:00:00.000Z')
      const clock = () => new Date(time),
        secret = 'isolated-native-delegation-proof'
      const ts = await openPostgresBuildStoreFromEnv(env, { clock }),
        sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 })
      const projects = new PostgresProjectRegistry(sql),
        credentials = new PostgresCredentialStore(sql, projects)
      const repo = (await projects.add('https://github.com/proa/delegation-proof', 'proof')).repo
      const foreign = (await projects.add('https://github.com/proa/delegation-foreign', 'proof'))
        .repo
      const owner = await credentials.issue(repo, 'owner', { expiresAt: new Date(time + 86400000) })
      const dispatcher = await credentials.issue(repo, 'dispatcher', { purpose: 'dispatcher' })
      const running: Awaited<ReturnType<typeof startProtocolServer>>[] = []
      let failure: unknown
      const discrepancies: unknown[] = []
      const equal = (actual: unknown, expected: unknown, message: string) => {
        try {
          // Issuance replies contain live fixture credentials. Never let an
          // assertion dump either side into persisted subprocess diagnostics.
          assert.equal(isDeepStrictEqual(actual, expected), true, message)
        } catch (error) {
          discrepancies.push(error)
        }
      }
      const start = async (key: string | null = secret) => {
        const server = await startProtocolServer({
          executable,
          env: { ...env, PROA_TEST_AUTH: 'project', PROA_TEST_SECRET: key ?? undefined },
          clock,
        })
        running.push(server)
        return server
      }
      const oracle = (key: string | null = secret) =>
        createStoreServer({
          store: ts,
          clock,
          ...(key === null ? {} : { secret: key }),
          auth: createMachineAuth({
            secret: key ?? secret,
            credentials,
            projects,
            store: ts,
            clock,
          }),
        })
      const headers = {
        'content-type': 'application/json',
        'x-autobuild-version': AUTOBUILD_VERSION,
        'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
      }
      try {
        for (const [slug, owningRepo] of [
          ['grant-one', repo],
          ['grant-two', repo],
          ['grant-foreign', foreign],
        ] as const) {
          await ts.createBuild({ slug, repo: owningRepo })
          await ts.append(slug, sampleEventWrite())
        }
        await ts.ensureRepo(repo)
        const native = await start(),
          expected = oracle()
        const compare = async (
          path: string,
          token: string | undefined,
          method = 'GET',
          body?: unknown,
          server = native,
          service = expected,
          raw = false,
        ) => {
          const init = {
            method,
            headers: {
              ...headers,
              ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
            },
            ...(body === undefined ? {} : { body: raw ? String(body) : JSON.stringify(body) }),
          }
          const [a, b] = await Promise.all([
            server.fetch(`${server.url}${path}`, init),
            service.fetch(new Request(`http://oracle${path}`, init)),
          ])
          const actual = { status: a.status, body: await a.json() },
            oracle = { status: b.status, body: await b.json() }
          equal(actual, oracle, `${method} ${path}`)
          comparisons++
          return actual as { status: number; body: unknown }
        }
        const issue = async (token: string, target: unknown) => {
          const response = await compare('/credentials/delegate', token, 'POST', target)
          assert.equal(response.status, 200)
          const grant = (response.body as Record<string, unknown>).token as string
          assert.ok(grant)
          const scope = verifyToken(secret, grant, clock())
          assert.ok(
            scope && 'delegation' in scope,
            'Native-issued grant verifies with unchanged TS function',
          )
          return { token: grant, scope: scope as DelegatedTokenScope }
        }
        const runner = await issue(owner.token, { kind: 'build-runner', id: 'grant-one' })
        assert.deepEqual(runner.scope, {
          version: 2,
          delegation: { repo, kind: 'build-runner', id: 'grant-one', anchor: 1 },
        })
        await compare('/builds/grant-two', runner.token)
        await compare('/builds/grant-one', mintToken(secret, runner.scope))
        await issue(dispatcher.token, { kind: 'build-runner', id: 'grant-one' })
        const wireOracle = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          fetch: (request) => expected.fetch(request),
        })
        try {
          for (const token of [owner.token, runner.token])
            for (const separator of [[32], [9], [160], [194, 160]]) {
              const header = Buffer.concat([
                Buffer.from('Bearer'),
                Buffer.from(separator),
                Buffer.from(token),
              ])
              const [actual, reference] = await Promise.all([
                rawAuthorizationRequest(native.url, '/builds/grant-one', header),
                rawAuthorizationRequest(wireOracle.url.toString(), '/builds/grant-one', header),
              ])
              equal(actual, reference, `Authorization separator bytes ${separator.join(',')}`)
              equal(
                actual.status,
                separator[0] === 194 ? 401 : 200,
                'Expected authorization separator gate',
              )
              comparisons++
            }
          for (const token of [owner.token, runner.token]) {
            const header = Buffer.from(`Bearer ${token}`),
              extra = [{ name: 'Authorization', value: header }]
            const [actual, reference] = await Promise.all([
              rawAuthorizationRequest(native.url, '/builds/grant-one', header, extra),
              rawAuthorizationRequest(
                wireOracle.url.toString(),
                '/builds/grant-one',
                header,
                extra,
              ),
            ])
            equal(
              actual,
              reference,
              'Duplicate Authorization fields merge before bearer verification',
            )
            equal(actual.status, 401, 'Expected duplicate authorization refusal')
            comparisons++
          }
          for (const name of ['x-autobuild-version', 'x-autobuild-protocol-version']) {
            const header = Buffer.from(`Bearer ${owner.token}`),
              extra = [{ name, value: Buffer.from('unsupported-duplicate') }]
            const [actual, reference] = await Promise.all([
              rawAuthorizationRequest(native.url, '/builds/grant-one', header, extra),
              rawAuthorizationRequest(
                wireOracle.url.toString(),
                '/builds/grant-one',
                header,
                extra,
              ),
            ])
            equal(actual, reference, 'Duplicate identity fields merge before negotiation')
            equal(actual.status, 409, 'Expected duplicate identity refusal')
            comparisons++
          }
        } finally {
          await wireOracle.stop(true)
        }
        checks.push(
          'raw HTTP authorization bytes use Fetch Latin1 semantics; duplicate authority/identity fields merge before validation',
        )
        checks.push(
          'native-issued grants verify in TS with exact minted bytes; TS-minted grants authenticate in Rust; both project purposes can issue',
        )
        for (const [token, body] of [
          [owner.token, { kind: 'build-runner', id: 'missing' }],
          [owner.token, { kind: 'build-runner', id: 'grant-foreign' }],
          [owner.token, { kind: 'build-phase', id: 'grant-one', session: 'missing' }],
          [owner.token, { kind: 'build-runner', id: 'grant-one', extra: true }],
          [runner.token, { kind: 'build-runner', id: 'grant-two' }],
        ] as const)
          await compare('/credentials/delegate', token, 'POST', body)
        await compare('/credentials/delegate', owner.token, 'POST', '{', native, expected, true)
        await compare('/credentials/delegate', undefined, 'POST', '{', native, expected, true)
        await ts.append('grant-one', {
          actor: { kind: 'kernel' },
          type: 'session.started',
          payload: {
            session: 'phase-one',
            role: 'implement',
            runner: 'scripted',
            phase: 'implement',
            round: 1,
          },
        })
        const phase = await issue(runner.token, {
          kind: 'build-phase',
          id: 'grant-one',
          session: 'phase-one',
        })
        assert.equal(phase.scope.delegation.anchor, 2)
        assert.equal(phase.scope.delegation.session, 'phase-one')
        await compare('/credentials/delegate', phase.token, 'POST', {
          kind: 'build-phase',
          id: 'grant-one',
          session: 'phase-one',
        })
        await compare('/builds/grant-one/events', phase.token, 'POST', sampleEventWrite())
        const phaseWrite = {
          ...sampleEventWrite(),
          actor: { kind: 'agent', role: 'implement', session: 'phase-one' },
        }
        const accepted = await native.fetch(`${native.url}/builds/grant-one/events`, {
          method: 'POST',
          headers: { ...headers, authorization: `Bearer ${phase.token}` },
          body: JSON.stringify(phaseWrite),
        })
        assert.equal(accepted.status, 201)
        assert.equal((await ts.getEvents('grant-one')).at(-1)!.actor.kind, 'agent')
        checks.push(
          'runner attenuation binds earliest own session; malformed/foreign targets and phase delegation/attribution fail before event validation',
        )

        await ts.claimRepoLease(repo, 'harvest-holder', 60000)
        await ts.appendRepo(repo, {
          actor: { kind: 'kernel' },
          type: 'harvest.started',
          payload: {
            run: 'harvest-one',
            observations: [{ build: 'grant-one', seq: 1 }],
            scan: { kind: 'harvest-scan', rev: 0 },
          },
        })
        const authorization = await ts.appendRepo(repo, {
          actor: { kind: 'dispatcher' },
          type: 'harvest.execution.authorized',
          payload: {
            run: 'harvest-one',
            execution: 'exec-one',
            launch: 'started',
            leaseHolder: 'harvest-holder',
          },
        })
        const harvest = await issue(owner.token, {
          kind: 'harvest-runner',
          repo,
          id: 'harvest-one',
          execution: 'exec-one',
          leaseHolder: 'harvest-holder',
        })
        assert.equal(harvest.scope.delegation.anchor, authorization.seq)
        await ts.appendRepo(repo, {
          actor: { kind: 'kernel' },
          type: 'harvest.session.started',
          payload: {
            run: 'harvest-one',
            session: 'harvest-phase',
            role: 'harvest',
            runner: 'scripted',
            step: 'synthesize',
            round: 1,
          },
        })
        const harvestPhase = await issue(harvest.token, {
          kind: 'harvest-phase',
          repo,
          id: 'harvest-one',
          session: 'harvest-phase',
        })
        assert.equal(harvestPhase.scope.delegation.execution, 'exec-one')
        await compare('/credentials/delegate', owner.token, 'POST', {
          kind: 'harvest-phase',
          repo,
          id: 'harvest-one',
          session: 'harvest-phase',
        })
        await compare('/credentials/delegate', owner.token, 'POST', {
          kind: 'harvest-runner',
          repo,
          id: 'harvest-one',
          execution: 'exec-one',
          leaseHolder: 'not-holder',
        })
        checks.push(
          'harvest issuance binds authorized execution and exact current holder; runner-to-phase inherits execution without widening target schema',
        )

        const admin = mintToken(secret, {
          version: 1,
          ownerAdmin: { user: ' owner ' },
          exp: time + 86400000,
        })
        const internal = mintToken(secret, {
          version: 1,
          internalOperator: { user: ' operator ', repo },
          exp: time + 86400000,
        })
        await compare('/builds', admin)
        await compare('/builds/grant-one', internal)
        await compare('/credentials/delegate', internal, 'POST', {
          kind: 'build-runner',
          id: 'grant-one',
        })
        for (const token of [
          'bad-signed-token',
          'abp_not_a_credential',
          mintToken('wrong', runner.scope),
          mintToken(secret, { build: '*', session: 'legacy', exp: time + 86400000 }),
          mintToken(secret, {
            resource: { kind: 'repo', id: repo },
            session: 'legacy',
            exp: time + 86400000,
          }),
          mintToken(secret, { version: 1, ownerAdmin: { user: 'owner' }, exp: time }),
        ])
          await compare('/builds/grant-one', token)
        const [payload, signature] = runner.token.split('.') as [string, string]
        for (const token of [
          `${payload}.${signature}=ignored`,
          `${payload}.!${signature}?`,
          `${payload}.${signature.replaceAll('-', '+').replaceAll('_', '/')}`,
        ])
          await compare('/builds/grant-one', token)
        checks.push(
          'existing admin/internal scopes and retired/invalid/expired signatures retain exact authority/refusal; permissive signature decoding matches Node',
        )

        const unavailable = await start(null),
          unavailableOracle = oracle(null)
        await compare(
          '/credentials/delegate',
          undefined,
          'POST',
          '{',
          unavailable,
          unavailableOracle,
          true,
        )
        const empty = await start(''),
          emptyOracle = oracle('')
        await compare('/credentials/delegate', undefined, 'POST', '{', empty, emptyOracle, true)
        const rotated = await start('rotated-key'),
          rotatedOracle = oracle('rotated-key')
        await compare('/builds/grant-one', runner.token, 'GET', undefined, rotated, rotatedOracle)
        checks.push(
          'issuance unavailability precedes body/auth without nonempty secret; current-key rotation immediately refuses old signatures',
        )

        const expiringOwner = await credentials.issue(repo, 'expiring-owner', {
          expiresAt: new Date(time + 86400000),
        })
        const expiryChild = await issue(expiringOwner.token, {
          kind: 'build-runner',
          id: 'grant-two',
        })
        await credentials.revoke(repo, owner.credential.id, 'proof')
        await compare('/builds/grant-one', owner.token)
        await compare('/builds/grant-one', runner.token)
        await projects.remove(repo, 'proof')
        await compare('/builds/grant-one', runner.token)
        await compare('/credentials/delegate', internal, 'POST', {
          kind: 'build-runner',
          id: 'grant-one',
        })
        await projects.add(repo, 'proof')
        time += 2 * 86400000
        await compare('/builds/grant-two', expiringOwner.token)
        await compare('/builds/grant-two', expiryChild.token)
        await compare('/builds/grant-one', runner.token)
        const restarted = await start()
        await compare('/builds/grant-one', runner.token, 'GET', undefined, restarted)
        await compare(`/repos/${encodeURIComponent(repo)}/events`, harvest.token)
        checks.push(
          'grant authority survives parent revocation/expiry, lease expiry and service restart; registration removal/re-add is observed on the next request',
        )

        await ts.append('grant-one', {
          actor: { kind: 'kernel' },
          type: 'session.ended',
          payload: {
            session: 'phase-one',
            transcript: { kind: 'transcript', rev: 0 },
            usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
          },
        })
        time += 59999
        await compare('/builds/grant-one', phase.token)
        time++
        await compare('/builds/grant-one', phase.token)
        await compare('/builds/grant-one', runner.token)
        await ts.append('grant-one', {
          actor: { kind: 'kernel' },
          type: 'build.aborted',
          payload: {},
        })
        time += 59999
        await compare('/builds/grant-one', runner.token)
        time++
        await compare('/builds/grant-one', runner.token)
        await ts.appendRepo(repo, {
          actor: { kind: 'kernel' },
          type: 'harvest.session.suspended',
          payload: {
            run: 'harvest-one',
            session: 'harvest-phase',
            cause: 'shutdown',
            transcript: { kind: 'harvest-transcript', rev: 0 },
          },
        })
        await compare(`/repos/${encodeURIComponent(repo)}/events`, harvestPhase.token)
        await compare(`/repos/${encodeURIComponent(repo)}/events`, harvest.token)
        await ts.appendRepo(repo, {
          actor: { kind: 'dispatcher' },
          type: 'harvest.execution.ended',
          payload: { run: 'harvest-one', execution: 'exec-one' },
        })
        time += 59999
        await compare(`/repos/${encodeURIComponent(repo)}/events`, harvest.token)
        time++
        await compare(`/repos/${encodeURIComponent(repo)}/events`, harvest.token)
        checks.push(
          'fresh session/build/execution terminal facts apply exact60-second grace; harvest suspension retires phase immediately without retiring runner',
        )
        if (discrepancies.length)
          throw new AggregateError(discrepancies, 'Delegation HTTP parity mismatches')
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
