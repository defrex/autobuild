/**
 * Build-runner process tests (SPEC §3.3, §8, §9, §10, §15.6, D5, D10): memory
 * store + ScriptedAgentRunner + FakeWorkspaceProvider + fake ServerLifecycle
 * + fake exec. The scripts SIMULATE what the `ab` CLI would do — they append
 * events and deposit artifacts through the store directly, using the ambient
 * session id the runner injected (AB_SESSION, D8), exactly as `ab done` /
 * `ab verdict` would. Event sequences are asserted as type lists; payloads
 * are spot-checked where the rule lives (feedback, attempts, transcript
 * metadata, actor kinds).
 */
import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import type { AbEvent } from '../events/catalog'
import { DISPATCHER, KERNEL, agentActor, humanActor } from '../events/envelope'
import type { EventType } from '../events/payloads'
import { sequentialIds } from '../ids'
import type { Decision } from '../kernel/engine'
import type { Finding } from '../ontology'
import {
  ScriptedAgentRunner,
  defaultTurnResult,
  type Script,
  type ScriptContext,
} from '../ports/runner/fake'
import type { AgentTurnResult } from '../ports/types'
import { FakeWorkspaceProvider } from '../ports/workspace/fake'
import type { Exec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import type { ArtifactMeta, BuildStore, Clock } from '../store/types'
import { manualClock, steppingClock } from '../testing/fixed'
import { BuildRunner, LeaseHeldError, type ServerLifecycle } from './build-runner'

const SLUG = 'auth-rate-limit'
const BRANCH = 'ab/auth-rate-limit'
const TICKET = { source: 'linear', id: 'ENG-42', title: 'Auth rate limiting' }

// Mirrors §16.1: two check steps (types, unit) + one agent step (e2e,
// needsServer), one finalize post-step, one routed role with a model.
const CONFIG_TOML = `
[tickets]
source = "file"
readyState = "ready"

[commands]
typecheck = "bun tsc --noEmit"
test = "bun test"

[server]
start = "bun dev"
url = "http://localhost:3000"

[verify]
steps = ["types", "unit", "e2e"]

[verify.types]
kind = "check"
command = "typecheck"

[verify.unit]
kind = "check"
command = "test"

[verify.e2e]
kind = "agent"
skill = "ab-verify-e2e"
needsServer = true

[finalize]
steps = ["release-notes"]

[roles]
plan = { runtime = "scripted", model = "m-plan" }
`
const config = parseConfig(CONFIG_TOML)

// ── Script plumbing (the fake ab CLI) ────────────────────────────────────────

type SkillHandler = (ctx: ScriptContext) => Promise<AgentTurnResult> | AgentTurnResult

/** The ambient session id (D8) — what the real CLI reads from AB_SESSION.
 * Resolved VERBATIM from this turn's env: the runner re-issues it on every
 * continued producer turn (§10), so the fake CLI never rebuilds it. */
function sessionOf(ctx: ScriptContext): string {
  return ctx.opts.env['AB_SESSION'] ?? ctx.session.id
}

/** Round from ambient AB_PHASE, resolved VERBATIM (D8) — the runner
 * re-issues the env per continued turn (§10); rebuilding the round from
 * ctx.turn here would mask a stale-env adapter. */
function roundOf(ctx: ScriptContext): number {
  const raw = ctx.opts.env['AB_PHASE'] ?? ''
  const at = raw.lastIndexOf('@')
  return at === -1 ? 1 : Number(raw.slice(at + 1)) || 1
}

function refOf(deposited: ArtifactMeta[]): { kind: string; rev: number } {
  const meta = deposited[0]
  if (!meta) throw new Error('deposit produced no artifact meta')
  return { kind: meta.kind, rev: meta.revision }
}

const FINDING: Finding = {
  id: 'f_1',
  severity: 'blocking',
  summary: 'limiter misses the login route',
  persists: [],
}

async function reviewVerdict(
  store: BuildStore,
  ctx: ScriptContext,
  phase: 'plan-review' | 'code-review',
  verdict: 'approve' | 'revise' | 'escalate',
  findings: Finding[] = [],
  reason?: string,
): Promise<void> {
  const round = roundOf(ctx)
  const base = {
    round,
    verdict,
    findings,
    ...(reason !== undefined ? { reason } : {}),
  }
  if (phase === 'plan-review') {
    await store.appendWithArtifacts(
      SLUG,
      [{ kind: 'plan-review', content: `plan review r${round}` }],
      (dep) => ({
        actor: agentActor(phase, sessionOf(ctx)),
        type: 'plan-review.verdict',
        payload: { ...base, artifact: refOf(dep) },
      }),
    )
  } else {
    await store.appendWithArtifacts(
      SLUG,
      [{ kind: 'code-review', content: `code review r${round}` }],
      (dep) => ({
        actor: agentActor(phase, sessionOf(ctx)),
        type: 'code-review.verdict',
        payload: { ...base, artifact: refOf(dep) },
      }),
    )
  }
}

/** The §15.6 happy-path cast: every phase terminates the way `ab` would. */
function happyHandlers(store: BuildStore): Record<string, SkillHandler> {
  return {
    plan: async (ctx) => {
      const round = roundOf(ctx)
      await store.appendWithArtifacts(
        SLUG,
        [{ kind: 'plan', content: `plan r${round}` }],
        (dep) => ({
          actor: agentActor('plan', sessionOf(ctx)),
          type: 'plan.completed',
          payload: { round, artifact: refOf(dep) },
        }),
      )
      return defaultTurnResult('planned')
    },
    'plan-review': async (ctx) => {
      await reviewVerdict(store, ctx, 'plan-review', 'approve')
      return defaultTurnResult('plan approved')
    },
    implement: async (ctx) => {
      const round = roundOf(ctx)
      await store.appendWithArtifacts(
        SLUG,
        [{ kind: 'implement-notes', content: `notes r${round}` }],
        (dep) => ({
          actor: agentActor('implement', sessionOf(ctx)),
          type: 'implement.completed',
          payload: {
            round,
            commits: { base: 'sha-base', head: `sha-head-${round}` },
            artifact: refOf(dep),
          },
        }),
      )
      return defaultTurnResult(`implemented r${round}`)
    },
    'code-review': async (ctx) => {
      await reviewVerdict(store, ctx, 'code-review', 'approve')
      return defaultTurnResult('code approved')
    },
    'verify-e2e': async (ctx) => {
      await store.append(SLUG, {
        actor: agentActor('verify-e2e', sessionOf(ctx)),
        type: 'verify.completed',
        payload: { step: 'e2e', attempt: roundOf(ctx), pass: true },
      })
      return defaultTurnResult('e2e green')
    },
    finalize: async (ctx) => {
      // D7: `ab done` in finalize has the KERNEL open the PR — the script
      // simulates that plumbing, so finalize.completed is a kernel event.
      void ctx
      await store.appendWithArtifacts(
        SLUG,
        [{ kind: 'pr-description', content: 'Adds auth rate limiting' }],
        () => ({
          actor: KERNEL,
          type: 'finalize.completed',
          payload: {
            pr: { number: 7, url: 'https://forge.test/acme/app/pull/7', headSha: 'sha-head-1' },
          },
        }),
      )
      return defaultTurnResult('finalized')
    },
    'release-notes': () => defaultTurnResult('notes posted'),
    reconcile: async (ctx) => {
      await store.appendWithArtifacts(
        SLUG,
        [{ kind: 'reconcile-notes', content: 'merged main into branch' }],
        (dep) => ({
          actor: agentActor('reconcile', sessionOf(ctx)),
          type: 'reconcile.completed',
          payload: { mergeCommit: 'sha-merge-1', artifact: refOf(dep) },
        }),
      )
      return defaultTurnResult('reconciled')
    },
  }
}

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakeServer implements ServerLifecycle {
  constructor(private readonly ops: string[]) {}
  async ensureStarted(): Promise<void> {
    this.ops.push('server:ensureStarted')
  }
  async stop(): Promise<void> {
    this.ops.push('server:stop')
  }
}

// ── Harness ──────────────────────────────────────────────────────────────────

interface HarnessOptions {
  handlers?: (store: BuildStore) => Record<string, SkillHandler>
  noServer?: boolean
  /** Shell commands (the `sh -c` argument) that exit 1 with output. */
  failCommands?: string[]
  sessionEnv?: Record<string, string>
  runnerOpts?: { maxPhaseAttempts?: number; heartbeatMs?: number; leaseTtlMs?: number }
  clock?: Clock
  /** Seed build.created + workspace.provisioned + spec@0 + spec.imported
   * (§15.6 prelude). Default true. */
  seedPrelude?: boolean
  /** Replaces the module config (parseConfig of this TOML) — e.g. to add a
   * [commands].setup for the §16.1 attach tests. */
  configToml?: string
}

interface Harness {
  store: MemoryBuildStore
  runner: ScriptedAgentRunner
  br: BuildRunner
  ops: string[]
  execCalls: Array<{ cmd: string[]; cwd: string | undefined }>
  workspacePath: string
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = options.clock ?? steppingClock()
  const store = new MemoryBuildStore({ clock })
  const workspaces = new FakeWorkspaceProvider()
  const handle = await workspaces.provision({
    repo: 'acme/app',
    baseBranch: 'main',
    branch: BRANCH,
  })
  await store.createBuild({ slug: SLUG, repo: 'acme/app', ticket: TICKET, branch: BRANCH })
  if (options.seedPrelude !== false) {
    await store.append(SLUG, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { ticket: TICKET, repo: 'acme/app', baseBranch: 'main' },
    })
    await store.append(SLUG, {
      actor: DISPATCHER,
      type: 'workspace.provisioned',
      payload: { provider: handle.provider, ref: handle.ref, branch: handle.branch },
    })
    await store.appendWithArtifacts(
      SLUG,
      [{ kind: 'spec', content: '# Spec: rate limit auth endpoints' }],
      (dep) => ({
        actor: DISPATCHER,
        type: 'spec.imported',
        payload: { artifact: refOf(dep), ticket: TICKET },
      }),
    )
  }

  const ops: string[] = []
  const table = (options.handlers ?? happyHandlers)(store)
  const script: Script = async (ctx) => {
    ops.push(`session:${ctx.opts.skill}`)
    const handler = table[ctx.opts.skill] ?? table[ctx.opts.skill.replace(/^ab-/, '')]
    if (!handler) throw new Error(`no handler for skill "${ctx.opts.skill}"`)
    return handler(ctx)
  }
  const runner = new ScriptedAgentRunner({ script })

  const failing = new Set(options.failCommands ?? [])
  const execCalls: Array<{ cmd: string[]; cwd: string | undefined }> = []
  const exec: Exec = async (cmd, opts) => {
    execCalls.push({ cmd, cwd: opts.cwd })
    const shell = cmd[2] ?? ''
    return failing.has(shell)
      ? {
          stdout: 'src/auth.ts(3,7): error TS2304: Cannot find name',
          stderr: 'typecheck failed',
          exitCode: 1,
        }
      : { stdout: 'ok', stderr: '', exitCode: 0 }
  }

  const server = options.noServer === true ? undefined : new FakeServer(ops)
  const br = new BuildRunner({
    store,
    config: options.configToml !== undefined ? parseConfig(options.configToml) : config,
    runtimes: {
      // `scripted` (the default runtime) serves the `m-` family so the routed
      // `plan = { runtime = "scripted", model = "m-plan" }` role resolves; the
      // pi/claude entries prove a second runtime is selectable.
      scripted: { runner, servesModels: ['m-'] },
      claude: { runner, servesModels: ['claude-'] },
      pi: { runner, servesModels: ['kimi-'] },
    },
    defaultRuntime: 'scripted',
    workspacePath: handle.path,
    branch: BRANCH,
    slug: SLUG,
    exec,
    ...(server !== undefined ? { server } : {}),
    ids: sequentialIds(),
    clock,
    instance: 'runner-1',
    host: 'sandbox-a',
    ...(options.sessionEnv !== undefined ? { sessionEnv: options.sessionEnv } : {}),
    ...(options.runnerOpts !== undefined ? { opts: options.runnerOpts } : {}),
  })
  return { store, runner, br, ops, execCalls, workspacePath: handle.path }
}

