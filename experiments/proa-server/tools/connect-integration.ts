/** Unchanged CLI -> normal Rust HTTP -> browser session -> shared credentials. */
import { SQL } from 'bun'
import { strict as assert } from 'node:assert'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { abConnect, abDisconnect } from '../../../packages/core/src/cli/connect'
import { HostedTicketSource } from '../../../packages/core/src/ports/tickets/remote'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { PostgresTicketPolicyStore } from '../../../packages/postgres-store/src/ticket-policy'
import { ProjectCredentials } from '../../../packages/core/src/cli/project-credentials'
import { spawnExec } from '../../../packages/core/src/ports/workspace/git-worktree'
import { RemoteBuildStore } from '../../../packages/core/src/store/remote/client'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { createMachineAuth } from '../../../packages/hosted-store-service/src/machine-auth'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'

const project = resolve(import.meta.dir, '..')
const root = resolve(project, '../..')
export async function buildConnectServer(environment: Record<string, string | undefined>) {
  const child = Bun.spawn(
    ['cargo', 'build', '--locked', '--bin', 'proa-server', '--message-format=json'],
    { cwd: project, env: environment, stdout: 'pipe', stderr: 'inherit' },
  )
  const output = await new Response(child.stdout).text()
  if (await child.exited) throw Error('Normal Rust connect server build failed')
  const executable = output
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find(
      (item) =>
        item.reason === 'compiler-artifact' &&
        item.target?.name === 'proa-server' &&
        item.executable,
    )?.executable
  if (!executable) throw Error('Cargo did not report normal server executable')
  return executable as string
}
export async function connectIntegration(
  admin: string,
  environment: Record<string, string | undefined>,
) {
  const executable = await buildConnectServer(environment)
  return withProtocolDatabase(admin, environment, async (env) => {
    const runtime = await mkdtemp(join(tmpdir(), 'proa-connect-http-'))
    const checkout = join(runtime, 'checkout'),
      userConfig = join(runtime, 'user-config')
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
    const port = reservation.port!
    reservation.stop(true)
    const origin = `http://127.0.0.1:${port}`
    const capability = randomBytes(32).toString('hex'),
      secret = randomBytes(32).toString('hex')
    const actor = 'operator@example.com',
      repo = 'https://github.com/proa/connect-cli'
    const sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 })
    const backing = await openPostgresBuildStoreFromEnv(env)
    const registry = new PostgresProjectRegistry(sql)
    const credentials = new PostgresCredentialStore(sql, registry)
    const oracle = createStoreServer({
      store: backing,
      secret,
      auth: createMachineAuth({ secret, credentials, projects: registry, store: backing }),
    })
    const typescript = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req) => oracle.fetch(req),
    })
    let server: ReturnType<typeof Bun.spawn> | undefined
    let serverEnv = {
      ...env,
      PROA_HOST: '127.0.0.1',
      PORT: String(port),
      PROA_AUTH_URL: origin,
      GITHUB_CLIENT_ID: 'connect-proof',
      GITHUB_CLIENT_SECRET: randomBytes(32).toString('hex'),
      PROA_SESSION_SECRET: randomBytes(32).toString('hex'),
      AB_WEB_ALLOWED_EMAILS: actor,
      AB_STORE_SECRET: secret,
      PROA_ENV: 'development',
      PROA_DEV_AUTH: 'true',
      PROA_DEV_AUTH_EMAIL: actor,
      PROA_DEV_AUTH_CAPABILITY: capability,
    }
    async function stop() {
      if (!server) return
      server.kill()
      await server.exited
      server = undefined
    }
    async function start() {
      server = Bun.spawn([executable], {
        cwd: runtime,
        env: serverEnv,
        stdout: Bun.file(join(runtime, 'server.log')),
        stderr: Bun.file(join(runtime, 'server-errors.log')),
      })
      for (let attempt = 0; attempt < 200; attempt++) {
        if (server.exitCode !== null) throw Error('Normal connect server exited before ready')
        try {
          if ((await fetch(`${origin}/readyz`)).ok) return
        } catch {}
        await Bun.sleep(50)
      }
      throw Error('Normal connect server readiness timed out')
    }
    async function session() {
      const result = await fetch(`${origin}/auth/dev-session`, {
        method: 'POST',
        headers: { 'x-proa-dev-capability': capability },
        redirect: 'manual',
      })
      assert.equal(result.status, 303)
      const cookie = result.headers
        .getSetCookie()
        .find((value) => value.startsWith('proa-session=') && !value.includes('Max-Age=0'))
        ?.split(';')[0]
      assert.ok(cookie)
      return cookie
    }
    async function api(path: string, body: unknown, cookie?: string, requestOrigin = origin) {
      return fetch(origin + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: requestOrigin,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
        redirect: 'manual',
      })
    }
    try {
      await mkdir(checkout)
      await symlink(join(project, 'public'), join(runtime, 'public'))
      for (const args of [
        ['git', 'init'],
        ['git', 'remote', 'add', 'origin', repo],
      ]) {
        const result = await spawnExec(args, { cwd: checkout, env })
        assert.equal(result.exitCode, 0)
      }
      const initial = '# preserve user settings\n[tickets]\nsource = "file"\nreadyState = "ready"\n'
      await writeFile(join(checkout, 'autobuild.toml'), initial)
      await start()
      let cookie = await session()
      assert.equal(
        (await api('/connect/v1/browser/lookup', { code: '0123456789' }, undefined)).status,
        401,
      )
      const cross = await api(
        '/connect/v1/browser/lookup',
        { code: '0123456789' },
        cookie,
        'https://foreign.example',
      )
      assert.equal(cross.status, 403)
      assert.deepEqual(await cross.json(), { error: 'cross-origin approval refused' })
      const noSession = await api(
        '/connect/v1/browser/lookup',
        { code: '0123456789' },
        'proa-session=invalid',
      )
      assert.equal(noSession.status, 401)
      assert.deepEqual(await noSession.json(), { error: 'sign in required' })
      for (const [method, contentType, body, status, error] of [
        ['GET', '', undefined, 405, 'method not allowed'],
        ['POST', 'text/plain', '{}', 400, 'application/json required'],
        ['POST', 'application/json', '{', 400, 'invalid JSON'],
        ['POST', 'application/json', 'null', 400, 'invalid request'],
        ['POST', 'application/json', '{}', 404, 'unknown connection route'],
        [
          'POST',
          'application/json',
          '{"code":"A"}',
          400,
          'enter the ten-character connection code',
        ],
        ['POST', 'application/json', ' '.repeat(8193), 413, 'request too large'],
      ] as const) {
        const refused = await fetch(`${origin}/connect/v1/browser/lookup`, {
          method,
          headers: { cookie, origin, 'content-type': contentType },
          ...(body === undefined ? {} : { body }),
          redirect: 'manual',
        })
        assert.equal(refused.status, status)
        assert.deepEqual(await refused.json(), { error })
        assert.equal(refused.headers.get('cache-control'), 'no-store')
        assert.equal(refused.headers.get('referrer-policy'), 'no-referrer')
      }
      const pending = await api('/connect/v1/requests', {
        repo,
        credentialId: randomBytes(16).toString('hex'),
        digest: randomBytes(32).toString('hex'),
      })
      assert.equal(pending.status, 200)
      const request = (await pending.json()) as { code: string; id: string; capability: string }
      const unsigned = await fetch(`${origin}/connect?code=${request.code}`, { redirect: 'manual' })
      assert.equal(unsigned.status, 307)
      assert.ok(unsigned.headers.get('location')?.includes('returnTo='))
      // Process replacement loses admission but not durable requests.
      await stop()
      await start()
      assert.equal(
        (await api('/connect/v1/browser/lookup', { code: request.code }, cookie)).status,
        401,
      )
      cookie = await session()
      const lookup = await api('/connect/v1/browser/lookup', { code: request.code }, cookie)
      assert.equal(
        ((await lookup.json()) as { connection: { id: string } }).connection.id,
        request.id,
      )
      // Real HTML form submitted without a script; neither CSRF nor Origin can be omitted.
      const page = await fetch(`${origin}/connect?code=${request.code}`, { headers: { cookie } })
      assert.equal(page.status, 200)
      const html = await page.text(),
        csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]
      assert.ok(csrf)
      for (const [token, formOrigin] of [
        ['wrong', origin],
        [csrf, 'https://foreign.example'],
      ] as const) {
        const refused = await fetch(`${origin}/connect/decide`, {
          method: 'POST',
          headers: {
            cookie,
            origin: formOrigin,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ csrf: token, code: request.code, decision: 'approve' }),
          redirect: 'manual',
        })
        assert.equal(refused.status, 403)
      }
      const form = await fetch(`${origin}/connect/decide`, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, code: request.code, decision: 'deny' }),
        redirect: 'manual',
      })
      assert.equal(form.status, 200)
      assert.ok((await form.text()).includes('data-connect-denied'))
      const cliEnv = { ...env, XDG_CONFIG_HOME: userConfig }
      const messages: string[] = []
      const options = {
        cwd: checkout,
        env: cliEnv,
        exec: spawnExec,
        print: (message: string) => messages.push(message),
        sleep: async () => {},
        browser: async (url: string) => {
          const code = new URL(url).searchParams.get('code')!
          const approved = await api('/connect/v1/browser/decide', { code, approve: true }, cookie)
          assert.equal(approved.status, 200)
        },
      }
      await abConnect(origin, options)
      const saved = new ProjectCredentials(cliEnv).load(origin, repo)
      assert.ok(saved)
      assert.ok(!new ProjectCredentials(cliEnv).directory.startsWith(`${checkout}/`))
      assert.ok(
        (await readFile(join(checkout, 'autobuild.toml'), 'utf8')).startsWith(
          '# preserve user settings',
        ),
      )
      const rust = new RemoteBuildStore({ url: origin, token: saved.token }),
        ts = new RemoteBuildStore({ url: typescript.url.origin, token: saved.token })
      await rust.ensureRepo(repo)
      assert.ok(await ts.getRepo(repo))
      assert.ok(await rust.getRepo(repo))
      await abConnect(undefined, options)
      assert.ok(messages.some((message) => message.includes('Credential: accepted')))
      // The real subprocess CLI uses the saved credential with no ambient phase tuple.
      const smoke = Bun.spawn(['bun', join(root, 'bin/ab.ts'), 'connect'], {
        cwd: checkout,
        env: cliEnv,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const stdout = await new Response(smoke.stdout).text(),
        stderr = await new Response(smoke.stderr).text()
      assert.equal(await smoke.exited, 0, stderr)
      assert.ok(stdout.includes('Credential: accepted'))
      await abDisconnect(options)
      assert.equal(new ProjectCredentials(cliEnv).load(origin, repo), undefined)
      await assert.rejects(() => rust.getRepo(repo), /unknown or revoked credential/)
      await assert.rejects(() => ts.getRepo(repo), /unknown or revoked credential/)
      const deniedMessages: string[] = []
      await abConnect(origin, {
        ...options,
        print: (message) => deniedMessages.push(message),
        browser: async (url: string) => {
          const denied = await api(
            '/connect/v1/browser/decide',
            { code: new URL(url).searchParams.get('code'), approve: false },
            cookie,
          )
          assert.equal(denied.status, 200)
        },
      })
      assert.ok(
        deniedMessages.some(
          (message) => message === 'Connection denied; local configuration unchanged.',
        ),
      )
      assert.equal(new ProjectCredentials(cliEnv).load(origin, repo), undefined)
      const expiredMessages: string[] = []
      await abConnect(origin, {
        ...options,
        print: (message) => expiredMessages.push(message),
        browser: async (url: string) => {
          const code = new URL(url).searchParams.get('code')!
          await sql`UPDATE project_connections SET expires_at=now()-interval '1 second' WHERE code=${code}`
        },
      })
      assert.ok(expiredMessages.includes('Connection expired; local configuration unchanged.'))
      assert.equal(new ProjectCredentials(cliEnv).load(origin, repo), undefined)
      const cancellation = new AbortController(),
        cancelledMessages: string[] = []
      let cancelledCode: string | undefined
      await abConnect(origin, {
        ...options,
        signal: cancellation.signal,
        print: (message) => cancelledMessages.push(message),
        browser: async (url: string) => {
          cancelledCode = new URL(url).searchParams.get('code')!
          cancellation.abort()
        },
      })
      assert.ok(cancelledMessages.includes('Connection cancelled; local configuration unchanged.'))
      assert.equal(new ProjectCredentials(cliEnv).load(origin, repo), undefined)
      const cancelled =
        await sql`SELECT status FROM project_connections WHERE code=${cancelledCode!}`
      assert.equal(cancelled[0].status, 'denied')
      // A ticket-only connection publishes the repository's complete hosted policy
      // through the unchanged CLI before saving a usable project credential.
      await writeFile(
        join(checkout, 'autobuild.toml'),
        [
          '# preserve hosted ticket settings',
          '[tickets]',
          'source = "hosted"',
          'teamKey = "FLOW"',
          'triageState = "intake"',
          'readyState = "queued"',
          'claimedState = "working"',
          'doneState = "shipped"',
          'createState = "intake"',
          'proposalState = "queued"',
          'readyLabels = ["reviewed"]',
          '',
        ].join('\n'),
      )
      assert.equal(await new PostgresTicketPolicyStore(sql).get(repo), null)
      await abConnect(origin, { ...options, tickets: true })
      const hostedSaved = new ProjectCredentials(cliEnv).load(origin, repo)
      assert.ok(hostedSaved)
      const hostedText = await readFile(join(checkout, 'autobuild.toml'), 'utf8')
      assert.ok(hostedText.startsWith('# preserve hosted ticket settings'))
      assert.ok(hostedText.includes(`url = "${origin}"`))
      assert.ok(!hostedText.includes('[store]'))
      const expectedPolicy = {
        version: 1,
        tickets: {
          source: 'hosted',
          teamKey: 'FLOW',
          triageState: 'intake',
          readyState: 'queued',
          claimedState: 'working',
          doneState: 'shipped',
          createState: 'intake',
          proposalState: 'queued',
          readyLabels: ['reviewed'],
        },
      }
      assert.deepEqual(await new PostgresTicketPolicyStore(sql).get(repo), expectedPolicy)
      const readPolicy = await fetch(`${origin}/tickets/policy`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${hostedSaved.token}`,
          'content-type': 'application/json',
          'x-autobuild-version': AUTOBUILD_VERSION,
          'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
        },
        body: JSON.stringify({ context: { repo, teamKey: 'FLOW' }, input: null }),
      })
      assert.equal(readPolicy.status, 200)
      assert.deepEqual(await readPolicy.json(), expectedPolicy)
      const hostedSource = new HostedTicketSource({
        url: origin,
        token: hostedSaved.token,
        repo,
        teamKey: 'FLOW',
      })
      const hostedTicket = await hostedSource.create({
        title: 'Connected hosted ticket',
        body: 'Policy published before authoring.',
      })
      assert.equal(hostedTicket.state, 'intake')
      assert.equal((await hostedSource.get(hostedTicket.ref.id))?.title, hostedTicket.title)
      const hostedRust = new RemoteBuildStore({ url: origin, token: hostedSaved.token }),
        hostedTs = new RemoteBuildStore({ url: typescript.url.origin, token: hostedSaved.token })
      assert.ok(await hostedRust.getRepo(repo))
      assert.ok(await hostedTs.getRepo(repo))
      await abDisconnect({ ...options, tickets: true })
      assert.equal(new ProjectCredentials(cliEnv).load(origin, repo), undefined)
      await assert.rejects(() => hostedRust.getRepo(repo), /unknown or revoked credential/)
      await assert.rejects(() => hostedTs.getRepo(repo), /unknown or revoked credential/)
      // Revoked browser admission is checked freshly on the next JSON operation.
      const account = await fetch(`${origin}/connect`, { headers: { cookie } })
      const logoutCsrf = (await account.text()).match(/name="csrf" value="([^"]+)"/)?.[1]
      assert.ok(logoutCsrf)
      await fetch(`${origin}/auth/sign-out`, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: logoutCsrf }),
        redirect: 'manual',
      })
      assert.equal(
        (await api('/connect/v1/browser/lookup', { code: request.code }, cookie)).status,
        401,
      )
      await stop()
      serverEnv = { ...serverEnv, PROA_DEV_AUTH_EMAIL: 'refused@example.com' }
      await start()
      assert.equal(
        (
          await fetch(`${origin}/auth/dev-session`, {
            method: 'POST',
            headers: { 'x-proa-dev-capability': capability },
            redirect: 'manual',
          })
        ).status,
        403,
      )
      return {
        normalServer: true,
        cliApproval: true,
        cliDenial: true,
        cliExpiry: true,
        cliCancellation: true,
        browserErrors: true,
        subprocessStatus: true,
        sharedCredential: true,
        disconnectRevocation: true,
        noJsForm: true,
        originCsrfRefusal: true,
        restart: true,
        freshBrowserAdmission: true,
        hostedPolicyPublication: true,
      }
    } finally {
      await stop()
      typescript.stop(true)
      await backing.close()
      await sql.close()
      await rm(runtime, { recursive: true, force: true })
    }
  })
}
if (import.meta.main) console.log(await withDataServices(connectIntegration))
