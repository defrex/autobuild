import type { SelectedAccount } from '../config/accounts'
export type { ForgeReadinessCheck, ForgeReadinessInput } from './forge/readiness'
import type { ForgeReadinessCheck, ForgeReadinessInput } from './forge/readiness'
import type { BuildStore } from '../store/types'
import { ForgeRejection } from './forge-failure'
/**
 * Ports (SPEC §3.2): interfaces to the world, each with swappable adapters.
 * The kernel and processes depend only on these types; adapters live in
 * `ports/<port>/` and fakes for seam tests in `ports/fakes/`.
 */
import type {
  HostedPrAttachmentAsset,
  PrAttachment,
  PrImageHostTarget,
  TicketRef,
  WorkspaceBase,
} from '../ontology'
import type { StreamOutcome, StreamPart } from '../store/streams/types'
import type { BuildExecution } from './workspace/build-execution'
import type { HarvestExecution } from './workspace/harvest-execution'
import type { OperatorSandboxExecution } from './workspace/operator-sandbox'

// ── Session streams (SPEC §9) ─────────────────────────────────────────────
//
// The live, protocol-shaped view of a build session: a runner that holds the
// optional streaming capability translates its harness's native output into
// AI SDK UI Message Stream parts and appends them as they happen. Streams
// are presentation, never routing; outcomes still travel only the typed CLI.

/**
 * The per-turn write side of a session stream. `append` NEVER throws: a
 * failing stream path must never fail a turn. Adapters call it with the
 * part vocabulary of `ai-ui-message-stream/v1` plus the `data-ab-*`
 * extension parts.
 */
export interface SessionStreamEmitter {
  append(parts: StreamPart[]): void
}

/**
 * The bracket-scoped sink a runtime registration's `openSessionStream`
 * capability receives: `open` creates the store stream and returns its id,
 * after which the sink is also an emitter; `close` is idempotent (first
 * outcome wins) and best-effort.
 */
export interface SessionStreamSink extends SessionStreamEmitter {
  open(label: string): Promise<string>
  close(outcome: StreamOutcome): Promise<void>
}

// ── TicketSource (SPEC §3.2, §13) ────────────────────────────────────────────
//
// Policy (§13): the TicketSource initiates and receives projections; it is
// never consulted mid-build and never used as artifact storage. A file-based
// adapter with nowhere to put blobs must be fully workable.

/** A recorded comment, with its exact body and source timestamp. */
export interface TicketComment {
  body: string
  createdAt: string
  author?: string
}

export type TicketKind = 'work' | 'node'

export interface Ticket {
  /** Optional only for legacy plugin compatibility; public reads normalize to work. */
  kind?: TicketKind
  /** Canonical source-local node ticket id; absent means the baseBranch root. */
  target?: string
  /** Opaque source version of title, body, labels, state and blockers. */
  revision: string
  /** Complete history oldest first when exposed by this read. Absent means
   * unsupported; an empty array means no comments. Bodies are unchanged. */
  comments?: TicketComment[]
  ref: TicketRef
  /** Stable source-native key used to correlate an externally created ticket
   * with Autobuild's durable creation reservation. It is separate from the
   * operator-facing `ref.id` and optional for legacy/plugin projections. */
  creationKey?: string
  title: string
  /** The ticket body — pre-build, the spec lives here (§6.3). */
  body: string
  state?: string
  /** Native completion fact, identical to DependencyState.resolved. */
  resolved: boolean
  labels: string[]
  /** Listing-time source fact that all declared blockers are resolved. Only
   * true permits skipping dependency reads; consumers fall back when absent. */
  blockersResolved?: boolean
  /** Source-local ids of tickets declared as blockers. Absent ≡ none. */
  blockedBy?: string[]
  /** Forge issues this ticket addresses, sorted by issue number. Absent ≡ none
   * or unsupported by the source. */
  issueLinks?: IssueLink[]
  /** `urgent` dispatches before normal ready work. Absent means normal, or a
   * source that cannot store priority. Normalized tickets never carry `normal`. */
  priority?: TicketPriority
}

/** Dispatch class: urgent ready work is claimed before normal ready work. */
export type TicketPriority = 'urgent' | 'normal'

export type IssueLinkIntent = 'closes' | 'refs'

/** One forge issue a ticket addresses: `closes` fully resolves it, `refs`
 * only partly addresses it. */
export interface IssueLink {
  issue: number
  intent: IssueLinkIntent
}

export interface TicketCriteria {
  labels?: string[]
  state?: string
  /** Only the ready tickets assigned to this user. The value's forms are
   * source-defined; `me` is the owner of the source's credential. Only sources
   * declaring `readyAssignee` receive it — the rest refuse
   * `[tickets].readyAssignee` before any listing. */
  assignee?: string
}

export interface TicketPage {
  limit: number
  offset?: number
  order?: 'oldest' | 'newest'
}

export interface TicketPageListing extends TicketListing {
  /** Matching count before ordering and slicing. No operator-specific limit cap. */
  total: number
}

/** A partial source scan. Diagnostics name source records that were excluded
 * from eligibility; infrastructure failures and source-wide invariants still
 * reject `listReady` rather than appearing here. */
export interface TicketListing {
  tickets: Ticket[]
  diagnostics: string[]
}

