import { publishExact } from '../kernel/publication'
import { compatibilityDiagnostic, MixedVersionDeferral } from '../kernel/mixed-version'
import { suspendNativeLanding } from '../kernel/landing-publication'
import { validateNodeChange } from '../kernel/node-restack'
import { validateRestack, retainReplay } from '../kernel/reconcile-restack'
import {
  readBuildFacts,
  readBuildSelector,
  readTerminalGuard,
  type CurrentBuildFacts,
} from '../store/reduced-reads'
import {
  leafLandingBase,
  recordHeadPaths,
  type HeadPathsInput,
  type RecordedHeadPaths,
} from '../kernel/head-paths'
import {
  consentRevocation,
  resolutionPathsFor,
  revocableConsent,
} from '../kernel/consent-revocation'
import { prIssueLinksForForge } from '../kernel/issue-keywords'
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
import { readTerminalGuardBoundary } from '../store/reduced-reads'
import { WAIT_TICKET_LIMIT, type EventPayload, type EventType } from '../events/payloads'
import type { EventWrite } from '../events/catalog'
import type { ArtifactInput } from '../store/types'
import type { EventEnvelope } from '../events/catalog'
import { agentActor, KERNEL } from '../events/envelope'
import { isRemoteWorkspace } from '../events/workspace-remote'
import type { IdSource } from '../ids'
import { phaseSpecFor } from '../kernel/phases'
import { resolvePlanVerifySteps } from '../kernel/plan-verify-selection'
import { objectiveBlocks, WORK_TICKET_OBJECTIVE_REFUSAL } from '../objective'
import { specConformance } from '../spec-standard'
import { readOptimizationLedger } from '../store/reduced-reads'
import {
  findingDraftSchema,
  isVerifyPhase,
  proposalsDocumentSchema,
  verifyReportKind,
  verifyStep,
  type ArtifactRef,
  type Finding,
  type ReviewVerdictKind,
} from '../ontology'
import type { Forge } from '../ports/types'
import { phaseScratchRejection, scratchPathsTouchedInRange } from '../ports/workspace/phase-scratch'
import type { Exec } from '../ports/workspace/git-worktree'
import type { ArtifactMeta, BuildStore } from '../store/types'
import { textContent } from '../store/types'
import { expandIssues } from '../zod-issues'
import { preparePrAttachments } from './pr-attachments'
import type { CliEnv } from './env'
import { harnessPathsTouched, harnessRejection, readAttemptContext } from './attempt'

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
async function assertNoPriorTerminal(store: BuildStore, env: CliEnv): Promise<void> {
  const result = await readTerminalGuard(store, env.build, env.phase, env.round, env.session)
  if (result.diagnostic) throw new Error(result.diagnostic)
}

/** Validate and commit against exactly one prefix; suspension and terminal
 * writers share the store's compare-and-append boundary. */
