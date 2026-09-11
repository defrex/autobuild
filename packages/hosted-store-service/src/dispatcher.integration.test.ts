/**
 * The hosted dispatcher integration scenario (AUT-303, SPEC §12): a real
 * `createDispatcherEndpoint` drives the REAL origin-mode dispatch kernel over
 * a localhost Bun server running `createHostedStoreService` with a fake
 * backing store and a fake ticket backend. The kernel's store and ticket
 * traffic really traverses the hosted service's authenticated protocol — the
 * harness URL is `http://127.0.0.1:<port>`, which `resolveOriginModeState`
 * accepts because of the loopback allowance. Only the world's edges are fakes:
 * FakeForge, a seed-git workspace provider, a guest build execution that supervises a
 * real BuildRunner with scripted agents over the real `ab` CLI, and the fake
 * tickets behind the hosted ticket source.
 *
 * Driven: claim + launch, observe + settle (a guest that finished while no
 * invocation ran), intake OFF/ON, durable pause/resume, the auto-merge
 * decision, yield-on-overlap, the bounded invocation (skipped repository), and
 * the endpoint auth matrix.
 */
import { expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abDispatch, type DispatchOpts } from '../../core/src/cli/dispatch'
import { resolveCliEnv } from '../../core/src/cli/env'
import { runCli } from '../../core/src/cli/main'
import { createTicketSource } from '../../core/src/ports/tickets/create'
import { FakeTicketSource } from '../../core/src/ports/tickets/fake'
import {
  defaultTurnResult,
  ScriptedAgentRunner,
  type ScriptContext,
} from '../../core/src/ports/runner/fake'
import type { RuntimeRegistry } from '../../core/src/ports/runner/runtime'
import { FakeForge } from '../../core/src/ports/forge/fake'
import type {
  BuildExecution,
  BuildExecutionHandle,
  BuildExecutionIdentity,
  BuildExecutionStart,
} from '../../core/src/ports/workspace/build-execution'
import type {
  Forge,
  TicketSource,
  WorkspaceProvider,
  WorkspaceProvisionResult,
} from '../../core/src/ports/types'
import { spawnExec } from '../../core/src/ports/workspace/git-worktree'
import { randomUuids, sequentialIds, type IdSource } from '../../core/src/ids'
import {
  BUILD_EFFECTIVE_CONFIG_ARTIFACT,
  diagnosticArtifact,
  parseEffectiveBuildConfig,
  selectOpenWorkspace,
} from '../../core/src/processes/build-execution-state'
import {
  BuildRunner,
  LeaseHeldError,
  SetupFailureError,
} from '../../core/src/processes/build-runner'
import {
  GIT_ID,
  git,
  readyTicket,
  typesOf,
  writeFileIn,
  type Cli,
  type SkillHandlers,
} from '../../core/src/integration/harness'
import { MemoryBuildStore } from '../../core/src/store/memory'
import { steppingClock } from '../../core/src/testing/fixed'
import { OperatorApiClient } from 'autobuild/operator-api'
import { mintToken, RemoteBuildStore } from 'autobuild/remote-store'
import type { BuildStore, Clock } from 'autobuild/plugin-sdk'
import { createHostedStoreService } from './service'
import { createDispatcherEndpoint } from './dispatcher'

const storeEnv = {
  AB_STORE_SECRET: 'integration-signing-secret',
  AB_POSTGRES_URL: 'postgres://injected/test',
  AB_BLOB_BACKEND: 's3',
  AB_S3_BUCKET: 'injected',
  AB_S3_REGION: 'us-east-1',
  AB_S3_ACCESS_KEY_ID: 'injected',
  AB_S3_SECRET_ACCESS_KEY: 'injected',
}

const REPO = 'https://github.com/acme/checkoutless'

