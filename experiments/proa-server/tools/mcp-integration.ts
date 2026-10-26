/** Real OAuth endpoints and SDK transport over an isolated migrated database. */
import { strict as assert } from 'node:assert'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SQL } from 'bun'
import { createHash } from 'node:crypto'
import { validateEventWrite } from '../../../packages/core/src/events/catalog'
import { reduceBuild } from '../../../packages/core/src/kernel/reducer'
import { refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  registerClient,
  startAuthorization,
  exchangeAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { buildConnectServer } from './connect-integration'
import { checkMcpCorpus, generateMcpCorpus, seedMcpControl } from './mcp-fixtures'
import { mcpRepo as operatorRepo } from './mcp-fixtures'

const project = resolve(import.meta.dir, '..')
export async function withMcpServer<T>(
  work: (server: {
    origin: string
    sql: SQL
    store: Awaited<ReturnType<typeof openPostgresBuildStoreFromEnv>>
    session: () => Promise<string>
    restart: (allowed?: string) => Promise<void>
  }) => Promise<T>,
) {
  return withDataServices(async (admin, env) => {
    const executable = await buildConnectServer(env)
    return withProtocolDatabase(admin, env, async (env) => {
      const sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 })
      const store = await openPostgresBuildStoreFromEnv(env)
      const runtime = await mkdtemp(join(tmpdir(), 'proa-mcp-'))
      const reserved = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () => new Response(),
      })
      const port = reserved.port!
      reserved.stop(true)
      const origin = `http://127.0.0.1:${port}`
      const capability = randomBytes(32).toString('hex')
      const serverEnv = {
        ...env,
        PROA_HOST: '127.0.0.1',
        PORT: String(port),
        PROA_AUTH_URL: origin,
        GITHUB_CLIENT_ID: 'mcp-proof',
        GITHUB_CLIENT_SECRET: randomBytes(32).toString('hex'),
        PROA_SESSION_SECRET: randomBytes(32).toString('hex'),
        AB_STORE_SECRET: randomBytes(32).toString('hex'),
        PROA_ENV: 'development',
        PROA_DEV_AUTH: 'true',
        PROA_DEV_AUTH_EMAIL: 'operator@example.com',
        PROA_DEV_AUTH_CAPABILITY: capability,
        AB_WEB_SUPER_USER_EMAILS: 'operator@example.com',
      }
      let child: ReturnType<typeof Bun.spawn> | undefined
      async function stop() {
        if (child) {
          child.kill()
          await child.exited
          child = undefined
        }
      }
      async function restart(allowed = 'operator@example.com') {
        await stop()
        serverEnv.AB_WEB_SUPER_USER_EMAILS = allowed
        child = Bun.spawn([executable], {
          cwd: runtime,
          env: serverEnv,
          stdout: Bun.file(join(runtime, 'server.log')),
          stderr: Bun.file(join(runtime, 'errors.log')),
        })
        for (let i = 0; i < 200; i++) {
          if (child.exitCode !== null) throw Error('MCP server exited before readiness')
          try {
            if ((await fetch(`${origin}/readyz`)).ok) return
          } catch {}
          await Bun.sleep(50)
        }
        throw Error('MCP readiness timeout')
      }
      async function session() {
        const response = await fetch(`${origin}/auth/dev-session`, {
          method: 'POST',
          headers: { 'x-proa-dev-capability': capability },
          redirect: 'manual',
        })
        assert.equal(response.status, 303)
        const cookie = response.headers
          .getSetCookie()
          .find((c) => c.startsWith('proa-session=') && !c.includes('Max-Age=0'))
          ?.split(';')[0]
        assert.ok(cookie)
        return cookie
      }
      try {
        await symlink(join(project, 'public'), join(runtime, 'public'))
        await sql.unsafe(await Bun.file(join(project, 'migrations/001-oauth.sql')).text())
        await new PostgresProjectRegistry(sql).add(operatorRepo, 'mcp-proof')
        await restart()
        return await work({ origin, sql, store, session, restart })
      } finally {
        await stop()
        await store.close()
        await sql.close()
        await rm(runtime, { recursive: true, force: true })
      }
    })
  })
}
export async function oauthFlow(
  origin: string,
  cookie: string,
  clientName = 'offline-mcp-client',
  accept = true,
  prompt = true,
  options: {
    audit?: (
      stage: 'consent' | 'code',
      fields: Record<string, string>,
    ) => Promise<OAuthTokens | void>
    authMethod?: 'none' | 'client_secret_basic' | 'client_secret_post'
    resume?: boolean
    omitResource?: boolean
  } = {},
) {
  const metadataResponse = await fetch(`${origin}/.well-known/oauth-authorization-server`)
  assert.equal(metadataResponse.status, 200)
  const metadata = await metadataResponse.json()
  const protectedResource = await (
    await fetch(`${origin}/.well-known/oauth-protected-resource`)
  ).json()
  assert.equal(protectedResource.resource, `${origin}/mcp`)
  const registered = await registerClient(origin, {
    metadata,
    clientMetadata: {
      client_name: clientName,
      redirect_uris: ['http://127.0.0.1:8765/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: options.authMethod ?? 'none',
    },
  })
  const { authorizationUrl, codeVerifier } = await startAuthorization(origin, {
    metadata,
    clientInformation: registered,
    redirectUrl: 'http://127.0.0.1:8765/callback',
    scope: 'openid profile email offline_access',
    state: 'proof-state',
  })
  if (!options.omitResource) authorizationUrl.searchParams.set('resource', `${origin}/mcp`)
  if (prompt) authorizationUrl.searchParams.set('prompt', 'consent')
  else authorizationUrl.searchParams.delete('prompt')
  if (options.omitResource) authorizationUrl.searchParams.delete('resource')
  const signedOut = await fetch(authorizationUrl, { redirect: 'manual' })
  assert.equal(signedOut.status, 302)
  assert.ok(signedOut.headers.get('location')?.startsWith('/sign-in?returnTo='))
  const continuation = new URL(signedOut.headers.get('location')!, origin).searchParams.get(
    'returnTo',
  )!
  const authorized = await fetch(
    options.resume ? new URL(continuation, origin) : authorizationUrl,
    {
      headers: { cookie },
      redirect: 'manual',
    },
  )
  assert.equal(authorized.status, 302)
  let callback = authorized.headers.get('location')!
  if (prompt) {
    const consent = new URL(callback, origin)
    assert.equal(consent.pathname, '/oauth/consent')
    const page = await fetch(consent, { headers: { cookie } })
    assert.ok((await page.text()).includes(clientName))
    await options.audit?.('consent', {
      consent_code: consent.searchParams.get('consent_code')!,
      client_id: registered.client_id,
    })
    const decision = await fetch(`${origin}/api/auth/oauth2/consent`, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        accept,
        consent_code: consent.searchParams.get('consent_code'),
      }),
    })
    assert.equal(decision.status, 200)
    callback = (await decision.json()).redirectURI
  }
  if (!accept) {
    assert.equal(new URL(callback).searchParams.get('error'), 'access_denied')
    return { registered, metadata, denied: true as const }
  }
  const code = new URL(callback).searchParams.get('code')!
  const audited = await options.audit?.('code', {
    grant_type: 'authorization_code',
    client_id: registered.client_id,
    code,
    code_verifier: codeVerifier,
    redirect_uri: 'http://127.0.0.1:8765/callback',
    resource: `${origin}/mcp`,
  })
  const tokens =
    audited ??
    (await exchangeAuthorization(origin, {
      metadata,
      clientInformation: registered,
      authorizationCode: code,
      codeVerifier,
      redirectUri: 'http://127.0.0.1:8765/callback',
      resource: new URL(`${origin}/mcp`),
    }))
  assert.ok(tokens.access_token)
  assert.ok(tokens.refresh_token)
  return {
    registered,
    metadata,
    tokens,
    code,
    codeVerifier,
    denied: false as const,
  }
}
export async function mcpIntegration() {
  await checkMcpCorpus()
  return withMcpServer(async (server) => {
    const { origin } = server
    const cookie = await server.session()
    const tokenRequest = (fields: Record<string, string>) =>
      fetch(`${origin}/api/auth/mcp/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields),
      })
    const flow = await oauthFlow(origin, cookie, undefined, true, true, {
      resume: true,
      audit: async (stage, fields) => {
        if (stage === 'consent') {
          for (const [headers, status] of [
            [{ 'content-type': 'application/json' }, 401],
            [
              { cookie, origin: 'https://foreign.invalid', 'content-type': 'application/json' },
              403,
            ],
          ] as const) {
            assert.equal(
              (
                await fetch(`${origin}/api/auth/oauth2/consent`, {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({ accept: true, consent_code: fields.consent_code }),
                })
              ).status,
              status,
            )
          }
          const invalid = await fetch(`${origin}/oauth/consent`, {
            method: 'POST',
            headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              decision: 'accept',
              consent_code: fields.consent_code!,
              csrf: 'wrong',
            }),
          })
          assert.equal(invalid.status, 403)
        } else {
          for (const [change, expected] of [
            [{ resource: 'https://other.invalid/mcp' }, 'invalid_target'],
            [{ code_verifier: 'x'.repeat(43) }, 'invalid_grant'],
            [{ redirect_uri: 'http://127.0.0.1:8765/foreign' }, 'invalid_grant'],
            [{ client_id: 'unknown-client' }, 'invalid_client'],
          ] as const) {
            const response = await tokenRequest({ ...fields, ...change })
            assert.equal(response.status, 400)
            assert.equal((await response.json()).error, expected)
            assert.equal(response.headers.get('cache-control'), 'no-store')
          }
        }
      },
    })
    assert.ok((await oauthFlow(origin, cookie, 'denial', false)).denied)
    assert.ok(
      !(
        await oauthFlow(origin, cookie, 'no-prompt', true, false, {
          resume: true,
          omitResource: true,
        })
      ).denied,
    )
    for (const authMethod of ['client_secret_basic', 'client_secret_post'] as const)
      assert.ok(!(await oauthFlow(origin, cookie, authMethod, true, true, { authMethod })).denied)
    await oauthFlow(origin, cookie, 'code-race', true, true, {
      audit: async (stage, fields) => {
        if (stage === 'code') {
          const responses = await Promise.all([tokenRequest(fields), tokenRequest(fields)])
          assert.deepEqual(
            responses.map((r) => r.status).sort(),
            [200, 400],
            'one authorization code winner',
          )
          return (await responses.find((r) => r.status === 200)!.json()) as OAuthTokens
        }
      },
    })
    assert.ok(!flow.denied)
    const headers = { authorization: `Bearer ${flow.tokens.access_token}` }
    const client = new Client({ name: 'proa-sdk-proof', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers },
      }),
    )
    try {
      const corpus = await generateMcpCorpus()
      assert.deepEqual((await client.listTools()).tools, corpus.tools)
      for (const observation of corpus.observations) {
        const r = observation.request
        if (r.seed) await seedMcpControl(server.store)
        const response = await fetch(`${origin}/mcp`, {
          method: r.method ?? 'POST',
          headers: {
            'content-type': r.contentType ?? 'application/json',
            ...(r.protocol ? { 'mcp-protocol-version': r.protocol } : {}),
            accept: r.accept ?? 'application/json, text/event-stream',
            ...(r.authenticated === false ? {} : headers),
          },
          ...(['GET', 'OPTIONS', 'DELETE'].includes(r.method ?? '')
            ? {}
            : { body: r.rawBody ?? JSON.stringify(r.body ?? {}) }),
        })
        assert.equal(response.status, observation.status, r.label)
        const sse = response.headers.get('content-type')?.startsWith('text/event-stream')
        if (sse) await response.body?.cancel()
        const text = sse ? '' : await response.text()
        const actual = text ? JSON.parse(text) : null
        if (r.label === 'unauthenticated') {
          assert.equal(
            response.headers.get('www-authenticate'),
            `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
          )
        } else if (
          [
            'repository.settings-dispatch',
            'harvest.control-dispatch',
            'builds.control-positive',
          ].includes(r.label)
        ) {
          const value = JSON.parse(actual.result.content[0].text)
          const expected = JSON.parse(
            (observation.body as { result: { content: { text: string }[] } }).result.content[0]!
              .text,
          )
          const events =
            r.label === 'builds.control-positive'
              ? await server.store.getEvents('mcp-control-build')
              : await server.store.getRepoEvents(operatorRepo)
          if (r.label === 'builds.control-positive') {
            events.forEach((e) => {
              validateEventWrite(e)
            })
            reduceBuild(events as never)
          }
          assert.deepEqual(value.event, events.at(-1))
          assert.deepEqual(value.event.actor, {
            kind: 'human',
            user: 'operator@example.com',
            via: { kind: 'mcp', client: 'offline-mcp-client' },
          })
          value.event.ts = expected.event.ts
          assert.deepEqual(value, expected)
        } else if (
          r.label.startsWith('notes.') &&
          (r.label.endsWith('-success') || r.label.endsWith('-dispatch'))
        ) {
          const value = JSON.parse(actual.result.content[0].text)
          const expected = JSON.parse(
            (observation.body as { result: { content: { text: string }[] } }).result.content[0]!
              .text,
          )
          const note =
            value.createdAt || value.metadata?.createdAt
              ? await server.store.getRepoArtifact(operatorRepo, 'operator-notes')
              : null
          if (value.createdAt) {
            assert.equal(value.createdAt, note!.meta.createdAt)
            value.createdAt = expected.createdAt
          }
          if (value.metadata?.createdAt) {
            assert.equal(value.metadata.createdAt, note!.meta.createdAt)
            value.metadata.createdAt = expected.metadata.createdAt
          }
          assert.deepEqual(value, expected, r.label)
        } else assert.deepEqual(actual, observation.body, r.label)
      }
      await client.close()
      await server.restart()
      assert.equal(
        (await fetch(`${origin}/mcp`, { method: 'DELETE', headers })).status,
        200,
        'tokens survive restart',
      )
      const expiredKey = createHash('sha256').update(flow.tokens.access_token).digest('base64url')
      await server.sql`UPDATE proa_oauth.state SET document=jsonb_set(document,${['access', expiredKey, 'expires']},'0'::jsonb) WHERE singleton=true`
      assert.equal((await fetch(`${origin}/mcp`, { method: 'DELETE', headers })).status, 401)
      flow.tokens = await refreshAuthorization(origin, {
        metadata: flow.metadata,
        clientInformation: flow.registered,
        refreshToken: flow.tokens.refresh_token!,
        resource: new URL(`${origin}/mcp`),
      })
      assert.equal(
        (
          await fetch(`${origin}/mcp`, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${flow.tokens.access_token}` },
          })
        ).status,
        200,
      )
      const scopeExpansion = await tokenRequest({
        grant_type: 'refresh_token',
        client_id: flow.registered.client_id,
        refresh_token: flow.tokens.refresh_token!,
        scope: 'openid admin',
      })
      assert.equal(scopeExpansion.status, 400)
      assert.equal((await scopeExpansion.json()).error, 'invalid_scope')
      const refresh = () =>
        fetch(`${origin}/api/auth/mcp/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: flow.registered.client_id,
            refresh_token: flow.tokens.refresh_token!,
            resource: `${origin}/mcp`,
          }),
        })
      const rotations = await Promise.all([refresh(), refresh()])
      assert.deepEqual(rotations.map((r) => r.status).sort(), [200, 400], 'one refresh winner')
      const rotated = await rotations.find((r) => r.status === 200)!.json()
      const revokedClient = new Client({ name: 'revocation-proof', version: '1' })
      await revokedClient.connect(
        new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${rotated.access_token}` } },
        }),
      )
      await server.restart('someone-else@example.com')
      try {
        await assert.rejects(() => revokedClient.listTools())
      } finally {
        await revokedClient.close()
      }
      assert.equal(
        (
          await fetch(`${origin}/mcp`, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${rotated.access_token}` },
          })
        ).status,
        403,
      )
      await server.restart()
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const response = await fetch(`${origin}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${rotated.access_token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
        })
        assert.equal(response.status, 200)
        const body = await response.json()
        return { result: JSON.parse(body.result.content[0].text), isError: body.result.isError }
      }
      assert.equal(
        (await fetch(`${origin}/mcp`, { method: 'DELETE', headers: { cookie } })).status,
        401,
        'cookies cannot authorize MCP',
      )
      await server.sql.unsafe('ALTER TABLE project_journal RENAME TO mcp_unavailable_registry')
      try {
        assert.deepEqual(await call('repositories.list'), {
          result: { kind: 'internal', error: 'project registry is unavailable' },
          isError: true,
        })
      } finally {
        await server.sql.unsafe('ALTER TABLE mcp_unavailable_registry RENAME TO project_journal')
      }
      await new PostgresProjectRegistry(server.sql).remove(operatorRepo, 'mcp-proof')
      assert.deepEqual((await call('repositories.list')).result, { repositories: [] })
      assert.deepEqual(await call('builds.list', { repo: operatorRepo }), {
        result: {
          kind: 'validation',
          error: `repository "${operatorRepo}" is not served by this deployment; call repositories.list for the served identities`,
        },
        isError: true,
      })
      return {
        tools: corpus.tools.length,
        cases: corpus.observations.length,
        oauth: true,
        persistence: true,
        refreshRotation: true,
        revocation: true,
      }
    } finally {
      await client.close()
    }
  })
}
if (import.meta.main) console.log(JSON.stringify(await mcpIntegration()))