// ── Seed helpers (dead-sandbox logs, engine-state shortcuts) ─────────────────

async function seedPlanApproved(store: BuildStore): Promise<void> {
  await store.append(SLUG, { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
  await store.append(SLUG, {
    actor: agentActor('plan', 's_seed'),
    type: 'plan.completed',
    payload: { round: 1, artifact: { kind: 'plan', rev: 0 } },
  })
  await store.append(SLUG, { actor: KERNEL, type: 'plan-review.started', payload: { round: 1 } })
  await store.append(SLUG, {
    actor: agentActor('plan-review', 's_seed'),
    type: 'plan-review.verdict',
    payload: { round: 1, verdict: 'approve', findings: [], artifact: { kind: 'plan-review', rev: 0 } },
  })
}

async function seedCodeApproved(store: BuildStore): Promise<void> {
  await store.append(SLUG, { actor: KERNEL, type: 'implement.started', payload: { round: 1 } })
  await store.append(SLUG, {
    actor: agentActor('implement', 's_seed'),
    type: 'implement.completed',
    payload: {
      round: 1,
      commits: { base: 'sha-base', head: 'sha-head-1' },
      artifact: { kind: 'implement-notes', rev: 0 },
    },
  })
  await store.append(SLUG, { actor: KERNEL, type: 'code-review.started', payload: { round: 1 } })
  await store.append(SLUG, {
    actor: agentActor('code-review', 's_seed'),
    type: 'code-review.verdict',
    payload: { round: 1, verdict: 'approve', findings: [], artifact: { kind: 'code-review', rev: 0 } },
  })
}

async function typesOf(store: BuildStore): Promise<string[]> {
  return (await store.getEvents(SLUG)).map((event) => event.type)
}

function ofType<T extends EventType>(
  events: AbEvent[],
  type: T,
): Extract<AbEvent, { type: T }>[] {
  return events.filter(
    (event): event is Extract<AbEvent, { type: T }> => event.type === type,
  )
}

// ── attach (§7.4) ────────────────────────────────────────────────────────────

describe('attach', () => {
  test('claims the lease, appends runner.attached (no resumedFromSeq on an empty log), and heartbeats', async () => {
    const clock = manualClock()
    const h = await makeHarness({ clock, seedPrelude: false })
    await h.br.attach()

    const events = await h.store.getEvents(SLUG)
    expect(events.map((e) => e.type)).toEqual(['runner.attached'])
    const attached = ofType(events, 'runner.attached')[0]!
    expect(attached.actor).toEqual({ kind: 'kernel' })
    expect(attached.payload.instance).toBe('runner-1')
    expect(attached.payload.host).toBe('sandbox-a')
    expect(attached.payload.resumedFromSeq).toBeUndefined()

    const record = await h.store.getBuild(SLUG)
    expect(record?.lease?.holder).toBe('runner-1')
    expect(record?.heartbeatAt).toBeDefined()
  })

  test('appends resumedFromSeq = last seq on a non-empty log', async () => {
    const h = await makeHarness()
    await h.br.attach()
    const events = await h.store.getEvents(SLUG)
    const attached = ofType(events, 'runner.attached')[0]!
    expect(attached.seq).toBe(4)
    expect(attached.payload.resumedFromSeq).toBe(3)
  })

  test('throws LeaseHeldError while another holder is live (§7.4)', async () => {
    const clock = manualClock()
    const h = await makeHarness({ clock })
    expect(await h.store.claimLease(SLUG, 'other-sandbox', 60_000)).toBe(true)

    expect(h.br.attach()).rejects.toBeInstanceOf(LeaseHeldError)
    // Nothing was appended: the build still belongs to the live holder.
    expect(await typesOf(h.store)).toEqual([
      'build.created',
      'workspace.provisioned',
      'spec.imported',
    ])
    expect((await h.store.getBuild(SLUG))?.lease?.holder).toBe('other-sandbox')
  })

  test('an expired lease is claimable — dead-sandbox takeover (§7.4)', async () => {
    const clock = manualClock()
    const h = await makeHarness({ clock })
    expect(await h.store.claimLease(SLUG, 'dead-sandbox', 1000)).toBe(true)
    clock.advance(1001)
    await h.br.attach()
    expect((await h.store.getBuild(SLUG))?.lease?.holder).toBe('runner-1')
  })
})

// ── Lease loss mid-run (§7.4, §15.2.6) ───────────────────────────────────────

describe('lease loss (§7.4)', () => {
  test('a heartbeat reporting the lease lost stops the runner at the next loop boundary', async () => {
    // Regression: the heartbeat's boolean was discarded, so a lapsed-but-alive
    // runner kept executing (and appending) alongside the sweep's replacement
    // — two live runners driving one build and one worktree. heartbeat() is a
    // no-op `false` once the lease expired (store contract): only claimLease
    // re-takes it, and a live replacement makes that claim fail.
    const clock = manualClock()
    const h = await makeHarness({
      clock,
      runnerOpts: { heartbeatMs: 1, leaseTtlMs: 1000 },
      handlers: (store) => ({
        ...happyHandlers(store),
        plan: async (ctx) => {
          // The runner stalls past its TTL (suspension, store outage, GC…);
          // the dispatcher's sweep launches a replacement that claims the
          // lease. Real time passes so the 1ms heartbeat interval fires and
          // observes the loss.
          clock.advance(2000)
          await store.claimLease(SLUG, 'replacement', 60_000)
          await new Promise((resolve) => setTimeout(resolve, 50))
          const round = roundOf(ctx)
          await store.appendWithArtifacts(
            SLUG,
            [{ kind: 'plan', content: `plan r${round}` }],
            (dep) => ({
              actor: agentActor('plan', sessionOf(ctx)),
              type: 'plan.completed',
              payload: { round, artifact: refOf(dep) },
            }),
          )
          return defaultTurnResult('planned')
        },
      }),
    })

    // The in-flight turn finishes (it cannot be interrupted), but the next
    // loop boundary re-claims, fails against the live replacement, and stops.
    await expect(h.br.run()).rejects.toBeInstanceOf(LeaseHeldError)
    expect((await h.store.getBuild(SLUG))?.lease?.holder).toBe('replacement')
    // Only the plan session ever ran — nothing executed without the lease.
    expect(h.runner.sessions.size).toBe(1)
    expect((await typesOf(h.store)).filter((t) => t === 'plan-review.started')).toEqual([])
  })

  test('a lapsed lease nobody claimed is re-taken and the run continues (§15.6-C)', async () => {
    const clock = manualClock()
    const h = await makeHarness({
      clock,
      runnerOpts: { heartbeatMs: 1, leaseTtlMs: 1000 },
      handlers: (store) => {
        const table = happyHandlers(store)
        const plan = table['plan']!
        table['plan'] = async (ctx) => {
          // Lapse without a takeover: the sweep has not run yet.
          clock.advance(2000)
          await new Promise((resolve) => setTimeout(resolve, 50))
          return plan(ctx)
        }
        return table
      },
    })
    const state = await h.br.run()
    expect(state.status).toBe('running') // re-claimed and finished the pipeline
    expect((await h.store.getBuild(SLUG))?.lease?.holder).toBe('runner-1')
  })
})

// ── [commands].setup (§16.1 D9, §15.6-C) ─────────────────────────────────────

describe('setup command (§16.1)', () => {
  const TOML_WITH_SETUP = CONFIG_TOML.replace(
    '[commands]',
    '[commands]\nsetup = "bun install"',
  )

  test('attach runs setup in the workspace BEFORE any phase or check work', async () => {
    // Regression: setup was never executed — a fresh worktree (git worktree
    // add: no node_modules) ran verify:types against unresolvable imports and
    // routed the bogus infra report into the code loop (§15.6-A).
    const h = await makeHarness({ configToml: TOML_WITH_SETUP })
    const state = await h.br.run()
    expect(state.status).toBe('running') // full §15.6 pipeline, unimpeded

    expect(h.execCalls[0]).toEqual({
      cmd: ['sh', '-c', 'bun install'],
      cwd: h.workspacePath,
    })
    // Checks still ran, after setup.
    expect(h.execCalls.map((c) => c.cmd[2])).toEqual([
      'bun install',
      'bun tsc --noEmit',
      'bun test',
    ])
  })

  test('a re-attach re-runs setup (§15.6-C: the sandbox-rehydrate step)', async () => {
    const h = await makeHarness({ configToml: TOML_WITH_SETUP })
    await h.br.attach()
    await h.br.attach() // a fresh sandbox resuming would attach again
    expect(h.execCalls.map((c) => c.cmd[2])).toEqual(['bun install', 'bun install'])
  })

  test('a failing setup aborts the attach with a clear error and starts no session', async () => {
    const h = await makeHarness({
      configToml: TOML_WITH_SETUP,
      failCommands: ['bun install'],
    })
    await expect(h.br.run()).rejects.toThrow(/\[commands\]\.setup "bun install" exited 1/)
    expect(h.runner.sessions.size).toBe(0) // no phase ran on a broken workspace
  })

  test('no [commands].setup → attach execs nothing (the knob is optional)', async () => {
    const h = await makeHarness()
    await h.br.attach()
    expect(h.execCalls).toEqual([])
  })
})

// ── step basics ──────────────────────────────────────────────────────────────

describe('step', () => {
  test('a wait decision executes nothing', async () => {
    const h = await makeHarness({ seedPrelude: false })
    const decision = await h.br.step()
    expect(decision).toEqual({ kind: 'wait', reason: 'awaiting-spec' })
    expect(await h.store.getEvents(SLUG)).toEqual([])
    expect(h.runner.sessions.size).toBe(0)
  })

  test('reconcile: pr.conflicted routes a reconcile run with {attempt, baseSha} (§15.7)', async () => {
    const h = await makeHarness()
    await seedPlanApproved(h.store)
    await seedCodeApproved(h.store)
    for (const step of ['types', 'unit', 'e2e']) {
      await h.store.append(SLUG, {
        actor: KERNEL,
        type: 'verify.completed',
        payload: { step, attempt: 1, pass: true },
      })
    }
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: { pr: { number: 7, url: 'https://forge.test/pr/7', headSha: 'sha-head-1' } },
    })
    await h.store.append(SLUG, {
      actor: agentActor('release-notes', 's_seed'),
      type: 'finalize.step-completed',
      payload: { step: 'release-notes', ok: true },
    })
    await h.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'pr.conflicted',
      payload: { baseSha: 'sha-main-9' },
    })

    const decision = await h.br.step()
    expect(decision).toEqual({
      kind: 'run-phase',
      phase: 'reconcile',
      round: 1,
      reconcile: { attempt: 1, baseSha: 'sha-main-9' },
    })

    const events = await h.store.getEvents(SLUG)
    expect(events.slice(-4).map((e) => e.type)).toEqual([
      'reconcile.started',
      'session.started',
      'reconcile.completed',
      'session.ended',
    ])
    const started = ofType(events, 'reconcile.started')[0]!
    expect(started.payload).toEqual({ attempt: 1, baseSha: 'sha-main-9' })

    // AB_PHASE uses the attempt as the round for reconcile (D8).
    const journal = [...h.runner.sessions.values()].find((j) => j.opts.skill === 'ab-reconcile')
    expect(journal?.opts.env['AB_PHASE']).toBe('reconcile@1')

    // Reconciliation changed code, so verify:* re-runs in full — cheap
    // checks first, at a FRESH attempt number (§15.6-A: the mainline cycle
    // already used attempt 1; reusing it would collide the reducer's
    // current-cycle projection and the D5 keys `verify:<step>` round=attempt).
    expect(await h.br.step()).toEqual({
      kind: 'run-check',
      step: 'types',
      command: 'bun tsc --noEmit',
      attempt: 2,
    })
  })
})

