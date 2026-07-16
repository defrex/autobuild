/**
 * `ab dispatch` (src/cli/dispatch.ts): the operator entry into the outer loop.
 *
 * The orchestration-unique surface is tested here — config loading, the
 * [tickets] guard, and the in-process fire-and-forget `launchRunner` that a
 * `--once` pass must drain before exiting. The Dispatcher + BuildRunner +
 * real-CLI pipeline itself is proven exhaustively by the integration harness
 * (src/integration/*.test.ts); this drives abDispatch over that same machinery
 * (real git worktrees, scripted agents on the REAL `ab` CLI) but with fakes
 * injected through the `wire` seam, and asserts a Ready ticket reaches PR-open
 * in one pass.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCliEnv } from './env'
import { runCli } from './main'
import { abDispatch, type DispatchWiring } from './dispatch'
import { sequentialIds } from '../ids'
import { FakeForge } from '../ports/forge/fake'
import {
  defaultTurnResult,
  ScriptedAgentRunner,
  type ScriptContext,
} from '../ports/runner/fake'
import { FakeTicketSource } from '../ports/tickets/fake'
import type { Ticket } from '../ports/types'
import { GitWorktreeProvider, spawnExec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import { systemClock } from '../store/types'
import {
  CONFORMING_BODY,
  GIT_ID,
  git,
  happyHandlers,
  type Cli,
  type SkillHandlers,
} from '../integration/harness'

// A [tickets] table so abDispatch's guard passes; the injected wire ignores it
// (it supplies a FakeTicketSource), so a file source with a dummy dir is fine.
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
readyLabels = ["autobuild"]

[tickets]
source = "file"
dir = "tickets"
`

async function initOrigin(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await git(['init', '-q', '-b', 'main'], dir)
  await writeFile(join(dir, 'autobuild.toml'), DISPATCH_CONFIG_TOML)
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
): Promise<Fixture> {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-dispatch-'))
  const origin = join(tmp, 'origin')
  await initOrigin(origin)

  const ids = sequentialIds()
  const store = new MemoryBuildStore({ clock: systemClock })
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
        clock: systemClock,
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
    runners: { scripted: agents },
    defaultRunner: 'scripted',
    storeRef: 'memory', // unused: the scripted CLI writes the shared store by ref
    ids,
    clock: systemClock,
  })

  return {
    tmp,
    origin,
    store,
    tickets,
    forge,
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

  test('a config with no [tickets] table is rejected', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ab-dispatch-'))
    try {
      await writeFile(
        join(tmp, 'autobuild.toml'),
        '[project]\nbaseBranch = "main"\n[dispatcher]\ncapacity = 1\n',
      )
      await expect(
        abDispatch({
          targetRepo: tmp,
          env: {},
          exec: spawnExec,
          stdout: () => {},
          stderr: () => {},
          once: true,
        }),
      ).rejects.toThrow(/no \[tickets\] table/)
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
      // The blocked ticket built nothing. (This fixture sets no readyState, so
      // T-9 is itself a candidate and does dispatch — which is exactly why the
      // gate must be per-ticket rather than per-tick.)
      const builds = await fx.store.listBuilds()
      expect(builds.map((b) => b.ticket?.id)).toEqual(['T-9'])
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
})
