import { StoreWriteTooLargeError } from '../store/remote/errors'
import { readVerifyPipeline } from '../config/pipeline-source'
import { spawnExec } from '../ports/workspace/git-worktree'
import { RUNTIME_IDENTITY } from '../runtime-identity'
import { newerFact, seedNewerMemoryFact } from '../testing/newer-writer'
import { readBuildFacts } from '../store/reduced-reads'
import { done } from '../cli/terminals'
import { summaryBoundary, settleSummaryRequests } from '../cli/pr-summary-publication'
/**
 * Build-runner process tests (SPEC §3.3, §8, §9, §10, §15.6, D5): memory
 * store + ScriptedAgentRunner + FakeWorkspaceProvider + fake exec. The scripts
 * SIMULATE what the `ab` CLI would do — they append events and deposit
 * artifacts through the store directly, using the ambient
 * session id the runner injected (AB_SESSION, D8), exactly as `ab done` /
 * `ab verdict` would. Event sequences are asserted as type lists; payloads
 * are spot-checked where the rule lives (feedback, attempts, transcript
 * metadata, actor kinds).
 */
import { afterEach, describe, expect, test, spyOn } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildContext } from '../cli/context'
import { parseAbPhase } from '../cli/env'
import { parseConfig } from '../config/load'
import type { Config } from '../config/schema'
import type { AbEvent, EventEnvelope, EventWrite } from '../events/catalog'
import { DISPATCHER, KERNEL, agentActor, humanActor } from '../events/envelope'
import { normalizeVerifyCompletion, type EventType } from '../events/payloads'
import { sequentialIds } from '../ids'
import { leafTransaction } from '../kernel/generators/leaf-restack-log'
import { reduceBuild } from '../kernel/reducer'
import type { Finding } from '../ontology'
import { FakeForge } from '../ports/forge/fake'
import {
  ScriptedAgentRunner,
  defaultTurnResult,
  failedTurnResult,
  type Script,
  type ScriptContext,
} from '../ports/runner/fake'
import type { AgentRunner, AgentSessionHandle, AgentTurnResult } from '../ports/types'
import { FakeWorkspaceProvider } from '../ports/workspace/fake'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import type { Exec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import type { ArtifactMeta, BuildStore, Clock } from '../store/types'
import { manualClock, steppingClock } from '../testing/fixed'
import {
  BuildRunner,
  LeaseHeldError,
  SetupFailureError,
  parseNulChangedPaths,
  selectPublishedBranchHead,
  selectVerifyDiffBase,
  type BuildRunnerOpts,
} from './build-runner'

const SLUG = 'auth-rate-limit'
const BRANCH = 'ab/auth-rate-limit'
const TICKET = { source: 'linear', id: 'ENG-42', title: 'Auth rate limiting' }
const KIMI_QUOTA =
  '403 {"error":{"type":"permission_error","message":"You\'ve reached your usage limit for this billing cycle. Please try again after your quota refreshes."}}'

// Mirrors §16.1: two check steps (types, unit) + one agent step (e2e), one
// finalize post-step, one routed role with a model.
const CONFIG_TOML = `
[tickets]
source = "file"
readyState = "ready"

[commands]
typecheck = "bun tsc --noEmit"
test = "bun test"

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

[finalize]
steps = ["release-notes"]

[finalize.release-notes]
kind = "agent"
skill = "ab-release-notes"

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
  const phase = ctx.opts.env.AB_PHASE?.split('@')[0]
  if (phase === 'finalize')
    expect(ctx.opts.env.AB_CONTEXT_DIR).toMatch(/^\.ab\/finalize(?:-[A-Za-z0-9._-]+)?$/)
  else if (phase) expect(ctx.opts.env.AB_CONTEXT_DIR).toBe(`.ab/${phase.replace(':', '-')}`)
  return ctx.opts.env.AB_SESSION ?? ctx.session.id
}

/** Round from ambient AB_PHASE, resolved VERBATIM (D8) — the runner
 * re-issues the env per continued turn (§10); rebuilding the round from
 * ctx.turn here would mask a stale-env adapter. */
function roundOf(ctx: ScriptContext): number {
  const raw = ctx.opts.env.AB_PHASE ?? ''
  const at = raw.lastIndexOf('@')
  return at === -1 ? 1 : Number(raw.slice(at + 1)) || 1
}

async function guidanceMaterializedFor(
  store: BuildStore,
  ctx: ScriptContext,
): Promise<{ escalation: string; answer: string }> {
  const rawPhase = ctx.opts.env.AB_PHASE ?? ''
  const { phase, round } = parseAbPhase(rawPhase)
  await mkdir(ctx.opts.workspacePath, { recursive: true })
  await writeFile(join(ctx.opts.workspacePath, 'autobuild.toml'), CONFIG_TOML)
  await buildContext({
    store,
    workspacePath: ctx.opts.workspacePath,
    env: {
      store: ctx.opts.env.AB_STORE ?? 'local',
      build: SLUG,
      phase,
      round,
      session: sessionOf(ctx),
    },
  })
  return JSON.parse(
    await readFile(
      join(ctx.opts.workspacePath, ctx.opts.env.AB_CONTEXT_DIR!, 'guidance.json'),
      'utf8',
    ),
  ) as { escalation: string; answer: string }
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
    if (verdict === 'approve') await startHistoricalVerifyCycle(store)
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
        payload: { step: 'e2e', attempt: roundOf(ctx), outcome: 'pass' },
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

// ── Harness ──────────────────────────────────────────────────────────────────

type ReconcileRefresh = { sha: string } | { fetchError: string } | { resolveError: string }

type VerifyDiffResult = { paths: string[] } | { stdout: string } | { error: string }

type FinalizeGitResult<T> = T | { error: string }

class OneShotPostAppendFaultStore extends MemoryBuildStore {
  private faultType: EventType | undefined

  faultAfterNext(type: EventType): void {
    this.faultType = type
  }

  override async append<T extends EventType>(
    slug: string,
    event: EventWrite<T>,
  ): Promise<EventEnvelope<T>> {
    const envelope = await super.append(slug, event)
    if (this.faultType === event.type) {
      this.faultType = undefined
      throw new Error(`injected crash after ${event.type}@${envelope.seq}`)
    }
    return envelope
  }
}

interface HarnessOptions {
  readVerifyPipeline?: import('./verify-cycle-config').VerifyPipelineReader
  checkExec?: Exec
  store?: OneShotPostAppendFaultStore
  instance?: string
  runtimeIdentity?: typeof RUNTIME_IDENTITY
  beforeExec?: (cmd: string[], store: BuildStore) => Promise<void>
  nativeSessions?: boolean
  handlers?: (store: BuildStore) => Record<string, SkillHandler>
  /** Shell commands (the `sh -c` argument) that exit 1 with output. */
  failCommands?: string[]
  /** Shell commands whose Exec call throws before returning a result. */
  throwCommands?: string[]
  /** Exact successive setup outcomes; the final value repeats. */
  setupResults?: Array<{ stdout: string; stderr: string; exitCode: number } | { error: string }>
  /** Results for successive reconcile-time remote-base refreshes. The final
   * entry repeats when more refreshes occur. */
  reconcileRefreshes?: ReconcileRefresh[]
  /** Results for successive conditional-verify Git diffs. The final entry
   * repeats; omitted defaults to an empty changed-path set. */
  verifyDiffs?: VerifyDiffResult[]
  /** Porcelain output before/after finalize turns; empty means clean. */
  finalizeStatuses?: Array<FinalizeGitResult<string>>
  /** Exact `git diff` (working tree) / `git diff --cached` (staged) results for
   * the finalize preflight's dirty-worktree record; defaults to empty output.
   * Distinct from `verifyDiffs`, which serves conditional-verify diffs. */
  finalizeDiffs?: { working?: FinalizeGitResult<string>; staged?: FinalizeGitResult<string> }
  /** `git rev-parse HEAD` results after successful finalize turns. */
  finalizeHeads?: Array<FinalizeGitResult<string>>
  /** Successive ancestry checks for changed finalize heads. */
  finalizeAncestors?: Array<FinalizeGitResult<boolean>>
  /** Commits and first-parent topology exposed to the finalize scratch guard. */
  finalizeCommits?: string[]
  finalizeCommitParents?: Record<string, string[]>
  forge?: FakeForge
  delegateCredential?: typeof import('../store/remote/credentials').delegateCredential
  sessionEnv?: Record<string, string>
  /** Optional nonconforming/runtime-specific seam; scripted journals remain on Harness.runner. */
  runtimeRunner?: AgentRunner
  /** Extra registration fields applied to every harness runtime entry — the
   * session-stream capability seam (SPEC §9). */
  registrationExtras?: { openSessionStream?: RuntimeRegistry[string]['openSessionStream'] }
  runnerOpts?: BuildRunnerOpts
  clock?: Clock
  /** Seed build.created + workspace.provisioned + spec@0 + spec.imported
   * (§15.6 prelude). Default true. */
  seedPrelude?: boolean
  /** Provider recorded on the seeded provisioned fact; defaults to the
   * harness fake. */
  shutdownSignal?: AbortSignal
  workspaceProvider?: string
  /** Remote publication marker recorded on the seeded provisioned fact;
   * defaults to absent (legacy journal, local under the fallback). */
  workspaceRemote?: boolean
  /** Replaces the module config (parseConfig of this TOML) — e.g. to add a
   * [commands].setup for the §16.1 attach tests. */
  configToml?: string
  /** Mutable dispatcher snapshot used by hot-reload boundary tests. */
  getConfig?: () => Config
}

const harnessRoots: string[] = []
afterEach(async () => {
  await Promise.all(
    harnessRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})
let nextHarnessWorkspace = 0

class ManualSessionBudgetScheduler {
  readonly delays: number[] = []
  private readonly entries: Array<{ active: boolean; expire: () => void }> = []

  readonly schedule: NonNullable<BuildRunnerOpts['scheduleSessionBudget']> = (expire, delayMs) => {
    const entry = { active: true, expire }
    this.delays.push(delayMs)
    this.entries.push(entry)
    return () => {
      entry.active = false
    }
  }

  get activeCount(): number {
    return this.entries.filter((entry) => entry.active).length
  }

  async expireNext(): Promise<void> {
    for (let spin = 0; spin < 100; spin += 1) {
      const entry = this.entries.find((candidate) => candidate.active)
      if (entry !== undefined) {
        entry.active = false
        entry.expire()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    throw new Error('no active phase-session budget timer appeared')
  }
}

interface Harness {
  store: OneShotPostAppendFaultStore
  runner: ScriptedAgentRunner
  br: BuildRunner
  forge: FakeForge
  ops: string[]
  execCalls: Array<{ cmd: string[]; cwd: string | undefined }>
  workspacePath: string
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = options.clock ?? steppingClock()
  const store = options.store ?? new OneShotPostAppendFaultStore({ clock })
  nextHarnessWorkspace += 1
  const workspaceRoot = join(tmpdir(), `ab-build-runner-${process.pid}-${nextHarnessWorkspace}`)
  // Logical providers allocate lazily when a scripted phase writes its context.
  harnessRoots.push(workspaceRoot)
  const workspaces = new FakeWorkspaceProvider({
    mode: 'logical',
    base: { source: 'remote', sha: '0'.repeat(40) },
    root: workspaceRoot,
  })
  const handle = await workspaces.provision({
    repo: 'acme/app',
    baseBranch: 'main',
    branch: BRANCH,
  })
  if (!options.store)
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
      payload: {
        provider: options.workspaceProvider ?? handle.provider,
        ref: handle.ref,
        ...(options.workspaceRemote !== undefined ? { remote: options.workspaceRemote } : {}),
        branch: handle.branch,
        base: handle.base,
      },
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
  const runner = new ScriptedAgentRunner({
    script,
    nativeState: options.nativeSessions ? new Map() : undefined,
  })

  const failing = new Set(options.failCommands ?? [])
  const throwing = new Set(options.throwCommands ?? [])
  const setupResults = options.setupResults
  let setupResultIndex = 0
  const refreshes = options.reconcileRefreshes ?? [{ sha: 'a'.repeat(40) }]
  let refreshIndex = -1
  const currentRefresh = (): ReconcileRefresh =>
    refreshes[Math.min(Math.max(refreshIndex, 0), refreshes.length - 1)] ?? {
      fetchError: 'no reconcile refresh result configured',
    }
  const verifyDiffs = options.verifyDiffs ?? [{ paths: [] }]
  let verifyDiffIndex = 0
  const finalizeStatuses = options.finalizeStatuses ?? ['']
  const finalizeHeads = options.finalizeHeads ?? ['sha-head-1']
  const finalizeAncestors = options.finalizeAncestors ?? [true]
  let finalizeStatusIndex = 0
  let finalizeHeadIndex = 0
  let finalizeAncestorIndex = 0
  let replayPrepared = false
  const execCalls: Array<{ cmd: string[]; cwd: string | undefined }> = []
  const exec: Exec = async (cmd, opts) => {
    if (cmd[0] === 'sh' && options.checkExec) return options.checkExec(cmd, opts)
    execCalls.push({ cmd, cwd: opts.cwd })
    await options.beforeExec?.(cmd, store)
    if (cmd[0] === 'git' && cmd[1] === 'commit-tree') {
      replayPrepared = true
      return { stdout: 'c'.repeat(40), stderr: '', exitCode: 0 }
    }
    if (cmd[0] === 'git' && cmd[1] === 'show' && cmd.includes('--format=%P')) {
      const refresh = currentRefresh()
      return { stdout: 'sha' in refresh ? refresh.sha : '', stderr: '', exitCode: 0 }
    }
    if (cmd[0] === 'git' && cmd[1] === 'show' && cmd.includes('--format=%B'))
      return { stdout: `Change\n\nAutobuild-Build: ${SLUG}\n`, stderr: '', exitCode: 0 }
    if (cmd.includes('CHERRY_PICK_HEAD')) return { stdout: '', stderr: '', exitCode: 1 }

    // Finalize preflight diff capture: exact bare commands only, dispatched
    // BEFORE the generic `git diff` branch below so they never consume
    // verifyDiffs entries.
    if (
      (cmd.length === 2 && cmd[0] === 'git' && cmd[1] === 'diff') ||
      (cmd.length === 3 && cmd[0] === 'git' && cmd[1] === 'diff' && cmd[2] === '--cached')
    ) {
      const configured = options.finalizeDiffs
      const result = (cmd.length === 2 ? configured?.working : configured?.staged) ?? {
        stdout: '',
        stderr: '',
        exitCode: 0,
      }
      if (typeof result === 'string') return { stdout: result, stderr: '', exitCode: 0 }
      if ('error' in result) return { stdout: '', stderr: result.error, exitCode: 128 }
      return result
    }
    if (cmd[0] === 'git' && cmd[1] === 'diff') {
      const diff = verifyDiffs[Math.min(verifyDiffIndex, verifyDiffs.length - 1)] ?? {
        error: 'no conditional verify diff configured',
      }
      verifyDiffIndex += 1
      if ('error' in diff) {
        return { stdout: '', stderr: diff.error, exitCode: 128 }
      }
      if ('stdout' in diff) {
        return { stdout: diff.stdout, stderr: '', exitCode: 0 }
      }
      return {
        stdout: diff.paths.length === 0 ? '' : `${diff.paths.join('\0')}\0`,
        stderr: '',
        exitCode: 0,
      }
    }
    if (cmd[0] === 'git' && cmd[1] === 'rev-list' && cmd[2] === '--reverse') {
      return {
        stdout: options.finalizeCommits?.map((commit) => `${commit}\n`).join('') ?? '',
        stderr: '',
        exitCode: 0,
      }
    }
    if (cmd[0] === 'git' && cmd[1] === 'rev-list' && cmd[2] === '--parents') {
      const commit = cmd.at(-1)!
      const parents = options.finalizeCommitParents?.[commit] ?? ['sha-head-1']
      return { stdout: `${[commit, ...parents].join(' ')}\n`, stderr: '', exitCode: 0 }
    }
    if (cmd[0] === 'git' && cmd[1] === 'status') {
      const status = finalizeStatuses[
        Math.min(finalizeStatusIndex, finalizeStatuses.length - 1)
      ] ?? {
        error: 'no finalize status result configured',
      }
      finalizeStatusIndex += 1
      return typeof status === 'string'
        ? { stdout: status, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: status.error, exitCode: 128 }
    }
    if (replayPrepared && cmd[0] === 'git' && cmd[1] === 'rev-parse' && cmd[2] === 'HEAD')
      return { stdout: 'b'.repeat(40), stderr: '', exitCode: 0 }
    if (cmd[0] === 'git' && cmd[1] === 'rev-parse' && cmd[2] === 'HEAD') {
      const head = finalizeHeads[Math.min(finalizeHeadIndex, finalizeHeads.length - 1)] ?? {
        error: 'no finalize head result configured',
      }
      finalizeHeadIndex += 1
      return typeof head === 'string'
        ? { stdout: `${head}\n`, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: head.error, exitCode: 128 }
    }
    if (cmd[0] === 'git' && cmd[1] === 'merge-base') {
      const ancestor = finalizeAncestors[
        Math.min(finalizeAncestorIndex, finalizeAncestors.length - 1)
      ] ?? { error: 'no finalize ancestry result configured' }
      finalizeAncestorIndex += 1
      if (typeof ancestor === 'boolean') {
        return { stdout: '', stderr: '', exitCode: ancestor ? 0 : 1 }
      }
      return { stdout: '', stderr: ancestor.error, exitCode: 128 }
    }
    if (cmd[0] === 'git' && cmd[1] === 'fetch') {
      refreshIndex += 1
      const refresh = currentRefresh()
      return 'fetchError' in refresh
        ? { stdout: '', stderr: refresh.fetchError, exitCode: 128 }
        : { stdout: '', stderr: '', exitCode: 0 }
    }
    if (cmd[0] === 'git' && cmd[1] === 'rev-parse') {
      const refresh = currentRefresh()
      if ('resolveError' in refresh) {
        return { stdout: '', stderr: refresh.resolveError, exitCode: 128 }
      }
      if ('fetchError' in refresh) {
        return { stdout: '', stderr: refresh.fetchError, exitCode: 128 }
      }
      return { stdout: `${refresh.sha}\n`, stderr: '', exitCode: 0 }
    }
    const shell = cmd[2] ?? ''
    if (shell === 'bun install' && setupResults !== undefined) {
      const result = setupResults[Math.min(setupResultIndex, setupResults.length - 1)]
      setupResultIndex += 1
      if (result === undefined) throw new Error('no setup result configured')
      if ('error' in result) throw new Error(result.error)
      return result
    }
    if (throwing.has(shell)) throw new Error(`exec unavailable for ${shell}`)
    return failing.has(shell)
      ? {
          stdout: 'src/auth.ts(3,7): error TS2304: Cannot find name',
          stderr: 'typecheck failed',
          exitCode: 1,
        }
      : { stdout: 'ok', stderr: '', exitCode: 0 }
  }

  const forge = options.forge ?? new FakeForge()
  // Explicit destination history for the scripted origin snapshots. These
  // commits belong to the test forge, never the runner's host checkout.
  const destinationHistory = ['0', 'a', 'b', 'c', '1', '2', '3', '4', '5', '6']
  destinationHistory.forEach((digit, index) => {
    forge.seedCommit(digit.repeat(40), index ? [destinationHistory[index - 1]!.repeat(40)] : [])
  })
  forge.remoteBranches.set(BRANCH, 'd'.repeat(40))
  await store.putArtifact(SLUG, { kind: 'pr-description', content: 'Build change' })
  const selectedConfig = options.configToml !== undefined ? parseConfig(options.configToml) : config
  selectedConfig.roles.default ??= { runtime: 'scripted' }
  const br = new BuildRunner({
    store: store.scopeBuild(SLUG),
    config: selectedConfig,
    readVerifyPipeline: options.readVerifyPipeline,
    ...(options.getConfig !== undefined ? { getConfig: options.getConfig } : {}),
    runtimes: {
      // `scripted` (the default runtime) serves the `m-` family so the routed
      // `plan = { runtime = "scripted", model = "m-plan" }` role resolves; the
      // pi/claude entries prove a second runtime is selectable.
      scripted: {
        runner: options.runtimeRunner ?? runner,
        servesModels: ['m-'],
        ...(options.registrationExtras ?? {}),
      },
      claude: {
        runner: options.runtimeRunner ?? runner,
        servesModels: ['claude-'],
        ...(options.registrationExtras ?? {}),
      },
      pi: {
        runner: options.runtimeRunner ?? runner,
        servesModels: ['kimi-'],
        ...(options.registrationExtras ?? {}),
      },
    },
    workspacePath: handle.path,
    workspaceProvider: options.workspaceProvider,
    workspaceRemote: options.workspaceRemote,
    shutdownSignal: options.shutdownSignal,
    branch: BRANCH,
    slug: SLUG,
    exec,
    forge,
    ids: sequentialIds(),
    clock,
    instance: options.instance ?? 'runner-1',
    runtimeIdentity: options.runtimeIdentity,
    host: 'sandbox-a',
    ...(options.delegateCredential ? { delegateCredential: options.delegateCredential } : {}),
    ...(options.sessionEnv !== undefined ? { sessionEnv: options.sessionEnv } : {}),
    ...(options.runnerOpts !== undefined ? { opts: options.runnerOpts } : {}),
  })
  return { store, runner, br, forge, ops, execCalls, workspacePath: handle.path }
}

// ── Seed helpers (dead-sandbox logs, engine-state shortcuts) ─────────────────

async function seedPlanApproved(store: BuildStore, verifySteps?: string[]): Promise<void> {
  await store.append(SLUG, { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
  await store.append(SLUG, {
    actor: agentActor('plan', 's_seed'),
    type: 'plan.completed',
    payload: {
      round: 1,
      artifact: { kind: 'plan', rev: 0 },
      ...(verifySteps !== undefined ? { verifySteps } : {}),
    },
  })
  await store.append(SLUG, { actor: KERNEL, type: 'plan-review.started', payload: { round: 1 } })
  await store.append(SLUG, {
    actor: agentActor('plan-review', 's_seed'),
    type: 'plan-review.verdict',
    payload: {
      round: 1,
      verdict: 'approve',
      findings: [],
      artifact: { kind: 'plan-review', rev: 0 },
    },
  })
}

/** These legacy pipeline fixtures resume an already-started verify cycle.
 * Fresh entry and automatic Git publication are exercised in leaf-restacking.test.ts. */
async function completeFixtureRestack(store: BuildStore): Promise<void> {
  const events = await store.getEvents(SLUG)
  const boundary = events.findLast((e) => e.type === 'reconcile.completed')!
  await store.append(SLUG, {
    actor: KERNEL,
    type: 'restack.completed',
    payload: {
      ...leafTransaction,
      branch: BRANCH,
      cycle: boundary.seq,
      targetBase: events.findLast((e) => e.type === 'reconcile.started')!.payload.baseSha,
      headSha: 'e'.repeat(40),
    },
  })
}

async function startHistoricalVerifyCycle(store: BuildStore): Promise<void> {
  const events = await store.getEvents(SLUG)
  const attempt =
    Math.max(
      0,
      ...events.flatMap((e) =>
        e.type === 'verify.started' || e.type === 'verify.completed' ? [e.payload.attempt] : [],
      ),
    ) + 1
  await store.append(SLUG, {
    actor: KERNEL,
    type: 'verify.started',
    payload: { step: 'types', attempt },
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
    payload: {
      round: 1,
      verdict: 'approve',
      findings: [],
      artifact: { kind: 'code-review', rev: 0 },
    },
  })
  await startHistoricalVerifyCycle(store)
}

async function seedReadyForFinalizeStep(store: BuildStore): Promise<void> {
  await seedPlanApproved(store)
  await seedCodeApproved(store)
  for (const step of ['types', 'unit', 'e2e']) {
    await store.append(SLUG, {
      actor: KERNEL,
      type: 'verify.completed',
      payload: { step, attempt: 1, pass: true },
    })
  }
  await store.append(SLUG, {
    actor: KERNEL,
    type: 'finalize.completed',
    payload: {
      pr: { number: 7, url: 'https://forge.test/pr/7', headSha: 'sha-head-1' },
    },
  })
}

async function seedFinalized(store: BuildStore): Promise<void> {
  await seedReadyForFinalizeStep(store)
  await store.append(SLUG, {
    actor: agentActor('release-notes', 's_seed'),
    type: 'finalize.step-completed',
    payload: { step: 'release-notes', ok: true },
  })
}

async function seedRepeatConflict(
  store: BuildStore,
  mergedBase: string,
  completedAttempts = 1,
): Promise<number> {
  await seedFinalized(store)
  for (let attempt = 1; attempt <= completedAttempts; attempt += 1) {
    await store.append(SLUG, {
      actor: DISPATCHER,
      type: 'pr.conflicted',
      payload: {
        baseSha: attempt === 1 ? 'stale-first-detection' : `stale-detection-${attempt}`,
      },
    })
    await store.append(SLUG, {
      actor: KERNEL,
      type: 'reconcile.started',
      payload: { attempt, baseSha: mergedBase },
    })
    await store.append(SLUG, {
      actor: agentActor('reconcile', 's_seed'),
      type: 'reconcile.completed',
      payload: {
        mergeCommit: `sha-merge-${attempt}`,
        artifact: { kind: 'reconcile-notes', rev: attempt - 1 },
      },
    })
    for (const step of ['types', 'unit', 'e2e']) {
      await store.append(SLUG, {
        actor: KERNEL,
        type: 'verify.completed',
        payload: { step, attempt: attempt + 1, pass: true },
      })
    }
  }
  const conflict = await store.append(SLUG, {
    actor: DISPATCHER,
    type: 'pr.conflicted',
    payload: { baseSha: 'stale-repeat-detection' },
  })
  return conflict.seq
}

async function typesOf(store: BuildStore): Promise<string[]> {
  return (await store.getEvents(SLUG)).map((event) => event.type)
}

function ofType<T extends EventType>(events: AbEvent[], type: T): Extract<AbEvent, { type: T }>[] {
  return events.filter((event): event is Extract<AbEvent, { type: T }> => event.type === type)
}

function completedSessionEnd(event: Extract<AbEvent, { type: 'session.ended' }>) {
  if (!('transcript' in event.payload)) throw new Error('expected transcript-bearing session end')
  return event.payload
}

// ── attach (§7.4) ────────────────────────────────────────────────────────────

describe('attach', () => {
  test('claims the lease, appends runner.attached (no resumedFromSeq on an empty log), and heartbeats', async () => {
    const clock = manualClock()
    const h = await makeHarness({ clock, seedPrelude: false })
    await h.br.attach()

    const events = await h.store.getEvents(SLUG)
    expect(events.map((e) => e.type)).toEqual(['runner.attached', 'runner.runtime-recorded'])
    const attached = ofType(events, 'runner.attached')[0]!
    expect(attached.actor).toEqual({ kind: 'kernel' })
    expect(attached.payload.instance).toBe('runner-1')
    expect(attached.payload.host).toBe('sandbox-a')
    expect(ofType(events, 'runner.runtime-recorded')[0]?.payload).toEqual({
      instance: attached.payload.instance,
      attachedSeq: attached.seq,
      runtime: RUNTIME_IDENTITY,
    })
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
    expect(ofType(events, 'runner.runtime-recorded')[0]?.payload).toEqual({
      instance: attached.payload.instance,
      attachedSeq: attached.seq,
      runtime: RUNTIME_IDENTITY,
    })
    expect(attached.seq).toBe(4)
    expect(attached.payload.resumedFromSeq).toBe(3)
  })

  test('reclaims every pre-boundary open session before attachment without a transcript', async () => {
    const h = await makeHarness()
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'session.started',
      payload: {
        session: 's_dead',
        role: 'code-review',
        runner: 'pi',
        phase: 'code-review',
        round: 2,
      },
    })
    const boundary = (await h.store.getEvents(SLUG)).at(-1)!.seq

    await h.br.attach()

    const events = await h.store.getEvents(SLUG)
    const reclaimed = ofType(events, 'session.ended')[0]!
    const attached = ofType(events, 'runner.attached')[0]!
    expect(reclaimed.seq).toBeLessThan(attached.seq)
    expect(reclaimed.payload).toEqual({
      session: 's_dead',
      outcome: 'reclaimed',
      reclaimedBy: { instance: 'runner-1', resumedFromSeq: boundary },
    })
    expect(reclaimed.payload).not.toHaveProperty('transcript')
    expect(reclaimed.payload).not.toHaveProperty('usage')
    expect(attached.payload.resumedFromSeq).toBe(boundary)
    expect(reduceBuild(events).sessions.open).toEqual([])
  })

  test('an interrupted multi-session reclaim merges no attachment and retry closes only the remainder', async () => {
    const h = await makeHarness()
    for (const session of ['s_dead_1', 's_dead_2']) {
      await h.store.append(SLUG, {
        actor: KERNEL,
        type: 'session.started',
        payload: {
          session,
          role: 'code-review',
          runner: 'pi',
          phase: 'code-review',
          round: 2,
        },
      })
    }
    h.store.faultAfterNext('session.ended')

    await expect(h.br.attach()).rejects.toThrow(/injected crash after session.ended/)
    let events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'runner.attached')).toHaveLength(0)
    expect(ofType(events, 'runner.runtime-recorded')).toHaveLength(0)
    expect(reduceBuild(events).sessions.open.map((session) => session.session)).toEqual([
      's_dead_2',
    ])

    await h.br.attach()
    events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'session.ended').map((event) => event.payload.session)).toEqual([
      's_dead_1',
      's_dead_2',
    ])
    expect(ofType(events, 'runner.attached')).toHaveLength(1)
    expect(reduceBuild(events).sessions.open).toEqual([])
  })

  test('three successive recoveries leave only the newest rerun session open', async () => {
    const h = await makeHarness()
    for (let recovery = 1; recovery <= 3; recovery += 1) {
      await h.store.append(SLUG, {
        actor: KERNEL,
        type: 'session.started',
        payload: {
          session: `s_run_${recovery}`,
          role: 'implement',
          runner: 'pi',
          phase: 'implement',
          round: 2,
        },
      })
      await h.br.attach()
    }
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'session.started',
      payload: {
        session: 's_run_4',
        role: 'implement',
        runner: 'pi',
        phase: 'implement',
        round: 2,
      },
    })

    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'session.ended').map((event) => event.payload.session)).toEqual([
      's_run_1',
      's_run_2',
      's_run_3',
    ])
    expect(reduceBuild(events).sessions.open.map((session) => session.session)).toEqual(['s_run_4'])
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
        const plan = table.plan!
        table.plan = async (ctx) => {
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
  const TOML_WITH_SETUP = CONFIG_TOML.replace('[commands]', '[commands]\nsetup = "bun install"')

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
    expect(h.execCalls.filter((c) => c.cmd[0] === 'sh').map((c) => c.cmd[2])).toEqual([
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

  test('a failing setup deposits exact durable evidence and starts no phase or session', async () => {
    const h = await makeHarness({
      configToml: TOML_WITH_SETUP,
      failCommands: ['bun install'],
    })
    await expect(h.br.run()).rejects.toBeInstanceOf(SetupFailureError)
    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'runner.setup-failed')[0]?.payload).toEqual({
      command: 'bun install',
      attempt: 1,
      exitStatus: 1,
      output: 'typecheck failed\nsrc/auth.ts(3,7): error TS2304: Cannot find name',
    })
    expect(events.slice(-3).map((event) => event.type)).toEqual([
      'runner.attached',
      'runner.runtime-recorded',
      'runner.setup-failed',
    ])
    expect(
      events.filter(
        (event) =>
          event.type === 'session.started' ||
          event.type === 'phase.failed' ||
          event.type === 'verify.completed',
      ),
    ).toEqual([])
    expect(h.runner.sessions.size).toBe(0)
  })

  test('a pre-existing pause bypasses broken setup and parks without workspace work', async () => {
    const h = await makeHarness({
      configToml: TOML_WITH_SETUP,
      failCommands: ['bun install'],
    })
    await h.store.append(SLUG, {
      actor: humanActor('aron'),
      type: 'build.pause-requested',
      payload: {},
    })

    const state = await h.br.run()
    const events = await h.store.getEvents(SLUG)
    expect(state.status).toBe('paused')
    expect(h.execCalls).toEqual([])
    expect(ofType(events, 'build.paused')).toHaveLength(1)
    expect(ofType(events, 'runner.attached')).toHaveLength(0)
    expect(ofType(events, 'runner.runtime-recorded')).toHaveLength(0)
    expect(ofType(events, 'runner.setup-failed')).toHaveLength(0)
    expect(events.some((event) => event.type.endsWith('.started'))).toBe(false)
    expect(h.runner.sessions.size).toBe(0)
  })

  test('a pre-existing abort bypasses broken setup and retains the execution lease', async () => {
    const h = await makeHarness({
      configToml: TOML_WITH_SETUP,
      failCommands: ['bun install'],
    })
    await h.store.append(SLUG, {
      actor: humanActor('aron'),
      type: 'build.abort-requested',
      payload: { reason: 'stop before setup' },
    })

    const state = await h.br.run()
    const events = await h.store.getEvents(SLUG)
    expect(state.status).toBe('aborted')
    expect(h.execCalls).toEqual([])
    expect(ofType(events, 'build.aborted')).toHaveLength(1)
    expect(ofType(events, 'runner.attached')).toHaveLength(0)
    expect(ofType(events, 'runner.runtime-recorded')).toHaveLength(0)
    expect(ofType(events, 'runner.setup-failed')).toHaveLength(0)
    expect(events.some((event) => event.type.endsWith('.started'))).toBe(false)
    expect(h.runner.sessions.size).toBe(0)
    expect((await h.store.getBuild(SLUG))?.lease?.holder).toBe('runner-1')
  })

  test('bounds repeated setup failures, raises once, and parks further attaches', async () => {
    const h = await makeHarness({
      configToml: TOML_WITH_SETUP,
      failCommands: ['bun install'],
    })
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(h.br.attach()).rejects.toBeInstanceOf(SetupFailureError)
    }
    const beforePark = h.execCalls.length
    await expect(h.br.attach()).rejects.toBeInstanceOf(SetupFailureError)
    expect(h.execCalls).toHaveLength(beforePark)

    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'runner.setup-failed').map((event) => event.payload.attempt)).toEqual([
      1, 2, 3,
    ])
    expect(ofType(events, 'runner.attached')).toHaveLength(1)
    expect(ofType(events, 'escalation.raised')).toHaveLength(1)
    expect(ofType(events, 'escalation.raised')[0]?.payload).toMatchObject({
      phase: 'setup',
      source: 'policy',
      policyCause: 'setup-failure-limit',
    })
    expect(ofType(events, 'escalation.raised')[0]?.payload.question).toContain('bun install')
    expect(ofType(events, 'escalation.raised')[0]?.payload.question).toContain('typecheck failed')
  })

  test('an abort bypasses an open setup exhaustion without consuming another attempt', async () => {
    const h = await makeHarness({
      configToml: TOML_WITH_SETUP,
      failCommands: ['bun install'],
    })
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(h.br.attach()).rejects.toBeInstanceOf(SetupFailureError)
    }
    const before = await h.store.getEvents(SLUG)
    expect(ofType(before, 'escalation.raised')).toHaveLength(1)
    await h.store.append(SLUG, {
      actor: humanActor('aron'),
      type: 'build.abort-requested',
      payload: { reason: 'environment remains broken' },
    })

    const state = await h.br.run()
    const events = await h.store.getEvents(SLUG)
    expect(state.status).toBe('aborted')
    expect(h.execCalls).toHaveLength(3)
    expect(ofType(events, 'runner.setup-failed')).toHaveLength(3)
    expect(ofType(events, 'runner.attached')).toHaveLength(1)
    expect(ofType(events, 'escalation.raised')).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('build.aborted')
    expect(h.runner.sessions.size).toBe(0)
    expect((await h.store.getBuild(SLUG))?.lease?.holder).toBe('runner-1')
  })

  test('repairs setup exhaustion despite a later answered policy raise for another target', async () => {
    const h = await makeHarness({ configToml: TOML_WITH_SETUP })
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await h.store.append(SLUG, {
        actor: KERNEL,
        type: 'runner.setup-failed',
        payload: {
          command: 'bun install',
          attempt,
          exitStatus: 1,
          output: `setup failure ${attempt}`,
        },
      })
    }
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: 'esc_other',
        phase: 'code-review',
        source: 'policy',
        policyCause: 'review-round-limit',
        question: 'review policy exhausted',
      },
    })
    await h.store.append(SLUG, {
      actor: humanActor('operator'),
      type: 'escalation.answered',
      payload: {
        id: 'esc_other',
        answer: 'continue review',
        resolution: 'guidance',
      },
    })

    await expect(h.br.attach()).rejects.toBeInstanceOf(SetupFailureError)
    expect(h.execCalls).toHaveLength(0)
    const setupRaises = ofType(await h.store.getEvents(SLUG), 'escalation.raised').filter(
      (event) => event.payload.phase === 'setup',
    )
    expect(setupRaises).toHaveLength(1)
    expect(setupRaises[0]?.payload.source).toBe('policy')
  })

  test('a transient failure recovers with one delayed attachment and no stale error', async () => {
    const h = await makeHarness({
      configToml: TOML_WITH_SETUP,
      setupResults: [
        { stdout: 'first stdout', stderr: 'first stderr', exitCode: 1 },
        { stdout: 'installed', stderr: '', exitCode: 0 },
      ],
    })
    await expect(h.br.attach()).rejects.toBeInstanceOf(SetupFailureError)
    await h.br.attach()

    const events = await h.store.getEvents(SLUG)
    expect(events.slice(-5).map((event) => event.type)).toEqual([
      'runner.attached',
      'runner.runtime-recorded',
      'runner.setup-failed',
      'runner.attached',
      'runner.runtime-recorded',
    ])
    const recovered = ofType(events, 'runner.attached').at(-1)
    expect(recovered?.payload.resumedFromSeq).toBe(ofType(events, 'runner.setup-failed')[0]?.seq)
    expect(reduceBuild(events).setupFailure).toBeUndefined()
    expect(ofType(events, 'escalation.raised')).toHaveLength(0)
  })

  test('setup recovery reclaims sessions before its delayed attachment', async () => {
    const h = await makeHarness({
      configToml: TOML_WITH_SETUP,
      setupResults: [{ stdout: 'installed', stderr: '', exitCode: 0 }],
    })
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'session.started',
      payload: {
        session: 's_before_setup_recovery',
        role: 'plan',
        runner: 'pi',
        phase: 'plan',
        round: 1,
      },
    })
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'runner.setup-failed',
      payload: { command: 'bun install', attempt: 1, exitStatus: 1, output: 'offline' },
    })
    const boundary = (await h.store.getEvents(SLUG)).at(-1)!.seq

    await h.br.attach()

    const events = await h.store.getEvents(SLUG)
    expect(events.slice(-3).map((event) => event.type)).toEqual([
      'session.ended',
      'runner.attached',
      'runner.runtime-recorded',
    ])
    expect(ofType(events, 'session.ended').at(-1)?.payload).toEqual({
      session: 's_before_setup_recovery',
      outcome: 'reclaimed',
      reclaimedBy: { instance: 'runner-1', resumedFromSeq: boundary },
    })
    expect(ofType(events, 'runner.attached').at(-1)?.payload.resumedFromSeq).toBe(boundary)
  })

  test('a human answer re-arms the exhausted setup budget', async () => {
    const h = await makeHarness({
      configToml: TOML_WITH_SETUP,
      failCommands: ['bun install'],
    })
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(h.br.attach()).rejects.toBeInstanceOf(SetupFailureError)
    }
    const escalation = ofType(await h.store.getEvents(SLUG), 'escalation.raised')[0]!
    await h.store.append(SLUG, {
      actor: humanActor('operator'),
      type: 'escalation.answered',
      payload: {
        id: escalation.payload.id,
        answer: 'environment repaired; retry',
        resolution: 'guidance',
      },
    })
    await expect(h.br.attach()).rejects.toBeInstanceOf(SetupFailureError)
    expect(
      ofType(await h.store.getEvents(SLUG), 'runner.setup-failed').at(-1)?.payload.attempt,
    ).toBe(1)
  })

  test('an execution exception records an explicit unavailable status', async () => {
    const h = await makeHarness({
      configToml: TOML_WITH_SETUP,
      throwCommands: ['bun install'],
    })
    await expect(h.br.attach()).rejects.toBeInstanceOf(SetupFailureError)
    expect(ofType(await h.store.getEvents(SLUG), 'runner.setup-failed')[0]?.payload).toMatchObject({
      exitStatus: null,
      output: 'exec unavailable for bun install',
    })
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

  const DETECTED_BASE = '1'.repeat(40)
  const CURRENT_BASE = '2'.repeat(40)

  test('reconcile refreshes an advanced base before recording the phase start (§15.7)', async () => {
    const h = await makeHarness({ reconcileRefreshes: [{ sha: CURRENT_BASE }] })
    await seedFinalized(h.store)
    await h.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'pr.conflicted',
      payload: { baseSha: DETECTED_BASE },
    })

    const decision = await h.br.step()
    expect(decision).toEqual({
      kind: 'run-phase',
      phase: 'reconcile',
      round: 1,
      reconcile: { attempt: 1 },
    })

    const events = await h.store.getEvents(SLUG)
    expect(events.slice(-4).map((e) => e.type)).toEqual([
      'reconcile.replayed',
      'session.started',
      'reconcile.completed',
      'session.ended',
    ])
    expect(ofType(events, 'pr.conflicted')[0]!.payload.baseSha).toBe(DETECTED_BASE)
    expect(ofType(events, 'reconcile.started')[0]!.payload).toEqual({
      attempt: 1,
      baseSha: CURRENT_BASE,
    })
    expect(
      h.execCalls
        .filter(
          (call) =>
            call.cmd[1] === 'fetch' ||
            call.cmd.includes(`refs/autobuild/reconcile/${SLUG}/base^{commit}`),
        )
        .slice(-2),
    ).toEqual([
      {
        cmd: [
          'git',
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          '--refmap=',
          'origin',
          `+refs/heads/main:refs/autobuild/reconcile/${SLUG}/base`,
        ],
        cwd: h.workspacePath,
      },
      {
        cmd: ['git', 'rev-parse', '--verify', `refs/autobuild/reconcile/${SLUG}/base^{commit}`],
        cwd: h.workspacePath,
      },
    ])

    // AB_PHASE uses the attempt as the round for reconcile (D8).
    const journal = [...h.runner.sessions.values()].find((j) => j.opts.skill === 'ab-reconcile')
    expect(journal?.opts.env.AB_PHASE).toBe('reconcile@1')

    // Reconciliation changed code, so verify:* re-runs in full — cheap
    // checks first, at a FRESH attempt number (§15.6-A: the mainline cycle
    // already used attempt 1; reusing it would collide the reducer's
    // current-cycle projection and the D5 keys `verify:<step>` round=attempt).
    await completeFixtureRestack(h.store)
    expect(await h.br.step()).toMatchObject({ kind: 'capture-reconcile-policy' })
    expect(await h.br.step()).toEqual({
      kind: 'run-check',
      step: 'types',
      command: 'bun tsc --noEmit',
      attempt: 2,
    })
  })

  test('reconcile delegates authoritative base snapshots to a capable forge without fetching origin', async () => {
    class SnapshotForge extends FakeForge {
      readonly snapshots: Array<{
        workspacePath: string
        base: string
        destinationRef: string
      }> = []

      async snapshotBase(opts: {
        workspacePath: string
        base: string
        destinationRef: string
      }): Promise<string> {
        this.snapshots.push(opts)
        return CURRENT_BASE
      }
    }

    const forge = new SnapshotForge()
    const h = await makeHarness({ forge })
    await seedFinalized(h.store)
    await h.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'pr.conflicted',
      payload: { baseSha: DETECTED_BASE },
    })

    await h.br.step()

    expect(forge.snapshots).toEqual([
      {
        workspacePath: h.workspacePath,
        base: 'main',
        destinationRef: `refs/autobuild/reconcile/${SLUG}/base`,
      },
    ])
    expect(h.execCalls.some(({ cmd }) => cmd[0] === 'git' && cmd[1] === 'fetch')).toBe(false)
    expect(ofType(await h.store.getEvents(SLUG), 'reconcile.started')[0]!.payload).toEqual({
      attempt: 1,
      baseSha: CURRENT_BASE,
    })
  })

  test('reconcile preserves unchanged-base behavior when refresh resolves the detected SHA', async () => {
    const h = await makeHarness({ reconcileRefreshes: [{ sha: DETECTED_BASE }] })
    await seedFinalized(h.store)
    await h.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'pr.conflicted',
      payload: { baseSha: DETECTED_BASE },
    })

    await h.br.step()
    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'reconcile.started')[0]!.payload).toEqual({
      attempt: 1,
      baseSha: DETECTED_BASE,
    })
    expect(ofType(events, 'reconcile.completed')).toHaveLength(1)
  })

  test('a crashed same-attempt reconcile refreshes the base again before replacement session startup', async () => {
    const firstStartBase = '3'.repeat(40)
    const h = await makeHarness({ reconcileRefreshes: [{ sha: CURRENT_BASE }] })
    await seedFinalized(h.store)
    await h.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'pr.conflicted',
      payload: { baseSha: DETECTED_BASE },
    })
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'reconcile.started',
      payload: { attempt: 1, baseSha: firstStartBase },
    })

    expect(await h.br.step()).toEqual({
      kind: 'run-phase',
      phase: 'reconcile',
      round: 1,
      reconcile: { attempt: 1 },
    })
    expect(
      ofType(await h.store.getEvents(SLUG), 'reconcile.started').map(
        (event) => event.payload.baseSha,
      ),
    ).toEqual([firstStartBase, CURRENT_BASE])
  })

  test('repeat-conflict progress checks persist an origin-fetched base, then phase startup refreshes again', async () => {
    const PHASE_BASE = '3'.repeat(40)
    const h = await makeHarness({
      reconcileRefreshes: [{ sha: CURRENT_BASE }, { sha: PHASE_BASE }],
    })
    const conflictSeq = await seedRepeatConflict(h.store, DETECTED_BASE)

    expect(await h.br.step()).toEqual({
      kind: 'check-reconcile-progress',
      conflictSeq,
      completedAttempt: 1,
      nextAttempt: 2,
    })
    let events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'reconcile.progress-checked')).toHaveLength(1)
    expect(ofType(events, 'reconcile.progress-checked')[0]!.payload).toEqual({
      conflictSeq,
      attempt: 1,
      baseSha: CURRENT_BASE,
    })
    expect(ofType(events, 'reconcile.started')).toHaveLength(1)

    expect(await h.br.step()).toEqual({
      kind: 'run-phase',
      phase: 'reconcile',
      round: 2,
      reconcile: { attempt: 2 },
    })
    events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'reconcile.started').at(-1)!.payload).toEqual({
      attempt: 2,
      baseSha: PHASE_BASE,
    })
    expect(h.execCalls.filter(({ cmd }) => cmd[1] === 'fetch')).toHaveLength(2)
  })

  test('a capable forge supplies the durable progress check without origin fetch', async () => {
    class SnapshotForge extends FakeForge {
      readonly snapshots: string[] = []

      async snapshotBase(): Promise<string> {
        this.snapshots.push('snapshot')
        return CURRENT_BASE
      }
    }

    const forge = new SnapshotForge()
    const h = await makeHarness({ forge })
    const conflictSeq = await seedRepeatConflict(h.store, DETECTED_BASE)
    await h.br.step()

    expect(forge.snapshots).toHaveLength(1)
    expect(h.execCalls.some(({ cmd }) => cmd[0] === 'git' && cmd[1] === 'fetch')).toBe(false)
    expect(ofType(await h.store.getEvents(SLUG), 'reconcile.progress-checked')[0]!.payload).toEqual(
      {
        conflictSeq,
        attempt: 1,
        baseSha: CURRENT_BASE,
      },
    )
  })

  test('restart after a persisted progress check consumes it without duplicating the fact', async () => {
    const h = await makeHarness({ reconcileRefreshes: [{ sha: CURRENT_BASE }] })
    await seedRepeatConflict(h.store, DETECTED_BASE)
    h.store.faultAfterNext('reconcile.progress-checked')

    await expect(h.br.step()).rejects.toThrow('injected crash after reconcile.progress-checked')
    expect(ofType(await h.store.getEvents(SLUG), 'reconcile.progress-checked')).toHaveLength(1)
    expect(await h.br.step()).toEqual({
      kind: 'run-phase',
      phase: 'reconcile',
      round: 2,
      reconcile: { attempt: 2 },
    })
    expect(ofType(await h.store.getEvents(SLUG), 'reconcile.progress-checked')).toHaveLength(1)
  })

  test('a failed progress refresh records retryable failure without a progress fact or phase start', async () => {
    const h = await makeHarness({
      reconcileRefreshes: [{ fetchError: 'fatal: progress origin unavailable' }],
    })
    const conflictSeq = await seedRepeatConflict(h.store, DETECTED_BASE)

    expect(await h.br.step()).toEqual({
      kind: 'check-reconcile-progress',
      conflictSeq,
      completedAttempt: 1,
      nextAttempt: 2,
    })
    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'reconcile.progress-checked')).toEqual([])
    expect(ofType(events, 'reconcile.started')).toHaveLength(1)
    expect(ofType(events, 'phase.failed').at(-1)!.payload).toEqual({
      phase: 'reconcile',
      round: 2,
      attempt: 1,
      error: expect.stringContaining('progress origin unavailable'),
      willRetry: true,
    })
  })

  test('answering a runner progress failure still raises exhausted no-progress policy before reconcile', async () => {
    const stable = '4'.repeat(40)
    const h = await makeHarness({
      reconcileRefreshes: [
        { fetchError: 'fatal: progress origin unavailable' },
        { fetchError: 'fatal: progress origin unavailable' },
        { sha: stable },
      ],
      runnerOpts: { maxPhaseAttempts: 2 },
    })
    const conflictSeq = await seedRepeatConflict(h.store, stable, 3)
    const progressDecision = {
      kind: 'check-reconcile-progress' as const,
      conflictSeq,
      completedAttempt: 3,
      nextAttempt: 4,
    }

    expect(await h.br.step()).toEqual(progressDecision)
    expect(await h.br.step()).toEqual(progressDecision)
    expect(await h.br.step()).toEqual(progressDecision)

    let events = await h.store.getEvents(SLUG)
    const runnerEscalation = ofType(events, 'escalation.raised')[0]!
    expect(runnerEscalation.payload).toMatchObject({
      phase: 'reconcile',
      round: 4,
      source: 'policy',
      policyCause: 'phase-attempt-limit',
      question: expect.stringContaining('maxPhaseAttempts 2'),
    })
    expect(ofType(events, 'reconcile.progress-checked')).toEqual([])
    expect(ofType(events, 'reconcile.started')).toHaveLength(3)
    expect(h.runner.sessions.size).toBe(0)

    await h.store.append(SLUG, {
      actor: humanActor('operator'),
      type: 'escalation.answered',
      payload: {
        id: runnerEscalation.payload.id,
        answer: 'Origin is available again.',
        resolution: 'guidance',
      },
    })

    expect(await h.br.step()).toEqual(progressDecision)
    events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'reconcile.progress-checked')[0]!.payload).toEqual({
      conflictSeq,
      attempt: 3,
      baseSha: stable,
    })
    expect(ofType(events, 'reconcile.started')).toHaveLength(3)

    expect(await h.br.step()).toEqual({
      kind: 'raise-escalation',
      source: 'policy',
      policyCause: 'reconcile-no-progress',
      phase: 'reconcile',
      question:
        'maxReconcileAttempts (3) exhausted: reconciliation made no progress against an unchanged base',
    })
    events = await h.store.getEvents(SLUG)
    const escalations = ofType(events, 'escalation.raised')
    expect(escalations).toHaveLength(2)
    expect(escalations[0]!.payload.round).toBe(4)
    expect(escalations[1]!.payload).toMatchObject({
      policyCause: 'reconcile-no-progress',
    })
    expect(escalations[1]!.payload.round).toBeUndefined()
    expect(ofType(events, 'reconcile.started')).toHaveLength(3)
    expect(h.runner.sessions.size).toBe(0)
  })

  test('an answered roundless reconcile policy cause does not reset counted runner failures', async () => {
    const stable = '5'.repeat(40)
    const h = await makeHarness({
      reconcileRefreshes: [{ sha: stable }],
      runnerOpts: { maxPhaseAttempts: 2 },
    })
    const conflictSeq = await seedRepeatConflict(h.store, stable, 3)
    for (const [attempt, willRetry] of [
      [1, true],
      [2, false],
    ] as const) {
      await h.store.append(SLUG, {
        actor: KERNEL,
        type: 'phase.failed',
        payload: {
          phase: 'reconcile',
          round: 4,
          attempt,
          error: 'progress snapshot failed',
          willRetry,
        },
      })
    }
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: 'esc_no_progress',
        phase: 'reconcile',
        source: 'policy',
        policyCause: 'reconcile-no-progress',
        question: 'reconciliation made no progress',
      },
    })
    await h.store.append(SLUG, {
      actor: humanActor('operator'),
      type: 'escalation.answered',
      payload: {
        id: 'esc_no_progress',
        answer: 'try the conflict again',
        resolution: 'guidance',
      },
    })

    expect(await h.br.step()).toEqual({
      kind: 'check-reconcile-progress',
      conflictSeq,
      completedAttempt: 3,
      nextAttempt: 4,
    })

    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'escalation.raised').at(-1)!.payload).toMatchObject({
      phase: 'reconcile',
      round: 4,
      source: 'policy',
      policyCause: 'phase-attempt-limit',
      question: expect.stringContaining('maxPhaseAttempts 2'),
    })
    expect(ofType(events, 'reconcile.progress-checked')).toEqual([])
    expect(ofType(events, 'reconcile.started')).toHaveLength(3)
    expect(h.execCalls.some(({ cmd }) => cmd[0] === 'git' && cmd[1] === 'fetch')).toBe(false)
    expect(h.runner.sessions.size).toBe(0)
  })

  test('a failed base fetch records phase.failed and never falls back to pr.conflicted', async () => {
    const h = await makeHarness({
      reconcileRefreshes: [{ fetchError: 'fatal: could not read from origin' }],
    })
    await seedFinalized(h.store)
    await h.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'pr.conflicted',
      payload: { baseSha: DETECTED_BASE },
    })

    expect(await h.br.step()).toEqual({
      kind: 'run-phase',
      phase: 'reconcile',
      round: 1,
      reconcile: { attempt: 1 },
    })
    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'reconcile.started')).toEqual([])
    expect(h.runner.sessions.size).toBe(0)
    expect(ofType(events, 'phase.failed')[0]!.payload).toEqual({
      phase: 'reconcile',
      round: 1,
      attempt: 1,
      error: expect.stringContaining('could not read from origin'),
      willRetry: true,
    })
  })

  test('a fetched ref that cannot resolve to a commit also fails before session startup', async () => {
    const h = await makeHarness({
      reconcileRefreshes: [{ resolveError: 'fatal: expected a commit object' }],
    })
    await seedFinalized(h.store)
    await h.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'pr.conflicted',
      payload: { baseSha: DETECTED_BASE },
    })

    await h.br.step()
    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'reconcile.started')).toEqual([])
    expect(h.runner.sessions.size).toBe(0)
    expect(ofType(events, 'phase.failed')[0]!.payload.error).toContain('expected a commit object')
  })
})

// ── The §15.6 happy path, live over fakes ────────────────────────────────────

describe('happy path (§15.6)', () => {
  const expectedSequence = [
    'build.created',
    'workspace.provisioned',
    'spec.imported',
    'runner.attached',
    'runner.runtime-recorded',
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
    'verify.started', // historical fixture's already-started cycle
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
    'pr-summary.attempted',
    'pr-summary.result',
    'finalize.step-started',
    'session.started',
    'session.ended',
    'finalize.step-completed',
    'pr-summary.attempted',
    'pr-summary.result',
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
      const endedPayload = completedSessionEnd(event)
      expect(endedPayload.transcript.kind).toBe('transcript')
      const artifact = await h.store.getArtifact(SLUG, 'transcript', endedPayload.transcript.rev)
      expect(artifact).not.toBeNull()
      const meta = artifact!.meta.metadata
      expect(meta.session).toBe(endedPayload.session)
      expect(meta.runner).toBe('scripted')
      expect(meta.usage).toEqual(endedPayload.usage)
      corpus.push([meta.phase, meta.round, meta.role])
    }
    expect(corpus).toEqual([
      ['plan', 1, 'plan'],
      ['plan-review', 1, 'plan-review'],
      ['implement', 1, 'implement'],
      ['code-review', 1, 'code-review'],
      ['verify:e2e', 1, 'e2e'],
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
    const transcript = await h.store.getArtifact(
      SLUG,
      'transcript',
      completedSessionEnd(ended).transcript.rev,
    )
    expect(transcript?.meta.metadata.model).toBe('m-plan')
  })

  // The routing rule (§9) as an explicit contract, not incidentally as a
  // selector inside a test about something else. Observed through
  // `session.started` and the runner journal — the same evidence the reporting
  // repository had to dig out of SQLite by hand.
  describe('§9 routing: which [roles.<key>] an agent step runs on', () => {
    const withRoles = (roles: string): string => `${CONFIG_TOML}${roles}`

    async function startedFor(configToml: string, role: string) {
      const h = await makeHarness({ configToml })
      await h.br.run()
      const events = await h.store.getEvents(SLUG)
      const started = ofType(events, 'session.started').find((e) => e.payload.role === role)
      if (started === undefined) throw new Error(`no session.started with role "${role}"`)
      return { h, started }
    }

    test('an agent verify step routes by its STEP name, not its skill name', async () => {
      const { h, started } = await startedFor(
        withRoles(
          'e2e = { runtime = "scripted", model = "m-step", args = ["--effort", "high"] }\n' +
            '"ab-verify-e2e" = { runtime = "scripted", model = "m-skill" }\n',
        ),
        'e2e',
      )
      expect(started.payload.phase).toBe('verify:e2e')
      expect(started.payload.model).toBe('m-step')
      expect(started.payload.args).toEqual(['--effort', 'high'])
      const journal = [...h.runner.sessions.values()].find((j) => j.opts.skill === 'ab-verify-e2e')!
      expect(journal.opts.model).toBe('m-step')
      expect(journal.opts.args).toEqual(['--effort', 'high'])
    })

    test('…and still routes by its deprecated skill-name key when that is all there is', async () => {
      const { h, started } = await startedFor(
        withRoles('"ab-verify-e2e" = { runtime = "scripted", model = "m-skill" }\n'),
        // The RECORDED role is the logical step name in both cases — one
        // meaning for the field across every kind of session, so finding the
        // session BY it is itself the assertion. The model says what applied.
        'e2e',
      )
      expect(started.payload.phase).toBe('verify:e2e')
      expect(started.payload.model).toBe('m-skill')
      const journal = [...h.runner.sessions.values()].find((j) => j.opts.skill === 'ab-verify-e2e')!
      expect(journal.opts.model).toBe('m-skill')
    })

    test('an agent finalize step routes by its step name — unchanged', async () => {
      const { h, started } = await startedFor(
        withRoles(
          '"release-notes" = { runtime = "scripted", model = "m-step" }\n' +
            '"ab-release-notes" = { runtime = "scripted", model = "m-skill" }\n',
        ),
        'release-notes',
      )
      expect(started.payload.phase).toBe('finalize')
      expect(started.payload.model).toBe('m-step')
      const journal = [...h.runner.sessions.values()].find(
        (j) => j.opts.skill === 'ab-release-notes',
      )!
      expect(journal.opts.model).toBe('m-step')
    })
  })

  test('ambient env (D8): AB_STORE/AB_BUILD/AB_PHASE/AB_SESSION on the e2e session', async () => {
    const h = await makeHarness()
    await h.br.run()
    const events = await h.store.getEvents(SLUG)
    const e2eSession = ofType(events, 'session.started').find((e) => e.payload.role === 'e2e')!
    const journal = [...h.runner.sessions.values()].find((j) => j.opts.skill === 'ab-verify-e2e')!
    expect(journal.opts.env.AB_STORE).toBe('local')
    expect(journal.opts.env.AB_BUILD).toBe(SLUG)
    expect(journal.opts.env.AB_PHASE).toBe('verify:e2e@1')
    expect(journal.opts.env.AB_CONTEXT_DIR).toBe('.ab/verify-e2e')
    expect(journal.opts.env.AB_SESSION).toBe(e2eSession.payload.session)
  })

  test('sessionEnv spreads extra AB_* and may override AB_STORE, never the identity keys', async () => {
    const h = await makeHarness({
      delegateCredential: async () => 'phase-token',
      sessionEnv: {
        AB_STORE: 'https://store.test',
        AB_TOKEN: 'tok_1',
        AB_SESSION: 'spoofed',
        AB_CONTEXT_DIR: '.ab/spoofed',
      },
    })
    await h.br.step() // plan
    const journal = [...h.runner.sessions.values()][0]!
    expect(journal.opts.env.AB_STORE).toBe('https://store.test')
    expect(journal.opts.env.AB_TOKEN).toBe('phase-token')
    expect(journal.opts.env.AB_BUILD).toBe(SLUG)
    expect(journal.opts.env.AB_SESSION).not.toBe('spoofed')
    expect(journal.opts.env.AB_CONTEXT_DIR).toBe('.ab/plan')
  })

  test('deterministic checks run through exec sh -c in the workspace (§8.2), commands resolved from [commands]', async () => {
    const h = await makeHarness()
    await h.br.run()
    expect(h.execCalls.filter((c) => c.cmd[0] === 'sh').map((c) => c.cmd)).toEqual([
      ['sh', '-c', 'bun tsc --noEmit'],
      ['sh', '-c', 'bun test'],
    ])
    expect(h.execCalls.every((c) => c.cwd === h.workspacePath)).toBe(true)
    const events = await h.store.getEvents(SLUG)
    const completed = ofType(events, 'verify.completed')
    expect(
      completed.map((e) => [
        e.payload.step,
        normalizeVerifyCompletion(e.payload).outcome,
        e.actor.kind,
      ]),
    ).toEqual([
      ['types', 'pass', 'kernel'],
      ['unit', 'pass', 'kernel'],
      ['e2e', 'pass', 'agent'],
    ])
  })

  test('an agent verify skip is terminal and the runner continues to finalize', async () => {
    const h = await makeHarness({
      handlers: (store) => ({
        ...happyHandlers(store),
        'verify-e2e': async (ctx) => {
          await store.append(SLUG, {
            actor: agentActor('verify-e2e', sessionOf(ctx)),
            type: 'verify.completed',
            payload: {
              step: 'e2e',
              attempt: roundOf(ctx),
              outcome: 'skipped',
              reason: 'No browser-facing behavior changed',
            },
          })
          return defaultTurnResult('e2e not applicable')
        },
      }),
    })

    await h.br.run()
    const events = await h.store.getEvents(SLUG)
    const skipped = ofType(events, 'verify.completed').find(
      (event) => normalizeVerifyCompletion(event.payload).outcome === 'skipped',
    )
    expect(skipped).toBeDefined()
    expect(normalizeVerifyCompletion(skipped!.payload)).toEqual({
      step: 'e2e',
      attempt: 1,
      outcome: 'skipped',
      reason: 'No browser-facing behavior changed',
    })
    expect(ofType(events, 'finalize.completed')).toHaveLength(1)
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

  test('a structured finalize-step failure is failure-tolerant and keeps its transcript', async () => {
    const h = await makeHarness({
      handlers: (store) => ({
        ...happyHandlers(store),
        'release-notes': () => failedTurnResult('403 billing disabled', true),
      }),
    })
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
      payload: {
        pr: { number: 7, url: 'https://forge.test/pr/7', headSha: 'sha-head-1' },
      },
    })

    const decision = await h.br.step()
    expect(decision.kind).toBe('run-finalize-step')
    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'finalize.step-completed').at(-1)?.payload).toEqual({
      step: 'release-notes',
      ok: false,
      note: 'agent turn failed: 403 billing disabled',
    })
    expect(ofType(events, 'session.ended')).toHaveLength(1)
    expect(ofType(events, 'observation.recorded').at(-1)?.payload.summary).toContain(
      'release-notes',
    )
  })
})

// ── Finalize post-step publication (§5, D7) ──────────────────────────────────

describe('finalize post-step publication', () => {
  const FINALIZE_HEAD = 'f'.repeat(40)

  async function readyHarness(options: HarnessOptions = {}): Promise<Harness> {
    const h = await makeHarness(options)
    await seedReadyForFinalizeStep(h.store)
    h.forge.setPrState(7, { state: 'open', mergeable: true })
    return h
  }

  async function expectFailureTolerance(h: Harness, note: string): Promise<void> {
    const events = await h.store.getEvents(SLUG)
    const completed = ofType(events, 'finalize.step-completed').at(-1)
    expect(completed?.payload).toMatchObject({
      step: 'release-notes',
      ok: false,
      note: expect.stringContaining(note),
    })
    expect(ofType(events, 'observation.recorded').at(-1)?.payload.summary).toContain(note)
    expect(await h.br.step()).toEqual({ kind: 'wait', reason: 'awaiting-pr' })
  }

  test('regular-pushes a clean descendant to the immutable branch and checkpoints it', async () => {
    const h = await readyHarness({
      finalizeStatuses: ['', ''],
      finalizeHeads: [FINALIZE_HEAD],
      finalizeAncestors: [true],
    })

    await h.forge.setAutoMerge(h.workspacePath, 7, true)
    const push = h.forge.pushBranch.bind(h.forge)
    h.forge.pushBranch = async (...args) => {
      expect(h.forge.isAutoMergeEnabled(7)).toBe(false)
      expect(
        ofType(await h.store.getEvents(SLUG), 'landing.native-applied').at(-1)?.payload,
      ).toMatchObject({ enabled: false, operation: 'finalize-step:release-notes' })
      await push(...args)
    }

    expect((await h.br.step()).kind).toBe('run-finalize-step')
    expect(h.forge.pushes).toEqual([{ workspacePath: h.workspacePath, branch: BRANCH }])

    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'finalize.step-completed').at(-1)?.payload).toEqual({
      step: 'release-notes',
      ok: true,
      headSha: FINALIZE_HEAD,
    })
    expect(selectPublishedBranchHead(events)).toBe(FINALIZE_HEAD)
    expect(h.execCalls.slice(-5).map((call) => call.cmd)).toEqual([
      ['git', 'status', '--porcelain'],
      ['git', 'status', '--porcelain'],
      ['git', 'rev-parse', 'HEAD'],
      ['git', 'merge-base', '--is-ancestor', 'sha-head-1', FINALIZE_HEAD],
      ['git', 'rev-list', '--reverse', `sha-head-1..${FINALIZE_HEAD}`],
    ])
    // A clean worktree never runs the preflight's diff capture (and therefore
    // never consumes verifyDiffs entries either).
    expect(h.execCalls.map((call) => call.cmd)).not.toContainEqual(['git', 'diff'])
    expect(h.execCalls.map((call) => call.cmd)).not.toContainEqual(['git', 'diff', '--cached'])
  })

  test('a remote workspace forks the finalize push into a publication request, by marker and by legacy name', async () => {
    for (const provisioned of [
      { provider: 'fake', remote: true },
      { provider: 'vercel-sandbox' },
    ]) {
      const h = await readyHarness({
        finalizeStatuses: ['', ''],
        finalizeHeads: [FINALIZE_HEAD],
        finalizeAncestors: [true],
        workspaceProvider: provisioned.provider,
        ...(provisioned.remote !== undefined ? { workspaceRemote: provisioned.remote } : {}),
      })

      expect((await h.br.step()).kind).toBe('run-finalize-step')
      expect(h.forge.pushes).toEqual([])
      const requests = ofType(await h.store.getEvents(SLUG), 'publication.requested')
      expect(requests).toHaveLength(1)
      expect(requests[0]!.payload).toEqual({
        operation: 'finalize-step',
        branch: BRANCH,
        sha: FINALIZE_HEAD,
        step: 'release-notes',
      })
    }
  })

  test('an explicit local marker keeps the finalize push direct', async () => {
    const h = await readyHarness({
      finalizeStatuses: ['', ''],
      finalizeHeads: [FINALIZE_HEAD],
      finalizeAncestors: [true],
      workspaceRemote: false,
    })

    expect((await h.br.step()).kind).toBe('run-finalize-step')
    expect(h.forge.pushes).toEqual([{ workspacePath: h.workspacePath, branch: BRANCH }])
    expect(ofType(await h.store.getEvents(SLUG), 'publication.requested')).toEqual([])
  })

  test('an explicit local marker keeps the finalize push direct even over a remote-suggestive provider name', async () => {
    const h = await readyHarness({
      finalizeStatuses: ['', ''],
      finalizeHeads: [FINALIZE_HEAD],
      finalizeAncestors: [true],
      workspaceProvider: 'vercel-sandbox',
      workspaceRemote: false,
    })

    expect((await h.br.step()).kind).toBe('run-finalize-step')
    expect(h.forge.pushes).toEqual([{ workspacePath: h.workspacePath, branch: BRANCH }])
    expect(ofType(await h.store.getEvents(SLUG), 'publication.requested')).toEqual([])
  })

  test('scratch commits fail tolerantly with an observation and no push', async () => {
    const h = await readyHarness({
      finalizeStatuses: ['', ''],
      finalizeHeads: [FINALIZE_HEAD],
      finalizeAncestors: [true],
      finalizeCommits: [FINALIZE_HEAD],
      finalizeCommitParents: { [FINALIZE_HEAD]: ['sha-head-1'] },
      verifyDiffs: [{ paths: ['.ab/release-notes.md'] }],
    })

    await h.br.step()
    expect(h.forge.pushes).toEqual([])
    await expectFailureTolerance(h, 'publication rejected')
    const observation = ofType(await h.store.getEvents(SLUG), 'observation.recorded').at(-1)
    expect(observation?.payload.summary).toContain('.ab/release-notes.md')
    expect(observation?.payload.summary).toContain('retry completion')
  })

  test('an unconfirmed native cancellation prevents a post-step push', async () => {
    const h = await readyHarness({
      finalizeStatuses: ['', ''],
      finalizeHeads: [FINALIZE_HEAD],
      finalizeAncestors: [true],
    })
    h.forge.setAutoMergeState(7, true)
    h.forge.setAutoMerge = async () => ({ kind: 'deferred' })
    await h.br.step()
    expect(h.forge.pushes).toEqual([])
    await expectFailureTolerance(h, 'cancellation unconfirmed')
  })

  test('an unchanged HEAD creates and pushes nothing', async () => {
    const h = await readyHarness({ finalizeHeads: ['sha-head-1'] })

    await h.br.step()
    expect(h.forge.pushes).toEqual([])
    expect(h.execCalls.some((call) => call.cmd[0] === 'git' && call.cmd[1] === 'commit')).toBe(
      false,
    )
    expect(
      ofType(await h.store.getEvents(SLUG), 'finalize.step-completed').at(-1)?.payload,
    ).toEqual({ step: 'release-notes', ok: true })
  })

  test('dirty post-step output is observed and still advances to the open PR wait', async () => {
    const h = await readyHarness({
      finalizeStatuses: ['', ' M release-notes.md\n'],
    })

    await h.br.step()
    expect(h.forge.pushes).toEqual([])
    await expectFailureTolerance(h, 'workspace must be clean after the post-step finishes')
  })

  test('a dirty preflight record includes both diffs so a mode-only flip is characterizable', async () => {
    // The AUT-439 shape: porcelain lists the path, but only the diff shows the
    // change is mode-only — indistinguishable from a content edit without it.
    const h = await readyHarness({
      finalizeStatuses: [' M bin.ts\n'],
      finalizeDiffs: {
        working: 'diff --git a/bin.ts b/bin.ts\nold mode 100755\nnew mode 100644\n',
        staged: '',
      },
    })

    await h.br.step()
    await expectFailureTolerance(h, 'workspace must be clean before the post-step starts')
    const note = ofType(await h.store.getEvents(SLUG), 'finalize.step-completed').at(-1)?.payload
      .note
    expect(note).toContain(' M bin.ts')
    expect(note).toContain('--- git diff (working tree) ---')
    expect(note).toContain('old mode 100755')
    expect(note).toContain('new mode 100644')
    expect(note).toContain('--- git diff --cached (staged) ---')
    expect(note).toContain('(no output)')
  })

  test('a large dirty diff is truncated at the stated cap', async () => {
    const oversized = 'x'.repeat(30_000)
    const h = await readyHarness({
      finalizeStatuses: [' M big.txt\n'],
      finalizeDiffs: { working: oversized, staged: '' },
    })

    await h.br.step()
    const note = ofType(await h.store.getEvents(SLUG), 'finalize.step-completed').at(-1)?.payload
      .note
    expect(note).toContain('... (truncated at 20000 characters)')
    expect(note).not.toContain(oversized)
    // Bound: porcelain + two capped sections (20k characters each) + headers.
    expect(note!.length).toBeLessThan(20_000 * 2 + 500)
  })

  test('a failing diff capture annotates its section without masking the dirty-worktree failure', async () => {
    const h = await readyHarness({
      finalizeStatuses: [' M bin.ts\n'],
      finalizeDiffs: { staged: { error: 'fatal: not a git repository' } },
    })

    await h.br.step()
    await expectFailureTolerance(h, 'workspace must be clean before the post-step starts')
    const note = ofType(await h.store.getEvents(SLUG), 'finalize.step-completed').at(-1)?.payload
      .note
    expect(note).toContain('workspace must be clean before the post-step starts')
    expect(note).toContain('--- git diff (working tree) ---')
    expect(note).toContain('(git diff --cached failed: exit 128: fatal: not a git repository)')
  })

  test('a non-descendant HEAD is rejected without pushing or failing the green build', async () => {
    const h = await readyHarness({
      finalizeHeads: [FINALIZE_HEAD],
      finalizeAncestors: [false],
    })

    await h.br.step()
    expect(h.forge.pushes).toEqual([])
    await expectFailureTolerance(h, 'rewrote branch history')
  })

  test('a thrown Forge push is observed and still advances to the open PR wait', async () => {
    class ThrowingPushForge extends FakeForge {
      readonly attempts: Array<{ workspacePath: string; branch: string }> = []

      override async pushBranch(workspacePath: string, branch: string): Promise<void> {
        this.attempts.push({ workspacePath, branch })
        throw new Error('remote rejected finalize push')
      }
    }
    const forge = new ThrowingPushForge()
    const h = await readyHarness({
      forge,
      finalizeHeads: [FINALIZE_HEAD],
      finalizeAncestors: [true],
    })

    await h.br.step()
    expect(forge.attempts).toEqual([{ workspacePath: h.workspacePath, branch: BRANCH }])
    await expectFailureTolerance(h, 'remote rejected finalize push')
  })

  test('local finalize readback failure records the failed step without a pending publication', async () => {
    const forge = new FakeForge()
    forge.confirmPublication = async () => false
    const h = await readyHarness({
      forge,
      finalizeHeads: [FINALIZE_HEAD],
      finalizeAncestors: [true],
    })
    await h.br.step()
    await expectFailureTolerance(h, 'publication readback did not confirm')
    expect(ofType(await h.store.getEvents(SLUG), 'publication.requested')).toHaveLength(0)
  })

  test('retries an already-pushed local descendant when the completion checkpoint was lost', async () => {
    const h = await readyHarness({
      finalizeHeads: [FINALIZE_HEAD],
      finalizeAncestors: [true],
    })
    // Models a crash after Forge.pushBranch and before finalize.step-completed.
    await h.forge.pushBranch(h.workspacePath, BRANCH, FINALIZE_HEAD)

    await h.br.step()
    expect(h.forge.pushes).toEqual([{ workspacePath: h.workspacePath, branch: BRANCH }])
    expect(
      ofType(await h.store.getEvents(SLUG), 'finalize.step-completed').at(-1)?.payload,
    ).toMatchObject({ ok: true, headSha: FINALIZE_HEAD })
  })
})

// ── First-class finalize actions (§5, §16.1) ─────────────────────────────────

describe('first-class finalize checks and agents', () => {
  const finalizeConfig = `
[tickets]
source = "file"
readyState = "ready"

[commands]
publish = "bun run publish"

[finalize]
steps = ["publish", "release-notes"]

[finalize.publish]
kind = "check"
command = "publish"

[finalize.release-notes]
kind = "agent"
skill = "custom-notes-skill"
`

  async function seedReady(store: BuildStore): Promise<void> {
    await seedPlanApproved(store)
    await seedCodeApproved(store)
    await store.append(SLUG, {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: {
        pr: { number: 7, url: 'https://forge.test/pr/7', headSha: 'sha-head-1' },
      },
    })
  }

  test.each([false, true])(
    'routes finalize post-step context with alternate routing %s',
    async (alternates) => {
      const h = await makeHarness({
        configToml:
          finalizeConfig +
          (alternates
            ? '\n[roles.release-notes]\nruntime = "scripted"\nmodel = "m-post"\nalternates = [{ runtime = "pi", model = "kimi-post" }]\n'
            : ''),
        handlers: (store) => ({
          ...happyHandlers(store),
          'custom-notes-skill': (ctx) => {
            expect(ctx.opts.env.AB_CONTEXT_DIR).toBe('.ab/finalize-release-notes')
            return ctx.opts.model === 'm-post'
              ? failedTurnResult('primary exhausted', true, '', 'exhaustion')
              : defaultTurnResult('notes posted')
          },
        }),
      })
      await seedReady(h.store)

      expect(await h.br.step()).toEqual({
        kind: 'run-finalize-step',
        step: 'publish',
        action: { kind: 'check', command: 'bun run publish' },
      })
      expect(h.execCalls).toEqual([
        { cmd: ['git', 'status', '--porcelain'], cwd: h.workspacePath },
        { cmd: ['sh', '-c', 'bun run publish'], cwd: h.workspacePath },
        { cmd: ['git', 'status', '--porcelain'], cwd: h.workspacePath },
        { cmd: ['git', 'rev-parse', 'HEAD'], cwd: h.workspacePath },
      ])
      let events = await h.store.getEvents(SLUG)
      expect(ofType(events, 'session.started')).toHaveLength(0)
      expect(ofType(events, 'finalize.step-completed').at(-1)).toMatchObject({
        actor: { kind: 'kernel' },
        payload: { step: 'publish', ok: true },
      })

      expect(await h.br.step()).toEqual({
        kind: 'run-finalize-step',
        step: 'release-notes',
        action: { kind: 'agent', skill: 'custom-notes-skill' },
      })
      const journal = [...h.runner.sessions.values()].at(-1)!
      expect(journal.opts.skill).toBe('custom-notes-skill')
      expect(journal.opts.env.AB_PHASE).toBe('finalize@1')
      expect(journal.opts.env.AB_CONTEXT_DIR).toBe('.ab/finalize-release-notes')
      expect(journal.opts.workspacePath).toBe(h.workspacePath)
      events = await h.store.getEvents(SLUG)
      const agentDone = ofType(events, 'finalize.step-completed').at(-1)!
      expect(agentDone.actor.kind).toBe('agent')
      expect(ofType(events, 'session.ended')).toHaveLength(alternates ? 2 : 1)
    },
  )

  test('publishes a check-created descendant through the same kernel boundary', async () => {
    const checkHead = 'c'.repeat(40)
    const h = await makeHarness({
      configToml: finalizeConfig,
      finalizeHeads: [checkHead],
      finalizeAncestors: [true],
    })
    await seedReady(h.store)
    h.forge.setPrState(7, { state: 'open', mergeable: true })

    await h.br.step()

    expect(h.forge.pushes).toEqual([{ workspacePath: h.workspacePath, branch: BRANCH }])
    const completed = ofType(await h.store.getEvents(SLUG), 'finalize.step-completed').at(-1)!
    expect(completed.actor).toEqual(KERNEL)
    expect(completed.payload).toEqual({
      step: 'publish',
      ok: true,
      headSha: checkHead,
    })
  })

  test('nonzero and thrown checks record kernel follow-ups and still advance', async () => {
    for (const mode of ['nonzero', 'throw'] as const) {
      const h = await makeHarness({
        configToml: finalizeConfig,
        ...(mode === 'nonzero'
          ? { failCommands: ['bun run publish'] }
          : { throwCommands: ['bun run publish'] }),
      })
      await seedReady(h.store)
      await h.br.step()

      const events = await h.store.getEvents(SLUG)
      const completed = ofType(events, 'finalize.step-completed').at(-1)!
      expect(completed.actor).toEqual(KERNEL)
      expect(completed.payload).toMatchObject({ step: 'publish', ok: false })
      expect(completed.payload.note).toContain(mode === 'nonzero' ? 'exited 1' : 'exec unavailable')
      const observation = ofType(events, 'observation.recorded').at(-1)!
      expect(observation.actor).toEqual(KERNEL)
      expect(observation.payload.summary).toContain('publish')
      expect(ofType(events, 'session.started')).toHaveLength(0)

      expect(await h.br.step()).toMatchObject({
        kind: 'run-finalize-step',
        step: 'release-notes',
      })
    }
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
  test('an in-flight producer keeps its route, then the next round restarts under the new model', async () => {
    let current = parseConfig(CONFIG_TOML)
    current.roles.default = { runtime: 'scripted' }
    let entered!: () => void
    const inFlight = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const handlers = (store: BuildStore): Record<string, SkillHandler> => {
      const base = happyHandlers(store)
      return {
        ...base,
        plan: async (ctx) => {
          if (roundOf(ctx) === 1) {
            entered()
            await gate
          }
          return base.plan!(ctx)
        },
        'plan-review': async (ctx) => {
          const round = roundOf(ctx)
          await reviewVerdict(
            store,
            ctx,
            'plan-review',
            round === 1 ? 'revise' : 'approve',
            round === 1 ? [FINDING] : [],
          )
          return defaultTurnResult(`reviewed r${round}`)
        },
      }
    }
    const h = await makeHarness({ handlers, getConfig: () => current })

    const first = h.br.step()
    await inFlight
    current = parseConfig(CONFIG_TOML.replace('model = "m-plan"', 'model = "m-plan-next"'))
    current.roles.default = { runtime: 'scripted' }
    const openStarts = ofType(await h.store.getEvents(SLUG), 'session.started').filter(
      (event) => event.payload.phase === 'plan',
    )
    expect(openStarts.map((event) => event.payload.model)).toEqual(['m-plan'])
    expect(
      [...h.runner.sessions.values()].filter((journal) => journal.opts.skill === 'ab-plan'),
    ).toHaveLength(1)
    release()
    await first
    await h.br.step() // review r1 -> revise, using the new snapshot only after r1 finished
    await h.br.step() // plan r2 must start fresh on the new route

    const starts = ofType(await h.store.getEvents(SLUG), 'session.started').filter(
      (event) => event.payload.phase === 'plan',
    )
    expect(starts.map((event) => event.payload.model)).toEqual(['m-plan', 'm-plan-next'])
    const journals = [...h.runner.sessions.values()].filter(
      (journal) => journal.opts.skill === 'ab-plan',
    )
    expect(journals).toHaveLength(2)
    expect(journals.every((journal) => journal.turns.length === 1)).toBe(true)
    expect(journals.every((journal) => journal.messages.length === 0)).toBe(true)
  })

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
    expect(journal.messages[0]).toContain('$AB_CONTEXT_DIR/findings.json')
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

  test('producer guidance survives a crash after its carrier start and before session launch', async () => {
    const materialized: Array<{ escalation: string; answer: string }> = []
    const h = await makeHarness({
      handlers: (store) => {
        const table = happyHandlers(store)
        const plan = table.plan!
        table.plan = async (ctx) => {
          materialized.push(await guidanceMaterializedFor(store, ctx))
          return plan(ctx)
        }
        return table
      },
    })
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
    h.store.faultAfterNext('plan.started')
    await expect(h.br.step()).rejects.toThrow('injected crash after plan.started')

    let events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'plan.started').at(-1)!.payload).toEqual({
      round: 2,
      feedback: { guidance },
    })
    expect(ofType(events, 'session.started')).toHaveLength(0)
    expect(ofType(events, 'escalation.answered')).toHaveLength(1)

    expect(await h.br.step()).toEqual({
      kind: 'run-phase',
      phase: 'plan',
      round: 2,
      feedback: { guidance },
    })
    expect(materialized).toEqual([guidance])

    events = await h.store.getEvents(SLUG)
    expect(
      ofType(events, 'plan.started')
        .slice(-2)
        .map((event) => event.payload),
    ).toEqual([
      { round: 2, feedback: { guidance } },
      { round: 2, feedback: { guidance } },
    ])
    expect(
      ofType(events, 'session.started').filter((event) => event.payload.phase === 'plan'),
    ).toHaveLength(1)
    expect(ofType(events, 'escalation.answered')).toHaveLength(1)

    expect(await h.br.step()).toMatchObject({ kind: 'run-phase', phase: 'plan-review', round: 2 })
    expect(ofType(await h.store.getEvents(SLUG), 'plan.started')).toHaveLength(3)
  })

  test('verifier guidance survives a crash after its carrier start and before session launch', async () => {
    const materialized: Array<{ escalation: string; answer: string }> = []
    const h = await makeHarness({
      handlers: (store) => {
        const table = happyHandlers(store)
        table['verify-e2e'] = async (ctx) => {
          materialized.push(await guidanceMaterializedFor(store, ctx))
          await store.append(SLUG, {
            actor: agentActor('verify-e2e', sessionOf(ctx)),
            type: 'verify.completed',
            payload: { step: 'e2e', attempt: roundOf(ctx), outcome: 'pass' },
          })
          return defaultTurnResult('e2e green with operator guidance')
        }
        return table
      },
    })
    await seedPlanApproved(h.store)
    await seedCodeApproved(h.store)
    for (const step of ['types', 'unit']) {
      await h.store.append(SLUG, {
        actor: KERNEL,
        type: 'verify.started',
        payload: { step, attempt: 1 },
      })
      await h.store.append(SLUG, {
        actor: KERNEL,
        type: 'verify.completed',
        payload: { step, attempt: 1, outcome: 'pass' },
      })
    }
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'verify.started',
      payload: { step: 'e2e', attempt: 1 },
    })
    await h.store.append(SLUG, {
      actor: agentActor('verify-e2e', 's_seed'),
      type: 'escalation.raised',
      payload: {
        id: 'esc_verify',
        phase: 'verify:e2e',
        round: 1,
        source: 'agent',
        question: 'Which test account is authoritative?',
      },
    })
    await h.store.append(SLUG, {
      actor: humanActor('aron'),
      type: 'escalation.answered',
      payload: {
        id: 'esc_verify',
        answer: 'Use the seeded admin account.',
        resolution: 'guidance',
      },
    })

    const guidance = { escalation: 'esc_verify', answer: 'Use the seeded admin account.' }
    h.store.faultAfterNext('verify.started')
    await expect(h.br.step()).rejects.toThrow('injected crash after verify.started')

    let events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'verify.started').at(-1)!.payload).toEqual({
      step: 'e2e',
      attempt: 1,
      feedback: { guidance },
    })
    expect(ofType(events, 'session.started')).toHaveLength(0)
    expect(ofType(events, 'escalation.answered')).toHaveLength(1)

    expect(await h.br.step()).toEqual({
      kind: 'run-agent-verify',
      step: 'e2e',
      skill: 'ab-verify-e2e',
      attempt: 1,
      feedback: { guidance },
    })
    expect(materialized).toEqual([guidance])

    events = await h.store.getEvents(SLUG)
    expect(
      ofType(events, 'verify.started')
        .filter((event) => event.payload.step === 'e2e')
        .slice(-2)
        .map((event) => event.payload),
    ).toEqual([
      { step: 'e2e', attempt: 1, feedback: { guidance } },
      { step: 'e2e', attempt: 1, feedback: { guidance } },
    ])
    expect(
      ofType(events, 'session.started').filter(
        (event) => event.payload.phase === 'verify:e2e' && event.payload.round === 1,
      ),
    ).toHaveLength(1)
    expect(ofType(events, 'escalation.answered')).toHaveLength(1)

    expect(await h.br.step()).toMatchObject({ kind: 'run-phase', phase: 'finalize' })
    expect(
      ofType(await h.store.getEvents(SLUG), 'verify.started').filter(
        (event) => event.payload.step === 'e2e',
      ),
    ).toHaveLength(3)
  })

  test('a continued turn re-issues ambient auth (D8): the new round in AB_PHASE, the new bracket in AB_SESSION', async () => {
    // Regression: the runner used to leave the continued turn on round 1's
    // start env, so the real CLI resolved round=1 and its terminal was
    // rejected as a D5 second call — §10 continuation was dead in production.
    const seen: Array<{ phase: string; session: string }> = []
    const h = await makeHarness({
      handlers: (store) => {
        const table = reviseThenApproveHandlers(store)
        const implement = table.implement!
        table.implement = (ctx) => {
          seen.push({
            phase: ctx.opts.env.AB_PHASE ?? '',
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
        const implement = table.implement!
        table.implement = async (ctx) => {
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
    const r2 = ofType(events, 'session.started').filter((e) => e.payload.role === 'implement')[1]!
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
    const endedSessions = new Set(ofType(events, 'session.ended').map((e) => e.payload.session))
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

// ── Durable terminal followed by a runtime throw ─────────────────────────────

function terminalThrowConfig(withAlternates: boolean): string {
  const alternates = withAlternates
    ? 'alternates = [{ runtime = "pi", model = "kimi-alternate" }]'
    : ''
  return `
[tickets]
source = "file"
readyState = "ready"
[commands]
[verify]
steps = []
[finalize]
steps = []
[roles.default]
runtime = "scripted"
[roles.plan]
runtime = "scripted"
model = "m-plan"
${alternates}
[roles.implement]
runtime = "scripted"
model = "m-implement"
${alternates}
`
}

function terminalThrowContinuationHandlers(
  store: BuildStore,
  beforeThrow?: () => void,
): Record<string, SkillHandler> {
  const table = happyHandlers(store)
  const implement = table.implement!
  table.implement = async (ctx) => {
    if (roundOf(ctx) === 2) {
      await implement(ctx)
      beforeThrow?.()
      throw new Error('runtime transport failed after implement terminal')
    }
    return implement(ctx)
  }
  table['code-review'] = async (ctx) => {
    const round = roundOf(ctx)
    await reviewVerdict(
      store,
      ctx,
      'code-review',
      round < 3 ? 'revise' : 'approve',
      round < 3 ? [{ ...FINDING, id: `f_terminal_${round}` }] : [],
    )
    return defaultTurnResult(`reviewed r${round}`)
  }
  return table
}

describe('durable terminal followed by a runtime throw', () => {
  for (const mode of [
    { name: 'single runtime', alternates: false },
    { name: 'runtime chain', alternates: true },
  ]) {
    test(`${mode.name}: a rejected fresh start keeps its terminal authoritative`, async () => {
      const h = await makeHarness({
        configToml: terminalThrowConfig(mode.alternates),
        handlers: (store) => {
          const table = happyHandlers(store)
          const plan = table.plan!
          table.plan = async (ctx) => {
            await plan(ctx)
            throw new Error('runtime transport failed after plan terminal')
          }
          return table
        },
      })
      await h.br.attach()
      await h.br.step()

      const events = await h.store.getEvents(SLUG)
      const planStarts = ofType(events, 'session.started').filter(
        (event) => event.payload.phase === 'plan',
      )
      expect(planStarts).toHaveLength(1)
      expect(ofType(events, 'plan.completed')).toHaveLength(1)
      expect(
        ofType(events, 'phase.failed').filter((event) => event.payload.phase === 'plan'),
      ).toEqual([])
      expect(planStarts[0]?.payload.substitution).toBeUndefined()
      // A rejected start exposes no handle through the current port, so the
      // durable open bracket remains for crash recovery rather than inventing
      // an unavailable transcript.
      expect(
        ofType(events, 'session.ended').filter(
          (event) => event.payload.session === planStarts[0]?.payload.session,
        ),
      ).toEqual([])
    })

    test(`${mode.name}: a continued producer throw retains one atomic transcript bracket`, async () => {
      const h = await makeHarness({
        configToml: terminalThrowConfig(mode.alternates),
        handlers: (store) => terminalThrowContinuationHandlers(store),
      })
      await h.br.run()

      const events = await h.store.getEvents(SLUG)
      const implementStarts = ofType(events, 'session.started').filter(
        (event) => event.payload.phase === 'implement',
      )
      expect(implementStarts.map((event) => event.payload.round)).toEqual([1, 2, 3])
      expect(implementStarts.every((event) => event.payload.runner === 'scripted')).toBe(true)
      expect(implementStarts.every((event) => event.payload.substitution === undefined)).toBe(true)
      expect(ofType(events, 'implement.completed')).toHaveLength(3)
      expect(
        ofType(events, 'phase.failed').filter((event) => event.payload.phase === 'implement'),
      ).toEqual([])

      const recoveredSession = implementStarts[1]!.payload.session
      const recoveredEnds = ofType(events, 'session.ended').filter(
        (event) => event.payload.session === recoveredSession,
      )
      expect(recoveredEnds).toHaveLength(1)
      const recoveredTranscripts = (await h.store.listArtifacts(SLUG, 'transcript')).filter(
        (artifact) => artifact.metadata.session === recoveredSession,
      )
      expect(recoveredTranscripts).toHaveLength(1)
      const recoveredEnd = recoveredEnds[0]!
      expect('transcript' in recoveredEnd.payload).toBe(true)
      if (!('transcript' in recoveredEnd.payload)) {
        throw new Error('expected transcript-bearing session ending')
      }
      expect(recoveredEnd.payload.transcript).toEqual({
        kind: 'transcript',
        rev: recoveredTranscripts[0]!.revision,
      })
      expect(recoveredEnd.payload.usage).toEqual({
        inputTokens: 1,
        outputTokens: 1,
        turns: 1,
      })
      expect(recoveredTranscripts[0]!.metadata).toEqual({
        phase: 'implement',
        round: 2,
        role: 'implement',
        runner: 'scripted',
        model: 'm-implement',
        session: recoveredSession,
        usage: { inputTokens: 1, outputTokens: 1, turns: 1 },
      })

      const implementJournals = [...h.runner.sessions.values()].filter(
        (journal) => journal.opts.skill === 'ab-implement',
      )
      expect(implementJournals).toHaveLength(2)
      expect(implementJournals[0]!.ended).toBe(true)
      expect(implementJournals[1]!.turns).toHaveLength(1)
      expect(implementJournals[1]!.messages).toEqual([])
    })
  }

  test('runtime chain: an unrecoverable close still cannot override the terminal or select an alternate', async () => {
    let failNextImplementEnd = false
    const h = await makeHarness({
      configToml: terminalThrowConfig(true),
      handlers: (store) =>
        terminalThrowContinuationHandlers(store, () => {
          failNextImplementEnd = true
        }),
    })
    const ordinaryEnd = h.runner.end.bind(h.runner)
    h.runner.end = async (session) => {
      if (failNextImplementEnd && session.model === 'm-implement') {
        failNextImplementEnd = false
        throw new Error('provider handle could not close')
      }
      return ordinaryEnd(session)
    }

    await h.br.run()

    const events = await h.store.getEvents(SLUG)
    const implementStarts = ofType(events, 'session.started').filter(
      (event) => event.payload.phase === 'implement',
    )
    expect(implementStarts.map((event) => [event.payload.round, event.payload.runner])).toEqual([
      [1, 'scripted'],
      [2, 'scripted'],
      [3, 'scripted'],
    ])
    expect(ofType(events, 'implement.completed')).toHaveLength(3)
    expect(
      ofType(events, 'phase.failed').filter((event) => event.payload.phase === 'implement'),
    ).toEqual([])
    const unrecoveredSession = implementStarts[1]!.payload.session
    expect(
      ofType(events, 'session.ended').filter(
        (event) => event.payload.session === unrecoveredSession,
      ),
    ).toEqual([])
    expect(
      (await h.store.listArtifacts(SLUG, 'transcript')).filter(
        (artifact) => artifact.metadata.session === unrecoveredSession,
      ),
    ).toEqual([])
    const implementJournals = [...h.runner.sessions.values()].filter(
      (journal) => journal.opts.skill === 'ab-implement',
    )
    expect(implementJournals).toHaveLength(2)
    expect(implementJournals[1]!.turns).toHaveLength(1)
    expect(implementJournals[1]!.messages).toEqual([])
  })
})

// ── Provider/runner failures (§8.4, §9) ──────────────────────────────────────

describe('structured provider failure policy', () => {
  const alternateConfig = `
[tickets]
source = "file"
readyState = "ready"

[commands]
[verify]
steps = []
[finalize]
steps = []

[roles.default]
runtime = "scripted"
[roles.plan]
runtime = "scripted"
model = "m-plan"
alternates = [{ runtime = "pi", model = "kimi-alt" }]
`

  test('an eligible primary failure substitutes in-order inside one attempt with durable attribution', async () => {
    const h = await makeHarness({
      configToml: alternateConfig,
      handlers: (store) => {
        const table = happyHandlers(store)
        const happyPlan = table.plan!
        table.plan = (ctx) =>
          ctx.opts.model === 'm-plan'
            ? failedTurnResult('primary quota exhausted', true, '', 'exhaustion')
            : happyPlan(ctx)
        return table
      },
    })

    await h.br.run()
    const events = await h.store.getEvents(SLUG)
    const starts = events.filter((event) => event.type === 'session.started')
    const planStarts = starts.filter(
      (event) => event.type === 'session.started' && event.payload.phase === 'plan',
    )
    expect(planStarts).toHaveLength(2)
    expect(planStarts[0]?.payload).toMatchObject({ runner: 'scripted', model: 'm-plan' })
    expect(planStarts[1]?.payload).toMatchObject({
      runner: 'pi',
      model: 'kimi-alt',
      substitution: {
        failed: {
          index: 0,
          runner: 'scripted',
          model: 'm-plan',
          error: 'primary quota exhausted',
          cause: 'exhaustion',
        },
        selectedIndex: 1,
      },
    })
    expect(
      events.filter((event) => event.type === 'phase.failed' && event.payload.phase === 'plan'),
    ).toHaveLength(0)
    const planCompleted = events.find((event) => event.type === 'plan.completed')
    expect(planCompleted?.actor).toMatchObject({
      kind: 'agent',
      session: planStarts[1]?.payload.session,
    })
    expect(starts[2]?.payload.runner).toBe('scripted')
  })

  test('a failed producer continuation falls back fresh and the following round resets to primary', async () => {
    const continuationConfig = `
[tickets]
source = "file"
readyState = "ready"
[commands]
[verify]
steps = []
[finalize]
steps = []
[roles.default]
runtime = "scripted"
[roles.implement]
runtime = "scripted"
model = "m-implement"
alternates = [{ runtime = "pi", model = "kimi-alternate" }]
`
    const h = await makeHarness({
      configToml: continuationConfig,
      handlers: (store) => {
        const table = happyHandlers(store)
        const happyImplement = table.implement!
        table.implement = (ctx) => {
          const round = roundOf(ctx)
          if (round === 2 && ctx.opts.model === 'm-implement') {
            expect(ctx.turn).toBe(2)
            return failedTurnResult('continued primary unavailable', false, '', 'availability')
          }
          if (round === 2) {
            expect(ctx.opts.model).toBe('kimi-alternate')
            expect(ctx.turn).toBe(1)
          }
          if (round === 3) {
            expect(ctx.opts.model).toBe('m-implement')
            expect(ctx.turn).toBe(1)
          }
          return happyImplement(ctx)
        }
        table['code-review'] = async (ctx) => {
          const round = roundOf(ctx)
          if (round < 3) {
            await reviewVerdict(store, ctx, 'code-review', 'revise', [
              { ...FINDING, id: `f_round_${round}` },
            ])
            return defaultTurnResult(`revision ${round} requested`)
          }
          await reviewVerdict(store, ctx, 'code-review', 'approve')
          return defaultTurnResult('approved')
        }
        return table
      },
    })

    await h.br.run()
    const events = await h.store.getEvents(SLUG)
    const implementStarts = ofType(events, 'session.started').filter(
      (event) => event.payload.phase === 'implement',
    )
    expect(
      implementStarts.map(({ payload }) => ({
        round: payload.round,
        runner: payload.runner,
        model: payload.model,
      })),
    ).toEqual([
      { round: 1, runner: 'scripted', model: 'm-implement' },
      { round: 2, runner: 'scripted', model: 'm-implement' },
      { round: 2, runner: 'pi', model: 'kimi-alternate' },
      { round: 3, runner: 'scripted', model: 'm-implement' },
    ])
    expect(implementStarts[2]?.payload.substitution).toMatchObject({
      failed: {
        session: implementStarts[1]?.payload.session,
        error: 'continued primary unavailable',
      },
      selectedIndex: 1,
    })
    const completed = ofType(events, 'implement.completed')
    expect(completed.find((event) => event.payload.round === 2)?.actor).toMatchObject({
      kind: 'agent',
      session: implementStarts[2]?.payload.session,
    })
    const alternateEnded = ofType(events, 'session.ended').find(
      (event) => event.payload.session === implementStarts[2]?.payload.session,
    )
    expect(alternateEnded).toBeDefined()
    const alternateTranscript = (await h.store.listArtifacts(SLUG, 'transcript')).find(
      (artifact) => artifact.revision === completedSessionEnd(alternateEnded!).transcript.rev,
    )
    expect(alternateTranscript?.metadata).toMatchObject({
      phase: 'implement',
      round: 2,
      role: 'implement',
      runner: 'pi',
      model: 'kimi-alternate',
      session: implementStarts[2]?.payload.session,
    })
    expect(
      events.filter(
        (event) => event.type === 'phase.failed' && event.payload.phase === 'implement',
      ),
    ).toHaveLength(0)

    const journals = [...h.runner.sessions.values()]
    const firstPrimary = journals.find((journal) => journal.opts.model === 'm-implement')
    expect(firstPrimary?.turns).toHaveLength(2)
    expect(firstPrimary?.ended).toBe(true)
    const alternate = journals.find((journal) => journal.opts.model === 'kimi-alternate')
    expect(alternate?.turns).toHaveLength(1)
    expect(alternate?.ended).toBe(true)
    expect(
      journals.filter(
        (journal) => journal.opts.model === 'm-implement' && journal.turns.length === 1,
      ),
    ).toHaveLength(1)
  })

  test('availability exhaustion consumes one attempt and retries primary first', async () => {
    let primaryCalls = 0
    const h = await makeHarness({
      configToml: alternateConfig,
      handlers: (store) => {
        const table = happyHandlers(store)
        const happyPlan = table.plan!
        table.plan = (ctx) => {
          if (ctx.opts.model === 'm-plan') {
            primaryCalls += 1
            if (primaryCalls === 2) return happyPlan(ctx)
            return failedTurnResult('primary unavailable', false, '', 'availability')
          }
          return failedTurnResult('alternate unavailable', false, '', 'availability')
        }
        return table
      },
    })

    await h.br.run()
    const events = await h.store.getEvents(SLUG)
    const planStarts = ofType(events, 'session.started').filter(
      (event) => event.payload.phase === 'plan',
    )
    expect(planStarts.map((event) => event.payload.runner)).toEqual(['scripted', 'pi', 'scripted'])
    const failures = ofType(events, 'phase.failed').filter(
      (event) => event.payload.phase === 'plan',
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]?.payload).toMatchObject({
      attempt: 1,
      error: 'alternate unavailable',
      willRetry: true,
      providerAttempts: [
        { index: 0, error: 'primary unavailable' },
        { index: 1, error: 'alternate unavailable' },
      ],
    })
  })

  test('agent verify and finalize routes each use their logical role alternate chain', async () => {
    const routedConfig = `
[tickets]
source = "file"
readyState = "ready"
[commands]
[verify]
steps = ["e2e"]
[verify.e2e]
kind = "agent"
skill = "ab-verify-e2e"
[finalize]
steps = ["release-notes"]
[finalize.release-notes]
kind = "agent"
skill = "ab-release-notes"
[roles.default]
runtime = "scripted"
[roles.e2e]
runtime = "scripted"
model = "m-e2e"
alternates = [{ runtime = "pi", model = "kimi-e2e" }]
[roles.release-notes]
runtime = "scripted"
model = "m-finalize"
alternates = [{ runtime = "pi", model = "kimi-finalize" }]
`
    const h = await makeHarness({
      configToml: routedConfig,
      handlers: (store) => {
        const table = happyHandlers(store)
        const happyVerify = table['verify-e2e']!
        table['verify-e2e'] = (ctx) =>
          ctx.opts.model === 'm-e2e'
            ? failedTurnResult('verify provider exhausted', true, '', 'exhaustion')
            : happyVerify(ctx)
        table['release-notes'] = (ctx) =>
          ctx.opts.model === 'm-finalize'
            ? failedTurnResult('finalize provider overloaded', false, '', 'availability')
            : defaultTurnResult('release notes completed')
        return table
      },
    })

    await h.br.run()
    const events = await h.store.getEvents(SLUG)
    const verifyStarts = ofType(events, 'session.started').filter(
      (event) => event.payload.phase === 'verify:e2e',
    )
    expect(verifyStarts.map((event) => event.payload.runner)).toEqual(['scripted', 'pi'])
    expect(verifyStarts[1]?.payload).toMatchObject({
      role: 'e2e',
      substitution: { failed: { error: 'verify provider exhausted' }, selectedIndex: 1 },
    })
    expect(
      events.filter(
        (event) => event.type === 'phase.failed' && event.payload.phase === 'verify:e2e',
      ),
    ).toHaveLength(0)

    const finalizeStarts = ofType(events, 'session.started').filter(
      (event) => event.payload.phase === 'finalize' && event.payload.role === 'release-notes',
    )
    expect(finalizeStarts.map((event) => event.payload.runner)).toEqual(['scripted', 'pi'])
    expect(finalizeStarts[1]?.payload.substitution).toMatchObject({
      failed: { error: 'finalize provider overloaded' },
      selectedIndex: 1,
    })
    expect(
      ofType(events, 'finalize.step-completed').find(
        (event) => event.payload.step === 'release-notes',
      ),
    ).toMatchObject({
      actor: { kind: 'agent', session: finalizeStarts[1]?.payload.session },
      payload: { ok: true },
    })
  })

  test('a completed turn with no typed terminal does not engage alternates', async () => {
    const h = await makeHarness({
      configToml: alternateConfig,
      handlers: (store) => {
        const table = happyHandlers(store)
        table.plan = () => defaultTurnResult('agent omitted its terminal')
        return table
      },
    })

    expect((await h.br.run()).status).toBe('blocked')
    const events = await h.store.getEvents(SLUG)
    const starts = ofType(events, 'session.started').filter(
      (event) => event.payload.phase === 'plan',
    )
    expect(starts).toHaveLength(2)
    expect(starts.every((event) => event.payload.runner === 'scripted')).toBe(true)
    expect(
      events.filter((event) => event.type === 'phase.failed' && event.payload.phase === 'plan'),
    ).toHaveLength(2)
  })

  test('an exhausted chain writes one phase failure and escalation names every target', async () => {
    const h = await makeHarness({
      configToml: alternateConfig,
      handlers: (store) => {
        const table = happyHandlers(store)
        table.plan = (ctx) =>
          ctx.opts.model === 'm-plan'
            ? failedTurnResult('primary overloaded', false, '', 'availability')
            : failedTurnResult('alternate quota exhausted', true, '', 'exhaustion')
        return table
      },
    })

    expect((await h.br.run()).status).toBe('blocked')
    const events = await h.store.getEvents(SLUG)
    const failures = events.filter(
      (event) => event.type === 'phase.failed' && event.payload.phase === 'plan',
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]?.payload).toMatchObject({
      attempt: 1,
      error: 'alternate quota exhausted',
      willRetry: false,
      providerAttempts: [
        { index: 0, runner: 'scripted', error: 'primary overloaded' },
        { index: 1, runner: 'pi', error: 'alternate quota exhausted' },
      ],
    })
    const escalation = ofType(events, 'escalation.raised').find(
      (event) => event.payload.source === 'policy',
    )
    expect(escalation?.payload.question).toContain('primary overloaded')
    expect(escalation?.payload.question).toContain('alternate quota exhausted')
  })

  test('a missing primary CLI is skipped; the alternate completes with no phase.failed', async () => {
    const h = await makeHarness({
      configToml: alternateConfig,
      handlers: (store) => {
        const table = happyHandlers(store)
        const happyPlan = table.plan!
        table.plan = (ctx) =>
          ctx.opts.model === 'm-plan'
            ? failedTurnResult('executable "codex" was not found', true, '', 'configuration', true)
            : happyPlan(ctx)
        return table
      },
    })

    await h.br.run()
    const events = await h.store.getEvents(SLUG)
    expect(
      events.filter((event) => event.type === 'phase.failed' && event.payload.phase === 'plan'),
    ).toHaveLength(0)
    const planStarts = ofType(events, 'session.started').filter(
      (event) => event.payload.phase === 'plan',
    )
    expect(planStarts.map((event) => event.payload.runner)).toEqual(['scripted', 'pi'])
    const primary = [...h.runner.sessions.values()].find((j) => j.opts.model === 'm-plan')
    expect(primary?.ended).toBe(true)
  })

  test('every target missing emits one non-retried configuration failure naming the last', async () => {
    const h = await makeHarness({
      configToml: alternateConfig,
      handlers: (store) => {
        const table = happyHandlers(store)
        table.plan = (ctx) =>
          failedTurnResult(
            `executable "${ctx.opts.model === 'm-plan' ? 'codex' : 'pi'}" was not found`,
            true,
            '',
            'configuration',
            true,
          )
        return table
      },
    })

    expect((await h.br.run()).status).toBe('blocked')
    const events = await h.store.getEvents(SLUG)
    const failures = ofType(events, 'phase.failed').filter(
      (event) => event.payload.phase === 'plan',
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]?.payload).toMatchObject({
      error: 'executable "pi" was not found',
      willRetry: false,
      providerAttempts: [
        { index: 0, error: 'executable "codex" was not found', cause: 'configuration' },
        { index: 1, error: 'executable "pi" was not found', cause: 'configuration' },
      ],
    })
  })

  test('a non-missing configuration failure bypasses a declared alternate', async () => {
    const h = await makeHarness({
      configToml: alternateConfig,
      handlers: (store) => {
        const table = happyHandlers(store)
        table.plan = () => failedTurnResult('requires Pi 0.81 or newer', true, '', 'configuration')
        return table
      },
    })

    expect((await h.br.run()).status).toBe('blocked')
    const events = await h.store.getEvents(SLUG)
    expect(
      ofType(events, 'session.started').filter((event) => event.payload.phase === 'plan'),
    ).toHaveLength(1)
  })

  test('credential rejection bypasses a declared alternate and parks immediately', async () => {
    const h = await makeHarness({
      configToml: alternateConfig,
      handlers: (store) => {
        const table = happyHandlers(store)
        table.plan = () => failedTurnResult('invalid API key', true, '', 'credentials')
        return table
      },
    })

    expect((await h.br.run()).status).toBe('blocked')
    const events = await h.store.getEvents(SLUG)
    const planStarts = events.filter(
      (event) => event.type === 'session.started' && event.payload.phase === 'plan',
    )
    expect(planStarts).toHaveLength(1)
    const failed = events.find(
      (event) => event.type === 'phase.failed' && event.payload.phase === 'plan',
    )
    expect(failed?.payload).toMatchObject({
      error: 'invalid API key',
      willRetry: false,
      providerAttempts: [{ index: 0, error: 'invalid API key', cause: 'credentials' }],
    })
  })
  test('AUT-28 quota rejection fails attempt 1 verbatim, deposits the transcript, and escalates without attempt 2', async () => {
    let calls = 0
    const h = await makeHarness({
      handlers: (store) => {
        const table = happyHandlers(store)
        const happyPlan = table.plan!
        table.plan = async (ctx) => {
          calls += 1
          if (calls === 1) return failedTurnResult(KIMI_QUOTA, true)
          return happyPlan(ctx)
        }
        return table
      },
    })

    expect((await h.br.run()).status).toBe('blocked')
    let events = await h.store.getEvents(SLUG)
    const failed = ofType(events, 'phase.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.payload).toEqual({
      phase: 'plan',
      round: 1,
      attempt: 1,
      error: KIMI_QUOTA,
      willRetry: false,
    })
    expect(ofType(events, 'plan.started')).toHaveLength(1)
    expect(ofType(events, 'session.started')).toHaveLength(1)
    expect(ofType(events, 'session.ended')).toHaveLength(1)
    expect(calls).toBe(1)

    const ended = ofType(events, 'session.ended')[0]!
    const transcript = await h.store.getArtifact(
      SLUG,
      'transcript',
      completedSessionEnd(ended).transcript.rev,
    )
    const transcriptJson = JSON.parse(new TextDecoder().decode(transcript!.content))
    expect(transcriptJson.turns[0].result.failure.message).toBe(KIMI_QUOTA)
    const escalation = ofType(events, 'escalation.raised')[0]!
    expect(escalation.payload.source).toBe('policy')
    expect(escalation.payload.policyCause).toBe('non-retryable-phase-failure')
    expect(escalation.payload.question).toContain('non-retryable')
    expect(escalation.payload.question).toContain(KIMI_QUOTA)

    // A human answer deliberately re-arms both the count and non-retryable
    // disposition, allowing corrected provider configuration to be tried.
    await h.store.append(SLUG, {
      actor: humanActor('operator'),
      type: 'escalation.answered',
      payload: { id: escalation.payload.id, answer: 'retry', resolution: 'retry' },
    })
    expect((await h.br.run()).status).toBe('running')
    events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'plan.started')).toHaveLength(2)
    expect(calls).toBe(2)
  })

  test('a non-permanent provider failure takes the existing retry and can recover', async () => {
    let calls = 0
    const h = await makeHarness({
      handlers: (store) => {
        const table = happyHandlers(store)
        const happyPlan = table.plan!
        table.plan = async (ctx) => {
          calls += 1
          if (calls === 1) {
            return failedTurnResult('503 provider overloaded', false)
          }
          return happyPlan(ctx)
        }
        return table
      },
    })

    expect((await h.br.run()).status).toBe('running')
    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'phase.failed')[0]!.payload).toMatchObject({
      attempt: 1,
      error: '503 provider overloaded',
      willRetry: true,
    })
    expect(ofType(events, 'plan.started')).toHaveLength(2)
    expect(calls).toBe(2)
  })
})

// ── Phase-session wall-clock budget ──────────────────────────────────────────

describe('phase-session budget', () => {
  test('the kernel stops awaiting a runtime that ignores cancellation', async () => {
    const timers = new ManualSessionBudgetScheduler()
    const signals: AbortSignal[] = []
    let starts = 0
    const stuck: AgentRunner = {
      name: 'stuck',
      start: (opts) => {
        starts += 1
        if (opts.signal !== undefined) signals.push(opts.signal)
        return new Promise<{ session: AgentSessionHandle; result: AgentTurnResult }>(() => {})
      },
      continue: () => new Promise<AgentTurnResult>(() => {}),
      end: async () => ({
        content: '',
        metadata: {
          runner: 'stuck',
          usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
        },
      }),
    }
    const h = await makeHarness({
      runtimeRunner: stuck,
      runnerOpts: { maxPhaseAttempts: 2, scheduleSessionBudget: timers.schedule },
    })

    const run = h.br.run()
    await timers.expireNext()
    await timers.expireNext()
    expect((await run).status).toBe('blocked')
    expect(starts).toBe(2)
    expect(signals).toHaveLength(2)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    const failures = ofType(await h.store.getEvents(SLUG), 'phase.failed')
    expect(failures.map((event) => event.payload.error)).toEqual([
      'phase session budget expired after 3600 seconds',
      'phase session budget expired after 3600 seconds',
    ])
  })

  test('operator abort keeps the deadline armed for an abort-ignoring start and skips alternates', async () => {
    const timers = new ManualSessionBudgetScheduler()
    let observedSignal: AbortSignal | undefined
    let starts = 0
    const stuck: AgentRunner = {
      name: 'abort-ignoring-start',
      start: (opts) => {
        starts += 1
        observedSignal = opts.signal
        return new Promise<{ session: AgentSessionHandle; result: AgentTurnResult }>(() => {})
      },
      continue: () => new Promise<AgentTurnResult>(() => {}),
      end: async () => ({
        content: '',
        metadata: {
          runner: 'abort-ignoring-start',
          usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
        },
      }),
    }
    const configToml = CONFIG_TOML.replace(
      'plan = { runtime = "scripted", model = "m-plan" }',
      'default = { runtime = "scripted" }\n' +
        'plan = { runtime = "scripted", model = "m-plan", ' +
        'alternates = [{ runtime = "pi", model = "kimi-k3" }] }',
    )
    const h = await makeHarness({
      configToml,
      runtimeRunner: stuck,
      runnerOpts: { scheduleSessionBudget: timers.schedule },
    })

    const running = h.br.run()
    for (let spin = 0; spin < 100 && observedSignal === undefined; spin += 1) {
      await Bun.sleep(1)
    }
    if (observedSignal === undefined) throw new Error('plan start did not receive a signal')
    await h.store.append(SLUG, {
      actor: humanActor('aron'),
      type: 'build.abort-requested',
      payload: { reason: 'stop the stuck primary' },
    })
    await Promise.race([
      (async () => {
        while (!observedSignal.aborted) await Bun.sleep(1)
      })(),
      Bun.sleep(1000).then(() => {
        throw new Error('operator abort did not cancel the start promptly')
      }),
    ])

    expect(timers.activeCount).toBe(1)
    await timers.expireNext()
    expect((await running).status).toBe('aborted')

    const events = await h.store.getEvents(SLUG)
    expect(starts).toBe(1)
    expect(
      ofType(events, 'session.started')
        .filter((event) => event.payload.phase === 'plan')
        .map((event) => event.payload.runner),
    ).toEqual(['scripted'])
    expect(ofType(events, 'phase.failed')).toEqual([])
    expect(ofType(events, 'build.aborted')).toHaveLength(1)
    expect((await h.store.getBuild(SLUG))?.lease?.holder).toBe('runner-1')
  })

  test('operator-first deadline release bounds a continued producer and preserves its terminal', async () => {
    const timers = new ManualSessionBudgetScheduler()
    let store: BuildStore | undefined
    let continuedSignal: AbortSignal | undefined
    let continues = 0
    const ended: string[] = []
    const continuing: AgentRunner = {
      name: 'abort-ignoring-continue',
      start: async (opts) => {
        if (store === undefined) throw new Error('test store was not initialized')
        const session = opts.env.AB_SESSION
        if (session === undefined) throw new Error('session env was not supplied')
        if (opts.skill === 'ab-plan') {
          await store.appendWithArtifacts(
            SLUG,
            [{ kind: 'plan', content: 'plan round 1' }],
            (deposited) => ({
              actor: agentActor('plan', session),
              type: 'plan.completed',
              payload: { round: 1, artifact: refOf(deposited) },
            }),
          )
          return {
            session: { id: 'producer-handle', runner: 'abort-ignoring-continue' },
            result: defaultTurnResult('planned'),
          }
        }
        if (opts.skill === 'ab-plan-review') {
          await store.appendWithArtifacts(
            SLUG,
            [{ kind: 'plan-review', content: 'revise plan' }],
            (deposited) => ({
              actor: agentActor('plan-review', session),
              type: 'plan-review.verdict',
              payload: {
                round: 1,
                verdict: 'revise',
                findings: [FINDING],
                artifact: refOf(deposited),
              },
            }),
          )
          return {
            session: { id: 'review-handle', runner: 'abort-ignoring-continue' },
            result: defaultTurnResult('revision requested'),
          }
        }
        throw new Error(`unexpected skill ${opts.skill}`)
      },
      continue: (_session, _message, opts) => {
        continues += 1
        continuedSignal = opts?.signal
        return new Promise<AgentTurnResult>(() => {})
      },
      end: async (session) => {
        ended.push(session.id)
        return {
          content: '',
          metadata: {
            runner: 'abort-ignoring-continue',
            usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
          },
        }
      },
    }
    const h = await makeHarness({
      handlers: (availableStore) => {
        store = availableStore
        return {}
      },
      runtimeRunner: continuing,
      runnerOpts: { scheduleSessionBudget: timers.schedule },
    })

    const running = h.br.run()
    for (let spin = 0; spin < 100 && continuedSignal === undefined; spin += 1) {
      await Bun.sleep(1)
    }
    if (continuedSignal === undefined) throw new Error('plan continuation did not start')
    const currentPlanSession = ofType(await h.store.getEvents(SLUG), 'session.started')
      .filter((event) => event.payload.phase === 'plan')
      .at(-1)
    if (currentPlanSession === undefined) throw new Error('continued plan bracket was not recorded')
    await h.store.appendWithArtifacts(
      SLUG,
      [{ kind: 'plan', content: 'plan round 2 merged before abort observation' }],
      (deposited) => ({
        actor: agentActor('plan', currentPlanSession.payload.session),
        type: 'plan.completed',
        payload: { round: 2, artifact: refOf(deposited) },
      }),
    )
    await h.store.append(SLUG, {
      actor: humanActor('aron'),
      type: 'build.abort-requested',
      payload: { reason: 'stop the continued producer' },
    })
    await Promise.race([
      (async () => {
        while (!continuedSignal.aborted) await Bun.sleep(1)
      })(),
      Bun.sleep(1000).then(() => {
        throw new Error('operator abort did not cancel the continuation promptly')
      }),
    ])

    expect(timers.activeCount).toBe(1)
    await timers.expireNext()
    expect((await running).status).toBe('aborted')

    const events = await h.store.getEvents(SLUG)
    expect(continues).toBe(1)
    expect(ofType(events, 'plan.completed').map((event) => event.payload.round)).toEqual([1, 2])
    expect(ofType(events, 'phase.failed')).toEqual([])
    expect(ofType(events, 'build.aborted')).toHaveLength(1)
    expect(ended).toContain('producer-handle')
    expect((await h.store.getBuild(SLUG))?.lease?.holder).toBe('runner-1')
  })

  test('a typed terminal deposited before expiry remains authoritative', async () => {
    const timers = new ManualSessionBudgetScheduler()
    const stuck: AgentRunner = {
      name: 'terminal-then-stuck',
      start: () => new Promise<{ session: AgentSessionHandle; result: AgentTurnResult }>(() => {}),
      continue: () => new Promise<AgentTurnResult>(() => {}),
      end: async () => ({
        content: '',
        metadata: {
          runner: 'terminal-then-stuck',
          usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
        },
      }),
    }
    const h = await makeHarness({
      runtimeRunner: stuck,
      runnerOpts: { scheduleSessionBudget: timers.schedule },
    })
    await h.br.attach()

    const step = h.br.step()
    let started: EventEnvelope<'session.started'> | undefined
    for (let spin = 0; spin < 100 && started === undefined; spin += 1) {
      started = ofType(await h.store.getEvents(SLUG), 'session.started').at(-1)
      if (started === undefined) await new Promise((resolve) => setTimeout(resolve, 0))
    }
    if (started === undefined) throw new Error('plan session did not start')
    await h.store.appendWithArtifacts(
      SLUG,
      [{ kind: 'plan', content: 'terminal merged while runtime stayed busy' }],
      (deposited) => ({
        actor: agentActor('plan', started.payload.session),
        type: 'plan.completed',
        payload: { round: 1, artifact: refOf(deposited) },
      }),
    )
    await timers.expireNext()
    await step

    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'plan.completed')).toHaveLength(1)
    expect(ofType(events, 'phase.failed')).toEqual([])
  })

  test('a stuck end call cannot extend an expired phase', async () => {
    const timers = new ManualSessionBudgetScheduler()
    let ends = 0
    const stuckEnd: AgentRunner = {
      name: 'stuck-end',
      start: (opts) =>
        new Promise((resolve) => {
          opts.signal?.addEventListener(
            'abort',
            () =>
              resolve({
                session: { id: 'stuck-end-1', runner: 'stuck-end' },
                result: failedTurnResult('aborted', false),
              }),
            { once: true },
          )
        }),
      continue: () => new Promise<AgentTurnResult>(() => {}),
      end: () => {
        ends += 1
        return new Promise(() => {})
      },
    }
    const h = await makeHarness({
      runtimeRunner: stuckEnd,
      runnerOpts: { maxPhaseAttempts: 1, scheduleSessionBudget: timers.schedule },
    })

    const run = h.br.run()
    await timers.expireNext()
    expect((await run).status).toBe('blocked')
    expect(ends).toBe(1)
    expect(ofType(await h.store.getEvents(SLUG), 'phase.failed')[0]?.payload.error).toBe(
      'phase session budget expired after 3600 seconds',
    )
  })

  test('a hung role expires, retries without alternates, escalates, and an answer re-arms it', async () => {
    const timers = new ManualSessionBudgetScheduler()
    let attempts = 0
    const configToml = `${CONFIG_TOML.replace(
      'plan = { runtime = "scripted", model = "m-plan" }',
      'default = { runtime = "scripted" }\n' +
        'plan = { runtime = "scripted", model = "m-plan", sessionBudgetSeconds = 7, ' +
        'alternates = [{ runtime = "pi", model = "kimi-k3" }] }',
    )}\n[policy]\nsessionBudgetSeconds = 2\n`
    const h = await makeHarness({
      configToml,
      runnerOpts: { maxPhaseAttempts: 2, scheduleSessionBudget: timers.schedule },
      handlers: (store) => {
        const table = happyHandlers(store)
        const healthyPlan = table.plan!
        table.plan = async (ctx) => {
          attempts += 1
          if (attempts <= 2) return new Promise<AgentTurnResult>(() => {})
          return healthyPlan(ctx)
        }
        return table
      },
    })

    const blocked = h.br.run()
    await timers.expireNext()
    await timers.expireNext()
    expect((await blocked).status).toBe('blocked')

    let events = await h.store.getEvents(SLUG)
    const failures = ofType(events, 'phase.failed')
    expect(failures.map((event) => event.payload)).toEqual([
      {
        phase: 'plan',
        round: 1,
        attempt: 1,
        error: 'phase session budget expired after 7 seconds',
        willRetry: true,
      },
      {
        phase: 'plan',
        round: 1,
        attempt: 2,
        error: 'phase session budget expired after 7 seconds',
        willRetry: false,
      },
    ])
    const planStarts = ofType(events, 'session.started').filter(
      (event) => event.payload.phase === 'plan',
    )
    expect(planStarts.map((event) => event.payload.runner)).toEqual(['scripted', 'scripted'])
    expect(timers.delays.slice(0, 2)).toEqual([7000, 7000])
    expect([...h.runner.sessions.values()].every((journal) => journal.ended)).toBe(true)

    const escalation = ofType(events, 'escalation.raised')[0]!
    expect(escalation.payload.question).toContain('phase session budget expired after 7 seconds')
    expect(reduceBuild(events).status).toBe('blocked')
    await h.store.append(SLUG, {
      actor: humanActor('operator'),
      type: 'escalation.answered',
      payload: {
        id: escalation.payload.id,
        answer: 'the provider is healthy again',
        resolution: 'retry',
      },
    })

    expect((await h.br.run()).status).toBe('running')
    events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'plan.completed')).toHaveLength(1)
    expect(
      ofType(events, 'session.started').filter((event) => event.payload.phase === 'plan'),
    ).toHaveLength(3)
    expect(attempts).toBe(3)
    expect(timers.activeCount).toBe(0)
  })

  test('agent-verify expiry uses phase retry failure and releases its handle', async () => {
    const timers = new ManualSessionBudgetScheduler()
    const h = await makeHarness({
      configToml: `${CONFIG_TOML}\n[policy]\nsessionBudgetSeconds = 11\n`,
      runnerOpts: { scheduleSessionBudget: timers.schedule },
      handlers: (store) => ({
        ...happyHandlers(store),
        'verify-e2e': () => new Promise<AgentTurnResult>(() => {}),
      }),
    })
    await seedPlanApproved(h.store)
    await seedCodeApproved(h.store)
    for (const step of ['types', 'unit']) {
      await h.store.append(SLUG, {
        actor: KERNEL,
        type: 'verify.completed',
        payload: { step, attempt: 1, pass: true },
      })
    }
    await h.br.attach()

    const step = h.br.step()
    await timers.expireNext()
    await step
    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'phase.failed').at(-1)?.payload).toMatchObject({
      phase: 'verify:e2e',
      round: 1,
      error: 'phase session budget expired after 11 seconds',
      willRetry: true,
    })
    expect([...h.runner.sessions.values()].at(-1)?.ended).toBe(true)
  })

  test('finalize post-step expiry is observed but cannot turn the build red', async () => {
    const timers = new ManualSessionBudgetScheduler()
    const h = await makeHarness({
      configToml: `${CONFIG_TOML}\n[policy]\nsessionBudgetSeconds = 13\n`,
      runnerOpts: { scheduleSessionBudget: timers.schedule },
      handlers: (store) => ({
        ...happyHandlers(store),
        'release-notes': () => new Promise<AgentTurnResult>(() => {}),
      }),
    })
    await seedReadyForFinalizeStep(h.store)
    h.forge.setPrState(7, { state: 'open', mergeable: true })
    await h.br.attach()

    const step = h.br.step()
    await timers.expireNext()
    await step
    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'finalize.step-completed').at(-1)?.payload).toEqual({
      step: 'release-notes',
      ok: false,
      note: 'phase session budget expired after 13 seconds',
    })
    expect(ofType(events, 'observation.recorded').at(-1)?.payload.summary).toContain(
      'phase session budget expired after 13 seconds',
    )
    expect(ofType(events, 'phase.failed')).toEqual([])
    expect([...h.runner.sessions.values()].at(-1)?.ended).toBe(true)
  })
})

describe('remote publication terminal boundary', () => {
  test.each([false, true])(
    'a producer publication parks with stale resume=%s',
    async (staleResume) => {
      const h = await makeHarness({
        handlers: (store) => {
          const handlers = happyHandlers(store)
          handlers.implement = async (ctx: ScriptContext) => {
            await store.appendWithArtifacts(
              SLUG,
              [{ kind: 'implement-notes', content: 'remote implementation complete' }],
              (deposited) => ({
                actor: agentActor('implement', sessionOf(ctx)),
                type: 'publication.requested',
                payload: {
                  operation: 'implement',
                  branch: BRANCH,
                  sha: 'a'.repeat(40),
                  round: 1,
                  base: 'b'.repeat(40),
                  artifact: refOf(deposited),
                },
              }),
            )
            return defaultTurnResult('publication requested')
          }
          return handlers
        },
      })

      if (staleResume) {
        await h.store.append(SLUG, {
          actor: humanActor('operator'),
          type: 'build.resume-requested',
          payload: {},
        })
      }
      await h.br.run()
      // Reattaching with the same unsettled publication must also park.
      await h.br.run()

      const events = await h.store.getEvents(SLUG)
      expect(ofType(events, 'publication.requested')).toHaveLength(1)
      expect(ofType(events, 'phase.failed')).toEqual([])
      expect(ofType(events, 'session.ended')).toHaveLength(3)
    },
  )

  test('replacement ignores a request abandoned with the dead workspace and reruns its phase', async () => {
    let implementations = 0
    const replacementSha = 'c'.repeat(40)
    const h = await makeHarness({
      handlers: (store) => {
        const handlers = happyHandlers(store)
        handlers.implement = async (ctx: ScriptContext) => {
          implementations += 1
          await store.appendWithArtifacts(
            SLUG,
            [{ kind: 'implement-notes', content: 'replacement implementation' }],
            (deposited) => ({
              actor: agentActor('implement', sessionOf(ctx)),
              type: 'publication.requested',
              payload: {
                operation: 'implement',
                branch: BRANCH,
                sha: replacementSha,
                round: 1,
                base: 'b'.repeat(40),
                artifact: refOf(deposited),
              },
            }),
          )
          return defaultTurnResult('replacement publication requested')
        }
        return handlers
      },
    })
    await seedPlanApproved(h.store)
    const originalWorkspace = (await h.store.getEvents(SLUG)).findLast(
      (event) => event.type === 'workspace.provisioned',
    )
    if (originalWorkspace?.type !== 'workspace.provisioned') throw new Error('missing workspace')
    const stale = await h.store.putArtifact(SLUG, {
      kind: 'implement-notes',
      content: 'lost with sandbox g0',
    })
    await h.store.append(SLUG, {
      actor: agentActor('implement', 'lost-session'),
      type: 'publication.requested',
      payload: {
        operation: 'implement',
        branch: BRANCH,
        sha: 'a'.repeat(40),
        round: 1,
        base: 'b'.repeat(40),
        artifact: { kind: stale.kind, rev: stale.revision },
      },
    })
    await h.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'workspace.released',
      payload: { ref: originalWorkspace.payload.ref, reason: 'replacement' },
    })
    await h.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'workspace.provisioned',
      payload: {
        provider: 'vercel-sandbox',
        ref: 'sandbox-g1',
        remote: true,
        branch: BRANCH,
        base: { source: 'existing', sha: 'b'.repeat(40) },
      },
    })

    await h.br.run()

    const requests = ofType(await h.store.getEvents(SLUG), 'publication.requested')
    expect(implementations).toBe(1)
    expect(requests).toHaveLength(2)
    expect(requests.at(-1)?.payload.sha).toBe(replacementSha)
  })
})

// ── No terminal (D5, §8.4) ───────────────────────────────────────────────────

describe('no-terminal retry policy (D5)', () => {
  for (const priorFailures of [0, 1]) {
    test(`mid-session decisive facts defer a refused terminal without consuming attempt ${priorFailures + 1}`, async () => {
      const h = await makeHarness({
        handlers: (store) => ({
          plan: async (ctx) => {
            await store.putArtifact(SLUG, { kind: 'plan', content: '# Finished plan' })
            const seq = (await store.getEvents(SLUG)).at(-1)!.seq + 1
            seedNewerMemoryFact(store as MemoryBuildStore, newerFact(seq, 'decisive', SLUG))
            await expect(
              done({
                store,
                env: {
                  store: 'local',
                  build: SLUG,
                  phase: 'plan',
                  round: 1,
                  session: sessionOf(ctx),
                },
                workspacePath: ctx.opts.workspacePath,
                forge: new FakeForge(),
                ids: sequentialIds(),
                exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
              }),
            ).rejects.toThrow('Kernel decisions deferred')
            return defaultTurnResult('terminal deferred')
          },
        }),
      })
      if (priorFailures)
        await h.store.append(SLUG, {
          actor: KERNEL,
          type: 'phase.failed',
          payload: {
            phase: 'plan',
            round: 1,
            attempt: 1,
            error: 'previous failure',
            willRetry: true,
          },
        })
      await h.br.attach()
      expect(await h.br.step()).toEqual({ kind: 'wait', reason: 'mixed-version' })
      expect(await h.br.step()).toEqual({ kind: 'wait', reason: 'mixed-version' })
      const events = await h.store.getEvents(SLUG)
      expect(ofType(events, 'phase.failed')).toHaveLength(priorFailures)
      expect(ofType(events, 'escalation.raised')).toHaveLength(0)
      expect(ofType(events, 'build.compatibility-deferred')).toHaveLength(1)
      expect(await h.store.listArtifacts(SLUG, 'plan')).toHaveLength(1)
    })
  }

  test('a silent session fails the phase; the transcript and session.ended still merge', async () => {
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
    const transcript = await h.store.getArtifact(
      SLUG,
      'transcript',
      completedSessionEnd(ended).transcript.rev,
    )
    expect(transcript).not.toBeNull()
    expect(transcript!.meta.metadata.phase).toBe('plan')
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
      'runner.runtime-recorded',
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
    expect(escalation.payload.policyCause).toBe('phase-attempt-limit')
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
  test('an escalate verdict without its escalation.raised is repaired by the kernel; run exits blocked', async () => {
    const h = await makeHarness({
      handlers: (store) => ({
        ...happyHandlers(store),
        'code-review': async (ctx) => {
          // Simulates the CLI dying between the verdict and its escalation.
          await reviewVerdict(
            store,
            ctx,
            'code-review',
            'escalate',
            [],
            'auth approach conflicts with the spec',
          )
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
  test('resolves a reloaded command at the next verify decision boundary', async () => {
    const current = parseConfig(
      CONFIG_TOML.replace(
        'typecheck = "bun tsc --noEmit"',
        'typecheck = "bun tsc --noEmit --pretty false"',
      ),
    )
    current.roles.default = { runtime: 'scripted' }
    const h = await makeHarness({ getConfig: () => current })
    await seedPlanApproved(h.store)
    await seedCodeApproved(h.store)

    expect(await h.br.step()).toMatchObject({
      kind: 'run-check',
      step: 'types',
      command: 'bun tsc --noEmit --pretty false',
    })
    expect(h.execCalls.at(-1)?.cmd).toEqual(['sh', '-c', 'bun tsc --noEmit --pretty false'])
  })

  test('a failing check deposits the exec output as the verify report (D6) and completes outcome:fail', async () => {
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
      outcome: 'fail',
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

// ── Approved-plan verify selection ───────────────────────────────────────────

describe('approved-plan verify selection', () => {
  const conditionalOptional = `
[tickets]
source = "file"
readyState = "ready"
[commands]
dashboard = "bun test dashboard"
[verify]
steps = ["dashboard"]
[verify.dashboard]
kind = "check"
command = "dashboard"
paths = ["src/cli/dashboard/**"]
`

  test('an omitted step records a kernel skip without diff, command, or session work', async () => {
    const h = await makeHarness({
      configToml: conditionalOptional,
      verifyDiffs: [{ error: 'selection must precede path inspection' }],
    })
    await seedPlanApproved(h.store, [])
    await seedCodeApproved(h.store)

    expect(await h.br.step()).toEqual({
      kind: 'skip-verify',
      step: 'dashboard',
      attempt: 1,
      reason:
        'excluded by approved plan selection (plan@0): verify step "dashboard" was not selected',
    })
    expect(h.execCalls).toEqual([])
    expect(h.ops).toEqual([])
    expect(h.runner.sessions.size).toBe(0)
    const events = await h.store.getEvents(SLUG)
    expect(events.slice(-2).map((event) => event.type)).toEqual([
      'verify.started',
      'verify.completed',
    ])
    expect(ofType(events, 'verify.completed').at(-1)?.payload).toEqual({
      step: 'dashboard',
      attempt: 1,
      outcome: 'skipped',
      reason:
        'excluded by approved plan selection (plan@0): verify step "dashboard" was not selected',
    })
  })

  test('an always = true gate executes defensively despite a malformed direct selection fact', async () => {
    const h = await makeHarness({
      configToml: conditionalOptional.replace(
        'paths = ["src/cli/dashboard/**"]',
        'paths = ["src/cli/dashboard/**"]\nalways = true',
      ),
      verifyDiffs: [{ error: 'mandatory gate must not inspect paths' }],
    })
    await seedPlanApproved(h.store, [])
    await seedCodeApproved(h.store)

    expect(await h.br.step()).toMatchObject({ kind: 'run-check', step: 'dashboard' })
    expect(h.execCalls).toEqual([{ cmd: ['sh', '-c', 'bun test dashboard'], cwd: h.workspacePath }])
    expect(
      normalizeVerifyCompletion(
        ofType(await h.store.getEvents(SLUG), 'verify.completed').at(-1)!.payload,
      ).outcome,
    ).toBe('pass')
  })
})

// ── Conditional verify applicability (§16.1) ─────────────────────────────────

describe('conditional verify applicability', () => {
  const conditionalCheck = `
[tickets]
source = "file"
readyState = "ready"
[commands]
dashboard = "bun test dashboard"
[verify]
steps = ["dashboard"]
[verify.dashboard]
kind = "check"
command = "dashboard"
paths = ["src/cli/dashboard/**"]
`

  async function seedApproved(store: BuildStore): Promise<void> {
    await seedPlanApproved(store)
    await seedCodeApproved(store)
  }

  test('a matching path runs the wrapped check after the exact NUL Git diff', async () => {
    const h = await makeHarness({
      configToml: conditionalCheck,
      verifyDiffs: [{ paths: ['README.md', 'src/cli/dashboard/model.ts'] }],
    })
    await seedApproved(h.store)

    expect(await h.br.step()).toEqual({
      kind: 'evaluate-verify',
      step: 'dashboard',
      attempt: 1,
      paths: ['src/cli/dashboard/**'],
      action: {
        kind: 'run-check',
        step: 'dashboard',
        command: 'bun test dashboard',
        attempt: 1,
      },
    })
    expect(h.execCalls).toEqual([
      {
        cmd: ['git', 'diff', '--no-renames', '--name-only', '-z', '0'.repeat(40), 'HEAD', '--'],
        cwd: h.workspacePath,
      },
      { cmd: ['sh', '-c', 'bun test dashboard'], cwd: h.workspacePath },
    ])
    expect(ofType(await h.store.getEvents(SLUG), 'verify.completed').at(-1)?.payload).toEqual({
      step: 'dashboard',
      attempt: 1,
      outcome: 'pass',
    })
  })

  test('a nonmatching check records a kernel skip and launches no command', async () => {
    const h = await makeHarness({
      configToml: conditionalCheck,
      verifyDiffs: [{ paths: ['README.md', 'docs/guide.md'] }],
    })
    await seedApproved(h.store)
    await h.br.step()

    expect(h.execCalls).toHaveLength(1)
    expect(h.execCalls[0]?.cmd.slice(0, 2)).toEqual(['git', 'diff'])
    const events = await h.store.getEvents(SLUG)
    expect(events.slice(-2).map((event) => event.type)).toEqual([
      'verify.started',
      'verify.completed',
    ])
    expect(ofType(events, 'verify.completed').at(-1)?.actor).toEqual(KERNEL)
    expect(ofType(events, 'verify.completed').at(-1)?.payload).toEqual({
      step: 'dashboard',
      attempt: 1,
      outcome: 'skipped',
      reason:
        'excluded by [verify.dashboard].paths: no changed path matched ["src/cli/dashboard/**"]',
    })
  })

  test('a generated skip advances to the next verifier at the same attempt', async () => {
    const h = await makeHarness({
      configToml: `
[tickets]
source = "file"
readyState = "ready"
[commands]
dashboard = "bun test dashboard"
unit = "bun test"
[verify]
steps = ["dashboard", "unit"]
[verify.dashboard]
kind = "check"
command = "dashboard"
paths = ["src/cli/dashboard/**"]
[verify.unit]
kind = "check"
command = "unit"
`,
      verifyDiffs: [{ paths: ['README.md'] }],
    })
    await seedApproved(h.store)
    await h.br.step()
    expect(await h.br.step()).toEqual({
      kind: 'run-check',
      step: 'unit',
      command: 'bun test',
      attempt: 1,
    })
    expect(
      ofType(await h.store.getEvents(SLUG), 'verify.completed').map((event) =>
        normalizeVerifyCompletion(event.payload),
      ),
    ).toEqual([
      {
        step: 'dashboard',
        attempt: 1,
        outcome: 'skipped',
        reason:
          'excluded by [verify.dashboard].paths: no changed path matched ["src/cli/dashboard/**"]',
      },
      { step: 'unit', attempt: 1, outcome: 'pass' },
    ])
  })

  test('nonmatching agent steps start no session', async () => {
    const h = await makeHarness({
      configToml: `
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = ["e2e"]
[verify.e2e]
kind = "agent"
skill = "ab-verify-e2e"
paths = ["web/**"]
`,
      verifyDiffs: [{ paths: ['src/auth.ts'] }],
    })
    await seedApproved(h.store)
    expect((await h.br.step()).kind).toBe('evaluate-verify')
    expect(h.ops).toEqual([])
    expect(h.runner.sessions.size).toBe(0)
    expect(ofType(await h.store.getEvents(SLUG), 'session.started')).toEqual([])
  })

  test('matching agent steps persist routed guidance through the wrapped action', async () => {
    const h = await makeHarness({
      configToml: `
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = ["e2e"]
[verify.e2e]
kind = "agent"
skill = "ab-verify-e2e"
paths = ["web/**"]
`,
      verifyDiffs: [{ paths: ['web/routes/login.ts'] }],
    })
    await seedApproved(h.store)
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'verify.started',
      payload: { step: 'e2e', attempt: 1 },
    })
    await h.store.append(SLUG, {
      actor: agentActor('e2e', 's_old'),
      type: 'escalation.raised',
      payload: {
        id: 'esc_verify',
        phase: 'verify:e2e',
        source: 'agent',
        question: 'Which account should the verifier use?',
      },
    })
    await h.store.append(SLUG, {
      actor: humanActor('operator'),
      type: 'escalation.answered',
      payload: {
        id: 'esc_verify',
        answer: 'Use the seeded admin account.',
        resolution: 'guidance',
      },
    })

    const feedback = {
      guidance: { escalation: 'esc_verify', answer: 'Use the seeded admin account.' },
    }
    expect(await h.br.step()).toEqual({
      kind: 'evaluate-verify',
      step: 'e2e',
      attempt: 1,
      paths: ['web/**'],
      action: {
        kind: 'run-agent-verify',
        step: 'e2e',
        skill: 'ab-verify-e2e',
        attempt: 1,
        feedback,
      },
    })
    expect(ofType(await h.store.getEvents(SLUG), 'verify.started').at(-1)?.payload).toEqual({
      step: 'e2e',
      attempt: 1,
      feedback,
    })
  })

  test('matching agent steps retain normal session execution', async () => {
    const h = await makeHarness({
      configToml: `
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = ["e2e"]
[verify.e2e]
kind = "agent"
skill = "ab-verify-e2e"
paths = ["web/**"]
`,
      verifyDiffs: [{ paths: ['web/routes/login.ts'] }],
    })
    await seedApproved(h.store)
    await h.br.step()
    expect(h.ops).toEqual(['session:ab-verify-e2e'])
    expect(
      normalizeVerifyCompletion(
        ofType(await h.store.getEvents(SLUG), 'verify.completed').at(-1)!.payload,
      ).outcome,
    ).toBe('pass')
  })

  test('always = true bypasses path inspection and runs the mandatory gate', async () => {
    const h = await makeHarness({
      configToml: conditionalCheck.replace(
        'paths = ["src/cli/dashboard/**"]',
        'paths = ["src/cli/dashboard/**"]\nalways = true',
      ),
      verifyDiffs: [{ error: 'must not inspect paths' }],
    })
    await seedApproved(h.store)
    expect((await h.br.step()).kind).toBe('run-check')
    expect(h.execCalls).toEqual([{ cmd: ['sh', '-c', 'bun test dashboard'], cwd: h.workspacePath }])
  })

  test('Git diff failures fail closed without a skip outcome', async () => {
    const h = await makeHarness({
      configToml: conditionalCheck,
      verifyDiffs: [{ error: 'fatal: bad object fake-base-sha' }],
    })
    await seedApproved(h.store)
    const starts = ofType(await h.store.getEvents(SLUG), 'verify.started').length
    await expect(h.br.step()).rejects.toThrow('fatal: bad object fake-base-sha')
    expect(ofType(await h.store.getEvents(SLUG), 'verify.started')).toHaveLength(starts)
    expect(ofType(await h.store.getEvents(SLUG), 'verify.completed')).toEqual([])
  })

  test('NUL parsing preserves whitespace/newlines and rejects malformed output', () => {
    expect(parseNulChangedPaths('old name.ts\0new\nname.ts\0')).toEqual([
      'old name.ts',
      'new\nname.ts',
    ])
    expect(parseNulChangedPaths('')).toEqual([])
    expect(() => parseNulChangedPaths('src/file.ts\n')).toThrow('non-NUL-terminated')
    expect(() => parseNulChangedPaths('src/file.ts\0\0')).toThrow('empty path entry')
  })

  test('the diff base advances only after a completed reconcile', async () => {
    const h = await makeHarness()
    expect(selectVerifyDiffBase(await h.store.getEvents(SLUG))).toBe('0'.repeat(40))

    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'reconcile.started',
      payload: { attempt: 1, baseSha: 'base-after-first' },
    })
    await h.store.append(SLUG, {
      actor: agentActor('reconcile', 's_reconcile_1'),
      type: 'reconcile.completed',
      payload: {
        mergeCommit: 'merge-1',
        artifact: { kind: 'reconcile-notes', rev: 0 },
      },
    })
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'reconcile.started',
      payload: { attempt: 2, baseSha: 'dangling-base' },
    })
    expect(selectVerifyDiffBase(await h.store.getEvents(SLUG))).toBe('base-after-first')

    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'reconcile.started',
      payload: { attempt: 2, baseSha: 'refreshed-base' },
    })
    await h.store.append(SLUG, {
      actor: agentActor('reconcile', 's_reconcile_2'),
      type: 'reconcile.completed',
      payload: {
        mergeCommit: 'merge-2',
        artifact: { kind: 'reconcile-notes', rev: 1 },
      },
    })
    expect(selectVerifyDiffBase(await h.store.getEvents(SLUG))).toBe('refreshed-base')
  })
})

// ── Agent verification ───────────────────────────────────────────────────────

describe('agent verification', () => {
  test('a thrown session records phase.failed', async () => {
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

    expect(h.ops).toEqual(['session:ab-verify-e2e'])
    const events = await h.store.getEvents(SLUG)
    // The thrown start never returned a handle, so no session.ended arrives
    // yet. It stays open until a later attachment explicitly reclaims it, and
    // this runner records the phase failure.
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

  test('a permanent agent-verify provider failure uses the shared no-retry guard', async () => {
    let calls = 0
    const h = await makeHarness({
      handlers: (store) => ({
        ...happyHandlers(store),
        'verify-e2e': () => {
          calls += 1
          return failedTurnResult(KIMI_QUOTA, true)
        },
      }),
    })
    await seedPlanApproved(h.store)
    await seedCodeApproved(h.store)

    expect((await h.br.run()).status).toBe('blocked')
    const events = await h.store.getEvents(SLUG)
    const failed = ofType(events, 'phase.failed').at(-1)!
    expect(failed.payload).toEqual({
      phase: 'verify:e2e',
      round: 1,
      attempt: 1,
      error: KIMI_QUOTA,
      willRetry: false,
    })
    expect(calls).toBe(1)
    expect(ofType(events, 'escalation.raised').at(-1)?.payload.question).toContain(KIMI_QUOTA)
    expect(h.ops).toContain('session:ab-verify-e2e')
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
    expect(types.at(-1)).toBe('pr-summary.result')
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
    expect((await typesOf(h.store)).slice(-2)).toEqual(['build.abort-requested', 'build.aborted'])
    expect(h.runner.sessions.size).toBe(0) // no phase ever ran
  })

  test('an abort cancels a live turn, deposits its transcript, and retains the execution lease', async () => {
    const timers = new ManualSessionBudgetScheduler()
    let observedSignal: AbortSignal | undefined
    const h = await makeHarness({
      runnerOpts: { scheduleSessionBudget: timers.schedule },
      handlers: () => ({
        plan: async (ctx) => {
          observedSignal = ctx.opts.signal
          await new Promise<void>(() => {})
          return defaultTurnResult('unreachable')
        },
      }),
    })

    const running = h.br.run()
    while (observedSignal === undefined) await Bun.sleep(1)
    await h.store.append(SLUG, {
      actor: humanActor('aron'),
      type: 'build.abort-requested',
      payload: { reason: 'stop now' },
    })
    const state = await Promise.race([
      running,
      Bun.sleep(1000).then(() => {
        throw new Error('live abort did not settle within one second')
      }),
    ])

    expect(observedSignal.aborted).toBe(true)
    expect(state.status).toBe('aborted')
    expect(timers.activeCount).toBe(0)
    const events = await h.store.getEvents(SLUG)
    expect(events.some((event) => event.type === 'session.ended')).toBe(true)
    expect(events.some((event) => event.type === 'phase.failed')).toBe(false)
    expect(events.some((event) => event.type === 'plan.completed')).toBe(false)
    expect((await h.store.getBuild(SLUG))?.lease?.holder).toBe('runner-1')
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
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'code-review.started',
      payload: { round: 1 },
    })
    await h.store.append(SLUG, {
      actor: agentActor('code-review', 's_dead'),
      type: 'code-review.verdict',
      payload: {
        round: 1,
        verdict: 'revise',
        findings: [FINDING],
        artifact: { kind: 'code-review', rev: 0 },
      },
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
    expect(journal.opts.env.AB_PHASE).toBe('implement@2')
    const completed = ofType(after, 'implement.completed').at(-1)!
    expect(completed.payload.round).toBe(2)
  })
})

// ── Session streams (SPEC §9) ────────────────────────────────────────────────

describe('session streams', () => {
  test('a streaming registration opens one stream per bracket, names it on session.started, and passes the emitter into the turn', async () => {
    const opened: string[] = []
    // The scripted turn appends a part through the per-turn emitter — the
    // wiring under test — before its terminal.
    const h = await makeHarness({
      registrationExtras: {
        openSessionStream: async (sink, info) => {
          opened.push(info.session)
          return sink.open(`session:${info.session}`)
        },
      },
      handlers: (store) =>
        Object.fromEntries(
          Object.entries(happyHandlers(store)).map(([skill, handler]) => [
            skill,
            async (ctx) => {
              ctx.opts.stream?.append([{ type: 'data-ab-prompt', data: { text: ctx.opts.skill } }])
              return handler(ctx)
            },
          ]),
        ),
    })
    await h.br.run()

    const events = await h.store.getEvents(SLUG)
    const started = ofType(events, 'session.started')
    expect(started.length).toBe(7)
    expect(opened.length).toBe(7)
    for (const event of started) {
      // The stream field carries the store-assigned stream id, which is also
      // the label's key: `session:<sessionId>`.
      expect(typeof event.payload.stream).toBe('string')
    }
    // Every stream: first part data-ab-session, closed completed, finalized
    // document assembled from the appended parts, one per opened session.
    const streams = await h.store.listStreams({ kind: 'build', build: SLUG })
    expect(streams).toHaveLength(7)
    expect(new Set(started.map((e) => e.payload.stream))).toEqual(new Set(streams.map((r) => r.id)))
    for (const record of streams) {
      expect(record.status).toBe('closed')
      expect(record.outcome).toBe('completed')
      expect(record.label).toMatch(/^session:/)
      const artifact = await h.store.getArtifact(SLUG, `stream:${record.id}`)
      expect(artifact).not.toBeNull()
      const document = JSON.parse(new TextDecoder().decode(artifact!.content))
      expect(document[0]?.parts?.[0]?.type).toBe('data-ab-session')
      expect(document[0]?.parts?.some((p: { type: string }) => p.type === 'data-ab-prompt')).toBe(
        true,
      )
    }
  })
})

describe('session streams: capability boundary and failure containment', () => {
  test('a plugin registration without the capability yields sessions with no stream and no emitter', async () => {
    const h = await makeHarness()
    await h.br.run()
    const events = await h.store.getEvents(SLUG)
    for (const event of ofType(events, 'session.started')) {
      expect(event.payload.stream).toBeUndefined()
    }
    expect(await h.store.listStreams({ kind: 'build', build: SLUG })).toHaveLength(0)
    // No emitter reached the turns either.
    for (const journal of h.runner.sessions.values()) {
      expect(journal.opts.stream).toBeUndefined()
    }
  })

  test('streamSessions: false reproduces the no-stream event log', async () => {
    const h = await makeHarness({
      registrationExtras: {
        openSessionStream: async (sink, info) => sink.open(`session:${info.session}`),
      },
      runnerOpts: { streamSessions: false },
    })
    await h.br.run()
    const events = await h.store.getEvents(SLUG)
    for (const event of ofType(events, 'session.started')) {
      expect(event.payload.stream).toBeUndefined()
    }
    expect(await h.store.listStreams({ kind: 'build', build: SLUG })).toHaveLength(0)
  })

  test('a store whose stream appends always fail lets the phase complete with one diagnostic and an aborted close', async () => {
    const diagnostics: string[] = []
    const h = await makeHarness({
      registrationExtras: {
        openSessionStream: async (sink, info) => sink.open(`session:${info.session}`),
      },
      runnerOpts: { onDiagnostic: (message) => diagnostics.push(message) },
    })
    // Break the append primitive after the streams are open.
    const failing = new Set<string>()
    const originalAppend = h.store.appendStreamParts.bind(h.store)
    h.store.appendStreamParts = async (streamId: string, parts: never) => {
      if (failing.has(streamId)) throw new Error('store down')
      return originalAppend(streamId, parts)
    }
    // Every stream fails from its first append: mark all ids as failing when
    // they are created.
    const originalCreate = h.store.createStream.bind(h.store)
    h.store.createStream = async (scope: never, label: never) => {
      const record = await originalCreate(scope, label)
      failing.add(record.id)
      return record
    }

    const state = await h.br.run()
    // The phase completes exactly as it would without streams.
    expect(state.status).toBe('running')
    expect(state.prState).toBe('open')
    // Every bracket's deposit-path close observed the undeliverable buffer:
    // one diagnostic each, closed aborted, phase unaffected.
    expect(diagnostics.length).toBe(7)
    // Each defunct writer closed its stream aborted, best-effort.
    const streams = await h.store.listStreams({ kind: 'build', build: SLUG })
    expect(streams.length).toBeGreaterThan(0)
    for (const record of streams) {
      expect(record.outcome).toBe('aborted')
    }
    // The transcript artifact is deposited regardless.
    const ended = ofType(await h.store.getEvents(SLUG), 'session.ended')
    expect(ended.length).toBe(7)
  })
})

describe('session streams: close outcomes per exit path', () => {
  test('a budget-expired bracket closes its stream aborted', async () => {
    const timers = new ManualSessionBudgetScheduler()
    const stuck: AgentRunner = {
      name: 'stuck',
      start: () => new Promise<{ session: AgentSessionHandle; result: AgentTurnResult }>(() => {}),
      continue: () => new Promise<AgentTurnResult>(() => {}),
      end: async () => ({
        content: '',
        metadata: { runner: 'stuck', usage: { inputTokens: 0, outputTokens: 0, turns: 0 } },
      }),
    }
    const h = await makeHarness({
      registrationExtras: {
        openSessionStream: async (sink, info) => sink.open(`session:${info.session}`),
      },
      runtimeRunner: stuck,
      runnerOpts: { maxPhaseAttempts: 2, scheduleSessionBudget: timers.schedule },
    })

    const run = h.br.run()
    await timers.expireNext()
    await timers.expireNext()
    expect((await run).status).toBe('blocked')

    // Both expired brackets' streams closed aborted (best-effort background
    // release; poll for the writer's cadence).
    const deadline = Date.now() + 2_000
    let streams = await h.store.listStreams({ kind: 'build', build: SLUG })
    while (streams.length < 2 && Date.now() < deadline) {
      await Bun.sleep(25)
      streams = await h.store.listStreams({ kind: 'build', build: SLUG })
    }
    expect(streams).toHaveLength(2)
    for (const record of streams) {
      expect(record.status).toBe('closed')
      expect(record.outcome).toBe('aborted')
    }
  })

  test('an operator-aborted bracket that settles keeps its transcript deposit and closes aborted', async () => {
    const h = await makeHarness({
      registrationExtras: {
        openSessionStream: async (sink, info) => sink.open(`session:${info.session}`),
      },
      handlers: (store) => ({
        ...happyHandlers(store),
        plan: async (ctx) => {
          await store.append(SLUG, {
            actor: humanActor('aron'),
            type: 'build.abort-requested',
            payload: { reason: 'stop work' },
          })
          // The turn observes its cancellation signal — as a conforming
          // adapter does — and returns the failed result.
          await new Promise((resolve) => {
            if (ctx.opts.signal?.aborted) resolve(undefined)
            else {
              ctx.opts.signal?.addEventListener('abort', () => resolve(undefined), { once: true })
            }
          })
          return failedTurnResult('turn aborted by caller', false)
        },
      }),
    })
    // The plan turn sees the abort via its signal and returns; the bracket
    // closes aborted with its transcript still deposited.
    const state = await h.br.run()
    expect(state.status).toBe('aborted')

    const streams = await h.store.listStreams({ kind: 'build', build: SLUG })
    expect(streams).toHaveLength(1)
    expect(streams[0]!.outcome).toBe('aborted')
    // The transcript was still deposited.
    const ended = ofType(await h.store.getEvents(SLUG), 'session.ended')
    expect(ended).toHaveLength(1)
  })
})

describe('coalesced summary boundaries', () => {
  for (const shutdown of [false, true])
    test(`remote final verifier drains its terminal turn (parent shutdown: ${shutdown})`, async () => {
      const parent = new AbortController()
      const forge = new FakeForge()
      forge.setPrState(7, { state: 'open', mergeable: true })
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let terminal!: () => void
      const passed = new Promise<void>((resolve) => {
        terminal = resolve
      })
      let calls = 0
      const h = await makeHarness({
        forge,
        configToml: CONFIG_TOML.replace(
          'steps = ["types", "unit", "e2e"]',
          'steps = ["types", "unit", ["e2e"]]',
        ),
        workspaceRemote: true,
        shutdownSignal: parent.signal,
        handlers: (store) => ({
          ...happyHandlers(store),
          'verify-e2e': async (ctx) => {
            calls++
            await store.append(SLUG, {
              actor: agentActor('verify-e2e', sessionOf(ctx)),
              type: 'verify.completed',
              payload: { step: 'e2e', attempt: roundOf(ctx), outcome: 'pass' },
            })
            terminal()
            await held
            return defaultTurnResult('complete')
          },
        }),
      })
      await seedFinalized(h.store)
      await h.store.append(SLUG, {
        actor: DISPATCHER,
        type: 'pr.conflicted',
        payload: { baseSha: 'detected-base' },
      })
      await h.br.attach()
      await h.br.step()
      await completeFixtureRestack(h.store)
      await h.br.step()
      await h.br.step()
      await h.br.step()
      const previous = summaryBoundary(await h.store.getEvents(SLUG))!
      const request = await h.store.append(SLUG, {
        actor: KERNEL,
        type: 'pr-summary.requested',
        payload: previous,
      })
      await h.store.append(SLUG, {
        actor: KERNEL,
        type: 'pr-summary.settled',
        payload: { request: request.seq, disposition: 'skipped' },
      })
      let delivered!: () => void
      const observed = new Promise<void>((resolve) => {
        delivered = resolve
      })
      const subscribe = h.store.subscribe.bind(h.store)
      let first = true
      h.store.subscribe = (slug, opts, callback) => {
        const stage = first
        first = false
        return subscribe(slug, opts, (event) => {
          callback(event)
          if (stage && event.type === 'verify.completed') delivered()
        })
      }
      let configRead!: () => void
      const recomputed = new Promise<void>((resolve) => {
        configRead = resolve
      })
      // Observe the stage's asynchronous config read as well as delivery. The
      // decision itself is synchronous immediately after this read returns.
      // biome-ignore lint/complexity/useLiteralKeys: synchronize the real stage loop without adding a production test hook.
      const capture = h.br['captureConfig'].bind(h.br)
      // biome-ignore lint/complexity/useLiteralKeys: synchronize the real stage loop without adding a production test hook.
      h.br['captureConfig'] = async () => {
        const config = await capture()
        if (calls === 1) configRead()
        return config
      }
      const running = h.br.run()
      await passed
      await observed
      await recomputed
      // Deliver the event and drain the runnable microtasks while the agent's
      // return is explicitly held. This is an event-loop barrier, not a timer.
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(reduceBuild(await h.store.getEvents(SLUG)).sessions.open).toHaveLength(1)
      if (shutdown) parent.abort()
      release()
      await running
      const events = await h.store.getEvents(SLUG)
      expect(calls).toBe(1)
      if (shutdown) {
        // Genuine remote execution shutdown keeps the bracket for recovery.
        expect(reduceBuild(events).sessions.open).toHaveLength(1)
        expect(events.filter((e) => e.type === 'pr-summary.requested')).toHaveLength(1)
        return
      }
      expect(reduceBuild(events).sessions.open).toHaveLength(0)
      expect(events.filter((e) => e.type === 'session.suspended')).toHaveLength(0)
      const ended = events.findLast((e) => e.type === 'session.ended')!
      const summary = events.findLast((e) => e.type === 'pr-summary.requested')!
      expect(summary.seq).toBeGreaterThan(ended.seq)
    })

  for (const remote of [false, true])
    for (const count of [3, 300]) {
      test(`${remote ? 'remote' : 'local'} verify with ${count} attachments publishes only after session settlement`, async () => {
        const forge = new FakeForge()
        forge.setPrState(7, { state: 'open', mergeable: true })
        let verifyCalls = 0
        let guestSummaryCalls = 0
        const h = await makeHarness({
          forge,
          workspaceRemote: remote,
          handlers: (store) => ({
            ...happyHandlers(store),
            'verify-e2e': async (ctx) => {
              verifyCalls++
              // Simulate artifact put's atomic designation, including one after
              // the terminal command: the session must settle before rendering.
              await store.append(SLUG, {
                actor: agentActor('verify-e2e', sessionOf(ctx)),
                type: 'verify.completed',
                payload: { step: 'e2e', attempt: roundOf(ctx), outcome: 'pass' },
              })
              for (let i = 0; i < count; i++) {
                await store.appendWithArtifacts(
                  SLUG,
                  [{ kind: `frame:${i}`, content: 'pixels' }],
                  (metas) => ({
                    actor: agentActor('verify-e2e', sessionOf(ctx)),
                    type: 'pr-attachment.designated',
                    payload: {
                      artifact: refOf(metas),
                      filename: `frame-${i}.png`,
                      mediaType: 'image/png',
                    },
                  }),
                )
                expect(forge.comments).toHaveLength(0)
              }
              return defaultTurnResult('complete')
            },
          }),
        })
        await seedFinalized(h.store)
        // Make a fresh verification cycle eligible after a completed reconcile.
        await h.store.append(SLUG, {
          actor: DISPATCHER,
          type: 'pr.conflicted',
          payload: { baseSha: 'detected-base' },
        })
        // Drive deterministic checks first; run() then verifies and handles the boundary.
        await h.br.attach()
        await h.br.step() // reconcile
        await completeFixtureRestack(h.store)
        await h.br.step() // capture policy
        await h.br.step() // types
        await h.br.step() // unit
        const previous = summaryBoundary(await h.store.getEvents(SLUG))!
        if (remote) {
          const request = await h.store.append(SLUG, {
            actor: KERNEL,
            type: 'pr-summary.requested',
            payload: previous,
          })
          await h.store.append(SLUG, {
            actor: KERNEL,
            type: 'pr-summary.settled',
            payload: { request: request.seq, disposition: 'skipped' },
          })
        } else {
          await h.store.append(SLUG, {
            actor: KERNEL,
            type: 'pr-summary.attempted',
            payload: { ...previous, pr: 7 },
          })
        }
        if (remote) {
          // Any summary call by the guest is an error, even if best effort.
          forge.commentOnPr = async () => {
            guestSummaryCalls++
            throw new Error('guest summary call')
          }
        }
        await h.br.run()
        expect(verifyCalls).toBe(1)
        const events = await h.store.getEvents(SLUG)
        const latest = events.findLast(
          (e) => e.type === 'pr-summary.requested' || e.type === 'pr-summary.attempted',
        )!
        if (remote) {
          expect(latest.type).toBe('pr-summary.requested')
          expect(events.some((e) => e.type === 'pr-summary.attempted')).toBe(false)
          expect(forge.comments).toHaveLength(0)
          expect(guestSummaryCalls).toBe(0)
          // The execution owner has reaped the guest and released its lease.
          await h.store.releaseLease(SLUG, 'runner-1')
          const hostForge = new FakeForge()
          hostForge.setPrState(7, { state: 'open', mergeable: true })
          await settleSummaryRequests({
            store: h.store,
            forge: hostForge,
            slug: SLUG,
            workspacePath: h.workspacePath,
            storeRef: 'https://store.test',
            clock: steppingClock(),
            holder: 'authenticated-host',
          })
          expect(hostForge.comments).toHaveLength(1)
          const body = hostForge.comments[0]!.body
          const full = body.includes('pr-summary@')
            ? new TextDecoder().decode((await h.store.getArtifact(SLUG, 'pr-summary', 0))!.content)
            : body
          expect(full).toContain(`frame-${count - 1}.png`)
          expect(full).toContain('<code>e2e</code> (attempt 2): pass')
          await h.br.run()
          expect(verifyCalls).toBe(1)
          expect(guestSummaryCalls).toBe(0)
        } else {
          expect(latest.type).toBe('pr-summary.attempted')
          expect(forge.comments).toHaveLength(1)
          const body = forge.comments[0]!.body
          const full = body.includes('pr-summary@')
            ? new TextDecoder().decode((await h.store.getArtifact(SLUG, 'pr-summary', 0))!.content)
            : body
          expect(full).toContain(`frame-${count - 1}.png`)
          expect(full).toContain('<code>e2e</code> (attempt 2): pass')
        }
      })
    }
})

describe('frozen post-reconcile verification policy', () => {
  test('captures live config once, recovers crashes, skips check and agent without execution, then refreshes next reconcile', async () => {
    const disabled = parseConfig(
      CONFIG_TOML.replace('[verify]\n', '[verify]\nafterReconcile = false\n'),
    )
    const enabledConfig = parseConfig(CONFIG_TOML)
    enabledConfig.roles.default = { runtime: 'scripted' }
    disabled.roles.default = { runtime: 'scripted' }
    let current = enabledConfig
    current.roles.default = { runtime: 'scripted' }
    const h = await makeHarness({ getConfig: () => current })
    await seedFinalized(h.store)
    await h.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'pr.conflicted',
      payload: { baseSha: 'base-2' },
    })
    await h.br.step() // reconcile under original config
    await completeFixtureRestack(h.store)
    current = disabled // next action sees the newly disabled policy
    h.store.faultAfterNext('verify.reconcile-policy-captured')
    await expect(h.br.step()).rejects.toThrow('injected crash')
    current = enabledConfig // must not replace the durable snapshot on recovery
    const sessions = h.runner.sessions.size
    const execs = h.execCalls.length
    h.store.faultAfterNext('verify.started')
    await expect(h.br.step()).rejects.toThrow('injected crash')
    for (const step of ['types', 'unit', 'e2e']) {
      expect(await h.br.step()).toMatchObject({
        kind: 'skip-verify',
        step,
        skipCause: 'post-reconcile-policy',
      })
    }
    expect(h.runner.sessions.size).toBe(sessions)
    expect(h.execCalls.length).toBe(execs)
    expect(await h.br.step()).toEqual({ kind: 'wait', reason: 'awaiting-pr' })
    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'verify.reconcile-policy-captured')).toHaveLength(1)
    expect(
      reduceBuild(events)
        .verify.results.slice(-3)
        .map((r) => r.outcome),
    ).toEqual(['skipped', 'skipped', 'skipped'])
    await h.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'pr.conflicted',
      payload: { baseSha: 'base-3' },
    })
    await h.br.step() // progress observation
    await h.br.step() // reconcile
    await completeFixtureRestack(h.store)
    expect(await h.br.step()).toMatchObject({ kind: 'capture-reconcile-policy' })
    expect(await h.br.step()).toMatchObject({ kind: 'run-check', step: 'types' })
  })

  test.each([true, false])('step override takes precedence over repository %s', async (enabled) => {
    const current = parseConfig(
      CONFIG_TOML.replace('[verify]\n', `[verify]\nafterReconcile = ${enabled}\n`).replace(
        '[verify.types]\n',
        `[verify.types]\nafterReconcile = ${!enabled}\nalways = true\npaths = ["missing/**"]\n`,
      ),
    )
    current.roles.default = { runtime: 'scripted' }
    const h = await makeHarness({ getConfig: () => current })
    await seedFinalized(h.store)
    await h.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'pr.conflicted',
      payload: { baseSha: 'base-2' },
    })
    await h.br.step()
    await completeFixtureRestack(h.store)
    await h.br.step()
    expect(await h.br.step()).toMatchObject(
      !enabled
        ? { kind: 'run-check', step: 'types' }
        : {
            kind: 'skip-verify',
            step: 'types',
            reason: 'skipped by post-reconcile policy: verify.types.afterReconcile = false',
          },
    )
  })
})

describe('native identity recording', () => {
  test('the fact merges before the native turn completes and deduplicates within a bracket', async () => {
    const { nativeHandle } = await import('../ports/runner/native-session')
    let unblock!: () => void
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve
    })
    let observed!: () => void
    const observation = new Promise<void>((resolve) => {
      observed = resolve
    })
    const h = await makeHarness({
      handlers: (store) => {
        const handlers = happyHandlers(store)
        const plan = handlers['ab-plan'] ?? handlers.plan!
        return {
          ...handlers,
          'ab-plan': async (ctx) => {
            const handle = nativeHandle('scripted', 'native-thread', ctx.opts.workspacePath)
            await ctx.opts.onNativeSession?.(handle)
            await ctx.opts.onNativeSession?.(handle)
            observed()
            await blocked
            return plan(ctx)
          },
        }
      },
    })
    const running = h.br.run()
    await observation
    const facts = ofType(await h.store.getEvents(SLUG), 'session.native-handle-recorded')
    expect(facts).toHaveLength(1)
    expect(facts[0]?.payload).toMatchObject({
      phase: 'plan',
      round: 1,
      handle: { nativeId: 'native-thread' },
    })
    expect(
      reduceBuild(await h.store.getEvents(SLUG)).sessions.open[0]?.nativeHandle?.nativeId,
    ).toBe('native-thread')
    unblock()
    await running
    const all = await h.store.getEvents(SLUG)
    expect(all.findIndex((e) => e.type === 'session.native-handle-recorded')).toBeLessThan(
      all.findIndex((e) => e.type === 'session.ended'),
    )
  })

  test('late native callbacks after a budget boundary cannot write a handle', async () => {
    const { nativeHandle } = await import('../ports/runner/native-session')
    const timers = new ManualSessionBudgetScheduler()
    let callback: import('../ports/types').NativeSessionObserver | undefined
    let workspacePath = ''
    const runner: AgentRunner = {
      name: 'late',
      start: async (opts) => {
        callback = opts.onNativeSession
        workspacePath = opts.workspacePath
        return new Promise(() => {})
      },
      continue: async () => defaultTurnResult(),
      end: async () => ({
        content: '',
        metadata: { runner: 'late', usage: { inputTokens: 0, outputTokens: 0, turns: 0 } },
      }),
    }
    const h = await makeHarness({
      runtimeRunner: runner,
      runnerOpts: { maxPhaseAttempts: 1, scheduleSessionBudget: timers.schedule },
    })
    const running = h.br.run()
    await timers.expireNext()
    await running
    await callback?.(nativeHandle('late', 'too-late', workspacePath))
    expect(ofType(await h.store.getEvents(SLUG), 'session.native-handle-recorded')).toHaveLength(0)
  })

  test('a rejected native fact append surfaces as infrastructure failure', async () => {
    const { nativeHandle } = await import('../ports/runner/native-session')
    const h = await makeHarness({
      handlers: (store) => ({
        ...happyHandlers(store),
        'ab-plan': async (ctx) => {
          await ctx.opts.onNativeSession?.(
            nativeHandle('scripted', 'native-thread', ctx.opts.workspacePath),
          )
          return defaultTurnResult()
        },
      }),
    })
    const append = h.store.append.bind(h.store)
    h.store.append = async (slug, write) => {
      if (write.type === 'session.native-handle-recorded')
        throw new Error('native fact store unavailable')
      return append(slug, write)
    }
    await expect(h.br.run()).rejects.toThrow('native fact store unavailable')
  })
})

test('native facts follow the current bracket across reused producer rounds', async () => {
  const h = await makeHarness({ nativeSessions: true, handlers: reviseThenApproveHandlers })
  await h.br.run()
  const events = await h.store.getEvents(SLUG)
  const facts = ofType(events, 'session.native-handle-recorded').filter(
    (event) => event.payload.phase === 'implement',
  )
  expect(facts).toHaveLength(2)
  expect(facts.map((event) => event.payload.round)).toEqual([1, 2])
  expect(facts[0]!.payload.session).not.toBe(facts[1]!.payload.session)
  expect(facts[0]!.payload.handle.nativeId).toBe(facts[1]!.payload.handle.nativeId)
  for (const fact of facts) {
    const start = ofType(events, 'session.started').find(
      (event) => event.payload.session === fact.payload.session,
    )!
    const end = ofType(events, 'session.ended').find(
      (event) => event.payload.session === fact.payload.session,
    )!
    expect(start.seq).toBeLessThan(fact.seq)
    expect(fact.seq).toBeLessThan(end.seq)
  }
})

test('restart still reclaims and reruns a phase even when a durable native handle exists', async () => {
  const { nativeHandle } = await import('../ports/runner/native-session')
  const h = await makeHarness()
  await seedPlanApproved(h.store)
  await h.store.append(SLUG, { actor: KERNEL, type: 'implement.started', payload: { round: 1 } })
  await h.store.append(SLUG, {
    actor: KERNEL,
    type: 'session.started',
    payload: {
      session: 's_dead',
      phase: 'implement',
      round: 1,
      role: 'implement',
      runner: 'scripted',
    },
  })
  await h.store.append(SLUG, {
    actor: KERNEL,
    type: 'session.native-handle-recorded',
    payload: {
      session: 's_dead',
      phase: 'implement',
      round: 1,
      handle: nativeHandle('scripted', 'dead-native', h.workspacePath),
    },
  })
  await h.br.attach()
  await h.br.step()
  const events = await h.store.getEvents(SLUG)
  expect(
    ofType(events, 'session.ended').find((event) => event.payload.session === 's_dead')?.payload,
  ).toMatchObject({ outcome: 'reclaimed' })
  const fresh = [...h.runner.sessions.values()].find((j) => j.opts.skill === 'ab-implement')!
  expect(fresh.messages).toEqual([])
  expect(fresh.turns).toHaveLength(1)
  expect(reduceBuild(events).sessions.nativeHandles.s_dead?.nativeId).toBe('dead-native')
})

describe('native suspension and continuation', () => {
  function successor(h: Harness, runner: AgentRunner = h.runner, remote = false) {
    let id = 100
    return new BuildRunner({
      store: h.store.scopeBuild(SLUG),
      config,
      runtimes: {
        scripted: { runner, servesModels: ['m-'] },
        pi: { runner, servesModels: ['kimi-'] },
        claude: { runner, servesModels: ['claude-'] },
      },
      workspacePath: h.workspacePath,
      workspaceProvider: 'git-worktree',
      workspaceRemote: remote,
      branch: BRANCH,
      slug: SLUG,
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      forge: h.forge,
      ids: (prefix) => `${prefix}_${++id}`,
      clock: () => new Date(),
      instance: 'runner-1',
      host: 'sandbox-a',
    })
  }

  test('shutdown waits beyond the old deadlines for suspension persistence', async () => {
    const shutdown = new AbortController()
    let observed!: () => void
    const ready = new Promise<void>((resolve) => {
      observed = resolve
    })
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    let persisting!: () => void
    const entered = new Promise<void>((resolve) => {
      persisting = resolve
    })
    const h = await makeHarness({
      nativeSessions: true,
      workspaceProvider: 'git-worktree',
      shutdownSignal: shutdown.signal,
      handlers: (store) => ({
        ...happyHandlers(store),
        'ab-plan': async () => {
          observed()
          await new Promise(() => {})
          return defaultTurnResult()
        },
      }),
    })
    const append = h.store.appendWithArtifactsIfCurrent.bind(h.store)
    h.store.appendWithArtifactsIfCurrent = async (...args) => {
      persisting()
      await barrier
      return append(...args)
    }
    let finished = false
    const running = h.br.run().finally(() => {
      finished = true
    })
    try {
      await ready
      shutdown.abort()
      await entered
      await Bun.sleep(5100)
      expect(finished).toBe(false)
      expect(ofType(await h.store.getEvents(SLUG), 'session.suspended')).toHaveLength(0)
    } finally {
      release()
      await running
    }
    expect(ofType(await h.store.getEvents(SLUG), 'session.suspended')).toHaveLength(1)
    expect(reduceBuild(await h.store.getEvents(SLUG)).sessions.open).toHaveLength(0)
  }, 15000)

  test('shutdown suspends a session with no native handle and successor records fresh fallback', async () => {
    const shutdown = new AbortController()
    let ready!: () => void
    const observed = new Promise<void>((resolve) => {
      ready = resolve
    })
    let first = true
    const h = await makeHarness({
      nativeSessions: false,
      workspaceProvider: 'git-worktree',
      shutdownSignal: shutdown.signal,
      handlers: (store) => {
        const handlers = happyHandlers(store)
        return {
          ...handlers,
          'ab-plan': async (ctx) => {
            if (first) {
              first = false
              ready()
              await new Promise(() => {})
            }
            return (handlers['ab-plan'] ?? handlers.plan!)(ctx)
          },
        }
      },
    })
    const running = h.br.run()
    await observed
    shutdown.abort()
    await running
    const before = await h.store.getEvents(SLUG)
    expect(ofType(before, 'session.suspended')).toHaveLength(1)
    expect(ofType(before, 'session.suspended')[0]!.payload.handle).toBeUndefined()
    expect(reduceBuild(before).sessions.open).toHaveLength(0)
    const next = successor(h)
    await next.attach()
    await next.step()
    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'session.resume-fallback')).toHaveLength(1)
    expect(ofType(events, 'session.resume-fallback')[0]!.payload.reason).toBeTruthy()
    expect(ofType(events, 'session.resumed')).toHaveLength(0)
  })

  test('shutdown deposits partial evidence; restart resumes the same native handle and phase round', async () => {
    const shutdown = new AbortController()
    let observed!: () => void
    const ready = new Promise<void>((r) => {
      observed = r
    })
    let resumed = false
    const h = await makeHarness({
      nativeSessions: true,
      workspaceProvider: 'git-worktree',
      shutdownSignal: shutdown.signal,
      handlers: (store) => {
        const handlers = happyHandlers(store)
        return {
          ...handlers,
          'ab-plan': async (ctx) => {
            if (!ctx.message) {
              observed()
              await new Promise(() => {})
            }
            resumed = true
            return (handlers['ab-plan'] ?? handlers.plan!)(ctx)
          },
        }
      },
    })
    const running = h.br.run()
    await ready
    shutdown.abort()
    await running
    const before = await h.store.getEvents(SLUG)
    const suspended = ofType(before, 'session.suspended')[0]!
    expect(suspended.payload.cause).toBe('shutdown')
    expect(
      await h.store.getArtifact(
        SLUG,
        suspended.payload.transcript.kind,
        suspended.payload.transcript.rev,
      ),
    ).not.toBeNull()
    const resumedRunner = successor(h)
    await resumedRunner.attach()
    await resumedRunner.step()
    expect(resumed).toBe(true)
    const log = await h.store.getEvents(SLUG)
    const acceptance = ofType(log, 'session.resumed')[0]!
    expect(acceptance.payload.handle.nativeId).toBe(suspended.payload.handle!.nativeId)
    expect(ofType(log, 'plan.started')).toHaveLength(1)
    const continuation = ofType(log, 'session.started').at(-1)!
    expect(continuation.payload.continuation?.predecessor).toBe(suspended.payload.session)
    expect(continuation.payload.round).toBe(1)
    const journal = h.runner.sessions.get(acceptance.payload.handle.nativeId)!
    expect(journal.messages[0]).toContain('interrupted (shutdown)')
    expect(journal.messages[0]).toContain('Re-check the worktree')
  })

  for (const countermanded of [false, true]) {
    test(`pause before session.started is ${countermanded ? 'countermanded by resume' : 'honored without waiting for the phase'}`, async () => {
      const shutdown = new AbortController()
      const h = await makeHarness({
        nativeSessions: true,
        workspaceProvider: 'git-worktree',
        shutdownSignal: shutdown.signal,
        handlers: countermanded
          ? happyHandlers
          : (store) => ({
              ...happyHandlers(store),
              'ab-plan': async () => {
                await new Promise(() => {})
                return defaultTurnResult()
              },
            }),
      })
      const append = h.store.append.bind(h.store)
      let injected = false
      h.store.append = async (slug, event) => {
        if (!injected && event.type === 'session.started') {
          injected = true
          await append(slug, {
            actor: humanActor('operator'),
            type: 'build.pause-requested',
            payload: {},
          })
          if (countermanded) {
            await append(slug, {
              actor: humanActor('operator'),
              type: 'build.resume-requested',
              payload: {},
            })
          }
        }
        return append(slug, event)
      }
      const running = h.br.run()
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('pre-session pause did not settle')), 1000)
      })
      try {
        const state = await Promise.race([running, deadline])
        const log = await h.store.getEvents(SLUG)
        expect(ofType(log, 'build.pause-requested')[0]!.seq).toBeLessThan(
          ofType(log, 'session.started')[0]!.seq,
        )
        expect(ofType(log, 'phase.failed')).toHaveLength(0)
        if (countermanded) {
          expect(ofType(log, 'session.suspended')).toHaveLength(0)
          expect(ofType(log, 'build.paused')).toHaveLength(0)
          expect(ofType(log, 'plan.completed')).toHaveLength(1)
        } else {
          expect(state.status).toBe('paused')
          expect(ofType(log, 'session.suspended')).toHaveLength(1)
          expect(ofType(log, 'session.suspended')[0]!.payload.cause).toBe('pause')
          expect(ofType(log, 'plan.completed')).toHaveLength(0)
          expect(ofType(log, 'build.paused')[0]!.seq).toBeGreaterThan(
            ofType(log, 'session.suspended')[0]!.seq,
          )
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        shutdown.abort()
        await running
      }
    })
  }

  test('pause suspends promptly and resumes the same native session', async () => {
    let observed!: () => void
    const ready = new Promise<void>((r) => {
      observed = r
    })
    let resumed = false
    const h = await makeHarness({
      nativeSessions: true,
      workspaceProvider: 'git-worktree',
      handlers: (store) => {
        const handlers = happyHandlers(store)
        return {
          ...handlers,
          'ab-plan': async (ctx) => {
            if (!ctx.message) {
              observed()
              await new Promise(() => {})
            }
            resumed = true
            return (handlers['ab-plan'] ?? handlers.plan!)(ctx)
          },
        }
      },
    })
    const running = h.br.run()
    await ready
    const read = h.store.getReducerValue.bind(h.store)
    let failedRead = false
    h.store.getReducerValue = async (scope, request) => {
      if (!failedRead && request.reducer === 'buildReadFacts') {
        failedRead = true
        throw new Error('transient pause read failure')
      }
      return read(scope, request)
    }
    await h.store.append(SLUG, {
      actor: humanActor('operator'),
      type: 'build.pause-requested',
      payload: {},
    })
    await running
    const before = await h.store.getEvents(SLUG)
    const suspended = ofType(before, 'session.suspended')[0]!
    expect(suspended.payload.cause).toBe('pause')
    expect(failedRead).toBe(true)
    expect(
      await h.store.getArtifact(
        SLUG,
        suspended.payload.transcript.kind,
        suspended.payload.transcript.rev,
      ),
    ).not.toBeNull()
    expect(reduceBuild(before).status).toBe('paused')
    await h.store.append(SLUG, {
      actor: humanActor('operator'),
      type: 'build.resume-requested',
      payload: {},
    })
    const resumedRunner = successor(h)
    await resumedRunner.attach()
    await resumedRunner.step()
    expect(resumed).toBe(true)
    const log = await h.store.getEvents(SLUG)
    const acceptance = ofType(log, 'session.resumed')[0]!
    expect(acceptance.payload.handle.nativeId).toBe(suspended.payload.handle!.nativeId)
    expect(ofType(log, 'plan.started')).toHaveLength(1)
    const continuation = ofType(log, 'session.started').at(-1)!
    expect(continuation.payload.continuation?.predecessor).toBe(suspended.payload.session)
    expect(continuation.payload.round).toBe(1)
    const journal = h.runner.sessions.get(acceptance.payload.handle.nativeId)!
    expect(journal.messages[0]).toContain('interrupted (pause)')
    expect(journal.messages[0]).toContain('Re-check the worktree')
  })

  for (const scenario of ['missing-handle', 'remote', 'unsupported'] as const) {
    test(`pause suspends ${scenario} sessions and logs a fresh recovery fallback`, async () => {
      let ready!: () => void
      const observed = new Promise<void>((resolve) => {
        ready = resolve
      })
      let first = true
      const h = await makeHarness({
        nativeSessions: scenario !== 'missing-handle',
        workspaceProvider: 'git-worktree',
        workspaceRemote: scenario === 'remote',
        handlers: (store) => {
          const handlers = happyHandlers(store)
          return {
            ...handlers,
            'ab-plan': async (ctx) => {
              if (first) {
                first = false
                ready()
                await new Promise(() => {})
              }
              return (handlers['ab-plan'] ?? handlers.plan!)(ctx)
            },
          }
        },
      })
      const running = h.br.run()
      await observed
      await h.store.append(SLUG, {
        actor: humanActor('operator'),
        type: 'build.pause-requested',
        payload: {},
      })
      expect((await running).status).toBe('paused')
      const suspended = ofType(await h.store.getEvents(SLUG), 'session.suspended')
      expect(suspended).toHaveLength(1)
      expect(suspended[0]!.payload.cause).toBe('pause')
      if (scenario === 'missing-handle') expect(suspended[0]!.payload.handle).toBeUndefined()
      await h.store.append(SLUG, {
        actor: humanActor('operator'),
        type: 'build.resume-requested',
        payload: {},
      })
      const runner =
        scenario === 'unsupported'
          ? {
              name: h.runner.name,
              start: h.runner.start.bind(h.runner),
              continue: h.runner.continue.bind(h.runner),
              end: h.runner.end.bind(h.runner),
            }
          : h.runner
      const next = successor(h, runner, scenario === 'remote')
      await next.attach()
      await next.step()
      const log = await h.store.getEvents(SLUG)
      expect(ofType(log, 'session.resumed')).toHaveLength(0)
      expect(ofType(log, 'session.resume-fallback')[0]!.payload.reason).toBe(
        scenario === 'remote'
          ? 'workspace-not-local-git-worktree'
          : scenario === 'unsupported'
            ? 'unsupported-runtime'
            : 'missing-handle',
      )
      expect(ofType(log, 'phase.failed')).toHaveLength(0)
    })
  }

  for (const command of ['resume', 'abort'] as const) {
    test(`${command} during pause cleanup supersedes pause without stranding the build`, async () => {
      let ready!: () => void
      const observed = new Promise<void>((resolve) => {
        ready = resolve
      })
      let h!: Harness
      let interrupted = false
      const runner: AgentRunner = {
        name: 'scripted',
        start: (...args) => h.runner.start(...args),
        continue: (...args) => h.runner.continue(...args),
        resume: (...args) => h.runner.resume(...args),
        end: async (handle) => {
          if (!interrupted) {
            interrupted = true
            await h.store.append(SLUG, {
              actor: humanActor('operator'),
              type: command === 'resume' ? 'build.resume-requested' : 'build.abort-requested',
              payload: {},
            })
          }
          return h.runner.end(handle)
        },
      }
      h = await makeHarness({
        nativeSessions: true,
        workspaceProvider: 'git-worktree',
        runtimeRunner: runner,
        handlers: (store) => {
          const handlers = happyHandlers(store)
          return {
            ...handlers,
            'ab-plan': async (ctx) => {
              if (!ctx.message) {
                ready()
                await new Promise(() => {})
              }
              return (handlers['ab-plan'] ?? handlers.plan!)(ctx)
            },
          }
        },
      })
      const running = h.br.run()
      await observed
      await h.store.append(SLUG, {
        actor: humanActor('operator'),
        type: 'build.pause-requested',
        payload: {},
      })
      const state = await running
      const log = await h.store.getEvents(SLUG)
      expect(ofType(log, 'build.paused')).toHaveLength(0)
      expect(ofType(log, 'session.suspended')).toHaveLength(1)
      expect(ofType(log, 'phase.failed')).toHaveLength(0)
      if (command === 'abort') expect(state.status).toBe('aborted')
      else {
        expect(ofType(log, 'session.resumed')).toHaveLength(1)
        expect(ofType(log, 'plan.completed')).toHaveLength(1)
      }
    })
  }

  test('resume winning the pause acknowledgement CAS prevents a stale paused fact', async () => {
    let ready!: () => void
    const observed = new Promise<void>((resolve) => {
      ready = resolve
    })
    const h = await makeHarness({
      nativeSessions: true,
      workspaceProvider: 'git-worktree',
      handlers: (store) => {
        const handlers = happyHandlers(store)
        return {
          ...handlers,
          'ab-plan': async (ctx) => {
            if (!ctx.message) {
              ready()
              await new Promise(() => {})
            }
            return (handlers['ab-plan'] ?? handlers.plan!)(ctx)
          },
        }
      },
    })
    const append = h.store.appendIfCurrent.bind(h.store)
    let raced = false
    h.store.appendIfCurrent = async (slug, cursor, write) => {
      if (write.type === 'build.paused' && !raced) {
        raced = true
        await h.store.append(SLUG, {
          actor: humanActor('operator'),
          type: 'build.resume-requested',
          payload: {},
        })
      }
      return append(slug, cursor, write)
    }
    const running = h.br.run()
    await observed
    await h.store.append(SLUG, {
      actor: humanActor('operator'),
      type: 'build.pause-requested',
      payload: {},
    })
    await running
    const log = await h.store.getEvents(SLUG)
    expect(raced).toBe(true)
    expect(ofType(log, 'build.paused')).toHaveLength(0)
    expect(ofType(log, 'session.resumed')).toHaveLength(1)
    expect(ofType(log, 'phase.failed')).toHaveLength(0)
  })

  test('a pause countermanded before cancellation leaves the running turn intact', async () => {
    const h = await makeHarness({
      nativeSessions: true,
      workspaceProvider: 'git-worktree',
      handlers: (store) => {
        const handlers = happyHandlers(store)
        return {
          ...handlers,
          'ab-plan': async (ctx) => {
            await store.append(SLUG, {
              actor: humanActor('operator'),
              type: 'build.pause-requested',
              payload: {},
            })
            await store.append(SLUG, {
              actor: humanActor('operator'),
              type: 'build.resume-requested',
              payload: {},
            })
            return (handlers['ab-plan'] ?? handlers.plan!)(ctx)
          },
        }
      },
    })
    await h.br.run()
    const log = await h.store.getEvents(SLUG)
    expect(ofType(log, 'session.suspended')).toHaveLength(0)
    expect(ofType(log, 'build.paused')).toHaveLength(0)
    expect(ofType(log, 'plan.completed')).toHaveLength(1)
  })

  test('a phase terminal merge during pause cleanup wins over suspension', async () => {
    let ready!: () => void
    const observed = new Promise<void>((resolve) => {
      ready = resolve
    })
    let h!: Harness
    const runner: AgentRunner = {
      name: 'scripted',
      start: (...args) => h.runner.start(...args),
      continue: (...args) => h.runner.continue(...args),
      resume: (...args) => h.runner.resume(...args),
      end: async (handle) => {
        const journal = h.runner.sessions.get(handle.id)!
        const ctx = { opts: journal.opts, session: handle, turn: 1, history: [] }
        await happyHandlers(h.store).plan!(ctx)
        return h.runner.end(handle)
      },
    }
    h = await makeHarness({
      nativeSessions: true,
      workspaceProvider: 'git-worktree',
      runtimeRunner: runner,
      handlers: (store) => ({
        ...happyHandlers(store),
        'ab-plan': async () => {
          ready()
          await new Promise(() => {})
          return defaultTurnResult()
        },
      }),
    })
    const running = h.br.run()
    await observed
    await h.store.append(SLUG, {
      actor: humanActor('operator'),
      type: 'build.pause-requested',
      payload: {},
    })
    expect((await running).status).toBe('paused')
    const log = await h.store.getEvents(SLUG)
    expect(ofType(log, 'session.suspended')).toHaveLength(0)
    expect(ofType(log, 'plan.completed')).toHaveLength(1)
    expect(ofType(log, 'session.ended')).toHaveLength(1)
    expect(ofType(log, 'phase.failed')).toHaveLength(0)
  })

  test('abort of an already suspended build never resumes its native session', async () => {
    let ready!: () => void
    const observed = new Promise<void>((resolve) => {
      ready = resolve
    })
    const h = await makeHarness({
      nativeSessions: true,
      workspaceProvider: 'git-worktree',
      handlers: (store) => ({
        ...happyHandlers(store),
        'ab-plan': async () => {
          ready()
          await new Promise(() => {})
          return defaultTurnResult()
        },
      }),
    })
    const running = h.br.run()
    await observed
    await h.store.append(SLUG, {
      actor: humanActor('operator'),
      type: 'build.pause-requested',
      payload: {},
    })
    expect((await running).status).toBe('paused')
    await h.store.append(SLUG, {
      actor: humanActor('operator'),
      type: 'build.abort-requested',
      payload: {},
    })
    expect((await successor(h).run()).status).toBe('aborted')
    const log = await h.store.getEvents(SLUG)
    expect(ofType(log, 'session.resumed')).toHaveLength(0)
    expect(ofType(log, 'session.started')).toHaveLength(1)
  })

  test('an attempt without acceptance is retried with inherited identity; terminal before acceptance is valid', async () => {
    const { nativeHandle } = await import('../ports/runner/native-session')
    let starts = 0
    let resumes = 0
    const handle = nativeHandle('scripted', 'durable-native', '/placeholder')
    let h!: Harness
    const runner: AgentRunner = {
      name: 'scripted',
      async start() {
        starts++
        throw new Error('must resume')
      },
      async continue() {
        throw new Error('unexpected continue')
      },
      async resume(native, message, opts) {
        resumes++
        expect(native.nativeId).toBe('durable-native')
        expect(message).toContain('interrupted')
        const env = opts.env!
        // Simulate a phase terminal issued before the adapter reports native acceptance.
        const deps = {
          store: h.store,
          env: {
            build: SLUG,
            store: 'local',
            phase: 'plan' as const,
            round: 1,
            session: env.AB_SESSION!,
          },
          workspacePath: h.workspacePath,
          forge: h.forge,
          ids: sequentialIds(),
          exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        }
        await h.store.putArtifact(SLUG, { kind: 'plan', content: '# Plan' })
        await done(deps)
        expect(env.AB_SESSION).not.toBe('attempt-before-crash')
        await opts.onNativeSession?.(native)
        return {
          kind: 'resumed',
          session: { id: 'continued', runner: 'scripted' },
          result: defaultTurnResult(),
        }
      },
      async end() {
        return {
          content: 'continued turn',
          metadata: { runner: 'scripted', usage: { inputTokens: 2, outputTokens: 3, turns: 1 } },
        }
      },
    }
    h = await makeHarness({
      workspaceProvider: 'git-worktree',
      runtimeRunner: runner,
      clock: () => new Date(),
    })
    await mkdir(h.workspacePath, { recursive: true })
    await writeFile(join(h.workspacePath, 'autobuild.toml'), CONFIG_TOML)
    handle.workspacePath = h.workspacePath
    await h.store.append(SLUG, { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'session.started',
      payload: {
        session: 'attempt-before-crash',
        role: 'plan',
        runner: 'scripted',
        phase: 'plan',
        round: 1,
        budgetMs: 3600000,
        continuation: {
          predecessor: 'original',
          root: 'original',
          handle,
          cause: 'runner-loss',
          activeMs: 10,
          budgetMs: 3600000,
        },
      },
    })
    const br = successor(h, runner)
    await br.attach()
    await br.step()
    expect(starts).toBe(0)
    expect(resumes).toBe(1)
    expect(ofType(await h.store.getEvents(SLUG), 'plan.completed')).toHaveLength(1)
  })
})

describe('native recovery fallback boundaries', () => {
  for (const scenario of [
    'missing-handle',
    'wrong-host',
    'wrong-workspace',
    'remote',
    'missing-state',
    'unsupported',
  ] as const) {
    test(`${scenario} records why native recovery was unavailable and executes one fresh turn`, async () => {
      const { nativeHandle } = await import('../ports/runner/native-session')
      let h!: Harness
      let starts = 0
      let resumes = 0
      const timers = new ManualSessionBudgetScheduler()
      const delegate: AgentRunner = {
        name: 'scripted',
        start: (opts) => {
          starts++
          return h.runner.start(opts)
        },
        continue: (handle, message, opts) => h.runner.continue(handle, message, opts),
        end: (handle) => h.runner.end(handle),
        ...(scenario === 'unsupported'
          ? {}
          : {
              resume: async (...args: Parameters<NonNullable<AgentRunner['resume']>>) => {
                resumes++
                return h.runner.resume(...args)
              },
            }),
      }
      h = await makeHarness({
        workspaceProvider: 'git-worktree',
        configToml: `${CONFIG_TOML}\n[policy]\nsessionBudgetSeconds = 1\n`,
        runnerOpts: { scheduleSessionBudget: timers.schedule },
        workspaceRemote: scenario === 'remote',
        runtimeRunner: delegate,
        clock: () => new Date(),
      })
      await h.store.append(SLUG, { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
      await h.store.append(SLUG, {
        actor: KERNEL,
        type: 'session.started',
        payload: {
          session: 'lost',
          role: 'plan',
          runner: 'scripted',
          phase: 'plan',
          round: 1,
          budgetMs: 1000,
        },
      })
      if (scenario !== 'missing-handle') {
        const handle = nativeHandle('scripted', 'unavailable-native', h.workspacePath)
        if (scenario === 'wrong-host') handle.host = 'other-machine'
        if (scenario === 'wrong-workspace') handle.workspacePath = '/other/workspace'
        await h.store.append(SLUG, {
          actor: KERNEL,
          type: 'session.native-handle-recorded',
          payload: {
            session: 'lost',
            phase: 'plan',
            round: 1,
            handle,
          },
        })
      }
      if (scenario === 'missing-state') {
        await h.store.append(SLUG, {
          actor: KERNEL,
          type: 'session.suspended',
          payload: {
            session: 'lost',
            phase: 'plan',
            round: 1,
            handle: nativeHandle('scripted', 'unavailable-native', h.workspacePath),
            cause: 'shutdown',
            activeMs: 900,
            transcript: { kind: 'transcript', rev: 0 },
            usage: { inputTokens: 17, outputTokens: 19, turns: 1 },
          },
        })
      }
      await h.br.attach()
      await h.br.step()
      expect(starts).toBe(1)
      expect(resumes).toBe(scenario === 'missing-state' ? 1 : 0)
      const events = await h.store.getEvents(SLUG)
      const fallback = ofType(events, 'session.resume-fallback')
      expect(fallback).toHaveLength(1)
      expect(fallback[0]!.payload.reason).toContain(
        scenario === 'remote'
          ? 'workspace-not-local'
          : scenario === 'unsupported'
            ? 'unsupported-runtime'
            : scenario,
      )
      if (scenario === 'missing-state') {
        expect(timers.delays).toEqual([100, 1000])
        const brackets = ofType(events, 'session.started')
        expect(brackets).toHaveLength(3)
        const fresh = brackets.at(-1)!.payload
        expect(fresh.continuation).toBeUndefined()
        expect(fresh.session).not.toBe(brackets[1]!.payload.session)
        const totals = reduceBuild(events).sessions.totals
        expect(totals.lost?.usage).toEqual({ inputTokens: 17, outputTokens: 19, turns: 1 })
        expect(totals[fresh.session]).toBeDefined()
        const transcript = (await h.store.listArtifacts(SLUG, 'transcript')).find(
          (artifact) => artifact.metadata.session === fresh.session,
        )
        expect(transcript).toBeDefined()
        expect(transcript!.metadata.interruptionPrompt).toBeUndefined()
        expect(ofType(events, 'phase.failed')).toHaveLength(0)
      }
      expect(ofType(events, 'plan.completed')).toHaveLength(1)
      expect((await readBuildFacts(h.store, SLUG)).value.state.sessions.open).toEqual([])
    })
  }

  test('a real provider failure during resume follows failure policy without a fresh rerun', async () => {
    const { nativeHandle } = await import('../ports/runner/native-session')
    let starts = 0
    const runner: AgentRunner = {
      name: 'scripted',
      async start() {
        starts++
        throw new Error('unexpected fresh launch')
      },
      async continue() {
        throw new Error('unexpected continuation')
      },
      async resume() {
        return {
          kind: 'resumed',
          session: { id: 'failed', runner: 'scripted' },
          result: failedTurnResult('provider unavailable', false, '', 'availability'),
        }
      },
      async end() {
        return {
          content: 'provider unavailable',
          metadata: { runner: 'scripted', usage: { inputTokens: 0, outputTokens: 0, turns: 1 } },
        }
      },
    }
    const h = await makeHarness({
      workspaceProvider: 'git-worktree',
      runtimeRunner: runner,
      clock: () => new Date(),
    })
    await h.store.append(SLUG, { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'session.started',
      payload: {
        session: 'lost',
        role: 'plan',
        runner: 'scripted',
        phase: 'plan',
        round: 1,
      },
    })
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'session.native-handle-recorded',
      payload: {
        session: 'lost',
        phase: 'plan',
        round: 1,
        handle: nativeHandle('scripted', 'native', h.workspacePath),
      },
    })
    await h.br.attach()
    await h.br.step()
    expect(starts).toBe(0)
    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'session.resume-fallback')).toHaveLength(0)
    expect(ofType(events, 'phase.failed')[0]?.payload.error).toBe('provider unavailable')
  })
})

describe('native continuation budget and stale acceptance', () => {
  for (const activeMs of [400, 1000])
    test(`a ${activeMs}ms segment retains its budget across a day suspended`, async () => {
      const { nativeHandle } = await import('../ports/runner/native-session')
      const clock = manualClock()
      const timers = new ManualSessionBudgetScheduler()
      let resumes = 0
      let starts = 0
      let observe: import('../ports/types').NativeSessionObserver | undefined
      const runner: AgentRunner = {
        name: 'scripted',
        async start() {
          starts++
          throw new Error('unexpected fresh start')
        },
        async continue() {
          throw new Error('unexpected continue')
        },
        async resume(_handle, _message, opts) {
          resumes++
          observe = opts.onNativeSession
          return {
            kind: 'resumed',
            session: { id: 'native', runner: 'scripted' },
            result: {
              kind: 'completed',
              text: 'partial resumed work',
              usage: { inputTokens: 2, outputTokens: 4, turns: 1 },
            },
          }
        },
        async end() {
          return {
            content: 'partial resumed work',
            metadata: { runner: 'scripted', usage: { inputTokens: 2, outputTokens: 4, turns: 1 } },
          }
        },
      }
      const h = await makeHarness({
        clock,
        workspaceProvider: 'git-worktree',
        runtimeRunner: runner,
        runnerOpts: { scheduleSessionBudget: timers.schedule },
      })
      const handle = nativeHandle('scripted', 'native', h.workspacePath)
      await h.store.append(SLUG, { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
      await h.store.append(SLUG, {
        actor: KERNEL,
        type: 'session.started',
        payload: {
          session: 'old',
          role: 'plan',
          runner: 'scripted',
          phase: 'plan',
          round: 1,
          budgetMs: 1000,
        },
      })
      await h.store.append(SLUG, {
        actor: KERNEL,
        type: 'session.suspended',
        payload: {
          session: 'old',
          phase: 'plan',
          round: 1,
          handle,
          cause: 'shutdown',
          activeMs,
          transcript: { kind: 'transcript', rev: 0 },
          usage: { inputTokens: 1, outputTokens: 2, turns: 1 },
        },
      })
      clock.advance(86400000)
      await h.br.attach()
      await h.br.step()
      expect(timers.delays).toEqual([1000 - activeMs])
      expect(starts).toBe(0)
      expect(resumes).toBe(activeMs < 1000 ? 1 : 0)
      if (activeMs < 1000) {
        const before = reduceBuild(await h.store.getEvents(SLUG)).sessions
        expect(before.totals.old?.usage).toEqual({ inputTokens: 3, outputTokens: 6, turns: 2 })
        // The old callback arrives after the segment has closed and a new bracket
        // supersedes it; the accepted native identity must not become current.
        const predecessor = ofType(await h.store.getEvents(SLUG), 'session.started').at(-1)!.payload
          .session
        await h.store.append(SLUG, {
          actor: KERNEL,
          type: 'session.started',
          payload: {
            session: 'replacement',
            role: 'plan',
            runner: 'scripted',
            phase: 'plan',
            round: 1,
            continuation: {
              predecessor,
              root: 'old',
              handle,
              cause: 'runner-loss',
              activeMs,
              budgetMs: 1000,
            },
          },
        })
        const superseded = reduceBuild(await h.store.getEvents(SLUG)).sessions
        await observe?.(handle)
        const events = await h.store.getEvents(SLUG)
        expect(ofType(events, 'session.resumed').at(-1)?.payload.stale).toBe(true)
        expect(reduceBuild(events).sessions).toEqual(superseded)
      } else {
        expect(ofType(await h.store.getEvents(SLUG), 'phase.failed')[0]?.payload.error).toContain(
          'budget expired',
        )
      }
    })
})

test('a phase terminal merge after attachment settles the old bracket before starting the next phase', async () => {
  const { nativeHandle } = await import('../ports/runner/native-session')
  const h = await makeHarness({ workspaceProvider: 'git-worktree', clock: () => new Date() })
  await h.store.append(SLUG, { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
  await h.store.append(SLUG, {
    actor: KERNEL,
    type: 'session.started',
    payload: {
      session: 'lost',
      role: 'plan',
      runner: 'scripted',
      phase: 'plan',
      round: 1,
    },
  })
  await h.store.append(SLUG, {
    actor: KERNEL,
    type: 'session.native-handle-recorded',
    payload: {
      session: 'lost',
      phase: 'plan',
      round: 1,
      handle: nativeHandle('scripted', 'native', h.workspacePath),
    },
  })
  await h.br.attach()
  await h.store.appendWithArtifacts(
    SLUG,
    [{ kind: 'plan', content: '# Finished plan' }],
    (deposited) => ({
      actor: agentActor('plan', 'lost'),
      type: 'plan.completed',
      payload: {
        round: 1,
        artifact: refOf(deposited),
        verifySteps: ['types', 'unit', 'e2e'],
      },
    }),
  )
  await h.br.step()
  const events = await h.store.getEvents(SLUG)
  expect(ofType(events, 'plan-review.started')).toHaveLength(1)
  expect(ofType(events, 'session.resumed')).toHaveLength(0)
  expect(ofType(events, 'session.resume-fallback')).toHaveLength(0)
  expect(
    ofType(events, 'session.ended').find((e) => e.payload.session === 'lost')?.payload,
  ).toMatchObject({ outcome: 'reclaimed' })
})

test('a pending resume control is acknowledged before selecting suspended native work', async () => {
  const { nativeHandle } = await import('../ports/runner/native-session')
  let resumes = 0
  const runner: AgentRunner = {
    name: 'scripted',
    async start() {
      throw new Error('unexpected fresh turn')
    },
    async continue() {
      throw new Error('unexpected continue')
    },
    async resume() {
      resumes++
      return {
        kind: 'resumed',
        session: { id: 'native', runner: 'scripted' },
        result: failedTurnResult('provider unavailable', false, '', 'availability'),
      }
    },
    async end() {
      return {
        content: 'partial',
        metadata: { runner: 'scripted', usage: { inputTokens: 0, outputTokens: 0, turns: 1 } },
      }
    },
  }
  const h = await makeHarness({ workspaceProvider: 'git-worktree', runtimeRunner: runner })
  await h.store.append(SLUG, { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
  await h.store.append(SLUG, {
    actor: KERNEL,
    type: 'session.started',
    payload: {
      session: 'old',
      role: 'plan',
      runner: 'scripted',
      phase: 'plan',
      round: 1,
    },
  })
  await h.store.append(SLUG, {
    actor: KERNEL,
    type: 'session.suspended',
    payload: {
      session: 'old',
      phase: 'plan',
      round: 1,
      handle: nativeHandle('scripted', 'native', h.workspacePath),
      cause: 'shutdown',
      activeMs: 10,
      transcript: { kind: 'transcript', rev: 0 },
    },
  })
  await h.store.append(SLUG, { actor: KERNEL, type: 'build.paused', payload: {} })
  await h.store.append(SLUG, {
    actor: humanActor('operator'),
    type: 'build.resume-requested',
    payload: {},
  })
  await h.br.attach()
  await h.br.step()
  expect(resumes).toBe(1)
  expect(ofType(await h.store.getEvents(SLUG), 'build.resumed')).toHaveLength(1)
})

test('a budget that expires during credential delegation cannot launch a late native or fresh process', async () => {
  const { nativeHandle } = await import('../ports/runner/native-session')
  const timers = new ManualSessionBudgetScheduler()
  let unblock!: () => void
  let ready!: () => void
  const gate = new Promise<void>((r) => {
    unblock = r
  })
  const delegating = new Promise<void>((r) => {
    ready = r
  })
  let launches = 0
  const runner: AgentRunner = {
    name: 'scripted',
    async start() {
      launches++
      throw new Error('unexpected start')
    },
    async resume() {
      launches++
      throw new Error('unexpected resume')
    },
    async continue() {
      throw new Error('unexpected continue')
    },
    async end() {
      throw new Error('unexpected end')
    },
  }
  const h = await makeHarness({
    workspaceProvider: 'git-worktree',
    runtimeRunner: runner,
    clock: () => new Date(),
    runnerOpts: { scheduleSessionBudget: timers.schedule },
    sessionEnv: { AB_STORE: 'https://store.example', AB_TOKEN: 'parent' },
    delegateCredential: async () => {
      ready()
      await gate
      return 'delegated'
    },
  })
  await h.store.append(SLUG, { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
  await h.store.append(SLUG, {
    actor: KERNEL,
    type: 'session.started',
    payload: {
      session: 'old',
      role: 'plan',
      runner: 'scripted',
      phase: 'plan',
      round: 1,
    },
  })
  await h.store.append(SLUG, {
    actor: KERNEL,
    type: 'session.native-handle-recorded',
    payload: {
      session: 'old',
      phase: 'plan',
      round: 1,
      handle: nativeHandle('scripted', 'native', h.workspacePath),
    },
  })
  await h.br.attach()
  const turning = h.br.step()
  await delegating
  await timers.expireNext()
  await turning
  unblock()
  await Bun.sleep(0)
  expect(launches).toBe(0)
})

test('a terminal winning while the continuation stream opens prevents native launch', async () => {
  const { nativeHandle } = await import('../ports/runner/native-session')
  let h!: Harness
  let complete = true
  h = await makeHarness({
    workspaceProvider: 'git-worktree',
    clock: () => new Date(),
    registrationExtras: {
      openSessionStream: async (_sink, info) => {
        if (info.role === 'plan' && complete) {
          complete = false
          await h.store.append(SLUG, {
            actor: agentActor('plan', 'old'),
            type: 'plan.completed',
            payload: {
              round: 1,
              artifact: { kind: 'plan', rev: 0 },
              verifySteps: ['types', 'unit', 'e2e'],
            },
          })
        }
        return undefined
      },
    },
  })
  await h.store.putArtifact(SLUG, { kind: 'plan', content: '# Finished plan' })
  await h.store.append(SLUG, { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
  await h.store.append(SLUG, {
    actor: KERNEL,
    type: 'session.started',
    payload: {
      session: 'old',
      role: 'plan',
      runner: 'scripted',
      phase: 'plan',
      round: 1,
    },
  })
  await h.store.append(SLUG, {
    actor: KERNEL,
    type: 'session.native-handle-recorded',
    payload: {
      session: 'old',
      phase: 'plan',
      round: 1,
      handle: nativeHandle('scripted', 'native', h.workspacePath),
    },
  })
  await h.br.attach()
  await h.br.step()
  expect(h.runner.sessions.size).toBe(0)
  expect(ofType(await h.store.getEvents(SLUG), 'session.started')).toHaveLength(1)
  await h.br.step()
  expect(ofType(await h.store.getEvents(SLUG), 'plan-review.started')).toHaveLength(1)
})

describe('classified own-build reads', () => {
  test('persistent context read failures park once per explicit authorization without spending phase failures', async () => {
    let calls = 0
    let repaired = false
    const h = await makeHarness({
      handlers: (store) => ({
        plan: async (ctx) => {
          calls++
          if (repaired) return happyHandlers(store).plan!(ctx)
          const read = store.getReducerValue.bind(store)
          store.getReducerValue = async () => {
            throw new Error('own build unreadable')
          }
          try {
            await expect(
              buildContext({
                store,
                env: {
                  store: 'local',
                  build: SLUG,
                  phase: 'plan',
                  round: 1,
                  session: sessionOf(ctx),
                },
                workspacePath: ctx.opts.workspacePath,
              }),
            ).rejects.toThrow('own build unreadable')
          } finally {
            store.getReducerValue = read
          }
          return defaultTurnResult('context failed')
        },
      }),
    })
    await h.br.attach()
    for (let episode = 1; episode <= 4; episode++) {
      await h.br.step()
      for (let replay = 0; replay < 3; replay++)
        expect(await h.br.step()).toEqual({ kind: 'wait', reason: 'blocked' })
      const events = await h.store.getEvents(SLUG)
      expect(calls).toBe(episode)
      expect(ofType(events, 'phase.failed')).toHaveLength(0)
      expect(ofType(events, 'phase.deferred')).toHaveLength(episode)
      const raises = ofType(events, 'phase.deferral-escalated')
      expect(raises).toHaveLength(episode)
      expect(reduceBuild(events).status).toBe('blocked')
      await h.store.append(SLUG, {
        actor: humanActor('operator'),
        type: 'escalation.answered',
        payload: {
          id: raises.at(-1)!.payload.id,
          answer: 'access repaired',
          resolution: episode % 2 ? 'retry' : 'guidance',
        },
      })
    }
    repaired = true
    await h.br.step()
    expect(ofType(await h.store.getEvents(SLUG), 'plan.completed')).toHaveLength(1)
    expect(ofType(await h.store.getEvents(SLUG), 'phase.failed')).toHaveLength(0)
  })

  for (const settled of [false, true])
    test(`repairs crash gap after ${settled ? 'deferral' : 'session end'} without an agent`, async () => {
      const h = await makeHarness({
        handlers: () => ({
          plan: () => {
            throw new Error('must not launch')
          },
        }),
      })
      await h.br.attach()
      await h.store.append(SLUG, {
        actor: KERNEL,
        type: 'session.started',
        payload: { session: 's_crash', role: 'plan', runner: 'scripted', phase: 'plan', round: 1 },
      })
      await h.store.append(SLUG, {
        actor: KERNEL,
        type: 'session.build-read-failed',
        payload: {
          session: 's_crash',
          phase: 'plan',
          round: 1,
          operation: 'context',
          reason: 'own-build-read',
          diagnostic: 'unreadable',
        },
      })
      await h.store.append(SLUG, {
        actor: KERNEL,
        type: 'session.ended',
        payload: {
          session: 's_crash',
          outcome: 'reclaimed',
          reclaimedBy: { instance: 'prior', resumedFromSeq: 0 },
        },
      })
      if (settled)
        await h.store.append(SLUG, {
          actor: KERNEL,
          type: 'phase.deferred',
          payload: {
            session: 's_crash',
            phase: 'plan',
            round: 1,
            reason: 'own-build-read',
            diagnostic: 'unreadable',
          },
        })
      expect((await h.br.step()).kind).toBe('raise-read-deferral')
      expect(await h.br.step()).toEqual({ kind: 'wait', reason: 'blocked' })
      const events = await h.store.getEvents(SLUG)
      expect(ofType(events, 'phase.deferred')).toHaveLength(1)
      expect(ofType(events, 'phase.deferral-escalated')).toHaveLength(1)
      expect(ofType(events, 'phase.failed')).toHaveLength(0)
      expect(h.runner.sessions.size).toBe(0)
    })
})

test('a deferral answer preserves a genuine failure, and the next ordinary failure still exhausts', async () => {
  let calls = 0
  const h = await makeHarness({
    handlers: (store) => ({
      plan: async (ctx) => {
        calls++
        if (calls === 1)
          await store.append(SLUG, {
            actor: KERNEL,
            type: 'session.build-read-failed',
            payload: {
              session: sessionOf(ctx),
              phase: 'plan',
              round: 1,
              operation: 'context',
              reason: 'own-build-read',
              diagnostic: 'cannot read',
            },
          })
        return defaultTurnResult('no terminal')
      },
    }),
  })
  await h.store.append(SLUG, {
    actor: KERNEL,
    type: 'phase.failed',
    payload: {
      phase: 'plan',
      round: 1,
      attempt: 1,
      error: 'real previous failure',
      willRetry: true,
    },
  })
  await h.br.attach()
  await h.br.step()
  const raise = ofType(await h.store.getEvents(SLUG), 'phase.deferral-escalated')[0]!
  await h.store.append(SLUG, {
    actor: humanActor('operator'),
    type: 'escalation.answered',
    payload: { id: raise.payload.id, answer: 'fixed', resolution: 'retry' },
  })
  await h.br.step()
  await h.br.step()
  const events = await h.store.getEvents(SLUG)
  expect(ofType(events, 'phase.failed').map((event) => event.payload.attempt)).toEqual([1, 2])
  expect(ofType(events, 'escalation.raised').at(-1)!.payload.policyCause).toBe(
    'phase-attempt-limit',
  )
  expect(calls).toBe(2)
})

for (const role of ['verify-e2e', 'release-notes'] as const)
  test(`${role} read failure parks its distinct agent path before completion`, async () => {
    const h = await makeHarness({
      handlers: (store) => ({
        ...happyHandlers(store),
        [role]: async (ctx: ScriptContext) => {
          const { phase, round } = parseAbPhase(ctx.opts.env.AB_PHASE!)
          await store.append(SLUG, {
            actor: KERNEL,
            type: 'session.build-read-failed',
            payload: {
              session: sessionOf(ctx),
              phase,
              round,
              operation: 'context',
              reason: 'own-build-read',
              diagnostic: 'cannot read contract',
            },
          })
          return defaultTurnResult('context unavailable')
        },
      }),
    })
    const state = await h.br.run()
    expect(state.status).toBe('blocked')
    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'phase.failed')).toHaveLength(0)
    expect(ofType(events, 'phase.deferral-escalated')).toHaveLength(1)
    if (role === 'release-notes') expect(ofType(events, 'finalize.step-completed')).toHaveLength(0)
    else
      expect(
        ofType(events, 'verify.completed').filter((event) => event.payload.step === 'e2e'),
      ).toHaveLength(0)
  })

test('same-turn context recovery and a valid terminal override the read marker', async () => {
  const h = await makeHarness({
    handlers: (store) => ({
      plan: async (ctx) => {
        await store.append(SLUG, {
          actor: KERNEL,
          type: 'session.build-read-failed',
          payload: {
            session: sessionOf(ctx),
            phase: 'plan',
            round: 1,
            operation: 'context',
            reason: 'own-build-read',
            diagnostic: 'transient',
          },
        })
        return happyHandlers(store).plan!(ctx)
      },
    }),
  })
  await h.br.attach()
  await h.br.step()
  const events = await h.store.getEvents(SLUG)
  expect(ofType(events, 'plan.completed')).toHaveLength(1)
  expect(ofType(events, 'phase.deferred')).toHaveLength(0)
  expect(ofType(events, 'phase.failed')).toHaveLength(0)
  expect((await h.br.step()).kind).toBe('run-phase')
})

test('finalize post-step expiry still parks classified read evidence before recording an outcome', async () => {
  const timers = new ManualSessionBudgetScheduler()
  let signalRead!: () => void
  const readRecorded = new Promise<void>((resolve) => {
    signalRead = resolve
  })
  const h = await makeHarness({
    runnerOpts: { scheduleSessionBudget: timers.schedule },
    handlers: (store) => ({
      ...happyHandlers(store),
      'release-notes': async (ctx) => {
        await store.append(SLUG, {
          actor: KERNEL,
          type: 'session.build-read-failed',
          payload: {
            session: sessionOf(ctx),
            phase: 'finalize',
            round: 1,
            operation: 'context',
            reason: 'own-build-read',
            diagnostic: 'unreadable before expiry',
          },
        })
        signalRead()
        return new Promise<AgentTurnResult>(() => {})
      },
    }),
  })
  const running = h.br.run()
  await readRecorded
  await timers.expireNext()
  expect((await running).status).toBe('blocked')
  const events = await h.store.getEvents(SLUG)
  expect(ofType(events, 'phase.deferral-escalated')).toHaveLength(1)
  expect(ofType(events, 'finalize.step-completed')).toHaveLength(0)
  expect(ofType(events, 'phase.failed')).toHaveLength(0)
})

test('runtime companion append failure prevents phase work after attach', async () => {
  const h = await makeHarness()
  const append = h.store.append.bind(h.store)
  h.store.append = async (...args) => {
    if (args[1].type === 'runner.runtime-recorded') throw new Error('runtime metadata unavailable')
    return append(...args)
  }
  await expect(h.br.run()).rejects.toThrow('runtime metadata unavailable')
  const events = await h.store.getEvents(SLUG)
  expect(ofType(events, 'runner.attached')).toHaveLength(1)
  expect(ofType(events, 'runner.runtime-recorded')).toHaveLength(0)
  expect(ofType(events, 'plan.started')).toHaveLength(0)
})

describe('accepted runtime relaunch at phase boundaries', () => {
  const target = { ...RUNTIME_IDENTITY, commit: 'f'.repeat(40) }
  async function authorize(store: BuildStore, instance = 'runner-1', to = target) {
    await store.append(SLUG, {
      actor: DISPATCHER,
      type: 'execution.drain-authorized',
      payload: {
        instance,
        correlation: 'handoff-1',
        run: 'dispatch-old',
        runtime: RUNTIME_IDENTITY,
        targetRuntime: to,
      },
    })
  }

  for (const remote of [false, true])
    test(`a target accepted during plan lets plan finish but starts no review (remote: ${remote})`, async () => {
      const h = await makeHarness({
        workspaceRemote: remote,
        handlers: (store) => {
          const handlers = happyHandlers(store)
          return {
            ...handlers,
            plan: async (ctx) => {
              await authorize(store)
              return handlers.plan!(ctx)
            },
          }
        },
      })
      await h.br.run()
      const events = await h.store.getEvents(SLUG)
      expect(ofType(events, 'plan.completed')).toHaveLength(1)
      expect(ofType(events, 'session.ended')).toHaveLength(1)
      expect(ofType(events, 'plan-review.started')).toHaveLength(0)
      expect(ofType(events, 'execution.relaunch-requested')).toHaveLength(1)
      expect(ofType(events, 'execution.relaunch-requested')[0]!.payload).toEqual({
        instance: 'runner-1',
        correlation: 'handoff-1',
        from: RUNTIME_IDENTITY,
        to: target,
      })
      await h.br.run()
      expect(ofType(await h.store.getEvents(SLUG), 'execution.relaunch-requested')).toHaveLength(1)
    })

  test('a fresh owner resumes the next phase on the accepted runtime from durable state', async () => {
    const old = await makeHarness({
      handlers: (store) => {
        const handlers = happyHandlers(store)
        return {
          ...handlers,
          plan: async (ctx) => {
            await authorize(store)
            return handlers.plan!(ctx)
          },
        }
      },
    })
    await old.br.run()
    await old.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'execution.ended',
      payload: { instance: 'runner-1', workspaceRef: 'local', outcome: 'relaunch', exitCode: 0 },
    })
    await old.store.releaseLease(SLUG, 'runner-1')
    // No process memory or repository lease is needed to preserve the handoff.
    const successor = await makeHarness({
      store: old.store,
      seedPrelude: false,
      instance: 'runner-2',
      runtimeIdentity: target,
    })
    await successor.br.run()
    const events = await old.store.getEvents(SLUG)
    expect(ofType(events, 'runner.runtime-recorded').map((e) => e.payload.runtime)).toEqual([
      RUNTIME_IDENTITY,
      target,
    ])
    expect(ofType(events, 'plan.completed')).toHaveLength(1)
    expect(ofType(events, 'plan-review.started')).toHaveLength(1)
    expect(ofType(events, 'execution.relaunch-requested')).toHaveLength(1)
  })

  test('a target accepted during a deterministic check lets only that check complete', async () => {
    const h = await makeHarness({
      beforeExec: async (cmd, store) => {
        if (cmd[0] === 'sh' && cmd[2] === 'bun tsc --noEmit') await authorize(store)
      },
    })
    await seedCodeApproved(h.store)
    await h.br.run()
    const events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'verify.completed').map((e) => e.payload.step)).toEqual(['types'])
    expect(ofType(events, 'execution.relaunch-requested')).toHaveLength(1)
    expect(h.execCalls.some((c) => c.cmd[2] === 'bun test')).toBe(false)
  })

  test('unchanged target adds no Store reads at boundaries', async () => {
    async function countReads(equalTarget: boolean) {
      const h = await makeHarness()
      if (equalTarget) await authorize(h.store, 'runner-1', RUNTIME_IDENTITY)
      const reads = spyOn(h.store, 'getReducerValue')
      try {
        await h.br.run()
        return reads.mock.calls.length
      } finally {
        reads.mockRestore()
      }
    }
    expect(await countReads(true)).toBe(await countReads(false))
  })

  test('failed request deposit rejects instead of returning a successful relaunch', async () => {
    const h = await makeHarness()
    await authorize(h.store)
    const original = h.store.appendIfCurrent.bind(h.store)
    const append = spyOn(h.store, 'appendIfCurrent').mockImplementation(
      async (slug, seq, event) => {
        if (event.type === 'execution.relaunch-requested') throw new Error('request write failed')
        return original(slug, seq, event)
      },
    )
    try {
      await expect(h.br.run()).rejects.toThrow('request write failed')
      expect(ofType(await h.store.getEvents(SLUG), 'execution.relaunch-requested')).toHaveLength(0)
    } finally {
      append.mockRestore()
    }
  })

  for (const kind of ['equal', 'foreign', 'settled'] as const) {
    test(`${kind} target does not request relaunch`, async () => {
      const h = await makeHarness()
      await authorize(
        h.store,
        kind === 'foreign' ? 'another-runner' : 'runner-1',
        kind === 'equal' ? RUNTIME_IDENTITY : target,
      )
      if (kind === 'settled')
        await h.store.append(SLUG, {
          actor: DISPATCHER,
          type: 'execution.drain-settled',
          payload: { instance: 'runner-1', correlation: 'handoff-1' },
        })
      await h.br.run()
      expect(ofType(await h.store.getEvents(SLUG), 'execution.relaunch-requested')).toHaveLength(0)
    })
  }
})

test('continued producer prompts route all feedback to the receiving directory', async () => {
  const cases: Array<{ feedback?: import('../ontology').Feedback; pointer: string }> = [
    { feedback: undefined, pointer: '$AB_CONTEXT_DIR/' },
    { feedback: { findings: ['f_1'] }, pointer: '$AB_CONTEXT_DIR/findings.json' },
    {
      feedback: { verify: { step: 'e2e', report: { kind: 'verify-report:e2e', rev: 0 } } },
      pointer: '$AB_CONTEXT_DIR/verify/',
    },
    {
      feedback: { guidance: { escalation: 'esc_resume', answer: 'Continue with this scope.' } },
      pointer: '$AB_CONTEXT_DIR/',
    },
  ]
  for (const item of cases) {
    const h = await makeHarness()
    await h.br.step() // plan
    await h.br.step() // approve plan
    await h.br.step() // first implement turn
    // Exercise the runner invocation seam with each durable decision shape.
    // biome-ignore lint/complexity/useLiteralKeys: Exercise the private runner seam without widening its production API.
    await h.br['runPhase']({
      kind: 'run-phase',
      phase: 'implement',
      round: 2,
      ...(item.feedback ? { feedback: structuredClone(item.feedback) } : {}),
    })
    const journal = [...h.runner.sessions.values()].find(
      (entry) => entry.opts.skill === 'ab-implement',
    )!
    expect(journal.messages).toHaveLength(1)
    expect(journal.messages[0]).toContain(item.pointer)
    expect(journal.messages[0]).toContain('refresh $AB_CONTEXT_DIR/')
    expect(journal.messages[0]).not.toContain('.ab/')
    expect(journal.opts.env.AB_CONTEXT_DIR).toBe('.ab/implement')
  }
})

test('a stage starts both checks before either resolves and collects both failures before routing', async () => {
  type Result = { stdout: string; stderr: string; exitCode: number }
  const releases = new Map<string, (result: Result) => void>()
  let bothStarted!: () => void
  const launched = new Promise<void>((resolve) => {
    bothStarted = resolve
  })
  const h = await makeHarness({
    configToml: CONFIG_TOML.replace(
      'steps = ["types", "unit", "e2e"]',
      'steps = [["types", "unit"], "e2e"]',
    ),
    checkExec: async (cmd) =>
      new Promise<Result>((resolve) => {
        releases.set(cmd[2]!, resolve)
        if (releases.size === 2) bothStarted()
      }),
  })
  await seedPlanApproved(h.store)
  await seedCodeApproved(h.store)
  await h.br.attach()
  let finished = false
  const work = h.br.step().then((decision) => {
    finished = true
    return decision
  })
  await launched
  expect(
    (await h.store.getEvents(SLUG))
      .filter((e) => e.type === 'verify.started')
      .map((e) => e.payload.step)
      .slice(-2),
  ).toEqual(['types', 'unit'])
  releases.get('bun tsc --noEmit')!({ stdout: 'types failure', stderr: '', exitCode: 1 })
  await new Promise<void>((resolve) => {
    const stop = h.store.subscribe(SLUG, { fromSeq: 0, pollMs: 1 }, (event) => {
      if (event.type === 'verify.completed' && event.payload.step === 'types') {
        stop()
        resolve()
      }
    })
  })
  expect(finished).toBe(false)
  expect(
    (await h.store.getEvents(SLUG)).some(
      (e) => e.type === 'implement.started' && e.payload.round === 2,
    ),
  ).toBe(false)
  releases.get('bun test')!({ stdout: 'unit failure', stderr: '', exitCode: 1 })
  await work
  expect((await h.br.step()).kind).toBe('record-verify-stage-failure')
  const receipts = (await h.store.getEvents(SLUG)).filter((e) => e.type === 'verify.stage-failed')
  expect(receipts).toHaveLength(1)
  expect(receipts[0]!.payload.failed.map((f) => f.step)).toEqual(['types', 'unit'])
  await h.store.append(SLUG, {
    actor: KERNEL,
    type: 'implement.started',
    payload: {
      round: 2,
      verifyStageFailure: receipts[0]!.seq,
      feedback: { guidance: { escalation: 'operator', answer: 'Address both reports' } },
    },
  })
  const manifest = await buildContext({
    store: h.store,
    workspacePath: h.workspacePath,
    env: { store: 'local', build: SLUG, phase: 'implement', round: 2, session: 's_aggregate' },
  })
  expect(manifest.feedback).toEqual({
    guidance: { escalation: 'operator', answer: 'Address both reports' },
  })
  expect(manifest.verifyReports?.map((report) => report.step)).toEqual(['types', 'unit'])
  for (const report of manifest.verifyReports ?? [])
    expect(await readFile(join(h.workspacePath, report.path), 'utf8')).toContain(
      `${report.step} failure`,
    )
})

test('fail-fast records cancellation and exits for supervised teardown before implement', async () => {
  type Result = { stdout: string; stderr: string; exitCode: number }
  const releases = new Map<string, (result: Result) => void>()
  let started!: () => void
  const launched = new Promise<void>((resolve) => {
    started = resolve
  })
  const h = await makeHarness({
    configToml: CONFIG_TOML.replace(
      'steps = ["types", "unit", "e2e"]',
      'steps = [["types", "unit"], "e2e"]',
    ).replace('[verify.types]', '[verify.types]\nfailFast=true'),
    checkExec: async (cmd) =>
      new Promise<Result>((resolve) => {
        releases.set(cmd[2]!, resolve)
        if (releases.size === 2) started()
      }),
  })
  await seedPlanApproved(h.store)
  await seedCodeApproved(h.store)
  await h.br.attach()
  const running = h.br.step()
  await launched
  releases.get('bun tsc --noEmit')!({ stdout: 'failure', stderr: '', exitCode: 1 })
  await running
  expect((await h.br.step()).kind).toBe('restart-execution')
  const state = await h.br.run()
  expect(state.verifyStage.cancellations['["unit",1]']?.cause.step).toBe('types')
  expect(
    (await h.store.getEvents(SLUG)).some(
      (e) => e.type === 'implement.started' && e.payload.round === 2,
    ),
  ).toBe(false)
  releases.get('bun test')!({ stdout: 'late result', stderr: '', exitCode: 0 })
  await Promise.resolve()
  expect(
    (await h.store.getEvents(SLUG)).some(
      (e) => e.type === 'verify.completed' && e.payload.step === 'unit',
    ),
  ).toBe(false)
  await h.store.append(SLUG, {
    actor: DISPATCHER,
    type: 'execution.started',
    payload: { instance: 'replacement', workspaceRef: h.workspacePath, provider: 'test' },
  })
  expect((await h.br.step()).kind).toBe('record-verify-stage-failure')
  const receipt = (await h.store.getEvents(SLUG)).find((e) => e.type === 'verify.stage-failed')!
  await h.store.append(SLUG, {
    actor: KERNEL,
    type: 'implement.started',
    payload: { round: 2, verifyStageFailure: receipt.seq },
  })
  const manifest = await buildContext({
    store: h.store,
    workspacePath: h.workspacePath,
    env: {
      store: 'local',
      build: SLUG,
      phase: 'implement',
      round: 2,
      session: 's_cancelled_context',
    },
  })
  expect(manifest.cancelledVerify).toEqual([
    { step: 'unit', attempt: 1, cause: { step: 'types' }, status: 'not-run' },
  ])
})

test('fail-fast durably cancels and ends an agent that ignores abort before requesting execution replacement', async () => {
  let checkReady!: () => void
  let agentReady!: () => void
  const checkStarted = new Promise<void>((resolve) => {
    checkReady = resolve
  })
  const agentStarted = new Promise<void>((resolve) => {
    agentReady = resolve
  })
  let fail!: (result: { stdout: string; stderr: string; exitCode: number }) => void
  let cancelledSession = ''
  const h = await makeHarness({
    configToml: CONFIG_TOML.replace(
      'steps = ["types", "unit", "e2e"]',
      'steps = [["types", "e2e"], "unit"]',
    ).replace('[verify.types]', '[verify.types]\nfailFast=true'),
    checkExec: async () =>
      new Promise((resolve) => {
        fail = resolve
        checkReady()
      }),
    handlers: () => ({
      'ab-verify-e2e': async (ctx) => {
        cancelledSession = ctx.opts.env.AB_SESSION!
        agentReady()
        return new Promise(() => {})
      },
    }),
  })
  await seedPlanApproved(h.store)
  await seedCodeApproved(h.store)
  await h.br.attach()
  const work = h.br.step()
  await Promise.all([checkStarted, agentStarted])
  fail({ stdout: 'decisive failure', stderr: '', exitCode: 1 })
  await work
  const events = await h.store.getEvents(SLUG)
  const cancellation = events.find(
    (e) => e.type === 'verify.cancelled' && e.payload.step === 'e2e',
  )!
  const ended = events.find(
    (e) => e.type === 'session.ended' && e.payload.session === cancelledSession,
  )!
  expect(ended.seq).toBeGreaterThan(cancellation.seq)
  expect(events.some((e) => e.type === 'phase.failed')).toBe(false)
  expect((await h.br.step()).kind).toBe('restart-execution')
})

test('late verifier infrastructure failure after cancellation spends no retry budget', async () => {
  const h = await makeHarness()
  await h.store.append(SLUG, {
    actor: KERNEL,
    type: 'verify.cancelled',
    payload: { step: 'e2e', attempt: 1, cause: { step: 'types' } },
  })
  // biome-ignore lint/complexity/useLiteralKeys: intentional private-method test of the terminal write fence.
  await h.br['failPhase']('verify:e2e', 1, 0, 'late adapter error')
  expect((await h.store.getEvents(SLUG)).some((e) => e.type === 'phase.failed')).toBe(false)
})

test('two agent verifiers start concurrently in one workspace with separate contexts', async () => {
  let bothStarted!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    bothStarted = resolve
  })
  const finish = new Promise<void>((resolve) => {
    release = resolve
  })
  const contexts: Array<{ path: string; workspace: string; session: string }> = []
  const h = await makeHarness({
    configToml: `${CONFIG_TOML.replace(
      'steps = ["types", "unit", "e2e"]',
      'steps = ["types", "unit", ["e2e", "other"]]',
    )}\n[verify.other]\nkind="agent"\nskill="verify-other"\n`,
    handlers: (store) => {
      const handler: SkillHandler = async (ctx) => {
        contexts.push({
          path: ctx.opts.env.AB_CONTEXT_DIR!,
          workspace: ctx.opts.workspacePath,
          session: ctx.opts.env.AB_SESSION!,
        })
        if (contexts.length === 2) bothStarted()
        await finish
        const step = ctx.opts.env.AB_PHASE!.split('@')[0]!.slice(7)
        await store.append(SLUG, {
          actor: agentActor(step, ctx.opts.env.AB_SESSION!),
          type: 'verify.completed',
          payload: { step, attempt: roundOf(ctx), outcome: 'pass' },
        })
        return defaultTurnResult()
      }
      return { 'ab-verify-e2e': handler, 'verify-other': handler }
    },
  })
  await seedPlanApproved(h.store)
  await seedCodeApproved(h.store)
  await h.br.attach()
  await h.br.step() // types stage
  await h.br.step() // unit stage
  const work = h.br.step()
  await started
  expect(new Set(contexts.map((c) => c.path)).size).toBe(2)
  expect(new Set(contexts.map((c) => c.session)).size).toBe(2)
  expect(contexts.every((c) => c.workspace === h.workspacePath)).toBe(true)
  release()
  await work
  expect((await h.store.getEvents(SLUG)).some((e) => e.type === 'phase.failed')).toBe(false)
})

for (const interruption of ['crash', 'shutdown'] as const) {
  test(`a stage recovers both native agents and its unfinished check after ${interruption}`, async () => {
    const shutdown = new AbortController()
    const configToml = `${CONFIG_TOML.replace(
      'steps = ["types", "unit", "e2e"]',
      'steps = [["types", "unit", "e2e", "other"]]',
    )}\n[verify.other]\nkind="agent"\nskill="verify-other"\n`
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const seen = new Set<string>()
    const observe = (name: string) => {
      seen.add(name)
      if (seen.size === 3) started()
    }
    let destination: BuildStore
    const h = await makeHarness({
      configToml,
      nativeSessions: true,
      workspaceProvider: 'git-worktree',
      shutdownSignal: shutdown.signal,
      checkExec: async () => {
        observe('unit')
        return new Promise(() => {})
      },
      handlers: () => {
        const verify: SkillHandler = async (ctx) => {
          const step = ctx.opts.env.AB_PHASE!.split('@')[0]!.slice(7)
          if (!ctx.message) {
            observe(step)
            return new Promise(() => {})
          }
          expect(ctx.message).toContain(
            `interrupted (${interruption === 'crash' ? 'runner-loss' : 'shutdown'})`,
          )
          await destination.append(SLUG, {
            actor: agentActor(step, ctx.opts.env.AB_SESSION!),
            type: 'verify.completed',
            payload: { step, attempt: roundOf(ctx), outcome: 'pass' },
          })
          return defaultTurnResult()
        }
        return { 'ab-verify-e2e': verify, 'verify-other': verify }
      },
    })
    await seedPlanApproved(h.store)
    await seedCodeApproved(h.store)
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'verify.completed',
      payload: { step: 'types', attempt: 1, outcome: 'pass' },
    })
    await h.br.attach()
    const work = h.br.step()
    await ready
    const crashPrefix = await h.store.getEvents(SLUG)
    shutdown.abort()
    await work
    const stopped = await h.store.getEvents(SLUG)
    expect(
      ofType(stopped, 'session.suspended')
        .map((e) => e.payload.phase)
        .sort(),
    ).toEqual(['verify:e2e', 'verify:other'])
    const prefix = interruption === 'crash' ? crashPrefix : stopped
    const recoveredStore = new MemoryBuildStore()
    await recoveredStore.createBuild({
      slug: SLUG,
      repo: 'acme/app',
      ticket: TICKET,
      branch: BRANCH,
    })
    for (const meta of await h.store.listArtifacts(SLUG)) {
      const artifact = (await h.store.getArtifact(SLUG, meta.kind, meta.revision))!
      await recoveredStore.putArtifact(SLUG, {
        kind: meta.kind,
        content: artifact.content,
        metadata: meta.metadata,
      })
    }
    for (const event of prefix)
      await recoveredStore.append(SLUG, {
        actor: event.actor,
        type: event.type,
        payload: event.payload,
      } as EventWrite)
    destination = recoveredStore
    const checks: string[] = []
    let nextId = 1000
    const recoveredConfig = parseConfig(configToml)
    recoveredConfig.roles.default = { runtime: 'scripted' }
    const next = new BuildRunner({
      store: recoveredStore.scopeBuild(SLUG),
      config: recoveredConfig,
      runtimes: {
        scripted: { runner: h.runner, servesModels: ['m-'] },
        pi: { runner: h.runner, servesModels: ['kimi-'] },
        claude: { runner: h.runner, servesModels: ['claude-'] },
      },
      workspacePath: h.workspacePath,
      workspaceProvider: 'git-worktree',
      branch: BRANCH,
      slug: SLUG,
      forge: h.forge,
      clock: () => new Date(),
      instance: 'successor',
      host: 'sandbox-a',
      ids: (kind) => `${kind}_${++nextId}`,
      exec: async (cmd) => {
        if (cmd[0] === 'sh') checks.push(cmd[2]!)
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    })
    await next.attach()
    await next.step()
    const events = await recoveredStore.getEvents(SLUG)
    expect(checks).toEqual(['bun test'])
    expect(
      ofType(events, 'verify.completed')
        .map((e) => [e.payload.step, e.payload.attempt])
        .sort(),
    ).toEqual([
      ['e2e', 1],
      ['other', 1],
      ['types', 1],
      ['unit', 1],
    ])
    expect(ofType(events, 'verify.started').filter((e) => e.payload.step === 'types')).toHaveLength(
      1,
    )
    const resumptions = ofType(events, 'session.resumed')
    expect(resumptions).toHaveLength(2)
    expect(new Set(resumptions.map((e) => e.payload.handle.nativeId)).size).toBe(2)
    expect(resumptions.map((e) => e.payload.cause)).toEqual([
      interruption === 'crash' ? 'runner-loss' : 'shutdown',
      interruption === 'crash' ? 'runner-loss' : 'shutdown',
    ])
    expect(ofType(events, 'session.resume-fallback')).toHaveLength(0)
    expect(
      ofType(events, 'session.ended').filter(
        (e) => 'outcome' in e.payload && e.payload.outcome === 'reclaimed',
      ),
    ).toHaveLength(0)
    expect(reduceBuild(events).sessions.open).toHaveLength(0)
    await recoveredStore.close()
  })
}

test('mid-verify checkout rename repins before constructing the removed member', async () => {
  // The physical Git checkout exercises execution provenance; commands and agents
  // retain the existing harness ports so launched skills can be asserted.
  const { mkdtemp, rm } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'runner-verify-repin-'))
  try {
    const git = async (...args: string[]) => {
      const r = await spawnExec(['git', ...args], { cwd: root })
      if (r.exitCode) throw new Error(r.stderr)
      return r.stdout.trim()
    }
    await git('init', '-b', 'main')
    await git('config', 'user.email', 'test@example.com')
    await git('config', 'user.name', 'Test')
    const old = CONFIG_TOML.replaceAll('e2e', 'web-dashboard')
    await writeFile(join(root, 'autobuild.toml'), old)
    await git('add', '.')
    await git('commit', '-m', 'old pipeline')
    const h = await makeHarness({
      configToml: old,
      readVerifyPipeline: () => readVerifyPipeline(root, spawnExec),
    })
    await seedPlanApproved(h.store, ['types', 'unit', 'web-dashboard'])
    await seedCodeApproved(h.store)
    expect(await h.br.step()).toMatchObject({ kind: 'run-check', step: 'types' })
    const oldPin = (await readBuildFacts(h.store, SLUG)).value.state.verify.configPin!
    await writeFile(join(root, 'autobuild.toml'), old.replaceAll('web-dashboard', 'ui-app'))
    await git('add', '.')
    await git('commit', '-m', 'restack brings renamed verifier')
    const head = await git('rev-parse', 'HEAD')
    expect(await h.br.step()).toMatchObject({ kind: 'record-verify-selection-drift' })
    const state = (await readBuildFacts(h.store, SLUG)).value.state
    expect(state.verify.configPin).toMatchObject({ head, source: { commit: head } })
    expect(state.verify.configPin!.seq).toBeGreaterThan(oldPin.seq)
    expect(await h.br.step()).toMatchObject({ kind: 'run-check', step: 'types' })
    expect(await h.br.step()).toMatchObject({ kind: 'run-check', step: 'unit' })
    expect(await h.br.step()).toMatchObject({
      kind: 'run-agent-verify',
      step: 'ui-app',
      skill: 'ab-verify-ui-app',
    })
    const events = await h.store.getEvents(SLUG)
    expect(
      events.filter((e) => e.type === 'verify.started' && e.payload.step === 'web-dashboard'),
    ).toHaveLength(0)
    expect(
      events.filter(
        (e) => e.type === 'observation.recorded' && e.payload.summary.includes('web-dashboard'),
      ),
    ).toHaveLength(1)
    expect(
      events.filter((e) => e.type === 'verify.started' && e.payload.step === 'ui-app'),
    ).toHaveLength(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('config refresh waits for concurrent siblings and repins before the next stage', async () => {
  const old = CONFIG_TOML.replace(
    'steps = ["types", "unit", "e2e"]',
    'steps = [["types", "unit"], "e2e"]',
  )
  let current = old
  const h = await makeHarness({
    configToml: old,
    readVerifyPipeline: async () => ({
      config: parseConfig(current),
      head: 'a'.repeat(40),
      meta: { ref: 'branch-head', commit: 'a'.repeat(40) },
    }),
    beforeExec: async (cmd) => {
      if (cmd[2] === 'bun tsc --noEmit') current = old.replaceAll('e2e', 'ui-app')
    },
  })
  await seedPlanApproved(h.store)
  await seedCodeApproved(h.store)
  expect(await h.br.step()).toMatchObject({ kind: 'run-verify-stage' })
  let events = await h.store.getEvents(SLUG)
  expect(events.filter((e) => e.type === 'verify.config-captured')).toHaveLength(1)
  expect(
    events
      .filter((e) => e.type === 'verify.completed')
      .map((e) => e.payload.step)
      .sort(),
  ).toEqual(['types', 'unit'])
  expect(events.some((e) => e.type === 'verify.started' && e.payload.step === 'e2e')).toBe(false)
  await h.br.step() // detects change, captures a fresh cycle, runs its first stage
  events = await h.store.getEvents(SLUG)
  expect(events.filter((e) => e.type === 'verify.config-captured')).toHaveLength(2)
  expect(events.filter((e) => e.type === 'verify.config-superseded')).toHaveLength(1)
  expect(
    events
      .filter((e) => e.type === 'verify.started')
      .filter((e) => e.payload.attempt > 1)
      .map((e) => e.payload.step)
      .sort(),
  ).toEqual(['types', 'types', 'unit', 'unit'])
  expect(await h.br.step()).toMatchObject({
    kind: 'run-verify-stage',
    members: [{ kind: 'run-agent-verify', step: 'ui-app', skill: 'ab-verify-ui-app' }],
  })
})

const alternateConfig = `
[tickets]
source = "file"
readyState = "ready"

[commands]
[verify]
steps = []
[finalize]
steps = []

[roles.default]
runtime = "scripted"
[roles.plan]
runtime = "scripted"
model = "m-plan"
alternates = [{ runtime = "pi", model = "kimi-alt" }]
`
for (const alternates of [false, true]) {
  test(`kernel session write size rejection parks without provider substitution (alternates=${alternates})`, async () => {
    const h = await makeHarness({ ...(alternates ? { configToml: alternateConfig } : {}) })
    const append = h.store.append.bind(h.store)
    let rejected = 0
    let reject = true
    h.store.append = async (...args) => {
      if (args[1].type === 'session.started' && reject) {
        rejected += 1
        throw new StoreWriteTooLargeError('POST', '/builds/test/events', 123, 'ceiling 100 bytes')
      }
      return append(...args)
    }
    expect((await h.br.run()).status).toBe('blocked')
    let events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'phase.failed').map((e) => e.payload)).toEqual([
      {
        phase: 'plan',
        round: 1,
        attempt: 1,
        willRetry: false,
        error:
          'oversized store write: POST /builds/test/events (123 request bytes): ceiling 100 bytes',
      },
    ])
    const escalation = ofType(events, 'escalation.raised').at(-1)!
    expect(escalation.payload.policyCause).toBe('non-retryable-phase-failure')
    expect(escalation.payload.question).toContain('oversized store write')
    expect(escalation.payload.question).not.toContain('provider/runner')
    expect(rejected).toBe(1)
    const restarted = await makeHarness({
      store: h.store,
      seedPrelude: false,
      ...(alternates ? { configToml: alternateConfig } : {}),
    })
    expect((await restarted.br.run()).status).toBe('blocked')
    expect(rejected).toBe(1)
    await h.store.append(SLUG, {
      actor: humanActor('operator'),
      type: 'escalation.answered',
      payload: { id: escalation.payload.id, answer: 'retry', resolution: 'retry' },
    })
    expect((await restarted.br.run()).status).toBe('blocked')
    expect(rejected).toBe(2)
    events = await h.store.getEvents(SLUG)
    expect(ofType(events, 'phase.failed')).toHaveLength(2)
    expect(ofType(events, 'phase.failed').at(-1)!.payload.willRetry).toBe(false)
    reject = false
    await h.store.append(SLUG, {
      actor: humanActor('operator'),
      type: 'escalation.answered',
      payload: {
        id: ofType(events, 'escalation.raised').at(-1)!.payload.id,
        answer: 'retry',
        resolution: 'retry',
      },
    })
    expect((await restarted.br.run()).status).toBe('running')
  })
}

for (const terminal of [false, true]) {
  test(`oversized transcript deposition respects durable terminal=${terminal}`, async () => {
    const h = await makeHarness({
      handlers: (store) => {
        const table = happyHandlers(store)
        if (!terminal) table.plan = () => defaultTurnResult()
        return table
      },
    })
    const deposit = h.store.appendWithArtifacts.bind(h.store)
    h.store.appendWithArtifacts = async (...args) => {
      if (args[1].some((artifact) => artifact.kind === 'transcript'))
        throw new StoreWriteTooLargeError('POST', '/builds/test/deposits', 123)
      return deposit(...args)
    }
    expect((await h.br.run()).status).toBe(terminal ? 'running' : 'blocked')
    const failures = ofType(await h.store.getEvents(SLUG), 'phase.failed')
    expect(failures).toHaveLength(terminal ? 0 : 1)
    if (!terminal) expect(failures[0]!.payload).toMatchObject({ attempt: 1, willRetry: false })
  })
}

test('refusing the failure fact propagates without a second recording attempt', async () => {
  const h = await makeHarness()
  const append = h.store.append.bind(h.store)
  let failures = 0
  h.store.append = async (...args) => {
    if (args[1].type === 'phase.failed') failures += 1
    if (args[1].type === 'session.started' || args[1].type === 'phase.failed')
      throw new StoreWriteTooLargeError('POST', '/builds/test/events', 123)
    return append(...args)
  }
  await expect(h.br.run()).rejects.toBeInstanceOf(StoreWriteTooLargeError)
  expect(failures).toBe(1)
  expect(ofType(await h.store.getEvents(SLUG), 'escalation.raised')).toHaveLength(0)
})

test('a verify check store write parks its stage immediately', async () => {
  const h = await makeHarness()
  await seedPlanApproved(h.store)
  await seedCodeApproved(h.store)
  const append = h.store.append.bind(h.store)
  let writes = 0
  h.store.append = async (...args) => {
    if (
      args[1].type === 'verify.started' &&
      'step' in args[1].payload &&
      args[1].payload.step === 'types'
    ) {
      writes += 1
      throw new StoreWriteTooLargeError('POST', '/builds/test/events', 123)
    }
    return append(...args)
  }
  expect((await h.br.run()).status).toBe('blocked')
  const events = await h.store.getEvents(SLUG)
  expect(ofType(events, 'phase.failed').map((e) => e.payload)).toEqual([
    {
      phase: 'verify:types',
      round: 1,
      attempt: 1,
      willRetry: false,
      error: 'oversized store write: POST /builds/test/events (123 request bytes)',
    },
  ])
  expect(ofType(events, 'escalation.raised').at(-1)!.payload.policyCause).toBe(
    'non-retryable-phase-failure',
  )
  await h.br.run()
  expect(writes).toBe(1)
})
