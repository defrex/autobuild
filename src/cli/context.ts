/**
 * The `ab context` materializer (SPEC §8.3): a phase-scoped hydration of the
 * gitignored `.ab/` scratch dir. Everything derives from
 * `PHASE_SPECS[phase].inputs` — the table drives, so the CLI, the manifest,
 * and the engine all validate against the same data (no per-phase switch
 * sprawl). Scoping is deliberate: what a phase *can't* see is part of its
 * design (the planner never sees code-review rounds; the reviewer sees prior
 * findings but not the producer's session).
 *
 * `.ab/` is wiped and recreated on every run — stale context is worse than no
 * context — and nothing outside `.ab/` is ever touched. Two carve-outs keep
 * the wipe honest: the dev-server control state (`server.pid`/`server.log`,
 * §16.2 D10 — ServerControl's only handle to a deliberately CLI-outliving
 * process) survives it, and a self-excluding `.ab/.gitignore` is (re)written
 * so the scratch dir is actually gitignored (§7, §8.3) without mutating the
 * repo's own `.gitignore`.
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseConfig } from '../config/load'
import type { VerifyStepConfig } from '../config/schema'
import type { AbEvent } from '../events/catalog'
import {
  allowedTerminals,
  phaseSpecFor,
  type PhaseSpec,
  type TerminalCommand,
} from '../kernel/phases'
import { reduceBuild, type BuildState } from '../kernel/reducer'
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
import type { BuildStore } from '../store/types'
import type { CliEnv } from './env'

export interface ContextDeps {
  store: BuildStore
  env: CliEnv
  /** Root of the working copy; `.ab/` is created directly under it. */
  workspacePath: string
}

/** Paths are relative to `.ab/`, forward-slash separated. */
export type MaterializedEntry = ArtifactRef | 'derived'

/**
 * The manifest (§8.3): the agent's contract — `required` deposits and
 * `allowedTerminals` — sourced from the same PHASE_SPECS table the terminal
 * commands validate with, so skills are self-checking.
 */
export interface ContextManifest {
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
  /** relPath → source artifact ref, or 'derived' for event-derived files. */
  materialized: Record<string, MaterializedEntry>
  /** From the latest `implement.completed` (§8.3 code-review/verify inputs). */
  commitRange?: CommitRange
  /** Reconcile: `{baseSha}` freshly recorded by this attempt's phase start (§15.7). */
  conflict?: { baseSha: string }
  /** Agent-verify: the step's config from the workspace's autobuild.toml (§16.1). */
  step?: { name: string; config: VerifyStepConfig }
  /** The feedback this producer round was started with (§15.3, §10). */
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
function findingsById(events: AbEvent[]): Map<string, Finding> {
  const byId = new Map<string, Finding>()
  for (const event of events) {
    if (event.type === 'plan-review.verdict' || event.type === 'code-review.verdict') {
      for (const finding of event.payload.findings) byId.set(finding.id, finding)
    }
  }
  return byId
}

/**
 * The feedback carried by this round's `*.started` event (§15.3).
 * `implement.started` and `plan.started` both carry a feedback field
 * (symmetric by design) — the carrier that gets an answered guidance
 * escalation to a FRESH producer session after a parked build re-attaches
 * (§15.6-B). A `plan.started` without one (logs predating the field) falls
 * back to deriving round-N feedback from the round-(N-1)
 * `plan-review.verdict` — the plan loop's verdicts ARE its findings channel
 * (§8.3: "prior plan rev + findings").
 */
function currentFeedback(events: AbEvent[], phase: Phase, round: number): Feedback | null {
  if (phase === 'implement') {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!
      if (event.type === 'implement.started' && event.payload.round === round) {
        return event.payload.feedback ?? null
      }
    }
    return null
  }
  if (phase === 'plan') {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!
      if (event.type === 'plan.started' && event.payload.round === round) {
        if (event.payload.feedback !== undefined) return event.payload.feedback
        break // legacy start without the field — derive from the prior verdict
      }
    }
    if (round <= 1) return null
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!
      if (event.type === 'plan-review.verdict' && event.payload.round === round - 1) {
        return event.payload.verdict === 'revise'
          ? { findings: event.payload.findings.map((finding) => finding.id) }
          : null
      }
    }
  }
  return null
}

/** Dev-server control state that must survive the `.ab/` wipe (§16.2 D10):
 * ServerControl (src/cli/server-control.ts) keeps its only handle to the
 * CLI-outliving server process in these files. */
const SERVER_CONTROL_FILES = new Set(['server.pid', 'server.log'])

/** Empty `.ab/` except the server control files — see the module doc. */
async function wipeAbDir(abDir: string): Promise<void> {
  await mkdir(abDir, { recursive: true })
  for (const entry of await readdir(abDir)) {
    if (SERVER_CONTROL_FILES.has(entry)) continue
    await rm(join(abDir, entry), { recursive: true, force: true })
  }
}

