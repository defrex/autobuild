/**
 * The agent tool registry — one typed table that is the single source of
 * truth for the agent-facing operator surface (AUT-338).
 *
 * Every entry names a tool, describes it for a model, declares its Zod input
 * schema (every field documented), carries MCP annotations and an approval
 * class, and binds a handler that calls the same control/query/ticket service
 * the operator API route calls — never a reimplementation. Bindings (the
 * in-process registry itself, `ab mcp` over stdio, later transports) are
 * generated from this table, so adding a tool here makes it appear in every
 * face. The table never widens beyond the operator services.
 *
 * Wire-encoding invariant: every handler returns a JSON-serializable plain
 * value — never a `Uint8Array` or other non-JSON type. Binary content is
 * carried as base64 strings at the entry level (`builds.artifact`'s
 * `contentBase64` is the base64 of the exact artifact bytes), so a binding's
 * `JSON.stringify` can never silently corrupt bytes. The contract suite
 * (registry.contract.test.ts) asserts the round-trip for every tool.
 *
 * Risk classes live in `operator/annotations.ts` (checked in, enforced by the
 * contract suite). The registry itself enforces only what every binding needs
 * identically: input validation before the handler, attributed identity for
 * every mutator, and — for constrained bindings — repository targeting.
 */
import { z } from 'zod'
import { controlBuild, BuildControlError, type BuildControlAction } from '../cli/build-control'
import { bulkControlRepository, BulkWalkError } from '../cli/bulk-control'
import { systemClock, type BuildStore, type Clock } from '../store/types'
import { TicketOperationError } from '../ports/tickets/operations'
import { OPERATOR_NOTES_REPO_KIND } from '../store/retention'
import {
  OperatorControlError,
  setRepositorySetting,
  toggleHarvestGate,
  toggleRepositorySetting,
  controlHarvestRun,
} from './control'
import {
  getHarvestStatus,
  getOperatorBuild,
  getRepositoryStatus,
  listOperatorBuilds,
  OperatorQueryError,
} from './query'
import {
  answerRequestSchema,
  harvestControlRequestSchema,
  ticketBlockerRequestSchema,
  ticketCreateRequestSchema,
  ticketMoveRequestSchema,
  ticketUpdateRequestSchema,
  type OperatorAnswerRequest,
} from './protocol'
import { OPERATOR_TOOL_ANNOTATIONS, type OperatorToolName } from './annotations'
import { answerAction, controlPrechecks, requireRouteBuild, RouteRefusalError } from './requests'
import {
  getOperatorTicket,
  listOperatorTickets,
  mutateOperatorTicket,
  type OperatorTicketBackend,
} from './tickets'

/** The retention-managed repository artifact kind the notes tools serve. */
export const OPERATOR_NOTES_ARTIFACT = OPERATOR_NOTES_REPO_KIND

/** One tool invocation's full context: who is calling, and what to operate on. */
export interface ToolContext {
  /** The opened store the handler operates through. */
  store: BuildStore
  /** The operator ticket backend; required only by the ticket tools. */
  tickets?: OperatorTicketBackend
  clock: Clock
  /** The caller's attributed identity (the operator user every write names). */
  identity?: string
  /** Optional binding marker recorded with the caller's identity (e.g. "mcp"). */
  via?: string
}

/** The failure body shape the operator API emits, mapped one-to-one so a tool
 * and its route fail identically. HTTP status is a route concern; the kinds
 * are shared vocabulary. */
export interface ToolFailureBody {
  kind: 'validation' | 'auth' | 'not-found' | 'conflict' | 'refusal' | 'internal'
  error: string
  code?: string
  progress?: unknown
}

export type RegistryErrorReason =
  | 'validation'
  | 'no-identity'
  | 'unknown-tool'
  | 'repo-mismatch'
  | 'domain'

/** Every registry-level refusal. `reason` is the registry's own vocabulary;
 * `body` is the operator-API-shaped failure a binding should surface. */
export class RegistryError extends Error {
  override readonly name = 'RegistryError'

