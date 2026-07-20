/**
 * `ab dispatch` (src/cli/dispatch.ts): the operator entry into the outer loop.
 *
 * The orchestration-unique surface is tested here — config loading, ticket
 * source selection, and the in-process fire-and-forget `launchRunner` that a
 * `--once` pass must drain before exiting. The Dispatcher + BuildRunner +
 * real-CLI pipeline itself is proven exhaustively by the integration harness
 * (src/integration/*.test.ts); this drives abDispatch over that same machinery
 * (real git worktrees, scripted agents on the REAL `ab` CLI) but with fakes
 * injected through the `wire` seam, and asserts a Ready ticket reaches PR-open
 * in one pass.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCliEnv } from './env'
import { runCli } from './main'
import { abDispatch, type DispatchWiring } from './dispatch'
import {
  renderDashboard,
  stripAnsi,
  type DashboardRenderer,
} from './dashboard/render'
import type {
  TerminalInput,
  TerminalInputEvent,
  TerminalOut,
} from './terminal'
import type { Config } from '../config/schema'
import { KERNEL, agentActor } from '../events/envelope'
import { randomUuids, sequentialIds } from '../ids'
import { reduceHarvest } from '../kernel/harvest'
import { FakeForge } from '../ports/forge/fake'
import type { OneShotCompletionInput } from '../ports/runner/one-shot'
import {
  defaultTurnResult,
  ScriptedAgentRunner,
  type ScriptContext,
} from '../ports/runner/fake'
import { FakeTicketSource } from '../ports/tickets/fake'
import type { Ticket } from '../ports/types'
import { GitWorktreeProvider, spawnExec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import { makeHarvestScanPacket, scanUnclaimedObservations } from '../processes/harvest'
import { systemClock, type Clock } from '../store/types'
import { manualClock } from '../testing/fixed'
import {
  CONFORMING_BODY,
  GIT_ID,
  git,
  happyHandlers,
  type Cli,
  type SkillHandlers,
} from '../integration/harness'

// The injected wire supplies a FakeTicketSource and ignores adapter details,
// but `[tickets]` is still required to name the mandatory ready state. This
// fixture pins that the complete table parses and flows through.
const DISPATCH_CONFIG_TOML = `
[project]
baseBranch = "main"

[commands]
test = "test -f ok.marker"

[verify]
steps = ["unit"]

[verify.unit]
kind = "check"
command = "test"

[policy]
stallRounds = 3

[dispatcher]
capacity = 1

[tickets]
source = "file"
dir = "tickets"
readyLabels = ["autobuild"]
# These tests inject a FakeTicketSource (exact, case-sensitive state match) whose
# tickets default to state "Ready", so the gate names that state verbatim — the
# file source's canonicalization is exercised in dispatcher-file-tickets.test.ts.
readyState = "Ready"
`

async function initOrigin(dir: string, toml = DISPATCH_CONFIG_TOML): Promise<void> {
  await mkdir(dir, { recursive: true })
  await git(['init', '-q', '-b', 'main'], dir)
  await writeFile(join(dir, 'autobuild.toml'), toml)
  await writeFile(join(dir, 'README.md'), 'dispatch e2e origin\n')
  await git(['add', '-A'], dir)
  await git([...GIT_ID, 'commit', '-q', '-m', 'initial'], dir)
}

interface Fixture {
  tmp: string
  origin: string
  store: MemoryBuildStore
  tickets: FakeTicketSource
  forge: FakeForge
  agents: ScriptedAgentRunner
  cliErrors: string[]
  err: string[]
  /** The injectable wire abDispatch is called with (fakes over real git). */
  wire: () => DispatchWiring
  cleanup: () => Promise<void>
}

/** A wire that supplies fakes over a REAL git worktree provider and a scripted
 * agent driving the real `ab` CLI (the harness happy-path handlers). */
async function makeFixture(
  ticket: Ticket | Ticket[],
  handlers: SkillHandlers,
  toml = DISPATCH_CONFIG_TOML,
  clock: Clock = systemClock,
): Promise<Fixture> {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-dispatch-'))
  const originPath = join(tmp, 'origin')
  await initOrigin(originPath, toml)
  // Git reports its common directory canonically (macOS temp paths gain the
  // `/private` prefix), so fixtures use that same repository identity.
  const origin = await realpath(originPath)

  const ids = sequentialIds()
  const store = new MemoryBuildStore({ clock })
  const forge = new FakeForge()
  const tickets = new FakeTicketSource(Array.isArray(ticket) ? ticket : [ticket])
  const workspaces = new GitWorktreeProvider({ root: join(tmp, 'worktrees') })
  const cliErrors: string[] = []

  // The script IS the agent (§9): route by skill, hand the handler the real
  // CLI bound to this turn's ambient env (D8) over the shared store — exactly
  // as the integration harness does.
  const makeCli = (ctx: ScriptContext): Cli => {
    const env = resolveCliEnv(ctx.opts.env)
    const ws = ctx.opts.workspacePath
    const run = async (argv: string[]): Promise<string[]> => {
      const out: string[] = []
      const errLines: string[] = []
      const code = await runCli(argv, {
        store,
        env,
        workspacePath: ws,
        forge,
        exec: spawnExec,
        ids,
        clock,
        stdout: (line) => out.push(line),
        stderr: (line) => errLines.push(line),
      })
      if (code !== 0) {
        const message = `ab ${argv.join(' ')} exited ${code}: ${errLines.join('\n') || '(no stderr)'}`
        cliErrors.push(message)
        throw new Error(message)
      }
      return out
    }
    return { run, ws, round: env.round, env, ctx }
  }
  const agents = new ScriptedAgentRunner({
    script: async (ctx) => {
      const handler = handlers[ctx.opts.skill] ?? handlers[ctx.opts.skill.replace(/^ab-/, '')]
      if (handler === undefined) throw new Error(`no handler for skill "${ctx.opts.skill}"`)
      return (await handler(makeCli(ctx))) ?? defaultTurnResult(`${ctx.opts.skill} finished`)
    },
  })

  const wire = (): DispatchWiring => ({
    store,
    tickets,
    forge,
    workspaces,
    runtimes: { scripted: { runner: agents, servesModels: [] } },
    defaultRuntime: 'scripted',
    storeRef: 'memory', // unused: the scripted CLI writes the shared store by ref
    ids,
    uuids: randomUuids(),
    clock,
  })

  return {
    tmp,
    origin,
    store,
    tickets,
    forge,
    agents,
    cliErrors,
    err: [],
    wire,
    cleanup: async () => {
      await store.close()
      await rm(tmp, { recursive: true, force: true })
    },
  }
}

function readyTicket(id: string, over: Partial<Omit<Ticket, 'ref'>> = {}): Ticket {
  const title = over.title ?? 'Add rate limiting'
  return {
    ref: { source: 'fake', id, title },
    title,
    body: over.body ?? CONFORMING_BODY,
    state: over.state ?? 'Ready',
    labels: over.labels ?? ['autobuild'],
    ...(over.blockedBy !== undefined ? { blockedBy: over.blockedBy } : {}),
  }
}

