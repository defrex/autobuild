/** Isolated actual Dispatcher/BuildRunner + native browser form proof.
 * Only fixture-owned PostgreSQL, Git worktrees, web process and fake forge/agent
 * edges are used. Never opens the live repository store or dispatcher. */
import { SQL } from 'bun'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  makeHarness,
  happyHandlers,
  readyTicket,
  type E2eHarness,
} from '../../../packages/core/src/scenarios/harness'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { migratePostgres } from '../../../packages/postgres-store/src/schema'
import { reduceBuild } from '../../../packages/core/src/kernel/reducer'
import { validateEventWrite } from '../../../packages/core/src/events/catalog'
import { effectiveBuildConfigContent } from '../../../packages/core/src/processes/build-execution-state'
import { getOperatorDashboard } from '../../../packages/core/src/operator/query'
import { renderDashboard } from '../../../packages/core/src/cli/dashboard/render'
import type { Clock } from '../../../packages/core/src/store/types'
import { buildNative } from './data-integration'
import { withDataServices } from './data-services'
const project = resolve(import.meta.dir, '..')
const bounded = <T>(promise: Promise<T>, ms: number, label: string) => {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}
export async function dispatcherIntegration(
  adminUrl: string,
  environment: Record<string, string | undefined>,
) {
  const native = await buildNative(environment)
  const suffix = crypto.randomUUID().replaceAll('-', '')
  const database = `proa_dispatch_${suffix}`
  const readRole = `proa_dispatch_read_${suffix}`,
    writeRole = `proa_dispatch_write_${suffix}`,
    password = crypto.randomUUID()
  const admin = new SQL(adminUrl, { max: 1 })
  const dbUrl = new URL(adminUrl)
  dbUrl.pathname = `/${database}`
  let sql: SQL | undefined,
    store: Awaited<ReturnType<typeof openPostgresBuildStoreFromEnv>> | undefined,
    h: E2eHarness | undefined
  let server: ReturnType<typeof Bun.spawn> | undefined, running: Promise<unknown> | undefined
  let release = () => {},
    created = false
  const roles: string[] = []
  const evidence = await mkdtemp(resolve(project, '../../.ab/proa-dispatcher-proof-'))
  const runtime = await mkdtemp(resolve(tmpdir(), 'proa-dispatcher-web-'))
  const stop = () => {
    release()
    server?.kill('SIGTERM')
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  let failure: unknown, result: unknown
  try {
    await admin.unsafe(`CREATE DATABASE ${database}`)
    created = true
    await migratePostgres(dbUrl.href)
    sql = new SQL(dbUrl.href, { max: 1 })
    for (const role of [readRole, writeRole]) {
      await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
      roles.push(role)
      await sql.unsafe(`GRANT CONNECT ON DATABASE ${database} TO ${role}`)
      await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`)
      await sql.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`)
    }
    await sql.unsafe(`GRANT INSERT,UPDATE ON builds,events,repo_change_positions TO ${writeRole}`)
    let clock: Clock = () => new Date('2026-07-15T12:00:00.000Z')
    store = await openPostgresBuildStoreFromEnv(
      { ...environment, AB_POSTGRES_URL: dbUrl.href },
      { clock: () => clock() },
    )
    const activeStore = store
    let started!: () => void
    const atPlan = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const handlers = happyHandlers(),
      plan = handlers.plan!
    handlers.plan = async (cli) => {
      started()
      await gate
      return plan(cli)
    }
    h = await makeHarness({
      handlers,
      tickets: [readyTicket('T-1')],
      storeAdapter: async () => ({
        store: activeStore,
        storeRef: 'memory://proa-dispatcher-proof',
      }),
    })
    clock = h.clock
    h.clock.advance(Math.max(0, Date.now() - h.clock().getTime() + 1000))
    await activeStore.ensureRepo(h.origin)
    const config = await activeStore.putRepoArtifact(h.origin, {
      kind: 'dispatcher-effective-config',
      content: effectiveBuildConfigContent(h.config),
    })
    await activeStore.appendRepo(h.origin, {
      actor: { kind: 'dispatcher' },
      type: 'dispatcher.run-started',
      payload: {
        run: 'proof-dispatcher',
        pid: process.pid,
        host: 'isolated-test',
        effectiveConfig: { kind: config.kind, rev: config.revision },
        roleWarnings: [],
      },
    })
    await sql`INSERT INTO project_journal(seq,repo,action,actor,ts) VALUES(nextval('project_journal_seq'),${h.origin},'added','proof',${h.clock().toISOString()})`
    const reserved = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('reserved'),
    })
    const port = reserved.port!
    await reserved.stop(true)
    const origin = `http://127.0.0.1:${port}`,
      capability = crypto.randomUUID() + crypto.randomUUID()
    const roleUrl = (role: string) => {
      const url = new URL(dbUrl)
      url.username = role
      url.password = password
      return url.href
    }
    server = Bun.spawn([native.server], {
      cwd: project,
      env: {
        ...environment,
        AB_POSTGRES_URL: roleUrl(readRole),
        PROA_POSTGRES_WRITE_URL: roleUrl(writeRole),
        AB_STORE_SECRET: 'isolated-dispatcher-machine-secret',
        PORT: String(port),
        PROA_HOST: '127.0.0.1',
        PROA_AUTH_URL: origin,
        PROA_ENV: 'development',
        PROA_DEV_AUTH: 'true',
        PROA_DEV_AUTH_EMAIL: 'operator@example.com',
        PROA_DEV_AUTH_CAPABILITY: capability,
        PROA_SESSION_SECRET: 'isolated-dispatcher-proof-secret-0000000000',
        AB_WEB_ALLOWED_EMAILS: 'operator@example.com',
        GITHUB_CLIENT_ID: undefined,
        GITHUB_CLIENT_SECRET: undefined,
      },
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const errors = new Response(server.stderr as ReadableStream<Uint8Array>).text()
    let ready = false
    for (let i = 0; i < 200; i++) {
      if (server.exitCode !== null) throw new Error(`Fixture web exited: ${await errors}`)
      try {
        if ((await fetch(`${origin}/readyz`)).ok) {
          ready = true
          break
        }
      } catch {}
      await Bun.sleep(50)
    }
    assert(ready, 'native web readiness')
    const signIn = await fetch(`${origin}/auth/dev-session`, {
      method: 'POST',
      headers: { 'x-proa-dev-capability': capability },
      redirect: 'manual',
    })
    assert.equal(signIn.status, 303)
    const cookie = signIn.headers
      .get('set-cookie')!
      .split(', ')
      .filter((c) => c.startsWith('proa-session=') && !c.startsWith('proa-session=;'))
      .at(-1)!
      .split(';')[0]!
    const initial = await h.dispatcher.tick()
    assert.equal(initial.dispatched, 1)
    assert.equal(h.launched.length, 1)
    const slug = h.launched[0]!.slug
    running = h.runLatest()
    await bounded(atPlan, 10000, 'runner enters plan')
    const readState = async () => reduceBuild(await activeStore.getEvents(slug))
    assert.equal((await readState()).status, 'running')
    const page = await fetch(
      `${origin}/dashboard/builds/${encodeURIComponent(slug)}?project=${encodeURIComponent(h.origin)}`,
      { headers: { cookie } },
    )
    const html = await page.text()
    const csrf = /name="csrf"\s+value="([^"]+)"/.exec(html)?.[1]
    assert(csrf, 'real browser page CSRF')
    const submit = async (action: string) => {
      const response = await fetch(`${origin}/controls`, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, project: h!.origin, slug, action }),
        redirect: 'manual',
      })
      assert.equal(response.status, 303, `native browser ${action}`)
    }
    const frames: Record<string, string> = {}
    const frame = async (label: string) => {
      const view = await getOperatorDashboard({
        store: activeStore,
        repo: h!.origin,
        clock: h!.clock,
      })
      const text = renderDashboard(view.model, {
        color: false,
        width: 144,
        now: h!.clock().getTime(),
      }).join('\n')
      frames[label] = text
      await Bun.write(resolve(evidence, `${label}.txt`), text)
      return text
    }
    await submit('pause')
    h.clock.advance(
      Math.max(
        0,
        Date.parse((await activeStore.getBuild(slug))!.updatedAt) - h.clock().getTime() + 1000,
      ),
    )
    assert.match(await frame('pausing'), /PAUSING/)
    const turnsBefore = (await activeStore.getEvents(slug)).filter(
      (e) => e.type === 'session.started',
    ).length
    await h.dispatcher.tick()
    assert.equal(h.launched.length, 1, 'dispatcher does not schedule through live pause boundary')
    release()
    await bounded(running, 10000, 'runner acknowledges pause')
    running = undefined
    assert.equal((await readState()).status, 'paused')
    assert.match(await frame('paused'), /PAUSED/)
    await h.dispatcher.tick()
    assert.equal(h.launched.length, 1, 'paused build remains unscheduled')
    assert.equal(
      (await activeStore.getEvents(slug)).filter((e) => e.type === 'session.started').length,
      turnsBefore,
      'no next phase/session while paused',
    )
    await submit('resume')
    h.clock.advance(
      Math.max(
        0,
        Date.parse((await activeStore.getBuild(slug))!.updatedAt) - h.clock().getTime() + 1000,
      ),
    )
    await h.dispatcher.tick()
    assert.equal(h.launched.length, 2, 'durable resume permits actual dispatcher scheduling')
    running = h.runLatest()
    await bounded(running, 20000, 'resumed runner progresses')
    running = undefined
    assert.equal((await readState()).status, 'running')
    assert(
      (await activeStore.getEvents(slug)).filter((e) => e.type === 'session.started').length >
        turnsBefore,
      'phase sessions resume',
    )
    assert.match(await frame('resumed'), /RUNNING/)
    const events = await activeStore.getEvents(slug)
    events.forEach(validateEventWrite)
    for (const type of ['build.pause-requested', 'build.resume-requested'])
      assert.deepEqual(events.find((e) => e.type === type)?.actor, {
        kind: 'human',
        user: 'operator@example.com',
      })
    result = {
      proof: 'isolated-native-browser-dispatcher',
      database,
      repo: h.origin,
      slug,
      pausing: true,
      paused: true,
      resumed: true,
      launches: h.launched.length,
      terminalFrames: Object.keys(frames),
      evidence,
    }
    await Bun.write(resolve(evidence, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify(result))
  } catch (error) {
    failure = error
  } finally {
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
    release()
    if (running)
      await bounded(
        running.catch(() => {}),
        10000,
        'test runner cleanup',
      ).catch((error) => {
        failure ??= error
      })
    if (server) {
      server.kill('SIGTERM')
      const kill = setTimeout(() => server?.kill('SIGKILL'), 5000)
      await server.exited
      clearTimeout(kill)
    }
    const errors: unknown[] = []
    for (const close of [
      () => h?.cleanup(),
      () => store?.close(),
      () => sql?.close(),
      () => (created ? admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`) : undefined),
      ...roles.map((role) => () => admin.unsafe(`DROP ROLE ${role}`)),
      () => admin.close(),
      () => rm(runtime, { recursive: true, force: true }),
    ]) {
      try {
        await close()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) failure ??= new AggregateError(errors, 'Dispatcher proof cleanup failed')
  }
  if (failure) throw failure
  return result
}
if (import.meta.main) await withDataServices((a, e) => dispatcherIntegration(a, e))