  constructor(
    readonly reason: RegistryErrorReason,
    message: string,
    readonly body: ToolFailureBody,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

export type ToolApproval = 'never' | 'default'

/** Handlers receive the schema-validated input (typed `never` so the only
 * invocation path is `registry.call`, which validates first) and the context. */
export type ToolHandler = (input: never, ctx: ToolContext) => Promise<unknown>

export interface ToolEntry {
  name: OperatorToolName
  /** Written for a model: what the tool does and what it returns. */
  description: string
  /** Zod schema; every field carries its own `.describe()`. */
  inputSchema: z.ZodType
  /** Appended to the description by bindings that can show it. */
  outputDescription: string
  /** MCP annotation hints, from the checked-in annotations table. */
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
  }
  approval: ToolApproval
  handler: ToolHandler
}

/** The attribution rule every mutating handler shares: refuse without a
 * caller identity, else return it. `call()` enforces this before the handler
 * runs; handlers call it again so a directly-invoked handler cannot write
 * unattributed. */
export function attributed(ctx: ToolContext): string {
  const identity = ctx.identity?.trim()
  if (identity === undefined || identity === '') {
    throw new RegistryError(
      'no-identity',
      'this tool mutates durable state and requires an attributed operator identity',
      {
        kind: 'auth',
        error: 'this tool mutates durable state and requires an attributed operator identity',
      },
    )
  }
  return identity
}

/** The ticket tools need the backend; the route refuses without one and so
 * does the registry (same conflict body as the route). */
function ticketsOf(ctx: ToolContext): OperatorTicketBackend {
  if (ctx.tickets === undefined) {
    throw new RouteRefusalError({
      kind: 'conflict',
      error: 'ticket operator backend is not configured',
    })
  }
  return ctx.tickets
}

/** Extend every member of a request-union schema with shared routing fields
 * (repo, slug) while preserving each member's own strict semantics — the
 * `"{repo, slug} & request"` shape the routes express with URL + body. */
function extendUnion(schema: z.ZodType, extra: z.ZodRawShape): z.ZodType {
  const options = (schema as unknown as { options?: readonly z.ZodObject[] }).options
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error('extendUnion requires a union schema with options')
  }
  return z.union(options.map((option) => option.extend(extra)))
}

// ── Shared input fields ──────────────────────────────────────────────────────

const repoField = z
  .string()
  .min(1)
  .describe(
    'Repository identity as the store keys it: the checkout’s normalized origin URL (e.g. "https://github.com/acme/widgets").',
  )
const slugField = z.string().min(1).describe('Build slug identifying one build in the store.')
const ticketIdField = z
  .string()
  .min(1)
  .describe('Ticket id in the configured ticket source (e.g. "AUT-8").')

const buildListInput = z.strictObject({
  repo: repoField,
  scope: z
    .enum(['active', 'queued', 'all'])
    .default('active')
    .describe(
      'Which builds to include: "active" (running, paused, or blocked — the default), "queued", or "all".',
    ),
})

const buildDetailInput = z.strictObject({ repo: repoField, slug: slugField })

const ticketDetailInput = z.strictObject({ repo: repoField, id: ticketIdField })

const buildEventsInput = z.strictObject({
  repo: repoField,
  slug: slugField,
  cursor: z
    .number()
    .int()
    .min(0)
    .describe(
      'Event sequence cursor: return build events with seq strictly greater than this (0 = the whole log).',
    ),
  waitSeconds: z
    .number()
    .int()
    .min(0)
    .max(30)
    .default(0)
    .describe(
      'Bounded wait: hold the call for at most this many seconds waiting for at least one new event before returning an empty page (0–30; 0 returns immediately).',
    ),
})

const buildArtifactInput = z.strictObject({
  repo: repoField,
  slug: slugField,
  kind: z.string().min(1).describe('Artifact kind to download (e.g. "spec", "plan", "notes").'),
  rev: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Artifact revision to fetch; omit for the latest revision of the kind.'),
})

const buildControlInput = z.strictObject({
  repo: repoField,
  slug: slugField,
  action: z
    .enum([
      'pause',
      'cancel-pause',
      'resume',
      'auto-merge-on',
      'auto-merge-off',
      'abort',
      'discard',
    ])
    .describe(
      'Control to request: "pause" (or "cancel-pause" to revoke a pending pause), "resume" a paused build, "auto-merge-on"/"auto-merge-off" for native auto-merge — or the destructive "abort" (cancels the build, cleans up its PR and workspace, returns the ticket to triage) and "discard" (dequeue a queued build).',
    ),
})

const buildsAnswerInput = extendUnion(answerRequestSchema, { repo: repoField, slug: slugField })