describe('abDispatch guards', () => {
  test('missing autobuild.toml is an actionable error', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ab-dispatch-'))
    try {
      await expect(
        abDispatch({
          targetRepo: tmp,
          env: {},
          exec: spawnExec,
          stdout: () => {},
          stderr: () => {},
          once: true,
        }),
      ).rejects.toThrow(/autobuild\.toml: not found/)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('a config with no [tickets] table fails at tickets.readyState before wiring', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ab-dispatch-'))
    try {
      await writeFile(
        join(tmp, 'autobuild.toml'),
        '[project]\nbaseBranch = "main"\n[dispatcher]\ncapacity = 1\n',
      )
      let wired = false

      await expect(
        abDispatch({
          targetRepo: tmp,
          env: {},
          exec: spawnExec,
          stdout: () => {},
          stderr: () => {},
          once: true,
          wire: () => {
            wired = true
            throw new Error('wire must not run for invalid config')
          },
        }),
      ).rejects.toThrow('tickets.readyState')
      expect(wired).toBe(false)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('uses --store over AB_STORE and normalizes either against the main repo', async () => {
    const fx = await makeFixture([], happyHandlers())
    const seen: string[] = []
    try {
      const run = (env: Record<string, string | undefined>, storeRef?: string) =>
        abDispatch({
          targetRepo: fx.origin,
          env,
          exec: spawnExec,
          stdout: () => {},
          stderr: (line) => fx.err.push(line),
          once: true,
          ...(storeRef !== undefined ? { storeRef } : {}),
          wire: (_config, resolved) => {
            seen.push(resolved.storeRef!)
            return fx.wire()
          },
        })

      await run({ AB_STORE: 'environment-state' }, 'flag-state')
      await run({ AB_STORE: 'environment-state' })
      await run({})
      expect(seen).toEqual([
        join(fx.origin, 'flag-state'),
        join(fx.origin, 'environment-state'),
        join(fx.origin, '.autobuild'),
      ])
      expect(fx.err).toEqual([])
    } finally {
      await fx.cleanup()
    }
  })

  test('a config naming an unregistered runtime fails loudly at startup, before any build (§9)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ab-dispatch-'))
    try {
      await writeFile(
        join(tmp, 'autobuild.toml'),
        '[tickets]\nsource = "file"\nreadyState = "ready"\n[roles.default]\nruntime = "ghost"\n',
      )
      const store = new MemoryBuildStore({ clock: systemClock })
      await expect(
        abDispatch({
          targetRepo: tmp,
          env: {},
          exec: spawnExec,
          stdout: () => {},
          stderr: () => {},
          once: true,
          wire: () => ({
            store,
            tickets: new FakeTicketSource([]),
            forge: new FakeForge(),
            workspaces: new GitWorktreeProvider({ root: join(tmp, 'worktrees') }),
            runtimes: {
              claude: {
                runner: new ScriptedAgentRunner({ script: () => defaultTurnResult() }),
                servesModels: ['claude-'],
              },
            },
            defaultRuntime: 'claude',
            storeRef: join(tmp, 'store'),
            ids: sequentialIds(),
            uuids: randomUuids(),
            clock: systemClock,
          }),
        }),
      ).rejects.toThrow(/runtime "ghost", which is not registered/)
      await store.close()
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})

describe('abDispatch --once', () => {
  test('dispatches a Ready ticket and runs the build in-process to PR-open', async () => {
    const fx = await makeFixture(readyTicket('T-1'), happyHandlers())
    const out: string[] = []
    try {
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: (line) => out.push(line),
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
      })

      // Seam integrity: no `ab` invocation failed inside the scripted agents.
      expect(fx.cliErrors).toEqual([])

      // The ticket produced exactly one build, dispatched and claimed.
      const builds = await fx.store.listBuilds()
      expect(builds).toHaveLength(1)
      const slug = builds[0]!.slug
      // This injected runtime has no optional one-shot capability, so the CLI
      // still completes through the deterministic title fallback.
      expect(slug).toBe('add-rate-limiting')
      expect(builds[0]!.branch).toBe('ab/add-rate-limiting')
      expect(builds[0]!.ticket?.id).toBe('T-1')

      // launchRunner actually RAN the build in-process (drain-on-once): the
      // happy path walks all the way to finalize, whose `ab done` opens the PR.
      const events = (await fx.store.getEvents(slug)).map((e) => e.type)
      expect(events).toContain('spec.imported')
      expect(events).toContain('finalize.completed')
      expect(fx.forge.opened).toHaveLength(1)

      // The operator saw the build park.
      expect(out.some((line) => line.includes(`build ${slug} parked`))).toBe(true)
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('claim-time auto-merge is visible on the first build frame and survives a default-off restart', async () => {
    const fx = await makeFixture(
      readyTicket('T-auto-default', { title: 'Automatic landing' }),
      happyHandlers(),
    )
    const firstTerminal = fakeTerminal(true, { columns: 180 })
    try {
      await abDispatch({
        targetRepo: fx.origin,
        env: { USER: 'dispatch-op' },
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        once: true,
        defaultAutoMerge: true,
        wire: fx.wire,
        terminal: firstTerminal,
      })

      const [record] = await fx.store.listBuilds()
      expect(record).toBeDefined()
      const events = await fx.store.getEvents(record!.slug)
      const types = events.map((event) => event.type)
      expect(types.indexOf('build.auto-merge-requested')).toBeGreaterThan(
        types.indexOf('build.created'),
      )
      expect(types.indexOf('build.auto-merge-requested')).toBeLessThan(
        types.indexOf('workspace.provisioned'),
      )
      const request = events.find(
        (event) => event.type === 'build.auto-merge-requested',
      )
      expect(request?.actor).toEqual({ kind: 'human', user: 'dispatch-op' })

      const firstBuildFrame = firstTerminal.frames.find((frame) =>
        stripAnsi(frame).includes(record!.slug),
      )
      expect(firstBuildFrame).toBeDefined()
      expect(stripAnsi(firstBuildFrame!)).toContain('auto merge')
      expect(stripAnsi(firstTerminal.all())).toContain(
        'auto merge default ON',
      )

      const beforeRestart = await fx.store.getEvents(record!.slug)
      const restartTerminal = fakeTerminal(true, { columns: 180 })
      await abDispatch({
        targetRepo: fx.origin,
        env: { USER: 'another-op' },
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
        terminal: restartTerminal,
      })

      expect(await fx.store.getEvents(record!.slug)).toEqual(beforeRestart)
      const restarted = stripAnsi(restartTerminal.all())
      expect(restarted).toContain('auto merge default OFF')
      expect(restarted).toContain('auto merge')
      expect(
        (await fx.store.getEvents(record!.slug)).filter(
          (event) => event.type === 'build.auto-merge-requested',
        ),
      ).toHaveLength(1)
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('initial intake off skips new claims while janitor still advances existing builds', async () => {
    const fx = await makeFixture(
      readyTicket('T-existing', { title: 'Existing work' }),
      happyHandlers(),
      DISPATCH_CONFIG_TOML.replace('capacity = 1', 'capacity = 2'),
    )
    try {
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
      })
      const [existing] = await fx.store.listBuilds()
      expect(existing).toBeDefined()
      expect(fx.tickets.claims).toEqual(['T-existing'])

      fx.forge.setPrState(1, { state: 'merged', sha: 'merged-existing' })
      fx.tickets.add(readyTicket('T-new', { title: 'New work' }))
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        once: true,
        intake: false,
        wire: fx.wire,
      })

      expect(fx.tickets.claims).toEqual(['T-existing'])
      expect((await fx.store.listBuilds()).map((record) => record.slug)).toEqual([
        existing!.slug,
      ])
      expect(
        (await fx.store.getEvents(existing!.slug)).some(
          (event) =>
            event.type === 'build.completed' && event.payload.outcome === 'merged',
        ),
      ).toBe(true)
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('routes the slug role to a one-shot capability with the full spec and configured model', async () => {
    const toml = `${DISPATCH_CONFIG_TOML}
[roles.default]
runtime = "scripted"

[roles.slug]
runtime = "namer"
model = "gpt-slug-name"
`
    const fx = await makeFixture(
      readyTicket('T-named', {
        title: 'Please add support for throttling repeated login attempts',
      }),
      happyHandlers(),
      toml,
    )
    const calls: OneShotCompletionInput[] = []
    const baseWire = fx.wire
    const wire = (): DispatchWiring => {
      const wiring = baseWire()
      const oneShot = {
        complete: async (input: OneShotCompletionInput) => {
          calls.push(input)
          return { text: 'login-rate-limit' }
        },
      }
      return {
        ...wiring,
        runtimes: {
          ...wiring.runtimes,
          namer: {
            runner: wiring.runtimes['scripted']!.runner,
            oneShot,
            servesModels: ['gpt-'],
          },
        },
      }
    }

    try {
      await abDispatch({
        targetRepo: fx.origin,
        env: { NAMING_API_KEY: 'secret' },
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        once: true,
        wire,
      })

      expect(calls).toHaveLength(1)
      expect(calls[0]?.prompt).toContain(CONFORMING_BODY)
      expect(calls[0]?.prompt).toContain('one to three meaningful words')
      expect(calls[0]?.cwd).toBe(fx.origin)
      expect(calls[0]?.env['NAMING_API_KEY']).toBe('secret')
      expect(calls[0]?.model).toBe('gpt-slug-name')
      expect(calls[0]?.signal).toBeInstanceOf(AbortSignal)

      const [build] = await fx.store.listBuilds()
      expect(build?.slug).toBe('login-rate-limit')
      expect(build?.branch).toBe('ab/login-rate-limit')
      expect(fx.cliErrors).toEqual([])
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  /**
   * The observability criterion: a dependency-blocked ticket and its
   * unresolved blockers must be discoverable from dispatcher output alone —
   * no provider API, filesystem, or database inspection.
   *
   * Also the regression guard for printReport's shape assumption: it filters
   * `Object.entries(report)` by `count > 0`, which silently drops a non-numeric
   * field (an array is never `> 0`, and TypeScript does not complain). Without
   * this test, the diagnostics could vanish from output while the counter
   * incremented, and every other test would still pass.
   */
  test('prints dependency diagnostics as lines AND still prints numeric counts', async () => {
    const fx = await makeFixture(
      [
        readyTicket('T-blocked', { title: 'Blocked work', blockedBy: ['T-9'] }),
        readyTicket('T-9', { title: 'The blocker', state: 'In Progress' }),
        readyTicket('T-free', { title: 'Unrelated work' }),
      ],
      happyHandlers(),
    )
    const out: string[] = []
    try {
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: (line) => out.push(line),
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
      })

      expect(out).toContain('ticket T-blocked blocked by T-9 (not complete)')
      const tick = out.find((line) => line.startsWith('tick: '))
      expect(tick).toContain('dependencyBlocked=1')
      // The counts line survives the array field rather than throwing or
      // rendering `dependencyDiagnostics=[object Object]`.
      expect(tick).not.toContain('dependencyDiagnostics')
      // The blocked ticket built nothing, while the unrelated eligible ticket
      // in the same ready list dispatched — the gate is per-ticket, not a
      // per-tick abort. (T-9 never appears: `readyState = "Ready"` gates the
      // scan, so an In-Progress ticket is not a candidate in the first place —
      // see readyCriteria.)
      const builds = await fx.store.listBuilds()
      expect(builds.map((b) => b.ticket?.id)).toEqual(['T-free'])
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('a new invocation retries a current build parked by an infrastructure policy failure', async () => {
    const handlers = happyHandlers()
    const happyPlan = handlers.plan!
    let planAttempts = 0
    handlers.plan = async (cli) => {
      planAttempts += 1
      if (planAttempts <= 2) return defaultTurnResult('ended without a terminal')
      return happyPlan(cli)
    }
    const fx = await makeFixture(readyTicket('T-retry'), handlers)
    const firstOut: string[] = []
    const secondOut: string[] = []
    try {
      // The first invocation exhausts the runner's two-attempt infra budget
      // and parks on a policy escalation.
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: (line) => firstOut.push(line),
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
      })
      const [record] = await fx.store.listBuilds()
      expect(record).toBeDefined()
      const slug = record!.slug
      expect((await fx.store.getEvents(slug)).at(-1)?.type).toBe('escalation.raised')

      // Simulate the prior dispatch process being gone long enough for its
      // lease to lapse. MemoryBuildStore has no manual clock in this e2e seam,
      // so release by the recorded holder is the equivalent lease state.
      expect(record!.lease).toBeDefined()
      await fx.store.releaseLease(slug, record!.lease!.holder)

      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: (line) => secondOut.push(line),
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
      })

      const events = await fx.store.getEvents(slug)
      const retry = events.find(
        (event) =>
          event.type === 'escalation.answered' && event.payload.resolution === 'retry',
      )
      expect(retry?.actor).toEqual({ kind: 'dispatcher' })
      expect(events.map((event) => event.type)).toContain('finalize.completed')
      expect(secondOut).toContain('tick: resumed=1')
      expect(planAttempts).toBe(3)
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('resumes an open harvest on startup and a later --once tick does not re-file it', async () => {
    const fx = await makeFixture(
      [],
      happyHandlers(),
      `${DISPATCH_CONFIG_TOML}\n[harvest]\nthreshold = 1\n`,
    )
    const run = 'h_dispatch_resume'
    const out: string[] = []
    try {
      await fx.store.createBuild({ slug: 'observation-source', repo: fx.origin })
      await fx.store.append('observation-source', {
        actor: agentActor('implement', 's_old'),
        type: 'observation.recorded',
        payload: {
          id: 'obs-dispatch-resume',
          kind: 'latent-bug',
          summary: 'resume the repository workflow on dispatcher startup',
        },
      })
      const scan = await scanUnclaimedObservations(fx.store, fx.origin)
      const packet = await makeHarvestScanPacket({
        store: fx.store,
        tickets: fx.tickets,
        repo: fx.origin,
        run,
        observations: scan.observations,
        state: scan.state,
      })
      await fx.store.appendRepoWithArtifacts(
        fx.origin,
        [{ kind: 'harvest-scan', content: JSON.stringify(packet) }],
        (deposited) => ({
          actor: KERNEL,
          type: 'harvest.started',
          payload: {
            run,
            observations: scan.observations.map((item) => item.occurrence),
            scan: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
          },
        }),
      )
      const proposals = {
        proposals: [
          {
            action: 'create' as const,
            title: 'Resume repository harvest safely',
            whatWhy: 'A durable open workflow must resume after dispatch restarts.',
            acceptanceCriteria: ['The existing proposal is filed exactly once.'],
            outOfScope: ['Unrelated dispatcher behavior.'],
            observations: scan.observations.map((item) => item.occurrence),
          },
        ],
      }
      await fx.store.appendRepoWithArtifacts(
        fx.origin,
        [{ kind: 'harvest-proposals', content: JSON.stringify(proposals) }],
        (deposited) => ({
          actor: agentActor('harvest', 'hs_old'),
          type: 'harvest.proposals.submitted',
          payload: {
            run,
            round: 1,
            artifact: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
          },
        }),
      )
      await fx.store.appendRepoWithArtifacts(
        fx.origin,
        [{ kind: 'harvest-review', content: 'approved before restart\n' }],
        (deposited) => ({
          actor: agentActor('harvest-review', 'hr_old'),
          type: 'harvest.review.verdict',
          payload: {
            run,
            round: 1,
            verdict: 'approve',
            findings: [],
            artifact: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
          },
        }),
      )

      const originalCreate = fx.tickets.create.bind(fx.tickets)
      let releaseCreate!: () => void
      const createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve
      })
      let markCreateStarted!: () => void
      const createStarted = new Promise<void>((resolve) => {
        markCreateStarted = resolve
      })
      fx.tickets.create = async (...args) => {
        markCreateStarted()
        await createGate
        return originalCreate(...args)
      }

      const dispatch = abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: (line) => out.push(line),
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
      })
      let dispatchSettled = false
      void dispatch.then(
        () => {
          dispatchSettled = true
        },
        () => {
          dispatchSettled = true
        },
      )
      await createStarted
      await Promise.resolve()
      expect(dispatchSettled).toBe(false)
      releaseCreate()
      await dispatch

      expect(reduceHarvest(await fx.store.getRepoEvents(fx.origin)).latest).toMatchObject({
        run,
        status: 'completed',
      })
      expect((await fx.tickets.get('fake-1'))?.state).toBe('Triage')
      expect(await fx.tickets.get('fake-2')).toBeNull()
      expect(out).toContain('tick: harvestResumed=1 harvestCompleted=1')

      const eventCount = (await fx.store.getRepoEvents(fx.origin)).length
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
      })
      expect(await fx.tickets.get('fake-2')).toBeNull()
      expect(await fx.store.getRepoEvents(fx.origin)).toHaveLength(eventCount)
      expect(fx.cliErrors).toEqual([])
      expect(fx.err).toEqual([])
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('automatically recovers a failed approved run before starting anything new', async () => {
    const fx = await makeFixture(
      [],
      happyHandlers(),
      `${DISPATCH_CONFIG_TOML}\n[harvest]\nthreshold = 1\n`,
    )
    const run = 'h_failed_dispatch'
    const out: string[] = []
    try {
      await fx.store.createBuild({ slug: 'failed-source', repo: fx.origin })
      await fx.store.append('failed-source', {
        actor: agentActor('implement', 's_failed'),
        type: 'observation.recorded',
        payload: {
          id: 'obs-failed-dispatch',
          kind: 'latent-bug',
          summary: 'recover this approved run automatically',
        },
      })
      const scan = await scanUnclaimedObservations(fx.store, fx.origin)
      const packet = await makeHarvestScanPacket({
        store: fx.store,
        tickets: fx.tickets,
        repo: fx.origin,
        run,
        observations: scan.observations,
        state: scan.state,
      })
      await fx.store.appendRepoWithArtifacts(
        fx.origin,
        [{ kind: 'harvest-scan', content: JSON.stringify(packet) }],
        (deposited) => ({
          actor: KERNEL,
          type: 'harvest.started',
          payload: {
            run,
            observations: scan.observations.map((item) => item.occurrence),
            scan: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
          },
        }),
      )
      await fx.store.appendRepoWithArtifacts(
        fx.origin,
        [
          {
            kind: 'harvest-proposals',
            content: JSON.stringify({
              proposals: [
                {
                  action: 'create',
                  title: 'Recover approved harvest automatically',
                  whatWhy: 'The approved work must survive an infrastructure stop.',
                  acceptanceCriteria: ['The frozen proposal is filed once.'],
                  outOfScope: ['Starting a replacement harvest run.'],
                  observations: scan.observations.map(
                    (item) => item.occurrence,
                  ),
                },
              ],
            }),
          },
        ],
        (deposited) => ({
          actor: agentActor('harvest', 'hs_failed'),
          type: 'harvest.proposals.submitted',
          payload: {
            run,
            round: 1,
            artifact: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
          },
        }),
      )
      await fx.store.appendRepoWithArtifacts(
        fx.origin,
        [{ kind: 'harvest-review', content: 'approved before failure\n' }],
        (deposited) => ({
          actor: agentActor('harvest-review', 'hr_failed'),
          type: 'harvest.review.verdict',
          payload: {
            run,
            round: 1,
            verdict: 'approve',
            findings: [],
            artifact: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
          },
        }),
      )
      await fx.store.appendRepo(fx.origin, {
        actor: KERNEL,
        type: 'harvest.failed',
        payload: {
          run,
          step: 'file',
          attempt: 2,
          error: 'temporary ticket outage',
          willRetry: false,
        },
      })

      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: (line) => out.push(line),
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
      })

      const events = await fx.store.getRepoEvents(fx.origin)
      expect(reduceHarvest(events).latest).toMatchObject({
        run,
        status: 'completed',
        recoveryRequests: [
          { attempt: 1, limit: 2, acknowledgedSeq: expect.any(Number) },
        ],
      })
      expect(
        events.filter((event) => event.type === 'harvest.started'),
      ).toHaveLength(1)
      expect(
        events.filter(
          (event) => event.type === 'harvest.recovery-requested',
        ),
      ).toHaveLength(1)
      expect(
        events.filter((event) => event.type === 'harvest.proposal.filed'),
      ).toHaveLength(1)
      expect(await fx.tickets.get('fake-1')).not.toBeNull()
      expect(await fx.tickets.get('fake-2')).toBeNull()
      expect(out).toContain('tick: harvestResumed=1 harvestCompleted=1')
      expect(fx.err).toEqual([])
    } finally {
      await fx.cleanup()
    }
  }, 30_000)
})

describe('abDispatch watch build-runner coordination', () => {
  test('stale-lease polling cannot open competing sessions for one phase attempt', async () => {
    const handlers = happyHandlers()
    const happyCodeReview = handlers['code-review']!
    let releaseFirst!: () => void
    let firstReleased = false
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = () => {
        if (firstReleased) return
        firstReleased = true
        resolve()
      }
    })
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    let reviewTurns = 0
    handlers['code-review'] = async (cli) => {
      reviewTurns += 1
      if (reviewTurns === 1) {
        markFirstStarted()
        await firstGate
        return defaultTurnResult('first review ended without a terminal')
      }
      return happyCodeReview(cli)
    }

    const clock = manualClock()
    const fx = await makeFixture(
      readyTicket('T-session-single-flight'),
      handlers,
      DISPATCH_CONFIG_TOML,
      clock,
    )
    const stop = new AbortController()
    const out: string[] = []
    let sleeps = 0
    let turnsWhileFirstLive = 0
    let sessionsWhileFirstLive = 0
    let attachmentsWhileFirstLive = 0
    let dispatch: Promise<void> | undefined

    try {
      dispatch = abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: (line) => out.push(line),
        stderr: (line) => fx.err.push(line),
        signal: stop.signal,
        intervalMs: 1,
        sleep: async () => {
          sleeps += 1
          if (sleeps === 1) {
            // Hold the real code-review turn open, then make its build lease
            // look stale before the next watch tick. The heartbeat uses real
            // time, so this manual-clock jump creates the reported race
            // deterministically without waiting a minute.
            await firstStarted
            clock.advance(61_000)
            return
          }
          if (sleeps === 2) {
            // Permit another full lease-sweep tick over the same stale record.
            return
          }

          const [record] = await fx.store.listBuilds()
          const events = await fx.store.getEvents(record!.slug)
          const ended = new Set(
            events
              .filter((event) => event.type === 'session.ended')
              .map((event) => event.payload.session),
          )
          const liveReviews = events.filter(
            (event) =>
              event.type === 'session.started' &&
              event.payload.phase === 'code-review' &&
              !ended.has(event.payload.session),
          )
          turnsWhileFirstLive = reviewTurns
          sessionsWhileFirstLive = liveReviews.length
          attachmentsWhileFirstLive = events.filter(
            (event) => event.type === 'runner.attached',
          ).length

          // The first session is now confirmed ended without a terminal. The
          // same BuildRunner's bounded retry may start one fresh session; it
          // must happen sequentially, never as a polling-launched competitor.
          releaseFirst()
          await waitFor(
            async () =>
              (await fx.store.getEvents(record!.slug)).some(
                (event) => event.type === 'finalize.completed',
              ),
            10_000,
          )
          stop.abort()
        },
        wire: fx.wire,
      })
      await dispatch

      expect(sleeps).toBe(3)
      expect(turnsWhileFirstLive).toBe(1)
      expect(sessionsWhileFirstLive).toBe(1)
      expect(attachmentsWhileFirstLive).toBe(1)

      const [record] = await fx.store.listBuilds()
      const events = await fx.store.getEvents(record!.slug)
      const reviewSessionIds = new Set(
        events.flatMap((event) =>
          event.type === 'session.started' &&
          event.payload.phase === 'code-review'
            ? [event.payload.session]
            : [],
        ),
      )
      const reviewStarts = events.filter(
        (event) =>
          event.type === 'session.started' &&
          event.payload.phase === 'code-review',
      )
      const reviewEnds = events.filter(
        (event) =>
          event.type === 'session.ended' &&
          reviewSessionIds.has(event.payload.session),
      )
      const reviewFailures = events.filter(
        (event) =>
          event.type === 'phase.failed' &&
          event.payload.phase === 'code-review' &&
          event.payload.round === 1,
      )
      const verdicts = events.filter(
        (event) => event.type === 'code-review.verdict',
      )

      expect(reviewStarts).toHaveLength(2)
      expect(reviewEnds).toHaveLength(2)
      expect(reviewFailures).toHaveLength(1)
      expect(verdicts).toHaveLength(1)
      expect(reviewEnds[0]!.seq).toBeLessThan(reviewStarts[1]!.seq)
      expect(
        events.filter((event) => event.type === 'runner.attached'),
      ).toHaveLength(1)
      // Suppressed sweeps are no-ops, not inflated observability counters;
      // one successful verdict also means there was no D5 terminal race.
      expect(out.some((line) => line.includes('swept='))).toBe(false)
      expect(fx.cliErrors).toEqual([])
      expect(fx.err).toEqual([])
    } finally {
      releaseFirst()
      stop.abort()
      await dispatch?.catch(() => {})
      await fx.cleanup()
    }
  }, 30_000)

  test('a launch preflight failure releases the slug for a later sweep', async () => {
    const fx = await makeFixture(
      readyTicket('T-launch-preflight-retry'),
      happyHandlers(),
    )
    const originalGetBuild = fx.store.getBuild.bind(fx.store)
    let failedPreflight = false
    fx.store.getBuild = async (slug) => {
      const record = await originalGetBuild(slug)
      // uniqueSlug probes before createBuild and sees null. Fail only the first
      // post-provision lookup inside DispatchLoop.launchRunner.
      if (record !== null && !failedPreflight) {
        failedPreflight = true
        throw new Error('scripted launch preflight failure')
      }
      return record
    }

    const stop = new AbortController()
    const err: string[] = []
    let sleeps = 0
    let dispatch: Promise<void> | undefined
    try {
      dispatch = abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => err.push(line),
        signal: stop.signal,
        intervalMs: 1,
        sleep: async () => {
          sleeps += 1
          if (sleeps === 1) return
          const [record] = await fx.store.listBuilds()
          await waitFor(
            async () =>
              (await fx.store.getEvents(record!.slug)).some(
                (event) => event.type === 'finalize.completed',
              ),
            10_000,
          )
          stop.abort()
        },
        wire: fx.wire,
      })
      await dispatch

      expect(failedPreflight).toBe(true)
      expect(sleeps).toBe(2)
      expect(err).toEqual([
        'tick failed: scripted launch preflight failure',
      ])
      const [record] = await fx.store.listBuilds()
      expect(
        (await fx.store.getEvents(record!.slug)).filter(
          (event) => event.type === 'runner.attached',
        ),
      ).toHaveLength(1)
      expect(fx.cliErrors).toEqual([])
    } finally {
      stop.abort()
      await dispatch?.catch(() => {})
      await fx.cleanup()
    }
  }, 30_000)
})