// ── The §15.6 happy path, live over fakes ────────────────────────────────────

describe('happy path (§15.6)', () => {
  const expectedSequence = [
    'build.created',
    'workspace.provisioned',
    'spec.imported',
    'runner.attached',
    'plan.started',
    'session.started',
    'plan.completed',
    'session.ended',
    'plan-review.started',
    'session.started',
    'plan-review.verdict',
    'session.ended',
    'implement.started',
    'session.started',
    'implement.completed',
    'session.ended',
    'code-review.started',
    'session.started',
    'code-review.verdict',
    'session.ended',
    'verify.started',
    'verify.completed',
    'verify.started',
    'verify.completed',
    'verify.started',
    'session.started',
    'verify.completed',
    'session.ended',
    'finalize.started',
    'session.started',
    'finalize.completed',
    'session.ended',
    'session.started',
    'session.ended',
    'finalize.step-completed',
  ]

  test('run() drives the full pipeline; the complete event-type sequence matches §15.6 with session brackets', async () => {
    const h = await makeHarness()
    const state = await h.br.run()
    expect(await typesOf(h.store)).toEqual(expectedSequence)
    expect(state.status).toBe('running')
    expect(state.prState).toBe('open')
    expect(state.pr).toEqual({
      number: 7,
      url: 'https://forge.test/acme/app/pull/7',
      headSha: 'sha-head-1',
    })
  })

  test('every session.ended carries a transcript artifact whose metadata names phase/round/role (§7.1)', async () => {
    const h = await makeHarness()
    await h.br.run()
    const events = await h.store.getEvents(SLUG)
    const ended = ofType(events, 'session.ended')
    expect(ended.length).toBe(7)

    const corpus: Array<[unknown, unknown, unknown]> = []
    for (const event of ended) {
      expect(event.actor).toEqual({ kind: 'kernel' })
      expect(event.payload.transcript.kind).toBe('transcript')
      const artifact = await h.store.getArtifact(SLUG, 'transcript', event.payload.transcript.rev)
      expect(artifact).not.toBeNull()
      const meta = artifact!.meta.metadata
      expect(meta['session']).toBe(event.payload.session)
      expect(meta['runner']).toBe('scripted')
      expect(meta['usage']).toEqual(event.payload.usage)
      corpus.push([meta['phase'], meta['round'], meta['role']])
    }
    expect(corpus).toEqual([
      ['plan', 1, 'plan'],
      ['plan-review', 1, 'plan-review'],
      ['implement', 1, 'implement'],
      ['code-review', 1, 'code-review'],
      ['verify:e2e', 1, 'ab-verify-e2e'],
      ['finalize', 1, 'finalize'],
      ['finalize', 1, 'release-notes'],
    ])
  })

  test('heartbeatAt advanced past creation and the lease is held', async () => {
    const h = await makeHarness()
    await h.br.run()
    const record = await h.store.getBuild(SLUG)
    expect(record?.heartbeatAt).toBeDefined()
    expect(Date.parse(record!.heartbeatAt!)).toBeGreaterThan(Date.parse(record!.createdAt))
    expect(record?.lease?.holder).toBe('runner-1')
  })

  test('invokes every installed skill through the ab-* namespace', async () => {
    const h = await makeHarness()
    await h.br.run()
    expect([...h.runner.sessions.values()].map((journal) => journal.opts.skill)).toEqual([
      'ab-plan',
      'ab-plan-review',
      'ab-implement',
      'ab-code-review',
      'ab-verify-e2e',
      'ab-finalize',
      'ab-release-notes',
    ])
  })

  test('role routing (§9): the plan session carries the configured model everywhere', async () => {
    const h = await makeHarness()
    await h.br.run()
    const events = await h.store.getEvents(SLUG)
    const planSession = ofType(events, 'session.started').find((e) => e.payload.role === 'plan')!
    expect(planSession.payload.model).toBe('m-plan')
    expect(planSession.payload.runner).toBe('scripted')

    const journal = [...h.runner.sessions.values()].find((j) => j.opts.skill === 'ab-plan')
    expect(journal?.opts.model).toBe('m-plan')

    const ended = ofType(events, 'session.ended').find(
      (e) => e.payload.session === planSession.payload.session,
    )!
    const transcript = await h.store.getArtifact(SLUG, 'transcript', ended.payload.transcript.rev)
    expect(transcript?.meta.metadata['model']).toBe('m-plan')
  })

  test('ambient env (D8): AB_STORE/AB_BUILD/AB_PHASE/AB_SESSION on the e2e session', async () => {
    const h = await makeHarness()
    await h.br.run()
    const events = await h.store.getEvents(SLUG)
    const e2eSession = ofType(events, 'session.started').find(
      (e) => e.payload.role === 'ab-verify-e2e',
    )!
    const journal = [...h.runner.sessions.values()].find((j) => j.opts.skill === 'ab-verify-e2e')!
    expect(journal.opts.env['AB_STORE']).toBe('local')
    expect(journal.opts.env['AB_BUILD']).toBe(SLUG)
    expect(journal.opts.env['AB_PHASE']).toBe('verify:e2e@1')
    expect(journal.opts.env['AB_SESSION']).toBe(e2eSession.payload.session)
  })

  test('sessionEnv spreads extra AB_* and may override AB_STORE, never the identity keys', async () => {
    const h = await makeHarness({
      sessionEnv: { AB_STORE: 'https://store.test', AB_TOKEN: 'tok_1', AB_SESSION: 'spoofed' },
    })
    await h.br.step() // plan
    const journal = [...h.runner.sessions.values()][0]!
    expect(journal.opts.env['AB_STORE']).toBe('https://store.test')
    expect(journal.opts.env['AB_TOKEN']).toBe('tok_1')
    expect(journal.opts.env['AB_BUILD']).toBe(SLUG)
    expect(journal.opts.env['AB_SESSION']).not.toBe('spoofed')
  })

  test('deterministic checks run through exec sh -c in the workspace (§8.2), commands resolved from [commands]', async () => {
    const h = await makeHarness()
    await h.br.run()
    expect(h.execCalls.map((c) => c.cmd)).toEqual([
      ['sh', '-c', 'bun tsc --noEmit'],
      ['sh', '-c', 'bun test'],
    ])
    expect(h.execCalls.every((c) => c.cwd === h.workspacePath)).toBe(true)
    const events = await h.store.getEvents(SLUG)
    const completed = ofType(events, 'verify.completed')
    expect(completed.map((e) => [e.payload.step, e.payload.pass, e.actor.kind])).toEqual([
      ['types', true, 'kernel'],
      ['unit', true, 'kernel'],
      ['e2e', true, 'agent'],
    ])
  })

  test('finalize.step-completed is recorded with the session agent actor', async () => {
    const h = await makeHarness()
    await h.br.run()
    const events = await h.store.getEvents(SLUG)
    const stepDone = ofType(events, 'finalize.step-completed')[0]!
    expect(stepDone.payload).toEqual({ step: 'release-notes', ok: true })
    expect(stepDone.actor.kind).toBe('agent')
    if (stepDone.actor.kind !== 'agent') throw new Error('unreachable')
    expect(stepDone.actor.role).toBe('release-notes')
    const notesSession = ofType(events, 'session.started').find(
      (e) => e.payload.role === 'release-notes',
    )!
    expect(stepDone.actor.session).toBe(notesSession.payload.session)
  })
})