async function terminalDeposit<T extends EventType>(
  deps: TerminalDeps,
  artifacts: ArtifactInput[],
  makeEvent: (deposited: ArtifactMeta[]) => EventWrite<T>,
  refuse?: (guard: { waitHeld?: string }) => string | undefined,
): Promise<{ event: EventEnvelope<T>; artifacts: ArtifactMeta[] }> {
  for (;;) {
    const boundary = await readTerminalGuardBoundary(
      deps.store,
      deps.env.build,
      deps.env.phase,
      deps.env.round,
      deps.env.session,
    )
    if (boundary.value.diagnostic) throw new Error(boundary.value.diagnostic)
    const refusal = refuse?.(boundary.value)
    if (refusal !== undefined) throw new Error(refusal)
    const deposited = await deps.store.appendWithArtifactsIfCurrent(
      deps.env.build,
      boundary.cursor,
      artifacts,
      makeEvent,
    )
    if (deposited !== null) return deposited
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

/** Git object ids are 40 hex characters for SHA-1 repositories and 64 for
 * SHA-256 repositories. The corresponding rev-parse calls also prove type. */
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function gitObjectIds(output: string, command: string): string[] {
  const body = output.endsWith('\n') ? output.slice(0, -1) : output
  if (body === '') return []
  const ids = body.split('\n')
  const malformed = ids.find((id) => !GIT_OBJECT_ID.test(id))
  if (malformed !== undefined) {
    throw new Error(`${command} returned malformed commit output: ${JSON.stringify(output)}`)
  }
  return ids
}

function singleGitObjectId(output: string, command: string): string {
  const ids = gitObjectIds(output, command)
  if (ids.length !== 1) {
    throw new Error(`${command} expected exactly one commit SHA, found ${ids.length}`)
  }
  return ids[0]!
}

/** No `done` on a dirty worktree (D5) — the error lists the offending files. */
async function assertCleanWorktree(deps: TerminalDeps, command = 'ab done'): Promise<void> {
  const status = (await git(deps, ['status', '--porcelain'])).trimEnd()
  if (status !== '') {
    throw new Error(
      `'${command}' in ${deps.env.phase} requires a clean worktree (D5) — ` +
        `commit or discard these first:\n${status}`,
    )
  }
}

function baseBranchOf(events: CurrentBuildFacts): string {
  if (events.state.baseBranch) return events.state.baseBranch
  throw new Error('this build has no build.created event — cannot resolve its baseBranch (§15.3)')
}

function requireImplementationProvisioning(events: CurrentBuildFacts): void {
  if (events.workspaceGenerations > 0) return
  throw new Error(
    "implement's 'ab done' requires workspace.provisioned provenance — " +
      'this build has no workspace.provisioned event (§7.4, §15.3)',
  )
}

function remotePublication(events: CurrentBuildFacts): boolean {
  return events.workspace !== null && isRemoteWorkspace(events.workspace)
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

/**
 * Establish the focused range that this implementation completion makes
 * durable. The target snapshot lives only in a build-scoped internal ref:
 * neither FETCH_HEAD nor operator/remote-tracking refs are review inputs.
 */
async function implementationReviewBoundary(
  deps: TerminalDeps,
  events: CurrentBuildFacts,
): Promise<{ branch: string; base: string; head: string }> {
  const diagnostic = 'cannot establish implementation review boundary'
  try {
    requireImplementationProvisioning(events)
    const branch = await buildBranch(deps)
    const headCommand = 'git rev-parse --verify HEAD^{commit}'
    const head = singleGitObjectId(
      await git(deps, ['rev-parse', '--verify', 'HEAD^{commit}']),
      headCommand,
    )

    const provision = events.reconcileHistory.findLast(
      (event) => event.type === 'workspace.provisioned' && event.payload.base.source !== 'existing',
    )
    const effectiveBase =
      events.state.implement.commits?.base ??
      events.state.implement.contributionBase ??
      (provision?.type === 'workspace.provisioned' ? provision.payload.base.sha : undefined)
    if (!effectiveBase) throw new Error('missing fresh-cut contribution provenance')
    async function ancestor(base: string, tip: string): Promise<boolean> {
      const args = ['git', 'merge-base', '--is-ancestor', base, tip]
      const result = await deps.exec(args, { cwd: deps.workspacePath })
      if (result.exitCode === 0) return true
      if (result.exitCode === 1) return false
      throw new Error(`${args.join(' ')} exited ${result.exitCode}: ${result.stderr.trim()}`)
    }
    if (!(await ancestor(effectiveBase, head)))
      throw new Error(`effective contribution base ${effectiveBase} is not an ancestor of HEAD`)

    return { branch, base: effectiveBase, head }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${diagnostic}: ${detail}`)
  }
}

/** Record a produced candidate head's paths before the write that publishes
 * it, through the same guarded deposit as the terminal itself. */
async function recordTerminalHeadPaths(
  deps: TerminalDeps,
  events: CurrentBuildFacts,
  input: HeadPathsInput,
): Promise<RecordedHeadPaths> {
  const recorded = await recordHeadPaths(
    {
      store: deps.store,
      slug: deps.env.build,
      exec: deps.exec,
      workspacePath: deps.workspacePath,
      actor: KERNEL,
    },
    {
      ...input,
      state: events.state,
      deposit: (artifacts, makeEvent) => terminalDeposit(deps, artifacts, makeEvent),
    },
  )
  // The terminal deposit retries until it lands; it never misses.
  if (recorded === null) throw new Error('head path deposit missed its guarded boundary')
  return recorded
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
  /** An optimization attempt's implementer declines with this reason
   * (RFC 0005 §6.2): no review, verification, measurement or merge. */
  noImprovement?: string
}

/** Resolve this build as an optimization attempt, or undefined. */
async function attemptOf(deps: TerminalDeps, events: CurrentBuildFacts) {
  const created = events.created
  if (created?.type !== 'build.created') return undefined
  return readAttemptContext(deps.store, {
    slug: deps.env.build,
    state: events.state,
    repo: created.payload.repo,
    ticket: created.payload.ticket,
    ticketSource: async () =>
      (await loadConfig(join(deps.workspacePath, 'autobuild.toml'))).tickets.source,
  })
}

export interface FinalizePrInput {
  branch: string
  baseBranch: string
  title: string
  body: string
  mergeMessage: string
  /** Remote settlement pins the PR to the already-verified published head. */
  expectedHeadSha?: string
}

/** Shared local/remote finalize plumbing. The caller must publish the exact
 * requested head before entering this idempotent PR-side sequence. */
export async function completeFinalizePr(
  deps: TerminalDeps,
  events: CurrentBuildFacts,
  input: FinalizePrInput,
): Promise<EventEnvelope> {
  const { env, store } = deps
  let boundary = (await readBuildFacts(store, env.build)).value.state
  const diagnostic = compatibilityDiagnostic(boundary.compatibility)
  if (diagnostic) throw new MixedVersionDeferral(diagnostic)
  // Seal the issue links before the first PR side effect: every downgrade
  // ordered before the seal is composed, every later one is inert, so retries
  // and an adopted PR always carry the same keywords. Remote finalize was
  // already sealed by its publication request.
  if (boundary.issueLinks.length > 0 && boundary.issueLinksSealedSeq === undefined) {
    await store.append(env.build, { actor: KERNEL, type: 'issue-links.sealed', payload: {} })
    boundary = (await readBuildFacts(store, env.build)).value.state
  }
  const pr = await deps.forge.openPr({
    workspacePath: deps.workspacePath,
    head: input.branch,
    base: input.baseBranch,
    title: input.title,
    body: input.body,
    mergeMessage: input.mergeMessage,
    ...prIssueLinksForForge(boundary, deps.forge),
  })
  if (input.expectedHeadSha !== undefined && pr.headSha !== input.expectedHeadSha) {
    throw new Error(
      `PR head ${pr.headSha} did not match published request ${input.expectedHeadSha}`,
    )
  }

  await preparePrAttachments(deps, events, pr.url)

  const latest = (await readBuildFacts(store, env.build)).value
  const nodeTarget = latest.state.target !== undefined
  if (nodeTarget) {
    const cancellation = await deps.forge.setAutoMerge(deps.workspacePath, pr.number, false)
    if (cancellation.kind !== 'applied')
      throw new Error('node-target native auto-merge cancellation unconfirmed')
  }
  const write = { actor: KERNEL, type: 'finalize.completed', payload: { pr } } as const
  const event =
    input.expectedHeadSha !== undefined
      ? await store.append(env.build, write)
      : (await terminalDeposit(deps, [], () => write)).event

  return event
}

function emptyContributionQuestion(build: string, round: number, head: string, base: string) {
  return (
    `build ${build} implement round ${round} produced no commits over its base: ` +
    `HEAD ${head} equals contribution base ${base}. Answer with guidance describing the ` +
    'change to make, revise the spec, or abort the build if no code change is intended.'
  )
}

export async function done(deps: TerminalDeps, opts: DoneOpts = {}): Promise<EventEnvelope> {
  const { env, store } = deps
  const spec = phaseSpecFor(env.phase)
  if (spec.kind !== 'producer') {
    throw new Error(
      `'ab done' is not ${env.phase}'s terminal — ${env.phase} is a ` +
        `${spec.kind} phase; use 'ab verdict' (§8.2)`,
    )
  }
  if (spec.terminal !== 'done') {
    throw new Error(`'ab done' is not ${env.phase}'s terminal — use 'ab ${spec.terminal}' (§8.2)`)
  }
  const events = (await readBuildFacts(store, env.build)).value
  const diagnostic = compatibilityDiagnostic(events.state.compatibility)
  if (diagnostic) throw new MixedVersionDeferral(diagnostic)
  await assertNoPriorTerminal(store, env)
  const actor = agentActor(env.phase, env.session)
  if (opts.noImprovement !== undefined && spec.name !== 'implement')
    throw new Error("'--no-improvement' is only valid in implement of an optimization attempt")

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
      const lastCited = events.maxPlanRevision
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
      return terminalDeposit(deps, [], () => ({
        actor,
        type: 'plan.completed',
        payload: {
          round: env.round,
          artifact: { kind: 'plan', rev: latest.revision },
          verifySteps,
        },
      })).then(({ event }) => event)
    }

    case 'implement': {
      if (opts.noImprovement !== undefined) {
        // Declining publishes nothing, so it needs neither a clean worktree
        // nor commits; the dispatcher settles the attempt on the node.
        const reason = opts.noImprovement.trim()
        if (reason === '')
          throw new Error(
            "'ab done --no-improvement' requires a non-empty reason: say what was tried and why it did not help",
          )
        if (reason.length > 4000)
          throw new Error(
            `'ab done --no-improvement' reason is ${reason.length} characters; the limit is 4000`,
          )
        if ((await attemptOf(deps, events)) === undefined)
          throw new Error(
            `ab done --no-improvement is only for optimization attempts: build ${env.build} ` +
              'is not an attempt of an optimization node',
          )
        const notes =
          opts.notes === undefined ? undefined : await readTextFile(opts.notes, '--notes')
        const { event } = await terminalDeposit(
          deps,
          notes === undefined ? [] : [{ kind: 'implement-notes', content: notes }],
          (deposited) => ({
            actor,
            type: 'implement.declined',
            payload: {
              round: env.round,
              reason,
              ...(notes === undefined ? {} : { artifact: refOf(deposited[0]) }),
            },
          }),
        )
        return event
      }
      const notesPath = requireNotes(opts.notes, "implement's 'ab done' deposits implement-notes")
      const notes = await readTextFile(notesPath, '--notes')
      await assertCleanWorktree(deps)
      // Resolve the current target and focused divergence BEFORE publication
      // or deposit. A misleading range is worse than rejecting this terminal.
      const { branch, base, head } = await implementationReviewBoundary(deps, events)
      // An empty contribution has nothing to review or publish, and a forge
      // would refuse its PR. Stop here with a question instead (the
      // escalation is this session's terminal).
      if (head === base) {
        const { event } = await terminalDeposit(deps, [], () => ({
          actor,
          type: 'escalation.raised',
          payload: {
            id: deps.ids('esc'),
            phase: 'implement',
            round: env.round,
            source: 'agent',
            question: emptyContributionQuestion(env.build, env.round, head, base),
          },
        }))
        return event
      }
      const scratchPaths = await scratchPathsTouchedInRange(
        deps.exec,
        deps.workspacePath,
        base,
        head,
      )
      if (scratchPaths.length > 0) throw phaseScratchRejection(scratchPaths)
      // An attempt must not change its pinned ruler (RFC 0005 §6.1). Refused
      // here, before any deposit, so code review never sees the change. An
      // identity error refuses too: the check is never silently skipped.
      if (events.state.target !== undefined) {
        const attempt = await attemptOf(deps, events)
        if (attempt !== undefined) {
          const harness = await harnessPathsTouched(
            deps.exec,
            deps.workspacePath,
            base,
            head,
            attempt.optimization.objective.metric.harness,
          )
          if (harness.length > 0) throw harnessRejection(harness)
        }
      }
      if (remotePublication(events)) {
        const { event } = await terminalDeposit(
          deps,
          [{ kind: 'implement-notes', content: notes }],
          (deposited) => ({
            actor,
            type: 'publication.requested',
            payload: {
              operation: 'implement',
              branch,
              sha: head,
              round: env.round,
              base,
              artifact: refOf(deposited[0]),
            },
          }),
        )
        return event
      }
      // Local publication remains immediate and push-before-fact.
      await suspendNativeLanding({ ...deps, slug: env.build }, `implement:${env.round}`)
      await publishExact(deps.forge, deps.workspacePath, branch, head)
      const { event } = await terminalDeposit(
        deps,
        [{ kind: 'implement-notes', content: notes }],
        (deposited) => ({
          actor,
          type: 'implement.completed',
          payload: { round: env.round, commits: { base, head }, artifact: refOf(deposited[0]) },
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
      if (remotePublication(events)) {
        await assertCleanWorktree(deps)
        const head = await git(deps, ['rev-parse', '--verify', 'HEAD^{commit}'])
        await recordTerminalHeadPaths(deps, events, {
          source: 'finalize',
          head: head.trim(),
          destination: await leafLandingBase(deps.store, deps.env.build, events.log.restack),
        })
        return await terminalDeposit(deps, [], () => ({
          actor,
          type: 'publication.requested',
          payload: {
            operation: 'finalize',
            branch,
            sha: head.trim(),
            description: { kind: description.meta.kind, rev: description.meta.revision },
          },
        })).then(({ event }) => event)
      }
      const published = await readBuildSelector(store, env.build, 'publishedBranchHead')
      if (published === undefined)
        throw new Error(
          'finalize publication requires a prior implement.completed, reconcile.completed, ' +
            'or successful finalize publication head, but this build has none',
        )
      await recordTerminalHeadPaths(deps, events, {
        source: 'finalize',
        head: published,
        destination: await leafLandingBase(deps.store, deps.env.build, events.log.restack),
      })
      return completeFinalizePr(deps, events, {
        branch,
        baseBranch,
        title: firstLine,
        body,
        mergeMessage: text,
      })
    }

    case 'reconcile': {
      const notesPath = requireNotes(opts.notes, "reconcile's 'ab done' deposits reconcile-notes")
      const notes = await readTextFile(notesPath, '--notes')
      await assertCleanWorktree(deps)
      const node = events.state.nodeRestack
      if (node?.conflict && node.active) {
        const conflict = node.conflict
        const change = node.active.changes[conflict.index]!
        const head = (await git(deps, ['rev-parse', 'HEAD'])).trim()
        await validateNodeChange(deps, change, conflict.base, head)
        await retainReplay({ ...deps, slug: env.build }, head, conflict.base)
        const deposited = await terminalDeposit(
          deps,
          [{ kind: 'reconcile-notes', content: notes }],
          () => ({
            actor: KERNEL,
            type: 'node.item-replayed',
            payload: {
              id: node.active!.id,
              index: conflict.index,
              base: conflict.base,
              head,
              dropped: false,
            },
          }),
        )
        return terminalDeposit(deps, [], () => ({
          actor,
          type: 'reconcile.completed',
          payload: {
            headSha: head,
            rewriteId: node.active!.id,
            artifact: refOf(deposited.artifacts[0]),
          },
        })).then(({ event }) => event)
      }
      const transaction = events.reconcileTransaction
      if (transaction === undefined || transaction.attempt !== env.round)
        throw new Error(
          'reconcile requires a kernel-prepared single-change replay; restart this reconcile occurrence',
        )
      const head = (await git(deps, ['rev-parse', 'HEAD'])).trim()
      const priorIntent = events.reconcileHistory.findLast(
        (event) =>
          event.type === 'reconcile.publish-intended' && event.payload.id === transaction.id,
      )
      if (
        priorIntent?.type === 'reconcile.publish-intended' &&
        priorIntent.payload.headSha !== head
      )
        throw new Error(
          'the durable reconcile publication intent names another resolved head; restore that head before retrying completion',
        )
      const restack = { ...deps, slug: env.build }
      await validateRestack(restack, transaction, head)
      await retainReplay(restack, head, transaction.targetBase)
      const conflicted =
        events.reconcileReplay?.id === transaction.id && events.reconcileReplay.conflicted
      const recorded = await recordTerminalHeadPaths(deps, events, {
        source: 'reconcile',
        head,
        destination: transaction.targetBase,
        resolution: [
          {
            change: transaction.changeSha,
            parent: transaction.oldBase,
            onto: transaction.targetBase,
            head,
          },
        ],
      })
      // Protected consent lapses when this resolution edited protected files.
      // Once the revocation folds the consent is gone, so a retry adds none.
      const revocation =
        revocableConsent(events.state.landing) &&
        consentRevocation(events.state.landing, {
          source: 'reconcile',
          previousHead: transaction.oldHead,
          head,
          resolution: await resolutionPathsFor(deps.store, env.build, recorded),
        })
      if (revocation)
        await terminalDeposit(deps, [], () => ({
          actor: KERNEL,
          type: 'landing.consent-revoked',
          payload: revocation,
        }))
      const { event: intended } = await terminalDeposit(
        deps,
        [{ kind: 'reconcile-notes', content: notes }],
        (deposited) => ({
          actor: KERNEL,
          type: 'reconcile.publish-intended',
          payload: { ...transaction, headSha: head, conflicted, artifact: refOf(deposited[0]) },
        }),
      )
      // All resolver publications wait until the agent turn has ended.
      return terminalDeposit(deps, [], () => ({
        actor,
        type: 'publication.requested',
        payload: {
          operation: 'reconcile',
          branch: transaction.branch,
          sha: head,
          artifact: intended.payload.artifact,
          rewrite: { ...transaction, conflicted },
        },
      })).then(({ event }) => event)
    }

    default:
      throw new Error(`'ab done' has no plumbing for phase "${env.phase}"`)
  }
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

export async function verdict(deps: TerminalDeps, opts: VerdictOpts): Promise<EventEnvelope[]> {
  const { env, store } = deps
  const spec = phaseSpecFor(env.phase)
  if (spec.kind === 'producer') {
    throw new Error(
      `'ab verdict' is not ${env.phase}'s terminal — ${env.phase} is a ` +
        `producer phase; use 'ab ${spec.terminal}' (§8.2)`,
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
  const events = (await readBuildFacts(store, env.build)).value
  await assertNoPriorTerminal(store, env)
  const actor = agentActor(env.phase, env.session)

  if (spec.kind === 'agent-verify') {
    return agentVerifyVerdict(deps, opts, actor)
  }
  return reviewVerdict(deps, opts, events, actor)
}

async function reviewVerdict(
  deps: TerminalDeps,
  opts: VerdictOpts,
  events: CurrentBuildFacts,
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
          'escalation question for external judgment (§8.2, §11)',
      )
    }
    reason = opts.reason
  }

  const type: 'plan-review.verdict' | 'code-review.verdict' =
    env.phase === 'plan-review' ? 'plan-review.verdict' : 'code-review.verdict'
  // Atomic bundle (D6): notes artifact + verdict event in one operation — no
  // state where the artifact exists without its event or vice versa.
  const { event } = await terminalDeposit(deps, [{ kind, content: notes }], (deposited) => ({
    actor,
    type,
    payload: {
      round: env.round,
      verdict: opts.verdict as ReviewVerdictKind,
      findings,
      artifact: refOf(deposited[0]),
      ...(reason !== undefined ? { reason } : {}),
    },
  }))
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

// ── ab propose (an optimization node's proposer — SPEC §13.1.1) ─────────────

const PROPOSALS_SHAPE = `{
  "proposals": [
    {
      "id": "kebab-case-id, stable and never reused in this node",
      "title": "one line, at most 200 characters",
      "strategy": "one line naming the single strategy, at most 300 characters",
      "body": "a spec-standard ticket body: what and why, '## Acceptance criteria' with at least one item, '## Out of scope'"
    }
  ],
  "reason": "required when proposals is empty"
}`

export interface ProposeOpts {
  /** Path to the proposals JSON document. */
  file?: string
  /** Propose nothing, for this reason. */
  none?: string
}

/**
 * Deposit the proposer's typed list as the `attempts` artifact with
 * `propose.completed`, atomically. The proposer never creates tickets: the
 * dispatcher files each proposal as a ready attempt targeting the node.
 */
export async function propose(deps: TerminalDeps, opts: ProposeOpts): Promise<EventEnvelope> {
  const { env, store } = deps
  const spec = phaseSpecFor(env.phase)
  if (spec.terminal !== 'propose') {
    throw new Error(
      `'ab propose' is not ${env.phase}'s terminal — ${env.phase} ends with ` +
        `'ab ${spec.terminal}' (§8.2)`,
    )
  }
  if ((opts.file === undefined) === (opts.none === undefined))
    throw new Error("'ab propose' takes exactly one of <file> or --none <reason>")
  const events = (await readBuildFacts(store, env.build)).value
  const diagnostic = compatibilityDiagnostic(events.state.compatibility)
  if (diagnostic) throw new MixedVersionDeferral(diagnostic)
  await assertNoPriorTerminal(store, env)
  const optimization = events.state.optimization
  const proposal = optimization?.proposal
  if (optimization === undefined || proposal === undefined || proposal.round !== env.round)
    throw new Error(
      `propose@${env.round} has no open proposal request on ${env.build}; nothing can be deposited`,
    )
  if (proposal.deposited !== undefined)
    throw new Error(`proposal request ${proposal.id} was already deposited`)

  let raw: unknown
  if (opts.none !== undefined) {
    if (opts.none.trim() === '') throw new Error("'ab propose --none' requires a reason")
    raw = { proposals: [], reason: opts.none }
  } else {
    const text = await readTextFile(opts.file!, 'proposals')
    try {
      raw = JSON.parse(text)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `${opts.file} is not valid JSON: ${message}\nExpected shape:\n${PROPOSALS_SHAPE}`,
      )
    }
  }
  const parsed = proposalsDocumentSchema.safeParse(raw)
  if (!parsed.success)
    throw new Error(
      `the proposals do not match the schema:\n${renderFindingsIssues(parsed.error.issues)}\n` +
        `Expected shape:\n${PROPOSALS_SHAPE}`,
    )
  const document = parsed.data
  const ids = document.proposals.map((entry) => entry.id)
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
  if (duplicate !== undefined) throw new Error(`proposal id "${duplicate}" appears more than once`)
  if (ids.length > proposal.room)
    throw new Error(
      `${ids.length} proposals exceed this request's room of ${proposal.room}; ` +
        'propose at most that many',
    )
  for (const entry of document.proposals) {
    const conformance = specConformance(entry.body)
    if (!conformance.conforms)
      throw new Error(
        `proposal "${entry.id}" body does not meet the spec standard: missing ${conformance.missing.join(', ')}`,
      )
    if (objectiveBlocks(entry.body).length > 0)
      throw new Error(`proposal "${entry.id}" refused: ${WORK_TICKET_OBJECTIVE_REFUSAL}`)
  }
  if (ids.length > 0) {
    // One explicit history read per deposit: a fresh proposal must never
    // adopt an earlier attempt's ticket by reusing its id.
    const ledger = (await readOptimizationLedger(store, env.build)).value
    const used = new Set([
      ...ledger.entries.map((entry) => entry.proposal),
      ...Object.keys(ledger.pending),
      ...optimization.inFlight.map((attempt) => attempt.proposal),
    ])
    const reused = ids.find((id) => used.has(id))
    if (reused !== undefined)
      throw new Error(
        `proposal id "${reused}" was already used by this node; choose a new id for a new attempt`,
      )
  }
  const actor = agentActor(env.phase, env.session)
  const { event } = await terminalDeposit(
    deps,
    [{ kind: 'attempts', content: `${JSON.stringify(document, null, 2)}\n` }],
    (deposited) => ({
      actor,
      type: 'propose.completed',
      payload: {
        round: env.round,
        request: proposal.id,
        proposals: ids,
        artifact: refOf(deposited[0]),
      },
    }),
  )
  return event
}

/**
 * Render findings-schema issues without discarding an untagged union's branch
 * detail. Kept separate from parsing because the current accepted findings
 * schema has no such union; this is the presentation contract for future ones.
 */
export function renderFindingsIssues(issues: readonly z.core.$ZodIssue[]): string {
  return expandIssues(issues)
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
}

/**
 * Parse, validate (D6: failures return the schema shape and the precise
 * issue), check `persists` against prior rounds' finding ids for this loop,
 * and stamp kernel-assigned ids (§15.4 — agents never self-assign).
 */
async function parseFindings(
  deps: TerminalDeps,
  path: string,
  events: CurrentBuildFacts,
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
    const issues = renderFindingsIssues(parsed.error.issues)
    throw new Error(
      `--findings ${path} does not match the finding schema (D6):\n${issues}\n` +
        `Expected shape:\n${FINDING_DRAFT_SHAPE}`,
    )
  }

  // `persists` may only reference ids from prior rounds of THIS loop (§15.4;
  // ids are deposit-stamped, so a reviewer can only ever see rounds it was
  // shown — §8.3).
  const state = events.state
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
  const facts = (await readBuildFacts(store, env.build)).value
  const start =
    facts.log.restack.gates[
      String(Math.max(facts.log.code.latestApproveSeq, facts.log.lastReconcileCompletedSeq))
    ]
  const integrationStart =
    facts.state.kind === 'node'
      ? facts.log.verifyStarted.findLast((record) => record.attempt === env.round)
      : undefined
  const evidence =
    integrationStart !== undefined
      ? {
          baseSha: integrationStart.baseSha,
          headSha: integrationStart.headSha,
          restackId: integrationStart.restackId,
        }
      : start === undefined
        ? {}
        : { baseSha: start.targetBase, headSha: start.headSha, restackId: start.id }

  if (opts.verdict === 'pass') {
    // Optional --notes are deposited as the step's report kind and the event
    // carries the ref — provenance for a pass is welcome, just not required.
    if (opts.notes !== undefined) {
      const notes = await readTextFile(opts.notes, '--notes')
      const { event } = await terminalDeposit(
        deps,
        [{ kind: reportKind, content: notes }],
        (deposited) => ({
          actor,
          type: 'verify.completed',
          payload: {
            ...evidence,
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
      (
        await terminalDeposit(deps, [], () => ({
          actor,
          type: 'verify.completed',
          payload: { ...evidence, step, attempt: env.round, outcome: 'pass' },
        }))
      ).event,
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
      (
        await terminalDeposit(deps, [], () => ({
          actor,
          type: 'verify.completed',
          payload: { ...evidence, step, attempt: env.round, outcome: 'skipped', reason },
        }))
      ).event,
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
  const { event } = await terminalDeposit(
    deps,
    [{ kind: reportKind, content: report }],
    (deposited) => ({
      actor,
      type: 'verify.completed',
      payload: {
        ...evidence,
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
    throw new Error("'ab escalate' requires a question — it is what the human answers (§11)")
  }
  const _events = (await readBuildFacts(store, env.build)).value
  await assertNoPriorTerminal(store, env)
  return terminalDeposit(deps, [], () => ({
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
  })).then(({ event }) => event)
}

// ── ab wait-on (any leaf phase — SPEC §11 "Ticket waits") ────────────────────

export interface WaitOnOpts {
  tickets: string[]
  reason: string
}

/**
 * Declare that this build waits on other tickets. The declaration is this
 * session's terminal: it appends one `wait.requested` and returns. The
 * dispatcher, which holds the ticket source, validates the ids and either
 * enters the wait (the build parks without a slot) or refuses it (this phase
 * re-runs with the reason as guidance). Only checks that need no ticket
 * source run here, and every refusal writes nothing.
 */
export async function waitOn(
  deps: TerminalDeps,
  opts: WaitOnOpts,
): Promise<EventEnvelope<'wait.requested'>> {
  const { env, store } = deps
  const tickets = opts.tickets.map((id) => id.trim())
  if (tickets.length === 0 || tickets.some((id) => id === ''))
    throw new Error("'ab wait-on' requires one or more nonblank ticket ids")
  const duplicate = tickets.find((id, index) => tickets.indexOf(id) !== index)
  if (duplicate !== undefined)
    throw new Error(`'ab wait-on' names ticket "${duplicate}" more than once`)
  if (tickets.length > WAIT_TICKET_LIMIT)
    throw new Error(`'ab wait-on' accepts at most ${WAIT_TICKET_LIMIT} ticket ids`)
  const reason = opts.reason.trim()
  if (reason === '')
    throw new Error("'ab wait-on' requires --reason <text> — it says why the build must wait")
  await assertNoPriorTerminal(store, env)
  const facts = (await readBuildFacts(store, env.build)).value
  if (facts.state.kind === 'node')
    throw new Error("'ab wait-on' is for work builds; a node build cannot declare a ticket wait")
  const own = (await store.getBuild(env.build))?.ticket?.id
  if (own !== undefined && tickets.includes(own))
    throw new Error(`ticket "${own}" is this build's own ticket; a build cannot wait on itself`)
  const id = deps.ids('wait')
  const publication =
    env.phase === 'implement' ? await publishBeforeWait(deps, facts, id) : undefined
  // Checked against the same prefix the append commits to, so concurrent
  // verifiers cannot both declare: the loser re-reads and is refused.
  const { event } = await terminalDeposit(
    deps,
    [],
    () => ({
      actor: agentActor(env.phase, env.session),
      type: 'wait.requested',
      payload: {
        id,
        phase: env.phase,
        round: env.round,
        tickets,
        reason,
        ...(publication === undefined ? {} : { publication }),
      },
    }),
    (guard) => guard.waitHeld,
  )
  return event
}

/**
 * Publish an implement session's commits before its wait is declared, so a
 * resume restack replays only published work (SPEC §11 "Ticket waits").
 * Nothing to publish when HEAD is already the published head (or the
 * contribution base before any). A local workspace pushes before the fact,
 * like `ab done`: a failed push throws and writes nothing. A remote one
 * deposits `publication.requested {operation: 'wait'}`; the dispatcher
 * settles it and enters the wait only after `wait.published`.
 */
async function publishBeforeWait(
  deps: TerminalDeps,
  facts: CurrentBuildFacts,
  id: string,
): Promise<EventPayload<'wait.requested'>['publication']> {
  const { env, store } = deps
  await assertCleanWorktree(deps, 'ab wait-on')
  const { branch, base, head } = await implementationReviewBoundary(deps, facts)
  const published = await readBuildSelector(store, env.build, 'publishedBranchHead')
  if (head === (published ?? base)) return undefined
  const scratchPaths = await scratchPathsTouchedInRange(deps.exec, deps.workspacePath, base, head)
  if (scratchPaths.length > 0) throw phaseScratchRejection(scratchPaths)
  if (remotePublication(facts)) {
    await terminalDeposit(
      deps,
      [],
      () => ({
        actor: agentActor(env.phase, env.session),
        type: 'publication.requested',
        payload: { operation: 'wait', id, branch, sha: head, base },
      }),
      (guard) => guard.waitHeld,
    )
    return { branch, base, sha: head, settlement: 'requested' }
  }
  await suspendNativeLanding({ ...deps, slug: env.build }, `wait:${id}`)
  await publishExact(deps.forge, deps.workspacePath, branch, head)
  return { branch, base, sha: head, settlement: 'published' }
}