describe('abDispatch watch harvest coordination', () => {
  test('long harvest work does not block later ticks or SIGINT', async () => {
    const fx = await makeFixture(
      [],
      happyHandlers(),
      `${DISPATCH_CONFIG_TOML}\n[harvest]\nthreshold = 1\n`,
    )
    let releaseTurn!: () => void
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    let markStarted!: () => void
    const agentStarted = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let turnReleased = false
    const blockingAgents = new ScriptedAgentRunner({
      script: async () => {
        markStarted()
        await turnGate
        return defaultTurnResult('released without terminal')
      },
    })
    const run = 'h_watch_responsive'
    const stop = new AbortController()
    const out: string[] = []
    let sleeps = 0

    try {
      await fx.store.ensureRepo(fx.origin)
      const packet = {
        repo: fx.origin,
        run,
        observations: [
          {
            occurrence: { build: 'observation-source', seq: 1 },
            id: 'obs-watch-responsive',
            kind: 'latent-bug' as const,
            summary: 'a long harvest must not stop the outer loop',
            ts: '2026-07-15T12:00:00.000Z',
          },
        ],
        ledger: [],
      }
      await fx.store.appendRepoWithArtifacts(
        fx.origin,
        [{ kind: 'harvest-scan', content: JSON.stringify(packet) }],
        (deposited) => ({
          actor: KERNEL,
          type: 'harvest.started',
          payload: {
            run,
            observations: [{ build: 'observation-source', seq: 1 }],
            scan: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
          },
        }),
      )

      const dispatch = abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: (line) => out.push(line),
        stderr: (line) => fx.err.push(line),
        signal: stop.signal,
        intervalMs: 1,
        sleep: async () => {
          sleeps += 1
          if (sleeps === 1) {
            await agentStarted
          } else {
            stop.abort()
          }
        },
        wire: () => ({
          ...fx.wire(),
          runtimes: {
            scripted: { runner: blockingAgents, servesModels: [] },
          },
        }),
      })

      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          dispatch,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('dispatch stayed blocked on harvest')),
              1_000,
            )
          }),
        ])
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
      }
      expect(turnReleased).toBe(false)
      expect(sleeps).toBe(2)
      expect(blockingAgents.sessions.size).toBe(1)
      expect(out).toContain('ab dispatch stopped')

      turnReleased = true
      releaseTurn()
      await waitFor(async () =>
        (await fx.store.getRepoEvents(fx.origin)).some(
          (event) =>
            event.type === 'harvest.step.completed' &&
            event.payload.outcome === 'failed',
        ),
      )
      await waitFor(async () => (await fx.store.getRepo(fx.origin))?.lease === undefined)
      expect(fx.err).toEqual([])
    } finally {
      if (!turnReleased) releaseTurn()
      await fx.cleanup()
    }
  }, 30_000)
})