// ── Producer session memory (§10) ────────────────────────────────────────────

function reviseThenApproveHandlers(store: BuildStore): Record<string, SkillHandler> {
  return {
    ...happyHandlers(store),
    'code-review': async (ctx) => {
      const round = roundOf(ctx)
      if (round === 1) await reviewVerdict(store, ctx, 'code-review', 'revise', [FINDING])
      else await reviewVerdict(store, ctx, 'code-review', 'approve')
      return defaultTurnResult(`reviewed r${round}`)
    },
  }
}

describe('session memory (§10)', () => {
  test('implement r2 continues the SAME producer session; the message names the findings and .ab/', async () => {
    const h = await makeHarness({ handlers: reviseThenApproveHandlers })
    const state = await h.br.run()
    expect(state.status).toBe('running') // ran through to awaiting-pr

    const implementJournals = [...h.runner.sessions.values()].filter(
      (j) => j.opts.skill === 'ab-implement',
    )
    expect(implementJournals.length).toBe(1) // ONE runner session, two rounds
    const journal = implementJournals[0]!
    expect(journal.turns.length).toBe(2)
    expect(journal.messages.length).toBe(1)
    expect(journal.messages[0]).toContain('f_1')
    expect(journal.messages[0]).toContain('.ab/')
  })

  test('reviewer rounds are FRESH sessions (fresh skeptic)', async () => {
    const h = await makeHarness({ handlers: reviseThenApproveHandlers })
    await h.br.run()
    const reviewJournals = [...h.runner.sessions.values()].filter(
      (j) => j.opts.skill === 'ab-code-review',
    )
    expect(reviewJournals.length).toBe(2)
    expect(reviewJournals.every((j) => j.turns.length === 1)).toBe(true)
    expect(reviewJournals[0]!.session.id).not.toBe(reviewJournals[1]!.session.id)
  })

  test('implement.started r2 carries the findings feedback (§15.3)', async () => {
    const h = await makeHarness({ handlers: reviseThenApproveHandlers })
    await h.br.run()
    const events = await h.store.getEvents(SLUG)
    const starts = ofType(events, 'implement.started')
    expect(starts.length).toBe(2)
    expect(starts[0]!.payload).toEqual({ round: 1 })
    expect(starts[1]!.payload).toEqual({ round: 2, feedback: { findings: ['f_1'] } })
  })

  test('plan.started after a parked plan-loop guidance answer CARRIES the answer (§15.6-B)', async () => {
    // Regression: a plan-loop escalation always parks the build, the runner
    // exits, and producerSessions is in-memory — so the post-answer re-attach
    // starts a FRESH plan session. plan.started used to be a bare {round}: the
    // decision's guidance feedback was silently dropped, then marked consumed
    // by the very start that failed to deliver it. The payload is the carrier
    // `ab context` materializes .ab/guidance.json from.
    const h = await makeHarness()
    // Dead-runner log: plan round 1 escalated; a human answered with guidance
    // while nothing was attached (§11: answerable from any UI).
    await h.store.append(SLUG, { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
    await h.store.append(SLUG, {
      actor: agentActor('plan', 's_seed'),
      type: 'plan.completed',
      payload: { round: 1, artifact: { kind: 'plan', rev: 0 } },
    })
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'plan-review.started',
      payload: { round: 1 },
    })
    await h.store.append(SLUG, {
      actor: agentActor('plan-review', 's_seed'),
      type: 'plan-review.verdict',
      payload: {
        round: 1,
        verdict: 'escalate',
        findings: [],
        artifact: { kind: 'plan-review', rev: 0 },
        reason: 'scope unclear',
      },
    })
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: 'esc_plan',
        phase: 'plan-review',
        round: 1,
        source: 'agent',
        question: 'scope unclear',
      },
    })
    await h.store.append(SLUG, {
      actor: humanActor('aron'),
      type: 'escalation.answered',
      payload: { id: 'esc_plan', answer: 'Only the API surface.', resolution: 'guidance' },
    })

    const guidance = { escalation: 'esc_plan', answer: 'Only the API surface.' }
    const decision = await h.br.step()
    expect(decision).toEqual({
      kind: 'run-phase',
      phase: 'plan',
      round: 2,
      feedback: { guidance },
    })

    const events = await h.store.getEvents(SLUG)
    const starts = ofType(events, 'plan.started')
    expect(starts.at(-1)!.payload).toEqual({ round: 2, feedback: { guidance } })

    // Fresh session (no live handle survives a park): started, never continued.
    const planJournals = [...h.runner.sessions.values()].filter(
      (j) => j.opts.skill === 'ab-plan',
    )
    expect(planJournals).toHaveLength(1)
    expect(planJournals[0]!.messages).toEqual([])
  })

  test('a continued turn re-issues ambient auth (D8): the new round in AB_PHASE, the new bracket in AB_SESSION', async () => {
    // Regression: the runner used to leave the continued turn on round 1's
    // start env, so the real CLI resolved round=1 and its terminal was
    // rejected as a D5 second call — §10 continuation was dead in production.
    const seen: Array<{ phase: string; session: string }> = []
    const h = await makeHarness({
      handlers: (store) => {
        const table = reviseThenApproveHandlers(store)
        const implement = table['implement']!
        table['implement'] = (ctx) => {
          seen.push({
            phase: ctx.opts.env['AB_PHASE'] ?? '',
            session: sessionOf(ctx),
          })
          return implement(ctx)
        }
        return table
      },
    })
    const state = await h.br.run()
    expect(state.status).toBe('running')

    const events = await h.store.getEvents(SLUG)
    const brackets = ofType(events, 'session.started')
      .filter((e) => e.payload.role === 'implement')
      .map((e) => e.payload.session)
    expect(seen).toEqual([
      { phase: 'implement@1', session: brackets[0]! },
      { phase: 'implement@2', session: brackets[1]! },
    ])
    // The refreshed AB_SESSION stamps the terminals: each round's completion
    // carries its OWN bracket's identity (§15.3), not round 1's.
    const completions = ofType(events, 'implement.completed').map((e) =>
      e.actor.kind === 'agent' ? e.actor.session : e.actor.kind,
    )
    expect(completions).toEqual(brackets)
  })

  test("`ab escalate` from a continued round stamps the refreshed AB_SESSION, so it IS the turn's terminal (§8.4)", async () => {
    // Regression: with the stale start env, the continued round's escalation
    // carried round 1's session id, executeSession's terminal check missed
    // it, and a legitimate escalation burned a phase.failed{no-terminal}.
    const h = await makeHarness({
      handlers: (store) => {
        const table = reviseThenApproveHandlers(store)
        const implement = table['implement']!
        table['implement'] = async (ctx) => {
          if (ctx.turn === 1) return implement(ctx)
          // The continued round escalates through the ambient identity (D8),
          // exactly as `ab escalate` would.
          await store.append(SLUG, {
            actor: agentActor('implement', sessionOf(ctx)),
            type: 'escalation.raised',
            payload: {
              id: 'esc_agent',
              phase: 'implement',
              round: roundOf(ctx),
              source: 'agent',
              question: 'finding f_1 contradicts the spec — which reading wins?',
            },
          })
          return defaultTurnResult('escalated')
        }
        return table
      },
    })
    const state = await h.br.run()
    expect(state.status).toBe('blocked') // parked on the escalation…
    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'phase.failed')).toEqual([]) // …never an infra failure
    const raised = ofType(events, 'escalation.raised')[0]!
    expect(raised.payload.round).toBe(2)
    const r2 = ofType(events, 'session.started').filter(
      (e) => e.payload.role === 'implement',
    )[1]!
    expect(raised.actor).toEqual({
      kind: 'agent',
      role: 'implement',
      session: r2.payload.session,
    })
  })

  test('each producer round gets its own session bracket, both closed with transcripts', async () => {
    const h = await makeHarness({ handlers: reviseThenApproveHandlers })
    await h.br.run()
    const events = await h.store.getEvents(SLUG)
    const implementSessions = ofType(events, 'session.started').filter(
      (e) => e.payload.role === 'implement',
    )
    expect(implementSessions.length).toBe(2)
    expect(implementSessions[0]!.payload.session).not.toBe(implementSessions[1]!.payload.session)
    expect(implementSessions.map((e) => e.payload.round)).toEqual([1, 2])
    const endedSessions = new Set(
      ofType(events, 'session.ended').map((e) => e.payload.session),
    )
    for (const started of implementSessions) {
      expect(endedSessions.has(started.payload.session)).toBe(true)
    }
  })

  test('after a phase.failed the producer session is dropped: next attempt is start, not continue (D5)', async () => {
    const h = await makeHarness({
      handlers: (store) => ({
        ...reviseThenApproveHandlers(store),
        implement: async (ctx) => {
          // The continued round goes silent (no terminal) exactly once.
          if (ctx.turn === 2) return defaultTurnResult('rambling…')
          const round = roundOf(ctx)
          await store.appendWithArtifacts(
            SLUG,
            [{ kind: 'implement-notes', content: `notes r${round}` }],
            (dep) => ({
              actor: agentActor('implement', sessionOf(ctx)),
              type: 'implement.completed',
              payload: {
                round,
                commits: { base: 'sha-base', head: `sha-head-${round}` },
                artifact: refOf(dep),
              },
            }),
          )
          return defaultTurnResult(`implemented r${round}`)
        },
      }),
    })
    const state = await h.br.run()
    expect(state.status).toBe('running') // recovered and finished the pipeline

    const implementJournals = [...h.runner.sessions.values()].filter(
      (j) => j.opts.skill === 'ab-implement',
    )
    expect(implementJournals.length).toBe(2)
    expect(implementJournals[0]!.turns.length).toBe(2) // r1 + failed continue
    expect(implementJournals[0]!.ended).toBe(true) // ended on failure, transcript kept
    expect(implementJournals[1]!.turns.length).toBe(1) // fresh start for the retry
    expect(implementJournals[1]!.messages.length).toBe(0)

    const events = await h.store.getEvents(SLUG)
    const failed = ofType(events, 'phase.failed')
    expect(failed.length).toBe(1)
    expect(failed[0]!.payload).toEqual({
      phase: 'implement',
      round: 2,
      attempt: 1,
      error: 'no-terminal',
      willRetry: true,
    })
  })
})

