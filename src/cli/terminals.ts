/**
 * The three terminal commands — `ab done`, `ab verdict`, `ab escalate`
 * (SPEC §8.4 D5, §8.5 D6, §8.6 D7).
 *
 * D5: every phase ends with exactly one terminal command; a second terminal
 * call is rejected citing what already exists, and every terminal validates
 * its preconditions before emitting the phase event.
 *
 * D6: terminal commands are atomic bundles — `appendWithArtifacts` deposits
 * the artifact and appends the event in one operation, and validation
 * failures return the schema and a precise error as in-session agent
 * feedback, not build failures.
 *
 * D7: agents never touch the remote — push and PR creation happen here, as
 * plumbing triggered by the terminal. Forge credentials never enter the
 * agent's own toolbox; this CLI call IS the kernel plumbing.
 */
import { join } from 'node:path'
import { z } from 'zod'
import { loadConfig } from '../config/load'
import type { AbEvent, EventEnvelope } from '../events/catalog'
import { agentActor, KERNEL } from '../events/envelope'
import { normalizeVerifyCompletion } from '../events/payloads'
import type { IdSource } from '../ids'
import {
  autoMergeApplicationType,
  pendingAutoMerge,
} from '../kernel/auto-merge'
import { phaseSpecFor } from '../kernel/phases'
import { resolvePlanVerifySteps } from '../kernel/plan-verify-selection'
import { reduceBuild } from '../kernel/reducer'
import {
  findingDraftSchema,
  isVerifyPhase,
  verifyReportKind,
  verifyStep,
  type ArtifactRef,
  type Finding,
  type ReviewVerdictKind,
} from '../ontology'
import type { Forge } from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'
import type { ArtifactMeta, BuildStore } from '../store/types'
import { textContent } from '../store/types'
import {
  extractDashboardFrameManifest,
  type DashboardFrameEntry,
} from './dashboard/frame-artifacts'
import { stripAnsi } from './dashboard/render'
import type { CliEnv } from './env'

/** Structural subset of CliDeps (src/cli/main.ts) — what terminals need. */
export interface TerminalDeps {
  store: BuildStore
  env: CliEnv
  workspacePath: string
  forge: Forge
  /** All git interrogation goes through this seam — never a raw spawn. */
  exec: Exec
  ids: IdSource
}

// ── Shared discipline (D5) ───────────────────────────────────────────────────

/**
 * Reject a second terminal call for this phase+round: either the phase's
 * terminal event already recorded at this round, or an `escalation.raised`
 * by THIS session (a session that escalated is done — §8.4). Also reject a
 * terminal from a ZOMBIE session — one the log already ended, or one whose
 * phase round already failed after it started (D5: a session that ends
 * without a terminal is failed and retried; only the retry may complete the
 * round, so a still-in-flight CLI process from the failed session must not
 * land a terminal the runner will misattribute to the retry).
 */
