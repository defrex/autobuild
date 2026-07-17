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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCliEnv } from './env'
import { runCli } from './main'
import { abDispatch, type DispatchWiring } from './dispatch'
import type { TerminalOut } from './terminal'
import type { Config } from '../config/schema'
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

// The injected wire supplies a FakeTicketSource and ignores this table, so its
// contents don't matter — it is here only to pin that an explicit [tickets]
// table still parses and flows through. Omitting it would be equally valid now
// (absent = the local file tracker); the zero-config path is covered below.
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
): Promise<Fixture> {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-dispatch-'))
  const origin = join(tmp, 'origin')
  await initOrigin(origin, toml)

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

  test('a config with no [tickets] table is accepted and selects the file source (AC 1)', async () => {
    // The inverse of the rejection this used to assert: no [tickets] table is
    // the zero-config default now, not an error.
    //
    // It stops at the `wire` seam deliberately. Unlike ticket.test.ts — whose
    // real factory only writes under tmp — abDispatch's defaultWire would open
    // a real SQLite store and a real worktree provider under DEFAULT_LOCAL_ROOT
    // (~/.autobuild), i.e. side effects in the user's actual autobuild home.
    // The old test never reached defaultWire because the deleted guard threw
    // first, so letting it through now would be a new hazard, not a fuller test.
    // What abDispatch itself owns is: don't reject, and hand the resolved
    // config to the wire. That the config then yields a FileTicketSource under
    // the repo is proven against the real factory in
    // ports/tickets/create.test.ts, and end-to-end through a real dispatcher
    // tick in processes/dispatcher-file-tickets.test.ts.
    const tmp = await mkdtemp(join(tmpdir(), 'ab-dispatch-'))
    try {
      await writeFile(
        join(tmp, 'autobuild.toml'),
        '[project]\nbaseBranch = "main"\n[dispatcher]\ncapacity = 1\n',
      )
      let wired: Config | undefined
      const store = new MemoryBuildStore({ clock: systemClock })

      await abDispatch({
        targetRepo: tmp,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: () => {},
        once: true,
        wire: (config) => {
          wired = config
          return {
            store,
            tickets: new FakeTicketSource([]),
            forge: new FakeForge(),
            workspaces: new GitWorktreeProvider({ root: join(tmp, 'worktrees') }),
            runners: {},
            defaultRunner: 'claude',
            storeRef: join(tmp, 'store'),
            ids: sequentialIds(),
            clock: systemClock,
          }
        },
      })

      // Reaching the wire at all IS the assertion: the guard used to throw
      // before this point.
      expect(wired?.tickets).toEqual({ source: 'file' })
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
      // per-tick abort. (T-9 never appears: this config's source is `file`,
      // whose readyState defaults to `Ready`, so an In-Progress ticket is not
      // a candidate in the first place — see readyCriteria.)
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
})

/** A TerminalOut that claims to be a TTY and records every raw write. */
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

  test('prints a SUPERSET of plain mode — the dashboard adds, never removes', async () => {
    // Plan@4 suppressed the tick report and the parked line on the rationale
    // that "the dashboard conveys both". It does not: a parked-`done` build is
    // filtered OUT of the dashboard by construction, and TickReport carries
    // counts no row ever shows. Suppressing them would be an unrequested
    // information regression, worst in the interactive --once an operator runs
    // by hand.
    const fx = await makeFixture(readyTicket('T-super'), happyHandlers())
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
      expect(out.some((line) => line.includes(`build ${slug} parked`))).toBe(true)
      expect(out.some((line) => line.startsWith('tick: dispatched=1'))).toBe(true)
      expect(out.some((line) => line.includes('one pass over'))).toBe(true)
      // …and the final frame is still on screen at exit.
      expect(term.all()).toContain(slug)
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
      expect(term.all()).toContain('ab dispatch') // the header survives
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

  /**
   * The reconcile guard where this branch's dashboard met main's dependency
   * diagnostics: main added them to `printReport` writing straight to
   * `opts.stdout`, which on a TTY lands inside the frame the region is about
   * to repaint over — the "routine runner messages must not corrupt or
   * interleave with the dashboard" criterion. They must route through `say()`.
   *
   * This is a WATCH-mode test on purpose, and neither test above can replace
   * it. In plain mode `say()` IS `opts.stdout` (no region), so both spellings
   * pass. In `--once` the only tick's diagnostics are printed BEFORE the
   * render loop has painted anything, so the region is empty and `log()`
   * degrades to a bare write — again both spellings pass. Only a tick that
   * runs while a frame is already on screen distinguishes them, and only watch
   * mode has one.
   */
  test('watch: a diagnostic on a later tick is bracketed by the region, not dropped into the frame', async () => {
    const fx = await makeFixture(
      [
        readyTicket('T-blocked-tty', { title: 'Blocked work', blockedBy: ['T-9'] }),
        readyTicket('T-9', { title: 'The blocker', state: 'In Progress' }),
      ],
      happyHandlers(),
    )
    // One interleaved transcript across BOTH sinks: asserting on `out` alone
    // cannot discriminate, because region.log() forwards to this same stdout
    // sink. The difference is only the erase/repaint the TERMINAL sees hugging
    // the write, so the two streams have to be ordered against each other.
    const transcript: string[] = []
    const term = fakeTerminal()
    const termWrite = term.write.bind(term)
    term.write = (chunk: string) => {
      termWrite(chunk)
      transcript.push(`term:${chunk}`)
    }
    const controller = new AbortController()
    // Two ticks: the first paints the header frame, the second emits its
    // diagnostic into a live region. Real (short) sleeps, so the render loop's
    // async store reads land between them rather than racing the assertion.
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
        stdout: (line) => transcript.push(`out:${line}`),
        stderr: (line) => fx.err.push(line),
        once: false,
        intervalMs: 1,
        sleep,
        signal: controller.signal,
        wire: fx.wire,
        terminal: term,
      })

      const marker = 'out:ticket T-blocked-tty blocked by T-9 (not complete)'
      // The LAST diagnostic — the one from a tick with a frame already up.
      const at = transcript.lastIndexOf(marker)
      expect(at).toBeGreaterThan(0)
      // The operator still sees WHY the ticket is sitting still (main's
      // criterion: discoverable from dispatcher output alone) — AND the region
      // ERASED the frame immediately before the write, then repainted after.
      //
      // The erase must be matched precisely (cursor-up + clear-down), not as
      // "some escape sequence": the painted frame is itself full of colour
      // escapes, so a loose /\x1b/ here matches the raw-write bug too — the
      // failure mode being guarded against is exactly `term:<frame>` followed
      // by `out:<diagnostic>` scribbled on top of it.
      expect(transcript[at - 1]).toMatch(/^term:\x1b\[\d+A\x1b\[0J$/)
      expect(transcript[at + 1]).toMatch(/^term:\x1b\[1mab dispatch/)
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
})
