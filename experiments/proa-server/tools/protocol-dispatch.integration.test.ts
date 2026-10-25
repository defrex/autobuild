/** Finite isolated Dispatcher -> BuildRunner -> real CLI -> RemoteBuildStore ->
 * native HTTP/Postgres/S3 proof. Agent/forge/ticket edges are journaled fakes;
 * git, worktrees, lifecycle code and persistence are real. Never runs on import. */
import { strict as assert } from 'node:assert'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { SQL } from 'bun'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import { delegateCredential } from '../../../packages/core/src/store/remote/credentials'
import { verifyToken } from '../../../packages/core/src/store/remote/token'
import { openProductionStore } from '../../../packages/core/src/cli/store-opening'
import { Dispatcher } from '../../../packages/core/src/processes/dispatcher'
import { BuildRunner } from '../../../packages/core/src/processes/build-runner'
import { spawnExec } from '../../../packages/core/src/ports/workspace/git-worktree'
import { RemoteBuildStore } from '../../../packages/core/src/store/remote/client'
import {
  happyHandlers,
  CONFIG_TOML,
  makeHarness,
  readyTicket,
} from '../../../packages/core/src/scenarios/harness'
import { expected } from './fixture-core'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'

async function dataReader(executable: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn([executable], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const diagnostics = new Response(child.stderr).text()
  const lines = (async function* () {
    let pending = ''
    for await (const bytes of child.stdout) {
      pending += new TextDecoder().decode(bytes)
      while (pending.includes('\n')) {
        const index = pending.indexOf('\n')
        const line = pending.slice(0, index)
        pending = pending.slice(index + 1)
        yield JSON.parse(line)
      }
    }
    throw new Error(`Native data reader closed (${await child.exited}): ${await diagnostics}`)
  })()
  const next = async () => {
    const timer = setTimeout(() => child.kill(), 30_000)
    try {
      return (await lines.next()).value
    } finally {
      clearTimeout(timer)
    }
  }
  assert.deepEqual(await next(), { ready: true })
  return {
    async read(command: Record<string, unknown>) {
      child.stdin.write(`${JSON.stringify(command)}\n`)
      await child.stdin.flush()
      const reply = await next()
      assert.equal(reply.error, undefined, JSON.stringify(reply))
      return reply.value
    },
    async close() {
      child.stdin.end()
      const timer = setTimeout(() => child.kill(), 10_000)
      try {
        await child.exited
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export async function proveProtocolDispatch(
  serverExecutable: string,
  readerExecutable: string,
  authenticated = false,
) {
  const requests: { method: string; path: string }[] = [],
    checks: string[] = []
  let orderedEvents: { seq: number; type: string }[] = []
  const delegatedPhases: { phase: string; session: string; anchor: number; terminalSeq: number }[] =
    []
  let eventCount = 0,
    artifactCount = 0
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (baseEnv) => {
      const secret = 'finite-native-dispatch-secret'
      const env: Record<string, string | undefined> = {
        ...baseEnv,
        ...(authenticated ? { PROA_TEST_AUTH: 'project', PROA_TEST_SECRET: secret } : {}),
      }
      const sql = authenticated ? new SQL(env.AB_POSTGRES_URL!, { max: 1 }) : undefined
      let projectToken: string | undefined
      let server: Awaited<ReturnType<typeof startProtocolServer>> | undefined,
        h: Awaited<ReturnType<typeof makeHarness>> | undefined,
        reader: Awaited<ReturnType<typeof dataReader>> | undefined,
        failure: unknown
      try {
        server = await startProtocolServer({
          executable: serverExecutable,
          env,
          clock: () => new Date('2026-01-01T00:00:00.000Z'),
        })
        const native = server
        const remote = new RemoteBuildStore({
          url: native.url,
          fetchFn: (async (input: URL | RequestInfo, init?: RequestInit) => {
            const request = new Request(input, init)
            if (projectToken) request.headers.set('authorization', `Bearer ${projectToken}`)
            requests.push({ method: request.method, path: new URL(request.url).pathname })
            return native.fetch(request)
          }) as typeof fetch,
        })
        h = await makeHarness({
          handlers: happyHandlers(),
          processCli: authenticated,
          ...(authenticated
            ? {
                localGitForge: true,
                configToml: CONFIG_TOML.replace(
                  'capacity = 2',
                  'capacity = 2\nforge = "local-git"',
                ),
              }
            : {}),
          tickets: [readyTicket('T-1')],
          storeAdapter: async () => ({ store: remote, storeRef: native.url }),
        })
        const repo = authenticated ? 'https://github.com/proa/finite-dispatch' : h.origin
        if (authenticated) {
          const projects = new PostgresProjectRegistry(sql!)
          await projects.add(repo, 'proof')
          projectToken = (await new PostgresCredentialStore(sql!, projects).issue(repo, 'proof'))
            .token
        }
        let launched: string | undefined
        const dispatcher = authenticated
          ? new Dispatcher({
              store: remote,
              tickets: h.tickets,
              workspaces: h.workspaces,
              forge: h.forgeAdapter,
              config: h.config,
              repo,
              checkout: h.origin,
              exec: spawnExec,
              launchRunner: async (slug) => {
                launched = slug
                return 'scheduled'
              },
              ids: h.ids,
              clock: h.clock,
            })
          : h.dispatcher
        const tick = await dispatcher.tick()
        assert.equal(tick.dispatched, 1)
        const slug = authenticated ? launched! : 'add-rate-limiting'
        assert.ok(authenticated ? launched : h.launched.some((entry) => entry.slug === slug))
        const state = await (async () => {
          if (!authenticated) return h!.runLatest()
          const runnerToken = await delegateCredential(native.url, projectToken, {
            kind: 'build-runner',
            id: slug,
          })
          const claims = verifyToken(secret, runnerToken, new Date('2026-01-01T00:00:00.000Z'))
          assert.ok(claims && 'delegation' in claims && claims.delegation.kind === 'build-runner')
          const runnerStore = openProductionStore(native.url, runnerToken)
          const prefix = await runnerStore.getEvents(slug)
          const workspace = prefix.find((event) => event.type === 'workspace.provisioned')
          assert.ok(workspace && workspace.type === 'workspace.provisioned')
          const runner = new BuildRunner({
            store: runnerStore.scopeBuild(slug),
            config: h!.config,
            runtimes: { scripted: { runner: h!.agents, servesModels: [] } },
            workspacePath: workspace.payload.ref,
            branch: `ab/${slug}`,
            slug,
            exec: spawnExec,
            forge: h!.forgeAdapter,
            ids: h!.ids,
            clock: h!.clock,
            instance: 'delegated-runner',
            host: 'isolated-dispatch-proof',
            sessionEnv: { AB_STORE: native.url, AB_TOKEN: runnerToken },
            opts: { heartbeatMs: 3_600_000, leaseTtlMs: 3_600_000 },
          })
          try {
            return await runner.run()
          } finally {
            await runnerStore.releaseLease(slug, 'delegated-runner')
            await runnerStore.close()
          }
        })()
        assert.equal(state.status, 'running')
        assert.equal(state.prState, 'open')
        assert.deepEqual(h.cliErrors, [])
        if (authenticated) {
          await remote.append(slug, {
            actor: { kind: 'human', user: 'proof' },
            type: 'build.auto-merge-requested',
            payload: {},
          })
          const landing = await dispatcher.tick()
          const terminalTick = await dispatcher.tick()
          assert.equal(landing.merged + terminalTick.merged, 1)
          assert.ok(h.tickets.transitions.some((row) => row.state === 'Done'))
          checks.push(
            'authenticated dispatcher janitor observes merged forge and persists workspace release/build completion',
          )
        }
        const events = await remote.getEvents(slug)
        eventCount = events.length
        orderedEvents = events.map(({ seq, type }) => ({ seq, type }))
        assert.deepEqual(
          events.map((event) => event.seq),
          events.map((_, index) => index + 1),
        )
        for (const type of [
          'build.created',
          'workspace.provisioned',
          'spec.imported',
          'plan.completed',
          'plan-review.verdict',
          'implement.completed',
          'code-review.verdict',
          'verify.completed',
          'finalize.completed',
          'pr-summary.result',
        ])
          assert.ok(
            events.some((event) => event.type === type),
            `missing lifecycle fact ${type}`,
          )
        assert.ok(
          events.some(
            (event) =>
              event.type === 'verify.completed' &&
              'outcome' in event.payload &&
              event.payload.outcome === 'pass',
          ),
        )
        if (authenticated) {
          assert.equal(h.agents.sessions.size, 5)
          for (const session of h.agents.sessions.values()) {
            const token = session.opts.env.AB_TOKEN
            assert.ok(token && token !== projectToken)
            const claims = verifyToken(secret, token, new Date('2026-01-01T00:00:00.000Z'))
            assert.ok(claims && 'delegation' in claims)
            if (!claims || !('delegation' in claims)) throw Error('missing phase delegation')
            assert.equal(claims.delegation.kind, 'build-phase')
            assert.equal(claims.delegation.id, slug)
            assert.equal(claims.delegation.session, session.session.id)
            assert.equal(claims.delegation.repo, repo)
            const started = events.find(
              (event) =>
                event.type === 'session.started' && event.payload.session === session.session.id,
            )
            const ended = events.find(
              (event) =>
                event.type === 'session.ended' && event.payload.session === session.session.id,
            )
            assert.ok(started && ended)
            assert.equal(claims.delegation.anchor, started.seq)
            delegatedPhases.push({
              phase: session.opts.env.AB_PHASE!,
              session: session.session.id,
              anchor: started.seq,
              terminalSeq: ended.seq,
            })
          }
          checks.push(
            'project credential bootstraps native-issued runner grant; real runner delegates five phase grants; child CLI reopens production stores with phase credentials',
          )
        }
        const artifacts = await remote.listArtifacts(slug)
        artifactCount = artifacts.length
        for (const kind of [
          'spec',
          'plan',
          'plan-review',
          'implement-notes',
          'code-review',
          'pr-description',
          'transcript',
        ])
          assert.ok(
            artifacts.some((meta) => meta.kind === kind),
            `missing durable artifact ${kind}`,
          )
        assert.equal((await remote.listArtifacts(slug, 'transcript')).length, 5)
        reader = await dataReader(readerExecutable, env)
        assert.deepEqual(
          await reader.read({ op: 'build', repo, id: slug }),
          expected('build', events),
        )
        assert.deepEqual(
          await reader.read({ op: 'repository', repo }),
          expected('repository', await remote.getRepoEvents(repo)),
        )
        const project = await reader.read({ op: 'project', repo })
        assert.deepEqual(project, [{ status: 'readable', slug, value: expected('build', events) }])
        const nativeBuild = await reader.read({ op: 'build', repo, id: slug })
        assert.equal(nativeBuild.build.status, authenticated ? 'done' : state.status)
        assert.equal(nativeBuild.build.prState, authenticated ? 'merged' : state.prState)
        checks.push(
          'real isolated git dispatch and full scripted pipeline reach open PR through native RemoteBuildStore',
          'all phase facts, five transcript revisions and required artifacts persist',
          'independent Rust DataReader equals authoritative TS reducers on actual dispatch output',
        )
        await reader.close()
        reader = undefined
        await native.close()
        server = undefined
        const restarted = await startProtocolServer({
          executable: serverExecutable,
          env,
          clock: () => new Date('2026-01-01T00:00:00.000Z'),
        })
        server = restarted
        const cold = new RemoteBuildStore({
          url: restarted.url,
          fetchFn: restarted.fetch,
          token: projectToken,
        })
        assert.deepEqual(await cold.getEvents(slug), events)
        assert.deepEqual(await cold.listArtifacts(slug), artifacts)
        checks.push('fresh native process reopens complete dispatch history/artifacts')
        assert.ok(
          requests.some((row) => row.method === 'POST' && row.path.endsWith('/reducer-values')),
        )
        assert.ok(requests.some((row) => row.method === 'POST' && row.path.endsWith('/deposits')))
      } catch (error) {
        failure = error
      } finally {
        await reader?.close().catch((error) => {
          failure ??= error
        })
        await h?.cleanup().catch((error) => {
          failure ??= error
        })
        await sql?.close().catch((error) => {
          failure ??= error
        })
        await server?.close().catch((error) => {
          failure ??= error
        })
      }
      if (failure) throw failure
    }),
  )
  const report = {
    authority: authenticated ? 'project-runner-phase' : 'private-test-open',
    fullDelegatedDispatchProof: authenticated,
    state: authenticated
      ? { status: 'done', prState: 'merged' }
      : { status: 'running', prState: 'open' },
    orderedEvents,
    eventCount,
    artifactCount,
    projectClientHttpRequests: requests.length,
    observedProjectMethodRoutes: Object.fromEntries(
      [
        ...new Set(
          requests.map((row) => {
            const parts = row.path.split('/')
            if (
              ['builds', 'repos', 'sessions', 'streams'].includes(parts[1] ?? '') &&
              parts.length > 2
            )
              parts[2] = ':id'
            return `${row.method} ${parts.join('/')}`
          }),
        ),
      ]
        .sort()
        .map((route) => [
          route,
          requests.filter((row) => {
            const parts = row.path.split('/')
            if (
              ['builds', 'repos', 'sessions', 'streams'].includes(parts[1] ?? '') &&
              parts.length > 2
            )
              parts[2] = ':id'
            return `${row.method} ${parts.join('/')}` === route
          }).length,
        ]),
    ),
    delegatedPhaseCount: delegatedPhases.length,
    delegatedPhases,
    checks,
  }
  const evidence = resolve(import.meta.dir, '../../../.ab/proa-protocol-dispatch')
  await mkdir(evidence, { recursive: true })
  await Bun.write(
    resolve(
      evidence,
      authenticated ? 'delegated-authority-report.json' : 'open-authority-report.json',
    ),
    `${JSON.stringify(report, null, 2)}\n`,
  )
  return report
}

export function proveProtocolDelegatedDispatch(serverExecutable: string, readerExecutable: string) {
  return proveProtocolDispatch(serverExecutable, readerExecutable, true)
}