// ── No terminal (D5, §8.4) ───────────────────────────────────────────────────

describe('no-terminal retry policy (D5)', () => {
  test('a silent session fails the phase; the transcript and session.ended still land', async () => {
    const h = await makeHarness({
      handlers: () => ({ plan: () => defaultTurnResult('rambled and exited') }),
    })
    await h.br.attach()
    await h.br.step()

    const events = await h.store.getEvents(SLUG)
    expect(events.slice(-4).map((e) => e.type)).toEqual([
      'plan.started',
      'session.started',
      'session.ended',
      'phase.failed',
    ])
    const failed = ofType(events, 'phase.failed')[0]!
    expect(failed.payload).toEqual({
      phase: 'plan',
      round: 1,
      attempt: 1,
      error: 'no-terminal',
      willRetry: true,
    })
    const ended = ofType(events, 'session.ended')[0]!
    const transcript = await h.store.getArtifact(SLUG, 'transcript', ended.payload.transcript.rev)
    expect(transcript).not.toBeNull()
    expect(transcript!.meta.metadata['phase']).toBe('plan')
  })

  test('the second failure exhausts maxPhaseAttempts: policy escalation, no third session, run exits blocked', async () => {
    const h = await makeHarness({
      handlers: () => ({ plan: () => defaultTurnResult('rambled again') }),
    })
    const state = await h.br.run()
    expect(state.status).toBe('blocked')

    expect(await typesOf(h.store)).toEqual([
      'build.created',
      'workspace.provisioned',
      'spec.imported',
      'runner.attached',
      'plan.started',
      'session.started',
      'session.ended',
      'phase.failed',
      'plan.started',
      'session.started',
      'session.ended',
      'phase.failed',
      'escalation.raised',
    ])
    expect(h.runner.sessions.size).toBe(2) // never a third session

    const events = await h.store.getEvents(SLUG)
    const failed = ofType(events, 'phase.failed')
    expect(failed.map((e) => [e.payload.attempt, e.payload.willRetry])).toEqual([
      [1, true],
      [2, false],
    ])
    const escalation = ofType(events, 'escalation.raised')[0]!
    expect(escalation.actor).toEqual({ kind: 'kernel' })
    expect(escalation.payload.source).toBe('policy')
    expect(escalation.payload.phase).toBe('plan')
    expect(escalation.payload.round).toBe(1)
    expect(escalation.payload.question).toContain('maxPhaseAttempts')
    expect(escalation.payload.question).toContain('no-terminal')
  })

  test('an answered exhaustion escalation RE-ARMS the budget: the round runs again instead of re-raising (§15.6-B)', async () => {
    // Regression: the failure tally never reset, so after the human answered
    // the policy escalation the guard saw count >= maxPhaseAttempts, raised a
    // NEW escalation without starting a session, and every subsequent answer
    // ping-ponged forever — guidance could never unstick the phase.
    let attempts = 0
    const h = await makeHarness({
      handlers: (store) => ({
        ...happyHandlers(store),
        plan: async (ctx) => {
          attempts += 1
          if (attempts <= 4) return defaultTurnResult('rambled') // no terminal
          const round = roundOf(ctx)
          await store.appendWithArtifacts(
            SLUG,
            [{ kind: 'plan', content: `plan r${round}` }],
            (dep) => ({
              actor: agentActor('plan', sessionOf(ctx)),
              type: 'plan.completed',
              payload: { round, artifact: refOf(dep) },
            }),
          )
          return defaultTurnResult('planned')
        },
      }),
    })
    const answer = async (id: string, answer: string) =>
      h.store.append(SLUG, {
        actor: humanActor('aron'),
        type: 'escalation.answered',
        payload: { id, answer, resolution: 'guidance' },
      })

    // Attempts 1–2 fail → the policy raise parks the build (D5).
    expect((await h.br.run()).status).toBe('blocked')
    expect(ofType(await h.store.getEvents(SLUG), 'escalation.raised')).toHaveLength(1)

    // The answer re-arms the budget: attempts 3–4 RUN (real sessions, not an
    // instant re-raise) and their fresh failures escalate on new evidence.
    await answer('esc_1', 'plan the simpler variant first')
    expect((await h.br.run()).status).toBe('blocked')
    let events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'escalation.raised')).toHaveLength(2)
    expect(ofType(events, 'phase.failed')).toHaveLength(4)
    expect(attempts).toBe(4)

    // A second answer unblocks again; attempt 5 terminates and the pipeline
    // runs through to awaiting-pr — the recovery channel works repeatedly.
    await answer('esc_2', 'drop the migration step entirely')
    expect((await h.br.run()).status).toBe('running')
    events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'escalation.raised')).toHaveLength(2) // no extra raise
    expect(ofType(events, 'plan.completed')).toHaveLength(1)
    expect(ofType(events, 'plan.started')).toHaveLength(5) // every attempt really ran
  })
})