function assertNoPriorTerminal(events: AbEvent[], env: CliEnv): void {
  const spec = phaseSpecFor(env.phase)
  // §6.3 restart boundary: verify attempts and finalize completion RESET
  // across a spec.revised (decideNext ignores pre-restart results and
  // re-runs the pipeline from plan), so a pre-restart verify.completed or
  // finalize.completed must not shadow the rebuilt pipeline's terminal.
  // Loop-phase rounds continue monotonically across restarts (engine
  // LoopIndex.maxRoundEver) and never collide, so they match over the full
  // log; the reconcile epilogue is restart-orthogonal (§15.7).
  let restartSeq = 0
  for (const event of events) {
    if (event.type === 'spec.revised') restartSeq = event.seq
  }
  // reconcile.completed carries no attempt (§15.3); pair it with the latest
  // reconcile.started seen before it.
  let reconcileAttempt = 0
  let sessionStartedSeq: number | undefined
  for (const event of events) {
    if (event.type === 'reconcile.started') reconcileAttempt = event.payload.attempt
    if (event.type === 'session.started' && event.payload.session === env.session) {
      sessionStartedSeq = event.seq
    }
    if (event.type === 'session.ended' && event.payload.session === env.session) {
      throw new Error(
        `terminal rejected (D5): session "${env.session}" already ended ` +
          `(session.ended at seq ${event.seq}) — a session that ended without ` +
          'a terminal was failed and retried; only the live retry may complete ' +
          'this phase round (§8.4).',
      )
    }
    if (
      sessionStartedSeq !== undefined &&
      event.type === 'phase.failed' &&
      event.payload.phase === env.phase &&
      event.payload.round === env.round &&
      event.seq > sessionStartedSeq
    ) {
      throw new Error(
        `terminal rejected (D5): ${env.phase}@${env.round} already failed after ` +
          `this session started (phase.failed at seq ${event.seq}) — the retry ` +
          'session owns this round now (§8.4).',
      )
    }
    if (
      event.type === 'escalation.raised' &&
      event.actor.kind === 'agent' &&
      event.actor.session === env.session
    ) {
      throw new Error(
        `second terminal call rejected (D5): this session already escalated — ` +
          `escalation.raised "${event.payload.id}" at seq ${event.seq}. ` +
          'Every phase ends with exactly one terminal command (§8.4).',
      )
    }
    if (event.type !== spec.terminalEvent) continue
    if (
      (event.type === 'verify.completed' || event.type === 'finalize.completed') &&
      event.seq <= restartSeq
    ) {
      continue
    }
    if (!terminalMatchesRound(event, env, reconcileAttempt)) continue
    throw new Error(
      `second terminal call rejected (D5): ${event.type} for ` +
        `${env.phase}@${env.round} already recorded at seq ${event.seq}. ` +
        'Every phase ends with exactly one terminal command (§8.4).',
    )
  }
}

function terminalMatchesRound(
  event: AbEvent,
  env: CliEnv,
  reconcileAttempt: number,
): boolean {
  switch (event.type) {
    case 'plan.completed':
    case 'plan-review.verdict':
    case 'implement.completed':
    case 'code-review.verdict':
      return event.payload.round === env.round
    case 'verify.completed':
      return (
        isVerifyPhase(env.phase) &&
        event.payload.step === verifyStep(env.phase) &&
        event.payload.attempt === env.round
      )
    case 'finalize.completed':
      // finalize runs once per build (§5) — any prior completion counts.
      return true
    case 'reconcile.completed':
      // No started event before it → conservative match (total over any log).
      return reconcileAttempt === env.round || reconcileAttempt === 0
    default:
      return false
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────

async function readTextFile(path: string, flag: string): Promise<string> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`${flag} file not found: ${path}`)
  }
  return file.text()
}