const repositoryStatusInput = z.strictObject({ repo: repoField })

const repositorySettingsInput = z.strictObject({
  repo: repoField,
  setting: z
    .enum(['intake', 'auto-merge-default'])
    .describe(
      '"intake" gates whether new tickets may be claimed; "auto-merge-default" is the claim-time auto-merge default for newly claimed builds.',
    ),
  enabled: z
    .boolean()
    .optional()
    .describe('Set the value explicitly; omit to toggle the current durable value.'),
})

const bulkControlInput = z.strictObject({
  repo: repoField,
  action: z
    .enum(['pause', 'resume'])
    .describe(
      '"pause" holds every queued build, turns intake off, and requests pause on every running build without a pending pause; "resume" reverses all three.',
    ),
})

const harvestStatusInput = z.strictObject({ repo: repoField })

const harvestControlInput = extendUnion(harvestControlRequestSchema, { repo: repoField })

const ticketsListInput = z.strictObject({
  repo: repoField,
  state: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Provider state to list; defaults to the effective triage state from the repository’s effective config.',
    ),
  labels: z
    .array(z.string().min(1))
    .optional()
    .describe('Narrow the list to tickets carrying every named label.'),
})

const ticketsCreateInput = ticketCreateRequestSchema.extend({ repo: repoField })

const ticketsUpdateInput = ticketUpdateRequestSchema
  .extend({ repo: repoField, id: ticketIdField })
  .refine(
    (value) => value.title !== undefined || value.body !== undefined || value.labels !== undefined,
    'update must name at least one field',
  )

const ticketsBlockersInput = ticketBlockerRequestSchema.extend({
  repo: repoField,
  id: ticketIdField,
  blockerIds: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'Blocker ticket ids to relate (at least one); the first id is the ticket being changed.',
    ),
})

const ticketsMoveInput = ticketMoveRequestSchema.extend({
  repo: repoField,
  id: ticketIdField,
  state: z
    .string()
    .min(1)
    .describe(
      'Provider state to move the ticket into. Destructive: moving a ticket into the repository’s configured ready state queues it for dispatch.',
    ),
})

const notesReadInput = z.strictObject({ repo: repoField })

const notesWriteInput = z.strictObject({
  repo: repoField,
  document: z
    .string()
    .describe(
      'The complete replacement notes document (UTF-8 text); an empty string clears the notes.',
    ),
})

// ── The closed version-one table ─────────────────────────────────────────────

function defineTool(
  name: OperatorToolName,
  description: string,
  inputSchema: z.ZodType,
  outputDescription: string,
  handler: ToolHandler,
): ToolEntry {
  const table = OPERATOR_TOOL_ANNOTATIONS[name]
  return {
    name,
    description,
    inputSchema,
    outputDescription,
    annotations: {
      readOnlyHint: table.readOnlyHint,
      destructiveHint: table.destructiveHint,
      idempotentHint: table.idempotentHint,
    },
    approval: table.approval,
    handler,
  }
}

/** The closed version-one tool table. Adding a tool means adding an entry
 * here and a row in `operator/annotations.ts`; the contract suite proves the
 * two stay in lockstep. Sandbox and publish tools are later tickets. */