// ── Crash-gap repair (§8.5) ──────────────────────────────────────────────────

describe('crash-gap repair', () => {
  test("an escalate verdict without its escalation.raised is repaired by the kernel; run exits blocked", async () => {
    const h = await makeHarness({
      handlers: (store) => ({
        ...happyHandlers(store),
        'code-review': async (ctx) => {
          // Simulates the CLI dying between the verdict and its escalation.
          await reviewVerdict(store, ctx, 'code-review', 'escalate', [], 'auth approach conflicts with the spec')
          return defaultTurnResult('escalated')
        },
      }),
    })
    const state = await h.br.run()
    expect(state.status).toBe('blocked')

    const events = await h.store.getEvents(SLUG)
    expect(events.slice(-5).map((e) => e.type)).toEqual([
      'code-review.started',
      'session.started',
      'code-review.verdict',
      'escalation.raised',
      'session.ended',
    ])
    const escalation = ofType(events, 'escalation.raised')[0]!
    expect(escalation.actor).toEqual({ kind: 'kernel' })
    expect(escalation.payload.source).toBe('agent')
    expect(escalation.payload.phase).toBe('code-review')
    expect(escalation.payload.round).toBe(1)
    expect(escalation.payload.question).toBe('auth approach conflicts with the spec')
  })

  test('no duplicate raise when the CLI already appended the escalation', async () => {
    const h = await makeHarness({
      handlers: (store) => ({
        ...happyHandlers(store),
        'code-review': async (ctx) => {
          await reviewVerdict(store, ctx, 'code-review', 'escalate', [], 'which auth approach?')
          await store.append(SLUG, {
            actor: agentActor('code-review', sessionOf(ctx)),
            type: 'escalation.raised',
            payload: {
              id: 'esc_agent',
              phase: 'code-review',
              round: roundOf(ctx),
              source: 'agent',
              question: 'which auth approach?',
            },
          })
          return defaultTurnResult('escalated')
        },
      }),
    })
    const state = await h.br.run()
    expect(state.status).toBe('blocked')
    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'escalation.raised').length).toBe(1)
    expect(ofType(events, 'escalation.raised')[0]!.payload.id).toBe('esc_agent')
  })
})

