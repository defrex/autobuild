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
import type { TerminalOut } from './terminal'
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
  ticket: Ticket,
  handlers: SkillHandlers,
  toml = DISPATCH_CONFIG_TOML,
): Promise<Fixture> {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-dispatch-'))
  const origin = join(tmp, 'origin')
  await initOrigin(origin, toml)

  const ids = sequentialIds()
  const store = new MemoryBuildStore({ clock: systemClock })
  const forge = new FakeForge()
  const tickets = new FakeTicketSource([ticket])
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

function readyTicket(id: string): Ticket {
  return {
    ref: { source: 'fake', id, title: 'Add rate limiting' },
    title: 'Add rate limiting',
    body: CONFORMING_BODY,
    state: 'Ready',
    labels: ['autobuild'],
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