export const TOOLS: readonly ToolEntry[] = [
  defineTool(
    'builds.list',
    'List one repository’s builds, newest first, with effective status derived from the build log.',
    buildListInput,
    'JSON array of build summaries: slug, ticket ref, effective status, phase/round/attempt, PR number/url/state, updatedAt, lease health, and durable-event progress.',
    async (raw, ctx) => {
      const input = raw as z.infer<typeof buildListInput>
      return listOperatorBuilds({
        store: ctx.store,
        repo: input.repo,
        scope: input.scope,
        now: ctx.clock(),
      })
    },
  ),
  defineTool(
    'builds.get',
    'Show detailed state for one build: open escalations, verify progress, PR lifecycle, lease health, and the dashboard row.',
    buildDetailInput,
    '{detail, dashboardRow}: the full build detail projection and the dashboard row a terminal dashboard would render (null when the build has no dashboard row).',
    async (raw, ctx) => {
      const input = raw as z.infer<typeof buildDetailInput>
      return getOperatorBuild({
        store: ctx.store,
        repo: input.repo,
        slug: input.slug,
        now: ctx.clock(),
      })
    },
  ),
  defineTool(
    'builds.events',
    'Read one build’s event log after a cursor, optionally waiting (bounded, ≤30s) for new events — the polling companion to builds.get.',
    buildEventsInput,
    '{events, cursor}: the new events in sequence order (each with seq, ts, actor, type, payload) and the cursor to pass next time — the last returned event’s seq, or the requested cursor when the page is empty.',
    async (raw, ctx) => {
      const input = raw as z.infer<typeof buildEventsInput>
      await requireRouteBuild(ctx.store, input.repo, input.slug)
      let events = await ctx.store.getEvents(input.slug, input.cursor)
      if (events.length === 0 && input.waitSeconds > 0) {
        // The store interface offers subscribe but no bounded wait; polling
        // keeps the handler finite. The schema caps waitSeconds at 30.
        const deadline = Date.now() + input.waitSeconds * 1000
        while (events.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 500))
          events = await ctx.store.getEvents(input.slug, input.cursor)
        }
      }
      return { events, cursor: events.length > 0 ? events.at(-1)!.seq : input.cursor }
    },
  ),
  defineTool(
    'builds.artifact',
    'Download one of a build’s deposited artifacts by kind and optional revision.',
    buildArtifactInput,
    'The artifact metadata {kind, revision, blobRef, createdAt} plus contentBase64: the exact artifact bytes base64-encoded. Decode contentBase64 to recover the download; the bytes are identical to the operator API’s artifact download body.',
    async (raw, ctx) => {
      const input = raw as z.infer<typeof buildArtifactInput>
      await requireRouteBuild(ctx.store, input.repo, input.slug)
      const artifact = await ctx.store.getArtifact(input.slug, input.kind, input.rev)
      if (artifact === null) {
        throw new RouteRefusalError({
          kind: 'not-found',
          error: `artifact ${input.kind}${input.rev === undefined ? '' : `@${input.rev}`} not found`,
        })
      }
      return {
        meta: {
          kind: artifact.meta.kind,
          revision: artifact.meta.revision,
          blobRef: artifact.meta.blobRef,
          createdAt: artifact.meta.createdAt,
        },
        contentBase64: Buffer.from(artifact.content).toString('base64'),
      }
    },
  ),
  defineTool(
    'builds.control',
    'Request a durable control for one active build: pause/cancel-pause, resume, auto-merge on/off — or the destructive abort and discard.',
    buildControlInput,
    'Either {kind: "command", slug, command, event} for an accepted control, or {kind: "answer-required", slug, escalationIds} when a resume needs its open escalations answered first.',
    async (raw, ctx) => {
      const input = raw as z.infer<typeof buildControlInput>
      await controlPrechecks(ctx.store, input.repo, input.slug, input.action)
      // The route maps BOTH pause and cancel-pause to `dashboard-pause`:
      // on a running build it requests a pause, and on a build with a pending
      // pause the reducer-supersede rule makes the same command cancel it.
      // Only `resume` maps to `dashboard-resume`.
      const action: BuildControlAction =
        input.action === 'pause' || input.action === 'cancel-pause'
          ? { kind: 'dashboard-pause' }
          : input.action === 'resume'
            ? { kind: 'dashboard-resume' }
            : { kind: input.action }
      return controlBuild({
        store: ctx.store,
        repo: input.repo,
        slug: input.slug,
        user: attributed(ctx),
        action,
      })
    },
  ),
  defineTool(
    'builds.answer',
    'Answer a blocked build’s open escalations: guidance text, a bare retry, a dismissal of the cited findings, a review-round ceiling, or a spec revision (destructive — replaces the spec and restarts from plan).',
    buildsAnswerInput,
    'The controlBuild answer result: {kind: "answered", slug, count, resolution, resumed, …} describing how many escalations were answered and with what.',
    async (raw, ctx) => {
      const input = raw as OperatorAnswerRequest & { repo: string; slug: string }
      await requireRouteBuild(ctx.store, input.repo, input.slug)
      const { action, readTicketBody } = answerAction(input)
      return controlBuild({
        store: ctx.store,
        repo: input.repo,
        slug: input.slug,
        user: attributed(ctx),
        action,
        ...(readTicketBody !== undefined ? { readTicketBody } : {}),
      })
    },
  ),
  defineTool(
    'repository.status',
    'Report one repository’s durable dispatcher settings and journal state.',
    repositoryStatusInput,
    'The repository status projection: ticket intake, repository-wide pause, claim-time auto-merge default, and the harvest/dispatch journal state the sessionless CLI and dashboard read.',
    async (raw, ctx) => {
      const input = raw as z.infer<typeof repositoryStatusInput>
      return getRepositoryStatus(ctx.store, input.repo)
    },
  ),
  defineTool(
    'repository.settings',
    'Set or toggle a durable repository setting: ticket intake or the claim-time auto-merge default.',
    repositorySettingsInput,
    '{enabled, event}: the resulting durable value and the appended repository event.',
    async (raw, ctx) => {
      const input = raw as z.infer<typeof repositorySettingsInput>
      const user = attributed(ctx)
      return input.enabled === undefined
        ? toggleRepositorySetting({
            store: ctx.store,
            repo: input.repo,
            user,
            setting: input.setting,
          })
        : setRepositorySetting({
            store: ctx.store,
            repo: input.repo,
            user,
            setting: input.setting,
            enabled: input.enabled,
          })
    },
  ),
  defineTool(
    'repository.bulk_control',
    'Pause or resume the whole repository: hold queued builds, set intake, and request per-build pause/resume in one walk.',
    bulkControlInput,
    '{direction, slugs, paused, intake}: the direction, the slugs that received a durable request, and the repository-wide hold/intake values written. A partial walk surfaces as a refusal with code "bulk-partial" and a progress object naming what landed.',
    async (raw, ctx) => {
      const input = raw as z.infer<typeof bulkControlInput>
      return bulkControlRepository({
        store: ctx.store,
        repo: input.repo,
        user: attributed(ctx),
        direction: input.action,
      })
    },
  ),
  defineTool(
    'harvest.status',
    'Report one repository’s observation-harvest state: unresolved workflows, pending proposals, and their paper trail.',
    harvestStatusInput,
    'The harvest status projection the sessionless `ab harvest status` renders.',
    async (raw, ctx) => {
      const input = raw as z.infer<typeof harvestStatusInput>
      return getHarvestStatus(ctx.store, input.repo)
    },
  ),
  defineTool(
    'harvest.control',
    'Toggle the repository’s harvest gate, or act on the concrete harvest run the dashboard captured.',
    harvestControlInput,
    'For "toggle-gate": {command: "pause"|"resume", event}. For a run action: {action, event} — the action the dashboard offered for that run.',
    async (raw, ctx) => {
      const input = raw as { repo: string } & (
        | { action: 'toggle-gate' }
        | { action: 'run'; run: string }
      )
      const user = attributed(ctx)
      return input.action === 'toggle-gate'
        ? toggleHarvestGate({ store: ctx.store, repo: input.repo, user })
        : controlHarvestRun({ store: ctx.store, repo: input.repo, user, run: input.run })
    },
  ),
  defineTool(
    'tickets.list',
    'List the repository’s ticket grooming queue from the configured ticket source.',
    ticketsListInput,
    '{states, tickets, diagnostics, criteria, triageState, readyState}: the queue listing, the effective lifecycle names, and the criteria actually applied.',
    async (raw, ctx) => {
      const input = raw as z.infer<typeof ticketsListInput>
      return listOperatorTickets({
        store: ctx.store,
        repo: input.repo,
        backend: ticketsOf(ctx),
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.labels !== undefined ? { labels: input.labels } : {}),
      })
    },
  ),
  defineTool(
    'tickets.get',
    'Show one ticket with its blockers and any related build.',
    ticketDetailInput,
    '{ticket, blockers, build}: the ticket, its dependency states, and the most relevant build for it (null when none).',
    async (raw, ctx) => {
      const input = raw as z.infer<typeof ticketDetailInput>
      return getOperatorTicket({
        store: ctx.store,
        repo: input.repo,
        backend: ticketsOf(ctx),
        id: input.id,
      })
    },
  ),
  defineTool(
    'tickets.create',
    'Create a ticket in the configured source, optionally labelled, pre-blocked, or filed in a nondefault state.',
    ticketsCreateInput,
    '{ticket, blockers, build}: the created ticket and its (usually empty) dependency states.',
    async (raw, ctx) => {
      const input = raw as z.infer<typeof ticketsCreateInput>
      const { repo, title, body, labels, state, blockedBy } = input
      return mutateOperatorTicket({
        store: ctx.store,
        repo,
        backend: ticketsOf(ctx),
        operation: {
          kind: 'create',
          title,
          body,
          ...(labels !== undefined ? { labels } : {}),
          ...(state !== undefined ? { state } : {}),
          ...(blockedBy !== undefined ? { blockedBy } : {}),
        },
      })
    },
  ),
  defineTool(
    'tickets.update',
    'Partially replace a ticket’s editable fields (title, body, labels); state is never changed here.',
    ticketsUpdateInput,
    '{ticket, blockers, build}: the updated ticket.',
    async (raw, ctx) => {
      const input = raw as z.infer<typeof ticketsUpdateInput>
      const { repo, id, ...patch } = input
      return mutateOperatorTicket({
        store: ctx.store,
        repo,
        backend: ticketsOf(ctx),
        operation: { kind: 'update', id, patch },
      })
    },
  ),
  defineTool(
    'tickets.block',
    'Add dependency edges: make one ticket blocked by one or more blockers.',
    ticketsBlockersInput,
    '{ticket, blockers, build}: the ticket after the edges were added.',
    async (raw, ctx) => {
      const input = raw as z.infer<typeof ticketsBlockersInput>
      return mutateOperatorTicket({
        store: ctx.store,
        repo: input.repo,
        backend: ticketsOf(ctx),
        operation: { kind: 'block', id: input.id, blockerIds: input.blockerIds },
      })
    },
  ),
  defineTool(
    'tickets.unblock',
    'Remove dependency edges from one ticket.',
    ticketsBlockersInput,
    '{ticket, blockers, build}: the ticket after the edges were removed.',
    async (raw, ctx) => {
      const input = raw as z.infer<typeof ticketsBlockersInput>
      return mutateOperatorTicket({
        store: ctx.store,
        repo: input.repo,
        backend: ticketsOf(ctx),
        operation: { kind: 'unblock', id: input.id, blockerIds: input.blockerIds },
      })
    },
  ),
  defineTool(
    'tickets.move',
    'Move one ticket to a provider state. Destructive when the target is the repository’s configured ready state: the ticket becomes dispatchable.',
    ticketsMoveInput,
    '{ticket, blockers, build}: the ticket in its new state.',
    async (raw, ctx) => {
      const input = raw as z.infer<typeof ticketsMoveInput>
      return mutateOperatorTicket({
        store: ctx.store,
        repo: input.repo,
        backend: ticketsOf(ctx),
        operation: { kind: 'move', id: input.id, state: input.state },
      })
    },
  ),
  defineTool(
    'notes.read',
    'Read the repository’s operator-notes artifact — the shared notes an operator agent leaves for the next round.',
    notesReadInput,
    '{document, revision, metadata}: the latest revision’s UTF-8 text, its artifact revision, and its deposit metadata (writer identity). An empty document with null revision/metadata when no notes exist yet.',
    async (raw, ctx) => {
      const input = raw as z.infer<typeof notesReadInput>
      if ((await ctx.store.getRepo(input.repo)) === null) {
        return { document: '', revision: null, metadata: null }
      }
      const artifact = await ctx.store.getRepoArtifact(input.repo, OPERATOR_NOTES_ARTIFACT)
      if (artifact === null) {
        return { document: '', revision: null, metadata: null }
      }
      return {
        document: new TextDecoder().decode(artifact.content),
        revision: artifact.meta.revision,
        metadata: artifact.meta.metadata,
      }
    },
  ),
  defineTool(
    'notes.write',
    'Deposit a new revision of the repository’s operator-notes artifact, attributed to the caller.',
    notesWriteInput,
    '{revision, blobRef, createdAt}: the newly deposited revision. The kind is retention-managed: only the newest 200 revisions (the store’s configured maxRevisions) survive.',
    async (raw, ctx) => {
      const input = raw as z.infer<typeof notesWriteInput>
      const user = attributed(ctx)
      await ctx.store.ensureRepo(input.repo)
      const meta = await ctx.store.putRepoArtifact(input.repo, {
        kind: OPERATOR_NOTES_ARTIFACT,
        content: input.document,
        metadata: { user, ...(ctx.via !== undefined ? { via: ctx.via } : {}) },
      })
      return { revision: meta.revision, blobRef: meta.blobRef, createdAt: meta.createdAt }
    },
  ),
]