async function git(deps: TerminalDeps, args: string[]): Promise<string> {
  const result = await deps.exec(['git', ...args], { cwd: deps.workspacePath })
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} exited ${result.exitCode}: ` +
        `${result.stderr.trim() || result.stdout.trim() || '(no output)'}`,
    )
  }
  return result.stdout
}

/** No `done` on a dirty worktree (D5) — the error lists the offending files. */
async function assertCleanWorktree(deps: TerminalDeps): Promise<void> {
  const status = (await git(deps, ['status', '--porcelain'])).trimEnd()
  if (status !== '') {
    throw new Error(
      `'ab done' in ${deps.env.phase} requires a clean worktree (D5) — ` +
        `commit or discard these first:\n${status}`,
    )
  }
}

function baseBranchOf(events: AbEvent[]): string {
  for (const event of events) {
    if (event.type === 'build.created') return event.payload.baseBranch
  }
  throw new Error(
    'this build has no build.created event — cannot resolve its baseBranch (§15.3)',
  )
}

async function buildBranch(deps: TerminalDeps): Promise<string> {
  const build = await deps.store.getBuild(deps.env.build)
  if (build === null) {
    throw new Error(
      `build "${deps.env.build}" could not be resolved — cannot determine its durable branch`,
    )
  }
  return build.branch ?? `ab/${build.slug}`
}

function refOf(meta: ArtifactMeta | undefined): ArtifactRef {
  if (meta === undefined) {
    throw new Error('deposit produced no artifact meta — this is a store bug')
  }
  return { kind: meta.kind, rev: meta.revision }
}

function requireNotes(notes: string | undefined, why: string): string {
  if (notes === undefined) {
    throw new Error(`--notes <file> is required: ${why} (D5, §8.2)`)
  }
  return notes
}

// ── ab done (producer phases — D5/D7) ────────────────────────────────────────

export interface DoneOpts {
  /** Path to the notes file (implement/reconcile — deposited as the phase's artifact). */
  notes?: string
}

export async function done(
  deps: TerminalDeps,
  opts: DoneOpts = {},
): Promise<EventEnvelope> {
  const { env, store } = deps
  const spec = phaseSpecFor(env.phase)
  if (spec.kind !== 'producer') {
    throw new Error(
      `'ab done' is not ${env.phase}'s terminal — ${env.phase} is a ` +
        `${spec.kind} phase; use 'ab verdict' (§8.2)`,
    )
  }
  const events = await store.getEvents(env.build)
  assertNoPriorTerminal(events, env)
  const actor = agentActor(env.phase, env.session)

  switch (spec.name) {
    case 'plan': {
      // THIS round's plan must already be deposited (D5: no done without the
      // required artifacts): a revision newer than the one the last
      // plan.completed cited. A bare revision count is no proxy — crash
      // re-runs leave orphaned revs (§8.7) and a round may self-correct with
      // several deposits, so count ≥ round can hold while the latest rev is
      // still the already-reviewed plan, re-entering review as if revised.
      const revs = await store.listArtifacts(env.build, 'plan')
      const latest = revs[revs.length - 1]
      let lastCited = -1
      for (const event of events) {
        if (event.type === 'plan.completed') {
          lastCited = Math.max(lastCited, event.payload.artifact.rev)
        }
      }
      if (latest === undefined || latest.revision <= lastCited) {
        throw new Error(
          `plan@${env.round} 'ab done' requires this round's plan deposit: found ` +
            (latest === undefined
              ? '0 plan revisions'
              : `no plan revision newer than rev ${lastCited}, which an earlier ` +
                `round's plan.completed already cited`) +
            ` — run 'ab artifact put plan <file>' first (D5)`,
        )
      }
      // The event, not a later artifact read, is the engine's durable input.
      // Validate the exact fresh revision before appending so an invalid plan
      // can be corrected with another immutable deposit and no partial fact.
      const plan = await store.getArtifact(env.build, 'plan', latest.revision)
      if (plan === null) {
        throw new Error(
          `plan@${latest.revision} was listed but could not be fetched — this is a store bug`,
        )
      }
      const config = await loadConfig(join(deps.workspacePath, 'autobuild.toml'))
      const verifySteps = resolvePlanVerifySteps(textContent(plan), config)
      return store.append(env.build, {
        actor,
        type: 'plan.completed',
        payload: {
          round: env.round,
          artifact: { kind: 'plan', rev: latest.revision },
          verifySteps,
        },
      })
    }

    case 'implement': {
      const notesPath = requireNotes(opts.notes, "implement's 'ab done' deposits implement-notes")
      const notes = await readTextFile(notesPath, '--notes')
      await assertCleanWorktree(deps)
      const baseBranch = baseBranchOf(events)
      const branch = await buildBranch(deps)
      const head = (await git(deps, ['rev-parse', 'HEAD'])).trim()
      const base = (await git(deps, ['merge-base', baseBranch, 'HEAD'])).trim()
      // Push BEFORE the event (walkthrough §8.7 order): a push without an
      // event is a harmless retry — the re-run pushes the same branch again —
      // but an event without a push breaks cross-sandbox resume, which
      // fetches the branch at the recorded head (§15.6-C, D3).
      await deps.forge.pushBranch(deps.workspacePath, branch)
      const { event } = await store.appendWithArtifacts(
        env.build,
        [{ kind: 'implement-notes', content: notes }],
        (deposited) => ({
          actor,
          type: 'implement.completed',
          payload: {
            round: env.round,
            commits: { base, head },
            artifact: refOf(deposited[0]),
          },
        }),
      )
      return event
    }

    case 'finalize': {
      const description = await store.getArtifact(env.build, 'pr-description')
      if (description === null) {
        throw new Error(
          "finalize's 'ab done' requires a deposited pr-description artifact — " +
            "run 'ab artifact put pr-description <file>' first (D5, §8.3). " +
            'Its first line becomes the PR title; the rest is the body.',
        )
      }
      const text = textContent(description)
      const newline = text.indexOf('\n')
      const firstLine = (newline === -1 ? text : text.slice(0, newline))
        .replace(/^#+\s*/, '')
        .trim()
      const body = newline === -1 ? '' : text.slice(newline + 1).replace(/^\n+/, '')
      if (firstLine === '') {
        throw new Error(
          'the pr-description artifact has an empty first line — it becomes the PR title',
        )
      }
      const baseBranch = baseBranchOf(events)
      const branch = await buildBranch(deps)
      // §15.3/D7: the kernel opens the PR after the agent's `ab done` — this
      // CLI call IS that kernel plumbing, so the event's actor is KERNEL.
      // openPr runs BEFORE the event (same rationale as implement's push): a
      // PR without an event is a harmless retry — which holds only because
      // Forge.openPr is IDEMPOTENT by head branch (it adopts an existing open
      // PR rather than erroring, §8.7's crash-after-plumbing path).
      const pr = await deps.forge.openPr({
        workspacePath: deps.workspacePath,
        head: branch,
        base: baseBranch,
        title: firstLine,
        body,
      })

      // A dashboard command may land while finalize is running. Re-read after
      // openPr so the latest human intent is applied at the first instant a PR
      // exists. The setter is idempotent: if the forge call succeeds but this
      // process dies before either event append, retry adopts the PR and safely
      // applies the same desired state again.
      const latest = await store.getEvents(env.build)
      const autoMerge = pendingAutoMerge(reduceBuild(latest))
      const autoMergeResult =
        autoMerge === undefined
          ? undefined
          : await deps.forge.setAutoMerge(
              deps.workspacePath,
              pr.number,
              autoMerge.enabled,
            )

      const event = await store.append(env.build, {
        actor: KERNEL,
        type: 'finalize.completed',
        payload: { pr },
      })

      // The PR terminal is the D5 commit point. Its secondary correlated fact
      // is best-effort after that point: if this append fails, the janitor sees
      // the still-unmatched command and retries the idempotent forge operation.
      if (autoMerge !== undefined && autoMergeResult?.kind === 'applied') {
        try {
          await store.append(env.build, {
            actor: KERNEL,
            type: autoMergeApplicationType(autoMerge.enabled),
            payload: { commandSeq: autoMerge.commandSeq },
          })
        } catch {
          // Recoverable by Dispatcher.checkPr on its next open-PR poll.
        }
      }

      // §7.5: the PR gets a summary comment — verdict history, verification
      // results, store refs. Best-effort AFTER the terminal committed: the
      // comment is a projection, not the record, and a comment failure must
      // not turn a recorded finalize.completed into a CLI error (the agent's
      // retry would be rejected as a second terminal — D5).
      try {
        await deps.forge.commentOnPr(
          deps.workspacePath,
          pr.number,
          await renderPrSummary(env, latest, store),
        )
      } catch {
        // The audit trail stays queryable in the store (§7.5).
      }
      return event
    }

    case 'reconcile': {
      const notesPath = requireNotes(opts.notes, "reconcile's 'ab done' deposits reconcile-notes")
      const notes = await readTextFile(notesPath, '--notes')
      await assertCleanWorktree(deps)
      // The resolution lands as a merge commit (§15.7) — HEAD must have 2+
      // parents (base merged into the branch, never rebase — D1).
      const parentsLine = (
        await git(deps, ['rev-list', '--parents', '-n', '1', 'HEAD'])
      ).trim()
      const parts = parentsLine.split(/\s+/)
      const head = parts[0]!
      if (parts.length < 3) {
        throw new Error(
          `reconcile's 'ab done' requires HEAD to be a merge commit (2+ parents) — ` +
            `HEAD ${head} has ${parts.length - 1} parent(s); merge the base branch ` +
            'into this branch first (§15.7, D1: never rebase)',
        )
      }
      const branch = await buildBranch(deps)
      // Regular push, NEVER force (D1): the merge commit extends the branch;
      // rewriting it would sever the SHAs recorded in implement.completed.
      await deps.forge.pushBranch(deps.workspacePath, branch)
      const { event } = await store.appendWithArtifacts(
        env.build,
        [{ kind: 'reconcile-notes', content: notes }],
        (deposited) => ({
          actor,
          type: 'reconcile.completed',
          payload: { mergeCommit: head, artifact: refOf(deposited[0]) },
        }),
      )
      return event
    }

    default:
      throw new Error(`'ab done' has no plumbing for phase "${env.phase}"`)
  }
}