function dismissedIds(state: BuildState): string[] {
  const ids = new Set<string>()
  for (const escalation of state.answeredEscalations) {
    if (escalation.resolution !== 'dismiss-finding') continue
    for (const ref of escalation.refs ?? []) ids.add(ref)
  }
  return [...ids]
}

/**
 * Materialize the phase's `.ab/` tree and return the manifest (also written
 * as `.ab/context.json`).
 */
export async function buildContext(deps: ContextDeps): Promise<ContextManifest> {
  const { store, env, workspacePath } = deps
  const { build, phase, round } = env
  const spec = phaseSpecFor(phase)
  const inputs = spec.inputs
  const events = await store.getEvents(build)
  const state = reduceBuild(events)

  // Wipe and recreate (§8.3): stale context is worse than no context. Only
  // `.ab/` is ever removed — the workspace's other files are untouched — and
  // the dev-server control state survives the wipe: `.ab/server.pid` is
  // ServerControl's ONLY handle to a server that deliberately outlives its
  // CLI process (§16.2 D10); deleting it would orphan a running server from
  // every later `ab server` command.
  const abDir = join(workspacePath, '.ab')
  await wipeAbDir(abDir)
  // §7/§8.3 define `.ab/` as gitignored scratch, but nothing guarantees the
  // repo's own .gitignore says so. A self-excluding `.ab/.gitignore` makes
  // the dir invisible to git (status/add) in ANY repo — so implement's
  // clean-worktree check (D5) never trips on scratch and agents are never
  // coerced into committing it — without mutating a tracked file as an
  // unreviewed side effect.
  await writeFile(join(abDir, '.gitignore'), '*\n')

  const materialized: Record<string, MaterializedEntry> = {}

  async function writeDerived(relPath: string, content: string): Promise<void> {
    const target = join(abDir, relPath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
    materialized[relPath] = 'derived'
  }

  /** Latest rev when `rev` omitted; silently skips absent kinds — the tree is
   * a projection of what exists, and the manifest shows what materialized. */
  async function writeArtifact(
    relPath: string,
    kind: string,
    rev?: number,
  ): Promise<void> {
    const artifact = await store.getArtifact(build, kind, rev)
    if (artifact === null) return
    const target = join(abDir, relPath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, artifact.content)
    materialized[relPath] = { kind: artifact.meta.kind, rev: artifact.meta.revision }
  }

  const manifest: ContextManifest = {
    build,
    phase,
    round,
    required: requiredKinds(spec, phase),
    allowedTerminals: allowedTerminals(phase),
    materialized,
  }

  if (inputs.ticket === true) {
    const created = events.find((event) => event.type === 'build.created')
    if (created !== undefined && created.type === 'build.created') {
      const ticket = created.payload.ticket
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

  if (inputs.findings === 'current') {
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
      } else if ('verify' in feedback) {
        // The verify failure report routed back into the code loop (§5) — the
        // exact rev the feedback cites, not just the latest.
        await writeArtifact(
          `verify/${feedback.verify.step}.md`,
          feedback.verify.report.kind,
          feedback.verify.report.rev,
        )
      } else {
        // A human escalation answer fed in as authoritative feedback (§15.6-B).
        await writeDerived('guidance.json', `${JSON.stringify(feedback.guidance, null, 2)}\n`)
      }
    }
  }

  if (inputs.findings === 'all-rounds') {
    // Every prior round's findings, for `persists` marking (§15.4), plus the
    // human-dismissed ids — the reviewer is told so (§15.6-B).
    const loop =
      phase === 'plan-review'
        ? state.reviewFindings.planReview
        : state.reviewFindings.codeReview
    for (let r = 1; r < round && r <= loop.length; r += 1) {
      await writeDerived(
        `history/findings-r${r}.json`,
        `${JSON.stringify(loop[r - 1], null, 2)}\n`,
      )
    }
    manifest.dismissedFindingIds = dismissedIds(state)
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

  if (inputs.commitRange === true && state.implement.commits !== undefined) {
    manifest.commitRange = state.implement.commits
  }

  if (inputs.conflict === true) {
    // `pr.conflicted.baseSha` is the janitor's detection-time evidence. The
    // runner refreshes the remote base immediately before each actual run and
    // records the execution input in reconcile.started. A crashed same-attempt
    // rerun can therefore have multiple starts; the newest matching AB_PHASE
    // attempt is authoritative.
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!
      if (event.type === 'reconcile.started' && event.payload.attempt === round) {
        manifest.conflict = { baseSha: event.payload.baseSha }
        break
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

  await writeFile(join(abDir, 'context.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}
