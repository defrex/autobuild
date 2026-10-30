import { resolveContextDirectory } from '../context-directory'
import {
  parseNodeVerificationContext,
  type NodeVerificationIndex,
} from '../kernel/node-verification-context'
import { compatibilityDiagnostic } from '../kernel/mixed-version'
import { readBuildFacts, type CurrentBuildFacts } from '../store/reduced-reads'
/**
 * The `ab context` materializer (SPEC §8.3): a phase-scoped hydration of the
 * gitignored `.ab/` scratch dir. Everything derives from
 * `PHASE_SPECS[phase].inputs` — the table drives, so the CLI, the manifest,
 * and the engine all validate against the same data (no per-phase switch
 * sprawl). Each manifest selects the current phase's inputs. Sibling phase
 * directories remain readable; scratch separation is not filesystem isolation.
 *
 * Disposable session-directory content is wiped and recreated on every run — stale
 * context is worse than no context — while legacy tracked entries are restored
 * byte-for-byte from the index. Git's local exclude keeps generated scratch
 * ignored without mutating the repository's own `.gitignore`.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseConfig } from '../config/load'
import type { VerifyStepConfig } from '../config/schema'
import {
  allowedTerminals,
  phaseSpecFor,
  type PhaseSpec,
  type TerminalCommand,
} from '../kernel/phases'
import type { BuildState } from '../kernel/reducer'
import {
  isVerifyPhase,
  verifyReportKind,
  verifyStep,
  type ArtifactRef,
  type CommitRange,
  type Feedback,
  type Finding,
  type Phase,
} from '../ontology'
import { KERNEL } from '../events/envelope'
import type { IdSource } from '../ids'
import {
  allocateScratchPath,
  ensureScratchExcluded,
  restoreTrackedScratch,
  trackedScratchPaths,
} from '../ports/workspace/phase-scratch'
import type { Exec } from '../ports/workspace/git-worktree'
import type { BuildStore } from '../store/types'
import { writeAssetTo } from './ticket-assets'
import type { CliEnv } from './env'

export interface ContextDeps {
  store: BuildStore
  env: CliEnv
  /** Root of the working copy; `.ab/` is created directly under it. */
  workspacePath: string
  /** Present in the wired CLI; optional for non-Git materializer unit tests. */
  exec?: Exec
  ids?: IdSource
}

/** Paths are relative to the session directory, forward-slash separated. */
export type MaterializedEntry = ArtifactRef | 'derived'

/**
 * The manifest (§8.3): the agent's contract — `required` deposits and
 * `allowedTerminals` — sourced from the same PHASE_SPECS table the terminal
 * commands validate with, so skills are self-checking.
 */
export interface ContextManifest {
  workspaceRecovery?: string
  compatibility?: import('../events/compatibility').CompatibilityState
  compatibilityDiagnostic?: string
  build: string
  phase: Phase
  round: number
  /**
   * Artifact kinds the phase's terminal will validate (D5). For agent-verify
   * phases this is `verify-report:<step>`, required only on a `fail` verdict
   * (§8.2) — listed so the agent knows the kind name up front.
   */
  required: string[]
  allowedTerminals: TerminalCommand[]
  /** Workspace-relative directory for this session. */
  contextDir: string
  /** Workspace-relative path where this manifest was written. */
  manifestPath: string
  /** Safe workspace-relative producer notes path (implement/reconcile only). */
  notesPath?: string
  /** relPath (under the session directory) → source artifact ref, or 'derived'. */
  materialized: Record<string, MaterializedEntry>
  /** The ticket assets this build froze (SPEC §6.3), each written to `path`
   * (relative to the workspace). Omitted when the build pinned none. */
  assets?: {
    kind: string
    name: string
    revision: number
    layout: 'file' | 'tree'
    size: number
    path: string
  }[]
  /** From the latest `implement.completed` (§8.3 code-review/verify inputs). */
  commitRange?: CommitRange
  /** Reconcile: `{baseSha}` freshly recorded by this attempt's phase start (§15.7). */
  conflict?: { baseSha: string }
  nodeVerification?: Omit<NodeVerificationIndex, 'commits'> & { indexPath: string }
  nodeChange?: {
    owner: string
    transaction: string
    index: number
    sha: string
    build?: string
    foreign: boolean
  }
  replay?: import('../events/payloads').EventPayload<'reconcile.prepared'> & {
    conflicted?: boolean
    needsCompletion: boolean
  }
  /** Agent-verify: the step's config from the workspace's autobuild.toml (§16.1). */
  step?: { name: string; config: VerifyStepConfig }
  /** The feedback this phase occurrence was started with (§15.3, §10). */
  verifyStageFailure?: import('../kernel/verify-stage-state').VerifyStageFailure
  verifyReports?: { step: string; report: import('../ontology').ArtifactRef; path: string }[]
  cancelledVerify?: { step: string; attempt: number; cause: { step: string }; status: 'not-run' }[]
  feedback?: Feedback
  /** Chains a human resolved via dismiss-finding — the reviewer is told so (§15.6-B). */
  dismissedFindingIds?: string[]
}

