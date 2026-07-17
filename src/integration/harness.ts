/**
 * End-to-end harness (SPEC §15.6 as LIVE scenarios, §8.7, §12, §15.7):
 * real components everywhere the seam matters.
 *
 * - ONE MemoryBuildStore shared by dispatcher, build-runner, and every CLI
 *   invocation (steppingClock so store-assigned `ts` are deterministic).
 * - A REAL temp git repo as the origin, with a committed autobuild.toml
 *   fixture (§16.1 D9) whose check command is controllable: `test -f
 *   ok.marker` fails until an implement round commits the marker.
 * - REAL worktrees via GitWorktreeProvider for the dispatcher's provisioning.
 * - A Dispatcher whose `launchRunner` constructs a REAL in-process
 *   BuildRunner over the SAME store and the provisioned workspace path.
 * - THE POINT — scripted agents drive the REAL `ab` CLI: each script derives
 *   CliDeps from its ScriptContext (store = the shared store, env =
 *   resolveCliEnv(ctx.opts.env), workspacePath = ctx.opts.workspacePath,
 *   forge = the shared FakeForge, exec = spawnExec — real git) and invokes
 *   runCli(argv, deps) exactly like an agent typing `ab` commands (§8).
 *   A nonzero exit inside a script is a seam failure: it is recorded in
 *   `cliErrors` and thrown with the captured stderr.
 *
 * Only the world's edges are fakes, both journaled: FakeForge (D7 §8.6 —
 * agents never touch the remote, so a journal IS the remote) and
 * FakeTicketSource (§13 — projections flow outward only).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveCliEnv, type CliEnv } from '../cli/env'
import { runCli } from '../cli/main'
import { parseConfig } from '../config/load'
import type { Config } from '../config/schema'
import type { AbEvent } from '../events/catalog'
import type { EventType } from '../events/payloads'
import { sequentialIds, type IdSource } from '../ids'
import type { BuildState } from '../kernel/reducer'
import { FakeForge } from '../ports/forge/fake'
import {
  defaultTurnResult,
  ScriptedAgentRunner,
  type Script,
  type ScriptContext,
} from '../ports/runner/fake'
import { FakeTicketSource } from '../ports/tickets/fake'
import type { AgentTurnResult, Ticket, TicketSource } from '../ports/types'
import { GitWorktreeProvider, spawnExec } from '../ports/workspace/git-worktree'
import { BuildRunner } from '../processes/build-runner'
import { Dispatcher } from '../processes/dispatcher'
import { MemoryBuildStore } from '../store/memory'
import { steppingClock } from '../testing/fixed'

// ── The committed autobuild.toml fixture (§16.1) ─────────────────────────────
//
// The check command is the harness's control knob (§15.6-A): `test -f
// ok.marker` fails until an implement round commits the marker file.

export const CONFIG_TOML = `
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
capacity = 2
readyLabels = ["autobuild"]
readyState = "Ready"
`

/** Conforming per the dispatcher's exported heuristic (§6.3,
 * docs/spec-standard.md): nonempty body, '## Acceptance criteria' with a
 * list item, '## Out of scope'. */
export const CONFORMING_BODY = [
  'Login attempts are currently unlimited; throttle repeated failures.',
  '',
  '## Acceptance criteria',
  '',
  '- a sixth failed login within five minutes returns 429',
  '',
  '## Out of scope',
  '',
  '- captcha',
  '',
].join('\n')

export function readyTicket(
  id: string,
  over: Partial<Omit<Ticket, 'ref'>> = {},
): Ticket {
  const title = over.title ?? 'Add rate limiting'
  return {
    ref: { source: 'fake', id, title },
    title,
    body: over.body ?? CONFORMING_BODY,
    state: over.state ?? 'Ready',
    labels: over.labels ?? ['autobuild'],
  }
}

// ── Real-git helpers ─────────────────────────────────────────────────────────

/** Identity/signing pinned per invocation so tests ignore user git config. */
export const GIT_ID = [
  '-c',
  'user.email=ab@e2e.invalid',
  '-c',
  'user.name=ab-e2e',
  '-c',
  'commit.gpgsign=false',
]