// ── The registry constructor ─────────────────────────────────────────────────

export interface RegistryOptions {
  store: BuildStore
  tickets?: OperatorTicketBackend
  clock?: Clock
  /** Constrain every call to this repository identity (the `ab mcp --repo` flag). */
  allowedRepo?: string
}

export interface OperatorToolRegistry {
  /** The closed table, in definition order. */
  readonly entries: readonly ToolEntry[]
  /** Validate, enforce registry rules, then run the tool's handler. Throws
   * `RegistryError` (never a raw service error) on every refusal path. */
  call(name: string, input: unknown, ctx?: Partial<ToolContext>): Promise<unknown>
}

/** Map a service error to the registry's operator-API-shaped failure body —
 * the same kind mapping as the catch block in operator/server.ts. */
function mapDomainError(error: unknown): RegistryError {
  if (error instanceof RegistryError) return error
  if (error instanceof RouteRefusalError) {
    return new RegistryError('domain', error.message, {
      kind: error.refusal.kind,
      error: error.refusal.error,
    })
  }
  if (error instanceof TicketOperationError) {
    return new RegistryError('domain', error.message, {
      kind: error.code === 'not-found' ? 'not-found' : 'refusal',
      error: error.message,
      code: error.code,
    })
  }
  if (error instanceof BuildControlError || error instanceof OperatorControlError) {
    return new RegistryError('domain', error.message, {
      kind: 'refusal',
      error: error.message,
      code: error.code,
    })
  }
  if (error instanceof BulkWalkError) {
    return new RegistryError('domain', error.message, {
      kind: 'refusal',
      error: error.message,
      code: 'bulk-partial',
      progress: error.progress,
    })
  }
  if (error instanceof OperatorQueryError) {
    return new RegistryError('domain', error.message, {
      kind: error.code === 'not-found' ? 'not-found' : 'conflict',
      error: error.message,
      code: error.code,
    })
  }
  return new RegistryError(
    'domain',
    'operator tool is unavailable',
    {
      kind: 'internal',
      error: 'operator tool is unavailable',
    },
    { cause: error },
  )
}

