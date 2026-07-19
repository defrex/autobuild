/**
 * Ports (SPEC §3.2): interfaces to the world, each with swappable adapters.
 * The kernel and processes depend only on these types; adapters live in
 * `ports/<port>/` and fakes for seam tests in `ports/fakes/`.
 */
import type { TicketRef, WorkspaceBase } from '../ontology'

// ── TicketSource (SPEC §3.2, §13) ────────────────────────────────────────────
//
// Policy (§13): the TicketSource initiates and receives projections; it is
// never consulted mid-build and never used as artifact storage. A file-based
// adapter with nowhere to put blobs must be fully workable.

export interface Ticket {
  ref: TicketRef
  title: string
  /** The ticket body — pre-build, the spec lives here (§6.3). */
  body: string
  state?: string
  labels: string[]
  /** Source-local ids of tickets declared as blockers. Absent ≡ none. */
  blockedBy?: string[]
}

export interface TicketDraft {
  title: string
  body: string
  labels?: string[]
  /** Source-local blocker ids, recorded natively at creation (§13). An
   * adapter must record every one or throw — never discard silently. */
  blockedBy?: string[]
}

/** One node of the dependency graph, as this source sees it. */
export interface DependencyState {
  /** The requested source-local id, echoed back. */
  id: string
  /** False = no such ticket in this source. */
  exists: boolean
  /**
   * Complete per this source's NATIVE lifecycle semantics — the adapter owns
   * this meaning and callers must not re-derive it from `state` (§13: the
   * provider's taxonomy never leaks above the port). Linear: `state.type` in
   * `completed | canceled`. File: state equals the source's done state.
   */
  resolved: boolean
  /** This node's own declared blockers, so callers can close the graph. */
  blockedBy: string[]
}

export interface TicketCreateOptions {
  /** Explicit workflow state for this create (harvest always targets Triage). */
  state?: string
  /** Source-level adoption key for crash-safe external creation. File and fake
   * sources treat it as opaque; Linear requires a durably reserved UUID v4,
   * sends it verbatim as the issue id, and queries that id when adopting. */
  idempotencyKey?: string
}

export interface TicketSource {
  readonly name: string
  /** Ready tickets matching the dispatch criteria (label/state — §3.3). */
  listReady(criteria: { labels?: string[]; state?: string }): Promise<Ticket[]>
  get(id: string): Promise<Ticket | null>
  /** Claim-before-launch (§12): false means someone else already claimed it. */
  claim(id: string): Promise<boolean>
  comment(id: string, body: string): Promise<void>
  transition(id: string, state: string): Promise<void>
  create(draft: TicketDraft, opts?: TicketCreateOptions): Promise<Ticket>
  /**
   * Dependency-graph nodes for `ids`. The result covers EVERY requested id, in
   * request order; a missing id comes back `{exists: false, resolved: false,
   * blockedBy: []}`. Read at ticket creation and at dispatch time only — both
   * are initiation, so §13's "never consulted mid-build" is untouched.
   */
  dependencyStates(ids: string[]): Promise<DependencyState[]>
}

// ── Workspace (SPEC §3.2, §7) ────────────────────────────────────────────────

export interface WorkspaceHandle {
  provider: string
  /** Provider-scoped identifier (e.g. the worktree path). */
  ref: string
  /** Absolute path of the working copy. */
  path: string
  branch: string
}

export interface WorkspaceProvisionResult extends WorkspaceHandle {
  /** Durable evidence for the commit this provision selected or reused. */
  base: WorkspaceBase
}

export interface WorkspaceProvider {
  readonly name: string
  provision(opts: {
    repo: string
    baseBranch: string
    branch: string
  }): Promise<WorkspaceProvisionResult>
  release(handle: WorkspaceHandle): Promise<void>
}

// ── Forge (SPEC §3.2, §8.6, §15.7) ───────────────────────────────────────────
//
// D7: agents never touch the remote — push, PR creation, and forge API calls
// are plumbing triggered by terminal commands. D1: PR→main is squash merge,
// main→feature is a merge commit, rebase is banned.

export interface PrRef {
  number: number
  url: string
  headSha: string
}

export type PrState =
  | { state: 'open'; mergeable: boolean | null }
  | { state: 'merged'; sha: string }
  | { state: 'closed' }

/** Result of reconciling durable auto-merge intent with the forge. Native
 * state is acknowledged only by `applied`; the other results deliberately
 * leave the command pending for a later janitor poll. */
export type AutoMergeResult =
  | { kind: 'applied' }
  | { kind: 'ungated'; headSha: string }
  | { kind: 'deferred' }