export async function git(args: string[], cwd: string): Promise<string> {
  const result = await spawnExec(['git', ...args], { cwd })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

/** Stage everything and commit; returns the commit sha. `.ab/` never dirties
 * the tree (§7) because `ab context` writes a self-excluding
 * `.ab/.gitignore` — the origin deliberately does NOT ignore it, exactly
 * like a real repo, so these scenarios exercise that mechanism. */
export async function commitAll(ws: string, message: string): Promise<string> {
  await git(['add', '-A'], ws)
  await git([...GIT_ID, 'commit', '-q', '-m', message], ws)
  return git(['rev-parse', 'HEAD'], ws)
}

export async function writeFileIn(
  dir: string,
  rel: string,
  content: string,
): Promise<string> {
  const path = join(dir, rel)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  return path
}

async function initOrigin(dir: string, configToml: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await git(['init', '-q', '-b', 'main'], dir)
  // No `.ab/` ignore here — see commitAll: the product establishes it.
  await writeFile(join(dir, 'autobuild.toml'), configToml)
  await writeFile(join(dir, 'README.md'), 'e2e origin\n')
  await git(['add', '-A'], dir)
  await git([...GIT_ID, 'commit', '-q', '-m', 'initial'], dir)
}

// ── Event helpers ────────────────────────────────────────────────────────────

export function typesOf(events: AbEvent[]): string[] {
  return events.map((event) => event.type)
}

export function ofType<T extends EventType>(
  events: AbEvent[],
  type: T,
): Extract<AbEvent, { type: T }>[] {
  return events.filter(
    (event): event is Extract<AbEvent, { type: T }> => event.type === type,
  )
}

/** The agent session an event was emitted under (throws on non-agent actors
 * so a wrong-actor event fails the test loudly). */
export function agentSession(event: AbEvent): string {
  if (event.actor.kind !== 'agent') {
    throw new Error(`${event.type} (seq ${event.seq}) has a ${event.actor.kind} actor, not agent`)
  }
  return event.actor.session
}

/** Latest `workspace.provisioned` ref not followed by `workspace.released`
 * (same projection the dispatcher's janitor scans for). */
export function openWorkspaceRef(events: AbEvent[]): string | null {
  let open: string | null = null
  for (const event of events) {
    if (event.type === 'workspace.provisioned') open = event.payload.ref
    else if (event.type === 'workspace.released') open = null
  }
  return open
}

// ── Scripted agents over the real CLI ────────────────────────────────────────

/**
 * What a skill handler gets per turn: the real `ab` CLI bound to this
 * session's ambient auth (D8) and the real worktree.
 */
export interface Cli {
  /** Invoke the REAL `ab` CLI (runCli); returns stdout lines. A nonzero exit
   * is a seam failure — recorded in harness.cliErrors and thrown with the
   * captured stderr. */
  run(argv: string[]): Promise<string[]>
  /** Absolute path of the real worktree (ctx.opts.workspacePath). */
  ws: string
  /** This turn's round, resolved from ambient AB_PHASE (D8) — the runner
   * re-issues the env on every continued producer turn (§10). */
  round: number
  /** The ambient env this turn resolved (D8). */
  env: CliEnv
  ctx: ScriptContext
}

export type SkillHandler = (
  cli: Cli,
) => Promise<AgentTurnResult | undefined | void> | AgentTurnResult | undefined | void

/** Scripts are routed by ctx.opts.skill — one handler per phase skill. */
export type SkillHandlers = Record<string, SkillHandler>

// ── The harness ──────────────────────────────────────────────────────────────

export interface E2eHarness {
  tmp: string
  /** The real origin repo (also the dispatcher's `repo`). */
  origin: string
  store: MemoryBuildStore
  clock: ReturnType<typeof steppingClock>
  ids: IdSource
  forge: FakeForge
  tickets: FakeTicketSource
  workspaces: GitWorktreeProvider
  agents: ScriptedAgentRunner
  dispatcher: Dispatcher
  config: Config
  /** BuildRunners constructed by the dispatcher's launchRunner, in order.
   * launchRunner only CONSTRUCTS (the dispatcher never awaits a pipeline);
   * tests run them via runLatest(). */
  launched: Array<{ slug: string; runner: BuildRunner }>
  /** Nonzero-exit `ab` invocations (message + stderr). Scenarios assert []. */
  cliErrors: string[]
  /** Run the most recently launched BuildRunner to its park point (§11). */
  runLatest(): Promise<BuildState>
  events(slug: string): Promise<AbEvent[]>
  cleanup(): Promise<void>
}

export async function makeHarness(opts: {
  handlers: SkillHandlers
  tickets?: Ticket[]
  /** Drive the dispatcher with a REAL TicketSource instead of the fake — e.g.
   * FileTicketSource, to prove the source's own dependency representation and
   * lifecycle end-to-end. `h.tickets` stays the (then unused) fake. */
  ticketSource?: TicketSource
  /** The committed autobuild.toml (§16.1) driving this build. Default
   * CONFIG_TOML, so every existing scenario is untouched; a scenario proving
   * two-axis routing (§9) supplies its own `[roles.default]`/phase roles. */
  configToml?: string
}): Promise<E2eHarness> {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-e2e-'))
  const origin = join(tmp, 'origin')
  const configToml = opts.configToml ?? CONFIG_TOML
  await initOrigin(origin, configToml)

  const clock = steppingClock()
  const ids = sequentialIds()
  const store = new MemoryBuildStore({ clock })
  const forge = new FakeForge()
  const tickets = new FakeTicketSource(opts.tickets ?? [])
  const ticketSource: TicketSource = opts.ticketSource ?? tickets
  const workspaces = new GitWorktreeProvider({ root: join(tmp, 'worktrees') })
  const config = parseConfig(configToml, 'e2e autobuild.toml')

  const launched: Array<{ slug: string; runner: BuildRunner }> = []
  const cliErrors: string[] = []

  // The script IS the agent (§9): route by skill, hand the handler the real
  // CLI bound to this turn's ambient env (D8).
  const script: Script = async (ctx) => {
    const handler =
      opts.handlers[ctx.opts.skill] ?? opts.handlers[ctx.opts.skill.replace(/^ab-/, '')]
    if (handler === undefined) {
      throw new Error(`no scripted handler for skill "${ctx.opts.skill}"`)
    }
    const result = await handler(makeCli(ctx))
    return result ?? defaultTurnResult(`${ctx.opts.skill} finished`)
  }
  const agents = new ScriptedAgentRunner({ script })

  function makeCli(ctx: ScriptContext): Cli {
    // D8, VERBATIM: exactly what the real adapters do — the CLI resolves the
    // env the turn was launched with, nothing rebuilt by the harness. The
    // runner re-issues AB_PHASE/AB_SESSION on every continued producer turn
    // (§10, build-runner.ts executeSession); a harness that hand-advanced
    // the round here would mask a stale-env adapter (the continued round's
    // `ab done` would resolve round 1 and be rejected as a D5 second call).
    const env = resolveCliEnv(ctx.opts.env)
    const ws = ctx.opts.workspacePath

    const run = async (argv: string[]): Promise<string[]> => {
      const out: string[] = []
      const err: string[] = []
      const code = await runCli(argv, {
        store,
        env,
        workspacePath: ws,
        forge,
        exec: spawnExec,
        ids,
        clock,
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      })
      if (code !== 0) {
        const message =
          `ab ${argv.join(' ')} exited ${code} in ${env.phase}@${env.round}: ` +
          `${err.join('\n') || '(no stderr)'}`
        cliErrors.push(message)
        throw new Error(message)
      }
      return out
    }
    return { run, ws, round: env.round, env, ctx }
  }

  // launchRunner (§3.3, §15.6-C, §15.7): construct a REAL BuildRunner over
  // the SAME store and the provisioned workspace path; the dispatcher never
  // runs agents itself.
  let instances = 0
  const launchRunner = async (slug: string): Promise<void> => {
    const record = await store.getBuild(slug)
    const wsRef = openWorkspaceRef(await store.getEvents(slug))
    if (record === null || wsRef === null) {
      throw new Error(`launchRunner("${slug}"): no build record or open workspace`)
    }
    instances += 1
    launched.push({
      slug,
      runner: new BuildRunner({
        store,
        config,
        // Two-axis registry (§9): every runtime is backed by the SAME scripted
        // runner instance, so the `s_1…s_N` session numbering scenarios rely on
        // is preserved regardless of which runtime a role selects. `scripted`
        // is the fallback and runs only with its un-named built-in model; `pi`
        // serves the Kimi family for exact configured-pair validation.
        runtimes: {
          scripted: { runner: agents, servesModels: [] },
          claude: { runner: agents, servesModels: ['claude-'] },
          pi: { runner: agents, servesModels: ['kimi-'] },
        },
        defaultRuntime: 'scripted',
        workspacePath: wsRef,
        branch: record.branch ?? `ab/${slug}`,
        slug,
        exec: spawnExec,
        ids,
        clock,
        instance: `runner-${instances}`,
        host: 'e2e-host',
        // Long lease/heartbeat: liveness is driven by the shared stepping
        // clock; scenarios advance it explicitly to expire a lease.
        opts: { heartbeatMs: 3_600_000, leaseTtlMs: 3_600_000 },
      }),
    })
  }

  const dispatcher = new Dispatcher({
    store,
    tickets: ticketSource,
    workspaces,
    forge,
    config,
    repo: origin,
    exec: spawnExec,
    launchRunner,
    ids,
    clock,
  })

  return {
    tmp,
    origin,
    store,
    clock,
    ids,
    forge,
    tickets,
    workspaces,
    agents,
    dispatcher,
    config,
    launched,
    cliErrors,
    async runLatest(): Promise<BuildState> {
      const entry = launched.at(-1)
      if (entry === undefined) throw new Error('runLatest: nothing launched')
      return entry.runner.run()
    },
    events: (slug) => store.getEvents(slug),
    cleanup: async () => {
      await store.close()
      await rm(tmp, { recursive: true, force: true })
    },
  }
}

// ── Default (§15.6 happy-path) handlers over the REAL CLI ────────────────────

/**
 * Every phase terminates the way §8.7 walks it: `ab context`, real work in
 * the worktree (implement commits with real git), deposits via `ab artifact
 * put`, exactly one terminal (`ab done` / `ab verdict`). Scenarios override
 * individual entries.
 */
export function happyHandlers(): SkillHandlers {
  return {
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
      const notes = await writeFileIn(
        cli.ws,
        '.ab/plan-review.md',
        'Plan conforms to the spec.\n',
      )
      await cli.run(['verdict', 'approve', '--notes', notes])
    },
    implement: async (cli) => {
      await cli.run(['context'])
      await writeFileIn(cli.ws, 'rate-limit.txt', `throttle after 5 (r${cli.round})\n`)
      await writeFileIn(cli.ws, 'ok.marker', 'ok\n')
      await commitAll(cli.ws, `implement: rate limiting r${cli.round}`)
      // §8.7: a mid-phase structured observation — never a terminal.
      await cli.run(['observe', '--kind', 'refactor', 'extract limiter config into settings'])
      const notes = await writeFileIn(
        cli.ws,
        '.ab/implement-notes.md',
        `Added rate-limit.txt (round ${cli.round}).\n`,
      )
      await cli.run(['done', '--notes', notes])
    },
    'code-review': async (cli) => {
      await cli.run(['context'])
      const notes = await writeFileIn(
        cli.ws,
        '.ab/code-review.md',
        'Diff matches the approved plan.\n',
      )
      await cli.run(['verdict', 'approve', '--notes', notes])
    },
    finalize: async (cli) => {
      await cli.run(['context'])
      const pr = await writeFileIn(
        cli.ws,
        '.ab/pr-description.md',
        'Add login rate limiting\n\nThrottles repeated failed logins per the spec.\n',
      )
      await cli.run(['artifact', 'put', 'pr-description', pr])
      await cli.run(['done'])
    },
  }
}