/** Test convenience names map to the raw normalized events production emits.
 * Command letters remain printable text at the terminal seam. */
type FakeInputKey =
  | 'up'
  | 'down'
  | 'auto-merge'
  | 'pause'
  | 'letter-d'
  | 'interrupt'
  | 'enter'
  | 'backspace'
  | 'escape'

function fakeInputEvent(key: FakeInputKey): TerminalInputEvent {
  switch (key) {
    case 'auto-merge':
      return { type: 'text', text: 'm' }
    case 'pause':
      return { type: 'text', text: 'p' }
    case 'letter-d':
      return { type: 'text', text: 'd' }
    default:
      return { type: key }
  }
}

/** A TerminalInput that records lifecycle and can send text/editing events. */
function fakeInput(initial: FakeInputKey[] = []): TerminalInput & {
  press: (key: FakeInputKey) => void
  text: (text: string) => void
  starts: number
  cleanups: number
} {
  let onInput: ((input: TerminalInputEvent) => void) | undefined
  const input = {
    starts: 0,
    cleanups: 0,
    start(handler: (event: TerminalInputEvent) => void): () => void {
      input.starts += 1
      onInput = handler
      for (const key of initial) handler(fakeInputEvent(key))
      let cleaned = false
      return () => {
        if (cleaned) return
        cleaned = true
        input.cleanups += 1
        onInput = undefined
      }
    },
    press(key: FakeInputKey): void {
      onInput?.(fakeInputEvent(key))
    },
    text(text: string): void {
      onInput?.({ type: 'text', text })
    },
  }
  return input
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= end) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function fakeTerminal(
  interactive = true,
  size: { columns?: number; rows?: number } = {},
): TerminalOut & { frames: string[]; all: () => string } {
  const frames: string[] = []
  return {
    frames,
    all: () => frames.join(''),
    write: (chunk) => {
      frames.push(chunk)
    },
    columns: size.columns ?? 120,
    rows: size.rows ?? 40,
    interactive,
  }
}

/** The longest run of consecutive painted lines the region wrote — i.e. the
 * tallest frame it will later have to cursor UP over. */
function tallestFrame(term: { frames: string[] }): number {
  return Math.max(
    0,
    ...term.frames
      .filter((chunk) => chunk.includes('\n'))
      .map((chunk) => chunk.split('\n').length - 1),
  )
}