export interface TicketDraft {
  kind?: TicketKind
  target?: string | null
  title: string
  body: string
  /** Labels applied at creation. Names need not already exist in the source;
   * adapters own any provider-side label-registry reconciliation. */
  labels?: string[]
  /** Source-local blocker ids, recorded natively at creation (§13). An
   * adapter must record every one or throw — never discard silently. */
  blockedBy?: string[]
  /** Forge issues this ticket addresses. An adapter without the `issueLinks`
   * capability must refuse, never discard. */
  issueLinks?: IssueLink[]
  /** Dispatch class. A source without the `priority` capability refuses
   * `urgent`; `normal` is a no-op. */
  priority?: TicketPriority
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
   * `completed | canceled`. File: state equals the source's done state. The
   * dispatcher applies the configured rejected role on top: a blocker whose
   * `state` holds that role never resolves.
   */
  resolved: boolean
  /** The blocker's native state name when the source knows it; absent when
   * unsupported or when the ticket does not exist. */
  state?: string
  /** This node's own declared blockers, so callers can close the graph. */
  blockedBy: string[]
}

export interface TicketCreateOptions {
  /** Requested source id. Unsupported adapters must reject it. */
  requestedId?: string
  /** Explicit workflow state for this create (harvest always targets Triage). */
  state?: string
  /** Source-level adoption key for crash-safe external creation. File and fake
   * sources treat it as opaque; Linear requires a durably reserved UUID v4,
   * sends it verbatim as the issue id, and queries that id when adopting;
   * GitHub writes it as a hidden marker in the issue body by the same request
   * that opens the issue. */
  idempotencyKey?: string
  /** ISO-8601. The earliest time this creation key could first have been
   * used. A source whose key lookup is time-bounded (github) requires it with
   * a key. Other sources ignore it. Callers must pass the same value on every
   * retry. */
  idempotencyKeyReservedAt?: string
}

/** Editable ticket fields. Omitted fields are preserved; state is deliberately
 * absent because `transition()` exclusively owns lifecycle changes. */
export interface TicketUpdate {
  kind?: TicketKind
  target?: string | null
  /** Required when named: an update cannot clear the ticket's title. */
  title?: string
  /** Required when named: pre-build, this is the spec (§6.3). */
  body?: string
  /** A complete label replacement. An explicit empty array clears labels.
   * Names need not already exist in the source; adapters own any
   * provider-side label-registry reconciliation. */
  labels?: string[]
  /** A complete issue-link replacement. An explicit empty array clears links. */
  issueLinks?: IssueLink[]
  /** `normal` removes urgency. A source without the `priority` capability
   * refuses `urgent`; `normal` is a no-op. */
  priority?: TicketPriority
}

/** One workflow state of a source that can enumerate them. */
export interface TicketStateInfo {
  name: string
  /** Tickets currently in the state. */
  tickets: number
  /** One-line purpose recorded when the state was created, if any. */
  about?: string
}

/** One state's ticket total from a bounded count read; `name` is canonical. */
export interface TicketStateCount {
  name: string
  tickets: number
}

/** Source methods may reject with this failure; it is not a dependency verdict. */
export class TicketSourceRateLimitError extends Error {
  constructor(
    readonly source: string,
    /** UTC epoch milliseconds at which a caller may try again. */
    readonly resetAt: number,
  ) {
    super(`${source}: rate limited until ${new Date(resetAt).toISOString()}`)
    this.name = 'TicketSourceRateLimitError'
  }
}

export type TicketAssetStore = {
  /** Native ownership, including tombstones, prevents resurrection from legacy stores. */
  hasTicketAssetHistory?(repo: string, id: string, kind: string, name: string): Promise<boolean>
} & Pick<
  BuildStore,
  | 'ticketAssetLimits'
  | 'putTicketAsset'
  | 'getTicketAsset'
  | 'listTicketAssets'
  | 'removeTicketAsset'
>

export type TicketMutation =
  | { kind: 'update'; patch: TicketUpdate }
  | { kind: 'transition'; state: string }
  | { kind: 'blockers'; operation: 'block' | 'unblock'; ids: string[] }

export interface ExportSnapshotOptions {
  signal?: AbortSignal
  progress?: (progress: { completed: number; total?: number; resetAt?: number }) => void
}