function requiredKinds(spec: PhaseSpec, phase: Phase): string[] {
  if (spec.requiredArtifact !== undefined) return [spec.requiredArtifact]
  // Agent-verify: the per-step report kind, required only on fail (§8.2).
  if (isVerifyPhase(phase)) return [verifyReportKind(verifyStep(phase))]
  return []
}

/** All finding objects ever deposited, by id — verdict payloads carry them in
 * full (§15.3), so feedback-by-id resolves without touching artifacts. */
function findingsById(events: CurrentBuildFacts): Map<string, Finding> {
  return new Map(Object.values(events.findings).map((finding) => [finding.id, finding]))
}
function currentFeedback(events: CurrentBuildFacts, phase: Phase, round: number): Feedback | null {
  const explicit = events.feedback[JSON.stringify([phase, round])]
  return explicit ?? (phase === 'plan' ? (events.planFeedback[String(round)] ?? null) : null)
}

/** Empty and recreate the session directory; callers restore any tracked legacy entries. */
async function wipeAbDir(abDir: string): Promise<void> {
  await rm(abDir, { recursive: true, force: true })
  await mkdir(abDir, { recursive: true })
}

function dismissedIds(state: BuildState, events: CurrentBuildFacts): string[] {
  const known = findingsById(events)
  const ids = new Set<string>()
  for (const escalation of state.answeredEscalations) {
    if (escalation.resolution !== 'dismiss-finding') continue
    for (const ref of escalation.refs ?? []) {
      if (known.has(ref)) ids.add(ref)
    }
  }
  return [...ids]
}

/**
 * Materialize the phase's `.ab/` tree and return the manifest (also written
 * as `$AB_CONTEXT_DIR/context.json`).
 */