// ── Deterministic checks (§8.2) ──────────────────────────────────────────────

describe('checks', () => {
  test('a failing check deposits the exec output as the verify report (D6) and completes pass:false', async () => {
    const h = await makeHarness({ failCommands: ['bun tsc --noEmit'] })
    await seedPlanApproved(h.store)
    await seedCodeApproved(h.store)

    const decision = await h.br.step()
    expect(decision).toEqual({
      kind: 'run-check',
      step: 'types',
      command: 'bun tsc --noEmit',
      attempt: 1,
    })

    const events = await h.store.getEvents(SLUG)
    expect(events.slice(-2).map((e) => e.type)).toEqual(['verify.started', 'verify.completed'])
    const completed = ofType(events, 'verify.completed')[0]!
    expect(completed.actor).toEqual({ kind: 'kernel' })
    expect(completed.payload).toEqual({
      step: 'types',
      attempt: 1,
      pass: false,
      report: { kind: 'verify-report:types', rev: 0 },
    })

    const report = await h.store.getArtifact(SLUG, 'verify-report:types', 0)
    expect(report).not.toBeNull()
    const content = new TextDecoder().decode(report!.content)
    expect(content).toContain('error TS2304')
    expect(content).toContain('typecheck failed')
    expect(report!.meta.metadata).toEqual({
      step: 'types',
      attempt: 1,
      command: 'bun tsc --noEmit',
      exitCode: 1,
    })
  })

  test('the engine routes implement r2 with the verify feedback; the started event carries it (§15.6-A)', async () => {
    const h = await makeHarness({ failCommands: ['bun tsc --noEmit'] })
    await seedPlanApproved(h.store)
    await seedCodeApproved(h.store)
    await h.br.step() // run-check types → fail

    const decision = await h.br.step()
    expect(decision).toEqual({
      kind: 'run-phase',
      phase: 'implement',
      round: 2,
      feedback: { verify: { step: 'types', report: { kind: 'verify-report:types', rev: 0 } } },
    })
    const events = await h.store.getEvents(SLUG)
    const started = ofType(events, 'implement.started').at(-1)!
    expect(started.payload).toEqual({
      round: 2,
      feedback: { verify: { step: 'types', report: { kind: 'verify-report:types', rev: 0 } } },
    })
  })
})

// ── needsServer (§16.2, D10) ─────────────────────────────────────────────────