export interface TicketSource {
  /** Complete export-only snapshot; ordinary dispatch reads keep their own policy. */
  readExportSnapshot?(opts?: ExportSnapshotOptions): Promise<Ticket[]>
  /** Opt in only when kind/target persistence, graph validation and complete
   * enumeration are supported at every write boundary, including guarded writes. */
  readonly integrationTree?: boolean
  /** Opt in only when issue links are persisted and returned at every write
   * boundary, including create and guarded writes. Sources without it refuse
   * any write naming issue links. */
  readonly issueLinks?: boolean
  /** Opt in only when urgent priority is persisted and returned at every write
   * boundary, including create and guarded writes. Sources without it read
   * every ticket as normal and refuse any write naming `urgent`. */
  readonly priority?: boolean
  /** Opt in only when `listReady` (and `listPage`, if implemented) honour
   * `criteria.assignee` and an unassigned ticket is never ready while it is
   * set. Sources without it refuse `[tickets].readyAssignee` at startup,
   * `ab init --validate` and on reload, naming the source. */
  readonly readyAssignee?: boolean
  /** Resolve, outside any dispatcher tick, what a value like `me` needs (for
   * example the credential's owner). Dispatch calls it once at startup whether
   * or not `readyAssignee` is set. Memoize the result; record a credential
   * with no user instead of throwing, and throw only for infrastructure
   * failures. */
  prepareReadyAssignee?(): Promise<void>
  /** Synchronous and request-free: why this value cannot be honoured given
   * what `prepareReadyAssignee` resolved, or undefined. Checked at dispatcher
   * startup and on every reload. */
  readyAssigneeRefusal?(value: string): string | undefined
  /** `ab init --validate`: a one-line summary of who the value names (for
   * example `me → @octocat`); throws an actionable error when it names nobody. */
  describeReadyAssignee?(value: string): Promise<string>
  /** Every lifecycle state, including archived/completed tickets; no ready gate. */
  listAll?(): Promise<TicketListing>
  /** Optional bounded integration read: every ticket in every lifecycle state
   * whose target is `nodeId`, exhausting pagination — exactly
   * `listAll().tickets.filter(t => t.target === nodeId)`. Diagnostics name only
   * excluded records it read. Infrastructure failures reject; a failure never
   * falls back to `listAll`. Sources declaring it must declare integrationTree. */
  listTargeting?(nodeId: string): Promise<TicketListing>
  /** Import support: the same pure id policy used by create, for mutation-free preflight. */
  readonly requestedIds?: import('./tickets/requested-id').RequestedIdPolicy
  /** Import support: the source chooses every created id, so import remaps
   * every ticket and adopts committed creates through the creation key inside
   * `create`. */
  readonly allocatesIds?: boolean
  /** Explicit comment history, oldest first, for export and import only;
   * `null` for an unknown ticket. Never called on a recurring path. */
  readComments?(id: string): Promise<TicketComment[] | null>
  /** Every planned import input this source would refuse, reported together
   * before any import write. */
  importProblems?(input: {
    states: string[]
    labels: string[]
    creationKeys: string[]
  }): Promise<string[]>
  readonly assets?: TicketAssetStore
  /** Check and mutate at the source boundary; absent means checks are unsupported. */
  mutateIfRevision?(id: string, expectedRevision: string, mutation: TicketMutation): Promise<void>
  readonly name: string
  /** Ready tickets matching the dispatch criteria (label/state — §3.3), plus
   * actionable diagnostics for individual source records excluded as invalid.
   * Fatal source failures and invariants still reject the call. */
  listReady(criteria: TicketCriteria): Promise<TicketListing>
  /** Optional native window, equivalent to listReady then reverse/slice.
   * Defaults: offset 0, order oldest. Arguments are nonnegative integers;
   * zero limit returns no tickets with the full matching total. Diagnostics
   * and failures match listReady; a failure must not trigger a full-read fallback.
   * listReady and listAll remain exhaustive. */
  listPage?(criteria: TicketCriteria, page: TicketPage): Promise<TicketPageListing>
  get(id: string): Promise<Ticket | null>
  /** Claim-before-launch (§12): acquires nonterminal work and returns true.
   * Returns false for an unknown, already-claimed/contested, or terminal ticket.
   * Refusing a terminal ticket leaves its state unchanged; claim never reopens
   * completed work. An explicit transition to a nonterminal state permits a
   * later claim. */
  claim(id: string): Promise<boolean>
  comment(id: string, body: string): Promise<void>
  transition(id: string, state: string): Promise<void>
  create(draft: TicketDraft, opts?: TicketCreateOptions): Promise<Ticket>
  /** Partially replace editable fields. The patch must be nonempty and strict;
   * omitted fields (including unmodeled provider metadata) remain untouched. */
  update(id: string, patch: TicketUpdate): Promise<void>
  /** Add one same-source blocker. Retries are idempotent; the target and
   * blocker must exist, and a ticket may not block itself. */
  addBlocker(id: string, blockerId: string): Promise<void>
  /** Remove one same-source blocker. Missing relations are successful no-ops;
   * only the target ticket is required to still exist. */
  removeBlocker(id: string, blockerId: string): Promise<void>
  /**
   * Dependency-graph nodes for `ids`. The result covers EVERY requested id, in
   * request order; a missing id comes back `{exists: false, resolved: false,
   * blockedBy: []}`. Read at ticket creation and at dispatch time only — both
   * are initiation, so §13's "never consulted mid-build" is untouched.
   */
  dependencyStates(ids: string[]): Promise<DependencyState[]>
  /**
   * Optional state discovery (`ab ticket states`): every state the source has,
   * lifecycle states first in workflow order, then the rest alphabetically.
   * Sources that cannot enumerate their states omit it.
   */
  listStates?(): Promise<TicketStateInfo[]>
  /**
   * Optional bounded per-state counts for the named states (display only).
   * Each name resolves like `resolveState` (exact, else one case-insensitive
   * match); unmatched or ambiguous names are omitted. Never returns or parses
   * ticket rows. A store-backed source answers from maintained totals, so its
   * cost does not grow with the number of tickets.
   */
  countStates?(names: readonly string[]): Promise<TicketStateCount[]>
  /**
   * Optional state creation (`ab ticket state create`). Duplicate policy is
   * adapter-specific: file creation is idempotent and can replace purpose;
   * hosted creation refuses existing names in any case. Rejects malformed names.
   * Named `addState` because adapters already hold a `createState` option field.
   */
  addState?(
    name: string,
    opts?: { about?: string },
  ): Promise<{ state: TicketStateInfo; created: boolean }>
}