/** Replace controls that could alter a forge-rendered comment, while retaining
 * newlines in the terminal frame. */
function printableCommentText(value: string): string {
  let out = ''
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (character === '\n') out += character
    else if (code < 0x20 || code === 0x7f) out += `\\u{${code.toString(16)}}`
    else out += character
  }
  return out
}

function html(value: string): string {
  return printableCommentText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

interface PrDashboardFrame {
  entry: DashboardFrameEntry
  text: string
}

/** Resolve only the successful dashboard report in the reducer's CURRENT
 * verify cycle. Exact refs in that report prevent a failed/reconciled cycle's
 * stale captures from leaking into a later PR. */
async function currentDashboardFrames(
  env: CliEnv,
  events: AbEvent[],
  store: BuildStore,
): Promise<PrDashboardFrame[]> {
  const state = reduceBuild(events)
  const dashboardEvents = events.filter(
    (event) =>
      event.seq > state.verify.cycleSince &&
      event.type === 'verify.completed' &&
      event.payload.step === 'dashboard',
  )
  const latest = dashboardEvents.at(-1)
  if (latest === undefined || latest.type !== 'verify.completed') return []
  const completion = normalizeVerifyCompletion(latest.payload)
  if (completion.outcome !== 'pass' || completion.report === undefined) return []

  const report = await store.getArtifact(
    env.build,
    completion.report.kind,
    completion.report.rev,
  )
  if (report === null) return []
  const manifest = extractDashboardFrameManifest(textContent(report))
  const frames: PrDashboardFrame[] = []
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (const entry of manifest.frames) {
    const [textArtifact, pngArtifact] = await Promise.all([
      store.getArtifact(env.build, entry.text.kind, entry.text.rev),
      store.getArtifact(env.build, entry.png.kind, entry.png.rev),
    ])
    // Projection is all-or-nothing: a partial set gives a human false
    // confidence about what the verifier actually inspected.
    if (textArtifact === null || pngArtifact === null) return []
    let text: string
    try {
      text = decoder.decode(textArtifact.content)
    } catch {
      return []
    }
    frames.push({ entry, text })
  }
  return frames
}

function renderDashboardFrameSection(
  env: CliEnv,
  frames: PrDashboardFrame[],
): string[] {
  if (frames.length === 0) return []
  const lines = [
    '',
    '### Dashboard frames',
    '',
    'The text frames are inline below. Download the exact colour PNG artifacts with the listed commands.',
  ]
  for (const { entry, text } of frames) {
    const pngRef = `${entry.png.kind}@${entry.png.rev}`
    const textRef = `${entry.text.kind}@${entry.text.rev}`
    const command =
      `ab artifact download ${shellQuote(env.build)} ${shellQuote(pngRef)} ` +
      `--output ${shellQuote(`${entry.id}.png`)} --store ${shellQuote(env.store)}`
    lines.push(
      '',
      `#### ${entry.id} (${entry.terminal.columns}x${entry.terminal.rows})`,
      '',
      `- text artifact: <code>${html(textRef)}</code>`,
      `- colour PNG artifact: <code>${html(pngRef)}</code>`,
      `<pre><code>${html(command)}</code></pre>`,
      `<pre><code>${html(stripAnsi(text).replace(/\n$/, ''))}</code></pre>`,
    )
  }
  return lines
}

/** The §7.5 summary comment, rendered from events/artifacts — never from
 * scraped agent output. Optional dashboard projection remains best-effort. */
async function renderPrSummary(
  env: CliEnv,
  events: AbEvent[],
  store: BuildStore,
): Promise<string> {
  const verdicts: string[] = []
  const verifies: string[] = []
  for (const event of events) {
    if (event.type === 'plan-review.verdict' || event.type === 'code-review.verdict') {
      const phase = event.type === 'plan-review.verdict' ? 'plan-review' : 'code-review'
      const count = event.payload.findings.length
      const detail =
        event.payload.verdict === 'revise'
          ? ` (${count} finding${count === 1 ? '' : 's'})`
          : ''
      verdicts.push(`- ${phase} r${event.payload.round}: ${event.payload.verdict}${detail}`)
    }
    if (event.type === 'verify.completed') {
      const result = normalizeVerifyCompletion(event.payload)
      const detail =
        result.outcome === 'skipped'
          ? ` — ${result.reason}`
          : result.report !== undefined
            ? ` — ${result.report.kind}@${result.report.rev}`
            : ''
      verifies.push(
        `- ${result.step} (attempt ${result.attempt}): ${result.outcome}${detail}`,
      )
    }
  }

  let frames: PrDashboardFrame[] = []
  try {
    frames = await currentDashboardFrames(env, events, store)
  } catch {
    // Malformed/missing optional evidence cannot reverse finalize.completed.
  }
  return [
    `## Autobuild: ${env.build}`,
    '',
    '### Verdict history',
    ...(verdicts.length > 0 ? verdicts : ['- (none)']),
    '',
    '### Verify',
    ...(verifies.length > 0 ? verifies : ['- (none)']),
    ...renderDashboardFrameSection(env, frames),
    '',
    '### Store',
    `- store: ${env.store}`,
    `- build: ${env.build}`,
    '',
    'The full audit trail is queryable in the build store (§7.5).',
  ].join('\n')
}

// ── ab verdict (review + agent-verify phases — D5/D6) ────────────────────────

export interface VerdictOpts {
  verdict: string
  /** Notes file — review phases: required, deposited as the phase's artifact;
   * agent-verify pass: optional, deposited as `verify-report:<step>`. */
  notes?: string
  /** FindingDraft[] JSON file (revise only). */
  findings?: string
  /** Escalation question, or the required explanation for a verify skip. */
  reason?: string
  /** Failure report file (agent-verify fail — required). */
  report?: string
}

const FINDING_DRAFT_SHAPE = [
  '[',
  '  {',
  '    "severity": "blocking" | "important" | "minor",',
  '    "summary": "<one-line defect statement>",',
  '    "file": "src/…",           // optional',
  '    "lines": [40, 62],         // optional',
  '    "detail": "…",             // optional',
  '    "persists": ["f_1c22"]     // optional: prior-round finding ids this one continues (§15.4)',
  '  }',
  ']',
].join('\n')

export async function verdict(
  deps: TerminalDeps,
  opts: VerdictOpts,
): Promise<EventEnvelope[]> {
  const { env, store } = deps
  const spec = phaseSpecFor(env.phase)
  if (spec.kind === 'producer') {
    throw new Error(
      `'ab verdict' is not ${env.phase}'s terminal — ${env.phase} is a ` +
        `producer phase; use 'ab done' (§8.2)`,
    )
  }
  // The verdict vocabulary is phase-dependent and enforced here (§8.2):
  // review phases accept approve|revise|escalate; agent-verify steps accept
  // pass|fail|skip.
  const vocabulary = spec.verdictVocabulary ?? []
  if (!vocabulary.includes(opts.verdict)) {
    throw new Error(
      `verdict "${opts.verdict}" is not in ${env.phase}'s vocabulary — §8.2: ` +
        'review phases accept approve|revise|escalate; agent-verify steps ' +
        `accept pass|fail|skip. ${env.phase} accepts: ${vocabulary.join('|')}`,
    )
  }
  const events = await store.getEvents(env.build)
  assertNoPriorTerminal(events, env)
  const actor = agentActor(env.phase, env.session)

  if (spec.kind === 'agent-verify') {
    return agentVerifyVerdict(deps, opts, actor)
  }
  return reviewVerdict(deps, opts, events, actor)
}

async function reviewVerdict(
  deps: TerminalDeps,
  opts: VerdictOpts,
  events: AbEvent[],
  actor: ReturnType<typeof agentActor>,
): Promise<EventEnvelope[]> {
  const { env, store } = deps
  const spec = phaseSpecFor(env.phase)
  const kind = spec.requiredArtifact
  if (kind === undefined) {
    throw new Error(`review phase "${env.phase}" declares no artifact kind — phase table bug`)
  }
  if (opts.notes === undefined) {
    throw new Error(
      `'ab verdict ${opts.verdict}' in ${env.phase} requires --notes <file> — ` +
        `the notes are deposited as the ${kind} artifact (D6, §8.3)`,
    )
  }
  const notes = await readTextFile(opts.notes, '--notes')

  let findings: Finding[] = []
  let reason: string | undefined
  if (opts.verdict === 'revise') {
    if (opts.findings === undefined) {
      throw new Error(
        `'ab verdict revise' requires --findings <json file> with the structured ` +
          `findings (D6). Expected shape:\n${FINDING_DRAFT_SHAPE}`,
      )
    }
    findings = await parseFindings(deps, opts.findings, events)
  }
  if (opts.verdict === 'escalate') {
    if (opts.reason === undefined || opts.reason.trim() === '') {
      throw new Error(
        `'ab verdict escalate' requires --reason <text> — it becomes the ` +
          'escalation question a human answers (§8.2, §11)',
      )
    }
    reason = opts.reason
  }

  const type: 'plan-review.verdict' | 'code-review.verdict' =
    env.phase === 'plan-review' ? 'plan-review.verdict' : 'code-review.verdict'
  // Atomic bundle (D6): notes artifact + verdict event in one operation — no
  // state where the artifact exists without its event or vice versa.
  const { event } = await store.appendWithArtifacts(
    env.build,
    [{ kind, content: notes }],
    (deposited) => ({
      actor,
      type,
      payload: {
        round: env.round,
        verdict: opts.verdict as ReviewVerdictKind,
        findings,
        artifact: refOf(deposited[0]),
        ...(reason !== undefined ? { reason } : {}),
      },
    }),
  )
  const out: EventEnvelope[] = [event]

  if (opts.verdict === 'escalate') {
    // Two appends: the verdict, then the escalation. A crash between them
    // leaves a verdict{escalate} without its escalation.raised — the engine
    // repairs that gap on resume (state is a reduction of events, §15.5).
    out.push(
      await store.append(env.build, {
        actor,
        type: 'escalation.raised',
        payload: {
          id: deps.ids('esc'),
          phase: env.phase,
          round: env.round,
          source: 'agent',
          question: reason!,
        },
      }),
    )
  }
  return out
}

/**
 * Parse, validate (D6: failures return the schema shape and the precise
 * issue), check `persists` against prior rounds' finding ids for this loop,
 * and stamp kernel-assigned ids (§15.4 — agents never self-assign).
 */
async function parseFindings(
  deps: TerminalDeps,
  path: string,
  events: AbEvent[],
): Promise<Finding[]> {
  const raw = await readTextFile(path, '--findings')
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `--findings ${path} is not valid JSON: ${message}\n` +
        `Expected shape (D6):\n${FINDING_DRAFT_SHAPE}`,
    )
  }
  const parsed = z.array(findingDraftSchema).safeParse(json)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(
      `--findings ${path} does not match the finding schema (D6):\n${issues}\n` +
        `Expected shape:\n${FINDING_DRAFT_SHAPE}`,
    )
  }

  // `persists` may only reference ids from prior rounds of THIS loop (§15.4;
  // ids are deposit-stamped, so a reviewer can only ever see rounds it was
  // shown — §8.3).
  const state = reduceBuild(events)
  const loop =
    deps.env.phase === 'plan-review'
      ? state.reviewFindings.planReview
      : state.reviewFindings.codeReview
  const known = new Set<string>()
  loop.forEach((roundFindings, index) => {
    if (index + 1 < deps.env.round) {
      for (const finding of roundFindings) known.add(finding.id)
    }
  })
  for (const draft of parsed.data) {
    for (const id of draft.persists) {
      if (!known.has(id)) {
        throw new Error(
          `persists id "${id}" does not exist in prior rounds' findings for this ` +
            `loop — known ids: ${
              known.size > 0
                ? [...known].join(', ')
                : '(none — round 1 findings cannot persist anything)'
            }`,
        )
      }
    }
  }

  return parsed.data.map((draft) => ({ ...draft, id: deps.ids('f') }))
}