/** Bind the closed table to an opened store (and optional ticket backend).
 * The returned registry is the in-process binding; every other binding is
 * generated from `entries`. */
export function buildRegistry(options: RegistryOptions): OperatorToolRegistry {
  return {
    entries: TOOLS,
    async call(name, input, partial = {}) {
      const entry = TOOLS.find((tool) => tool.name === name)
      if (entry === undefined) {
        throw new RegistryError('unknown-tool', `unknown tool "${name}"`, {
          kind: 'not-found',
          error: `unknown tool "${name}"`,
        })
      }
      const parsed = entry.inputSchema.safeParse(input)
      if (!parsed.success) {
        throw new RegistryError(
          'validation',
          `invalid input for tool "${name}": ${parsed.error.message}`,
          {
            kind: 'validation',
            error: `invalid input for tool "${name}": ${parsed.error.message}`,
          },
        )
      }
      const value = parsed.data as { repo?: unknown }
      const allowedRepo = options.allowedRepo
      if (allowedRepo !== undefined && value.repo !== allowedRepo) {
        const error = `tool "${name}" targets repository "${String(value.repo)}" but this binding serves "${allowedRepo}"`
        throw new RegistryError('repo-mismatch', error, { kind: 'validation', error })
      }
      const identity = partial.identity
      if (entry.approval === 'default' && (identity === undefined || identity.trim() === '')) {
        throw new RegistryError(
          'no-identity',
          `tool "${name}" mutates durable state and requires an attributed operator identity`,
          {
            kind: 'auth',
            error: `tool "${name}" mutates durable state and requires an attributed operator identity`,
          },
        )
      }
      const tickets = partial.tickets ?? options.tickets
      const ctx: ToolContext = {
        store: partial.store ?? options.store,
        ...(tickets !== undefined ? { tickets } : {}),
        clock: partial.clock ?? options.clock ?? systemClock,
        ...(identity !== undefined ? { identity } : {}),
        ...(partial.via !== undefined ? { via: partial.via } : {}),
      }
      try {
        return await entry.handler(parsed.data as never, ctx)
      } catch (error) {
        throw mapDomainError(error)
      }
    },
  }
}