// ── Workspace (SPEC §3.2, §7) ────────────────────────────────────────────────

export interface WorkspaceHandle {
  provider: string
  /** Provider-scoped identifier (worktree path or sandbox name). */
  ref: string
  /** Absolute working-copy path in the provider's execution environment. It
   * is not necessarily reachable from the dispatcher. */
  path: string
  /** Dispatcher-reachable path when one exists. Remote providers omit it. */
  localPath?: string
  branch: string
}

export interface WorkspaceProvisionResult extends WorkspaceHandle {
  /** Durable evidence for the commit this provision selected or reused. */
  base: WorkspaceBase
  /** Preserved branch heads not restored over the branch. Omitted when empty. */
  restorationSkipped?: RestorationSkip[]
}

/** A preserved branch head the branch already contains, or that a recorded
 * rewrite in the build's bounded replaced-head record superseded. */
export interface RestorationSkip {
  sha: string
  reason: 'contained' | 'superseded'
}

/** A provider refused to destroy a checkout during provision/start. The
 * dispatcher must record its identity before fencing and preservation. */
export class WorkspaceCleanupRequired extends Error {
  constructor(
    readonly workspace: WorkspaceHandle & { base?: WorkspaceBase },
    cause: unknown,
  ) {
    super(
      `workspace ${workspace.ref} requires dispatcher-authorized cleanup: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    this.name = 'WorkspaceCleanupRequired'
  }
}

export interface WorkspacePreservationHead {
  sha: string
  remoteRef: string
  role: 'branch' | 'producer'
  commits: string[]
}
export type WorkspaceFenceOutcome =
  | { outcome: 'confirmed' | 'absent' }
  | { outcome: 'unknown'; error: string }

export interface WorkspacePublication {
  recoverCandidate?(input: {
    ref: string
    slug: string
    branch: string
    sha: string
    replayPack?: string
  }): Promise<boolean>

  /** Dispatcher-only, after a durable non-destructive fence. `absent` means
   * the environment is gone or exists without a provisioned checkout. Errors
   * never constitute proof that an environment or its unpublished work is
   * absent. */
  preserve?(input: {
    ref: string
    slug: string
    branch: string
    base: string
    candidates: string[]
    /** Shas a recorded rewrite replaced (bounded, newest last). A local
     * branch they cover is archived only as a producer, never as `branch`. */
    replaced?: string[]
    /** True only when the dispatcher's log shows no execution ever started in
     * this environment. Such a checkout holds no unpublished work, so objects
     * it lacks mean nothing to preserve rather than an error. Absent keeps
     * every object probe strict. */
    neverExecuted?: boolean
  }): Promise<{ outcome: 'preserved'; heads: WorkspacePreservationHead[] } | { outcome: 'absent' }>

  /** Trusted after-teardown path; never route a restack through plain publish. */
  rewrite?(input: {
    ref: string
    sha: string
    branch: string
    expected: string
    localExpected?: string
    archives: { ref: string; sha: string }[]
  }): Promise<RewriteResult>
  /** Observe whether the exact requested commit already reached the durable
   * remote branch after an interrupted acknowledgement. `ref` optionally
   * names the workspace whose git database the probe runs against — used by
   * the operator-sandbox publication path, whose provider probes from the
   * sandbox checkout; the build-path callers may also supply it. Inspection
   * must not resume a stopped remote guest; publish owns guest cache repair
   * before teardown. */
  isPublished?(input: { ref?: string; sha: string; branch: string }): Promise<boolean>
  /** Publish exactly one commit to exactly one branch; no arbitrary command
   * surface is exposed to the dispatcher or build child. */
  publish(input: { ref: string; sha: string; branch: string }): Promise<void>
}

/** Snapshot-purge evidence recorded with a workspace cleanup fact. Absence of
 * leftover snapshots can be proven from these durable events without querying
 * the provider. */
export interface WorkspaceReapSnapshots {
  outcome: 'confirmed' | 'absent' | 'unknown'
  deleted?: number
  error?: string
}

export interface WorkspaceReapOutcome {
  outcome: 'confirmed' | 'absent'
  snapshots: WorkspaceReapSnapshots
}

export interface WorkspaceRecovery {
  /** Stops execution without deleting the workspace or its snapshots. */
  fence?(handle: WorkspaceHandle): Promise<WorkspaceFenceOutcome>

  /** Fence an unavailable environment. Unknown outcomes must reject so the
   * dispatcher retains the lease/workspace fact and retries after its fence. */
  reap(handle: WorkspaceHandle): Promise<WorkspaceReapOutcome>
}

export interface WorkspaceProvider {
  /** Local adapters may provide the same boundary capability without becoming
   * a remote-publication provider. */
  readonly preservation?: NonNullable<WorkspacePublication['preserve']>

  readonly name: string
  /** Optional workspace-adjacent executor. Remote providers substitute here;
   * locally reachable providers use the shipped subprocess capability. */
  readonly buildExecution?: BuildExecution
  /** Optional hosted-harvest executor. Present on providers that can
   * provision a disposable environment for harvest sessions; its absence
   * keeps harvest running locally in the dispatcher's workspace. */
  readonly harvestExecution?: HarvestExecution
  /** Optional operator-sandbox host (AUT-340): one persistent,
   * credential-free environment per operator × repository behind registry
   * tools. Present on providers that can provision it; absent means the
   * provider cannot host an operator sandbox, and sandbox tools stay
   * unavailable over that provider. */
  readonly orchestratorSandbox?: OperatorSandboxExecution
  /** Trusted dispatcher-only publication capability for remote workspaces. */
  readonly publication?: WorkspacePublication
  /** Publication capability for the operator sandbox (PR-only publication):
   * deliberately distinct from `publication`, which is the dispatcher's
   * remote-workspace discriminator — its presence reclassifies every build
   * workspace as remote and reroutes build publication. `sandboxPublication`
   * is never consulted by the dispatcher; it is consumed only by the
   * operator-sandbox publish service, and present only on providers that can
   * host operator sandboxes. */
  readonly sandboxPublication?: WorkspacePublication
  /** Optional only for remote/disposable providers. */
  readonly recovery?: WorkspaceRecovery
  provision(opts: {
    repo: string
    baseBranch: string
    branch: string
    /** Confirmed publication and known stale cache tips, from durable facts.
     * Providers must preserve unknown unpublished work during ordinary resume. */
    publication?: { sha: string; cacheHeads: string[] }
    restoration?: WorkspacePreservationHead[]
    /** The build's bounded replaced-head record, newest last. A preserved
     * branch head it covers must not be restored over the branch; report it
     * in `restorationSkipped`. */
    restorationReplaced?: string[]
    /** Where the forge keeps `restoration` archive refs: `local` (local-git)
     * means the repository already holds them and restoration must not
     * consult a remote; `remote` means they may exist only on origin. */
    restorationArchives?: 'local' | 'remote'
    /** Immutable recovery checkpoint, never a moved base branch. */
    revision?: string
    /** Monotonic environment generation used in provider idempotency keys. */
    generation?: number
  }): Promise<WorkspaceProvisionResult>
  release(handle: WorkspaceHandle): Promise<void>
}

// ── Forge (SPEC §3.2, §8.6, §15.7) ───────────────────────────────────────────
//
// D7: agents never touch the remote — push, PR creation, and forge API calls
// are plumbing triggered by terminal commands. D1: PR→main is squash merge,
// reconcile replays one change onto its frozen base with archived evidence and exact head guards.

export interface PrRef {
  number: number
  /** Provider locator. HTTP(S) when the forge has a web UI; otherwise a
   * meaningful provider-native identifier such as a local Git ref. */
  url: string
  headSha: string
}

/** Native state is sampled with the ordinary PR read. Omission means the
 * adapter cannot observe it; callers retain conservative cancellation. */
export type PrState =
  | { state: 'open'; mergeable: boolean | null; nativeAutoMerge?: boolean }
  | { state: 'merged'; sha: string; headSha?: string }
  | { state: 'closed' }

/** Abort cleanup may race landing. A merged result is terminal and must never
 * be overwritten by a close attempt. */
export type ClosePrResult = { state: 'closed' } | { state: 'merged'; sha: string }

/** Result of reconciling durable auto-merge intent with the forge. Native
 * state is acknowledged only by `applied`; the other results deliberately
 * leave the command pending for a later janitor poll. */
export type AutoMergeDeferralCode =
  | 'github-plan-limitation'
  | 'repository-auto-merge-disabled'
  | 'gated-node-destination'
  | 'unproven-gate-state'
  /** A persistent, definite state — GitHub has computed merge conflicts with
   * the base branch. Recovery is updating the branch or resolving the
   * conflicts, not gate-state investigation. */
  | 'merge-conflicts'
  /** Mergeability not yet computed — transient, resolves on retry. */
  | 'mergeability-uncomputed'
  | 'local-base-checkout-dirty'
  | 'local-git-identity-missing'

/** How a deferral resolves. `pipeline-resolved` codes are recovered by the
 * pipeline itself — reconcile for merge conflicts, a later poll for
 * not-yet-computed mergeability — and record no operator observation.
 * `human-actionable` codes need a person to fix the named condition and keep
 * the one-observation-per-PR-and-command rule. Adding a code without choosing
 * a class is a compile error. */
export type AutoMergeDeferralClass = 'pipeline-resolved' | 'human-actionable'

export const autoMergeDeferralClasses = {
  'github-plan-limitation': 'human-actionable',
  'repository-auto-merge-disabled': 'human-actionable',
  'gated-node-destination': 'human-actionable',
  'unproven-gate-state': 'human-actionable',
  'merge-conflicts': 'pipeline-resolved',
  'mergeability-uncomputed': 'pipeline-resolved',
  'local-base-checkout-dirty': 'human-actionable',
  'local-git-identity-missing': 'human-actionable',
} as const satisfies Record<AutoMergeDeferralCode, AutoMergeDeferralClass>

export interface AutoMergeDeferralReason {
  /** Stable machine-readable family used by durable operator observations. */
  code: AutoMergeDeferralCode
  /** Provider detail. It must identify auto-merge inspection/application, not PR creation. */
  detail: string
}

export type AutoMergeResult =
  | { kind: 'applied' }
  | { kind: 'ungated'; headSha: string }
  | { kind: 'deferred'; reason?: AutoMergeDeferralReason }

/** One explicitly designated image artifact to copy to a review-window host. */
export interface PrAttachmentUploadRequest {
  workspacePath: string
  target: PrImageHostTarget
  prUrl: string
  attachment: PrAttachment
  content: Uint8Array
  /** Full lowercase SHA-256 / BuildStore blobRef for `content`. */
  sha256: string
}

export interface PrAttachmentReclaimRequest {
  /** Cleanup deliberately runs from the main repository after workspace removal. */
  workspacePath: string
  asset: HostedPrAttachmentAsset
}

/** Narrow optional Forge capability. Its absence is a supported text-only
 * path, not a verification outcome. */
export interface PrAttachmentHosting {
  upload(request: PrAttachmentUploadRequest): Promise<HostedPrAttachmentAsset>
  reclaim(request: PrAttachmentReclaimRequest): Promise<void>
}

export interface BuildLandingOptions {
  buildSlug: string
  /** Optional query hint, verified against the current provider PR base. */
  baseBranch?: string
  /** Refresh durable consent and pipeline eligibility before native mutation. */
  canApply?: () => Promise<boolean>
  /** The build's sealed issue links, passed only to a `closesIssues` forge
   * for a leaf aimed at the default branch. The adapter composes them into
   * the landed headline and message with `kernel/issue-keywords`. */
  issueLinks?: readonly IssueLink[]
}

/** GitHub's "No commits between" 422: a forge rejection the empty-node path
 * recognizes by class. */
export class NoCommitsBetweenBranchesError extends ForgeRejection {
  constructor(
    message: string,
    rejection: { forge?: string; status?: number; forgeMessage?: string } = {},
  ) {
    super(message, {
      forge: rejection.forge ?? 'GitHub',
      status: rejection.status ?? 422,
      forgeMessage: rejection.forgeMessage || message,
    })
    this.name = 'NoCommitsBetweenBranchesError'
  }
}

/** Reconcile-only branch replacement. All object ids are exact, never ref expressions.
 * A successful CAS overtaken before readback returns lease-mismatch with
 * rewritten: true: record its receipt, then replay actual instead of completing. */
export type RewriteResult =
  | { kind: 'published' }
  | { kind: 'lease-mismatch'; actual: string | null; rewritten?: true }
export interface ForgeRewrite {
  /** General destination publication, restricted to proven fast-forward ancestry. */
  fastForward?(input: {
    workspacePath: string
    branch: string
    expected: string
    sha: string
  }): Promise<RewriteResult>

  snapshot(input: {
    workspacePath: string
    branch: string
    destinationRef: string
  }): Promise<string>
  /** Remote archives recover remote-present objects by exact ref and return a verified local commit. */
  archive(input: { workspacePath: string; ref: string; sha: string }): Promise<void>
  replace(input: {
    workspacePath: string
    branch: string
    expected: string
    localExpected?: string
    sha: string
  }): Promise<RewriteResult>
}

/** Read-only proof for controlled landing into an exact destination branch.
 * Bypass privileges are never evidence that a branch is ungated. */
export type LandingGateInspection =
  | { kind: 'proved-ungated' }
  | { kind: 'gated'; reason: string }
  | { kind: 'unproven'; reason: string }

export { ForgeFailure, ForgeRejection, isForgeFailure, isForgeRejection } from './forge-failure'
export type {
  ForgeFailureDetails,
  ForgeRejectionDetails,
  ForgeRequestContext,
  ForgeRequestObserver,
} from './forge-failure'

export interface Forge {
  /** Optional observation epoch. Concurrent operations outside the callback stay independent. */
  withReadScope?<T>(work: () => Promise<T>): Promise<T>
  /** Prime opened-node observations; absent capabilities preserve ordinary reads. */
  primeNodeReads?(input: {
    workspacePath: string
    parent: string
    head: string
    prNumber?: number
  }): Promise<void>

  /** Optional API 1.8 capability. Absence means unavailable counts. */
  observeRequests?(observer: import('./forge-failure').ForgeRequestObserver): () => void

  inspectReadiness?(input: ForgeReadinessInput): Promise<ForgeReadinessCheck[]>
  /** Trusted kernel-only Git execution, with forge credentials scoped to its
   * origin. Never pass this capability or its environment to agent sessions. */
  readonly kernelExec?: import('./workspace/git-worktree').Exec
  /** Credentialed rewrite transport for dispatcher-owned node work. Workspace
   * replay retains its existing provider-controlled transport. */
  readonly kernelRewrite?: ForgeRewrite
  mergeLinearStack?(workspacePath: string, number: number, expectedHead: string): Promise<string>
  inspectMergeFreshness?(branch: string): Promise<{ fenced: boolean; evidence: string[] }>
  inspectLandingGate?(branch: string): Promise<LandingGateInspection>
  inspectLandingPr?(
    workspacePath: string,
    number: number,
  ): Promise<{ base: string; head: string; headSha: string; open: boolean }>

  /** Change only an existing open review's base, preserving its identity.
   * Implementations acknowledge only a matching inspected base/head. */
  retargetPr?(workspacePath: string, number: number, base: string): Promise<void>
  readonly rewrite?: ForgeRewrite
  /** Create once at sha; retries adopt only descendants of that opening commit. */
  createNodeBranch?(branch: string, sha: string): Promise<string>
  /** Observe exact heads and count commits reachable only from head. */
  compareBranches?(
    parent: string,
    head: string,
  ): Promise<{
    parentSha: string
    headSha: string
    ahead: number
  }>

  readonly name: string
  /** Closing keywords that reach the default branch close issues. A forge
   * declaring it composes `issueLinks` into the PR title and body and into
   * landing messages; without it links are recorded but never emitted. */
  readonly closesIssues?: boolean
  /** Rewrite an open PR's keyword paragraph so the body ends with one line
   * per link (composed with `kernel/issue-keywords`, `trailers: false`) and
   * neutralize closing references to `refs` issues in its title, writing
   * only on change, then confirm both by readback. Called only with
   * `closesIssues`, for a node's PR. Throws when the PR is not open or the
   * readback disagrees. Without it a node's set is recorded but never
   * written. */
  updatePrIssueLinks?(
    workspacePath: string,
    number: number,
    issueLinks: readonly IssueLink[],
  ): Promise<void>
  /** Optional because another forge may support PRs but not public image assets. */
  readonly prAttachments?: PrAttachmentHosting
  /** Publish this exact SHA (HEAD for legacy callers); success requires authoritative readback. */
  /** Exact authoritative observation, refreshing remote-backed caches only on a match.
   * Missing capability refuses kernel publication before attempting a write. */
  confirmPublication?(workspacePath: string, branch: string, sha: string): Promise<boolean>
  pushBranch(workspacePath: string, branch: string, sha?: string): Promise<void>
  openPr(opts: {
    workspacePath: string
    head: string
    base: string
    title: string
    body: string
    /** Untouched deposited pr-description. Providers may use it as the
     * landing message; title/body remain the portable review projection. */
    mergeMessage?: string
    /** Issue links, passed only to a `closesIssues` forge: a leaf aimed at
     * the default branch gets its sealed links; a leaf aimed at a node gets
     * them refs-only; a root node gets its own links merged with its landed
     * children's union; a nested node gets that set refs-only. An adapter
     * that adopts an existing open PR for the head must converge it
     * idempotently when links are present: neutralize the existing title,
     * canonicalize the body's keyword lines, write only on change and
     * confirm by readback, without replacing the title, prose or merge
     * message. */
    issueLinks?: readonly IssueLink[]
  }): Promise<PrRef>
  /** Optional authoritative base resolver. Capability-less adapters retain
   * the legacy origin fetch performed by the caller. The destination is a
   * build-private ref in the workspace's shared Git database. */
  snapshotBase?(opts: {
    workspacePath: string
    base: string
    destinationRef: string
  }): Promise<string>
  /** Janitor poll (§15.7): merged/closed/mergeability for one PR. */
  getPrState(workspacePath: string, number: number): Promise<PrState>
  /** Optional additive abort-cleanup capabilities. Older plugins remain
   * loadable, but cleanup stays pending with an actionable diagnostic. */
  closePr?(workspacePath: string, number: number): Promise<ClosePrResult>
  deleteBranch?(workspacePath: string, branch: string): Promise<void>
  /**
   * Reconcile GitHub-native auto-merge desired state. Enabling returns an
   * ungated candidate only after proving the base branch has no merge-blocking
   * gate. Transient merge states defer quietly; non-transient inability to
   * inspect or apply consent returns a reason-bearing deferral. The operation
   * is idempotent and safe to retry across the forge-call/event-append crash window.
   * With options it is also called on every eligible poll while a request is
   * armed: a matching request returns `applied` without mutation, and any
   * repair calls `options.canApply` first.
   */
  setAutoMerge(
    workspacePath: string,
    number: number,
    enabled: boolean,
    options?: BuildLandingOptions,
  ): Promise<AutoMergeResult>
  /**
   * Perform a normal squash merge, guarded by the inspected PR head. This is
   * never an admin/force operation: forge-side protection still applies.
   */
  squashMerge(
    workspacePath: string,
    number: number,
    expectedHeadSha: string,
    options?: BuildLandingOptions,
  ): Promise<void>
  /** Actual landed message. Absent capability or read failure means unknown
   * trailer evidence; neither may prevent observing a merged PR. */
  readCommitMessage?(workspacePath: string, sha: string): Promise<string>
  /** Inspect exact trailer values across all reachable history, including
   * merged side branches. Missing refs/read failures throw; false is proven
   * absence. Do not cache by branch name across history rewrites. */
  containsBuild?(workspacePath: string, branch: string, buildSlug: string): Promise<boolean>
  /** Post the build's summary comment (§7.5). */
  commentOnPr(workspacePath: string, number: number, body: string): Promise<void>
  /** Authoritative forge branch tip. Absence or failure must defer target
   * observation; callers must never substitute dispatcher-host refs. */
  remoteBranchSha?(branch: string): Promise<string>
  /** Whether `branch` exists on the authoritative forge remote. False is proven
   * absence; transport, auth or malformed responses throw. Dispatch uses it at
   * claim time so a new build never takes a branch another store owns, and to
   * recognize a target node branch another store opened. Absent capability keeps
   * store-only slug deduplication and reports one startup warning. */
  remoteBranchExists?(branch: string): Promise<boolean>
  /** Prove ancestry of immutable commit OIDs in the authoritative repository.
   * False means a proven non-descendant; absent capability or unknown objects
   * must fail closed, never authorize replay. */
  isCommitAncestor?(ancestor: string, descendant: string): Promise<boolean>
  /** Optional checkout-less capability: raw file bytes from the repository.
   * Ref omitted → the repository's default branch. Throws when the path does
   * not exist. Its absence retains reading configuration from a checkout. */
  readFile?(path: string, ref?: string): Promise<string>
}

// ── AgentRunner (SPEC §9) ────────────────────────────────────────────────────
//
// Session-based, because review loops need memory: the producer *continues*
// its session across rounds; the reviewer gets a fresh one each round (§10).
// Every production adapter also exposes this distribution's `ab` launcher at
// the front of the tool environment's PATH; CLI availability is a runner
// guarantee and does not depend on a global installation or host ordering.

/** Portable native identity only: never credentials, prompts or process handles. */
export interface NativeSessionHandle {
  version: 1
  runner: string
  nativeId: string
  host: string
  workspacePath: string
  statePath?: string
}

export type NativeSessionObserver = (handle: NativeSessionHandle) => Promise<void>
export type AgentResumeOpts = AgentStartOpts
export type AgentResumeResult =
  | { kind: 'resumed'; session: AgentSessionHandle; result: AgentTurnResult }
  | {
      kind: 'not-resumable'
      reason: 'unsupported' | 'wrong-runner' | 'wrong-host' | 'wrong-workspace' | 'missing-state'
      message: string
    }

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

export type AgentFailureCause = 'availability' | 'exhaustion' | 'credentials' | 'configuration'

export interface AgentTurnFailure {
  /** Provider/runner text, preserved verbatim when one was supplied. */
  message: string
  /** False means "apply the existing bounded retry policy"; it does not claim
   * the failure is transient. True remains the compatibility signal used by
   * retry policy. Provider exhaustion is permanent for retry purposes while
   * still being eligible for a configured alternate. */
  permanent: boolean
  /** Additive structured routing cause. Legacy plugin runners may omit it;
   * their existing permanent bit then supplies the conservative behavior. */
  cause?: AgentFailureCause
  /** Set with cause 'configuration' when the runtime's CLI executable is not
   * installed. This is the one configuration failure a configured alternate
   * may serve; every other configuration failure still stops the chain. */
  missingExecutable?: true
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
  account?: SelectedAccount
  /** Await before further native output/prompt processing. Rejections are
   * infrastructure failures and must propagate to the caller. */
  onNativeSession?: NativeSessionObserver
  /** Installed skill to invoke, e.g. `ab-plan`. */
  skill: string
  /** Opaque argument passed to the skill (build slug or harvest run id). */
  invocation?: string
  /** Backward-compatible build name; new callers should also set invocation. */
  buildSlug?: string
  workspacePath: string
  model?: string
  /** Extra CLI argv tokens for the selected runtime, in declared order. */
  args?: readonly string[]
  /** Scoped ambient auth (D8): AB_STORE, AB_BUILD, AB_PHASE, AB_SESSION,
   * AB_TOKEN. Adapters merge it over their process environment and then apply
   * the runner-controlled Autobuild CLI PATH prefix. */
  env: Record<string, string>
  /** Caller-owned cancellation for this turn. Aborting must leave any created
   * session endable so its transcript can still be deposited. */
  signal?: AbortSignal
  /** Live session stream, present only when the resolved runtime declared
   * the streaming capability (SPEC §9). A turn without it emits no parts. */
  stream?: SessionStreamEmitter
}

/** The inputs a runtime's start prompt depends on; no env, workspace or signal. */
export type StartPromptOpts = Pick<AgentStartOpts, 'skill' | 'invocation' | 'buildSlug'>

/** Per-turn refresh for a continued session (§10): each continue turn is a
 * NEW session bracket (next round, fresh session id), so the runner
 * re-issues ambient auth for the turn (D8) — merged over the start env. A
 * turn left on round 1's env would have the CLI resolve the stale round and
 * reject the continued round's terminal as a D5 second call (§8.4). */
export function agentInvocation(opts: StartPromptOpts): string {
  const invocation = opts.invocation ?? opts.buildSlug
  if (invocation === undefined || invocation === '') {
    throw new Error('AgentStartOpts requires a non-empty invocation')
  }
  return invocation
}

export interface AgentContinueOpts {
  /** Await before further native output/prompt processing. Rejections are
   * infrastructure failures and must propagate to the caller. */
  onNativeSession?: NativeSessionObserver
  env?: Record<string, string>
  /** Caller-owned cancellation for this continued turn. */
  signal?: AbortSignal
  /** Live session stream, present only when the resolved runtime declared
   * the streaming capability (SPEC §9). A turn without it emits no parts. */
  stream?: SessionStreamEmitter
}

export interface AgentRunner {
  readonly name: string
  resume?(
    handle: NativeSessionHandle,
    message: string,
    opts: AgentResumeOpts,
  ): Promise<AgentResumeResult>
  start(opts: AgentStartOpts): Promise<{ session: AgentSessionHandle; result: AgentTurnResult }>
  /** The exact first message `start(opts)` sends for these inputs. The kernel
   * records it on `session.started` before launch. Omit it when unknown;
   * the fact then records no prompt. */
  startPrompt?(opts: StartPromptOpts): string
  /** Review-loop rounds (§10), continuing the live native conversation. */
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