describe('abDispatch --once with an interactive terminal', () => {
  // The existing tests above pass an opts object with NO terminal, and they
  // pass unchanged — that is the regression proof for "absent terminal ⇒
  // non-interactive ⇒ plain ⇒ today's exact behavior". These add the
  // interactive path on top.

  test('paints a dashboard frame naming the build and its progress', async () => {
    const fx = await makeFixture(readyTicket('T-tty'), happyHandlers())
    const term = fakeTerminal()
    const out: string[] = []
    try {
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: (line) => out.push(line),
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
        terminal: term,
      })

      const builds = await fx.store.listBuilds()
      const slug = builds[0]!.slug
      const painted = term.all()
      expect(painted).toContain(slug)
      // A progress row, with the pipeline in it.
      expect(painted).toContain('plan')
      expect(painted).toMatch(/\[[x> ]\]/)
      // The cursor is always restored, however the pass ends.
      expect(painted).toContain('\x1b[?25h')
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('dashboard startup and notices stay inside the fixed frame, never the line sinks', async () => {
    const fx = await makeFixture(readyTicket('T-frame'), happyHandlers())
    const term = fakeTerminal()
    const out: string[] = []
    try {
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: (line) => out.push(line),
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
        terminal: term,
      })

      const slug = (await fx.store.listBuilds())[0]!.slug
      const painted = stripAnsi(term.all())
      expect(out).toEqual([])
      expect(fx.err).toEqual([])
      expect(painted).toContain('Auto Build')
      expect(painted).toContain(`build ${slug} parked`)
      expect(painted).toContain(slug)
      expect(painted).not.toContain(`one pass over ${fx.origin}`)
      expect(painted).not.toContain('Ctrl-C to stop')
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('the frame is STRICTLY shorter than the terminal — rows are wired through', async () => {
    // f_d2e4b3ee + f_c9449563. Two bugs, one assertion:
    //
    //   `<= rows` is the off-by-one (round 3): the region terminates every
    //   line with \n, so an N-line frame occupies N rows and leaves the cursor
    //   on an N+1th. At N === rows the header scrolls off and lands in
    //   scrollback on every repaint — f_d2e4b3ee's exact failure, surviving at
    //   the boundary its fix aimed for.
    //
    //   no clamp at all is the original bug.
    //
    // This is the seam that owns the invariant: render.ts counts lines and
    // cannot see the trailing newline; live.test.ts's fake collects strings and
    // cannot see scrolling. Only here do a real frame and a real row count meet.
    //
    // rows: 5 is deliberately tight — this fixture's natural frame is 5 lines,
    // so an unclamped or off-by-one frame lands exactly on the failing value.
    // A looser rows would fit anyway and prove nothing.
    const fx = await makeFixture(readyTicket('T-rows'), happyHandlers())
    const rows = 5
    const term = fakeTerminal(true, { columns: 80, rows })
    try {
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
        terminal: term,
      })
      expect(fx.cliErrors).toEqual([])
      expect(tallestFrame(term)).toBeGreaterThan(0) // it really did paint
      expect(tallestFrame(term)).toBeLessThan(rows) // STRICTLY — see above
      expect(term.all()).toContain('Auto Build') // the title survives
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('plain: true with an interactive terminal emits no escapes at all', async () => {
    const fx = await makeFixture(readyTicket('T-plain'), happyHandlers())
    const term = fakeTerminal()
    const out: string[] = []
    try {
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: (line) => out.push(line),
        stderr: (line) => fx.err.push(line),
        once: true,
        plain: true,
        wire: fx.wire,
        terminal: term,
      })
      expect(term.all()).toBe('')
      expect(out.join('\n')).not.toContain('\x1b')
      // Plain still reports everything it reports today.
      const slug = (await fx.store.listBuilds())[0]!.slug
      expect(out.some((line) => line.includes(`build ${slug} parked`))).toBe(true)
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('the global row accepts an early p before the first projection, even with no body rows', async () => {
    const fx = await makeFixture([], happyHandlers())
    const term = fakeTerminal()
    const input = fakeInput(['pause'])
    const out: string[] = []
    try {
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: (line) => out.push(line),
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
        terminal: term,
        input,
      })
      expect(out).toEqual([])
      expect(fx.err).toEqual([])
      const painted = stripAnsi(term.all())
      expect(painted).toContain('> Auto Build')
      expect(painted).toContain('intake OFF')
      expect(painted).toContain('dispatcher intake OFF')
      expect(painted).toContain('no active builds')
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('startup Up/Down clamp on global, so a following p still toggles intake', async () => {
    const fx = await makeFixture([], happyHandlers())
    const term = fakeTerminal()
    const input = fakeInput(['up', 'down', 'pause'])
    try {
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
        terminal: term,
        input,
      })
      const painted = stripAnsi(term.all())
      expect(painted).toContain('> Auto Build')
      expect(painted).toContain('dispatcher intake OFF')
      expect(painted).not.toContain('no active row is selected')
      expect(fx.err).toEqual([])
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('a non-interactive terminal (a pipe or redirect) auto-selects plain', async () => {
    const fx = await makeFixture(readyTicket('T-pipe'), happyHandlers())
    const term = fakeTerminal(false)
    const out: string[] = []
    try {
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: (line) => out.push(line),
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
        terminal: term,
      })
      expect(term.all()).toBe('')
      expect(out.join('\n')).not.toContain('\x1b')
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('watch: successive diagnostics replace the reserved status row without using line sinks', async () => {
    const fx = await makeFixture(
      [
        readyTicket('T-blocked-tty', { title: 'Blocked work', blockedBy: ['T-9'] }),
        readyTicket('T-9', { title: 'The blocker', state: 'In Progress' }),
      ],
      happyHandlers(),
    )
    const out: string[] = []
    const term = fakeTerminal()
    const controller = new AbortController()
    let sleeps = 0
    const sleep = async (): Promise<void> => {
      sleeps += 1
      await new Promise((resolve) => setTimeout(resolve, 30))
      if (sleeps >= 2) controller.abort()
    }
    try {
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: (line) => out.push(line),
        stderr: (line) => fx.err.push(line),
        once: false,
        intervalMs: 1,
        sleep,
        signal: controller.signal,
        wire: fx.wire,
        terminal: term,
      })

      const diagnostic = 'ticket T-blocked-tty blocked by T-9 (not complete)'
      const diagnosticFrame = term.frames.find((chunk) => stripAnsi(chunk).includes(diagnostic))
      const countFrame = term.frames.find((chunk) =>
        stripAnsi(chunk).includes('tick: dependencyBlocked=1'),
      )
      expect(out).toEqual([])
      expect(fx.err).toEqual([])
      expect(diagnosticFrame).toBeDefined()
      expect(countFrame).toBeDefined()
      const diagnosticLines = stripAnsi(diagnosticFrame!).split('\n').slice(0, -1)
      const countLines = stripAnsi(countFrame!).split('\n').slice(0, -1)
      expect(diagnosticLines[0]).toContain('Auto Build')
      expect(diagnosticLines[1]).toBe(diagnostic)
      expect(countLines[1]).toBe('tick: dependencyBlocked=1')
      expect(countLines).toHaveLength(diagnosticLines.length)
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('--once ticks exactly ONCE — a ticket that turns Ready mid-drain is not claimed', async () => {
    // The AC says --once selects eligible tickets only during its initial pass.
    // Today's --once already calls tick() once and then drains; the render loop
    // only READS, so this is a constraint to preserve, not to implement.
    const late = readyTicket('T-late')
    const handlers = happyHandlers()
    const happyPlan = handlers.plan!
    // Capacity 2: with capacity 1 the dispatcher's own active-count gate
    // blocks the second claim, and the test would pass even if --once ticked
    // twice — a false green.
    const fx = await makeFixture(
      readyTicket('T-first'),
      handlers,
      DISPATCH_CONFIG_TOML.replace('capacity = 1', 'capacity = 2'),
    )
    // Make the late ticket Ready while the first build is still in flight.
    let seeded = false
    handlers.plan = async (cli) => {
      fx.tickets.add(late)
      seeded = true
      return happyPlan(cli)
    }
    const out: string[] = []
    try {
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: (line) => out.push(line),
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
        terminal: fakeTerminal(),
      })
      // The oracle only means anything if the late ticket really did become
      // Ready mid-drain and the pass really did finish.
      expect(seeded).toBe(true)
      expect(fx.cliErrors).toEqual([])
      // T-late really was on offer by the time the pass drained…
      const ready = await fx.tickets.listReady({ labels: ['autobuild'], state: 'Ready' })
      expect(ready.map((t) => t.ref.id).sort()).toEqual(['T-first', 'T-late'])

      // …and the pass still built only the ticket its ONE tick selected.
      const builds = await fx.store.listBuilds()
      expect(builds.map((b) => b.ticket?.id)).toEqual(['T-first'])
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('watch: a renderer swap repaints without replacing the in-flight dispatcher, runner, or input', async () => {
    const handlers = happyHandlers()
    const happyPlan = handlers.plan!
    let releasePlan!: () => void
    let planReleased = false
    const planGate = new Promise<void>((resolve) => {
      releasePlan = () => {
        if (planReleased) return
        planReleased = true
        resolve()
      }
    })
    let markPlanStarted!: () => void
    const planStarted = new Promise<void>((resolve) => {
      markPlanStarted = resolve
    })
    handlers.plan = async (cli) => {
      markPlanStarted()
      await planGate
      return happyPlan(cli)
    }

    const fx = await makeFixture(
      readyTicket('T-hot-render', { title: 'Hot render work' }),
      handlers,
    )
    const originalListReady = fx.tickets.listReady.bind(fx.tickets)
    let readyScans = 0
    fx.tickets.listReady = async (criteria) => {
      readyScans += 1
      return originalListReady(criteria)
    }

    const markedRenderer = (marker: string): DashboardRenderer =>
      (model, opts) => {
        const lines = renderDashboard(model, opts)
        return lines.length === 0
          ? lines
          : [`${marker}  ${lines[0]}`, ...lines.slice(1)]
      }
    let currentRenderer = markedRenderer('renderer A')
    const term = fakeTerminal(true, { columns: 160 })
    const input = fakeInput()
    const stop = new AbortController()
    let wakeSleep!: () => void
    let sleepReleased = false
    const sleepGate = new Promise<void>((resolve) => {
      wakeSleep = () => {
        if (sleepReleased) return
        sleepReleased = true
        resolve()
      }
    })
    let sleeps = 0
    let dispatchLaunches = 0
    let run: Promise<void> | undefined

    try {
      run = abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        intervalMs: 1,
        signal: stop.signal,
        sleep: async () => {
          sleeps += 1
          await sleepGate
        },
        wire: () => {
          dispatchLaunches += 1
          return fx.wire()
        },
        terminal: term,
        input,
        resolveDashboardRenderer: () => currentRenderer,
      })

      await planStarted
      await waitFor(() =>
        stripAnsi(term.all()).includes('renderer A'),
      )
      await waitFor(() => input.starts === 1 && sleeps === 1)

      const [record] = await fx.store.listBuilds()
      expect(record).toBeDefined()
      const slug = record!.slug
      const leaseHolder = (await fx.store.getBuild(slug))?.lease?.holder
      expect(typeof leaseHolder).toBe('string')
      const attachedBefore = (await fx.store.getEvents(slug)).filter(
        (event) => event.type === 'runner.attached',
      )
      expect(attachedBefore).toHaveLength(1)
      const [openSession] = [...fx.agents.sessions.values()]
      expect(openSession).toBeDefined()
      expect(openSession!.ended).toBe(false)
      expect(dispatchLaunches).toBe(1)
      expect(readyScans).toBe(1)
      expect(sleeps).toBe(1)
      expect(input.starts).toBe(1)

      // Simulate Bun re-evaluating the dev entry: only the mutable renderer
      // pointer changes. The existing tick timer performs the next paint.
      currentRenderer = markedRenderer('renderer B')
      await waitFor(() =>
        stripAnsi(term.all()).includes('renderer B'),
      )

      expect(dispatchLaunches).toBe(1)
      expect(readyScans).toBe(1)
      expect(sleeps).toBe(1)
      expect(input.starts).toBe(1)
      expect(fx.agents.sessions.size).toBe(1)
      expect(fx.agents.sessions.get(openSession!.session.id)?.ended).toBe(false)
      expect(
        (await fx.store.getEvents(slug)).filter(
          (event) => event.type === 'runner.attached',
        ),
      ).toHaveLength(1)
      expect((await fx.store.getBuild(slug))?.lease?.holder).toBe(leaseHolder)

      // The very same blocked phase resumes and completes normally after the
      // presentation swap; no replacement runner is needed.
      releasePlan()
      await waitFor(
        async () =>
          (await fx.store.getEvents(slug)).some(
            (event) => event.type === 'finalize.completed',
          ),
        10_000,
      )
      expect(
        (await fx.store.getEvents(slug)).filter(
          (event) => event.type === 'runner.attached',
        ),
      ).toHaveLength(1)
      expect((await fx.store.getBuild(slug))?.lease?.holder).toBe(leaseHolder)

      stop.abort()
      wakeSleep()
      await run
      expect(input.cleanups).toBe(1)
      expect(term.all()).toContain('\x1b[?25h')
      expect(fx.cliErrors).toEqual([])
      expect(fx.err).toEqual([])
    } finally {
      releasePlan()
      stop.abort()
      wakeSleep()
      await run?.catch(() => {})
      await fx.cleanup()
    }
  }, 30_000)

  test('watch: the merge-waiting elapsed advances on the tick timer, with the store unchanged (AC 8)', async () => {
    // The decoupled paint (DASHBOARD_TICK_MS) is what makes a running elapsed
    // tick between store reads. Drain a build to PR-open in a first pass, then
    // WATCH it: the dispatcher tick interval is 10 s (so it does nothing during
    // the window and the store never changes), yet the merge `(waiting, …)`
    // elapsed still advances across repaints, driven purely by the render clock.
    const fx = await makeFixture(readyTicket('T-tick'), happyHandlers())
    try {
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
        terminal: fakeTerminal(),
      })
      expect(fx.forge.opened).toHaveLength(1) // parked at merge-waiting

      const term = fakeTerminal()
      const controller = new AbortController()
      // ~1.3 s guarantees at least one whole-second boundary crossing, so the
      // formatted elapsed changes at least once regardless of sub-second phase.
      setTimeout(() => controller.abort(), 1_300).unref?.()
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        once: false,
        intervalMs: 10_000,
        signal: controller.signal,
        wire: fx.wire,
        terminal: term,
      })

      const waits = new Set(
        [...stripAnsi(term.all()).matchAll(/merge\(waiting, ([^)]+)\)/g)].map((m) => m[1]),
      )
      // More than one distinct elapsed ⇒ the frame repainted with a moving clock
      // while the store held still.
      expect(waits.size).toBeGreaterThanOrEqual(2)
    } finally {
      await fx.cleanup()
    }
  }, 30_000)
})

describe('abDispatch interactive keyboard controls', () => {
  test('global m toggles the process default; harvest/build controls remain scoped by row', async () => {
    const fx = await makeFixture(
      [
        readyTicket('T-alpha-harvest', { title: 'Alpha work' }),
        readyTicket('T-beta-harvest', { title: 'Beta work' }),
      ],
      happyHandlers(),
      DISPATCH_CONFIG_TOML.replace('capacity = 1', 'capacity = 2'),
    )
    try {
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
      })
      await fx.store.ensureRepo(fx.origin)
      await fx.store.appendRepoWithArtifacts(
        fx.origin,
        [{ kind: 'harvest-scan', content: '{}' }],
        (deposited) => ({
          actor: KERNEL,
          type: 'harvest.started',
          payload: {
            run: 'harvest_keyboard_internal',
            observations: [{ build: 'alpha-work', seq: 1 }],
            scan: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
          },
        }),
      )
      // Keep the staged run visibly open without letting this control-focused
      // test launch harvest agents. The production runner returns `held`.
      expect(await fx.store.claimRepoLease(fx.origin, 'other-dispatcher', 3_600_000)).toBe(true)

      const beforeRepo = await fx.store.getRepoEvents(fx.origin)
      const beforeBuilds = new Map(
        await Promise.all(
          ['alpha-work', 'beta-work'].map(async (slug) => [
            slug,
            await fx.store.getEvents(slug),
          ] as const),
        ),
      )
      const term = fakeTerminal()
      const input = fakeInput()
      const out: string[] = []
      const run = abDispatch({
        targetRepo: fx.origin,
        env: { USER: 'harvest-op' },
        exec: spawnExec,
        stdout: (line) => out.push(line),
        stderr: (line) => fx.err.push(line),
        intervalMs: 60_000,
        wire: fx.wire,
        terminal: term,
        input,
      })
      await waitFor(() => stripAnsi(term.all()).includes('> Auto Build'))

      input.press('auto-merge')
      await waitFor(() =>
        stripAnsi(term.all()).includes('dispatcher auto-merge default ON'),
      )
      expect(stripAnsi(term.all())).toContain('auto merge default ON')
      input.press('auto-merge')
      await waitFor(() =>
        stripAnsi(term.all()).includes('dispatcher auto-merge default OFF'),
      )
      expect(stripAnsi(term.all())).toContain('auto merge default OFF')
      expect(await fx.store.getRepoEvents(fx.origin)).toEqual(beforeRepo)
      for (const slug of ['alpha-work', 'beta-work']) {
        expect(await fx.store.getEvents(slug)).toEqual(beforeBuilds.get(slug)!)
      }

      input.press('down')
      await waitFor(() => /^> .*Harvest/m.test(stripAnsi(term.all())))
      input.press('auto-merge')
      await waitFor(() => stripAnsi(term.all()).includes('Harvest auto-merge unavailable'))
      input.press('pause')
      await waitFor(async () =>
        (await fx.store.getRepoEvents(fx.origin)).some(
          (event) => event.type === 'harvest.pause-requested',
        ),
      )
      await waitFor(() => stripAnsi(term.all()).includes('harvest: pause requested'))
      await fx.store.appendRepo(fx.origin, {
        actor: KERNEL,
        type: 'harvest.paused',
        payload: {},
      })
      await waitFor(() => /Harvest.*PAUSED/.test(stripAnsi(term.all())))
      input.press('pause')
      await waitFor(async () =>
        (await fx.store.getRepoEvents(fx.origin)).some(
          (event) => event.type === 'harvest.resume-requested',
        ),
      )
      await waitFor(() => stripAnsi(term.all()).includes('harvest: resume requested'))
      expect(stripAnsi(term.all())).toContain('intake ON')

      const repoAdded = (await fx.store.getRepoEvents(fx.origin)).slice(
        beforeRepo.length,
      )
      expect(repoAdded.map((event) => event.type)).toEqual([
        'harvest.pause-requested',
        'harvest.paused',
        'harvest.resume-requested',
      ])
      expect(repoAdded[0]?.actor).toEqual({
        kind: 'human',
        user: 'harvest-op',
      })
      expect(repoAdded[2]?.actor).toEqual({
        kind: 'human',
        user: 'harvest-op',
      })
      for (const slug of ['alpha-work', 'beta-work']) {
        const added = (await fx.store.getEvents(slug)).slice(beforeBuilds.get(slug)!.length)
        expect(added.some((event) => event.actor.kind === 'human')).toBe(false)
      }
      expect(out).toEqual([])

      input.press('down')
      await waitFor(() => /^> .*alpha-work/m.test(stripAnsi(term.all())))
      input.press('auto-merge')
      input.press('pause')
      await waitFor(async () => {
        const events = await fx.store.getEvents('alpha-work')
        return (
          events.some((event) => event.type === 'build.auto-merge-requested') &&
          events.some((event) => event.type === 'build.pause-requested')
        )
      })
      input.press('interrupt')
      await run

      const human = (await fx.store.getEvents('alpha-work')).filter(
        (event) => event.actor.kind === 'human',
      )
      expect(human.slice(-2).map((event) => event.type)).toEqual([
        'build.auto-merge-requested',
        'build.pause-requested',
      ])
      expect(human.slice(-2).every(
        (event) => event.actor.kind === 'human' && event.actor.user === 'harvest-op',
      )).toBe(true)
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('global default seeds only later claims and never overrides per-build cancellation', async () => {
    const fx = await makeFixture(
      readyTicket('T-existing-default', { title: 'Existing work' }),
      happyHandlers(),
      DISPATCH_CONFIG_TOML.replace('capacity = 1', 'capacity = 3'),
    )
    let run: Promise<void> | undefined
    const input = fakeInput()
    const term = fakeTerminal(true, { columns: 180 })
    try {
      // Establish an in-flight build before this dispatch process chooses its
      // default. It must remain untouched when global m turns the default on.
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
      })
      const existingBefore = await fx.store.getEvents('existing-work')

      let sleeps = 0
      run = abDispatch({
        targetRepo: fx.origin,
        env: { USER: 'default-op' },
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        intervalMs: 1,
        sleep: async () => {
          sleeps += 1
          if (sleeps === 1) {
            input.press('auto-merge')
            await waitFor(() =>
              stripAnsi(term.all()).includes(
                'dispatcher auto-merge default ON',
              ),
            )
            fx.tickets.add(
              readyTicket('T-seeded-default', { title: 'Seeded work' }),
            )
            return
          }
          if (sleeps === 2) {
            await waitFor(async () =>
              (await fx.store.getEvents('seeded-work')).some(
                (event) => event.type === 'build.auto-merge-requested',
              ),
            )
            await waitFor(() =>
              /^  .*seeded-work.*RUNNING/m.test(stripAnsi(term.all())),
            )

            // Global → existing-work → seeded-work. Cancelling this seeded
            // build is authoritative even while the global default stays on.
            input.press('down')
            await waitFor(() =>
              /^> .*existing-work/m.test(stripAnsi(term.all())),
            )
            input.press('down')
            await waitFor(() =>
              /^> .*seeded-work/m.test(stripAnsi(term.all())),
            )
            input.press('auto-merge')
            await waitFor(async () =>
              (await fx.store.getEvents('seeded-work')).some(
                (event) => event.type === 'build.auto-merge-cancelled',
              ),
            )

            // Return to global and turn the claim-time default off. This must
            // not emit another build cancellation.
            input.press('up')
            input.press('up')
            input.press('auto-merge')
            await waitFor(() =>
              stripAnsi(term.all()).includes(
                'dispatcher auto-merge default OFF',
              ),
            )
            fx.tickets.add(
              readyTicket('T-unseeded-default', { title: 'Unseeded work' }),
            )
            return
          }
          if (sleeps === 3) {
            await waitFor(async () =>
              (await fx.store.getEvents('unseeded-work')).some(
                (event) => event.type === 'spec.imported',
              ),
            )
            await waitFor(async () =>
              (await fx.store.getEvents('seeded-work')).some(
                (event) => event.type === 'finalize.completed',
              ) &&
              (await fx.store.getEvents('unseeded-work')).some(
                (event) => event.type === 'finalize.completed',
              ),
              10_000,
            )
            return
          }
          input.press('interrupt')
        },
        wire: fx.wire,
        terminal: term,
        input,
      })
      await run
      run = undefined

      expect(await fx.store.getEvents('existing-work')).toEqual(existingBefore)
      const seeded = await fx.store.getEvents('seeded-work')
      expect(
        seeded.filter(
          (event) => event.type === 'build.auto-merge-requested',
        ),
      ).toHaveLength(1)
      expect(
        seeded.filter(
          (event) => event.type === 'build.auto-merge-cancelled',
        ),
      ).toHaveLength(1)
      expect(
        seeded.find(
          (event) => event.type === 'build.auto-merge-requested',
        )?.actor,
      ).toEqual({ kind: 'human', user: 'default-op' })
      expect(
        (await fx.store.getEvents('unseeded-work')).some(
          (event) => event.type === 'build.auto-merge-requested',
        ),
      ).toBe(false)
      expect(fx.cliErrors).toEqual([])
      expect(fx.err).toEqual([])
    } finally {
      input.press('interrupt')
      await run?.catch(() => {})
      await fx.cleanup()
    }
  }, 30_000)

  test('p acknowledges exhausted harvest attention, but does not reinterpret escalation', async () => {
    const fx = await makeFixture([], happyHandlers())
    const term = fakeTerminal()
    const input = fakeInput()
    let run: Promise<void> | undefined
    try {
      await fx.store.ensureRepo(fx.origin)
      await fx.store.appendRepo(fx.origin, {
        actor: KERNEL,
        type: 'harvest.started',
        payload: {
          run: 'harvest_errored',
          observations: [{ build: 'observed-build', seq: 1 }],
          scan: { kind: 'harvest-scan', rev: 0 },
        },
      })
      await fx.store.appendRepo(fx.origin, {
        actor: KERNEL,
        type: 'harvest.failed',
        payload: {
          run: 'harvest_errored',
          step: 'file',
          attempt: 2,
          error: 'ticket provider unavailable',
          willRetry: false,
        },
      })
      for (const attempt of [1, 2]) {
        await fx.store.appendRepo(fx.origin, {
          actor: KERNEL,
          type: 'harvest.recovery-requested',
          payload: { run: 'harvest_errored', attempt, limit: 2 },
        })
        await fx.store.appendRepo(fx.origin, {
          actor: KERNEL,
          type: 'harvest.resumed',
          payload: {},
        })
        await fx.store.appendRepo(fx.origin, {
          actor: KERNEL,
          type: 'harvest.failed',
          payload: {
            run: 'harvest_errored',
            step: 'file',
            attempt: attempt + 2,
            error: 'ticket provider unavailable',
            willRetry: false,
          },
        })
      }
      await fx.store.appendRepo(fx.origin, {
        actor: KERNEL,
        type: 'harvest.recovery-exhausted',
        payload: {
          run: 'harvest_errored',
          step: 'file',
          error: 'ticket provider unavailable',
          attempts: 2,
          limit: 2,
          releasedObservations: [{ build: 'observed-build', seq: 1 }],
          committedDispositions: [],
          pendingProposals: [],
        },
      })
      const before = (await fx.store.getRepoEvents(fx.origin)).length

      run = abDispatch({
        targetRepo: fx.origin,
        env: { USER: 'error-op' },
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        intervalMs: 60_000,
        wire: fx.wire,
        terminal: term,
        input,
      })
      await waitFor(() => /Harvest.*FAILED/.test(stripAnsi(term.all())))
      input.press('down')
      await waitFor(() => /^> .*Harvest.*FAILED/m.test(stripAnsi(term.all())))

      input.press('pause')
      await waitFor(async () =>
        (await fx.store.getRepoEvents(fx.origin)).slice(before).some(
          (event) => event.type === 'harvest.resume-requested',
        ),
      )
      await waitFor(() =>
        stripAnsi(term.all()).includes(
          'harvest: exhausted recovery attention acknowledgement requested',
        ),
      )
      let added = (await fx.store.getRepoEvents(fx.origin)).slice(before)
      expect(added.map((event) => event.type)).toEqual([
        'harvest.resume-requested',
      ])
      expect(added[0]?.actor).toEqual({ kind: 'human', user: 'error-op' })

      // Settle the attention acknowledgement, then stop a later run by
      // deliberate escalation. On that state p controls only the repository
      // pause gate and never treats escalation as recoverable infrastructure.
      await fx.store.appendRepo(fx.origin, {
        actor: KERNEL,
        type: 'harvest.resumed',
        payload: {},
      })
      await fx.store.appendRepo(fx.origin, {
        actor: KERNEL,
        type: 'harvest.started',
        payload: {
          run: 'harvest_escalated',
          observations: [{ build: 'observed-build', seq: 1 }],
          scan: { kind: 'harvest-scan', rev: 1 },
        },
      })
      await fx.store.appendRepo(fx.origin, {
        actor: KERNEL,
        type: 'harvest.escalated',
        payload: {
          run: 'harvest_escalated',
          source: 'agent',
          reason: 'operator judgment required',
          observations: [{ build: 'observed-build', seq: 1 }],
        },
      })
      await waitFor(() => /Harvest.*ESCALATED/.test(stripAnsi(term.all())))
      const beforeEscalatedAction = (await fx.store.getRepoEvents(fx.origin)).length
      input.press('pause')
      await waitFor(async () =>
        (await fx.store.getRepoEvents(fx.origin))
          .slice(beforeEscalatedAction)
          .some((event) => event.type === 'harvest.pause-requested'),
      )
      added = (await fx.store.getRepoEvents(fx.origin)).slice(
        beforeEscalatedAction,
      )
      expect(added.map((event) => event.type)).toEqual([
        'harvest.pause-requested',
      ])
      await waitFor(() =>
        stripAnsi(term.all()).includes('harvest: pause requested'),
      )

      input.press('interrupt')
      await run
      expect(fx.cliErrors).toEqual([])
      expect(fx.err).toEqual([])
    } finally {
      input.press('interrupt')
      await run?.catch(() => {})
      await fx.cleanup()
    }
  }, 30_000)

  test('Down selects by slug; p/m target that build with human events; rapid m toggles in order', async () => {
    const fx = await makeFixture(
      [
        readyTicket('T-alpha', { title: 'Alpha work' }),
        readyTicket('T-beta', { title: 'Beta work' }),
      ],
      happyHandlers(),
      DISPATCH_CONFIG_TOML.replace('capacity = 1', 'capacity = 2'),
    )
    try {
      // First create two durable, merge-waiting builds. The second invocation
      // is pure dashboard control over those rows.
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
      })
      const records = (await fx.store.listBuilds()).sort((a, b) =>
        a.slug.localeCompare(b.slug),
      )
      expect(records.map((record) => record.slug)).toEqual(['alpha-work', 'beta-work'])

      const term = fakeTerminal()
      const input = fakeInput()
      const run = abDispatch({
        targetRepo: fx.origin,
        env: { USER: 'dashboard-op' },
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        intervalMs: 60_000,
        wire: fx.wire,
        terminal: term,
        input,
      })
      await waitFor(() => stripAnsi(term.all()).includes('alpha-work'))

      input.press('down')
      input.press('down')
      await waitFor(() => /^> .*beta-work/m.test(stripAnsi(term.all())))
      input.press('pause')
      input.press('auto-merge')
      input.press('auto-merge')
      await waitFor(async () => {
        const events = await fx.store.getEvents('beta-work')
        return events.filter((event) =>
          [
            'build.pause-requested',
            'build.auto-merge-requested',
            'build.auto-merge-cancelled',
          ].includes(event.type),
        ).length === 3
      })

      // Removing the selected final row chooses its predecessor, not a stale
      // row index. Let the polling projection reconcile, then p must target
      // alpha rather than the now-done beta.
      await fx.store.append('beta-work', {
        actor: { kind: 'dispatcher' },
        type: 'build.completed',
        payload: { outcome: 'merged' },
      })
      await new Promise((resolve) => setTimeout(resolve, 600))
      input.press('pause')
      await waitFor(async () =>
        (await fx.store.getEvents('alpha-work')).some(
          (event) => event.type === 'build.pause-requested',
        ),
      )
      input.press('interrupt')
      await run

      const alpha = await fx.store.getEvents('alpha-work')
      expect(alpha.at(-1)?.type).toBe('build.pause-requested')
      const commands = (await fx.store.getEvents('beta-work')).filter((event) =>
        event.actor.kind === 'human',
      )
      expect(commands.map((event) => event.type).slice(-3)).toEqual([
        'build.pause-requested',
        'build.auto-merge-requested',
        'build.auto-merge-cancelled',
      ])
      expect(commands.slice(-3).every((event) =>
        event.actor.kind === 'human' && event.actor.user === 'dashboard-op'
      )).toBe(true)
      expect(input.starts).toBe(1)
      expect(input.cleanups).toBe(1)
      expect(term.all()).toContain('\x1b[?25h')
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('p on a blocked build opens input without writing; typed guidance answers it as the configured human', async () => {
    const fx = await makeFixture(
      readyTicket('T-guidance', { title: 'Guidance work' }),
      happyHandlers(),
    )
    try {
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
      })
      await fx.store.append('guidance-work', {
        actor: KERNEL,
        type: 'finalize.started',
        payload: {},
      })
      await fx.store.append('guidance-work', {
        actor: agentActor('finalize', 's_blocked'),
        type: 'escalation.raised',
        payload: {
          id: 'esc_guidance',
          phase: 'finalize',
          source: 'agent',
          question: 'Should finalize use the manual merge path?',
        },
      })
      const before = await fx.store.getEvents('guidance-work')

      const term = fakeTerminal()
      const input = fakeInput()
      const run = abDispatch({
        targetRepo: fx.origin,
        env: { USER: 'dashboard-op' },
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        intervalMs: 60_000,
        wire: fx.wire,
        terminal: term,
        input,
      })
      await waitFor(() => stripAnsi(term.all()).includes('Should finalize use the manual merge path?'))
      input.press('down')
      await waitFor(() => /^> .*guidance-work/m.test(stripAnsi(term.all())))

      input.press('pause')
      await waitFor(() => stripAnsi(term.all()).includes('Resume feedback'))
      expect(await fx.store.getEvents('guidance-work')).toHaveLength(before.length)

      // m/p/d are feedback characters while the modal is active, never global
      // actions. Backspace edits by code point before Enter submits.
      input.text('Use pmdX')
      input.press('backspace')
      input.text(' after checks. ')
      input.press('enter')
      await waitFor(async () =>
        (await fx.store.getEvents('guidance-work')).some(
          (event) => event.type === 'escalation.answered',
        ),
      )
      input.press('interrupt')
      await run

      const added = (await fx.store.getEvents('guidance-work')).slice(before.length)
      const answer = added.find((event) => event.type === 'escalation.answered')
      expect(answer?.actor).toEqual({ kind: 'human', user: 'dashboard-op' })
      expect(answer?.payload).toEqual({
        id: 'esc_guidance',
        answer: 'Use pmd after checks.',
        resolution: 'guidance',
      })
      expect(answer?.seq).toBeGreaterThan(before.at(-1)!.seq)
      expect(Date.parse(answer!.ts)).not.toBeNaN()
      expect(
        added.some((event) =>
          [
            'build.pause-requested',
            'build.auto-merge-requested',
            'build.auto-merge-cancelled',
          ].includes(event.type),
        ),
      ).toBe(false)
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('blank blocked resume retries every captured source and also unpauses a paused+blocked build', async () => {
    const fx = await makeFixture(
      readyTicket('T-retry', { title: 'Retry work' }),
      happyHandlers(),
    )
    try {
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
      })
      await fx.store.append('retry-work', {
        actor: KERNEL,
        type: 'finalize.started',
        payload: {},
      })
      for (const [id, source] of [
        ['esc_agent', 'agent'],
        ['esc_stall', 'stall'],
        ['esc_policy', 'policy'],
      ] as const) {
        await fx.store.append('retry-work', {
          actor:
            source === 'agent'
              ? agentActor('finalize', 's_blocked')
              : KERNEL,
          type: 'escalation.raised',
          payload: {
            id,
            phase: 'finalize',
            source,
            question: `${source} blocker remains unresolved`,
          },
        })
      }
      await fx.store.append('retry-work', {
        actor: KERNEL,
        type: 'build.paused',
        payload: {},
      })
      const before = await fx.store.getEvents('retry-work')

      const input = fakeInput()
      const term = fakeTerminal()
      const run = abDispatch({
        targetRepo: fx.origin,
        env: {}, // stable fallback user: dashboard
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        intervalMs: 60_000,
        wire: fx.wire,
        terminal: term,
        input,
      })
      await waitFor(() => input.starts === 1)
      await new Promise((resolve) => setTimeout(resolve, 20))
      input.press('down')
      await waitFor(() => /^> .*retry-work/m.test(stripAnsi(term.all())))
      input.press('pause')
      await waitFor(() => stripAnsi(term.all()).includes('Resume feedback'))
      input.text('   ')
      input.press('enter')
      await waitFor(async () => {
        const added = (await fx.store.getEvents('retry-work')).slice(before.length)
        return (
          added.filter((event) => event.type === 'escalation.answered').length === 3 &&
          added.some((event) => event.type === 'build.resume-requested')
        )
      })
      input.press('interrupt')
      await run

      const added = (await fx.store.getEvents('retry-work')).slice(before.length)
      const answers = added.filter((event) => event.type === 'escalation.answered')
      expect(answers.map((event) => event.payload.id)).toEqual([
        'esc_agent',
        'esc_stall',
        'esc_policy',
      ])
      expect(
        answers.every(
          (event) =>
            event.payload.resolution === 'retry' &&
            event.payload.answer.toLowerCase().includes('no feedback') &&
            event.actor.kind === 'human' &&
            event.actor.user === 'dashboard',
        ),
      ).toBe(true)
      expect(added.map((event) => event.type).slice(-1)).toEqual([
        'build.resume-requested',
      ])
      expect(added.some((event) => event.type === 'build.pause-requested')).toBe(false)
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('finalize blocked by auto-merge recovers after cancellation and an empty dashboard retry', async () => {
    const clock = manualClock()
    const handlers = happyHandlers()
    const happyPlan = handlers.plan!
    const happyFinalize = handlers.finalize!
    let releasePlan!: () => void
    let planReleased = false
    const planGate = new Promise<void>((resolve) => {
      releasePlan = () => {
        planReleased = true
        resolve()
      }
    })
    handlers.plan = async (cli) => {
      await planGate
      return happyPlan(cli)
    }
    const blocker =
      'Finalize opened the PR, but native auto-merge could not be enabled; cancel it and retry.'
    handlers.finalize = async (cli) => {
      try {
        return await happyFinalize(cli)
      } catch (error) {
        if (!String(error).includes('permission denied enabling native auto-merge')) {
          throw error
        }
        await cli.run(['escalate', blocker])
      }
    }

    const fx = await makeFixture(
      readyTicket('T-finalize-retry', { title: 'Finalize retry' }),
      handlers,
      DISPATCH_CONFIG_TOML,
      clock,
    )
    const nativeSetAutoMerge = fx.forge.setAutoMerge.bind(fx.forge)
    fx.forge.setAutoMerge = async (
      workspacePath: string,
      number: number,
      enabled: boolean,
    ) => {
      if (enabled) {
        throw new Error('permission denied enabling native auto-merge')
      }
      return nativeSetAutoMerge(workspacePath, number, enabled)
    }

    const term = fakeTerminal()
    const input = fakeInput()
    let run: Promise<void> | undefined
    try {
      run = abDispatch({
        targetRepo: fx.origin,
        env: { USER: 'manual-merge-op' },
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        intervalMs: 5,
        wire: fx.wire,
        terminal: term,
        input,
      })
      await waitFor(() => stripAnsi(term.all()).includes('finalize-retry'))
      input.press('down')
      await waitFor(() => /^> .*finalize-retry/m.test(stripAnsi(term.all())))

      // Hold plan long enough to record durable pre-PR auto-merge intent.
      input.press('auto-merge')
      await waitFor(async () =>
        (await fx.store.getEvents('finalize-retry')).some(
          (event) => event.type === 'build.auto-merge-requested',
        ),
      )
      releasePlan()

      await waitFor(async () =>
        (await fx.store.getEvents('finalize-retry')).some(
          (event) => event.type === 'escalation.raised',
        ),
        5_000,
      )
      await waitFor(() => stripAnsi(term.all()).includes(blocker), 5_000)
      expect(fx.forge.opened).toHaveLength(1)
      expect(
        (await fx.store.getEvents('finalize-retry')).some(
          (event) => event.type === 'finalize.completed',
        ),
      ).toBe(false)

      // The operator chooses manual merge, then submits the blocked-resume
      // field empty. No direct launch occurs; the ordinary lease sweep owns
      // durable reattachment after the parked runner's lease expires.
      input.press('auto-merge')
      await waitFor(async () =>
        (await fx.store.getEvents('finalize-retry')).some(
          (event) => event.type === 'build.auto-merge-cancelled',
        ),
      )
      input.press('pause')
      await waitFor(() => stripAnsi(term.all()).includes('Resume feedback'))
      input.press('enter')
      await waitFor(async () =>
        (await fx.store.getEvents('finalize-retry')).some(
          (event) =>
            event.type === 'escalation.answered' &&
            event.payload.resolution === 'retry',
        ),
      )
      clock.advance(120_000)
      await waitFor(async () =>
        (await fx.store.getEvents('finalize-retry')).some(
          (event) => event.type === 'finalize.completed',
        ),
        5_000,
      )
      input.press('interrupt')
      await run
      run = undefined

      const events = await fx.store.getEvents('finalize-retry')
      const retry = events.find(
        (event) =>
          event.type === 'escalation.answered' &&
          event.payload.resolution === 'retry',
      )
      const cancellation = events.find(
        (event) => event.type === 'build.auto-merge-cancelled',
      )
      const completed = events.find((event) => event.type === 'finalize.completed')
      expect(retry?.actor).toEqual({ kind: 'human', user: 'manual-merge-op' })
      expect(retry?.payload).toMatchObject({
        answer: expect.stringContaining('no feedback'),
        resolution: 'retry',
      })
      expect(Date.parse(retry!.ts)).not.toBeNaN()
      expect(retry!.seq).toBeGreaterThan(cancellation!.seq)
      expect(completed!.seq).toBeGreaterThan(retry!.seq)
      expect(fx.forge.opened).toHaveLength(1) // retry adopted the existing PR
      expect(fx.forge.autoMergeCalls.at(-1)).toMatchObject({
        number: 1,
        enabled: false,
      })
      expect(await fx.forge.getPrState('', 1)).toMatchObject({ state: 'open' })
      expect(
        events.filter((event) => event.type === 'escalation.raised'),
      ).toHaveLength(1)
      expect(fx.cliErrors).toHaveLength(1)
      expect(fx.cliErrors[0]).toContain('permission denied enabling native auto-merge')
    } finally {
      if (!planReleased) releasePlan()
      input.press('interrupt')
      await run?.catch(() => {})
      await fx.cleanup()
    }
  }, 30_000)

  test('Escape cancels blocked resume with no event and leaves the blocker visible', async () => {
    const fx = await makeFixture(
      readyTicket('T-cancel', { title: 'Cancel work' }),
      happyHandlers(),
    )
    try {
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
      })
      await fx.store.append('cancel-work', {
        actor: agentActor('finalize', 's_blocked'),
        type: 'escalation.raised',
        payload: {
          id: 'esc_cancel',
          phase: 'finalize',
          source: 'agent',
          question: 'Cancellation must leave this blocker untouched',
        },
      })
      const before = await fx.store.getEvents('cancel-work')
      const term = fakeTerminal()
      const input = fakeInput()
      const run = abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        intervalMs: 60_000,
        wire: fx.wire,
        terminal: term,
        input,
      })
      await waitFor(() => stripAnsi(term.all()).includes('Cancellation must leave this blocker untouched'))
      input.press('down')
      await waitFor(() => /^> .*cancel-work/m.test(stripAnsi(term.all())))
      input.press('pause')
      await waitFor(() => stripAnsi(term.all()).includes('Resume feedback'))
      input.text('do not submit this')
      input.press('escape')
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(await fx.store.getEvents('cancel-work')).toEqual(before)
      expect(stripAnsi(term.all())).toContain('Cancellation must leave this blocker untouched')
      input.press('interrupt')
      await run
      expect(
        (await fx.store.getEvents('cancel-work')).some(
          (event) => event.type === 'escalation.answered',
        ),
      ).toBe(false)
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('p on an authoritatively paused build writes resume-requested', async () => {
    const fx = await makeFixture(readyTicket('T-paused', { title: 'Paused work' }), happyHandlers())
    try {
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        once: true,
        wire: fx.wire,
      })
      await fx.store.append('paused-work', {
        actor: { kind: 'kernel' },
        type: 'build.paused',
        payload: {},
      })

      const input = fakeInput()
      const run = abDispatch({
        targetRepo: fx.origin,
        env: {}, // stable nonempty fallback actor
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        intervalMs: 60_000,
        wire: fx.wire,
        terminal: fakeTerminal(),
        input,
      })
      await waitFor(() => input.starts === 1)
      // Let the initial projection establish the global selection, then move
      // to the build row before applying its contextual p action.
      await new Promise((resolve) => setTimeout(resolve, 20))
      input.press('down')
      input.press('pause')
      await waitFor(async () =>
        (await fx.store.getEvents('paused-work')).some(
          (event) => event.type === 'build.resume-requested',
        ),
      )
      input.press('interrupt')
      await run

      const resume = (await fx.store.getEvents('paused-work')).find(
        (event) => event.type === 'build.resume-requested',
      )
      expect(resume?.actor).toEqual({ kind: 'human', user: 'dashboard' })
    } finally {
      await fx.cleanup()
    }
  }, 30_000)

  test('launch intake is process-local, global p toggles it, and the removed d key is inert', async () => {
    const fx = await makeFixture(
      readyTicket('T-intake-off', { body: 'not a conforming spec' }),
      {},
    )
    try {
      const input = fakeInput()
      const term = fakeTerminal()
      let sleeps = 0
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        intake: false,
        intervalMs: 1,
        sleep: async () => {
          sleeps += 1
          if (sleeps === 1) {
            expect(fx.tickets.claims).toEqual([])
            expect(stripAnsi(term.all())).toContain('intake OFF')
            input.press('letter-d')
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(stripAnsi(term.all())).toContain('intake OFF')
            input.press('pause')
            await waitFor(() =>
              stripAnsi(term.all()).includes('dispatcher intake ON'),
            )
          } else {
            input.press('interrupt')
          }
        },
        wire: fx.wire,
        terminal: term,
        input,
      })
      expect(fx.tickets.claims).toEqual(['T-intake-off'])

      // A new DispatchLoop defaults intake back on. A newly ready ticket is
      // claimed on its first tick without another operator toggle.
      fx.tickets.add(readyTicket('T-fresh', { body: 'still nonconforming' }))
      const freshInput = fakeInput()
      await abDispatch({
        targetRepo: fx.origin,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => fx.err.push(line),
        intervalMs: 1,
        sleep: async () => freshInput.press('interrupt'),
        wire: fx.wire,
        terminal: fakeTerminal(),
        input: freshInput,
      })
      expect(fx.tickets.claims).toEqual(['T-intake-off', 'T-fresh'])
    } finally {
      await fx.cleanup()
    }
  }, 30_000)
})