export async function buildContext(deps: ContextDeps): Promise<ContextManifest> {
  const { store, env, workspacePath } = deps
  const { build, phase, round } = env
  const spec = phaseSpecFor(phase)
  const inputs = spec.inputs
  let events: CurrentBuildFacts
  try {
    events = (await readBuildFacts(store, build)).value
  } catch (error) {
    try {
      await store.append(build, {
        actor: KERNEL,
        type: 'session.build-read-failed',
        payload: {
          session: env.session,
          phase,
          round,
          operation: 'context',
          reason: 'own-build-read',
          diagnostic:
            (error instanceof Error ? error.message : String(error)).trim() || 'build read failed',
        },
      })
    } catch {
      /* Preserve the original read error when evidence cannot be written. */
    }
    throw error
  }
  const state = events.state

  // Preserve legacy tracked scratch exactly while replacing disposable files.
  // Some adapter contract fixtures intentionally use a non-Git workspace;
  // context hydration still works there, while publication remains Git-only.
  const contextDir = resolveContextDirectory(phase, env.contextDir)
  const abDir = join(workspacePath, contextDir)
  const gitWorkspace =
    deps.exec !== undefined &&
    (await deps.exec(['git', 'rev-parse', '--is-inside-work-tree'], { cwd: workspacePath }))
      .exitCode === 0
  const tracked = gitWorkspace ? await trackedScratchPaths(deps.exec!, workspacePath) : []
  if (tracked.some((path) => contextDir === path || contextDir.startsWith(`${path}/`))) {
    throw new Error(
      `Tracked content blocks context directory ${contextDir}; move that content before retrying`,
    )
  }
  await wipeAbDir(abDir)
  if (gitWorkspace) {
    await restoreTrackedScratch(
      deps.exec!,
      workspacePath,
      tracked.filter((path) => path.startsWith(`${contextDir}/`)),
    )
    await ensureScratchExcluded(deps.exec!, workspacePath)
  }
  if (!tracked.includes('.ab/.gitignore'))
    await writeFile(join(workspacePath, '.ab', '.gitignore'), '*\n')

  const trackedSet = new Set(tracked)
  const allocated = new Set<string>()
  const locations = new Map<string, string>()
  const locate = (desired: string): string => {
    const prior = locations.get(desired)
    if (prior !== undefined) return prior
    const path = allocateScratchPath(desired, trackedSet, allocated, `${contextDir}/`)
    locations.set(desired, path)
    return path
  }
  const manifestRelPath = locate('context.json')
  const notesRelPath =
    phase === 'implement' || phase === 'reconcile' ? locate(`${phase}-notes.md`) : undefined
  if (notesRelPath !== undefined)
    await mkdir(dirname(join(abDir, notesRelPath)), { recursive: true })
  const materialized: Record<string, MaterializedEntry> = {}

  async function writeDerived(desiredPath: string, content: string): Promise<string> {
    const relPath = locate(desiredPath)
    const target = join(abDir, relPath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
    materialized[relPath] = 'derived'
    return `${contextDir}/${relPath}`
  }

  /** Latest rev when `rev` omitted; silently skips absent kinds — the tree is
   * a projection of what exists, and the manifest shows what materialized. */
  async function writeArtifact(
    desiredPath: string,
    kind: string,
    rev?: number,
  ): Promise<string | undefined> {
    const node = state.nodeRestack
    const sourceKind =
      phase === 'reconcile' && node?.conflict && ['spec', 'plan', 'implement-notes'].includes(kind)
        ? `node-source-${node.active!.id}-${node.conflict.index}-${kind}`
        : kind
    const artifact = await store.getArtifact(
      build,
      sourceKind,
      sourceKind === kind ? rev : undefined,
    )
    if (artifact === null) return
    const relPath = locate(desiredPath)
    const target = join(abDir, relPath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, artifact.content)
    materialized[relPath] = { kind: artifact.meta.kind, rev: artifact.meta.revision }
    return `${contextDir}/${relPath}`
  }

  const manifest: ContextManifest = {
    ...(state.compatibility.unknownFacts
      ? {
          compatibility: state.compatibility,
          compatibilityDiagnostic: compatibilityDiagnostic(state.compatibility),
        }
      : {}),
    build,
    phase,
    round,
    required: requiredKinds(spec, phase),
    allowedTerminals: allowedTerminals(phase),
    contextDir,
    manifestPath: `${contextDir}/${manifestRelPath}`,
    ...(notesRelPath !== undefined ? { notesPath: `${contextDir}/${notesRelPath}` } : {}),
    materialized,
  }

  // A receipt belongs to the next session, including repeated hydration. The
  // preceding session start bounds that window without consuming notes on read.
  const [earlier, latest] =
    events.sessionStarts.length === 2 ? events.sessionStarts : [undefined, events.sessionStarts[0]]
  const previousSession = (latest?.session === env.session ? earlier?.seq : latest?.seq) ?? 0
  const loss =
    events.workspaceLoss && events.workspaceLoss.seq > previousSession
      ? events.workspaceLoss.payload
      : undefined
  const checkpoint = events.workspacePreservation
  const preserved =
    checkpoint && checkpoint.seq > previousSession && checkpoint.payload.heads.length
      ? checkpoint.payload
      : undefined
  const recoveries = Object.values(events.candidateRecoveries).filter(
    (recovery) =>
      recovery && (events.candidateRecoverySeqs[recovery.operation] ?? 0) > previousSession,
  )
  const legacyRequest = events.publication.latestUncompletedRequest()
  if (
    loss ||
    preserved ||
    recoveries.length ||
    (legacyRequest && events.publication.lostRecorded(legacyRequest))
  ) {
    const lines = ['# Workspace commit recovery', '']
    if (preserved) {
      lines.push(`Preserved from ${preserved.ref}, ${preserved.phase}@${preserved.round}:`)
      for (const head of preserved.heads)
        lines.push(
          `- ${head.role}: ${head.sha} (${head.remoteRef}); commits: ${head.commits.join(', ')}`,
        )
      lines.push(
        'Replacement provisioning restores these exact refs before starting a session.',
        '',
      )
    }
    if (loss)
      lines.push(
        `Source workspace ${loss.ref}, ${loss.phase}@${loss.round}: ${loss.reason}`,
        `Known lost candidates: ${loss.shas.join(', ') || '(no SHA inventory was observable)'}. Additional unpublished SHAs are unavailable.`,
        '',
      )
    for (const recovery of recoveries) {
      if (!recovery) continue
      lines.push(
        `${recovery.operation} candidate ${recovery.sha} was confirmed unavailable. Reconstruct its producer result under retained intent ${recovery.replacementId}; do not search for the retired candidate.`,
        '',
      )
    }
    const legacy = events.publication.latestUncompletedRequest()
    if (!loss && legacy && events.publication.lostRecorded(legacy))
      lines.push(
        `Historical publication loss names ${legacy.payload.sha} (${legacy.payload.operation}). Availability must be checked before treating it as irrecoverable.`,
      )
    manifest.workspaceRecovery = await writeDerived(
      'workspace-recovery.md',
      `${lines.join('\n')}\n`,
    )
  }

  if (inputs.ticket === true) {
    const created = events.created
    if (created !== undefined && created.type === 'build.created') {
      const original = created.payload.ticket
      const current =
        original.source === 'hosted' ? (await store.getBuild(build))?.ticket : undefined
      const ticket = {
        ...original,
        ...(current?.source === original.source ? { id: current.id } : {}),
      }
      const lines = [
        `# Ticket: ${ticket.title ?? ticket.id}`,
        '',
        `- source: ${ticket.source}`,
        `- id: ${ticket.id}`,
        ...(ticket.url !== undefined ? [`- url: ${ticket.url}`] : []),
        ...(ticket.title !== undefined ? [`- title: ${ticket.title}`] : []),
        '',
      ]
      await writeDerived('ticket.md', lines.join('\n'))
    }
  }

  if (inputs.assets === true && state.pinnedAssets.length > 0) {
    // The pin, not the ticket's current state: the revisions `build.created`
    // (or the latest re-pinning `spec.revised`) recorded, fetched by explicit
    // revision so a later attach/replace/remove cannot change what a phase sees.
    const root = locate('assets')
    manifest.assets = []
    for (const pinned of state.pinnedAssets) {
      const asset = await store.getPinnedTicketAsset(
        build,
        pinned.kind,
        pinned.name,
        pinned.revision,
      )
      if (asset === null) {
        throw new Error(
          `pinned ticket asset ${pinned.kind}/${pinned.name} revision ${pinned.revision} is missing from the store`,
        )
      }
      const relPath = `${root}/${pinned.kind}/${pinned.name}`
      const target = join(abDir, relPath)
      // A file asset lands inside its directory as `<filename>`; a tree asset
      // keeps its relative tree, empty directories included.
      await mkdir(target, { recursive: true })
      await writeAssetTo(asset, target)
      manifest.assets.push({
        kind: pinned.kind,
        name: pinned.name,
        revision: pinned.revision,
        layout: pinned.layout,
        size: pinned.size,
        path: `${contextDir}/${relPath}`,
      })
    }
  }

  if (inputs.spec === true) {
    // §6.3 immutability: the spec a phase sees is the rev the spec.* events
    // anchor (spec.imported/authored/revised → state.specRev), never the
    // newest deposit — so a stray spec rev with no sanctioning event can
    // never swap the contract downstream reviewers approve conformance to.
    await writeArtifact('spec.md', 'spec', state.specRev)
  }

  // The plan a phase sees is the rev cited by the latest `plan.completed`
  // (D5: the terminal validates and cites this round's deposit). For
  // 'approved' inputs the engine only advances past the plan loop on an
  // approve verdict (§10), so the cited rev IS the approved one; for
  // plan-review's 'latest' it is the rev under review. Pinning to the
  // event-derived rev — never the newest deposit — keeps an out-of-loop
  // `ab artifact put plan` from swapping in a never-reviewed plan (§6.3's
  // drift argument, applied to the plan).
  if (inputs.plan !== undefined) {
    await writeArtifact('plan.md', 'plan', state.plan.artifactRev)
  }

  // Producer's own prior-round artifacts (§8.3: plan sees its prior rev,
  // implement its own prior notes) — the phase's required kind at latest rev;
  // absent on round 1 by construction.
  if (inputs.priorOwnArtifacts === true && spec.requiredArtifact !== undefined) {
    await writeArtifact(`${spec.requiredArtifact}.md`, spec.requiredArtifact)
  }

  if (inputs.implementNotes === true) {
    await writeArtifact('implement-notes.md', 'implement-notes')
  }

  // Verify reports at latest rev, one file per step (§8.3: routed-back
  // failure reports for implement; the full set for finalize).
  if (inputs.verifyReports === true) {
    const metas = await store.listArtifacts(build)
    const kinds = new Set(
      metas.map((meta) => meta.kind).filter((kind) => kind.startsWith('verify-report:')),
    )
    for (const kind of kinds) {
      const step = kind.slice('verify-report:'.length)
      await writeArtifact(`verify/${step}.md`, kind)
    }
  }

  if (inputs.findings === 'current' || inputs.currentFeedback === true) {
    if (phase === 'implement') {
      const receiptSeq = state.verifyStage.implementations[String(round)]
      const receipt = state.verifyStage.failures.find((f) => f.seq === receiptSeq)
      if (receipt) {
        manifest.verifyStageFailure = receipt
        manifest.verifyReports = []
        for (const failed of receipt.failed) {
          if (!failed.report) continue
          const path = await writeArtifact(
            `verify/${failed.step}.md`,
            failed.report.kind,
            failed.report.rev,
          )
          if (path === undefined)
            throw new Error(
              `Missing routed verify report ${failed.report.kind}@${failed.report.rev}`,
            )
          manifest.verifyReports.push({ step: failed.step, report: failed.report, path })
        }
        manifest.cancelledVerify = receipt.cancelled.map((c) => ({
          ...c,
          attempt: receipt.attempt,
          status: 'not-run' as const,
        }))
      }
    }
    const feedback = currentFeedback(events, phase, round)
    if (feedback !== null) {
      manifest.feedback = feedback
      if ('findings' in feedback) {
        // Ids → full Finding objects from the verdict that produced them.
        const byId = findingsById(events)
        const resolved = feedback.findings
          .map((id) => byId.get(id))
          .filter((finding): finding is Finding => finding !== undefined)
        await writeDerived('findings.json', `${JSON.stringify(resolved, null, 2)}\n`)
      } else if ('verify' in feedback && manifest.verifyReports === undefined) {
        // The verify failure report routed back into the code loop (§5) — the
        // exact rev the feedback cites, not just the latest.
        await writeArtifact(
          `verify/${feedback.verify.step}.md`,
          feedback.verify.report.kind,
          feedback.verify.report.rev,
        )
      } else if ('guidance' in feedback) {
        // A human escalation answer fed in as authoritative feedback (§15.6-B).
        await writeDerived('guidance.json', `${JSON.stringify(feedback.guidance, null, 2)}\n`)
      }
    }
  }

  if (inputs.findings === 'all-rounds') {
    // Every prior round's findings, for `persists` marking (§15.4), plus the
    // human-dismissed ids — the reviewer is told so (§15.6-B).
    const loop =
      phase === 'plan-review' ? state.reviewFindings.planReview : state.reviewFindings.codeReview
    for (let r = 1; r < round && r <= loop.length; r += 1) {
      await writeDerived(`history/findings-r${r}.json`, `${JSON.stringify(loop[r - 1], null, 2)}\n`)
    }
    const dismissed = dismissedIds(state, events)
    manifest.dismissedFindingIds = dismissed
    if (dismissed.length > 0) {
      await writeDerived('dismissed-findings.json', `${JSON.stringify(dismissed, null, 2)}\n`)
    }
  }

  // Answered guidance addressed to THIS phase (§15.6-B, §11): finalize and
  // reconcile have no producer round for the engine to feed the answer into,
  // so `ab context` IS their delivery channel — without this the answer would
  // be recorded but never reach any agent. Latest answer wins, matching the
  // engine's loop-feedback rule; the file shape matches the loop producers'
  // guidance.json so skills read one format.
  if (inputs.answeredGuidance === true) {
    const answered = state.answeredEscalations.filter(
      (escalation) => escalation.resolution === 'guidance' && escalation.phase === phase,
    )
    const latest = answered.at(-1) // answeredEscalations is in answer order
    if (latest !== undefined) {
      await writeDerived(
        'guidance.json',
        `${JSON.stringify({ escalation: latest.id, answer: latest.answer }, null, 2)}\n`,
      )
    }
  }

  // Read-deferral guidance repairs access for this same execution occurrence,
  // including reviewers, which have no producer-feedback carrier.
  if (manifest.feedback === undefined && (phase === 'plan-review' || phase === 'code-review')) {
    const latest = state.answeredEscalations
      .filter(
        (item) =>
          item.deferral === 'own-build-read' &&
          item.resolution === 'guidance' &&
          item.phase === phase &&
          item.round === round,
      )
      .at(-1)
    if (latest) {
      manifest.feedback = { guidance: { escalation: latest.id, answer: latest.answer } }
      await writeDerived(
        'guidance.json',
        `${JSON.stringify(manifest.feedback.guidance, null, 2)}\n`,
      )
    }
  }

  if (inputs.commitRange === true && state.kind === 'node' && state.integration?.cycle) {
    manifest.commitRange = {
      base: state.integration.cycle.parent,
      head: state.integration.cycle.head,
    }
  } else if (inputs.commitRange === true && state.implement.commits !== undefined) {
    manifest.commitRange = state.implement.commits
  }

  if (isVerifyPhase(phase) && state.kind === 'node' && state.integration?.cycle) {
    const cycle = state.integration.cycle
    if (!cycle.context)
      throw new Error(
        'node verification is missing prepared context input; prepare a new integration cycle',
      )
    const artifact = await store.getArtifact(build, cycle.context.kind, cycle.context.rev)
    if (!artifact) throw new Error('node verification prepared context artifact is missing')
    const { index, specs } = parseNodeVerificationContext(
      new TextDecoder().decode(artifact.content),
      cycle,
    )
    for (const contribution of index.contributions) {
      contribution.specPath = await writeDerived(
        `contributions/${contribution.build}/spec.md`,
        specs[contribution.build]!,
      )
    }
    const indexPath = await writeDerived(
      'node-verification.json',
      `${JSON.stringify(index, null, 2)}\n`,
    )
    const { commits: _commits, ...metadata } = index
    manifest.nodeVerification = { ...metadata, indexPath }
  }

  if (phase === 'reconcile' && state.nodeRestack?.conflict) {
    const node = state.nodeRestack
    const conflict = node.conflict!
    const change = node.active!.changes[conflict.index]!
    manifest.nodeChange = {
      owner: build,
      transaction: node.active!.id,
      index: conflict.index,
      sha: change.sha,
      build: change.build,
      foreign: change.build === undefined,
    }
    manifest.conflict = { baseSha: conflict.base }
    if (!change.build)
      await writeArtifact(
        'foreign-change.patch',
        `node-source-${node.active!.id}-${conflict.index}-foreign`,
      )
  }
  if (inputs.conflict === true) {
    // `pr.conflicted.baseSha` is the janitor's detection-time evidence. The
    // runner refreshes the remote base immediately before each actual run and
    // records the execution input in reconcile.started. A crashed same-attempt
    // rerun can therefore have multiple starts; the newest matching AB_PHASE
    // attempt is authoritative.
    const baseSha = events.reconcileBases[String(round)]
    if (baseSha !== undefined) manifest.conflict = { baseSha }
    if (events.reconcileTransaction?.attempt === round) {
      manifest.replay = {
        ...events.reconcileTransaction,
        conflicted: events.reconcileReplay?.conflicted,
        needsCompletion: events.reconcileReplay?.conflicted ?? true,
      }
    }
    if (manifest.conflict === undefined) {
      throw new Error(
        `reconcile@${round} context requires a matching reconcile.started event ` +
          'with the freshly resolved base SHA — the runner must record the phase start before launching the session',
      )
    }
  }

  if (inputs.stepConfig === true && isVerifyPhase(phase)) {
    const step = verifyStep(phase)
    const tomlPath = join(workspacePath, 'autobuild.toml')
    const file = Bun.file(tomlPath)
    if (!(await file.exists())) {
      throw new Error(
        `verify:${step} needs its step config, but ${tomlPath} does not exist — ` +
          'autobuild.toml declares [verify.<step>] tables (SPEC §16.1)',
      )
    }
    const config = parseConfig(await file.text(), tomlPath)
    const stepConfig = config.verify.stepConfigs[step]
    if (stepConfig === undefined) {
      const known = Object.keys(config.verify.stepConfigs)
      throw new Error(
        `verify step "${step}" is not configured in autobuild.toml — ` +
          `configured steps: ${known.join(', ') || '(none)'} (SPEC §16.1)`,
      )
    }
    manifest.step = { name: step, config: stepConfig }
  }

  // inputs.prTemplate (§8.3 finalize): autobuild.toml declares no PR-template
  // table in §16.1, so there is nothing to materialize yet — the input stays
  // in the table for when config grows one.

  await mkdir(dirname(join(abDir, manifestRelPath)), { recursive: true })
  await writeFile(join(abDir, manifestRelPath), `${JSON.stringify(manifest, null, 2)}\n`)

  // Legacy tracked scratch is repository debt, not content Autobuild rewrites.
  // Record it once per build from the provisioned base so harvest can groom it.
  if (gitWorkspace && deps.ids !== undefined) {
    const provisioned = events.firstWorkspace
    const marker = 'phase-scratch:tracked-at-provisioned-base'
    const alreadyRecorded = events.observations.some((observation) =>
      observation.refs?.includes(marker),
    )
    if (
      provisioned !== undefined &&
      provisioned.type === 'workspace.provisioned' &&
      !alreadyRecorded
    ) {
      const baseTracked = await trackedScratchPaths(
        deps.exec!,
        workspacePath,
        provisioned.payload.base.sha,
      )
      if (baseTracked.length > 0) {
        await store.append(build, {
          actor: KERNEL,
          type: 'observation.recorded',
          payload: {
            id: deps.ids('obs'),
            kind: 'followup',
            summary: `repository base tracks Autobuild phase scratch: ${baseTracked.join(', ')}`,
            files: baseTracked,
            refs: [marker],
          },
        })
      }
    }
  }
  return manifest
}