export interface Forge {
  readonly name: string
  /** Push a local branch to the remote (from the workspace's working copy). */
  pushBranch(workspacePath: string, branch: string): Promise<void>
  openPr(opts: {
    workspacePath: string
    head: string
    base: string
    title: string
    body: string
  }): Promise<PrRef>
  /** Janitor poll (§15.7): merged/closed/mergeability for one PR. */
  getPrState(workspacePath: string, number: number): Promise<PrState>
  /**
   * Reconcile GitHub-native auto-merge desired state. Enabling returns an
   * ungated candidate only after proving the base branch has no merge-blocking
   * gate; transient merge states are deferred. The operation is idempotent and
   * safe to retry across the forge-call/event-append crash window.
   */
  setAutoMerge(
    workspacePath: string,
    number: number,
    enabled: boolean,
  ): Promise<AutoMergeResult>
  /**
   * Perform a normal squash merge, guarded by the inspected PR head. This is
   * never an admin/force operation: forge-side protection still applies.
   */
  squashMerge(
    workspacePath: string,
    number: number,
    expectedHeadSha: string,
  ): Promise<void>
  /** Post the build's summary comment (§7.5). */
  commentOnPr(workspacePath: string, number: number, body: string): Promise<void>
}

// ── AgentRunner (SPEC §9) ────────────────────────────────────────────────────
//
// Session-based, because review loops need memory: the producer *continues*
// its session across rounds; the reviewer gets a fresh one each round (§10).
// Every production adapter also exposes this distribution's `ab` launcher at
// the front of the tool environment's PATH; CLI availability is a runner
// guarantee and does not depend on a global installation or host ordering.

export interface AgentSessionHandle {
  id: string
  runner: string
  model?: string
}

interface AgentTurnResultBase {
  /** Final text of the turn — informational only; outcomes travel the typed
   * channel (`ab done|verdict|escalate`), never parsed from output (§8.4). */
  text: string
  usage: { inputTokens: number; outputTokens: number; turns: number }
}

/** A turn whose provider/runtime completed normally. This does not mean the
 * phase completed: only a typed terminal event can express that outcome. */
export interface AgentTurnCompleted extends AgentTurnResultBase {
  kind: 'completed'
}

export interface AgentTurnFailure {
  /** Provider/runner text, preserved verbatim when one was supplied. */
  message: string
  /** False means "apply the existing bounded retry policy"; it does not claim
   * the failure is transient. True is reserved for positive permanent signals
   * such as authentication, permission, quota, or billing rejection. */
  permanent: boolean
}

/** A turn that reached a provider/runtime-declared failure while retaining an
 * endable session handle, so transcript deposition remains guaranteed. */
export interface AgentTurnFailed extends AgentTurnResultBase {
  kind: 'failed'
  failure: AgentTurnFailure
}

/** SDK/provider-declared failures must use the failed variant. A completed turn
 * with no typed terminal is the distinct `no-terminal` condition (§8.4). */
export type AgentTurnResult = AgentTurnCompleted | AgentTurnFailed

/** Transcripts come back through the interface, not scraped from disk (§9). */
export interface Transcript {
  content: string
  metadata: {
    runner: string
    model?: string
    usage: { inputTokens: number; outputTokens: number; turns: number }
  }
}

export interface AgentStartOpts {
  /** Installed skill to invoke, e.g. `ab-plan`. */
  skill: string
  /** Opaque argument passed to the skill (build slug or harvest run id). */
  invocation?: string
  /** Backward-compatible build name; new callers should also set invocation. */
  buildSlug?: string
  workspacePath: string
  model?: string
  /** Named extensions this session may use (§9, third axis). Empty/absent ⇒
   * hermetic. Runtime-specific: adapters without an extension model ignore it. */
  extensions?: readonly string[]
  /** Scoped ambient auth (D8): AB_STORE, AB_BUILD, AB_PHASE, AB_SESSION,
   * AB_TOKEN. Adapters merge it over their process environment and then apply
   * the runner-controlled Autobuild CLI PATH prefix. */
  env: Record<string, string>
}

/** Per-turn refresh for a continued session (§10): each continue turn is a
 * NEW session bracket (next round, fresh session id), so the runner
 * re-issues ambient auth for the turn (D8) — merged over the start env. A
 * turn left on round 1's env would have the CLI resolve the stale round and
 * reject the continued round's terminal as a D5 second call (§8.4). */
export function agentInvocation(opts: AgentStartOpts): string {
  const invocation = opts.invocation ?? opts.buildSlug
  if (invocation === undefined || invocation === '') {
    throw new Error('AgentStartOpts requires a non-empty invocation')
  }
  return invocation
}

export interface AgentContinueOpts {
  env?: Record<string, string>
}

export interface AgentRunner {
  readonly name: string
  start(
    opts: AgentStartOpts,
  ): Promise<{ session: AgentSessionHandle; result: AgentTurnResult }>
  /** Review-loop rounds (§10). Adapters without native resumption implement
   * this as start-with-rehydrate-from-store (§9). */
  continue(
    session: AgentSessionHandle,
    message: string,
    opts?: AgentContinueOpts,
  ): Promise<AgentTurnResult>
  /** Always called; the transcript goes to the store — the corpus is
   * guaranteed complete (§9). */
  end(session: AgentSessionHandle): Promise<Transcript>
}

// ── TelemetrySource (SPEC §3.2, §12) ─────────────────────────────────────────

export interface Signal {
  source: string
  id: string
  title: string
  url?: string
  /** Evidence for the proposal this signal may become (spec standard §6.1). */
  evidence: Record<string, unknown>
  occurrences?: number
  usersAffected?: number
  firstSeen?: string
  lastSeen?: string
}

export interface TelemetrySource {
  readonly name: string
  fetchSignals(since?: string): Promise<Signal[]>
}