async function until(
  check: () => Promise<boolean>,
  label: string,
  dump?: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + 20_000
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) {
      if (dump !== undefined) await dump()
      throw new Error(`timed out waiting for ${label}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** autobuild.toml served by the fake GitHub transport (origin-mode startup
 * fetch) and written into every guest workspace (the `ab done` terminals read
 * config from the workspace, and a fake provider copies the empty scratch). */
const HOSTED_CONFIG_TOML = `
baseBranch = "main"
capacity = 4

[commands]
test = "test -f ok.marker"

[verify]
steps = ["unit"]

[verify.unit]
kind = "check"
command = "test"

[policy]
stallRounds = 3

[roles.default]
runtime = "scripted"

[tickets]
source = "hosted"
teamKey = "ENG"
readyState = "Ready"
readyLabels = ["autobuild"]
claimedState = "In Progress"
`

/** The guest's git remote: a local bare repo, so `implement`'s `ab done` can
 * fetch the base for its review boundary exactly as a real checkout would. */
async function initGuestRemote(dir: string): Promise<string> {
  const remote = join(dir, 'guest-remote.git')
  await mkdir(remote, { recursive: true })
  await git(['init', '--bare', '-q', '-b', 'main'], remote)
  return remote
}

/** A real git seed with autobuild.toml at a REAL base commit: the provider
 * copies it per build, so the workspace looks exactly like a provisioned
 * worktree — base sha, config file, and branch all resolvable. */
async function initSeed(dir: string): Promise<{ seed: string; baseSha: string }> {
  const seed = join(dir, 'seed')
  await mkdir(seed, { recursive: true })
  await git(['init', '-q', '-b', 'main'], seed)
  await writeFile(join(seed, 'autobuild.toml'), HOSTED_CONFIG_TOML)
  await writeFile(join(seed, 'README.md'), 'hosted dispatcher integration seed\n')
  await git(['add', '-A'], seed)
  await git([...GIT_ID, 'commit', '-q', '-m', 'base'], seed)
  return { seed, baseSha: await git(['rev-parse', 'HEAD'], seed) }
}

/** Workspace provider over the seed: each provision is a fresh copy with the
 * build branch checked out at the seed base — the durable fact carries the
 * real base sha, as a real provider would. */
class SeedWorkspaceProvider implements WorkspaceProvider {
  readonly name = 'fake'

  constructor(
    private readonly root: string,
    private readonly seed: string,
    private readonly baseSha: string,
  ) {}

  async provision(opts: { branch: string }): Promise<WorkspaceProvisionResult> {
    const path = join(this.root, opts.branch)
    await cp(this.seed, path, { recursive: true })
    await git(['checkout', '-q', '-b', opts.branch], path)
    return {
      provider: this.name,
      ref: path,
      path,
      branch: opts.branch,
      base: { source: 'existing', sha: this.baseSha },
    }
  }

  async release(): Promise<void> {}
}

/** Idempotent guest workspace wiring: connect the guest remote, publish the
 * base, and make sure the build branch is checked out (a resumed runner finds
 * everything already in place). */
async function prepareWorkspace(
  workspacePath: string,
  slug: string,
  guestRemote: string,
): Promise<void> {
  const remotes = await git(['remote'], workspacePath)
  if (!remotes.split('\n').includes('origin')) {
    await git(['remote', 'add', 'origin', guestRemote], workspacePath)
  }
  await git(['push', '-q', 'origin', 'main'], workspacePath)
  await git(['checkout', '-q', `ab/${slug}`], workspacePath)
}

/** One supervised guest run, keyed by the durable command id recorded on its
 * `execution.started` fact. */
interface GuestRun {
  slug: string
  finished: boolean
  error?: string
  done: Promise<void>
}

/** Environment-supervised guest execution: the kernel's `--once` teardown
 * detaches it (the guest keeps running — here a real in-process BuildRunner
 * driven by scripted agents over its own HTTP store client), and a later
 * invocation settles it from the durable facts plus provider liveness
 * (`observe`). `commandId` makes the execution re-observable without process
 * memory, exactly like a Vercel sandbox command id. */
class GuestExecution implements BuildExecution {
  constructor(
    private readonly runs: Map<string, GuestRun>,
    private readonly store: BuildStore,
    private readonly forge: Forge,
    private readonly runtimes: RuntimeRegistry,
    private readonly ids: IdSource,
    private readonly clock: Clock,
    private readonly sessionEnv: Record<string, string>,
    private readonly guestRemote: string,
  ) {}

  async start(input: BuildExecutionStart): Promise<BuildExecutionHandle> {
    const commandId = `cmd-${input.instance}`
    const entry: GuestRun = {
      slug: input.slug,
      finished: false,
      done: Promise.resolve(),
    }
    const run = (async () => {
      try {
        const record = await this.store.getBuild(input.slug)
        const events = await this.store.getEvents(input.slug)
        const workspace = selectOpenWorkspace(events)
        const artifact = await this.store.getArtifact(input.slug, BUILD_EFFECTIVE_CONFIG_ARTIFACT)
        if (record === null || workspace === null || artifact === null) {
          throw new Error('guest launch state missing')
        }
        await prepareWorkspace(workspace.path, input.slug, this.guestRemote)
        const runner = new BuildRunner({
          store: this.store.scopeBuild(input.slug),
          config: parseEffectiveBuildConfig(artifact),
          runtimes: this.runtimes,
          workspacePath: workspace.path,
          branch: record.branch ?? `ab/${input.slug}`,
          slug: input.slug,
          exec: spawnExec,
          forge: this.forge,
          ids: this.ids,
          clock: this.clock,
          instance: input.instance,
          host: 'hosted-integration',
          sessionEnv: this.sessionEnv,
          opts: { heartbeatMs: 3_600_000, leaseTtlMs: 3_600_000 },
        })
        await runner.run()
      } catch (error) {
        await this.store
          .putArtifact(
            input.slug,
            diagnosticArtifact({
              instance: input.instance,
              outcome:
                error instanceof LeaseHeldError
                  ? 'lease-held'
                  : error instanceof SetupFailureError
                    ? 'setup-failed'
                    : 'failed',
              error: error instanceof Error ? error.message : String(error),
            }),
          )
          .catch(() => {})
        throw error
      } finally {
        entry.finished = true
      }
    })()
    entry.done = run.catch((error: unknown) => {
      entry.error = error instanceof Error ? error.message : String(error)
    })
    this.runs.set(commandId, entry)
    return {
      identity: { provider: 'fake', workspaceRef: input.workspaceRef, commandId },
      supervision: 'environment',
      completion: run.then(
        () => ({ exitCode: 0 }),
        () => ({ exitCode: 1 }),
      ),
      async stop() {
        return { outcome: 'confirmed' }
      },
      async detach() {},
    }
  }

  async observe(identity: BuildExecutionIdentity): Promise<{
    state: 'running' | 'ended'
    exitCode?: number
  }> {
    const entry = identity.commandId === undefined ? undefined : this.runs.get(identity.commandId)
    if (entry === undefined || !entry.finished) return { state: 'running' }
    return { state: 'ended', exitCode: 0 }
  }
}

test('the cron endpoint drives the real kernel: claim, launch, observe, settle, controls, overlap, bound', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-hosted-dispatcher-'))
  const clock = steppingClock(new Date().toISOString(), 100)
  const ids = sequentialIds()
  const uuids = randomUuids()
  const fakeForge = new FakeForge()
  const guestRemote = await initGuestRemote(tmp)
  const { seed, baseSha } = await initSeed(tmp)
  const guestRuns = new Map<string, GuestRun>()

  const backing = new MemoryBuildStore({ clock })
  const ticketBackend = new FakeTicketSource([readyTicket('T-1')])
  const service = createHostedStoreService({
    env: storeEnv,
    clock,
    openStore: async () => backing,
    sourceFor: () => ticketBackend,
  })
  const requests: Array<{ method: string; path: string; authorization: string | null }> = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
      })
      return service.fetch(request)
    },
  })
  const serviceUrl = `http://127.0.0.1:${server.port}`

  // The guest scripts run the real `ab` CLI over their own HTTP store client,
  // built from the ambient env the runner re-issued (D8). This both proves the
  // guest session env and keeps guests independent of any supervisor client.
  const sessionEnvs: Array<{ skill: string; store?: string; token?: string }> = []
  const makeCli = (ctx: ScriptContext): Cli => {
    const env = resolveCliEnv(ctx.opts.env)
    const ws = ctx.opts.workspacePath
    sessionEnvs.push({
      skill: ctx.opts.skill,
      store: ctx.opts.env.AB_STORE,
      token: ctx.opts.env.AB_TOKEN,
    })
    const run = async (argv: string[]): Promise<string[]> => {
      const out: string[] = []
      const err: string[] = []
      const code = await runCli(argv, {
        store: new RemoteBuildStore({ url: env.store, token: env.token }),
        env,
        workspacePath: ws,
        forge: fakeForge,
        exec: spawnExec,
        ids,
        clock,
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      })
      if (code !== 0) throw new Error(`ab ${argv.join(' ')} exited ${code}: ${err.join('\n')}`)
      return out
    }
    return { run, ws, round: env.round, env, ctx }
  }

  let holdImplement: Promise<void> | undefined
  let releaseImplement: (() => void) | undefined
  let implementHeld = false
  const handlers: SkillHandlers = {
    plan: async (cli) => {
      await cli.run(['context'])
      const plan = await writeFileIn(
        cli.ws,
        '.ab/plan.md',
        `# Plan (round ${cli.round})\n\n1. Add rate-limit.txt and ok.marker.\n`,
      )
      await cli.run(['artifact', 'put', 'plan', plan])
      await cli.run(['done'])
    },
    'plan-review': async (cli) => {
      await cli.run(['context'])
      const notes = await writeFileIn(cli.ws, '.ab/plan-review.md', 'Plan conforms to the spec.\n')
      await cli.run(['verdict', 'approve', '--notes', notes])
    },
    implement: async (cli) => {
      if (holdImplement) {
        implementHeld = true
        await holdImplement
        implementHeld = false
      }
      await cli.run(['context'])
      await writeFileIn(cli.ws, 'rate-limit.txt', `throttle after 5 (r${cli.round})\n`)
      await writeFileIn(cli.ws, 'ok.marker', 'ok\n')
      await git(['add', '-A'], cli.ws)
      await git([...GIT_ID, 'commit', '-q', '-m', `implement r${cli.round}`], cli.ws)
      const notes = await writeFileIn(
        cli.ws,
        '.ab/implement-notes.md',
        `Added rate-limit.txt (round ${cli.round}).\n`,
      )
      await cli.run(['done', '--notes', notes])
    },
    'code-review': async (cli) => {
      await cli.run(['context'])
      const notes = await writeFileIn(cli.ws, '.ab/code-review.md', 'Diff matches the plan.\n')
      await cli.run(['verdict', 'approve', '--notes', notes])
    },
    finalize: async (cli) => {
      await cli.run(['context'])
      const pr = await writeFileIn(
        cli.ws,
        '.ab/pr-description.md',
        'Add login rate limiting\n\nThrottles repeated failed logins.\n',
      )
      await cli.run(['artifact', 'put', 'pr-description', pr])
      await cli.run(['done'])
    },
  }
  const agents = new ScriptedAgentRunner({
    script: async (ctx) => {
      const handler = handlers[ctx.opts.skill] ?? handlers[ctx.opts.skill.replace(/^ab-/, '')]
      if (handler === undefined) throw new Error(`no scripted handler for "${ctx.opts.skill}"`)
      return (await handler(makeCli(ctx))) ?? defaultTurnResult(`${ctx.opts.skill} finished`)
    },
  })
  const guestRuntimes: RuntimeRegistry = { scripted: { runner: agents, servesModels: [] } }

  const transport = (async (method: string, path: string) => {
    if (method === 'GET' && path.includes('/contents/autobuild.toml')) {
      return { status: 200, headers: {}, bytes: new TextEncoder().encode(HOSTED_CONFIG_TOML) }
    }
    throw new Error(`unexpected GitHub request: ${method} ${path}`)
  }) as never

  const mintedTokens: string[] = []
  const kernelErrors: string[] = []
  const dispatch = async (opts: DispatchOpts): Promise<void> => {
    mintedTokens.push(opts.env!.AB_TOKEN!)
    const guestExecution = new GuestExecution(
      guestRuns,
      new RemoteBuildStore({ url: opts.env!.AB_STORE!, token: opts.env!.AB_TOKEN }),
      fakeForge,
      guestRuntimes,
      ids,
      clock,
      { AB_STORE: opts.env!.AB_STORE!, AB_TOKEN: opts.env!.AB_TOKEN! },
      guestRemote,
    )
    await abDispatch({
      targetRepo: join(tmp, 'unused-checkout'),
      repository: REPO,
      originConfigTransport: transport,
      once: true,
      plain: true,
      env: opts.env,
      exec: spawnExec,
      stdout: () => {},
      stderr: (line) => kernelErrors.push(line),
      kernelRunId: opts.kernelRunId,
      deadlineAt: opts.deadlineAt,
      nonStoreWire: async (config, innerOpts, state, plugins) => {
        const tickets: TicketSource = await createTicketSource(
          config.tickets,
          innerOpts.env,
          state.repo,
          state.localStateRoot,
          plugins,
        )
        const workspaces = new SeedWorkspaceProvider(join(tmp, 'workspaces'), seed, baseSha)
        ;(workspaces as unknown as { buildExecution?: BuildExecution }).buildExecution =
          guestExecution
        return {
          tickets,
          forge: fakeForge,
          workspaces,
          buildExecution: guestExecution,
          runtimes: guestRuntimes,
          ids,
          uuids,
          clock,
        }
      },
    })
  }

  const endpoint = createDispatcherEndpoint({
    env: {
      ...storeEnv,
      AB_DISPATCHER_ORIGIN: serviceUrl,
      AB_DISPATCHER_REPOSITORIES: REPO,
      AB_DISPATCHER_BUDGET_SECONDS: '780',
      CRON_SECRET: 'cron-secret',
      // Forge credentials flow through from the service environment, exactly
      // as a real deployment configures them — guests never receive one.
      GITHUB_TOKEN: 'forge-token',
    },
    clock,
    dispatch,
    stdout: () => {},
    stderr: (line) => kernelErrors.push(line),
  })
  const get = (headers?: Record<string, string>): Promise<Response> =>
    endpoint.fetch(new Request(`${serviceUrl}/api/dispatch`, { headers }))

  const journal = () => backing.getRepoEvents(REPO)
  const buildEvents = async (slug: string) => backing.getEvents(slug)
  const buildForTicket = async (id: string) =>
    (await backing.listBuilds()).find((candidate) => candidate.ticket?.id === id)
  const runPayload = (event: { payload: unknown }) => event.payload as { run?: string }
  /** Extra invocations until a durable condition holds (e.g. the janitor's
   * post-merge `build.completed` lands one tick after the guest parked). */
  const tickUntil = async (check: () => Promise<boolean>, label: string): Promise<void> => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await get({ authorization: 'Bearer cron-secret' })
      if (await check()) return
    }
    throw new Error(`invocations exhausted waiting for ${label}`)
  }
  const waitForBuildEvent = (slug: string, type: string, label: string): Promise<void> =>
    until(async () => (await buildEvents(slug)).some((event) => event.type === type), label)
  /** Simulate the forge completing a PR merge (native auto-merge or a human
   * click): the janitor's next tick observes `merged` and runs the epilogue
   * that parks the build `done`. */
  const mergePr = async (slug: string): Promise<void> => {
    const finalize = (await buildEvents(slug)).find((event) => event.type === 'finalize.completed')
    if (finalize === undefined) throw new Error(`${slug} has no finalize.completed to merge`)
    const pr = (finalize.payload as { pr: { number: number } }).pr
    fakeForge.setPrState(pr.number, { state: 'merged', sha: `merged-${pr.number}` })
  }
  type Body = {
    ok: boolean
    repositories: Array<{ repository: string; outcome: string; runId?: string }>
  }

  try {
    // ── Auth matrix: wrong/missing bearer and non-GET do no work. ──────────
    expect(
      (await endpoint.fetch(new Request(`${serviceUrl}/api/dispatch`, { method: 'POST' }))).status,
    ).toBe(405)
    expect((await get()).status).toBe(401)
    expect((await get({ authorization: 'Bearer wrong' })).status).toBe(401)
    expect(requests).toEqual([])

    // ── Claim + launch: one authorized GET runs one bounded tick. ──────────
    const first = await get({ authorization: 'Bearer cron-secret' })
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as Body
    expect(firstBody.ok).toBe(true)
    expect(firstBody.repositories).toEqual([
      { repository: REPO, outcome: 'ticked', runId: expect.stringMatching(/^hosted-dispatcher-/) },
    ])
    expect(ticketBackend.claims).toContain('T-1')

    // The durable journal names the hosted dispatcher everywhere.
    const firstRunId = firstBody.repositories[0]!.runId!
    let journalEvents = await journal()
    for (const type of [
      'dispatcher.run-started',
      'dispatcher.tick-started',
      'dispatcher.tick-completed',
      'dispatcher.run-stopped',
    ]) {
      const event = journalEvents.find((candidate) => candidate.type === type)
      expect(event, type).toBeDefined()
      expect(runPayload(event!)).toMatchObject({ run: firstRunId })
    }
    // The repository lease was released for the next invocation.
    expect((await backing.getRepo(REPO))?.lease ?? undefined).toBeUndefined()

    // The build exists, was provisioned, and a runner launched.
    const b1 = await buildForTicket('T-1')
    expect(b1).toBeDefined()
    // Slug naming falls back deterministically: the scripted runtime has no
    // one-shot model, so the title slug wins.
    expect(b1!.slug).toBe('add-rate-limiting')
    const b1Slug = b1!.slug
    let events = await buildEvents(b1Slug)
    expect(typesOf(events)).toContain('workspace.provisioned')
    const startedExecutions = events.filter((event) => event.type === 'execution.started')
    expect(startedExecutions).toHaveLength(1)
    expect(startedExecutions[0]!.payload.commandId).toBeDefined()

    // The guest finished while no invocation ran: wait it out, then the next
    // invocation's settlement stage observes the ended execution and settles
    // completion, lease, and publication from durable facts alone.
    await until(
      async () => (await buildEvents(b1Slug)).some((event) => event.type === 'finalize.completed'),
      'guest B1 finalize.completed',
    )
    const executionsBeforeSettle = (await buildEvents(b1Slug)).filter(
      (event) => event.type === 'execution.started',
    ).length
    expect((await buildEvents(b1Slug)).some((event) => event.type === 'execution.ended')).toBe(
      false,
    )

    const second = await get({ authorization: 'Bearer cron-secret' })
    expect(second.status).toBe(200)
    expect(((await second.json()) as Body).repositories[0]!.outcome).toBe('ticked')
    events = await buildEvents(b1Slug)
    const ended = events.filter((event) => event.type === 'execution.ended')
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({
      payload: { outcome: 'completed', instance: expect.any(String) },
    })
    expect(events.filter((event) => event.type === 'execution.started')).toHaveLength(
      executionsBeforeSettle,
    )
    journalEvents = await journal()
    const settleTick = [...journalEvents]
      .reverse()
      .find((event) => event.type === 'dispatcher.tick-completed')
    expect(
      (settleTick!.payload as { counters?: { settled?: number } }).counters?.settled,
    ).toBeGreaterThanOrEqual(1)
    // The janitor merges the settled build's PR one tick later: the build
    // parks fully done, exactly as a local dispatcher would leave it. The
    // fake forge's native auto-merge is simulated by recording the merge.
    await mergePr(b1Slug)
    await tickUntil(
      async () => (await buildEvents(b1Slug)).some((event) => event.type === 'build.completed'),
      'guest B1 build.completed',
    )

    // ── Dashboard controls take effect on the next invocation. ─────────────
    const operatorToken = mintToken(storeEnv.AB_STORE_SECRET, {
      operator: { user: 'Operator' },
      exp: clock().getTime() + 3_600_000,
    })
    const operator = new OperatorApiClient({ url: serviceUrl, token: operatorToken })

    // Intake OFF ⇒ the next GET claims nothing; ON ⇒ claims resume.
    ticketBackend.add(readyTicket('T-3', { title: 'Add pagination' }))
    await operator.setIntake(REPO, false)
    expect((await get({ authorization: 'Bearer cron-secret' })).status).toBe(200)
    expect(ticketBackend.claims).not.toContain('T-3')
    await operator.setIntake(REPO, true)
    expect((await get({ authorization: 'Bearer cron-secret' })).status).toBe(200)
    expect(ticketBackend.claims).toContain('T-3')
    {
      let b3Slug = ''
      await until(async () => {
        const record = await buildForTicket('T-3')
        if (record === undefined) return false
        b3Slug = record.slug
        return (await buildEvents(record.slug)).some((event) => event.type === 'finalize.completed')
      }, 'guest B3 finalize.completed')
      await mergePr(b3Slug)
      await tickUntil(
        async () => (await buildEvents(b3Slug)).some((event) => event.type === 'build.completed'),
        'guest B3 build.completed',
      )
    }

    // Auto-merge default ON + durable pause: the build parks paused, the next
    // invocation performs no launch work for it, and the resume control makes
    // a later invocation launch it to completion with auto-merge applied.
    await operator.setAutoMergeDefault(REPO, true)
    ticketBackend.add(readyTicket('T-2', { title: 'Add request timeouts' }))
    holdImplement = new Promise<void>((resolve) => {
      releaseImplement = resolve
    })
    const pausedLaunch = await get({ authorization: 'Bearer cron-secret' })
    expect(pausedLaunch.status).toBe(200)
    expect(((await pausedLaunch.json()) as Body).repositories[0]!.outcome).toBe('ticked')
    expect(ticketBackend.claims).toContain('T-2')
    let b2Slug = ''
    await until(async () => {
      const record = await buildForTicket('T-2')
      if (record === undefined) return false
      const started = (await buildEvents(record.slug)).some(
        (event) => event.type === 'execution.started',
      )
      if (started) b2Slug = record.slug
      return started
    }, 'guest B2 launch')
    // Hold the guest mid-implement, then request the durable pause.
    await until(async () => implementHeld, 'guest B2 held mid-implement')
    await operator.controlBuild(REPO, b2Slug, { action: 'pause' })
    releaseImplement!()
    releaseImplement = undefined
    holdImplement = undefined
    await until(
      async () => (await buildEvents(b2Slug)).some((event) => event.type === 'build.paused'),
      'guest B2 parked paused',
    )
    await until(
      async () =>
        [...guestRuns.values()].filter((run) => run.slug === b2Slug).every((run) => run.finished),
      'guest B2 runner exit',
    )

    const executionsBeforePausedTick = (await buildEvents(b2Slug)).filter(
      (event) => event.type === 'execution.started',
    ).length
    expect((await get({ authorization: 'Bearer cron-secret' })).status).toBe(200)
    let pausedEvents = await buildEvents(b2Slug)
    expect(pausedEvents.filter((event) => event.type === 'execution.started')).toHaveLength(
      executionsBeforePausedTick,
    )
    expect(pausedEvents.some((event) => event.type === 'build.resumed')).toBe(false)
    expect(pausedEvents.some((event) => event.type === 'finalize.completed')).toBe(false)

    await operator.controlBuild(REPO, b2Slug, { action: 'resume' })
    expect((await get({ authorization: 'Bearer cron-secret' })).status).toBe(200)
    await waitForBuildEvent(b2Slug, 'finalize.completed', 'guest B2 finalize.completed')
    pausedEvents = await buildEvents(b2Slug)
    expect(pausedEvents.some((event) => event.type === 'build.resumed')).toBe(true)
    // The kernel's next-tick auto-merge decision: the finalize applied the
    // repository default to the opened PR through the forge.
    expect(
      fakeForge.autoMergeCalls.some((call) => call.enabled === true),
      JSON.stringify(fakeForge.autoMergeCalls),
    ).toBe(true)

    // ── Yield on overlap: a foreign lease holder stops all work. ───────────
    const claimsBeforeYield = ticketBackend.claims.length
    await backing.claimRepoLease(REPO, 'foreign-operator', 3_600_000)
    const yielded = await get({ authorization: 'Bearer cron-secret' })
    expect(yielded.status).toBe(200)
    expect(((await yielded.json()) as Body).repositories[0]!.outcome).toBe('ticked')
    expect(ticketBackend.claims.length).toBe(claimsBeforeYield)
    journalEvents = await journal()
    const yieldEvent = [...journalEvents]
      .reverse()
      .find((event) => event.type === 'dispatcher.tick-yielded')
    expect(yieldEvent).toBeDefined()
    expect(yieldEvent!.payload).toMatchObject({ holder: 'foreign-operator' })
    expect(runPayload(yieldEvent!).run).toMatch(/^hosted-dispatcher-/)

    // ── Bounded invocation: an expired budget skips further repositories. ──
    const boundedDispatched: string[] = []
    const clockBase = Date.now()
    let boundedCalls = 0
    const boundedClock = (() => {
      boundedCalls += 1
      return new Date(clockBase + (boundedCalls > 3 ? 30_000 : 0))
    }) as Clock
    const boundedEndpoint = createDispatcherEndpoint({
      env: {
        ...storeEnv,
        AB_DISPATCHER_ORIGIN: serviceUrl,
        AB_DISPATCHER_REPOSITORIES: 'https://github.com/acme/one,https://github.com/acme/two',
        AB_DISPATCHER_BUDGET_SECONDS: '25',
        CRON_SECRET: 'cron-secret',
      },
      clock: boundedClock,
      dispatch: async (opts) => {
        boundedDispatched.push(opts.repository!)
      },
    })
    const bounded = await boundedEndpoint.fetch(
      new Request('https://hosted.example.test/api/dispatch', {
        headers: { authorization: 'Bearer cron-secret' },
      }),
    )
    expect(bounded.status).toBe(200)
    expect(await bounded.json()).toEqual({
      ok: true,
      repositories: [
        {
          repository: 'https://github.com/acme/one',
          outcome: 'ticked',
          runId: expect.any(String),
        },
        { repository: 'https://github.com/acme/two', outcome: 'skipped' },
      ],
    })
    expect(boundedDispatched).toEqual(['https://github.com/acme/one'])

    // ── Every delegated request authenticated; guest env carries the ───────
    // ── deployment's own AB_STORE/AB_TOKEN. ────────────────────────────────
    expect(
      requests
        .filter((entry) => entry.path !== '/health')
        .every((entry) => entry.authorization !== null),
    ).toBe(true)
    expect(sessionEnvs.length).toBeGreaterThan(0)
    for (const session of sessionEnvs) {
      expect(session.store).toBe(serviceUrl)
      const token = session.token
      expect(token).toBeDefined()
      expect(mintedTokens).toContain(token!)
    }
    expect(kernelErrors.filter((line) => line.includes('cron-secret'))).toEqual([])
  } finally {
    server.stop(true)
    await backing.close()
    await rm(tmp, { recursive: true, force: true })
  }
}, 120_000)