describe('needsServer (D10)', () => {
  test('ensureStarted runs before the e2e session; stop runs at phase end', async () => {
    const h = await makeHarness()
    await h.br.run()
    const i = h.ops.indexOf('server:ensureStarted')
    expect(i).toBeGreaterThan(-1)
    expect(h.ops[i + 1]).toBe('session:ab-verify-e2e')
    expect(h.ops[i + 2]).toBe('server:stop')
  })

  test('stop is still called when the session throws; the failure is a phase.failed', async () => {
    const h = await makeHarness({
      handlers: (store) => ({
        ...happyHandlers(store),
        'verify-e2e': () => {
          throw new Error('browser crashed')
        },
      }),
    })
    await seedPlanApproved(h.store)
    await seedCodeApproved(h.store)
    await h.br.step() // types pass
    await h.br.step() // unit pass
    const decision = await h.br.step()
    expect(decision.kind).toBe('run-agent-verify')

    expect(h.ops).toEqual(['server:ensureStarted', 'session:ab-verify-e2e', 'server:stop'])
    const events = await h.store.getEvents(SLUG)
    // The thrown start never returned a handle, so no session.ended arrives —
    // the dead session stays open (§15.6-C) and the failure is recorded.
    expect(events.slice(-3).map((e) => e.type)).toEqual([
      'verify.started',
      'session.started',
      'phase.failed',
    ])
    const failed = ofType(events, 'phase.failed')[0]!
    expect(failed.payload).toEqual({
      phase: 'verify:e2e',
      round: 1,
      attempt: 1,
      error: 'browser crashed',
      willRetry: true,
    })
  })

  test('needsServer without a server dep fails the phase with a clear error, no session', async () => {
    const h = await makeHarness({ noServer: true })
    await seedPlanApproved(h.store)
    await seedCodeApproved(h.store)
    await h.br.step() // types
    await h.br.step() // unit
    const decision = await h.br.step()
    expect(decision.kind).toBe('run-agent-verify')

    expect(h.runner.sessions.size).toBe(0)
    const events = await h.store.getEvents(SLUG)
    expect(events.slice(-5).map((e) => e.type)).toEqual([
      'verify.started',
      'verify.completed',
      'verify.started',
      'verify.completed',
      'phase.failed',
    ])
    const failed = ofType(events, 'phase.failed')[0]!
    expect(failed.payload.phase).toBe('verify:e2e')
    expect(failed.payload.error).toContain('needsServer')
  })
})

// ── Operator commands (D2, §15.2.7) ──────────────────────────────────────────

describe('operator commands (D2)', () => {
  test('pause-requested mid-loop is acknowledged and run() exits paused', async () => {
    const h = await makeHarness({
      handlers: (store) => ({
        ...happyHandlers(store),
        plan: async (ctx) => {
          // The operator pauses while the plan session is running.
          await store.append(SLUG, {
            actor: humanActor('aron'),
            type: 'build.pause-requested',
            payload: {},
          })
          const round = roundOf(ctx)
          await store.appendWithArtifacts(
            SLUG,
            [{ kind: 'plan', content: `plan r${round}` }],
            (dep) => ({
              actor: agentActor('plan', sessionOf(ctx)),
              type: 'plan.completed',
              payload: { round, artifact: refOf(dep) },
            }),
          )
          return defaultTurnResult('planned')
        },
      }),
    })
    const state = await h.br.run()
    expect(state.status).toBe('paused')
    const types = await typesOf(h.store)
    expect(types.at(-1)).toBe('build.paused')
    expect(types).not.toContain('plan-review.started') // parked before the next phase
    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'build.paused')[0]!.actor).toEqual({ kind: 'kernel' })
  })

  test('resume-requested while paused is acknowledged and the pipeline continues', async () => {
    const h = await makeHarness()
    await h.store.append(SLUG, {
      actor: humanActor('aron'),
      type: 'build.pause-requested',
      payload: {},
    })
    await h.store.append(SLUG, { actor: KERNEL, type: 'build.paused', payload: {} })
    await h.store.append(SLUG, {
      actor: humanActor('aron'),
      type: 'build.resume-requested',
      payload: {},
    })
    const state = await h.br.run()
    expect(state.status).toBe('running') // resumed and ran to awaiting-pr
    const types = await typesOf(h.store)
    expect(types).toContain('build.resumed')
    expect(types.at(-1)).toBe('finalize.step-completed')
  })

  test('abort-requested is acknowledged and run() exits aborted', async () => {
    const h = await makeHarness()
    await h.store.append(SLUG, {
      actor: humanActor('aron'),
      type: 'build.abort-requested',
      payload: { reason: 'wrong ticket' },
    })
    const state = await h.br.run()
    expect(state.status).toBe('aborted')
    expect((await typesOf(h.store)).slice(-2)).toEqual(['runner.attached', 'build.aborted'])
    expect(h.runner.sessions.size).toBe(0) // no phase ever ran
  })
})

// ── Resume (§15.6-C) ─────────────────────────────────────────────────────────

describe('resume after sandbox death (§15.6-C)', () => {
  test('a log ending at implement.started r2 re-runs implement r2 from its start, fresh session', async () => {
    const h = await makeHarness({ handlers: reviseThenApproveHandlers })
    // The dead sandbox's log: code loop round 1 revised, round 2 started but
    // never terminated — uncommitted round-2 work is lost by design (§7.3).
    await seedPlanApproved(h.store)
    await h.store.append(SLUG, { actor: KERNEL, type: 'implement.started', payload: { round: 1 } })
    await h.store.append(SLUG, {
      actor: agentActor('implement', 's_dead'),
      type: 'implement.completed',
      payload: {
        round: 1,
        commits: { base: 'sha-base', head: 'sha-head-1' },
        artifact: { kind: 'implement-notes', rev: 0 },
      },
    })
    await h.store.append(SLUG, { actor: KERNEL, type: 'code-review.started', payload: { round: 1 } })
    await h.store.append(SLUG, {
      actor: agentActor('code-review', 's_dead'),
      type: 'code-review.verdict',
      payload: { round: 1, verdict: 'revise', findings: [FINDING], artifact: { kind: 'code-review', rev: 0 } },
    })
    const seeded = (await h.store.getEvents(SLUG)).length
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'implement.started',
      payload: { round: 2, feedback: { findings: ['f_1'] } },
    })

    await h.br.attach()
    const events = await h.store.getEvents(SLUG)
    const attached = ofType(events, 'runner.attached')[0]!
    expect(attached.payload.resumedFromSeq).toBe(seeded + 1)

    const decision = await h.br.step()
    expect(decision).toEqual({
      kind: 'run-phase',
      phase: 'implement',
      round: 2,
      feedback: { findings: ['f_1'] },
    })

    // Re-run from the phase's start: a fresh implement.started r2 + a fresh
    // session (the dead sandbox's producer memory is gone — §7.4, §9).
    const after = await h.store.getEvents(SLUG)
    expect(after.slice(-4).map((e) => e.type)).toEqual([
      'implement.started',
      'session.started',
      'implement.completed',
      'session.ended',
    ])
    const journal = [...h.runner.sessions.values()].find((j) => j.opts.skill === 'ab-implement')!
    expect(journal.turns.length).toBe(1)
    expect(journal.messages.length).toBe(0) // start, not continue
    expect(journal.opts.env['AB_PHASE']).toBe('implement@2')
    const completed = ofType(after, 'implement.completed').at(-1)!
    expect(completed.payload.round).toBe(2)
  })
})