async function agentVerifyVerdict(
  deps: TerminalDeps,
  opts: VerdictOpts,
  actor: ReturnType<typeof agentActor>,
): Promise<EventEnvelope[]> {
  const { env, store } = deps
  if (!isVerifyPhase(env.phase)) {
    throw new Error(`agent-verify verdict outside a verify phase: "${env.phase}"`)
  }
  const step = verifyStep(env.phase)
  const reportKind = verifyReportKind(step)

  if (opts.verdict === 'pass') {
    // Optional --notes are deposited as the step's report kind and the event
    // carries the ref — provenance for a pass is welcome, just not required.
    if (opts.notes !== undefined) {
      const notes = await readTextFile(opts.notes, '--notes')
      const { event } = await store.appendWithArtifacts(
        env.build,
        [{ kind: reportKind, content: notes }],
        (deposited) => ({
          actor,
          type: 'verify.completed',
          payload: {
            step,
            attempt: env.round,
            outcome: 'pass',
            report: refOf(deposited[0]),
          },
        }),
      )
      return [event]
    }
    return [
      await store.append(env.build, {
        actor,
        type: 'verify.completed',
        payload: { step, attempt: env.round, outcome: 'pass' },
      }),
    ]
  }

  if (opts.verdict === 'skip') {
    const reason = opts.reason?.trim()
    if (reason === undefined || reason === '') {
      throw new Error(
        `'ab verdict skip' requires --reason <text> — a skipped verification ` +
          'must leave a human-readable reason in the event log',
      )
    }
    return [
      await store.append(env.build, {
        actor,
        type: 'verify.completed',
        payload: { step, attempt: env.round, outcome: 'skipped', reason },
      }),
    ]
  }

  // fail: the report is what routes back into the code loop (§5) — required.
  if (opts.report === undefined) {
    throw new Error(
      `'ab verdict fail' requires --report <file> — the failure report is ` +
        `deposited as ${reportKind} and routed back to implement (§5, D6)`,
    )
  }
  const report = await readTextFile(opts.report, '--report')
  const { event } = await store.appendWithArtifacts(
    env.build,
    [{ kind: reportKind, content: report }],
    (deposited) => ({
      actor,
      type: 'verify.completed',
      payload: {
        step,
        attempt: env.round,
        outcome: 'fail',
        report: refOf(deposited[0]),
      },
    }),
  )
  return [event]
}

// ── ab escalate (any phase — D5, §11) ────────────────────────────────────────

export interface EscalateOpts {
  question: string
  refs?: string[]
}

export async function escalate(
  deps: TerminalDeps,
  opts: EscalateOpts,
): Promise<EventEnvelope<'escalation.raised'>> {
  const { env, store } = deps
  if (opts.question.trim() === '') {
    throw new Error(
      "'ab escalate' requires a question — it is what the human answers (§11)",
    )
  }
  const events = await store.getEvents(env.build)
  assertNoPriorTerminal(events, env)
  return store.append(env.build, {
    actor: agentActor(env.phase, env.session),
    type: 'escalation.raised',
    payload: {
      id: deps.ids('esc'),
      phase: env.phase,
      round: env.round,
      source: 'agent',
      question: opts.question,
      ...(opts.refs !== undefined && opts.refs.length > 0 ? { refs: opts.refs } : {}),
    },
  })
}
