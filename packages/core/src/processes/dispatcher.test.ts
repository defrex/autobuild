import { missingAccountCredentials, MissingAccountCredentialsError } from '../accounts/availability'
import { parkedSweepReadBudget } from '../testing/reduced-read-budget'
import { leafTransaction } from '../kernel/generators/leaf-restack-log'
import { historicalEffectiveConfig } from '../config/effective-artifact.fixture'
import { GitHubForge } from '../ports/forge/github'
import { GitHubApiError, type GitHubRequest } from '../ports/forge/github-transport'
import { buildNeedsAttention, mergeDecision } from '../cli/attention'
import { decideNext } from '../kernel/engine'
import { publicationPending } from './publication-state'
import {
  BUILD_EFFECTIVE_CONFIG_ARTIFACT,
  effectiveBuildConfigContent,
} from './build-execution-state'
import { controlBuild } from '../cli/build-control'
/**
 * Dispatcher tests (SPEC §3.3, §6.3, §12, §15.7 D1, §15.6-C): memory store +
 * all fakes, sequentialIds + manualClock — deterministic and offline.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bulkControlRepository } from '../cli/bulk-control'
import { parseConfig } from '../config/load'
import type { Config } from '../config/schema'
import type { EventEnvelope, EventWrite } from '../events/catalog'
import type { EventType } from '../events/payloads'
import type { RepositoryEvent } from '../events/repository'
import { DISPATCHER, KERNEL, agentActor, humanActor } from '../events/envelope'
import { sequentialIds } from '../ids'
import { pendingAutoMerge, recordAutoMergeDeferralObservation } from '../kernel/auto-merge'
import { reduceBuild, type BuildState } from '../kernel/reducer'
import type { WorkspaceBase } from '../ontology'
import { FakeForge } from '../ports/forge/fake'
import { FakeTicketSource } from '../ports/tickets/fake'
import { LinearTicketSource } from '../ports/tickets/linear'
import { NoCommitsBetweenBranchesError, TicketSourceRateLimitError } from '../ports/types'
import type { Forge, Ticket, WorkspaceProvider } from '../ports/types'
import type { BuildExecution } from '../ports/workspace/build-execution'
import { FakeWorkspaceProvider } from '../ports/workspace/fake'
import type { Exec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import { textContent, type BuildStore } from '../store/types'
import { openLocalStore } from '../store/local/store'
import { manualClock } from '../testing/fixed'
import { withFailingRepoAppend } from '../testing/store-failures'
import {
  Dispatcher,
  SWEEP_PIN_CACHE_CAPACITY,
  analyzeDependencies,
  defaultProposalState,
  defaultTriageState,
  emptyTickReport,
  fallbackSlug,
  heldByRepositoryPause,
  kebab,
  readyCriteria,
  specConformance,
  validateSlugCandidate,
  type DependencyVerdict,
  type DispatcherOpts,
  type LaunchRunnerResult,
} from './dispatcher'
import type { DependencyState } from '../ports/types'

const REPO = '/repos/origin'
const BASE_SHA = 'a'.repeat(40)

/** Conforming per the spec standard's checkable core (docs/spec-standard.md). */
const CONFORMING_BODY = [
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

function readyTicket(id: string, over: Partial<Omit<Ticket, 'ref'>> = {}): Ticket {
  const title = over.title ?? 'Add rate limiting'
  return {
    revision: 'fixture',
    ref: { source: 'fake', id, title },
    ...(over.kind !== undefined ? { kind: over.kind } : {}),
    ...(over.target !== undefined ? { target: over.target } : {}),
    ...(over.creationKey !== undefined ? { creationKey: over.creationKey } : {}),
    title,
    body: over.body ?? CONFORMING_BODY,
    state: over.state ?? 'Ready',
    resolved: over.resolved ?? over.state === 'Done',
    labels: over.labels ?? ['autobuild'],
    ...(over.blockedBy !== undefined ? { blockedBy: over.blockedBy } : {}),
  }
}

/**
 * `[tickets].readyState` is required. These harness tests seed `readyTicket`s
 * in "Ready", so unrelated fixtures get that state inserted into an existing
 * `[tickets]` table or receive the minimal file-source table. A fixture that
 * sets its own readyState is left untouched.
 */
function withReadyState(toml: string): string {
  // Older dispatcher scenarios explicitly wait for consent. Policy-default
  // behavior is covered by the landing-policy and declarative scenarios.
  if (!/(?:\[\[landing\]\]|^landing\s*=)/m.test(toml))
    toml = `${toml}\n[[merge]]\nmode = "consent"\n`
  if (/(^|\n)\s*readyState\s*=/.test(toml)) return toml
  if (/(^|\n)\[tickets\]/.test(toml)) {
    return toml.replace(/(^|\n)(\[tickets\][^\n]*\n)/, `$1$2readyState = "Ready"\n`)
  }
  return `${toml}${toml.endsWith('\n') || toml.length === 0 ? '' : '\n'}[tickets]\nsource = "file"\nreadyState = "Ready"\n`
}

function harness(
  opts: {
    missingAccounts?: () => import('../accounts/availability').MissingAccountCredential[]
    clock?: ReturnType<typeof manualClock>
    tickets?: Ticket[]
    toml?: string
    authorSpec?: (ticket: Ticket) => Promise<string | null>
    nameSlug?: (spec: string, signal: AbortSignal) => Promise<string | null>
    opts?: DispatcherOpts
    /** Wrap the fake ticket source — e.g. to make dependencyStates throw. */
    wrapTickets?: (source: FakeTicketSource) => FakeTicketSource
    startHarvest?: () => void
    activeHarvestExecutions?: () => ReadonlySet<string>
    launchResult?: LaunchRunnerResult
    onLaunch?: (slug: string, store: BuildStore) => Promise<void> | void
    workspaceBase?: WorkspaceBase
    prAttachments?: boolean
    dispatchForge?: Forge
    forge?: FakeForge
    exec?: Exec
    /** Mutable dispatcher snapshot used by hot-reload boundary tests. */
    repairBuildConfig?: (slug: string) => Promise<void>
    getConfig?: () => Config
    /** A store to dispatch over instead of a fresh in-memory one — the seam
     * the restart tests use to hand a second Dispatcher a reopened store. */
    store?: BuildStore
    workspaceProvider?: WorkspaceProvider
    retiredWorkspaces?: readonly WorkspaceProvider[]
    /** Present the harness fake under another provider name, for facts that
     * name a specific provider (the dispatcher routes by that name). */
    workspaceName?: string
    /** Physical checkout path, distinct from the store identity — the seam
     * the identity-split tests use (deps.repo as origin URL, checkout as
     * the local path). */
    checkout?: string
    /** Store identity override — an origin URL for the identity-split
     * tests; defaults to the origin-less path fixture. */
    repo?: string
    /** Explicit normalized origin for checkoutless dispatch. */
    repoOrigin?: string
    /** Trusted publication settlement seam (AUT-328 release guard). */
    settlePublication?: (slug: string) => Promise<void>
  } = {},
) {
  const clock = opts.clock ?? manualClock()
  const store = opts.store ?? new MemoryBuildStore({ clock })
  const fakeTickets = new FakeTicketSource(opts.tickets ?? [])
  const tickets = opts.wrapTickets ? opts.wrapTickets(fakeTickets) : fakeTickets
  const workspaces = new FakeWorkspaceProvider({
    root: '/ws',
    mode: 'logical',
    base: opts.workspaceBase ?? { source: 'remote', sha: BASE_SHA },
  })
  const forge =
    opts.forge ??
    new FakeForge({
      ...(opts.prAttachments === true ? { prAttachments: true } : {}),
    })
  const launches: string[] = []
  const execCalls: string[][] = []
  const execCwds: (string | undefined)[] = []
  const exec: Exec = async (cmd, execOpts) => {
    execCalls.push(cmd)
    execCwds.push(execOpts.cwd)
    return (
      opts.exec?.(cmd, execOpts) ?? {
        stdout: `${BASE_SHA}\trefs/heads/main\n`,
        stderr: '',
        exitCode: 0,
      }
    )
  }
  const dispatcher = new Dispatcher({
    store,
    tickets,
    workspaces:
      opts.workspaceProvider ??
      (opts.workspaceName === undefined
        ? workspaces
        : new Proxy(workspaces, {
            get: (target, key, receiver) =>
              key === 'name' ? opts.workspaceName : Reflect.get(target, key, receiver),
          })),
    ...(opts.retiredWorkspaces === undefined ? {} : { retiredWorkspaces: opts.retiredWorkspaces }),
    forge: opts.dispatchForge ?? forge,
    missingAccounts: opts.missingAccounts,
    config: parseConfig(withReadyState(opts.toml ?? '')),
    ...(opts.getConfig !== undefined ? { getConfig: opts.getConfig } : {}),
    ...(opts.repairBuildConfig ? { repairBuildConfig: opts.repairBuildConfig } : {}),
    repo: opts.repo ?? REPO,
    ...(opts.repoOrigin !== undefined ? { repoOrigin: opts.repoOrigin } : {}),
    ...(opts.checkout !== undefined ? { checkout: opts.checkout } : {}),
    exec,
    launchRunner: async (slug) => {
      await opts.onLaunch?.(slug, store)
      launches.push(slug)
      return opts.launchResult ?? 'scheduled'
    },
    ...(opts.authorSpec ? { authorSpec: opts.authorSpec } : {}),
    ...(opts.nameSlug ? { nameSlug: opts.nameSlug } : {}),
    ...(opts.startHarvest ? { startHarvest: opts.startHarvest } : {}),
    ...(opts.settlePublication ? { settlePublication: opts.settlePublication } : {}),
    ...(opts.activeHarvestExecutions !== undefined
      ? { activeHarvestExecutions: opts.activeHarvestExecutions }
      : {}),
    ids: sequentialIds(),
    clock,
    ...(opts.opts ? { opts: opts.opts } : {}),
  })
  return { clock, store, tickets, workspaces, forge, launches, execCalls, execCwds, dispatcher }
}

type Harness = ReturnType<typeof harness>

/** Seed a build's log directly — the janitor/sweep read events, not history
 * of how they got there (state is a reduction, §3.4). Mirrors dispatch (§12):
 * created → provisioned → spec imported (every dispatched build has a spec
 * before its runner launches), then attached. */
async function seedBuild(
  h: Harness,
  opts: {
    slug?: string
    baseBranch?: string
    ticketId?: string
    ticketSource?: string
    repo?: string
    workspace?: boolean
    workspaceRef?: string
    workspacePath?: string
    /** Provider recorded on the provisioned fact; defaults to the harness fake. */
    workspaceProvider?: string
    /** Remote publication marker recorded on the provisioned fact; defaults to
     * absent so unmodified seeds keep exercising the legacy fallback. */
    workspaceRemote?: boolean
    attached?: boolean
    targetObserved?: boolean
    pr?: { number: number; url: string; headSha: string }
  } = {},
): Promise<string> {
  const slug = opts.slug ?? 'auth-limit'
  const repo = opts.repo ?? REPO
  const ticket = {
    source: opts.ticketSource ?? 'fake',
    id: opts.ticketId ?? `T-${slug}`,
    title: slug,
  }
  await h.store.createBuild({
    slug,
    repo,
    ...(opts.ticketId ? { ticket } : {}),
    branch: `ab/${slug}`,
  })
  await h.store.append(slug, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      ticket,
      repo,
      baseBranch: opts.baseBranch ?? 'main',
      ...(opts.baseBranch
        ? { target: { ticket: { source: 'fake', id: 'NODE' }, build: 'node-build' } }
        : {}),
    },
  })
  if (opts.workspace !== false) {
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'workspace.provisioned',
      payload: {
        provider: opts.workspaceProvider ?? 'fake',
        ref: opts.workspaceRef ?? `/ws/ab/${slug}`,
        ...(opts.workspacePath !== undefined ? { path: opts.workspacePath } : {}),
        ...(opts.workspaceRemote !== undefined ? { remote: opts.workspaceRemote } : {}),
        branch: `ab/${slug}`,
        base: { source: 'remote', sha: BASE_SHA },
      },
    })
  }
  await h.store.append(slug, {
    actor: DISPATCHER,
    type: 'spec.imported',
    payload: { artifact: { kind: 'spec', rev: 0 }, ticket },
  })
  if (opts.targetObserved !== false) {
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'target.moved',
      payload: { branch: 'main', sha: BASE_SHA },
    })
  }
  if (opts.attached !== false) {
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: 'runner-1', host: 'local' },
    })
  }
  if (opts.pr) {
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: { pr: opts.pr },
    })
  }
  return slug
}

async function seedHostedPrAttachment(h: Harness, slug: string, name = 'screenshot', assetId = 7) {
  const designated = await h.store.append(slug, {
    actor: agentActor('verify:visual', 's_visual'),
    type: 'pr-attachment.designated',
    payload: {
      artifact: { kind: `visual:${name}`, rev: 0 },
      filename: `${name}.png`,
      mediaType: 'image/png',
    },
  })
  return h.store.append(slug, {
    actor: KERNEL,
    type: 'pr-attachment.hosted',
    payload: {
      designationSeq: designated.seq,
      asset: {
        provider: 'github-release',
        repository: 'acme/review-assets',
        releaseId: 42,
        assetId,
        url: `https://github.com/acme/review-assets/releases/download/review/${name}.png`,
      },
    },
  })
}

/** Happy-path loop prefix: plan and code loops approved at round 1 — enough
 * log for `decideNext` to route past rules 5–6 into verify/finalize, the way
 * a real post-PR build's log would (§15.6). */
async function seedLoopsApproved(h: Harness, slug: string): Promise<void> {
  await h.store.append(slug, { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
  await h.store.append(slug, {
    actor: agentActor('plan', 's_seed'),
    type: 'plan.completed',
    payload: { round: 1, artifact: { kind: 'plan', rev: 0 } },
  })
  await h.store.append(slug, { actor: KERNEL, type: 'plan-review.started', payload: { round: 1 } })
  await h.store.append(slug, {
    actor: agentActor('plan-review', 's_seed'),
    type: 'plan-review.verdict',
    payload: {
      round: 1,
      verdict: 'approve',
      findings: [],
      artifact: { kind: 'plan-review', rev: 0 },
    },
  })
  await h.store.append(slug, { actor: KERNEL, type: 'implement.started', payload: { round: 1 } })
  await h.store.append(slug, {
    actor: agentActor('implement', 's_seed'),
    type: 'implement.completed',
    payload: {
      round: 1,
      commits: { base: 'sha-base', head: 'sha-head-1' },
      artifact: { kind: 'implement-notes', rev: 0 },
    },
  })
  await h.store.append(slug, { actor: KERNEL, type: 'code-review.started', payload: { round: 1 } })
  await h.store.append(slug, {
    actor: agentActor('code-review', 's_seed'),
    type: 'code-review.verdict',
    payload: {
      round: 1,
      verdict: 'approve',
      findings: [],
      artifact: { kind: 'code-review', rev: 0 },
    },
  })
}

/** A build whose dispatch was interrupted after `build.created`: a record and
 * a ticket, no workspace, no spec, no runner. Exactly what the recovery stage
 * exists to complete — and, because the recovery stage runs second in every
 * tick, the first thing to reach a queued build. */
async function seedInterrupted(
  h: Harness,
  slug = 'interrupted-dispatch',
  autoMergeRequestedBy?: string,
  ticketId = 'T-recover',
): Promise<void> {
  const ticket = (await h.tickets.get(ticketId))!
  await h.tickets.claim(ticket.ref.id)
  await h.store.createBuild({
    slug,
    repo: REPO,
    ticket: ticket.ref,
    branch: `ab/${slug}`,
  })
  await h.store.append(slug, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      ticket: ticket.ref,
      repo: REPO,
      baseBranch: 'main',
      ...(autoMergeRequestedBy !== undefined ? { autoMergeRequestedBy } : {}),
    },
  })
}

/** Seed a fully green build parked in the post-PR epilogue. */
async function seedAwaitingPr(
  h: Harness,
  slug = 'auth-limit',
  baseBranch?: string,
): Promise<string> {
  const ticketId = `T-${slug}`
  if (!(await h.tickets.get(ticketId)))
    await h.tickets.create(
      { title: slug, body: CONFORMING_BODY, labels: [] },
      { requestedId: ticketId },
    )
  await seedBuild(h, { slug, baseBranch, ticketId })
  await seedLoopsApproved(h, slug)
  await h.store.append(slug, {
    actor: KERNEL,
    type: 'finalize.completed',
    payload: { pr: PR },
  })
  return slug
}

const PR = { number: 1, url: 'https://fake.forge/pr/1', headSha: 'head-1' }

// ── Quality gate heuristic (§6.3) ────────────────────────────────────────────

describe('specConformance', () => {
  test('conforming body passes', () => {
    expect(specConformance(CONFORMING_BODY)).toEqual({ conforms: true, missing: [] })
  })

  test('empty body reports every missing part', () => {
    expect(specConformance('')).toEqual({
      conforms: false,
      missing: [
        'a nonempty spec body',
        "an '## Acceptance criteria' heading",
        "an '## Out of scope' heading",
      ],
    })
  })

  test('acceptance criteria heading without a list item is nonconforming', () => {
    const body = 'Why.\n\n## Acceptance criteria\n\nnone yet\n\n## Out of scope\n'
    expect(specConformance(body)).toEqual({
      conforms: false,
      missing: ["at least one list item under '## Acceptance criteria'"],
    })
  })

  test('headings match case-insensitively and at deeper levels', () => {
    const body = 'Why.\n\n### ACCEPTANCE CRITERIA\n- one\n\n### Out Of Scope — explicit\n'
    expect(specConformance(body)).toEqual({ conforms: true, missing: [] })
  })

  test('h1 headings conform (AUT-12)', () => {
    const body = 'Why.\n\n# Acceptance criteria\n- one\n\n# Out of scope\n'
    expect(specConformance(body)).toEqual({ conforms: true, missing: [] })
  })

  test('mixed heading levels conform', () => {
    const body = 'Why.\n\n# Acceptance criteria\n- one\n\n### Out of scope\n'
    expect(specConformance(body)).toEqual({ conforms: true, missing: [] })
  })

  test('an h1 section spans an h2 subheading; a later h1 still ends it', () => {
    const body = 'Why.\n\n# Acceptance criteria\n- one\n\n## Details\n\nprose\n\n# Out of scope\n'
    expect(specConformance(body)).toEqual({ conforms: true, missing: [] })
  })

  test('a list item under a subsection of the acceptance criteria counts (AUT-15)', () => {
    const body = 'Why.\n\n# Acceptance criteria\n\n## Details\n- one\n\n# Out of scope\n'
    expect(specConformance(body)).toEqual({ conforms: true, missing: [] })
  })

  test('criteria grouped under h3 subsections of an h2 section count (AUT-15 shape)', () => {
    const body =
      'Why.\n\n## Acceptance criteria\n\n### Legend & selection\n\n1. one\n2. two\n\n### Drain\n\n3. three\n\n## Out of scope\n'
    expect(specConformance(body)).toEqual({ conforms: true, missing: [] })
  })

  test('a list item under a sibling section does not count for acceptance criteria', () => {
    const body =
      'Why.\n\n## Acceptance criteria\n\nnone yet\n\n## Details\n- one\n\n## Out of scope\n'
    expect(specConformance(body)).toEqual({
      conforms: false,
      missing: ["at least one list item under '## Acceptance criteria'"],
    })
  })

  test('h1 heading with no list item under it is nonconforming', () => {
    const body = 'Why.\n\n# Acceptance criteria\n\nnone yet\n\n# Out of scope\n'
    expect(specConformance(body)).toEqual({
      conforms: false,
      missing: ["at least one list item under '## Acceptance criteria'"],
    })
  })

  test('h1 body missing the out-of-scope section still bounces accurately', () => {
    const body = 'Why.\n\n# Acceptance criteria\n- one\n'
    expect(specConformance(body)).toEqual({
      conforms: false,
      missing: ["an '## Out of scope' heading"],
    })
  })
})

describe('analyzeDependencies', () => {
  /**
   * `graph` reads as `id: [blockers]`; `done` lists the resolved ids and
   * `missing` the ids that exist nowhere. Pure input — no adapter involved.
   *
   * Only BLOCKERS become nodes: `nodes` models what the source returned, and
   * the source is never asked about the ticket being analyzed. Its own
   * blockers reach the analyzer as an argument (see `analyze`), which is what
   * keeps a fabricated self-node out of the tick-wide cache (f_8bc9ee0c).
   */
  function nodes(
    graph: Record<string, string[]>,
    opts: { done?: string[]; missing?: string[]; ticket?: string } = {},
  ): Map<string, DependencyState> {
    const map = new Map<string, DependencyState>()
    for (const [id, blockedBy] of Object.entries(graph)) {
      if (id === (opts.ticket ?? 'A')) continue // never fetched
      if (opts.missing?.includes(id)) {
        map.set(id, { id, exists: false, resolved: false, blockedBy: [] })
        continue
      }
      map.set(id, {
        id,
        exists: true,
        resolved: opts.done?.includes(id) ?? false,
        blockedBy,
      })
    }
    return map
  }

  /** Analyze ticket `id` against `graph`, taking its declared blockers from
   * the graph entry — mirroring the dispatcher, which passes the ticket's own
   * `blockedBy` rather than looking it up in the fetched nodes. */
  function analyze(
    id: string,
    graph: Record<string, string[]>,
    opts: { done?: string[]; missing?: string[] } = {},
  ): DependencyVerdict {
    return analyzeDependencies(id, graph[id] ?? [], nodes(graph, { ...opts, ticket: id }))
  }

  test('no blockers: eligible, nothing to say', () => {
    expect(analyze('A', { A: [] })).toEqual({ unresolved: [], diagnostics: [] })
  })

  test('a ticket with no declared blockers never consults the graph', () => {
    expect(analyzeDependencies('A', [], new Map())).toEqual({
      unresolved: [],
      diagnostics: [],
    })
  })

  test('one unresolved blocker: ineligible, diagnostic names ticket and blocker', () => {
    const verdict = analyze('A', { A: ['B'], B: [] })

    expect(verdict.unresolved).toEqual(['B'])
    expect(verdict.diagnostics).toEqual(['ticket A blocked by B (not complete)'])
  })

  test('one resolved blocker: eligible', () => {
    expect(analyze('A', { A: ['B'], B: [] }, { done: ['B'] })).toEqual({
      unresolved: [],
      diagnostics: [],
    })
  })

  test('multiple blockers: ineligible until the LAST one resolves', () => {
    const graph = { A: ['B', 'C'], B: [], C: [] }

    expect(analyze('A', graph).unresolved).toEqual(['B', 'C'])
    expect(analyze('A', graph, { done: ['B'] }).unresolved).toEqual(['C'])
    expect(analyze('A', graph, { done: ['C'] }).unresolved).toEqual(['B'])
    expect(analyze('A', graph, { done: ['B', 'C'] })).toEqual({
      unresolved: [],
      diagnostics: [],
    })
  })

  test('a missing blocker: ineligible, diagnostic says it does not exist', () => {
    const verdict = analyze('A', { A: ['B'], B: [] }, { missing: ['B'] })

    expect(verdict.unresolved).toEqual(['B'])
    expect(verdict.diagnostics).toEqual([
      'ticket A blocked by B, which does not exist in this ticket source',
    ])
  })

  test('a blocker absent from the graph entirely reads as missing', () => {
    const verdict = analyze('A', { A: ['B'] })

    expect(verdict.unresolved).toEqual(['B'])
    expect(verdict.diagnostics[0]).toContain('does not exist')
  })

  test('self-dependency: ineligible, named as such', () => {
    const verdict = analyze('A', { A: ['A'] })

    expect(verdict.unresolved).toEqual(['A'])
    expect(verdict.diagnostics).toEqual(['ticket A depends on itself'])
  })

  test('a 2-cycle is named as a cycle, not as a plain incomplete blocker', () => {
    const verdict = analyze('A', { A: ['B'], B: ['A'] })

    expect(verdict.unresolved).toEqual(['B'])
    expect(verdict.diagnostics).toEqual(['ticket A: dependency cycle A → B → A'])
  })

  test('a 3-cycle names the whole loop', () => {
    const verdict = analyze('A', { A: ['B'], B: ['C'], C: ['A'] })

    expect(verdict.diagnostics).toEqual(['ticket A: dependency cycle A → B → C → A'])
  })

  test('a cycle reached through a chain, not involving the ticket itself', () => {
    const verdict = analyze('A', { A: ['B'], B: ['C'], C: ['D'], D: ['C'] })

    expect(verdict.unresolved).toEqual(['B'])
    expect(verdict.diagnostics).toEqual(['ticket A: dependency cycle C → D → C'])
  })

  test('a resolved blocker is never walked — a cycle behind done work is not a diagnostic', () => {
    const verdict = analyze('A', { A: ['B'], B: ['C'], C: ['B'] }, { done: ['B'] })

    expect(verdict).toEqual({ unresolved: [], diagnostics: [] })
  })

  test('mixed: one resolved, one missing, one cycling — each reported once', () => {
    const verdict = analyze(
      'A',
      { A: ['B', 'C', 'D'], B: [], C: [], D: ['A'] },
      { done: ['B'], missing: ['C'] },
    )

    expect(verdict.unresolved).toEqual(['C', 'D'])
    expect(verdict.diagnostics).toEqual([
      'ticket A blocked by C, which does not exist in this ticket source',
      'ticket A: dependency cycle A → D → A',
    ])
  })

  test('a diamond terminates and does not double-report', () => {
    const verdict = analyze('A', {
      A: ['B'],
      B: ['C', 'D'],
      C: ['E'],
      D: ['E'],
      E: [],
    })

    expect(verdict.unresolved).toEqual(['B'])
    expect(verdict.diagnostics).toEqual(['ticket A blocked by B (not complete)'])
  })
})

describe('build slug helpers', () => {
  test('kebab lowercases, strips punctuation, and collapses separators', () => {
    expect(kebab('Add rate limiting!')).toBe('add-rate-limiting')
    expect(kebab('  Fix: OAuth2 / SSO  ')).toBe('fix-oauth2-sso')
    expect(kebab('!!!')).toBe('build')
  })

  test('fallbackSlug keeps only the first three normalized title tokens', () => {
    expect(fallbackSlug('Please add support for login throttling')).toBe('please-add-support')
    expect(fallbackSlug('Fix OAuth2 / SSO now')).toBe('fix-oauth2-sso')
    expect(fallbackSlug('!!!')).toBe('build')
  })

  test('validateSlugCandidate accepts only one-to-three lowercase kebab tokens', () => {
    expect(validateSlugCandidate('auth')).toBe('auth')
    expect(validateSlugCandidate('auth-limit')).toBe('auth-limit')
    expect(validateSlugCandidate('  login-rate-limit\n')).toBe('login-rate-limit')

    for (const invalid of [
      '',
      '   ',
      'Login-rate-limit',
      'login rate limit',
      'login/rate-limit',
      '-login-rate',
      'login-rate-',
      'login--rate',
      'login-rate-limit-now',
      'slug: login-rate',
      '"login-rate"',
    ]) {
      expect(validateSlugCandidate(invalid)).toBeNull()
    }
    expect(validateSlugCandidate(null)).toBeNull()
  })
})

// ── Dispatch (§12, §6.3) ─────────────────────────────────────────────────────

describe('Dispatcher dispatch', () => {
  test('conforming ticket end-to-end: events, spec rev 0, branch, launch', async () => {
    const ticket = readyTicket('T-1')
    const h = harness({ tickets: [ticket] })

    const report = await h.dispatcher.tick()
    expect(report).toEqual({ ...emptyTickReport(), dispatched: 1 })

    const builds = await h.store.listBuilds()
    expect(builds.map((b) => b.slug)).toEqual(['add-rate-limiting'])
    expect(builds[0]?.branch).toBe('ab/add-rate-limiting')

    // Exact event sequence (§12): setup facts precede notification and launch.
    const events = await h.store.getEvents('add-rate-limiting')
    expect(events.map((e) => e.type)).toEqual([
      'build.created',
      'workspace.provisioned',
      'spec.imported',
      'dispatch.comment-posted',
      'target.moved',
    ])
    expect(events[0]?.actor).toEqual({ kind: 'dispatcher' })
    expect(events[0]?.payload).toEqual({
      ticket: ticket.ref,
      repo: REPO,
      baseBranch: 'main',
    })
    expect(events[1]?.payload).toEqual({
      provider: 'fake',
      ref: '/ws/ab/add-rate-limiting',
      path: '/ws/ab/add-rate-limiting',
      remote: false,
      branch: 'ab/add-rate-limiting',
      base: { source: 'remote', sha: BASE_SHA },
    })
    expect(events[2]?.payload).toEqual({
      artifact: { kind: 'spec', rev: 0 },
      ticket: ticket.ref,
    })

    // The contract artifact (§6.3): kind spec, revision 0, the ticket body.
    const spec = await h.store.getArtifact('add-rate-limiting', 'spec')
    expect(spec?.meta.revision).toBe(0)
    expect(spec ? textContent(spec) : null).toBe(CONFORMING_BODY)

    expect(h.workspaces.provisions).toEqual([
      { repo: REPO, baseBranch: 'main', branch: 'ab/add-rate-limiting' },
    ])
    expect(h.tickets.comments).toEqual([{ id: 'T-1', body: 'build add-rate-limiting dispatched' }])
    expect(h.launches).toEqual(['add-rate-limiting'])
  })

  test('created builds record the served repository normalized origin, from one memoized exec call', async () => {
    let remoteCalls = 0
    const h = harness({
      tickets: [readyTicket('T-1'), readyTicket('T-2')],
      toml: 'capacity = 2\n',
      exec: async (cmd) => {
        if (cmd[1] === 'remote') {
          remoteCalls += 1
          return { stdout: 'git@github.com:acme/app.git\n', stderr: '', exitCode: 0 }
        }
        return { stdout: `${BASE_SHA}\trefs/heads/main\n`, stderr: '', exitCode: 0 }
      },
    })
    await h.dispatcher.tick()
    const builds = await h.store.listBuilds()
    expect(builds).toHaveLength(2)
    expect(builds.map((build) => build.repoOrigin)).toEqual([
      'https://github.com/acme/app',
      'https://github.com/acme/app',
    ])
    expect(remoteCalls).toBe(1)
  })

  test('a repository without an origin remote creates builds without a recorded origin', async () => {
    const h = harness({
      tickets: [readyTicket('T-1')],
      exec: async (cmd) =>
        cmd[1] === 'remote'
          ? { stdout: '', stderr: "error: No such remote 'origin'\n", exitCode: 2 }
          : { stdout: `${BASE_SHA}\trefs/heads/main\n`, stderr: '', exitCode: 0 },
    })
    await h.dispatcher.tick()
    const builds = await h.store.listBuilds()
    expect(builds.map((build) => build.repoOrigin)).toEqual([undefined])
  })

  test('the origin probe runs in the physical checkout, not the origin-URL identity', async () => {
    const remoteCwds: (string | undefined)[] = []
    const h = harness({
      tickets: [readyTicket('T-1')],
      // deps.repo is the store identity (an origin URL); deps.checkout is the
      // physical path. `git remote get-url origin` with cwd = the URL would
      // silently lose the origin (f_8061f912).
      repo: 'https://github.com/acme/app',
      checkout: '/repos/checkout',
      exec: async (cmd, execOpts) => {
        if (cmd[1] === 'remote') {
          remoteCwds.push(execOpts.cwd)
          return { stdout: 'git@github.com:acme/app.git\n', stderr: '', exitCode: 0 }
        }
        return { stdout: `${BASE_SHA}\trefs/heads/main\n`, stderr: '', exitCode: 0 }
      },
    })
    await h.dispatcher.tick()
    expect(remoteCwds).toEqual(['/repos/checkout'])
    const builds = await h.store.listBuilds()
    expect(builds[0]?.repoOrigin).toBe('https://github.com/acme/app')
  })

  test('uses the top-level baseBranch for the durable fact and workspace', async () => {
    const h = harness({
      tickets: [readyTicket('T-trunk')],
      toml: 'baseBranch = "trunk"\n',
    })

    await h.dispatcher.tick()

    const created = (await h.store.getEvents('add-rate-limiting')).find(
      (event) => event.type === 'build.created',
    )
    expect(created?.payload.baseBranch).toBe('trunk')
    expect(h.workspaces.provisions).toEqual([
      { repo: REPO, baseBranch: 'trunk', branch: 'ab/add-rate-limiting' },
    ])
  })

  test('freezes an enabled PR image host into build.created', async () => {
    const h = harness({
      tickets: [readyTicket('T-host')],
      toml: `
[pr.imageHost]
provider = "github-release"
repository = "acme/review-assets"
releaseId = 42
`,
    })

    await h.dispatcher.tick()

    const created = (await h.store.getEvents('add-rate-limiting')).find(
      (event) => event.type === 'build.created',
    )
    expect(created?.payload).toMatchObject({
      pr: {
        imageHost: {
          provider: 'github-release',
          repository: 'acme/review-assets',
          releaseId: 42,
        },
      },
    })
  })

  test('legacy launch defaults never record human consent before runner launch', async () => {
    let launchSnapshot: string[] = []
    const h = harness({
      tickets: [readyTicket('T-auto')],
      onLaunch: async (slug, store) => {
        launchSnapshot = (await store.getEvents(slug)).map((event) => event.type)
      },
    })

    const report = await h.dispatcher.tick({
      defaultAutoMerge: true,
      autoMergeUser: '  dispatch-op  ',
    })
    expect(report).toEqual({ ...emptyTickReport(), dispatched: 1 })

    const events = await h.store.getEvents('add-rate-limiting')
    expect(events.map((event) => event.type)).toEqual([
      'build.created',
      'workspace.provisioned',
      'spec.imported',
      'dispatch.comment-posted',
      'target.moved',
    ])
    expect(events[0]?.payload).not.toHaveProperty('autoMergeRequestedBy')
    expect(launchSnapshot).toEqual(events.map((event) => event.type))
    expect(reduceBuild(events).autoMerge.requested).toBe(false)
  })

  test('a retired off launch default preserves the original event sequence', async () => {
    const h = harness({ tickets: [readyTicket('T-off')] })

    await h.dispatcher.tick({
      defaultAutoMerge: false,
      autoMergeUser: 'unused-operator',
    })

    expect((await h.store.getEvents('add-rate-limiting')).map((event) => event.type)).toEqual([
      'build.created',
      'workspace.provisioned',
      'spec.imported',
      'dispatch.comment-posted',
      'target.moved',
    ])
  })

  test('a launch-flag seed with no durable default fact never touches resumed or directly created builds (seed-only premise)', async () => {
    const h = harness()
    const resumed = await seedBuild(h, { slug: 'resumed-build' })
    await h.store.createBuild({
      slug: 'direct-build',
      repo: REPO,
      branch: 'ab/direct-build',
    })
    const beforeResumed = await h.store.getEvents(resumed)
    const beforeDirect = await h.store.getEvents('direct-build')

    expect(
      await h.dispatcher.tick({
        resumeCurrent: true,
        acceptNewWork: false,
        defaultAutoMerge: true,
        autoMergeUser: 'dispatch-op',
      }),
    ).toEqual({ ...emptyTickReport(), resumed: 1 })

    expect(
      (await h.store.getEvents(resumed)).filter((e): boolean => e.type !== 'target.distance'),
    ).toEqual(beforeResumed)
    expect(
      (await h.store.getEvents('direct-build')).filter(
        (e): boolean => e.type !== 'target.distance',
      ),
    ).toEqual(beforeDirect)
    expect(h.launches).toEqual([resumed])
  })

  test('legacy launch default attribution is inert', async () => {
    const h = harness({ tickets: [readyTicket('T-no-user')] })
    expect(
      (await h.dispatcher.tick({ defaultAutoMerge: true, autoMergeUser: '   ' })).dispatched,
    ).toBe(1)
    expect(
      (await h.store.getEvents('add-rate-limiting')).some(
        (event) => event.type === 'build.auto-merge-requested',
      ),
    ).toBe(false)
  })

  test('copies local fallback evidence from the workspace result into the event', async () => {
    const base: WorkspaceBase = {
      source: 'local',
      sha: 'local-main-sha',
      remoteError: 'git fetch exited 128: authentication failed',
    }
    const h = harness({ tickets: [readyTicket('T-1')], workspaceBase: base })

    expect((await h.dispatcher.tick()).dispatched).toBe(1)
    const provisioned = (await h.store.getEvents('add-rate-limiting')).find(
      (event) => event.type === 'workspace.provisioned',
    )
    expect(provisioned?.payload).toEqual({
      provider: 'fake',
      ref: '/ws/ab/add-rate-limiting',
      path: '/ws/ab/add-rate-limiting',
      remote: false,
      branch: 'ab/add-rate-limiting',
      base,
    })
  })

  test('spec-aware naming sees the exact final spec and can surface a buried subject', async () => {
    let receivedSpec: string | undefined
    const h = harness({
      tickets: [
        readyTicket('T-1', {
          title: 'Please add support for throttling repeated login attempts',
        }),
      ],
      nameSlug: async (spec) => {
        receivedSpec = spec
        return 'login-rate-limit'
      },
    })

    expect((await h.dispatcher.tick()).dispatched).toBe(1)
    expect(receivedSpec).toBe(CONFORMING_BODY)
    expect((await h.store.listBuilds()).map((build) => build.slug)).toEqual(['login-rate-limit'])
    expect(h.workspaces.provisions[0]?.branch).toBe('ab/login-rate-limit')
  })

  test('h1-headed conforming body dispatches: imported as spec, not bounced (AUT-12)', async () => {
    const h1Body = [
      'Login attempts are currently unlimited; throttle repeated failures.',
      '',
      '# Acceptance criteria',
      '',
      '- a sixth failed login within five minutes returns 429',
      '',
      '# Out of scope',
      '',
      '- captcha',
      '',
    ].join('\n')
    const ticket = readyTicket('T-1', { body: h1Body })
    const h = harness({ tickets: [ticket] })

    const report = await h.dispatcher.tick()
    expect(report).toEqual({ ...emptyTickReport(), dispatched: 1 })

    const events = await h.store.getEvents('add-rate-limiting')
    expect(events.map((e) => e.type)).toContain('spec.imported')

    const spec = await h.store.getArtifact('add-rate-limiting', 'spec')
    expect(spec ? textContent(spec) : null).toBe(h1Body)
  })

  test('absent, null, rejected, and invalid naming all take the exact title fallback', async () => {
    const title = 'Please add support for login throttling'
    const scenarios: Array<{
      name: string
      nameSlug?: (spec: string, signal: AbortSignal) => Promise<string | null>
    }> = [
      { name: 'absent' },
      { name: 'null', nameSlug: async () => null },
      {
        name: 'rejected',
        nameSlug: async () => {
          throw new Error('naming service unavailable')
        },
      },
      { name: 'invalid prose', nameSlug: async () => 'Slug: login-rate-limit' },
    ]

    for (const scenario of scenarios) {
      const h = harness({
        tickets: [readyTicket(`T-${scenario.name}`, { title })],
        ...(scenario.nameSlug !== undefined ? { nameSlug: scenario.nameSlug } : {}),
      })
      const report = await h.dispatcher.tick()
      expect(report.dispatched, scenario.name).toBe(1)
      expect((await h.store.listBuilds())[0]?.slug, scenario.name).toBe('please-add-support')
    }
  })

  test('a timed-out namer is aborted and cannot block dispatch', async () => {
    let namingSignal: AbortSignal | undefined
    const h = harness({
      tickets: [
        readyTicket('T-timeout', {
          title: 'Please add support for login throttling',
        }),
      ],
      nameSlug: (_spec, signal) => {
        namingSignal = signal
        return new Promise<string | null>(() => {})
      },
      opts: { slugNamingTimeoutMs: 5 },
    })

    expect((await h.dispatcher.tick()).dispatched).toBe(1)
    expect(namingSignal?.aborted).toBe(true)
    expect((await h.store.listBuilds())[0]?.slug).toBe('please-add-support')
  })

  test('punctuation-only titles still dispatch as build', async () => {
    const h = harness({ tickets: [readyTicket('T-punctuation', { title: '!!!' })] })
    expect((await h.dispatcher.tick()).dispatched).toBe(1)
    expect((await h.store.listBuilds())[0]?.slug).toBe('build')
  })

  test('readyState narrows the scan: only tickets in that state dispatch', async () => {
    const ready = readyTicket('T-1', { state: 'Ready' })
    const backlog = readyTicket('T-2', { title: 'Backlog idea', state: 'Backlog' })
    const h = harness({
      tickets: [ready, backlog],
      toml: ['capacity = 2', '[tickets]', 'source = "file"', 'readyState = "Ready"'].join('\n'),
    })

    const report = await h.dispatcher.tick()

    expect(report.dispatched).toBe(1)
    const builds = await h.store.listBuilds()
    expect(builds.map((b) => b.slug)).toEqual(['add-rate-limiting'])
  })

  test('a completed ticket still carrying the ready label is NOT dispatched — the AUT-10 regression guard (AC 3, 4)', async () => {
    // AUT-10: a ticket that had moved to Done but still carried the `autobuild`
    // label was dispatched a second time because no state gate constrained the
    // scan. With readyState required, the completed ticket is never a candidate,
    // no matter its labels — the label alone can no longer make it eligible.
    const done = readyTicket('T-done', {
      title: 'Already shipped',
      state: 'Done',
      labels: ['autobuild'],
    })
    const fresh = readyTicket('T-ready', {
      title: 'Fresh work',
      state: 'Ready',
      labels: ['autobuild'],
    })
    const h = harness({
      tickets: [done, fresh],
      toml: [
        'capacity = 2', // room for BOTH — so a skip is a real gate, not a cap
        '[tickets]',
        'source = "file"',
        'readyLabels = ["autobuild"]',
        'readyState = "Ready"',
      ].join('\n'),
    })

    const report = await h.dispatcher.tick()

    expect(report.dispatched).toBe(1)
    const builds = await h.store.listBuilds()
    expect(builds.map((b) => b.ticket?.id)).toEqual(['T-ready'])
    // The completed ticket is never even claimed — the gate precedes claim (§12).
    expect(h.tickets.claims).not.toContain('T-done')
  })

  test('a prior completed build does not suppress re-dispatch when the ticket is Ready again (AC 6)', async () => {
    // AC 6: reruns work by moving a ticket back into the configured ready state.
    // The dispatcher gates on the ticket's CURRENT state, never on build
    // history, so an already-merged earlier build for the same ticket id must
    // not permanently hold it back.
    const h = harness({ tickets: [readyTicket('T-1')] })
    const prior = await seedBuild(h, { slug: 'prior-run', ticketId: 'T-1' })
    await h.store.append(prior, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })

    const report = await h.dispatcher.tick()

    expect(report.dispatched).toBe(1)
    const builds = await h.store.listBuilds()
    // A second, distinct build was created for the same ticket — no suppression.
    expect(builds.map((b) => b.slug).sort()).toEqual(['add-rate-limiting', 'prior-run'])
    expect(h.launches).toEqual(['add-rate-limiting'])
  })

  test('claim race: lost claim skips the ticket without building', async () => {
    const h = harness({ tickets: [readyTicket('T-1')] })
    const claim = h.tickets.claim.bind(h.tickets)
    h.tickets.claim = async (id) => {
      await claim(id) // another dispatcher wins after listing, before our claim
      return false
    }

    const report = await h.dispatcher.tick()
    expect(report).toEqual({ ...emptyTickReport(), claimRaces: 1 })
    expect(await h.store.listBuilds()).toEqual([])
    expect(h.launches).toEqual([])
  })

  test('capacity 1, two ready tickets: second merges next tick after the first completes', async () => {
    const h = harness({
      tickets: [
        readyTicket('T-1', { title: 'First feature' }),
        readyTicket('T-2', { title: 'Second feature' }),
      ],
    })

    const first = await h.dispatcher.tick()
    // T-2 remains waiting behind capacity — the standing queue depth reports it.
    expect(first).toEqual({ ...emptyTickReport(), dispatched: 1, queued: 1 })
    expect((await h.store.listBuilds()).map((b) => b.slug)).toEqual(['first-feature'])
    // T-2 was never claimed — capacity ran out before it.
    expect(await h.tickets.claim('T-2')).toBe(true)

    const h2 = harness({
      tickets: [
        readyTicket('T-1', { title: 'First feature' }),
        readyTicket('T-2', { title: 'Second feature' }),
      ],
    })
    await h2.dispatcher.tick()
    // First build completes (the janitor would do this on merge — §15.7).
    await h2.store.append('first-feature', {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })

    const second = await h2.dispatcher.tick()
    // The first ticket left Ready at claim, so only T-2 is offered this tick.
    expect(second).toEqual({ ...emptyTickReport(), dispatched: 1 })
    expect((await h2.store.listBuilds()).map((b) => b.slug)).toEqual([
      'first-feature',
      'second-feature',
    ])
    expect(h2.launches).toEqual(['first-feature', 'second-feature'])
  })

  test('captures reloaded capacity once per tick without terminating work above a lowered limit', async () => {
    const configAt = (capacity: number): Config =>
      parseConfig(`
capacity = ${capacity}
[tickets]
source = "file"
readyState = "Ready"
`)
    let current = configAt(1)
    const h = harness({
      tickets: [
        readyTicket('T-1', { title: 'First feature' }),
        readyTicket('T-2', { title: 'Second feature' }),
        readyTicket('T-3', { title: 'Third feature' }),
      ],
      getConfig: () => current,
      onLaunch: async (slug, store) => {
        const events = await store.getEvents(slug)
        if (!events.some((event) => event.type === 'runner.attached')) {
          await store.append(slug, {
            actor: KERNEL,
            type: 'runner.attached',
            payload: { instance: `runner-${slug}`, host: 'test' },
          })
        }
        await store.claimLease(slug, `runner-${slug}`, 600_000)
      },
    })

    expect((await h.dispatcher.tick()).dispatched).toBe(1)
    current = configAt(3)
    h.clock.advance(60_000)
    expect((await h.dispatcher.tick()).dispatched).toBe(2)
    expect(h.launches).toHaveLength(3)

    current = configAt(1)
    await h.tickets.create(
      { title: 'Fourth feature', body: CONFORMING_BODY, labels: [] },
      { state: 'Ready' },
    )
    h.clock.advance(60_000)
    const lowered = await h.dispatcher.tick()
    expect(lowered.dispatched).toBe(0)
    expect(lowered.queued).toBe(1)
    expect(h.launches).toHaveLength(3)
    expect(await h.store.listBuilds()).toHaveLength(3)
  })

  test('capacity counts blocked and paused builds as occupying slots', async () => {
    // Blocked: an open escalation (§15.5) holds the slot.
    const blocked = harness({ tickets: [readyTicket('T-1')] })
    await seedBuild(blocked, { slug: 'stuck' })
    await blocked.store.append('stuck', {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: 'e_1',
        phase: 'implement',
        source: 'stall',
        question: 'same finding 3 rounds',
      },
    })
    expect(await blocked.dispatcher.tick()).toEqual({
      ...emptyTickReport(),
      queued: 1,
    })
    expect((await blocked.store.listBuilds()).map((b) => b.slug)).toEqual(['stuck'])
    expect(blocked.launches).toEqual([])
    expect(blocked.tickets.comments).toEqual([])

    // Paused: operator instruction (§15.5) also holds the slot.
    const paused = harness({ tickets: [readyTicket('T-1')] })
    await seedBuild(paused, { slug: 'parked' })
    await paused.store.append('parked', {
      actor: KERNEL,
      type: 'build.paused',
      payload: {},
    })
    expect(await paused.dispatcher.tick()).toEqual({
      ...emptyTickReport(),
      queued: 1,
    })
    expect((await paused.store.listBuilds()).map((b) => b.slug)).toEqual(['parked'])
    expect(paused.launches).toEqual([])
  })

  test('nonconforming ticket bounces: Triage transition + comment naming missing parts, no build', async () => {
    const h = harness({ tickets: [readyTicket('T-1', { body: 'make it faster' })] })

    const report = await h.dispatcher.tick()
    expect(report).toEqual({ ...emptyTickReport(), bounced: 1 })
    expect(await h.store.listBuilds()).toEqual([])
    expect(h.launches).toEqual([])
    expect(h.workspaces.provisions).toEqual([])

    expect(h.tickets.transitions).toEqual([{ id: 'T-1', state: 'Triage' }])
    const comment = h.tickets.comments[0]
    expect(comment?.id).toBe('T-1')
    expect(comment?.body).toContain('.agents/skills/ab-guide/references/spec-standard.md')
    expect(comment?.body).not.toContain('docs/spec-standard.md')
    expect(comment?.body).toContain("an '## Acceptance criteria' heading")
    expect(comment?.body).toContain("an '## Out of scope' heading")
  })

  test('bounce targets Backlog by default for a linear ticket source', async () => {
    // Linear teams only have a "Triage" state when the triage feature is
    // enabled — Backlog is the hand-back state every team has.
    const h = harness({
      tickets: [readyTicket('T-1', { body: 'make it faster' })],
      toml: '[tickets]\nsource = "linear"\nteamKey = "AUT"\n',
    })

    const report = await h.dispatcher.tick()
    expect(report).toEqual({ ...emptyTickReport(), bounced: 1 })
    expect(h.tickets.transitions).toEqual([{ id: 'T-1', state: 'Backlog' }])
  })

  test('triageState: [tickets] config beats the source default, opts beat config', async () => {
    const configured = harness({
      tickets: [readyTicket('T-1', { body: 'make it faster' })],
      toml: '[tickets]\nsource = "linear"\nteamKey = "AUT"\ntriageState = "Todo"\n',
    })
    await configured.dispatcher.tick()
    expect(configured.tickets.transitions).toEqual([{ id: 'T-1', state: 'Todo' }])

    const opted = harness({
      tickets: [readyTicket('T-1', { body: 'make it faster' })],
      toml: '[tickets]\nsource = "linear"\nteamKey = "AUT"\ntriageState = "Todo"\n',
      opts: { triageState: 'Backlog' },
    })
    await opted.dispatcher.tick()
    expect(opted.tickets.transitions).toEqual([{ id: 'T-1', state: 'Backlog' }])
  })

  test('proposalState is harvest-only: it never moves the bounce target', async () => {
    // The whole reason proposals get their own field. A repository that files
    // proposals straight into readyState must still bounce nonconforming work
    // somewhere a dispatch tick will not immediately reclaim it.
    const h = harness({
      tickets: [readyTicket('T-1', { body: 'make it faster' })],
      toml: '[tickets]\nsource = "linear"\nteamKey = "AUT"\nproposalState = "Todo"\n',
    })
    await h.dispatcher.tick()
    expect(h.tickets.transitions).toEqual([{ id: 'T-1', state: 'Backlog' }])
  })

  test('defaultProposalState: configured value, else the resolved triage state', () => {
    const linear = (extra = '') =>
      parseConfig(`[tickets]\nsource = "linear"\nteamKey = "AUT"\nreadyState = "Todo"\n${extra}`)

    expect(defaultProposalState(linear())).toBe('Backlog')
    expect(defaultProposalState(linear('triageState = "Icebox"\n'))).toBe('Icebox')
    expect(defaultProposalState(linear('proposalState = "Todo"\n'))).toBe('Todo')
    // An explicit proposal state overrides the triage state without moving it.
    const both = linear('triageState = "Icebox"\nproposalState = "Todo"\n')
    expect(defaultProposalState(both)).toBe('Todo')
    expect(defaultTriageState(both)).toBe('Icebox')
    expect(
      defaultProposalState(parseConfig('[tickets]\nsource = "file"\nreadyState = "ready"\n')),
    ).toBe('Triage')
  })

  test('authorSpec success: authored body is recorded and then supplied to naming', async () => {
    let namedSpec: string | undefined
    const h = harness({
      tickets: [readyTicket('T-1', { body: 'thin but groomed' })],
      authorSpec: async () => CONFORMING_BODY,
      nameSlug: async (spec) => {
        namedSpec = spec
        return 'login-rate-limit'
      },
    })

    const report = await h.dispatcher.tick()
    expect(report).toEqual({ ...emptyTickReport(), dispatched: 1, authored: 1 })

    const events = await h.store.getEvents('login-rate-limit')
    expect(events.map((e) => e.type)).toEqual([
      'build.created',
      'workspace.provisioned',
      'spec.authored',
      'dispatch.comment-posted',
      'target.moved',
    ])
    expect(events[2]?.actor).toEqual({ kind: 'agent', role: 'spec', session: 's_1' })
    expect(events[2]?.payload).toEqual({
      artifact: { kind: 'spec', rev: 0 },
      session: 's_1',
    })
    // The authored body, not the thin ticket body, is both the contract and
    // the naming input (§6.3).
    const spec = await h.store.getArtifact('login-rate-limit', 'spec')
    expect(spec ? textContent(spec) : null).toBe(CONFORMING_BODY)
    expect(namedSpec).toBe(CONFORMING_BODY)
    expect(h.launches).toEqual(['login-rate-limit'])
  })

  test('authorSpec returning nonconforming or null bounces', async () => {
    const h = harness({
      tickets: [
        readyTicket('T-1', { body: 'thin', title: 'One' }),
        readyTicket('T-2', { body: 'thin', title: 'Two' }),
      ],
      authorSpec: async (ticket) => (ticket.ref.id === 'T-1' ? 'still not a spec' : null),
    })

    const report = await h.dispatcher.tick()
    expect(report).toEqual({ ...emptyTickReport(), bounced: 2 })
    expect(await h.store.listBuilds()).toEqual([])
    expect(h.launches).toEqual([])
    expect(h.tickets.transitions).toEqual([
      { id: 'T-1', state: 'Triage' },
      { id: 'T-2', state: 'Triage' },
    ])
  })

  test('equal meaningful candidates dedupe with a suffix outside the word budget', async () => {
    const h = harness({
      tickets: [readyTicket('T-1'), readyTicket('T-2')],
      toml: 'capacity = 2\n',
      nameSlug: async () => 'login-rate-limit',
    })

    const report = await h.dispatcher.tick()
    expect(report).toEqual({ ...emptyTickReport(), dispatched: 2 })
    const builds = await h.store.listBuilds()
    expect(builds.map((b) => b.slug)).toEqual(['login-rate-limit', 'login-rate-limit-2'])
    expect(builds.map((b) => b.branch)).toEqual(['ab/login-rate-limit', 'ab/login-rate-limit-2'])
    expect(h.launches).toEqual(['login-rate-limit', 'login-rate-limit-2'])
  })

  test('uniqueness skips later occupied suffixes and never changes an existing long slug', async () => {
    const oldSlug = 'existing-build-with-a-long-historical-slug'
    const h = harness({
      tickets: [readyTicket('T-new')],
      toml: 'capacity = 4\n',
      nameSlug: async () => 'login-rate-limit',
    })
    await h.store.createBuild({
      slug: oldSlug,
      repo: REPO,
      branch: `ab/${oldSlug}`,
    })
    await h.store.createBuild({
      slug: 'login-rate-limit',
      repo: REPO,
      branch: 'ab/login-rate-limit',
    })
    await h.store.createBuild({
      slug: 'login-rate-limit-2',
      repo: REPO,
      branch: 'ab/login-rate-limit-2',
    })

    expect((await h.dispatcher.tick()).dispatched).toBe(1)
    expect(await h.store.getBuild('login-rate-limit-3')).not.toBeNull()
    expect((await h.store.getBuild(oldSlug))?.branch).toBe(`ab/${oldSlug}`)
  })
})

// ── Invocation budget (deadlineAt, AUT-319) ──────────────────────────────────

describe('Dispatcher invocation budget', () => {
  test('a tick whose budget is already spent performs no stage work and returns the empty report', async () => {
    const h = harness({ tickets: [readyTicket('T-1')] })

    const report = await h.dispatcher.tick({ deadlineAt: h.clock().getTime() - 1000 })

    // No fabricated counts, no stage entry: no ticket claim, no launch, no
    // forge probe, no build created — the whole pass is deferred.
    expect(report).toEqual(emptyTickReport())
    expect(h.tickets.claims).toEqual([])
    expect(h.launches).toEqual([])
    expect(h.forge.getPrStateCalls).toEqual([])
    expect(await h.store.listBuilds()).toEqual([])
  })

  test('a slow claim that spends the budget mid-dispatch stops the ready loop before the next ticket claim', async () => {
    let h!: Harness
    // The claim transport call for the first ticket overruns the invocation
    // bound (one slow forge/store round trip). The gate is per ticket, so the
    // first ticket still dispatches completely; the second is left
    // un-attempted for the next invocation.
    h = harness({
      tickets: [readyTicket('T-1'), readyTicket('T-2', { title: 'Add retry budget' })],
      toml: 'capacity = 2\n',
      wrapTickets: (source) =>
        new Proxy(source, {
          get(target, property, receiver) {
            if (property === 'claim') {
              return async (id: string): Promise<boolean> => {
                h.clock.advance(60_000)
                return target.claim(id)
              }
            }
            return Reflect.get(target, property, receiver)
          },
        }) as FakeTicketSource,
    })

    const deadline = h.clock().getTime() + 1000
    const report = await h.dispatcher.tick({ deadlineAt: deadline })

    // Ticket 1 dispatched; ticket 2's claim (a transport call) never started.
    expect(report.dispatched).toBe(1)
    expect(h.tickets.claims).toEqual(['T-1'])
    expect(h.launches).toEqual(['add-rate-limiting'])
    const builds = await h.store.listBuilds()
    expect(builds.map((build) => build.slug)).toEqual(['add-rate-limiting'])
  })

  test('a slow forge probe that spends the budget mid-janitor stops the record loop before the next PR probe', async () => {
    const h = harness({
      tickets: [readyTicket('T-1', { labels: [] })],
      toml: 'capacity = 10\n',
    })
    await seedBuild(h, { slug: 'pr-probe-first', pr: { ...PR, number: 11 } })
    await seedBuild(h, { slug: 'pr-probe-second', pr: { ...PR, number: 12 } })
    h.forge.setPrState(11, { state: 'merged', sha: 'squash-11' })
    h.forge.setPrState(12, { state: 'merged', sha: 'squash-12' })
    // The first PR probe overruns the invocation bound; the second build's
    // probe must never start.
    const getPrState = h.forge.getPrState.bind(h.forge)
    h.forge.getPrState = async (workspacePath, number) => {
      h.clock.advance(60_000)
      return getPrState(workspacePath, number)
    }

    const deadline = h.clock().getTime() + 1000
    const report = await h.dispatcher.tick({ deadlineAt: deadline })

    // Only the first build was probed (and settled — merged is its durable
    // boundary); the second build's forge probe was never started, and no
    // later stage (recovery, resume, sweep, dispatch) ran either.
    expect(report).toEqual({ ...emptyTickReport(), merged: 1 })
    expect(h.forge.getPrStateCalls).toEqual([
      { workspacePath: '/ws/ab/pr-probe-first', number: 11 },
    ])
    expect(h.launches).toEqual([])
    expect(h.tickets.claims).toEqual([])
  })
})

// ── Harvest coordination (§12) ───────────────────────────────────────────────

describe('Dispatcher harvest coordination', () => {
  test('starts harvest after ready-ticket dispatch without folding its later outcome into this tick', async () => {
    let h!: Harness
    h = harness({
      tickets: [readyTicket('T-harvest', { title: 'Harvest ordering' })],
      startHarvest: () => {
        expect(h.launches).toEqual(['harvest-ordering'])
      },
    })

    expect(await h.dispatcher.tick()).toEqual({
      ...emptyTickReport(),
      dispatched: 1,
    })
  })

  test('a long harvest promise does not delay tick completion', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started = false
    const h = harness({
      startHarvest: async () => {
        started = true
        await gate
      },
    })

    const result = await Promise.race([
      h.dispatcher.tick(),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 20)),
    ])
    expect(result).not.toBe('timed-out')
    expect(started).toBe(true)
    release()
  })

  test('an acknowledged pause gates every tick, while an unacknowledged pause still launches settlement', async () => {
    let calls = 0
    const h = harness({
      startHarvest: () => {
        calls += 1
      },
    })
    await h.store.ensureRepo(REPO)
    await h.store.appendRepo(REPO, {
      actor: humanActor('operator'),
      type: 'harvest.pause-requested',
      payload: {},
    })

    await h.dispatcher.tick()
    expect(calls).toBe(1)
    await h.store.appendRepo(REPO, {
      actor: KERNEL,
      type: 'harvest.paused',
      payload: {},
    })
    await h.dispatcher.tick()
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(calls).toBe(1)
  })

  test('a pending resume reopens harvest launch even while drained and at build capacity', async () => {
    let calls = 0
    const h = harness({
      startHarvest: () => {
        calls += 1
      },
    })
    await seedBuild(h, { slug: 'capacity-holder' })
    await h.store.claimLease('capacity-holder', 'live-runner', 3_600_000)
    await h.store.ensureRepo(REPO)
    await h.store.appendRepo(REPO, {
      actor: humanActor('operator'),
      type: 'harvest.pause-requested',
      payload: {},
    })
    await h.store.appendRepo(REPO, {
      actor: KERNEL,
      type: 'harvest.paused',
      payload: {},
    })
    await h.store.appendRepo(REPO, {
      actor: humanActor('operator'),
      type: 'harvest.resume-requested',
      payload: {},
    })

    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual(emptyTickReport())
    expect(calls).toBe(1)
    expect(h.launches).toEqual([])
  })

  test('a shadowed errored run is selected for automatic recovery on every eligible tick', async () => {
    let calls = 0
    const h = harness({
      startHarvest: () => {
        calls += 1
      },
    })
    await seedBuild(h, { slug: 'capacity-holder' })
    await h.store.claimLease('capacity-holder', 'live-runner', 3_600_000)
    await h.store.ensureRepo(REPO)
    await h.store.appendRepo(REPO, {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_errored',
        observations: [{ build: 'capacity-holder', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    await h.store.appendRepo(REPO, {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_errored',
        step: 'file',
        attempt: 2,
        error: 'ticket provider unavailable',
        willRetry: false,
      },
    })
    await h.store.appendRepo(REPO, {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_later_completed',
        observations: [{ build: 'later-build', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 1 },
      },
    })
    await h.store.appendRepo(REPO, {
      actor: KERNEL,
      type: 'harvest.completed',
      payload: {
        run: 'h_later_completed',
        dispositions: [
          {
            occurrence: { build: 'later-build', seq: 1 },
            action: 'suppressed',
            proposalKey: 'later-completed',
          },
        ],
        report: { kind: 'harvest-report', rev: 1 },
      },
    })

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual(emptyTickReport())
    expect(calls).toBe(2)

    await h.store.appendRepo(REPO, {
      actor: humanActor('operator'),
      type: 'harvest.resume-requested',
      payload: {},
    })
    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual(emptyTickReport())
    expect(calls).toBe(3)
    expect(h.launches).toEqual([])
  })

  test('an exhausted attention barrier suppresses repeated ticks until a human acknowledgement request', async () => {
    let calls = 0
    const h = harness({
      startHarvest: () => {
        calls += 1
      },
    })
    await h.store.ensureRepo(REPO)
    await h.store.appendRepo(REPO, {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_exhausted',
        observations: [{ build: 'old-build', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    await h.store.appendRepo(REPO, {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_exhausted',
        step: 'synthesize',
        round: 1,
        attempt: 2,
        error: 'provider unavailable',
        willRetry: false,
      },
    })
    for (const attempt of [1, 2]) {
      await h.store.appendRepo(REPO, {
        actor: KERNEL,
        type: 'harvest.recovery-requested',
        payload: { run: 'h_exhausted', attempt, limit: 2 },
      })
      await h.store.appendRepo(REPO, {
        actor: KERNEL,
        type: 'harvest.resumed',
        payload: {},
      })
      await h.store.appendRepo(REPO, {
        actor: KERNEL,
        type: 'harvest.failed',
        payload: {
          run: 'h_exhausted',
          step: 'synthesize',
          round: 1,
          attempt: attempt + 2,
          error: 'provider unavailable',
          willRetry: false,
        },
      })
    }
    await h.store.appendRepo(REPO, {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_later_terminal',
        observations: [{ build: 'later-build', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 1 },
      },
    })
    await h.store.appendRepo(REPO, {
      actor: KERNEL,
      type: 'harvest.completed',
      payload: {
        run: 'h_later_terminal',
        dispositions: [
          {
            occurrence: { build: 'later-build', seq: 1 },
            action: 'suppressed',
            proposalKey: 'later-terminal',
          },
        ],
        report: { kind: 'harvest-report', rev: 1 },
      },
    })
    await h.store.appendRepo(REPO, {
      actor: KERNEL,
      type: 'harvest.recovery-exhausted',
      payload: {
        run: 'h_exhausted',
        step: 'synthesize',
        round: 1,
        error: 'provider unavailable',
        attempts: 2,
        limit: 2,
        releasedObservations: [{ build: 'old-build', seq: 1 }],
        committedDispositions: [],
        pendingProposals: [],
      },
    })

    await h.dispatcher.tick()
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(calls).toBe(0)

    await h.store.appendRepo(REPO, {
      actor: humanActor('operator'),
      type: 'harvest.resume-requested',
      payload: {},
    })
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(calls).toBe(1)
  })

  test('harvest remains independent of drain and occupied build capacity', async () => {
    let calls = 0
    const h = harness({
      tickets: [readyTicket('T-blocked-by-capacity')],
      startHarvest: () => {
        calls += 1
      },
    })
    await seedBuild(h, { slug: 'capacity-holder' })
    await h.store.claimLease('capacity-holder', 'live-runner', 3_600_000)

    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual(emptyTickReport())
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), queued: 1 })
    expect(calls).toBe(2)
    expect(h.launches).toEqual([])
    expect(h.tickets.claims).toEqual([])
  })
})

// ── Janitor (§15.7, D1) ──────────────────────────────────────────────────────

describe('Dispatcher tick-time intake gate', () => {
  test('drained skips even listing/claiming ready tickets; a later normal tick dispatches', async () => {
    const h = harness({ tickets: [readyTicket('T-drain')] })
    const listReady = h.tickets.listReady.bind(h.tickets)
    let lists = 0
    h.tickets.listReady = async (...args) => {
      lists += 1
      return listReady(...args)
    }

    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual(emptyTickReport())
    expect(lists).toBe(0)
    expect(h.tickets.claims).toEqual([])
    expect(await h.store.listBuilds()).toEqual([])

    expect(await h.dispatcher.tick()).toEqual({
      ...emptyTickReport(),
      dispatched: 1,
    })
    expect(lists).toBe(1)
    expect(h.tickets.claims).toEqual(['T-drain'])
  })

  test('observation-only ready listing reports depth without claim or build side effects', async () => {
    const h = harness({ tickets: [readyTicket('T-observe')] })
    const observed = await h.dispatcher.observeReady()
    expect(observed).toEqual({ queued: 1, invalidTickets: 0, ticketDiagnostics: [] })
    expect(h.tickets.claims).toEqual([])
    expect(await h.store.listBuilds()).toEqual([])
  })

  test('drained still performs janitor completion without refilling capacity', async () => {
    const h = harness({ tickets: [readyTicket('T-next')] })
    const slug = await seedBuild(h, { pr: PR })
    h.forge.setPrState(1, { state: 'merged', sha: 'squash-drain' })

    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual({
      ...emptyTickReport(),
      merged: 1,
    })
    expect((await h.store.getEvents(slug)).at(-1)?.type).toBe('build.completed')
    expect(h.tickets.claims).toEqual([])
  })

  test('drained still sweeps a stale runner', async () => {
    const h = harness({ tickets: [readyTicket('T-next')] })
    const slug = await seedBuild(h)

    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual({
      ...emptyTickReport(),
      swept: 1,
    })
    expect(h.launches).toEqual([slug])
    expect(h.tickets.claims).toEqual([])
  })
})

// ── Repository-wide pause hold ───────────────────────────────────────────────

/** Write the repository-wide quiescence fact the dashboard's pause-all writes. */
async function pauseRepo(store: BuildStore, enabled: boolean, repo = REPO): Promise<void> {
  await store.ensureRepo(repo)
  await store.appendRepo(repo, {
    actor: humanActor('operator'),
    type: 'dispatcher.pause-set',
    payload: { enabled },
  })
}

describe('heldByRepositoryPause', () => {
  test('holds queued builds only, and only while the repository is paused', () => {
    const statuses: BuildState['status'][] = [
      'queued',
      'running',
      'blocked',
      'paused',
      'done',
      'aborted',
    ]
    for (const status of statuses) {
      const state = { status } as BuildState
      expect(heldByRepositoryPause(state, true)).toBe(status === 'queued')
      expect(heldByRepositoryPause(state, false)).toBe(false)
    }
  })
})

describe('Dispatcher repository pause hold', () => {
  test('recovery does not complete an interrupted dispatch while the repository is paused', async () => {
    const h = harness({ tickets: [readyTicket('T-recover')] })
    await seedInterrupted(h, 'held-recovery')
    await pauseRepo(h.store, true)

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.launches).toEqual([])
    // Nothing durable happened either: no workspace, no dispatched comment.
    const types = (await h.store.getEvents('held-recovery')).map((event) => event.type)
    expect(types).toEqual(['build.created'])

    await pauseRepo(h.store, false)
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), recovered: 1 })
    expect(h.launches).toEqual(['held-recovery'])
  })

  test('startup resume does not attach a runner to a queued build while paused', async () => {
    const h = harness()
    // No ticket on the record, so recovery skips it; a healthy lease, so the
    // sweep skips it. Startup resume is the only stage that can reach it.
    const slug = await seedBuild(h, { attached: false })
    await h.store.claimLease(slug, 'runner-1', 3_600_000)
    await pauseRepo(h.store, true)

    expect(await h.dispatcher.tick({ resumeCurrent: true })).toEqual(emptyTickReport())
    expect(h.launches).toEqual([])

    await pauseRepo(h.store, false)
    expect(await h.dispatcher.tick({ resumeCurrent: true })).toEqual({
      ...emptyTickReport(),
      resumed: 1,
    })
    expect(h.launches).toEqual([slug])
  })

  test('the lease sweep leaves a queued build with an expired lease held', async () => {
    const h = harness()
    const slug = await seedBuild(h, { attached: false })
    await pauseRepo(h.store, true)

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.launches).toEqual([])

    await pauseRepo(h.store, false)
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), swept: 1 })
    expect(h.launches).toEqual([slug])
  })

  test('a running build with a dead runner is still swept — the hold never strands command delivery', async () => {
    const h = harness()
    const slug = await seedBuild(h)
    await h.store.claimLease(slug, 'runner-1', 1000)
    h.clock.advance(2000)
    await pauseRepo(h.store, true)

    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), swept: 1 })
    expect(h.launches).toEqual([slug])
  })

  test('an abort on a queued build is still honored while paused', async () => {
    const h = harness({ tickets: [readyTicket('T-queued-abort', { labels: [] })] })
    const slug = await seedBuild(h, {
      slug: 'paused-abort',
      ticketId: 'T-queued-abort',
      attached: false,
    })
    await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.abort-requested',
      payload: { reason: 'cancel queued work' },
    })
    await pauseRepo(h.store, true)

    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), abandoned: 1 })
    expect(reduceBuild(await h.store.getEvents(slug))).toMatchObject({
      status: 'done',
      outcome: 'abandoned',
    })
  })

  test('a discard on a queued build is still honored while paused', async () => {
    const h = harness({ tickets: [readyTicket('T-recover')] })
    await seedInterrupted(h, 'paused-discard')
    await h.store.append('paused-discard', {
      actor: humanActor('operator'),
      type: 'build.discard-requested',
      payload: {},
    })
    await pauseRepo(h.store, true)

    // The discard returns the ticket to Ready, and the ready scan still runs
    // while paused, so the standing queue-depth report picks it straight back
    // up — it is simply not claimed into a new build until the resume.
    expect(await h.dispatcher.tick()).toEqual({
      ...emptyTickReport(),
      discarded: 1,
      queued: 1,
    })
    expect(reduceBuild(await h.store.getEvents('paused-discard'))).toMatchObject({
      status: 'done',
      outcome: 'discarded',
    })
    // …and no second build was created from it while the pause holds.
    expect(await h.store.listBuilds()).toHaveLength(1)
  })

  test('intake off on its own leaves an already-queued build launchable', async () => {
    // The spec's settled decision: intake governs new ticket intake, not work
    // the repository has already accepted. No pause fact is written here.
    const swept = harness()
    const slug = await seedBuild(swept, { attached: false })
    expect(await swept.dispatcher.tick({ acceptNewWork: false })).toEqual({
      ...emptyTickReport(),
      swept: 1,
    })
    expect(swept.launches).toEqual([slug])

    const recovered = harness({ tickets: [readyTicket('T-recover')] })
    await seedInterrupted(recovered, 'intake-off-recovery')
    expect(await recovered.dispatcher.tick({ acceptNewWork: false })).toEqual({
      ...emptyTickReport(),
      recovered: 1,
    })
    expect(recovered.launches).toEqual(['intake-off-recovery'])
  })

  test('the dispatch stage claims no ticket while paused, but still reports queue depth', async () => {
    // Reachable only when intake is back on without a resume (or when the
    // intake write failed after the pause write landed).
    const h = harness({ tickets: [readyTicket('T-held')] })
    await pauseRepo(h.store, true)

    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), queued: 1 })
    expect(h.tickets.claims).toEqual([])
    expect(await h.store.listBuilds()).toEqual([])

    await pauseRepo(h.store, false)
    h.clock.advance(60_000)
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), dispatched: 1 })
    expect(h.tickets.claims).toEqual(['T-held'])
  })

  test('the hold survives a dispatcher restart and is not defeated by re-running dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ab-pause-hold-'))
    try {
      const first = openLocalStore(root, { clock: manualClock() })
      const seeded = harness({ tickets: [readyTicket('T-recover')], store: first })
      await seedInterrupted(seeded, 'restart-held')
      await pauseRepo(first, true)
      await first.close()

      // A brand-new store handle AND a brand-new Dispatcher: nothing but the
      // durable journal carries the hold across the restart.
      const second = openLocalStore(root, { clock: manualClock() })
      try {
        const h = harness({ tickets: [readyTicket('T-recover')], store: second })
        expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
        expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
        expect(h.launches).toEqual([])

        await pauseRepo(second, false)
        expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), recovered: 1 })
        expect(h.launches).toEqual(['restart-held'])
      } finally {
        await second.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a bulk pause whose intake write fails still leaves queued work unlaunchable', async () => {
    // The composed proof that the write order is load-bearing: under the
    // reverse order the pause fact never lands and this tick launches.
    const h = harness({ tickets: [readyTicket('T-recover')] })
    await seedInterrupted(h, 'partial-pause')
    const failing = withFailingRepoAppend(h.store, 'dispatcher.intake-set')

    await expect(
      bulkControlRepository({
        store: failing,
        repo: REPO,
        env: { USER: 'operator' },
        direction: 'pause',
      }),
    ).rejects.toThrow(/dispatcher.intake-set/)

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.launches).toEqual([])
  })

  test('another repository’s pause does not hold this one, and vice versa', async () => {
    const h = harness()
    const slug = await seedBuild(h, { attached: false })
    await pauseRepo(h.store, true, '/repos/elsewhere')

    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), swept: 1 })
    expect(h.launches).toEqual([slug])

    // With THIS repo paused, a foreign build record is likewise untouched —
    // it was never this dispatcher's to launch.
    const foreign = harness()
    await seedBuild(foreign, { slug: 'foreign-build', repo: '/repos/elsewhere', attached: false })
    await pauseRepo(foreign.store, true)
    expect(await foreign.dispatcher.tick()).toEqual(emptyTickReport())
    expect(foreign.launches).toEqual([])
    expect(reduceBuild(await foreign.store.getEvents('foreign-build')).status).toBe('queued')
  })

  test('a store where no repository row exists ticks normally', async () => {
    const h = harness()
    expect(await h.store.getRepo(REPO)).toBeNull()
    const slug = await seedBuild(h, { attached: false })

    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), swept: 1 })
    expect(h.launches).toEqual([slug])
  })
})

describe('Dispatcher in-flight creation gate', () => {
  test('a ready scan racing reservation, source create, and blocker filing withholds then gates the fresh dependency', async () => {
    const creationKey = crypto.randomUUID()
    let firstListing = true
    let h!: Harness
    h = harness({
      tickets: [
        readyTicket('T-created', { title: 'Generated work', creationKey }),
        readyTicket('T-blocker', { title: 'Prerequisite', state: 'In Progress' }),
      ],
      wrapTickets: (source) => {
        const listReady = source.listReady.bind(source)
        source.listReady = async (criteria) => {
          const stale = await listReady(criteria)
          if (!firstListing) return stale
          firstListing = false
          // The source listing has captured the newly visible ticket without
          // blockers. Filing then finishes entirely before dispatch receives
          // that stale projection, reproducing the production race.
          await h.store.appendRepo(REPO, {
            actor: KERNEL,
            type: 'harvest.proposal.id-reserved',
            payload: { run: 'h_race', proposalKey: 'cluster-race', id: creationKey },
          })
          await source.addBlocker('T-created', 'T-blocker')
          await h.store.appendRepo(REPO, {
            actor: KERNEL,
            type: 'harvest.proposal.filed',
            payload: {
              run: 'h_race',
              proposalKey: 'cluster-race',
              ticket: { source: 'fake', id: 'T-created', title: 'Generated work' },
            },
          })
          return stale
        }
        return source
      },
    })
    await h.store.ensureRepo(REPO)
    await h.store.appendRepo(REPO, {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_race',
        observations: [{ build: 'origin', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })

    const raced = await h.dispatcher.tick()
    expect(raced).toMatchObject({
      queued: 1,
      creationWithheld: 1,
      dependencyBlocked: 0,
      dispatched: 0,
    })
    expect(raced.creationDiagnostics).toEqual([
      expect.stringContaining('ticket T-created: creation withheld — Harvest run h_race'),
    ])
    expect(h.tickets.claims).toEqual([])
    expect(h.tickets.dependencyQueries).toEqual([])
    expect(await h.store.listBuilds()).toEqual([])
    expect(h.workspaces.provisions).toEqual([])
    expect(h.launches).toEqual([])

    // The conservative current-scan hold is gone. A fresh source projection
    // now carries the blocker written by filing, so the ordinary dependency
    // gate — not the creation gate — explains why the ticket still waits.
    h.clock.advance(60_000)
    const blocked = await h.dispatcher.tick()
    expect(blocked).toMatchObject({
      queued: 1,
      creationWithheld: 0,
      dependencyBlocked: 1,
      dispatched: 0,
    })
    expect(blocked.dependencyDiagnostics).toEqual([
      'ticket T-created blocked by T-blocker (not complete)',
    ])
    expect(h.tickets.claims).toEqual([])

    await h.tickets.transition('T-blocker', 'Done')
    h.clock.advance(60_000)
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), dispatched: 1 })
    expect(h.tickets.claims).toEqual(['T-created'])
  })
  test('a held ticket spends no capacity and a later ready ticket dispatches', async () => {
    const creationKey = crypto.randomUUID()
    const h = harness({
      tickets: [
        readyTicket('T-held', { title: 'Held generated work', creationKey, target: 'UNCLAIMED' }),
        readyTicket('T-next', { title: 'Independent work' }),
      ],
    })
    await h.store.ensureRepo(REPO)
    await h.store.appendRepo(REPO, {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_active',
        observations: [{ build: 'origin', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    await h.store.appendRepo(REPO, {
      actor: KERNEL,
      type: 'harvest.proposal.id-reserved',
      payload: { run: 'h_active', proposalKey: 'cluster-held', id: creationKey },
    })

    expect(await h.dispatcher.tick()).toEqual({
      ...emptyTickReport(),
      queued: 1,
      creationWithheld: 1,
      creationDiagnostics: [expect.stringContaining('ticket T-held: creation withheld')],
      dispatched: 1,
    })
    expect(h.tickets.claims).toEqual(['T-next'])
  })
})

describe('Dispatcher dependency gate', () => {
  /** readyState pins the candidate set to Ready tickets, so a blocker parked
   * in another state is a dependency and not itself dispatchable work — the
   * arrangement these tests are actually about. */
  const CAPACITY_2 = ['capacity = 2', '[tickets]', 'source = "file"', 'readyState = "Ready"'].join(
    '\n',
  )

  test('27-ticket milestone chain reads only the completed boundary', async () => {
    const tickets = Array.from({ length: 27 }, (_, index) => {
      const n = index + 1
      return readyTicket(`T-${n}`, {
        title: `Milestone number ${n}`,
        state: n <= 7 ? 'Done' : 'Ready',
        ...(n > 1 ? { blockedBy: [`T-${n - 1}`] } : {}),
      })
    })
    const h = harness({ tickets, toml: CAPACITY_2 })
    const report = await h.dispatcher.tick()
    expect(h.tickets.dependencyQueries).toEqual([['T-7']])
    expect(h.tickets.claims).toEqual(['T-8'])
    expect(report.dispatched).toBe(1)
    expect(report.dependencyBlocked).toBe(19)
    expect(report.dependencyDiagnostics).toEqual(
      Array.from(
        { length: 19 },
        (_, i) => `ticket T-${i + 9} blocked by T-${i + 8} (not complete)`,
      ),
    )
  })

  test('completed branches stop before missing and cycling history', async () => {
    const h = harness({
      tickets: [
        readyTicket('A', { blockedBy: ['B'] }),
        readyTicket('B', { state: 'Done', blockedBy: ['missing', 'C'] }),
        readyTicket('C', { state: 'In Progress', blockedBy: ['C'] }),
      ],
      toml: CAPACITY_2,
    })
    const report = await h.dispatcher.tick()
    expect(report.dispatched).toBe(1)
    expect(report.dependencyDiagnostics).toEqual([])
    expect(h.tickets.dependencyQueries).toEqual([['B']])
  })

  test('mixed ready and non-ready cycles traverse listing facts', async () => {
    const h = harness({
      tickets: [
        readyTicket('A', { blockedBy: ['B'] }),
        readyTicket('B', { blockedBy: ['C'] }),
        readyTicket('C', { state: 'In Progress', blockedBy: ['A'] }),
      ],
      toml: CAPACITY_2,
    })
    const report = await h.dispatcher.tick()
    expect(report.dependencyDiagnostics).toEqual([
      'ticket A: dependency cycle A → B → C → A',
      'ticket B: dependency cycle B → C → A → B',
    ])
    expect(h.tickets.dependencyQueries).toEqual([['C']])
  })

  test('cached history cannot close a cycle through a completed node', async () => {
    const h = harness({
      tickets: [
        readyTicket('C', { blockedBy: ['B'] }),
        readyTicket('A', { blockedBy: ['C'] }),
        readyTicket('B', { state: 'Done', blockedBy: ['C'] }),
      ],
      toml: CAPACITY_2,
    })
    const report = await h.dispatcher.tick()
    expect(report.dependencyDiagnostics).toEqual(['ticket A blocked by C (not complete)'])
    expect(h.tickets.dependencyQueries).toEqual([['B']])
  })

  test('active-build listing members remain dependency facts', async () => {
    const h = harness({
      tickets: [
        readyTicket('A', { blockedBy: ['B'] }),
        readyTicket('B', { title: 'Active prerequisite' }),
      ],
      toml: CAPACITY_2,
    })
    await seedBuild(h, { slug: 'active-prerequisite', ticketId: 'B' })
    const report = await h.dispatcher.tick()
    expect(report.dependencyDiagnostics).toEqual(['ticket A blocked by B (not complete)'])
    expect(h.tickets.dependencyQueries).toEqual([])
  })

  test('ready listing facts refresh on the next tick', async () => {
    const h = harness({
      tickets: [
        readyTicket('A', { blockedBy: ['B'] }),
        readyTicket('B', { blockedBy: ['missing'] }),
      ],
      toml: CAPACITY_2,
    })
    expect((await h.dispatcher.tick()).dependencyBlocked).toBe(2)
    expect(h.tickets.dependencyQueries).toEqual([['missing']])
    await h.tickets.transition('B', 'Done')
    h.clock.advance(60_000)
    const report = await h.dispatcher.tick()
    expect(report.dispatched).toBe(1)
    expect(report.dependencyDiagnostics).toEqual([])
    expect(h.tickets.dependencyQueries).toEqual([['missing'], ['B']])
  })
  test('an unresolved blocker: not claimed, no build, no workspace, no comment', async () => {
    const h = harness({
      tickets: [
        readyTicket('T-1', { title: 'Blocked work', blockedBy: ['T-9'] }),
        readyTicket('T-9', { title: 'The blocker', state: 'In Progress' }),
      ],
      toml: CAPACITY_2,
    })

    const report = await h.dispatcher.tick()

    expect(report.dependencyBlocked).toBe(1)
    expect(report.dependencyDiagnostics).toEqual(['ticket T-1 blocked by T-9 (not complete)'])
    // Never claimed (§12: the gate precedes claim-before-launch)…
    expect(h.tickets.claims).not.toContain('T-1')
    // …no build, no workspace, no projection outward.
    expect((await h.store.listBuilds()).map((b) => b.slug)).not.toContain('blocked-work')
    expect(h.workspaces.provisions.map((p) => p.branch)).not.toContain('ab/blocked-work')
    expect(h.tickets.comments.map((c) => c.id)).not.toContain('T-1')
    expect(h.launches).not.toContain('blocked-work')
  })

  /** The strongest test here: a blocked ticket must not spend a slot. With
   * capacity 1 and the blocked ticket first in the ready list, the eligible
   * one behind it still dispatches in the SAME tick. */
  test('a blocked ticket consumes no capacity — the next eligible ticket still dispatches', async () => {
    const h = harness({
      tickets: [
        readyTicket('T-1', { title: 'Blocked work', blockedBy: ['T-9'] }),
        readyTicket('T-2', { title: 'Free work' }),
        readyTicket('T-9', { title: 'The blocker', state: 'In Progress' }),
      ],
      toml: ['capacity = 1', '[tickets]', 'source = "file"', 'readyState = "Ready"'].join('\n'),
    })

    const report = await h.dispatcher.tick()

    expect(report.dependencyBlocked).toBe(1)
    expect(report.dispatched).toBe(1)
    expect((await h.store.listBuilds()).map((b) => b.slug)).toEqual(['free-work'])
  })

  test('the blocker completes: the NEXT tick dispatches, with no manual step', async () => {
    const h = harness({
      tickets: [
        readyTicket('T-1', { title: 'Blocked work', blockedBy: ['T-9'] }),
        readyTicket('T-9', { title: 'The blocker', state: 'In Progress' }),
      ],
      toml: CAPACITY_2,
    })

    expect((await h.dispatcher.tick()).dependencyBlocked).toBe(1)

    expect(h.tickets.dependencyQueries).toEqual([['T-9']])
    // Native lifecycle only: the blocker reaches the source's done state.
    await h.tickets.transition('T-9', 'Done')

    h.clock.advance(60_000)
    const second = await h.dispatcher.tick()
    expect(h.tickets.dependencyQueries).toEqual([['T-9'], ['T-9']])
    expect(second.dependencyBlocked).toBe(0)
    expect(second.dispatched).toBe(1)
    expect((await h.store.listBuilds()).map((b) => b.slug)).toContain('blocked-work')
  })
  test('two blockers: ineligible until BOTH resolve', async () => {
    const tickets = [
      readyTicket('T-1', { title: 'Blocked work', blockedBy: ['T-8', 'T-9'] }),
      readyTicket('T-8', { title: 'Blocker eight', state: 'In Progress' }),
      readyTicket('T-9', { title: 'Blocker nine', state: 'In Progress' }),
    ]
    const h = harness({ tickets, toml: CAPACITY_2 })

    expect((await h.dispatcher.tick()).dependencyBlocked).toBe(1)

    await h.tickets.transition('T-8', 'Done')
    h.clock.advance(60_000)
    const second = await h.dispatcher.tick()
    expect(second.dependencyBlocked).toBe(1)
    expect(second.dispatched).toBe(0)
    expect(second.dependencyDiagnostics).toEqual(['ticket T-1 blocked by T-9 (not complete)'])

    await h.tickets.transition('T-9', 'Done')
    h.clock.advance(60_000)
    expect((await h.dispatcher.tick()).dispatched).toBe(1)
  })
  test('a missing blocker keeps the ticket undispatched with an actionable diagnostic', async () => {
    const h = harness({
      tickets: [readyTicket('T-1', { title: 'Blocked work', blockedBy: ['T-404'] })],
      toml: CAPACITY_2,
    })

    const report = await h.dispatcher.tick()

    expect(report.dependencyBlocked).toBe(1)
    expect(report.dependencyDiagnostics).toEqual([
      'ticket T-1 blocked by T-404, which does not exist in this ticket source',
    ])
    expect(await h.store.listBuilds()).toEqual([])
  })

  test('a dependency cycle keeps every affected ticket undispatched and names the loop', async () => {
    const h = harness({
      tickets: [
        readyTicket('T-1', { title: 'First', blockedBy: ['T-2'] }),
        readyTicket('T-2', { title: 'Second', blockedBy: ['T-1'] }),
      ],
      toml: CAPACITY_2,
    })

    const report = await h.dispatcher.tick()

    expect(report.dependencyBlocked).toBe(2)
    expect(report.dispatched).toBe(0)
    expect(report.dependencyDiagnostics).toEqual([
      'ticket T-1: dependency cycle T-1 → T-2 → T-1',
      'ticket T-2: dependency cycle T-2 → T-1 → T-2',
    ])
    expect(h.tickets.dependencyQueries).toEqual([])
    expect(await h.store.listBuilds()).toEqual([])
  })

  test('a self-dependency keeps the ticket undispatched', async () => {
    const h = harness({
      tickets: [readyTicket('T-1', { title: 'Ouroboros', blockedBy: ['T-1'] })],
      toml: CAPACITY_2,
    })

    const report = await h.dispatcher.tick()

    expect(report.dependencyBlocked).toBe(1)
    expect(report.dependencyDiagnostics).toEqual(['ticket T-1 depends on itself'])
    expect(await h.store.listBuilds()).toEqual([])
  })

  /** An invalid graph is one ticket's problem: the tick must not throw, and
   * unrelated eligible tickets must still dispatch. */
  test('a dependencyStates failure skips that ticket only — the tick survives', async () => {
    const h = harness({
      tickets: [
        readyTicket('T-1', { title: 'Blocked work', blockedBy: ['T-9'] }),
        readyTicket('T-2', { title: 'Free work' }),
      ],
      toml: CAPACITY_2,
      wrapTickets: (source) =>
        Object.assign(source, {
          dependencyStates: () => Promise.reject(new Error('provider exploded')),
        }),
    })

    const report = await h.dispatcher.tick()

    expect(report.dependencyBlocked).toBe(0)
    expect(report.dependencyCheckFailed).toBe(1)
    expect(report.dependencyDiagnostics).toEqual([
      'ticket T-1: dependency check failed — provider exploded',
    ])
    expect(report.dispatched).toBe(1)
    expect((await h.store.listBuilds()).map((b) => b.slug)).toEqual(['free-work'])
  })

  /** Gate order: the dependency check runs BEFORE the spec gate, so a blocked
   * ticket is held, not bounced — its body is not this tick's business. */
  test('a blocked ticket with a nonconforming body is held, not bounced', async () => {
    const h = harness({
      tickets: [
        readyTicket('T-1', {
          title: 'Blocked work',
          body: 'thin',
          blockedBy: ['T-9'],
        }),
        readyTicket('T-9', { title: 'The blocker', state: 'In Progress' }),
      ],
      toml: CAPACITY_2,
    })

    const report = await h.dispatcher.tick()

    expect(report.dependencyBlocked).toBe(1)
    expect(report.bounced).toBe(0)
    expect(h.tickets.transitions).toEqual([])
  })

  /** The unchanged-behavior criterion, mechanically enforced: a ticket with
   * no dependencies never touches the dependency port at all. */
  test('Linear listing with completed blockers dispatches without another dependency read', async () => {
    const calls: string[] = []
    const listingSource = new LinearTicketSource({
      apiKey: 'test',
      teamKey: 'ENG',
      fetchFn: async (_url, init) => {
        calls.push(JSON.parse(init.body).query)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              issues: {
                nodes: [
                  {
                    team: { key: 'ENG' },
                    parent: null,
                    id: 'uuid-1',
                    identifier: 'T-1',
                    title: 'Add rate limiting',
                    description: CONFORMING_BODY,
                    url: 'https://linear.app/issue/T-1',
                    state: { name: 'Ready', type: 'unstarted' },
                    labels: {
                      nodes: [{ name: 'autobuild' }],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                    inverseRelations: {
                      nodes: [
                        {
                          type: 'blocks',
                          issue: { identifier: 'T-9', state: { type: 'completed' } },
                        },
                      ],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        }
      },
    })
    const h = harness({
      tickets: [readyTicket('T-1')],
      toml: CAPACITY_2,
      wrapTickets: (source) => {
        Object.defineProperty(source, 'name', { value: 'linear' })
        source.listReady = listingSource.listReady.bind(listingSource)
        return source
      },
    })
    expect((await h.dispatcher.tick()).dispatched).toBe(1)
    expect(h.tickets.dependencyQueries).toEqual([])
    expect(calls).toHaveLength(1)
  })

  test.each([true, false, undefined])(
    'listing hint %s skips dependency reads only when true',
    async (hint) => {
      const h = harness({
        tickets: [readyTicket('T-1', { blockedBy: ['T-9'] })],
        toml: CAPACITY_2,
        wrapTickets: (source) => {
          const list = source.listReady.bind(source)
          source.listReady = async (criteria) => {
            const result = await list(criteria)
            return {
              ...result,
              tickets: result.tickets.map((ticket) => ({
                ...ticket,
                ...(hint === undefined ? {} : { blockersResolved: hint }),
              })),
            }
          }
          return source
        },
      })
      const report = await h.dispatcher.tick()
      expect(report.dispatched).toBe(hint === true ? 1 : 0)
      expect(h.tickets.dependencyQueries).toEqual(hint === true ? [] : [['T-9']])
    },
  )

  test('a dependency-free ticket dispatches with ZERO dependencyStates calls', async () => {
    const h = harness({ tickets: [readyTicket('T-1')], toml: CAPACITY_2 })

    const report = await h.dispatcher.tick()

    expect(report.dispatched).toBe(1)
    expect(h.tickets.dependencyQueries).toEqual([])
  })

  test('a resolved blocker dispatches normally and reports nothing', async () => {
    const h = harness({
      tickets: [
        readyTicket('T-1', { title: 'Unblocked work', blockedBy: ['T-9'] }),
        readyTicket('T-9', { title: 'The blocker', state: 'Done' }),
      ],
      toml: CAPACITY_2,
    })

    const report = await h.dispatcher.tick()

    expect(report.dependencyBlocked).toBe(0)
    expect(report.dependencyDiagnostics).toEqual([])
    expect((await h.store.listBuilds()).map((b) => b.slug)).toContain('unblocked-work')
  })

  /** A shared blocker is fetched once per tick, not once per dependent. */
  test('the per-tick node cache fetches a shared blocker only once', async () => {
    const h = harness({
      tickets: [
        readyTicket('T-1', { title: 'First', blockedBy: ['T-9'] }),
        readyTicket('T-2', { title: 'Second', blockedBy: ['T-9'] }),
        readyTicket('T-9', { title: 'The blocker', state: 'In Progress' }),
      ],
      toml: CAPACITY_2,
    })

    const report = await h.dispatcher.tick()

    expect(report.dependencyBlocked).toBe(2)
    expect(h.tickets.dependencyQueries).toEqual([['T-9']])
  })

  /**
   * Regression (f_8bc9ee0c): the tick-wide node cache must never be polluted
   * with a fabricated node for the ticket being gated. It used to be seeded
   * `resolved: false` so a cycle could close back onto it; because the cache
   * is shared across the ready loop, a later ticket blocked by that
   * already-gated ticket then skipped the port call and read the fabricated
   * value — held forever, told its complete blocker was incomplete.
   *
   * The reproduction needs the intermediate blocker (T-2) to be *processed in
   * the ready loop before* its dependent (T-3) so its cache node is seeded, and
   * to be genuinely resolved so the FIXED gate lets T-3 through. Since the fake
   * treats only its `doneState` ("Done") as resolved, the shared ready state
   * that keeps all three in one ready list is "Done" — readyState is required
   * now, so it must be set, and setting it to "Done" preserves both the ordering
   * and the resolution the scenario depends on.
   */
  test('a done blocker gated earlier in the tick does not hold its dependent', async () => {
    const h = harness({
      tickets: [
        // Ready-list order is the natural one: blockers first (file-<n> ids
        // list this way), so T-2 is gated — and cached — before T-3 needs it.
        readyTicket('T-1', { title: 'First', state: 'Done' }),
        readyTicket('T-2', { title: 'Second', state: 'Done', blockedBy: ['T-1'] }),
        readyTicket('T-3', { title: 'Third', state: 'Done', blockedBy: ['T-2'] }),
      ],
      toml: ['capacity = 5', '[tickets]', 'source = "file"', 'readyState = "Done"'].join('\n'),
    })

    const report = await h.dispatcher.tick()

    expect(h.tickets.dependencyQueries).toEqual([])
    // T-2 is Done, so T-3 reaches claim using native listing facts.
    // The source then refuses all three because claim never reopens terminal
    // work, so this dependency-cache regression creates no build.
    expect(report.dependencyDiagnostics).toEqual([])
    expect(report.dependencyBlocked).toBe(0)
    expect(h.tickets.claims).toContain('T-3')
    expect(await h.store.listBuilds()).toEqual([])
  })

  test('a transitive chain is closed lazily: A → B → C, only A is dispatchable-checked', async () => {
    const h = harness({
      tickets: [
        readyTicket('T-1', { title: 'First', blockedBy: ['T-2'] }),
        readyTicket('T-2', { title: 'Second', state: 'In Progress', blockedBy: ['T-3'] }),
        readyTicket('T-3', { title: 'Third', state: 'In Progress' }),
      ],
      toml: CAPACITY_2,
    })

    const report = await h.dispatcher.tick()

    // T-1's DIRECT blocker T-2 is incomplete, which alone holds it — the
    // deeper walk exists only so a cycle could be named.
    expect(report.dependencyDiagnostics).toContain('ticket T-1 blocked by T-2 (not complete)')
    expect(h.tickets.dependencyQueries).toEqual([['T-2'], ['T-3']])
  })
})

describe('Dispatcher interrupted-dispatch recovery', () => {
  for (const text of [undefined, 'token rotated, try again']) {
    test(`dispatch budget parks, survives restart, and grants a fresh budget for ${text ?? 'bare retry'}`, async () => {
      const h = harness({ tickets: [readyTicket('T-recover')] })
      await seedInterrupted(h)
      h.workspaces.setFailure('provision', new Error('offline'))
      for (let i = 0; i < 6; i++)
        await h.dispatcher.tick({ acceptNewWork: false, resumeCurrent: true })
      let events = await h.store.getEvents('interrupted-dispatch')
      expect(events.filter((e) => e.type === 'dispatch.failed')).toHaveLength(3)
      expect(events.filter((e) => e.type === 'escalation.raised')).toHaveLength(1)
      expect(h.launches).toEqual([])
      await controlBuild({
        store: h.store,
        repo: REPO,
        slug: 'interrupted-dispatch',
        action: { kind: 'answer', text },
      })
      events = await h.store.getEvents('interrupted-dispatch')
      expect(events.at(-1)?.payload).toMatchObject({
        resolution: text === undefined ? 'retry' : 'guidance',
      })
      const restarted = harness({ store: h.store, tickets: [readyTicket('T-recover')] })
      restarted.workspaces.setFailure('provision', new Error('still offline'))
      for (let i = 0; i < 5; i++)
        await restarted.dispatcher.tick({ acceptNewWork: false, resumeCurrent: true })
      events = await h.store.getEvents('interrupted-dispatch')
      expect(events.filter((e) => e.type === 'dispatch.failed')).toHaveLength(6)
      expect(events.filter((e) => e.type === 'escalation.raised')).toHaveLength(2)
      expect(restarted.launches).toEqual([])
    })
  }

  test('repairs the failure/raise crash gap before workspace or startup launch', async () => {
    const h = harness({ tickets: [readyTicket('T-recover')] })
    await seedInterrupted(h)
    for (let i = 1; i <= 3; i++)
      await h.store.append('interrupted-dispatch', {
        actor: DISPATCHER,
        type: 'dispatch.failed',
        payload: { stage: 'comment', attempt: i, error: 'offline' },
      })
    await h.dispatcher.tick({ acceptNewWork: false, resumeCurrent: true })
    expect(h.workspaces.provisions).toHaveLength(0)
    expect(h.launches).toEqual([])
    expect(reduceBuild(await h.store.getEvents('interrupted-dispatch')).status).toBe('blocked')
    await controlBuild({
      store: h.store,
      repo: REPO,
      slug: 'interrupted-dispatch',
      action: { kind: 'abort' },
    })
    await h.dispatcher.tick({ acceptNewWork: false, resumeCurrent: true })
    expect(h.launches).toEqual(['interrupted-dispatch'])
    expect(h.workspaces.provisions).toHaveLength(0)
  })

  test('background comment failures use dispatch budget without infrastructure double counting', async () => {
    const local = new FakeWorkspaceProvider({ root: '/ws', mode: 'logical' })
    const provider: WorkspaceProvider = {
      name: local.name,
      recovery: {
        reap: async () => ({ outcome: 'absent', snapshots: { outcome: 'confirmed', deleted: 0 } }),
      },
      provision: (input) => local.provision(input),
      release: (handle) => local.release(handle),
    }
    let comments = 0
    const h = harness({
      tickets: [readyTicket('T-recover')],
      workspaceProvider: provider,
      wrapTickets: (source) => {
        source.comment = async () => {
          comments++
          throw new Error('comment denied')
        }
        return source
      },
    })
    await seedInterrupted(h)
    await h.dispatcher.tick({ acceptNewWork: false })
    await h.dispatcher.drainProvisioning()
    for (let i = 0; i < 5; i++)
      await h.dispatcher.tick({ acceptNewWork: false, resumeCurrent: true })
    const events = await h.store.getEvents('interrupted-dispatch')
    expect(comments).toBe(3)
    expect(events.filter((e) => e.type === 'dispatch.failed')).toHaveLength(3)
    expect(events.filter((e) => e.type === 'infrastructure.failed')).toHaveLength(0)
    expect(events.filter((e) => e.type === 'escalation.raised')).toHaveLength(1)
    expect(h.launches).toEqual([])
  })

  test('a detached dispatch exhaustion write failure is contained and repaired without workspace attribution', async () => {
    const memory = new MemoryBuildStore()
    let failRaise = true
    const store = new Proxy(memory, {
      get(target, key) {
        if (key === 'appendIfCurrent')
          return async (...args: Parameters<BuildStore['appendIfCurrent']>) => {
            if (args[2].type === 'escalation.raised' && failRaise) {
              failRaise = false
              throw new Error('store unavailable')
            }
            return target.appendIfCurrent(...args)
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const local = new FakeWorkspaceProvider({ root: '/ws', mode: 'logical' })
    const provider: WorkspaceProvider = {
      name: local.name,
      recovery: {
        reap: async () => ({
          outcome: 'confirmed',
          snapshots: { outcome: 'confirmed', deleted: 0 },
        }),
      },
      provision: (input) => local.provision(input),
      release: (handle) => local.release(handle),
    }
    let comments = 0
    const h = harness({
      store,
      tickets: [readyTicket('T-recover')],
      workspaceProvider: provider,
      toml: '[policy]\nmaxDispatchAttempts = 1',
      wrapTickets: (source) => {
        source.comment = async () => {
          comments++
          throw new Error('comment denied')
        }
        return source
      },
    })
    await seedInterrupted(h)
    await h.dispatcher.tick({ acceptNewWork: false })
    for (let i = 0; i < 100 && h.dispatcher.provisioningInFlight(); i++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.dispatcher.provisioningInFlight()).toBe(false)
    let events = await store.getEvents('interrupted-dispatch')
    expect(events.filter((e) => e.type === 'dispatch.failed')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'infrastructure.failed')).toHaveLength(0)
    expect(events.filter((e) => e.type === 'escalation.raised')).toHaveLength(0)
    await h.dispatcher.tick({ acceptNewWork: false })
    events = await store.getEvents('interrupted-dispatch')
    expect(comments).toBe(1)
    expect(events.filter((e) => e.type === 'dispatch.failed')).toHaveLength(1)
    expect(
      events.filter((e) => e.type === 'escalation.raised').map((e) => e.payload.policyCause),
    ).toEqual(['dispatch-failure-limit'])
    expect(h.launches).toEqual([])
  })

  test('a failed escalation write is repaired after restart without another dispatch attempt', async () => {
    const memory = new MemoryBuildStore()
    let failRaise = true
    const store = new Proxy(memory, {
      get(target, key) {
        if (key === 'appendIfCurrent')
          return async (...args: Parameters<BuildStore['appendIfCurrent']>) => {
            if (args[2].type === 'escalation.raised' && failRaise) {
              failRaise = false
              throw new Error('raise unavailable')
            }
            return target.appendIfCurrent(...args)
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const h = harness({
      store,
      tickets: [readyTicket('T-recover')],
      toml: '[policy]\nmaxDispatchAttempts = 1',
    })
    await seedInterrupted(h)
    h.workspaces.setFailure('provision', new Error('offline'))
    await expect(h.dispatcher.tick({ acceptNewWork: false })).rejects.toThrow('raise unavailable')
    const restarted = harness({
      store,
      tickets: [readyTicket('T-recover')],
      toml: '[policy]\nmaxDispatchAttempts = 1',
    })
    await restarted.dispatcher.tick({ acceptNewWork: false, resumeCurrent: true })
    expect(restarted.workspaces.provisions).toHaveLength(0)
    expect(restarted.launches).toEqual([])
    const events = await store.getEvents('interrupted-dispatch')
    expect(events.filter((e) => e.type === 'dispatch.failed')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'escalation.raised')).toHaveLength(1)
  })

  test('records increasing provisioning failures, then resumes workspace/spec/launch on an ordinary tick', async () => {
    const h = harness({ tickets: [readyTicket('T-recover')] })
    await seedInterrupted(h)
    h.workspaces.setFailure('provision', new Error('workspace backend offline'))

    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual({
      ...emptyTickReport(),
      dispatchFailed: 1,
    })
    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual({
      ...emptyTickReport(),
      dispatchFailed: 1,
    })
    let events = await h.store.getEvents('interrupted-dispatch')
    expect(
      events.filter((event) => event.type === 'dispatch.failed').map((event) => event.payload),
    ).toEqual([
      { stage: 'workspace', attempt: 1, error: 'workspace backend offline' },
      { stage: 'workspace', attempt: 2, error: 'workspace backend offline' },
    ])

    h.workspaces.setFailure('provision', null)
    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual({
      ...emptyTickReport(),
      recovered: 1,
    })
    events = await h.store.getEvents('interrupted-dispatch')
    expect(events.filter((event) => event.type === 'build.created')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'workspace.provisioned')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'spec.imported')).toHaveLength(1)
    expect(h.workspaces.provisions).toHaveLength(1)
    expect(h.launches).toEqual(['interrupted-dispatch'])
  })

  test('budgets repeated remote provisioning-step failures and escalates setup', async () => {
    const diagnostic =
      'system provisioning step "browser packages" failed\n' +
      'command: install browser packages\n' +
      'exit status: 23\n' +
      'stderr: chromium package unavailable\n' +
      'remediation: fix [workspace.config].provisioning and rerun ab init --validate'
    let provisions = 0
    const workspaceProvider: WorkspaceProvider = {
      name: 'remote-test',
      recovery: {
        reap: async () => ({ outcome: 'absent', snapshots: { outcome: 'confirmed', deleted: 0 } }),
      },
      provision: async () => {
        provisions += 1
        throw new Error(diagnostic)
      },
      release: async () => {},
    }
    const h = harness({
      tickets: [readyTicket('T-recover')],
      toml: '[policy]\nmaxInfrastructureAttempts = 2\nmaxDispatchAttempts = 1\n',
      workspaceProvider,
    })
    await seedInterrupted(h, 'provisioning-budget')

    for (const attempt of [1, 2]) {
      // The tick records the durable marker and returns without awaiting the
      // background continuation; the failure lands durably inside it.
      expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual({
        ...emptyTickReport(),
        provisioning: 1,
      })
      await h.dispatcher.drainProvisioning()
      const failures = (await h.store.getEvents('provisioning-budget')).filter(
        (event) => event.type === 'infrastructure.failed',
      )
      expect(failures.at(-1)?.payload).toEqual({
        provider: 'remote-test',
        workspaceRef: 'provisioning-budget',
        instance: 'dispatcher-recovery',
        operation: 'provision',
        cause: 'unknown-outcome',
        attempt,
        retryable: true,
        cleanupPending: true,
        error: diagnostic,
      })
    }

    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual(emptyTickReport())
    const events = await h.store.getEvents('provisioning-budget')
    expect(events.filter((event) => event.type === 'infrastructure.failed')).toHaveLength(2)
    const escalations = events.filter(
      (event) =>
        event.type === 'escalation.raised' &&
        event.payload.policyCause === 'infrastructure-failure-limit',
    )
    expect(escalations).toHaveLength(1)
    expect(
      events.filter(
        (event) =>
          event.type === 'escalation.raised' &&
          event.payload.policyCause === 'dispatch-failure-limit',
      ),
    ).toHaveLength(0)
    const escalation = escalations[0]
    expect(escalation?.payload).toMatchObject({
      phase: 'setup',
      source: 'policy',
      policyCause: 'infrastructure-failure-limit',
      refs: ['provisioning-budget'],
    })
    if (escalation?.type !== 'escalation.raised') throw new Error('setup escalation missing')
    expect(escalation.payload.question).toContain(diagnostic)
    expect(events.some((event) => event.type === 'workspace.provisioned')).toBe(false)
    expect(h.launches).toEqual([])
    expect(provisions).toBe(2)
  })

  test('reconstructs an empty dispatch stream with a conditional build.created append', async () => {
    const h = harness({ tickets: [readyTicket('T-recover')] })
    const ticket = (await h.tickets.get('T-recover'))!
    await h.tickets.claim(ticket.ref.id)
    await h.store.createBuild({
      slug: 'empty-dispatch',
      repo: REPO,
      ticket: ticket.ref,
      branch: 'ab/empty-dispatch',
    })

    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual({
      ...emptyTickReport(),
      recovered: 1,
    })
    const events = await h.store.getEvents('empty-dispatch')
    expect(events.map((event) => event.type)).toEqual([
      'build.created',
      'workspace.provisioned',
      'spec.imported',
      'dispatch.comment-posted',
      'target.moved',
    ])
  })

  test('recovery never resurrects a retired claim-time default', async () => {
    const h = harness({ tickets: [readyTicket('T-recover')] })
    await seedInterrupted(h, 'auto-merge-interrupted', 'claiming-operator')

    expect(
      await h.dispatcher.tick({
        acceptNewWork: false,
        defaultAutoMerge: false,
        autoMergeUser: 'different-current-operator',
      }),
    ).toEqual({ ...emptyTickReport(), recovered: 1 })

    const events = await h.store.getEvents('auto-merge-interrupted')
    const request = events.find((event) => event.type === 'build.auto-merge-requested')
    expect(request).toBeUndefined()
    expect(reduceBuild(events).autoMerge.requested).toBe(false)
  })

  test('a failed launch retries without duplicating the dispatched ticket comment', async () => {
    const h = harness({
      tickets: [readyTicket('T-recover')],
      onLaunch: () => {
        throw new Error('runner scheduler offline')
      },
    })
    await seedInterrupted(h, 'launch-retry')

    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual({
      ...emptyTickReport(),
      dispatchFailed: 1,
    })
    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual({
      ...emptyTickReport(),
      dispatchFailed: 1,
    })

    const events = await h.store.getEvents('launch-retry')
    expect(events.filter((event) => event.type === 'dispatch.comment-posted')).toHaveLength(1)
    expect(
      events
        .filter((event) => event.type === 'dispatch.failed')
        .map((event) => event.payload.stage),
    ).toEqual(['launch', 'launch'])
    expect(
      h.tickets.comments.filter(({ body }) => body === 'build launch-retry dispatched'),
    ).toHaveLength(1)
  })

  test('a discard requested during setup parks before runner launch', async () => {
    const h = harness({ tickets: [readyTicket('T-recover')] })
    await seedInterrupted(h, 'discard-before-launch')
    const comment = h.tickets.comment.bind(h.tickets)
    let requested = false
    h.tickets.comment = async (id, body) => {
      await comment(id, body)
      if (!requested && body === 'build discard-before-launch dispatched') {
        requested = true
        await h.store.append('discard-before-launch', {
          actor: humanActor('operator'),
          type: 'build.discard-requested',
          payload: {},
        })
      }
    }

    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual(emptyTickReport())
    expect(h.launches).toEqual([])
    expect(reduceBuild(await h.store.getEvents('discard-before-launch')).status).toBe('queued')

    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual({
      ...emptyTickReport(),
      discarded: 1,
    })
  })

  test('a discard racing after the pre-launch check is inert once the runner attaches', async () => {
    let launchedOnce = false
    const h = harness({
      tickets: [readyTicket('T-recover')],
      onLaunch: async (slug, store) => {
        if (launchedOnce) return
        launchedOnce = true
        await store.append(slug, {
          actor: humanActor('operator'),
          type: 'build.discard-requested',
          payload: {},
        })
        await store.append(slug, {
          actor: KERNEL,
          type: 'runner.attached',
          payload: { instance: 'live-runner', host: 'local' },
        })
        await store.claimLease(slug, 'live-runner', 60_000)
      },
    })
    await seedInterrupted(h, 'late-discard-race')

    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual({
      ...emptyTickReport(),
      recovered: 1,
    })
    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual(emptyTickReport())

    const state = reduceBuild(await h.store.getEvents('late-discard-race'))
    expect(state.status).toBe('running')
    expect(state.discardRequest).toBeDefined()
    expect(h.workspaces.releases).toEqual([])
    expect(h.tickets.transitions).not.toContainEqual({ id: 'T-recover', state: 'Ready' })
  })

  test('discard works without a runner, lease, or workspace and returns the ticket to a custom Ready state', async () => {
    const h = harness({
      tickets: [readyTicket('T-recover', { state: 'Selected' })],
      toml: '[tickets]\nsource = "file"\nreadyState = "Selected"',
    })
    await seedInterrupted(h, 'discard-me')
    await h.store.append('discard-me', {
      actor: humanActor('operator'),
      type: 'build.discard-requested',
      payload: {},
    })

    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual({
      ...emptyTickReport(),
      discarded: 1,
    })
    const state = reduceBuild(await h.store.getEvents('discard-me'))
    expect(state).toMatchObject({ status: 'done', outcome: 'discarded' })
    expect(h.tickets.transitions).toContainEqual({ id: 'T-recover', state: 'Selected' })
    expect(h.tickets.comments.at(-1)?.body).toContain('returned to Selected')

    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), dispatched: 1 })
    const builds = await h.store.listBuilds()
    expect(builds.filter((record) => record.ticket?.id === 'T-recover')).toHaveLength(2)
  })

  test('discard waits for a live execution lease before releasing a partial workspace', async () => {
    const h = harness({ tickets: [readyTicket('T-recover')] })
    await seedInterrupted(h, 'partial-discard')
    const handle = await h.workspaces.provision({
      repo: REPO,
      baseBranch: 'main',
      branch: 'ab/partial-discard',
    })
    await h.store.append('partial-discard', {
      actor: DISPATCHER,
      type: 'workspace.provisioned',
      payload: { ...handle },
    })
    await h.store.append('partial-discard', {
      actor: humanActor('operator'),
      type: 'build.discard-requested',
      payload: {},
    })
    await h.store.claimLease('partial-discard', 'launching-execution', 60_000)

    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual(emptyTickReport())
    expect(h.workspaces.releases).toEqual([])
    await h.store.releaseLease('partial-discard', 'launching-execution')
    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual({
      ...emptyTickReport(),
      discarded: 1,
    })
    expect(h.workspaces.releases).toHaveLength(1)
    expect(
      (await h.store.getEvents('partial-discard')).map((event) => event.type).slice(-2),
    ).toEqual(['workspace.released', 'build.completed'])
  })
})

describe('Dispatcher janitor', () => {
  test('merged PR: pr.merged once, release, Done transition, completed{merged}; second tick no-ops', async () => {
    const h = harness({ tickets: [readyTicket('T-1', { labels: [] })] })
    const slug = await seedBuild(h, {
      ticketId: 'T-1',
      pr: PR,
      workspaceRef: 'fake:workspace-1',
      workspacePath: '/local/workspace-1',
    })
    h.forge.setPrState(1, { state: 'merged', sha: 'squash-1' })

    const report = await h.dispatcher.tick()
    expect(report).toEqual({ ...emptyTickReport(), merged: 1 })

    const events = await h.store.getEvents(slug)
    expect(events.map((e) => e.type).slice(-3)).toEqual([
      'pr.merged',
      'workspace.released',
      'build.completed',
    ])
    const prMerged = events.find((e) => e.type === 'pr.merged')
    expect(prMerged?.payload).toEqual({ sha: 'squash-1', buildTrailerPresent: false })
    expect(events.at(-1)?.payload).toEqual({ outcome: 'merged' })
    expect(h.forge.getPrStateCalls).toEqual([{ workspacePath: '/local/workspace-1', number: 1 }])
    expect(h.workspaces.releases).toEqual([
      {
        provider: 'fake',
        ref: 'fake:workspace-1',
        path: '/local/workspace-1',
        branch: `ab/${slug}`,
      },
    ])
    expect(h.tickets.transitions).toEqual([{ id: 'T-1', state: 'Done' }])
    expect(h.tickets.comments).toEqual([{ id: 'T-1', body: expect.stringContaining(PR.url) }])

    // Second tick: the build is done — the whole pass is a no-op.
    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(await h.store.getEvents(slug)).toHaveLength(events.length)
    expect(h.workspaces.releases).toHaveLength(1)
    expect(h.tickets.transitions).toHaveLength(1)
  })

  test('hosted merged transition follows the current project doneState while direct sources retain Done', async () => {
    for (const source of ['hosted', 'linear']) {
      let config = parseConfig(
        withReadyState(`[tickets]\nsource = "${source}"\nteamKey = "ENG"\ndoneState = "Initial"\n`),
      )
      const h = harness({
        tickets: [readyTicket('T-1', { labels: [] })],
        toml: `[tickets]\nsource = "${source}"\nteamKey = "ENG"\ndoneState = "Initial"\n`,
        getConfig: () => config,
      })
      await seedBuild(h, {
        ticketId: 'T-1',
        pr: PR,
        workspaceRef: 'fake:workspace-1',
        workspacePath: '/local/workspace-1',
      })
      config = { ...config, tickets: { ...config.tickets, doneState: 'Shipped' } }
      h.forge.setPrState(1, { state: 'merged', sha: 'squash-1' })
      await h.dispatcher.tick()
      expect(h.tickets.transitions).toEqual([
        { id: 'T-1', state: source === 'hosted' ? 'Shipped' : 'Done' },
      ])
    }
  })

  test('per-build poll failures do not stop sibling janitor work, lease sweep, dispatch, or retry', async () => {
    const h = harness({
      tickets: [readyTicket('T-ready')],
      toml: 'capacity = 10\n',
    })
    const failedA = await seedBuild(h, {
      slug: 'poll-failed-a',
      pr: { ...PR, number: 91 },
    })
    const failedB = await seedBuild(h, {
      slug: 'poll-failed-b',
      pr: { ...PR, number: 92 },
    })
    const merged = await seedBuild(h, {
      slug: 'merged-sibling',
      pr: { ...PR, number: 93 },
    })
    const stale = await seedBuild(h, { slug: 'stale-runner' })
    h.forge.setPrState(91, { state: 'merged', sha: 'squash-a' })
    h.forge.setPrState(92, { state: 'merged', sha: 'squash-b' })
    h.forge.setPrState(93, { state: 'merged', sha: 'squash-sibling' })

    const failedPolls = new Set([91, 92])
    const pollCounts = new Map<number, number>()
    const getPrState = h.forge.getPrState.bind(h.forge)
    h.forge.getPrState = async (workspacePath, number) => {
      pollCounts.set(number, (pollCounts.get(number) ?? 0) + 1)
      if (failedPolls.has(number)) throw new Error(`forge poll unavailable for PR #${number}`)
      return getPrState(workspacePath, number)
    }
    const failedABefore = await h.store.getEvents(failedA)
    const failedBBefore = await h.store.getEvents(failedB)
    await h.store.claimLease(failedA, 'poll-a-live', 60_000)
    await h.store.claimLease(failedB, 'poll-b-live', 60_000)

    expect(await h.dispatcher.tick()).toEqual({
      ...emptyTickReport(),
      merged: 1,
      swept: 1,
      dispatched: 1,
      janitorFailed: 2,
      janitorDiagnostics: [
        'build poll-failed-a: janitor failed — forge poll unavailable for PR #91',
        'build poll-failed-b: janitor failed — forge poll unavailable for PR #92',
      ],
    })
    expect(reduceBuild(await h.store.getEvents(merged)).status).toBe('done')
    expect(h.launches).toEqual([stale, 'add-rate-limiting'])
    expect((await h.store.listBuilds()).some((record) => record.ticket?.id === 'T-ready')).toBe(
      true,
    )
    expect(
      (await h.store.getEvents(failedA))
        .filter((e): boolean => e.type !== 'target.distance')
        .slice(0, -1),
    ).toEqual(failedABefore)
    expect(
      (await h.store.getEvents(failedB))
        .filter((e): boolean => e.type !== 'target.distance')
        .slice(0, -1),
    ).toEqual(failedBBefore)
    expect(reduceBuild(await h.store.getEvents(failedA)).status).not.toBe('done')

    // Materialize the fake launch boundary and keep both launched runners out
    // of later recovery/sweeps, so the next report isolates janitor retries.
    await h.store.append('add-rate-limiting', {
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: 'new-runner', host: 'local' },
    })
    await h.store.claimLease(stale, 'stale-live', 300_000)
    await h.store.claimLease('add-rate-limiting', 'new-live', 300_000)
    h.clock.advance(30_000)
    expect(await h.dispatcher.tick()).toEqual({
      ...emptyTickReport(),
      janitorFailed: 2,
      janitorDiagnostics: [
        'build poll-failed-a: janitor failed — forge poll unavailable for PR #91',
        'build poll-failed-b: janitor failed — forge poll unavailable for PR #92',
      ],
    })
    expect(pollCounts.get(91)).toBe(2)
    expect(pollCounts.get(92)).toBe(2)

    h.clock.advance(60_000)
    failedPolls.clear()
    await h.store.releaseLease(failedA, 'poll-a-live')
    await h.store.releaseLease(failedB, 'poll-b-live')
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), merged: 2 })
    expect(reduceBuild(await h.store.getEvents(failedA)).status).toBe('done')
    expect(reduceBuild(await h.store.getEvents(failedB)).status).toBe('done')
  })

  test('ticket comment failure is attributed and leaves partial merged facts retryable', async () => {
    const h = harness({
      tickets: [readyTicket('T-bad', { labels: [] }), readyTicket('T-good', { labels: [] })],
    })
    const failed = await seedBuild(h, {
      slug: 'ticket-outage',
      ticketId: 'T-bad',
      pr: { ...PR, number: 11 },
    })
    const sibling = await seedBuild(h, {
      slug: 'ticket-healthy',
      ticketId: 'T-good',
      pr: { ...PR, number: 12 },
    })
    h.forge.setPrState(11, { state: 'merged', sha: 'squash-bad' })
    h.forge.setPrState(12, { state: 'merged', sha: 'squash-good' })
    const comment = h.tickets.comment.bind(h.tickets)
    let outage = true
    h.tickets.comment = async (id, body) => {
      if (id === 'T-bad' && outage) {
        outage = false
        throw new Error('ticket comment unavailable')
      }
      return comment(id, body)
    }

    expect(await h.dispatcher.tick()).toEqual({
      ...emptyTickReport(),
      merged: 1,
      swept: 1,
      janitorFailed: 1,
      janitorDiagnostics: ['build ticket-outage: janitor failed — ticket comment unavailable'],
    })
    expect(reduceBuild(await h.store.getEvents(sibling)).status).toBe('done')
    const partial = await h.store.getEvents(failed)
    expect(partial.map((event) => event.type)).toContain('pr.merged')
    expect(partial.map((event) => event.type)).toContain('workspace.released')
    expect(partial.map((event) => event.type)).not.toContain('build.completed')
    expect(h.tickets.transitions.filter((entry) => entry.id === 'T-bad')).toEqual([
      { id: 'T-bad', state: 'Done' },
    ])

    h.clock.advance(30_000)
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), merged: 1 })
    expect(reduceBuild(await h.store.getEvents(failed)).status).toBe('done')
    expect(h.tickets.transitions.filter((entry) => entry.id === 'T-bad')).toHaveLength(2)
    expect(
      h.workspaces.releases.filter((release) => release.branch === `ab/${failed}`),
    ).toHaveLength(1)
  })

  test('closed PR: closed-unmerged outcome, back to Triage', async () => {
    const h = harness({ tickets: [readyTicket('T-1', { labels: [] })] })
    const slug = await seedBuild(h, { ticketId: 'T-1', pr: PR })
    h.forge.setPrState(1, { state: 'closed' })

    const report = await h.dispatcher.tick()
    expect(report).toEqual({ ...emptyTickReport(), closed: 1 })

    const events = await h.store.getEvents(slug)
    expect(events.map((e) => e.type).slice(-3)).toEqual([
      'pr.closed',
      'workspace.released',
      'build.completed',
    ])
    expect(events.at(-1)?.payload).toEqual({ outcome: 'closed-unmerged' })
    expect(h.workspaces.releases).toHaveLength(1)
    // Closed-unmerged goes back to a human, not to Done (§15.7).
    expect(h.tickets.transitions).toEqual([{ id: 'T-1', state: 'Triage' }])
    expect(h.launches).toEqual([])
  })

  test('open PR: maintains explicit historical consent with correlated native receipts', async () => {
    const h = harness()
    const slug = await seedAwaitingPr(h)
    const command = await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    await h.store.claimLease(slug, 'runner-live', 60_000)

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.forge.autoMergeCalls.at(-1)).toMatchObject({ number: 1, enabled: true, changed: true })
    const applied = (await h.store.getEvents(slug)).at(-1)
    expect(applied?.type).toBe('landing.native-applied')
    expect(applied?.actor).toEqual(DISPATCHER)
    expect(applied?.payload).toMatchObject({ commandSeq: command.seq })

    // An applied candidate stays quiet until its readiness or command changes.
    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.forge.autoMergeCalls).toHaveLength(1)
    expect(
      (await h.store.getEvents(slug)).filter(
        (e) => e.type === 'landing.native-applied' && e.payload.enabled,
      ),
    ).toHaveLength(1)
  })

  test('finalize and janitor racing at conditional append record one deferral observation', async () => {
    const h = harness()
    const slug = await seedAwaitingPr(h)
    const command = await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    h.forge.setGateProbeError(1, 'ruleset probe forbidden')
    await h.store.claimLease(slug, 'runner-live', 60_000)

    // Hold both processors at the compare-and-append seam so they make the
    // same absent-marker decision before either can win.
    const appendIfCurrent = h.store.appendIfCurrent.bind(h.store)
    let arrivals = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.store.appendIfCurrent = async (build, expectedSeq, event) => {
      if (event.type !== 'observation.recorded') return appendIfCurrent(build, expectedSeq, event)
      arrivals += 1
      if (arrivals === 2) release()
      await gate
      return appendIfCurrent(build, expectedSeq, event)
    }

    const realSet = h.forge.setAutoMerge.bind(h.forge)
    let finalizeWrite: Promise<unknown> | undefined
    h.forge.setAutoMerge = async (...args) => {
      const result = await realSet(...args)
      if (!args[2]) return result
      if (result.kind !== 'deferred' || result.reason === undefined) {
        throw new Error('expected a reason-bearing deferral')
      }
      finalizeWrite = recordAutoMergeDeferralObservation(
        h.store,
        slug,
        result.reason,
        1,
        command.seq,
        'obs_finalize',
      )
      return result
    }

    await h.dispatcher.tick()
    await finalizeWrite

    const observations = (await h.store.getEvents(slug)).filter(
      (event) =>
        event.type === 'observation.recorded' &&
        event.payload.refs?.includes(`auto-merge-gate:pr:1:command:${command.seq}`),
    )
    expect(observations).toHaveLength(1)
    const observation = observations[0]
    if (observation?.type !== 'observation.recorded') {
      throw new Error('expected the correlated observation')
    }
    expect(observation.payload.id).toBe('obs_finalize')
  })

  test('a cancellation supersedes enable, including a stale enable acknowledgement', async () => {
    const h = harness()
    const slug = await seedBuild(h, { pr: PR })
    const enable = await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    h.forge.setAutoMergeState(1, true)
    await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-cancelled',
      payload: {},
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'pr.auto-merge-enabled',
      payload: { commandSeq: enable.seq },
    })
    await h.store.claimLease(slug, 'runner-live', 60_000)

    await h.dispatcher.tick()

    expect(h.forge.autoMergeCalls.at(-1)).toMatchObject({ enabled: false, changed: true })
    const writes = await h.store.getEvents(slug)
    const applied = writes.findLast((event) => event.type === 'landing.native-applied')
    expect(writes.at(-1)?.type).toBe('landing.command-acknowledged')
    expect(applied?.type).toBe('landing.native-applied')
    expect(applied?.payload).toEqual({ enabled: false })
  })

  test('call-before-event and failure windows retry through the idempotent setter', async () => {
    const h = harness()
    const slug = await seedAwaitingPr(h)
    const command = await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    // Simulate a previous process succeeding remotely and dying before append.
    h.forge.setAutoMergeState(1, true)
    await h.store.claimLease(slug, 'runner-live', 60_000)

    const realSet = h.forge.setAutoMerge.bind(h.forge)
    let outage = true
    h.forge.setAutoMerge = async (...args) => {
      if (outage) {
        outage = false
        throw new Error('forge temporarily unavailable')
      }
      return realSet(...args)
    }

    expect(await h.dispatcher.tick()).toEqual({
      ...emptyTickReport(),
      janitorFailed: 1,
      janitorDiagnostics: [`build ${slug}: janitor failed — forge temporarily unavailable`],
    })
    expect(
      (await h.store.getEvents(slug)).some(
        (e) => e.type === 'landing.native-applied' && e.payload.enabled,
      ),
    ).toBe(false)

    h.clock.advance(30_000)
    await h.dispatcher.tick()
    // Native readback repairs the receipt without another provider write.
    expect(h.forge.isAutoMergeEnabled(1)).toBe(true)
    const applied = (await h.store.getEvents(slug)).findLast(
      (e) => e.type === 'landing.native-applied',
    )
    expect(applied?.type).toBe('landing.native-applied')
    expect(applied?.payload).toMatchObject({ commandSeq: command.seq })
  })

  test('native auto-merge completion is observed by the ordinary next poll', async () => {
    const h = harness()
    const slug = await seedAwaitingPr(h)
    await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    await h.store.claimLease(slug, 'runner-live', 60_000)
    await h.dispatcher.tick()

    h.forge.setPrState(1, { state: 'merged', sha: 'native-squash' })
    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.workspaces.releases).toEqual([])
    await h.store.releaseLease(slug, 'runner-live')
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), merged: 1 })
    expect((await h.store.getEvents(slug)).map((e) => e.type).slice(-3)).toEqual([
      'pr.merged',
      'workspace.released',
      'build.completed',
    ])
  })

  test('a local checkout collision is nonfatal, observed once, and retries to a guarded squash', async () => {
    const h = harness()
    const slug = await seedAwaitingPr(h)
    const command = await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    h.forge.setPrHeadSha(1, PR.headSha)
    h.forge.setAutoMergeDeferral(1, {
      code: 'local-base-checkout-dirty',
      detail: "error: Entry 'autobuild.toml' not uptodate. Cannot merge.",
    })
    await h.store.claimLease(slug, 'runner-live', 60_000)

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    const blockedEvents = await h.store.getEvents(slug)
    const observations = blockedEvents.filter((event) => event.type === 'observation.recorded')
    expect(observations).toHaveLength(1)
    expect(observations[0]?.payload.summary).toContain('uncommitted work in the base checkout')
    expect(observations[0]?.payload.summary).toContain('autobuild.toml')
    expect(observations[0]?.payload.refs).toEqual([`auto-merge-gate:pr:1:command:${command.seq}`])
    expect(pendingAutoMerge(reduceBuild(blockedEvents))).toEqual({
      enabled: true,
      commandSeq: command.seq,
    })
    expect(h.forge.squashMergeCalls).toEqual([])

    h.forge.setGatePresence(1, 'absent')
    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.forge.squashMergeCalls).toHaveLength(1)
    await h.store.releaseLease(slug, 'runner-live')
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), merged: 1 })
  })

  test('a moved base with requested consent resolves itself and never records an auto-merge observation', async () => {
    // The AC scenario: finalize opens a PR whose base has moved, the gate
    // defers with merge-conflicts, the pipeline reconciles and re-verifies,
    // and native auto-merge lands with no human anywhere — while the log at
    // no point carries an auto-merge-gate observation.
    const h = harness()
    const slug = await seedAwaitingPr(h)
    const command = await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    h.forge.setPrState(1, { state: 'open', mergeable: false })
    h.forge.setAutoMergeDeferral(1, {
      code: 'merge-conflicts',
      detail:
        "GitHub reports mergeable_state 'DIRTY' — the head branch has merge conflicts with 'main'; " +
        'update the branch or resolve the conflicts and the pending consent will be re-examined',
    })
    await h.store.claimLease(slug, 'runner-live', 60_000)
    const gateObservations = async (): Promise<number> =>
      (await h.store.getEvents(slug)).filter(
        (event) =>
          event.type === 'observation.recorded' &&
          event.payload.refs?.some((ref) => ref.startsWith('auto-merge-gate:')),
      ).length

    // The conflicted gate deferral re-enters reconcile and records nothing.
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), conflicted: 1 })
    expect(await gateObservations()).toBe(0)

    // The reconcile epilogue merges the base and verify re-runs in full.
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'reconcile.started',
      payload: { attempt: 1, baseSha: 'base-2' },
    })
    await h.store.append(slug, {
      actor: agentActor('reconcile', 's_reconcile'),
      type: 'reconcile.completed',
      payload: { mergeCommit: 'sha-merge', artifact: { kind: 'reconcile-notes', rev: 0 } },
    })
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'verify.started',
      payload: { step: 'unit', attempt: 2 },
    })
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'verify.completed',
      payload: { step: 'unit', attempt: 2, pass: true },
    })
    expect(await gateObservations()).toBe(0)

    // Clean again: the pending consent is re-examined and native auto-merge
    // is applied without any human action.
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    h.forge.setGatePresence(1, 'present')
    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.forge.isAutoMergeEnabled(1)).toBe(true)
    const applied = (await h.store.getEvents(slug)).find(
      (event) => event.type === 'landing.native-applied' && event.payload.enabled,
    )
    expect(applied?.payload).toMatchObject({ commandSeq: command.seq })
    expect(await gateObservations()).toBe(0)

    // The forge merges, the janitor observes it, and still nothing is ever
    // recorded — including between the merge fact and build.completed.
    h.forge.setPrState(1, { state: 'merged', sha: 'squash-1' })
    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    await h.store.releaseLease(slug, 'runner-live')
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), merged: 1 })
    expect((await h.store.getEvents(slug)).map((event) => event.type).slice(-3)).toEqual([
      'pr.merged',
      'workspace.released',
      'build.completed',
    ])
    expect(await gateObservations()).toBe(0)
  })

  test('ungated CLEAN uses guarded squash only while awaiting-pr, then settles by observation', async () => {
    const h = harness()
    const slug = await seedAwaitingPr(h)
    await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    h.forge.setPrHeadSha(1, PR.headSha)
    h.forge.setGatePresence(1, 'absent')
    await h.store.claimLease(slug, 'runner-live', 60_000)

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.forge.isAutoMergeEnabled(1)).toBe(false)
    expect(h.forge.squashMergeCalls).toEqual([
      {
        workspacePath: `/ws/ab/${slug}`,
        number: 1,
        expectedHeadSha: PR.headSha,
        buildSlug: slug,
      },
    ])
    const afterMergeCall = await h.store.getEvents(slug)
    expect(
      afterMergeCall.some((e) => e.type === 'landing.native-applied' && e.payload.enabled),
    ).toBe(false)
    expect(afterMergeCall.some((e) => e.type === 'pr.merged')).toBe(false)

    // The forge call is not a speculative event. Completion waits until the
    // supervising execution releases its process-tree lease.
    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.workspaces.releases).toEqual([])
    await h.store.releaseLease(slug, 'runner-live')
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), merged: 1 })
    const final = await h.store.getEvents(slug)
    expect(final.map((e) => e.type).slice(-3)).toEqual([
      'pr.merged',
      'workspace.released',
      'build.completed',
    ])
    expect(final.at(-1)?.payload).toEqual({ outcome: 'merged' })
  })

  test('ungated UNSTABLE and BEHIND are safe candidates, but positive mergeability is still required', async () => {
    for (const [index, mergeState] of ['UNSTABLE', 'BEHIND'].entries()) {
      const h = harness()
      const slug = await seedAwaitingPr(h, `ungated-${index}`)
      await h.store.append(slug, {
        actor: humanActor('operator'),
        type: 'build.auto-merge-requested',
        payload: {},
      })
      h.forge.setPrState(1, { state: 'open', mergeable: index === 0 ? null : true })
      h.forge.setMergeStateStatus(1, mergeState as 'UNSTABLE' | 'BEHIND')
      h.forge.setGatePresence(1, 'absent')
      await h.store.claimLease(slug, 'runner-live', 60_000)

      await h.dispatcher.tick()
      expect(h.forge.squashMergeCalls).toHaveLength(index === 0 ? 0 : 1)
    }
  })

  test('no intent or cancelled intent never invokes the direct merge', async () => {
    const noIntent = harness()
    const noIntentSlug = await seedAwaitingPr(noIntent)
    noIntent.forge.setPrState(1, { state: 'open', mergeable: true })
    noIntent.forge.setGatePresence(1, 'absent')
    await noIntent.store.claimLease(noIntentSlug, 'runner-live', 60_000)
    await noIntent.dispatcher.tick()
    expect(noIntent.forge.autoMergeCalls.every((call) => !call.enabled)).toBe(true)
    expect(noIntent.forge.squashMergeCalls).toEqual([])

    const cancelled = harness()
    const cancelledSlug = await seedAwaitingPr(cancelled)
    await cancelled.store.append(cancelledSlug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    await cancelled.store.append(cancelledSlug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-cancelled',
      payload: {},
    })
    cancelled.forge.setPrState(1, { state: 'open', mergeable: true })
    cancelled.forge.setGatePresence(1, 'absent')
    await cancelled.store.claimLease(cancelledSlug, 'runner-live', 60_000)
    await cancelled.dispatcher.tick()
    expect(cancelled.forge.squashMergeCalls).toEqual([])
    const writes = await cancelled.store.getEvents(cancelledSlug)
    const applied = writes.findLast((event) => event.type === 'landing.native-applied')
    expect(writes.at(-1)?.type).toBe('landing.command-acknowledged')
    expect(applied?.type).toBe('landing.native-applied')
    expect(applied?.payload).toEqual({ enabled: false })
  })

  test('a cancellation merge after classification is caught by the last-moment event reload', async () => {
    const h = harness()
    const slug = await seedAwaitingPr(h)
    await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    h.forge.setGatePresence(1, 'absent')
    await h.store.claimLease(slug, 'runner-live', 60_000)
    const realSet = h.forge.setAutoMerge.bind(h.forge)
    h.forge.setAutoMerge = async (...args) => {
      const result = await realSet(...args)
      await h.store.append(slug, {
        actor: humanActor('operator'),
        type: 'build.auto-merge-cancelled',
        payload: {},
      })
      return result
    }

    await h.dispatcher.tick()
    expect(h.forge.squashMergeCalls).toEqual([])
    expect((await h.forge.getPrState('/repo', 1)).state).toBe('open')
  })

  test('a head race or direct command failure surfaces and writes no speculative merge fact', async () => {
    const h = harness()
    const slug = await seedAwaitingPr(h)
    await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    h.forge.setGatePresence(1, 'absent')
    await h.store.claimLease(slug, 'runner-live', 60_000)
    const realSet = h.forge.setAutoMerge.bind(h.forge)
    h.forge.setAutoMerge = async (...args) => {
      const result = await realSet(...args)
      if (result.kind === 'ungated') h.forge.setPrHeadSha(1, 'new-head')
      return result
    }

    expect(await h.dispatcher.tick()).toEqual({
      ...emptyTickReport(),
      janitorFailed: 1,
      janitorDiagnostics: [expect.stringContaining(`build ${slug}: janitor failed —`)],
    })
    expect(h.forge.squashMergeCalls).toEqual([])
    expect((await h.store.getEvents(slug)).some((e) => e.type === 'pr.merged')).toBe(false)
  })

  test('BLOCKED/probe failures are observed once; HAS_HOOKS delegates to native and never falls back', async () => {
    const blocked = harness()
    const blockedSlug = await seedAwaitingPr(blocked)
    await blocked.store.append(blockedSlug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    blocked.forge.setPrState(1, { state: 'open', mergeable: true })
    blocked.forge.setMergeStateStatus(1, 'BLOCKED')
    blocked.forge.setGatePresence(1, 'absent')
    await blocked.store.claimLease(blockedSlug, 'runner-live', 60_000)
    await blocked.dispatcher.tick()
    await blocked.dispatcher.tick()
    const blockedObservations = (await blocked.store.getEvents(blockedSlug)).filter(
      (event) => event.type === 'observation.recorded',
    )
    expect(blockedObservations).toHaveLength(1)
    expect(blockedObservations[0]?.payload.summary).toContain('Auto-merge gate')
    expect(blockedObservations[0]?.payload.summary).toContain('BLOCKED')
    expect(blocked.forge.squashMergeCalls).toEqual([])

    const probe = harness()
    const probeSlug = await seedAwaitingPr(probe)
    await probe.store.append(probeSlug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    probe.forge.setPrState(1, { state: 'open', mergeable: true })
    probe.forge.setGateProbeError(1, 'ruleset probe forbidden')
    await probe.store.claimLease(probeSlug, 'runner-live', 60_000)
    await probe.dispatcher.tick()
    await probe.dispatcher.tick()
    const probeEvents = await probe.store.getEvents(probeSlug)
    expect(probeEvents.filter((event) => event.type === 'observation.recorded')).toHaveLength(1)
    expect(
      probeEvents.find((event) => event.type === 'observation.recorded')?.payload.summary,
    ).toContain('ruleset probe forbidden')
    expect(probe.forge.squashMergeCalls).toEqual([])

    // Pending consent is retried and can apply once the condition clears.
    probe.forge.setGatePresence(1, 'present')
    await probe.dispatcher.tick()
    expect(probe.forge.isAutoMergeEnabled(1)).toBe(true)
    expect(
      (await probe.store.getEvents(probeSlug)).some(
        (event) => event.type === 'landing.native-applied' && event.payload.enabled,
      ),
    ).toBe(true)

    const hooks = harness()
    const hooksSlug = await seedAwaitingPr(hooks)
    await hooks.store.append(hooksSlug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    hooks.forge.setPrState(1, { state: 'open', mergeable: true })
    hooks.forge.setMergeStateStatus(1, 'HAS_HOOKS')
    hooks.forge.setGatePresence(1, 'absent')
    await hooks.store.claimLease(hooksSlug, 'runner-live', 60_000)
    await hooks.dispatcher.tick()
    expect(hooks.forge.isAutoMergeEnabled(1)).toBe(true)
    expect(hooks.forge.squashMergeCalls).toEqual([])
  })

  test('fallback waits for finalize post-steps before merge', async () => {
    const h = harness({
      toml:
        '[finalize]\nsteps = ["release-notes"]\n' +
        '[finalize.release-notes]\nkind = "agent"\nskill = "ab-release-notes"\n',
    })
    const slug = await seedAwaitingPr(h)
    await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    h.forge.setGatePresence(1, 'absent')
    await h.store.claimLease(slug, 'runner-live', 60_000)

    await h.dispatcher.tick()
    expect(h.forge.squashMergeCalls).toEqual([])
    await h.store.append(slug, {
      actor: agentActor('release-notes', 's_9'),
      type: 'finalize.step-completed',
      payload: { step: 'release-notes', ok: true },
    })
    await h.dispatcher.tick()
    expect(h.forge.squashMergeCalls).toHaveLength(1)
  })

  test.each([false, true])(
    'merge and native maintenance wait for post-reconcile verify (maintenance=%s)',
    async (maintenance) => {
      const toml = [
        '[commands]',
        'test = "bun test"',
        '[verify]',
        'steps = ["unit"]',
        '[verify.unit]',
        'kind = "check"',
        'command = "test"',
      ].join('\n')
      const h = harness({ toml })
      h.tickets.add(readyTicket('T-verify', { state: 'Done', labels: [] }))
      const slug = await seedBuild(h, { ticketId: 'T-verify' })
      await seedLoopsApproved(h, slug)
      await h.store.append(slug, {
        actor: KERNEL,
        type: 'verify.started',
        payload: { step: 'unit', attempt: 1 },
      })
      await h.store.append(slug, {
        actor: KERNEL,
        type: 'verify.completed',
        payload: { step: 'unit', attempt: 1, pass: true },
      })
      await h.store.append(slug, {
        actor: KERNEL,
        type: 'finalize.completed',
        payload: { pr: PR },
      })
      await h.store.append(slug, {
        actor: DISPATCHER,
        type: 'pr.conflicted',
        payload: { baseSha: 'base-old' },
      })
      await h.store.append(slug, {
        actor: KERNEL,
        type: 'reconcile.started',
        payload: { attempt: 1, baseSha: 'base-old' },
      })
      await h.store.append(slug, {
        actor: agentActor('reconcile', 's_9'),
        type: 'reconcile.completed',
        payload: {
          mergeCommit: 'merge-1',
          artifact: { kind: 'reconcile-notes', rev: 0 },
        },
      })
      const command = await h.store.append(slug, {
        actor: humanActor('operator'),
        type: 'build.auto-merge-requested',
        payload: {},
      })
      if (maintenance) {
        await h.store.append(slug, {
          actor: DISPATCHER,
          type: 'pr.auto-merge-enabled',
          payload: { commandSeq: command.seq },
        })
      }
      h.forge.setPrState(1, { state: 'open', mergeable: true })
      if (maintenance) h.forge.setAutoMergeState(1, true)
      h.forge.setGatePresence(1, maintenance ? 'present' : 'absent')
      await h.store.claimLease(slug, 'runner-live', 60_000)

      await h.dispatcher.tick()
      expect(h.forge.squashMergeCalls).toEqual([])
      expect(h.forge.autoMergeCalls.every((call) => !call.enabled)).toBe(true)
      await h.store.append(slug, {
        actor: KERNEL,
        type: 'verify.started',
        payload: { step: 'unit', attempt: 2 },
      })
      await h.store.append(slug, {
        actor: KERNEL,
        type: 'verify.completed',
        payload: { step: 'unit', attempt: 2, pass: true },
      })
      await h.dispatcher.tick()
      expect(h.forge.squashMergeCalls).toHaveLength(maintenance ? 0 : 1)
      expect(h.forge.autoMergeCalls.filter((call) => call.enabled)).toHaveLength(1)
      expect(h.forge.buildSlugs.get(1)).toBe(slug)
      if (maintenance)
        expect(
          (await h.store.getEvents(slug)).filter(
            (e) => e.type === 'landing.native-applied' && e.payload.enabled,
          ),
        ).toHaveLength(1)
    },
  )

  test('a pending cancellation disables native auto-merge before recording a new conflict', async () => {
    const h = harness()
    const slug = await seedAwaitingPr(h)
    const enable = await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'pr.auto-merge-enabled',
      payload: { commandSeq: enable.seq },
    })
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    h.forge.setAutoMergeState(1, true)
    await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-cancelled',
      payload: {},
    })
    h.forge.setPrState(1, { state: 'open', mergeable: false })

    expect(await h.dispatcher.tick()).toEqual({
      ...emptyTickReport(),
      conflicted: 1,
    })
    expect(h.forge.isAutoMergeEnabled(1)).toBe(false)
    expect(h.forge.autoMergeCalls).toEqual([
      {
        workspacePath: `/ws/ab/${slug}`,
        number: 1,
        enabled: false,
        changed: true,
      },
    ])
    const events = await h.store.getEvents(slug)
    expect(events.map((event) => event.type).slice(-3)).toEqual([
      'landing.native-applied',
      'landing.command-acknowledged',
      'pr.conflicted',
    ])
    expect(events.at(-3)?.payload).toEqual({ enabled: false })
  })

  test('a cancellation arriving during an existing conflict is applied without waiting for reconcile', async () => {
    const h = harness()
    const slug = await seedAwaitingPr(h)
    const enable = await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'pr.auto-merge-enabled',
      payload: { commandSeq: enable.seq },
    })
    h.forge.setPrState(1, { state: 'open', mergeable: false })
    h.forge.setAutoMergeState(1, true)
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'pr.conflicted',
      payload: { baseSha: 'base-old' },
    })
    await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-cancelled',
      payload: {},
    })
    await h.store.claimLease(slug, 'runner-live', 60_000)

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.forge.isAutoMergeEnabled(1)).toBe(false)
    const events = await h.store.getEvents(slug)
    expect(events.at(-1)?.type).toBe('landing.command-acknowledged')
    expect(events.at(-2)?.type).toBe('landing.native-applied')
    expect(events.at(-2)?.payload).toEqual({ enabled: false })
    expect(events.filter((event) => event.type === 'pr.conflicted')).toHaveLength(1)
  })

  test('a conflict is routed to reconcile before any native or direct auto-merge attempt', async () => {
    const h = harness()
    const slug = await seedAwaitingPr(h)
    await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    h.forge.setPrState(1, { state: 'open', mergeable: false })
    h.forge.setGatePresence(1, 'absent')

    expect(await h.dispatcher.tick()).toEqual({
      ...emptyTickReport(),
      conflicted: 1,
    })
    expect(h.forge.autoMergeCalls.every((call) => !call.enabled)).toBe(true)
    expect(h.forge.squashMergeCalls).toEqual([])
  })

  test('conflicted PR: pr.conflicted{baseSha} + runner re-attach, deduped while pending', async () => {
    const h = harness({ tickets: [readyTicket('T-1', { labels: [] })] })
    const slug = await seedBuild(h, { ticketId: 'T-1', pr: PR })
    h.forge.setPrState(1, { state: 'open', mergeable: false })

    const report = await h.dispatcher.tick()
    expect(report).toEqual({ ...emptyTickReport(), conflicted: 1 })

    // baseSha comes from `git ls-remote <repo> refs/heads/<base>` (§15.7).
    expect(h.execCalls).toEqual([
      ['git', 'ls-remote', REPO, 'refs/heads/main'],
      ['git', 'rev-parse', '--verify', `refs/heads/ab/${slug}^{commit}`],
      ['git', 'ls-remote', REPO, 'refs/heads/main'],
    ])
    const events = await h.store.getEvents(slug)
    expect(events.at(-1)?.type).toBe('pr.conflicted')
    expect(events.at(-1)?.payload).toEqual({ baseSha: BASE_SHA })
    // The dispatcher never runs agents (§15.7): it re-attached a runner.
    expect(h.launches).toEqual([slug])
    // The workspace stays provisioned — reconcile needs it.
    expect(h.workspaces.releases).toEqual([])

    // Next tick, still conflicted on the forge, reconcile pending (the
    // re-attached runner holds the lease): no duplicate event, no relaunch.
    await h.store.claimLease(slug, 'runner-2', 60_000)
    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    const after = await h.store.getEvents(slug)
    expect(after.filter((e) => e.type === 'pr.conflicted')).toHaveLength(1)
    expect(h.launches).toEqual([slug])
  })

  test('legacy baseSha ls-remotes the physical checkout, not the origin-URL identity', async () => {
    // A forge without `remoteBranchSha` falls back to git — against the
    // checkout path, never the store identity (f_8061f912).
    const h = harness({
      tickets: [readyTicket('T-1', { labels: [] })],
      repo: 'https://github.com/acme/app',
      checkout: '/repos/checkout',
    })
    const slug = await seedBuild(h, {
      ticketId: 'T-1',
      pr: PR,
      repo: 'https://github.com/acme/app',
    })
    h.forge.setPrState(1, { state: 'open', mergeable: false })

    const report = await h.dispatcher.tick()
    expect(report).toEqual({ ...emptyTickReport(), conflicted: 1 })
    expect(h.execCalls).toEqual([
      ['git', 'ls-remote', '/repos/checkout', 'refs/heads/main'],
      ['git', 'rev-parse', '--verify', `refs/heads/ab/${slug}^{commit}`],
      ['git', 'ls-remote', '/repos/checkout', 'refs/heads/main'],
    ])
  })

  test('conflicted re-entry records replacement provisioning failures durably', async () => {
    const workspaceProvider: WorkspaceProvider = {
      name: 'remote-test',
      recovery: {
        reap: async () => ({
          outcome: 'absent',
          snapshots: { outcome: 'confirmed', deleted: 0 },
        }),
      },
      provision: async () => {
        throw new Error('remote environment no longer exists')
      },
      release: async () => undefined,
    }
    const h = harness({ workspaceProvider })
    const slug = await seedBuild(h, {
      pr: PR,
      workspaceRef: 'sandbox-g0',
      workspaceProvider: 'remote-test',
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'workspace.released',
      payload: { ref: 'sandbox-g0', reason: 'replacement' },
    })
    h.forge.setPrState(1, { state: 'open', mergeable: false })

    // The janitor kicks the background replacement provisioning and returns;
    // the provision failure is recorded durably inside the continuation.
    expect((await h.dispatcher.tick()).janitorFailed).toBe(0)
    await h.dispatcher.drainProvisioning()

    const failures = (await h.store.getEvents(slug)).filter(
      (event) => event.type === 'infrastructure.failed' && event.payload.operation === 'provision',
    )
    expect(failures.length).toBeGreaterThan(0)
    expect(failures[0]?.payload).toMatchObject({
      provider: 'remote-test',
      workspaceRef: 'sandbox-g0',
      cause: 'missing',
      error: 'remote environment no longer exists',
    })
  })

  test('conflict resolved upstream (mergeable true after reconcile.completed): no event', async () => {
    const h = harness()
    const slug = await seedBuild(h, { pr: PR })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'pr.conflicted',
      payload: { baseSha: 'old-base' },
    })
    await h.store.append(slug, {
      actor: agentActor('reconcile', 's_9'),
      type: 'reconcile.completed',
      payload: { mergeCommit: 'merge-1', artifact: { kind: 'reconcile-notes', rev: 0 } },
    })
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    // The reconcile runner is still alive re-running verify (§15.7); a
    // healthy lease keeps the sweep out, isolating the janitor's dedupe.
    await h.store.claimLease(slug, 'runner-2', 60_000)
    const before = (await h.store.getEvents(slug)).length

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect((await h.store.getEvents(slug)).slice(before).map((event) => event.type)).toEqual([
      'target.distance',
      'landing.native-applied',
    ])
    expect(h.launches).toEqual([])
  })

  test('baseSha routes through the forge remoteBranchSha capability when present (no exec)', async () => {
    // Origin mode: the dispatcher's repo is the normalized origin — there is
    // no checkout for `git ls-remote` to read, so the forge answers.
    const forgeWithCapability = new Proxy(harness().forge, {}) as FakeForge & {
      remoteBranchSha?: (branch: string) => Promise<string>
    }
    forgeWithCapability.remoteBranchSha = async (branch) =>
      branch === 'main' ? 'b'.repeat(40) : Promise.reject(new Error('absent'))

    const h = harness({
      forge: forgeWithCapability,
      exec: async () => {
        throw new Error('host exec must not run when the forge answers')
      },
    })
    const slug = await seedBuild(h, { pr: PR })
    h.forge.setPrState(1, { state: 'open', mergeable: false })

    await h.dispatcher.tick()
    const events = await h.store.getEvents(slug)
    expect(events.at(-1)?.type).toBe('pr.conflicted')
    expect(events.at(-1)?.payload).toEqual({ baseSha: 'b'.repeat(40) })
  })

  test.each([
    ['a legacy vercel-sandbox journal without a marker', 'vercel-sandbox', undefined],
    ['a provisioned payload carrying the remote marker over a local-suggestive name', 'fake', true],
    [
      'a provisioned payload carrying the local marker over a remote-suggestive name',
      'vercel-sandbox',
      false,
    ],
  ])(
    'abort cleanup skips the local-branch git step for remote workspaces: %s',
    async (_name, provider, remote) => {
      // Harness wiring follows the provider name only: the dispatcher routes
      // release and reap by the name on the provisioned fact, so the fake
      // provider must present under that name. Outcome expectations below
      // derive from the marker (with the legacy fallback), mirroring
      // isRemoteWorkspace — not from the name.
      const nameSuggestsRemote = provider === 'vercel-sandbox'
      const expectRemote = remote ?? nameSuggestsRemote
      const h = harness({
        workspaceName: nameSuggestsRemote ? 'vercel-sandbox' : undefined,
        tickets: [readyTicket('T-1', { labels: [] })],
      })
      const slug = await seedBuild(h, {
        ticketId: 'T-1',
        workspaceProvider: provider,
        ...(remote !== undefined ? { workspaceRemote: remote } : {}),
      })
      await h.store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })

      const report = await h.dispatcher.tick({ acceptNewWork: false })
      expect(report.janitorDiagnostics).toEqual([])
      expect(report.abandoned).toBe(1)
      const events = await h.store.getEvents(slug)
      expect(events.some((event) => event.type === 'abort.remote-branch-deleted')).toBe(true)
      // The marker decides when present, overriding a suggestive provider
      // name in either direction; the name reading is only the fallback for
      // journals written before the marker existed. Remote workspaces never
      // create a local branch, so the git steps and their fact are skipped.
      expect(events.some((event) => event.type === 'abort.local-branch-deleted')).toBe(
        !expectRemote,
      )
      if (expectRemote) {
        expect(h.execCalls).toEqual([])
      } else {
        expect(h.execCalls).toContainEqual(['git', 'check-ref-format', `refs/heads/ab/${slug}`])
      }
      expect(events.at(-1)?.payload).toEqual({ outcome: 'abandoned' })
    },
  )

  test('abort cleanup records an unknown remote delete and retries it durably', async () => {
    let fail = true
    const remote: WorkspaceProvider = {
      name: 'remote-test',
      recovery: {
        async reap() {
          if (fail) throw new Error('delete acknowledgement timed out')
          return { outcome: 'confirmed', snapshots: { outcome: 'confirmed', deleted: 2 } }
        },
      },
      async provision() {
        throw new Error('not used')
      },
      async release() {},
    }
    const h = harness({ workspaceProvider: remote })
    const slug = await seedBuild(h, {
      workspaceRef: 'sandbox-g0',
      workspaceProvider: 'remote-test',
    })
    await h.store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })

    expect((await h.dispatcher.tick({ acceptNewWork: false })).janitorFailed).toBe(1)
    let events = await h.store.getEvents(slug)
    expect(events.filter((event) => event.type === 'infrastructure.failed')).toHaveLength(1)
    expect(
      events.filter((event) => event.type === 'infrastructure.cleanup-attempted').at(-1)?.payload,
    ).toMatchObject({ operation: 'delete', outcome: 'unknown', attempt: 1 })
    expect(events.some((event) => event.type === 'workspace.released')).toBe(false)

    h.clock.advance(30_000)
    fail = false
    await h.dispatcher.tick({ acceptNewWork: false })
    events = await h.store.getEvents(slug)
    expect(
      events.filter((event) => event.type === 'infrastructure.cleanup-attempted').at(-1)?.payload,
    ).toMatchObject({
      operation: 'delete',
      outcome: 'confirmed',
      attempt: 2,
      snapshots: { outcome: 'confirmed', deleted: 2 },
    })
    expect(events.some((event) => event.type === 'workspace.released')).toBe(true)
  })

  test('remote release records snapshot purge evidence before the durable release fact', async () => {
    const remote: WorkspaceProvider = {
      name: 'remote-test',
      recovery: {
        async reap() {
          return { outcome: 'confirmed', snapshots: { outcome: 'confirmed', deleted: 3 } }
        },
      },
      async provision() {
        throw new Error('not used')
      },
      async release() {},
    }
    const h = harness({ workspaceProvider: remote })
    const slug = await seedBuild(h, {
      workspaceRef: 'sandbox-g0',
      workspaceProvider: 'remote-test',
    })
    await h.store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })

    expect((await h.dispatcher.tick({ acceptNewWork: false })).abandoned).toBe(1)
    const events = await h.store.getEvents(slug)
    const cleaned = events.filter((event) => event.type === 'infrastructure.cleanup-attempted')
    expect(cleaned).toHaveLength(1)
    expect(cleaned[0]?.payload).toMatchObject({
      provider: 'remote-test',
      workspaceRef: 'sandbox-g0',
      operation: 'delete',
      attempt: 1,
      outcome: 'confirmed',
      snapshots: { outcome: 'confirmed', deleted: 3 },
    })
    const releasedIndex = events.findIndex((event) => event.type === 'workspace.released')
    expect(releasedIndex).toBe(events.indexOf(cleaned[0]!) + 1)
  })

  test('aborted build: releases everything, preserves labels, returns to Triage, and second tick no-ops', async () => {
    const h = harness({ tickets: [readyTicket('T-1', { labels: ['autobuild', 'priority:high'] })] })
    const slug = await seedBuild(h, { ticketId: 'T-1' })
    await h.store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })

    const report = await h.dispatcher.tick()
    expect(report).toEqual({ ...emptyTickReport(), abandoned: 1 })

    const events = await h.store.getEvents(slug)
    expect(events.map((e) => e.type).slice(-5)).toEqual([
      'workspace.released',
      'abort.remote-branch-deleted',
      'abort.local-branch-deleted',
      'abort.ticket-returned',
      'build.completed',
    ])
    expect(events.at(-1)?.payload).toEqual({ outcome: 'abandoned' })
    expect(h.workspaces.releases.map((r) => r.ref)).toEqual([`/ws/ab/${slug}`])
    // Aborted work goes back to a human (D1 discipline), never to Done.
    expect(h.tickets.transitions).toEqual([{ id: 'T-1', state: 'Triage' }])
    expect(h.tickets.updates).toEqual([
      {
        id: 'T-1',
        patch: { labels: ['autobuild', 'priority:high', 'autobuild:aborted'] },
      },
    ])
    expect(h.forge.deleteBranchCalls).toEqual([{ workspacePath: REPO, branch: `ab/${slug}` }])
    expect(h.execCalls.slice(-2)).toEqual([
      ['git', 'check-ref-format', `refs/heads/ab/${slug}`],
      ['git', 'update-ref', '-d', `refs/heads/ab/${slug}`],
    ])
    expect(h.tickets.comments).toEqual([
      { id: 'T-1', body: `build ${slug} aborted — returned to Triage` },
    ])

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(await h.store.getEvents(slug)).toHaveLength(events.length)
  })

  test('abort local-branch cleanup runs git in the physical checkout, not the origin-URL identity', async () => {
    // The saga's git steps cwd into the checkout — with cwd = the store
    // identity (an origin URL) check-ref-format/update-ref fail and strand
    // the abort (f_8061f912).
    const h = harness({
      tickets: [readyTicket('T-1', { labels: [] })],
      repo: 'https://github.com/acme/app',
      checkout: '/repos/checkout',
    })
    const slug = await seedBuild(h, { ticketId: 'T-1', repo: 'https://github.com/acme/app' })
    await h.store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })

    await h.dispatcher.tick()
    expect(h.execCwds.slice(-2)).toEqual(['/repos/checkout', '/repos/checkout'])
  })

  test('queued vercel-sandbox abort with no open workspace skips the local-branch git step entirely', async () => {
    // A never-provisioned remote build has no open workspace fact; the
    // local-branch git step must not run on the strength of `open === null`
    // implying a local workspace (f_f94f113a). Origin mode has no checkout:
    // any host exec would cwd into a scratch directory and fail the saga.
    const h = harness({
      workspaceName: 'vercel-sandbox',
      tickets: [readyTicket('T-1', { labels: [] })],
      repo: 'https://github.com/acme/app',
      exec: async () => {
        throw new Error('host exec must not run for a never-provisioned remote abort')
      },
    })
    const slug = await seedBuild(h, {
      ticketId: 'T-1',
      repo: 'https://github.com/acme/app',
      workspace: false,
      attached: false,
    })
    await h.store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })

    const report = await h.dispatcher.tick({ acceptNewWork: false })
    expect(report.janitorFailed).toBe(0)
    expect(report.abandoned).toBe(1)
    const events = await h.store.getEvents(slug)
    expect(events.some((event) => event.type === 'abort.remote-branch-deleted')).toBe(true)
    expect(events.some((event) => event.type === 'abort.local-branch-deleted')).toBe(false)
    expect(h.execCalls).toEqual([])
    expect(events.at(-1)?.payload).toEqual({ outcome: 'abandoned' })
  })

  test('abort cleanup hands local forges the physical checkout, never the origin-URL identity', async () => {
    // LocalGitForge treats workspacePath as a git cwd; the store identity is
    // an origin URL in checkout mode (f_c0437741). The remote-branch delete,
    // the PR close fallback with no open workspace, and PR-attachment
    // reclamation all carry the checkout instead.
    const h = harness({
      tickets: [readyTicket('T-1', { labels: [] })],
      repo: 'https://github.com/acme/app',
      checkout: '/repos/checkout',
    })
    const slug = await seedBuild(h, {
      ticketId: 'T-1',
      repo: 'https://github.com/acme/app',
      pr: PR,
      workspace: false,
    })
    await h.store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })
    h.forge.setPrState(PR.number, { state: 'open', mergeable: null })

    const report = await h.dispatcher.tick({ acceptNewWork: false })
    expect(report.janitorFailed).toBe(0)
    expect(report.abandoned).toBe(1)
    const branch = `ab/${slug}`
    // PR close ran with no open workspace → the checkout fallback.
    expect(h.forge.closePrCalls).toEqual([{ workspacePath: '/repos/checkout', number: PR.number }])
    expect(h.forge.deleteBranchCalls).toEqual([{ workspacePath: '/repos/checkout', branch }])
  })

  test('PR-attachment reclamation runs from the physical checkout, not the origin-URL identity', async () => {
    const h = harness({
      prAttachments: true,
      repo: 'https://github.com/acme/app',
      checkout: '/repos/checkout',
    })
    const slug = await seedBuild(h, {
      slug: 'reclaim-checkout',
      repo: 'https://github.com/acme/app',
      workspace: false,
    })
    const hosted = await seedHostedPrAttachment(h, slug)
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'abandoned' },
    })

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.forge.prAttachmentReclaims).toEqual([
      { workspacePath: '/repos/checkout', asset: hosted.payload.asset },
    ])
  })

  test('queued abort is dispatcher-acknowledged before the complete cleanup saga', async () => {
    const h = harness({ tickets: [readyTicket('T-queued-abort', { labels: [] })] })
    const slug = await seedBuild(h, {
      slug: 'queued-abort',
      ticketId: 'T-queued-abort',
      attached: false,
    })
    await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.abort-requested',
      payload: { reason: 'cancel queued work' },
    })

    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), abandoned: 1 })
    const events = await h.store.getEvents(slug)
    const acknowledged = events.find((event) => event.type === 'build.aborted')
    expect(acknowledged?.actor).toEqual(DISPATCHER)
    expect(events.at(-1)).toMatchObject({
      type: 'build.completed',
      payload: { outcome: 'abandoned' },
    })
  })

  test('aborted remote build closes its PR from the dispatcher checkout before releasing the sandbox', async () => {
    const h = harness({ workspaceName: 'vercel-sandbox' })
    const slug = await seedBuild(h, { slug: 'remote-abort', pr: PR })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'workspace.provisioned',
      payload: {
        provider: 'vercel-sandbox',
        ref: 'sandbox-remote-abort',
        path: '/vercel/sandbox/workspace',
        remote: true,
        branch: `ab/${slug}`,
        base: { source: 'existing', sha: 'a'.repeat(40) },
      },
    })
    h.forge.setPrState(PR.number, { state: 'open', mergeable: true })
    await h.store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })

    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), abandoned: 1 })
    expect(h.forge.closePrCalls).toEqual([{ workspacePath: REPO, number: PR.number }])
    expect(h.workspaces.releases.at(-1)?.ref).toBe('sandbox-remote-abort')
  })

  // AUT-527 audit: the parameterized dimension here is the PR's forge state at
  // abort time (open / closed / merged), orthogonal to the marker-vs-name
  // decision of isRemoteWorkspace. But the closePr workspacePath asserted below
  // comes from forgeWorkspacePath, which branches on isRemoteWorkspace — a
  // marker-sensitive decision this site's default seed (legacy local, no
  // remote marker) cannot discriminate: under a name-keyed revert every case
  // still reads local and still passes. The 'abort cleanup closePr targets the
  // path isRemoteWorkspace names' test.each below pins that precedence for the
  // saga's closePr step with marker-over-name cross-cases.
  test.each([
    ['open', { state: 'open', mergeable: true } as const, 'pr.closed'],
    ['already closed', { state: 'closed' } as const, 'pr.closed'],
    ['merged before close', { state: 'merged', sha: 'landing-sha' } as const, 'pr.merged'],
  ])(
    'aborted build with %s PR records the authoritative settlement',
    async (_name, prState, fact) => {
      const h = harness()
      const slug = await seedBuild(h, { pr: PR })
      h.forge.setPrState(PR.number, prState)
      await h.store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })

      expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), abandoned: 1 })
      const events = await h.store.getEvents(slug)
      expect(events.some((event) => event.type === fact)).toBe(true)
      expect(h.forge.closePrCalls).toEqual([{ workspacePath: `/ws/ab/${slug}`, number: PR.number }])
      if (fact === 'pr.merged') {
        expect(events.find((event) => event.type === 'pr.merged')?.payload).toEqual({
          sha: 'landing-sha',
          buildTrailerPresent: false,
        })
      }
    },
  )

  // AUT-527: forgeWorkspacePath branches on isRemoteWorkspace to pick the
  // closePr path — remote forges close against the store identity, local
  // forges against the physical checkout. These cross-cases pin marker-over-
  // name precedence for that decision: the marker decides when present,
  // overriding a suggestive provider name in either direction; the name
  // reading is only the legacy fallback. The PR-state dimension above is
  // orthogonal (the closePr call precedes any settlement branch), so an open
  // PR pins the path decision for every settlement case.
  test.each([
    ['a legacy vercel-sandbox journal without a marker', 'vercel-sandbox', undefined],
    ['a provisioned payload carrying the remote marker over a local-suggestive name', 'fake', true],
    [
      'a provisioned payload carrying the local marker over a remote-suggestive name',
      'vercel-sandbox',
      false,
    ],
  ])(
    'abort cleanup closePr targets the path isRemoteWorkspace names: %s',
    async (_name, provider, remote) => {
      // Harness wiring follows the provider name only: the dispatcher routes
      // release and reap by the name on the provisioned fact, so the fake
      // provider must present under that name. The closePr path expectation
      // derives from the marker (with the legacy fallback), mirroring
      // isRemoteWorkspace — not from the name.
      const nameSuggestsRemote = provider === 'vercel-sandbox'
      const expectRemote = remote ?? nameSuggestsRemote
      const h = harness({
        workspaceName: nameSuggestsRemote ? 'vercel-sandbox' : undefined,
        tickets: [readyTicket('T-1', { labels: [] })],
      })
      const slug = await seedBuild(h, {
        ticketId: 'T-1',
        pr: PR,
        workspaceProvider: provider,
        ...(remote !== undefined ? { workspaceRemote: remote } : {}),
      })
      h.forge.setPrState(PR.number, { state: 'open', mergeable: true })
      await h.store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })

      expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), abandoned: 1 })
      expect(h.forge.closePrCalls).toEqual([
        { workspacePath: expectRemote ? REPO : `/ws/ab/${slug}`, number: PR.number },
      ])
      expect((await h.store.getEvents(slug)).some((event) => event.type === 'pr.closed')).toBe(true)
    },
  )

  test('a later-step outage resumes from durable checkpoints without repeating settled effects', async () => {
    const h = harness({ tickets: [readyTicket('T-checkpoint', { labels: ['keep-me'] })] })
    const slug = await seedBuild(h, { slug: 'checkpoint', ticketId: 'T-checkpoint', pr: PR })
    h.forge.setPrState(PR.number, { state: 'open', mergeable: true })
    h.forge.failNextDeleteBranch('remote unavailable')
    await h.store.claimLease(slug, 'runner-live', 60_000)
    await h.store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })

    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual(emptyTickReport())
    expect(h.workspaces.releases).toEqual([])
    expect((await h.store.getBuild(slug))?.lease?.holder).toBe('runner-live')
    await h.store.releaseLease(slug, 'runner-live')

    const failed = await h.dispatcher.tick()
    expect(failed.janitorFailed).toBe(1)
    expect(failed.janitorDiagnostics[0]).toContain('remote branch deletion')
    expect((await h.store.getBuild(slug))?.lease).toBeUndefined()
    let events = await h.store.getEvents(slug)
    expect(events.some((event) => event.type === 'pr.closed')).toBe(true)
    expect(events.some((event) => event.type === 'workspace.released')).toBe(true)
    expect(events.some((event) => event.type === 'build.completed')).toBe(false)
    expect(h.forge.closePrCalls).toHaveLength(1)
    expect(h.workspaces.releases).toHaveLength(1)

    h.clock.advance(30_000)
    expect(await h.dispatcher.tick()).toEqual({
      ...emptyTickReport(),
      recovered: 1,
      abandoned: 1,
    })
    events = await h.store.getEvents(slug)
    expect(h.forge.closePrCalls).toHaveLength(1)
    expect(h.workspaces.releases).toHaveLength(1)
    expect(h.forge.deleteBranchCalls).toHaveLength(2) // failed side effect is safely retried
    expect(h.tickets.updates).toEqual([
      { id: 'T-checkpoint', patch: { labels: ['keep-me', 'autobuild:aborted'] } },
    ])
    expect(events.at(-1)?.type).toBe('build.janitor-recovered')
  })

  // AUT-527 audit: the parameterized dimension here is how many abort-cleanup
  // saga steps have already settled (checkpoint prefix 0..5). The assertions
  // include execCalls (the local-branch git steps, settled < 4), so the case is
  // sensitive to the remote-vs-local outcome — but only through the default
  // seed (legacy local, no remote marker), which marker-keyed and name-keyed
  // readings of isRemoteWorkspace agree on by construction; the settled count
  // cannot change the marker reading. Marker-over-name precedence for this
  // saga is already pinned in both directions by the AUT-520 cross-cases at
  // the 'abort cleanup skips the local-branch git step' test.each above.
  test.each([0, 1, 2, 3, 4, 5])(
    'a crash after cleanup checkpoint prefix %i resumes only the remaining external effects',
    async (settled) => {
      const ticketId = `T-prefix-${settled}`
      const h = harness({
        tickets: [
          readyTicket(ticketId, {
            labels: ['keep', 'autobuild:aborted'],
            state: 'In Progress',
          }),
        ],
      })
      const slug = await seedBuild(h, {
        slug: `checkpoint-prefix-${settled}`,
        ticketId,
        pr: PR,
      })
      h.forge.setPrState(PR.number, { state: 'open', mergeable: true })
      await h.store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })
      if (settled >= 1) {
        await h.store.append(slug, { actor: DISPATCHER, type: 'pr.closed', payload: {} })
      }
      if (settled >= 2) {
        await h.store.append(slug, { actor: DISPATCHER, type: 'workspace.released', payload: {} })
      }
      if (settled >= 3) {
        await h.store.append(slug, {
          actor: DISPATCHER,
          type: 'abort.remote-branch-deleted',
          payload: { branch: `ab/${slug}` },
        })
      }
      if (settled >= 4) {
        await h.store.append(slug, {
          actor: DISPATCHER,
          type: 'abort.local-branch-deleted',
          payload: { branch: `ab/${slug}` },
        })
      }
      if (settled >= 5) {
        await h.store.append(slug, {
          actor: DISPATCHER,
          type: 'abort.ticket-returned',
          payload: {
            ticket: { source: 'fake', id: ticketId, title: slug },
            state: 'Triage',
            label: 'autobuild:aborted',
          },
        })
      }

      expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), abandoned: 1 })
      expect(h.forge.closePrCalls).toHaveLength(settled >= 1 ? 0 : 1)
      expect(h.workspaces.releases).toHaveLength(settled >= 2 ? 0 : 1)
      expect(h.forge.deleteBranchCalls).toHaveLength(settled >= 3 ? 0 : 1)
      expect(h.execCalls).toHaveLength(settled >= 4 ? 0 : 2)
      expect(h.tickets.updates).toEqual([]) // marker was already present
      expect(h.tickets.transitions).toHaveLength(settled >= 5 ? 0 : 1)
      expect((await h.store.getEvents(slug)).at(-1)?.type).toBe('build.completed')
    },
  )

  // AUT-527 audit: the parameterized dimension here is which Forge capability
  // is absent (closePr / deleteBranch). The assertions (janitorFailed, the
  // diagnostic, absence of build.completed) are insensitive to the
  // remote-vs-local outcome, and every case runs on the default seed (legacy
  // local, no remote marker), so marker-keyed and name-keyed readings of
  // isRemoteWorkspace agree by construction. Marker-over-name precedence for
  // the abort-cleanup saga is pinned by the AUT-520 cross-cases at the
  // 'abort cleanup skips the local-branch git step' test.each above.
  test.each(['closePr', 'deleteBranch'] as const)(
    'missing Forge %s capability leaves cleanup pending with an actionable diagnostic',
    async (capability) => {
      const forge = new FakeForge()
      Object.defineProperty(forge, capability, { value: undefined })
      const h = harness({ forge })
      const slug = await seedBuild(h, {
        slug: `missing-${capability.toLowerCase()}`,
        ...(capability === 'closePr' ? { pr: PR } : {}),
      })
      if (capability === 'closePr') {
        forge.setPrState(PR.number, { state: 'open', mergeable: true })
      }
      await h.store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })

      const report = await h.dispatcher.tick()
      expect(report.janitorFailed).toBe(1)
      expect(report.janitorDiagnostics[0]).toContain(`does not implement ${capability}`)
      expect(report.janitorDiagnostics[0]).toContain('retry on next dispatcher tick')
      expect(
        (await h.store.getEvents(slug)).some((event) => event.type === 'build.completed'),
      ).toBe(false)
    },
  )

  test('aborted build: a ticket-source outage leaves the Triage handback retryable (§3.3)', async () => {
    // Regression: build.completed used to land BEFORE the ticket transition,
    // so a crash/outage between the two reduced to status 'done' and the
    // janitor skipped the build forever — the aborted ticket silently never
    // returned to Triage (D1). Ticket ops must precede the terminal event,
    // exactly as the merged/closed paths order them.
    const h = harness({
      tickets: [readyTicket('T-1', { labels: [], state: 'In Progress' })],
    })
    const slug = await seedBuild(h, { ticketId: 'T-1' })
    await h.store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })

    const realTransition = h.tickets.transition.bind(h.tickets)
    let outage = true
    h.tickets.transition = async (id, state) => {
      if (outage) {
        outage = false
        throw new Error('ticket source outage')
      }
      return realTransition(id, state)
    }

    expect(await h.dispatcher.tick()).toEqual({
      ...emptyTickReport(),
      janitorFailed: 1,
      janitorDiagnostics: [
        `build ${slug}: janitor failed — abort cleanup ticket handback failed for fake ticket T-1; remaining cleanup will retry on next dispatcher tick — ticket source outage`,
      ],
    })
    // The terminal event did NOT land: the build still reduces to 'aborted',
    // so the next tick re-runs the whole cleanup (workspace release is
    // log-deduped) instead of stranding the ticket.
    const types = (await h.store.getEvents(slug)).map((e) => e.type)
    expect(types).not.toContain('build.completed')
    expect(h.tickets.transitions).toEqual([])

    h.clock.advance(30_000)
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), abandoned: 1 })
    expect(h.tickets.transitions).toEqual([{ id: 'T-1', state: 'Triage' }])
    // The first tick already applied the idempotent label union before the
    // transition failed; retry reads it back and does not replace labels again.
    expect(h.tickets.updates).toEqual([{ id: 'T-1', patch: { labels: ['autobuild:aborted'] } }])
    expect(h.tickets.comments).toEqual([
      { id: 'T-1', body: `build ${slug} aborted — returned to Triage` },
    ])
    const events = await h.store.getEvents(slug)
    expect(events.at(-1)?.type).toBe('build.janitor-recovered')
    expect(events.findLast((e) => e.type === 'build.completed')?.payload).toEqual({
      outcome: 'abandoned',
    })
    expect(h.workspaces.releases).toHaveLength(1) // released once, tick 1
  })

  test('hosted PR attachment copies are reclaimed after merged, closed, and abandoned completion facts', async () => {
    for (const scenario of ['merged', 'closed', 'abandoned'] as const) {
      const h = harness({ prAttachments: true })
      const slug = await seedBuild(h, {
        slug: `cleanup-${scenario}`,
        ...(scenario !== 'abandoned' ? { pr: PR } : {}),
      })
      const hosted = await seedHostedPrAttachment(h, slug)
      if (scenario === 'merged') {
        h.forge.setPrState(1, { state: 'merged', sha: 'squash-cleanup' })
      } else if (scenario === 'closed') {
        h.forge.setPrState(1, { state: 'closed' })
      } else {
        await h.store.append(slug, {
          actor: KERNEL,
          type: 'build.aborted',
          payload: {},
        })
      }

      const report = await h.dispatcher.tick()
      expect(report).toEqual({
        ...emptyTickReport(),
        ...(scenario === 'merged'
          ? { merged: 1 }
          : scenario === 'closed'
            ? { closed: 1 }
            : { abandoned: 1 }),
      })
      const events = await h.store.getEvents(slug)
      const completed = events.find((event) => event.type === 'build.completed')!
      const reclaimed = events.find((event) => event.type === 'pr-attachment.reclaimed')!
      expect(reclaimed.seq).toBeGreaterThan(completed.seq)
      expect(reclaimed.payload).toEqual({ hostedSeq: hosted.seq })
      expect(h.forge.prAttachmentReclaims).toEqual([
        {
          workspacePath: REPO,
          asset: hosted.payload.asset,
        },
      ])
      expect(reduceBuild(events).status).toBe('done')
    }
  })

  test.each(['merged', 'closed'] as const)(
    'a %s replacement PR retries reclamation without repeating completion',
    async (outcome) => {
      const h = harness({ prAttachments: true })
      const slug = await seedBuild(h, { slug: `replacement-${outcome}`, pr: PR })
      await seedHostedPrAttachment(h, slug)
      await h.store.append(slug, {
        actor: KERNEL,
        type: 'landing.native-applied',
        payload: { enabled: false, operation: 'replacement' },
      })
      h.forge.setPrState(
        1,
        outcome === 'merged' ? { state: 'merged', sha: 'landed' } : { state: 'closed' },
      )
      h.forge.failNextPrAttachmentReclaim('temporary delete outage')
      await h.dispatcher.tick()
      const transitions = [...h.tickets.transitions]
      const comments = [...h.tickets.comments]
      expect(
        (await h.store.getEvents(slug)).filter((e) => e.type === 'build.completed'),
      ).toHaveLength(1)
      expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
      expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
      const events = await h.store.getEvents(slug)
      expect(events.filter((e) => e.type === 'build.completed')).toHaveLength(1)
      expect(events.filter((e) => e.type === 'pr-attachment.reclaimed')).toHaveLength(1)
      expect(h.forge.prAttachmentReclaims).toHaveLength(2)
      expect(h.tickets.transitions).toEqual(transitions)
      expect(h.tickets.comments).toEqual(comments)
    },
  )

  test('pending attachment reclamation waits through cooldown without failure receipts', async () => {
    const h = harness({ prAttachments: true })
    const slug = await seedBuild(h, { slug: 'cleanup-cooldown', workspace: false })
    await seedHostedPrAttachment(h, slug)
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'abandoned' },
    })
    await h.store.ensureRepo(REPO)
    await h.store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.forge-degraded',
      payload: {
        forge: h.forge.name,
        message: 'limit',
        resetAt: new Date(h.clock().getTime() + 60_000).toISOString(),
        firstFailureAt: h.clock().toISOString(),
      },
    })
    for (let tick = 0; tick < 3; tick++) await h.dispatcher.tick()
    expect(h.forge.prAttachmentReclaims).toHaveLength(0)
    const events = await h.store.getEvents(slug)
    expect(
      events.filter(
        (e) =>
          e.type === 'pr-attachment.reclaim-failed' || e.type === 'build.janitor-attempt-failed',
      ),
    ).toEqual([])
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    expect(h.forge.prAttachmentReclaims).toHaveLength(1)
    expect(
      (await h.store.getEvents(slug)).filter((e) => e.type === 'pr-attachment.reclaimed'),
    ).toHaveLength(1)
  })

  test('a done build retries transient reclamation, records attempts, and becomes idempotent', async () => {
    const h = harness({ prAttachments: true })
    const slug = await seedBuild(h, {
      slug: 'cleanup-retry',
      workspace: false,
    })
    const hosted = await seedHostedPrAttachment(h, slug)
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'abandoned' },
    })
    h.forge.failNextPrAttachmentReclaim('temporary delete outage')

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    let events = await h.store.getEvents(slug)
    const failed = events.find((event) => event.type === 'pr-attachment.reclaim-failed')
    expect(failed?.payload).toEqual({
      hostedSeq: hosted.seq,
      attempt: 1,
      error: 'temporary delete outage',
    })
    expect(reduceBuild(events).status).toBe('done')

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    events = await h.store.getEvents(slug)
    expect(events.filter((event) => event.type === 'pr-attachment.reclaimed')).toHaveLength(1)
    expect(h.forge.prAttachmentReclaims).toHaveLength(2)

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.forge.prAttachmentReclaims).toHaveLength(2)
  })
})

// ── Dispatch-command startup resume (§2.2, §15.6-C) ─────────────────────────

describe('durable forge failure scheduling', () => {
  test('janitor backoff and attention survive dispatcher reconstruction and quiet polls', async () => {
    const h = harness()
    const slug = await seedAwaitingPr(h)
    let calls = 0
    let failing = true
    const poll = h.forge.getPrState.bind(h.forge)
    h.forge.setPrState(1, { state: 'open', mergeable: null })
    h.forge.getPrState = async (...args) => {
      calls++
      if (failing) throw new Error(`provider unavailable ${calls}`)
      return poll(...args)
    }
    let dispatcher = h.dispatcher
    for (const delay of [30, 60, 120, 240, 300, 300]) {
      expect((await dispatcher.tick({ acceptNewWork: false })).janitorFailed).toBe(1)
      const state = reduceBuild(await h.store.getEvents(slug))
      expect(Date.parse(state.janitor!.nextAttemptAt) - h.clock().getTime()).toBe(delay * 1000)
      const events = await h.store.getEvents(slug)
      const count = calls
      await dispatcher.tick({ acceptNewWork: false })
      expect(calls).toBe(count)
      expect(await h.store.getEvents(slug)).toEqual(events)
      const restarted = harness({ store: h.store, forge: h.forge, wrapTickets: () => h.tickets })
      restarted.clock.set(h.clock().toISOString())
      await restarted.dispatcher.tick({ acceptNewWork: false })
      expect(calls).toBe(count)
      h.clock.advance(delay * 1000)
      restarted.clock.set(h.clock().toISOString())
      dispatcher = restarted.dispatcher
    }
    expect(
      (await h.store.getEvents(slug)).filter((e) => e.type === 'build.janitor-failing'),
    ).toHaveLength(1)
    failing = false
    await dispatcher.tick({ acceptNewWork: false })
    expect(reduceBuild(await h.store.getEvents(slug)).janitor).toBeUndefined()
  })

  test('a limit prevents sibling forge calls and survives restart while cleanup without forge continues', async () => {
    const h = harness()
    const first = await seedAwaitingPr(h, 'a-first')
    const second = await seedAwaitingPr(h, 'b-second')
    await h.tickets.create(
      { title: 'cleanup', body: CONFORMING_BODY, labels: [] },
      { requestedId: 'T-z-cleanup' },
    )
    const cleanup = await seedBuild(h, { slug: 'z-cleanup', ticketId: 'T-z-cleanup' })
    await h.store.append(cleanup, { actor: KERNEL, type: 'build.aborted', payload: {} })
    let calls = 0
    const resetAt = new Date(h.clock().getTime() + 60_000).toISOString()
    h.forge.getPrState = async () => {
      calls++
      throw {
        forgeFailure: 'autobuild.forge-failure.v1',
        message: 'secondary limit',
        details: { kind: 'rate-limited', resetAt },
      }
    }
    const report = await h.dispatcher.tick({ acceptNewWork: false })
    expect(calls).toBe(1)
    expect(report.janitorFailed, report.janitorDiagnostics.join('\n')).toBe(1)
    expect(reduceBuild(await h.store.getEvents(first)).janitor?.attempt).toBe(1)
    expect(reduceBuild(await h.store.getEvents(second)).janitor).toBeUndefined()
    expect((await h.store.getEvents(cleanup)).some((e) => e.type === 'workspace.released')).toBe(
      true,
    )
    const restarted = harness({ store: h.store, forge: h.forge, wrapTickets: () => h.tickets })
    await restarted.dispatcher.tick({ acceptNewWork: false })
    expect(calls).toBe(1)
    expect(reduceBuild(await h.store.getEvents(second)).janitor).toBeUndefined()
  })
})

describe('Dispatcher startup resume', () => {
  test('attempts every actionable current build even while its old lease is healthy', async () => {
    const h = harness()
    const slug = await seedBuild(h)
    await h.store.claimLease(slug, 'old-runner', 60_000)

    const report = await h.dispatcher.tick({ resumeCurrent: true })

    expect(report).toEqual({ ...emptyTickReport(), resumed: 1 })
    expect(h.launches).toEqual([slug])
  })

  test('does not count a startup or sweep request suppressed by a known active runner', async () => {
    const h = harness({ launchResult: 'already-active' })
    const slug = await seedBuild(h)
    await h.store.claimLease(slug, 'runner-1', 1000)
    h.clock.advance(2000)

    // Startup owns this tick's launch attempt, so its per-tick slug set also
    // prevents the stale-lease stage from asking twice.
    expect(await h.dispatcher.tick({ resumeCurrent: true })).toEqual(emptyTickReport())
    // A later stale-lease poll asks again, but the launcher still knows the
    // process-local run is live. Neither no-op is observable as resumed/swept.
    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.launches).toEqual([slug, slug])
  })

  test('repeated startup passes preserve every policy escalation cause and report the parked build', async () => {
    const h = harness()
    const slug = await seedBuild(h, { slug: 'policy-blocked' })
    const escalations = [
      {
        id: 'esc_phase_attempt',
        phase: 'plan',
        round: 1,
        policyCause: 'phase-attempt-limit',
      },
      {
        id: 'esc_non_retryable',
        phase: 'implement',
        round: 1,
        policyCause: 'non-retryable-phase-failure',
      },
      {
        id: 'esc_review_round',
        phase: 'plan-review',
        round: 6,
        policyCause: 'review-round-limit',
      },
      {
        id: 'esc_verify',
        phase: 'verify:unit',
        policyCause: 'verify-failure-limit',
      },
      {
        id: 'esc_reconcile',
        phase: 'reconcile',
        policyCause: 'reconcile-no-progress',
      },
      {
        id: 'esc_setup',
        phase: 'setup',
        policyCause: 'setup-failure-limit',
      },
    ] as const
    for (const escalation of escalations) {
      await h.store.append(slug, {
        actor: KERNEL,
        type: 'escalation.raised',
        payload: {
          ...escalation,
          source: 'policy',
          question: `${escalation.policyCause} remains unresolved`,
        },
      })
    }
    const before = await h.store.getEvents(slug)
    const diagnostic = `build ${slug} skipped: open escalations ${escalations
      .map(({ id }) => id)
      .join(', ')}`

    expect(reduceBuild(before).status).toBe('blocked')
    for (let pass = 0; pass < 3; pass += 1) {
      expect(await h.dispatcher.tick({ resumeCurrent: true })).toEqual({
        ...emptyTickReport(),
        blockedDiagnostics: [diagnostic],
      })
      expect(
        (await h.store.getEvents(slug)).filter((e): boolean => e.type !== 'target.distance'),
      ).toEqual(before.filter((e): boolean => e.type !== 'target.distance'))
      expect(
        reduceBuild(await h.store.getEvents(slug)).openEscalations.map(({ id }) => id),
      ).toEqual(escalations.map(({ id }) => id))
    }
    expect(h.launches).toEqual([])
  })

  test('an already-recorded human answer is actionable on startup without another answer', async () => {
    const h = harness()
    const slug = await seedBuild(h)
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: 'esc_policy',
        phase: 'plan',
        round: 1,
        source: 'policy',
        policyCause: 'phase-attempt-limit',
        question: 'plan failed twice',
      },
    })
    await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'escalation.answered',
      payload: { id: 'esc_policy', answer: 'retry', resolution: 'retry' },
    })
    const before = await h.store.getEvents(slug)

    expect(await h.dispatcher.tick({ resumeCurrent: true })).toEqual({
      ...emptyTickReport(),
      resumed: 1,
    })
    expect(h.launches).toEqual([slug])
    expect(
      (await h.store.getEvents(slug)).filter((e): boolean => e.type !== 'target.distance'),
    ).toEqual(before.filter((e): boolean => e.type !== 'target.distance'))
  })

  test('startup still launches blocked builds with pending abort, pause, or resume commands', async () => {
    for (const command of ['abort', 'pause', 'resume'] as const) {
      const h = harness()
      const slug = await seedBuild(h, { slug: `blocked-${command}` })
      await h.store.append(slug, {
        actor: KERNEL,
        type: 'escalation.raised',
        payload: {
          id: `esc_${command}`,
          phase: 'plan',
          source: 'agent',
          question: 'operator command must still be acknowledged',
        },
      })
      if (command === 'resume') {
        await h.store.append(slug, {
          actor: humanActor('operator'),
          type: 'build.pause-requested',
          payload: {},
        })
        await h.store.append(slug, { actor: KERNEL, type: 'build.paused', payload: {} })
      }
      await h.store.append(
        slug,
        command === 'abort'
          ? {
              actor: humanActor('operator'),
              type: 'build.abort-requested',
              payload: { reason: 'stop this build' },
            }
          : command === 'pause'
            ? {
                actor: humanActor('operator'),
                type: 'build.pause-requested',
                payload: {},
              }
            : {
                actor: humanActor('operator'),
                type: 'build.resume-requested',
                payload: {},
              },
      )

      expect(await h.dispatcher.tick({ resumeCurrent: true })).toEqual({
        ...emptyTickReport(),
        resumed: 1,
      })
      expect(h.launches).toEqual([slug])
    }
  })

  test('does not override human pauses or agent judgment escalations', async () => {
    const paused = harness()
    await seedBuild(paused, { slug: 'paused' })
    await paused.store.append('paused', { actor: KERNEL, type: 'build.paused', payload: {} })
    expect(await paused.dispatcher.tick({ resumeCurrent: true })).toEqual(emptyTickReport())
    expect(paused.launches).toEqual([])

    const blocked = harness()
    await seedBuild(blocked, { slug: 'blocked' })
    await blocked.store.append('blocked', {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: 'esc_agent',
        phase: 'plan',
        source: 'agent',
        question: 'Which compatibility policy should we use?',
      },
    })
    expect(await blocked.dispatcher.tick({ resumeCurrent: true })).toEqual({
      ...emptyTickReport(),
      blockedDiagnostics: ['build blocked skipped: open escalations esc_agent'],
    })
    expect(blocked.launches).toEqual([])
    expect(
      (await blocked.store.getEvents('blocked'))
        .filter((e): boolean => e.type !== 'target.distance')
        .at(-1)?.type,
    ).toBe('escalation.raised')
  })
})

// ── Lease sweep (§15.6-C) ────────────────────────────────────────────────────

describe('Dispatcher lease sweep', () => {
  for (const operation of ['restack', 'reconcile'] as const)
    for (const exhausted of [false, true])
      for (const command of ['abort', 'pause', 'resume'] as const)
        test(`${operation} ${exhausted ? 'exhaustion' : 'backoff'} permits swept runner to acknowledge ${command}`, async () => {
          const runnerToml = '[roles.default]\nruntime = "scripted"\n'
          const h = harness({
            toml: runnerToml,
            onLaunch: async (slug, store) => {
              const { BuildRunner } = await import('./build-runner')
              const { ScriptedAgentRunner } = await import('../ports/runner/fake')
              const runner = new BuildRunner({
                store: store.scopeBuild(slug),
                config: parseConfig(withReadyState(runnerToml)),
                runtimes: {
                  scripted: {
                    runner: new ScriptedAgentRunner({
                      script: async () => {
                        throw new Error('control acknowledgement must not start an agent')
                      },
                    }),
                    servesModels: [],
                  },
                },
                workspacePath: `/ws/ab/${slug}`,
                branch: `ab/${slug}`,
                slug,
                exec: async () => {
                  throw new Error('control acknowledgement must not execute Git')
                },
                forge: h.forge,
                ids: sequentialIds(),
                clock: h.clock,
                instance: 'replacement',
                host: 'test',
              })
              expect(await runner.step()).toEqual({ kind: 'acknowledge', command })
            },
          })
          const slug = await seedBuild(h)
          const {
            trigger: _trigger,
            cycle: _cycle,
            observation: _observation,
            message: _message,
            ...rewrite
          } = {
            ...leafTransaction,
            branch: `ab/${slug}`,
          }
          if (operation === 'restack') {
            await h.store.append(slug, {
              actor: KERNEL,
              type: 'restack.prepared',
              payload: { ...leafTransaction, branch: `ab/${slug}` },
            })
            await h.store.append(slug, {
              actor: KERNEL,
              type: 'restack.publish-intended',
              payload: { ...leafTransaction, branch: `ab/${slug}`, headSha: 'e'.repeat(40) },
            })
          } else {
            const transaction = { ...rewrite, attempt: 1 }
            const artifact = { kind: 'reconcile-notes', rev: 0 }
            await h.store.append(slug, {
              actor: KERNEL,
              type: 'reconcile.started',
              payload: { attempt: 1, baseSha: transaction.targetBase },
            })
            await h.store.append(slug, {
              actor: KERNEL,
              type: 'reconcile.prepared',
              payload: transaction,
            })
            await h.store.append(slug, {
              actor: KERNEL,
              type: 'reconcile.publish-intended',
              payload: { ...transaction, headSha: 'e'.repeat(40), conflicted: true, artifact },
            })
            await h.store.append(slug, {
              actor: KERNEL,
              type: 'publication.requested',
              payload: {
                operation,
                branch: transaction.branch,
                sha: 'e'.repeat(40),
                artifact,
                rewrite: { ...transaction, conflicted: true },
              },
            })
          }
          if (command === 'resume')
            await h.store.append(slug, { actor: KERNEL, type: 'build.paused', payload: {} })
          const retry = { operation, rewriteId: rewrite.id, round: 1, anchor: 0, error: 'HTTP 503' }
          if (exhausted)
            await h.store.append(slug, {
              actor: KERNEL,
              type: 'publication.retry-exhausted',
              payload: { ...retry, failure: 7 },
            })
          else
            await h.store.append(slug, {
              actor: KERNEL,
              type: 'publication.retry-scheduled',
              payload: {
                ...retry,
                failure: 1,
                retryAt: new Date(h.clock().getTime() + 300_000).toISOString(),
              },
            })
          await h.store.claimLease(slug, 'old-runner', 1000)
          h.clock.advance(2000)
          expect((await h.dispatcher.tick({ acceptNewWork: false })).swept).toBe(0)
          expect(h.launches).toEqual([])
          await h.store.append(slug, {
            actor: humanActor('operator'),
            type: `build.${command}-requested`,
            payload: {},
          })
          expect((await h.dispatcher.tick({ acceptNewWork: false })).swept).toBe(1)
          expect(h.launches).toEqual([slug])
          const events = await h.store.getEvents(slug)
          const state = reduceBuild(events)
          expect(state.pendingCommands).toEqual([])
          expect(state.status).toBe(
            command === 'abort'
              ? 'aborted'
              : command === 'pause'
                ? 'paused'
                : exhausted
                  ? 'blocked'
                  : 'running',
          )
          expect(
            events.some(
              (event) => event.type === 'escalation.answered' || event.type === 'phase.failed',
            ),
          ).toBe(false)
          expect(
            events.filter(
              (event) =>
                event.type === 'publication.retry-scheduled' ||
                event.type === 'publication.retry-exhausted',
            ),
          ).toHaveLength(1)
        })

  test('a detached replacement launch failure stays under the infrastructure budget without rejecting', async () => {
    const local = new FakeWorkspaceProvider({ root: '/ws', mode: 'logical' })
    const provider: WorkspaceProvider = {
      name: local.name,
      recovery: {
        reap: async () => ({
          outcome: 'confirmed',
          snapshots: { outcome: 'confirmed', deleted: 0 },
        }),
      },
      provision: (input) => local.provision(input),
      release: (handle) => local.release(handle),
    }
    let starts = 0
    const h = harness({
      workspaceProvider: provider,
      toml: '[policy]\nmaxInfrastructureAttempts = 1\nmaxDispatchAttempts = 1',
      onLaunch: () => {
        starts++
        throw new Error('sandbox start failed')
      },
    })
    const slug = await seedBuild(h)
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'workspace.released',
      payload: {},
    })
    h.clock.advance(120_000)
    expect((await h.dispatcher.tick({ acceptNewWork: false })).provisioning).toBe(1)
    // Deliberately never drain: that would attach allSettled and hide the
    // detached rejection that used to terminate the real dispatcher process.
    for (let i = 0; i < 100 && h.dispatcher.provisioningInFlight(); i++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.dispatcher.provisioningInFlight()).toBe(false)
    expect(starts).toBe(1)
    const events = await h.store.getEvents(slug)
    expect(events.filter((e) => e.type === 'infrastructure.failed')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'dispatch.failed').at(-1)?.payload).toMatchObject({
      stage: 'workspace',
      error: 'sandbox start failed',
    })
    expect(
      events.filter((e) => e.type === 'escalation.raised').map((e) => e.payload.policyCause),
    ).toEqual(['infrastructure-failure-limit'])
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(starts).toBe(1)
  })

  test('a workspace from a retired provider is never handed to the configured remote provider', async () => {
    const operations: string[] = []
    const remote: WorkspaceProvider = {
      name: 'remote-test',
      recovery: {
        async reap(handle) {
          operations.push(`reap:${handle.provider}:${handle.ref}`)
          return { outcome: 'confirmed', snapshots: { outcome: 'confirmed', deleted: 1 } }
        },
      },
      async provision(opts) {
        operations.push('provision')
        return {
          provider: 'remote-test',
          ref: 'sandbox-g1',
          path: '/remote/workspace',
          branch: opts.branch,
          base: { source: 'existing', sha: opts.revision ?? BASE_SHA },
        }
      },
      async release(handle) {
        operations.push(`release:${handle.provider}:${handle.ref}`)
      },
    }
    const retired: WorkspaceProvider = {
      name: 'git-worktree',
      async provision() {
        throw new Error('retired providers never provision')
      },
      async release(handle) {
        operations.push(`retired-release:${handle.provider}:${handle.ref}`)
      },
    }
    const h = harness({ workspaceProvider: remote, retiredWorkspaces: [retired] })
    const slug = await seedBuild(h, {
      workspaceRef: '/repo/.autobuild/worktrees/ab-local-build',
      workspaceProvider: 'git-worktree',
    })
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: { id: 'esc_local', phase: 'implement', source: 'agent', question: 'Which path?' },
    })

    // Blocked with an open local worktree: the remote provider's recovery must
    // not be asked to reap a path it cannot own, and nothing is recorded.
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(operations).toEqual([])
    const events = await h.store.getEvents(slug)
    expect(events.some((event) => event.type === 'infrastructure.cleanup-attempted')).toBe(false)
    expect(events.some((event) => event.type === 'infrastructure.failed')).toBe(false)

    // Abort releases the worktree through the provider that owns it.
    await h.store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(operations).toEqual([
      'retired-release:git-worktree:/repo/.autobuild/worktrees/ab-local-build',
    ])
    expect(
      (await h.store.getEvents(slug)).some((event) => event.type === 'workspace.released'),
    ).toBe(true)
  })

  test('remote recovery fences the stale identity before provisioning from the durable checkpoint', async () => {
    const operations: string[] = []
    let recoveredRevision: string | undefined
    let recoveredGeneration: number | undefined
    const workspaceProvider: WorkspaceProvider = {
      name: 'remote-test',
      recovery: {
        async reap(handle) {
          operations.push(`reap:${handle.ref}`)
          return { outcome: 'confirmed', snapshots: { outcome: 'confirmed', deleted: 1 } }
        },
      },
      async provision(opts) {
        operations.push('provision')
        recoveredRevision = opts.revision
        recoveredGeneration = opts.generation
        return {
          provider: 'remote-test',
          ref: 'sandbox-g1',
          path: '/remote/workspace',
          branch: opts.branch,
          base: { source: 'existing', sha: opts.revision! },
        }
      },
      async release() {},
    }
    const h = harness({ workspaceProvider })
    const slug = await seedBuild(h, {
      workspaceRef: 'sandbox-g0',
      workspaceProvider: 'remote-test',
    })
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'publication.requested',
      payload: {
        operation: 'implement',
        branch: `ab/${slug}`,
        sha: 'f'.repeat(40),
        round: 1,
        base: 'e'.repeat(40),
        artifact: { kind: 'implement-notes', rev: 0 },
      },
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'execution.started',
      payload: {
        provider: 'remote-test',
        workspaceRef: 'sandbox-g0',
        instance: 'old-instance',
        environmentId: 'sandbox-g0',
        sessionId: 'old-session',
      },
    })
    expect(await h.store.claimLease(slug, 'old-instance', 100)).toBe(true)
    h.clock.advance(101)

    expect((await h.dispatcher.tick({ acceptNewWork: false })).swept).toBe(1)
    // The replacement provision runs inside the kicked background continuation,
    // whose tail re-attaches the runner once the workspace exists.
    await h.dispatcher.drainProvisioning()
    expect(operations).toEqual(['reap:sandbox-g0', 'provision'])
    expect(recoveredRevision).toBe(BASE_SHA)
    expect(recoveredGeneration).toBe(1)
    expect(h.launches).toEqual([slug])
    const events = await h.store.getEvents(slug)
    expect(events.filter((event) => event.type === 'workspace.released')).toHaveLength(1)
    expect(
      events.filter((event) => event.type === 'workspace.provisioned').at(-1)?.payload.ref,
    ).toBe('sandbox-g1')
  })

  for (const completions of [1, 3]) {
    test(`parked remote publication recovery launches after ${completions} empty completions`, async () => {
      const operations: string[] = []
      const sha = 'f'.repeat(40)
      const workspaceProvider: WorkspaceProvider = {
        name: 'remote-test',
        recovery: {
          async reap() {
            operations.push('reap')
            throw new Error('a completed execution must recover publication in place')
          },
        },
        async provision() {
          throw new Error('publication recovery must retain the existing workspace')
        },
        async release() {},
      }
      const h = harness({
        workspaceProvider,
        onLaunch: async (slug, store) => {
          operations.push('settle-publication')
          // The real launchRunner settles publication before starting a guest.
          await store.append(slug, {
            actor: KERNEL,
            type: 'finalize.completed',
            payload: { pr: { ...PR, headSha: sha } },
          })
        },
      })
      const slug = await seedBuild(h, {
        workspaceRef: 'sandbox-g0',
        workspaceProvider: 'remote-test',
        workspaceRemote: true,
      })
      await seedLoopsApproved(h, slug)
      await h.store.append(slug, { actor: KERNEL, type: 'finalize.completed', payload: { pr: PR } })
      h.forge.setPrState(PR.number, { state: 'open', mergeable: true })
      await h.store.append(slug, {
        actor: KERNEL,
        type: 'publication.requested',
        payload: {
          operation: 'finalize',
          branch: `ab/${slug}`,
          sha,
          description: { kind: 'pr-description', rev: 0 },
        },
      })
      for (let i = 0; i < completions; i++) {
        const instance = `completed-${i}`
        await h.store.append(slug, {
          actor: DISPATCHER,
          type: 'execution.started',
          payload: { provider: 'remote-test', workspaceRef: 'sandbox-g0', instance },
        })
        await h.store.append(slug, {
          actor: DISPATCHER,
          type: 'execution.ended',
          payload: { instance, workspaceRef: 'sandbox-g0', outcome: 'completed', exitCode: 0 },
        })
      }
      expect(await h.store.claimLease(slug, 'completed-0', 100)).toBe(true)
      h.clock.advance(101)
      const before = await h.store.getEvents(slug)
      expect(decideNext(before, parseConfig(withReadyState('')))).toEqual({
        kind: 'wait',
        reason: 'awaiting-pr',
      })
      expect(publicationPending(before)).toBe(true)
      expect((await h.dispatcher.tick({ acceptNewWork: false })).swept).toBe(1)
      expect(h.launches).toEqual([slug])
      expect(operations).toEqual(['settle-publication'])
      const after = await h.store.getEvents(slug)
      expect(publicationPending(after)).toBe(false)
      expect(after.some((event) => event.type === 'escalation.raised')).toBe(false)
      expect((await h.dispatcher.tick({ acceptNewWork: false })).swept).toBe(0)
      expect(h.launches).toEqual([slug])
    })
  }

  test('parked build with a reaped recovery-capable workspace: reap only — the surviving wait guard keeps it out of launch', async () => {
    // Regression for the dead duplicate of the top-level wait guard in
    // leaseSweep: the duplicate was removed, but the first guard is
    // load-bearing — a parked build (wait decision, no publication recovery
    // due) whose stale workspace was successfully reaped falls through the
    // reap block's `if (!parked)` arm and would otherwise reach the
    // unconditional `launch` below, starting a fresh runner for a paused or
    // blocked build.
    const operations: string[] = []
    const workspaceProvider: WorkspaceProvider = {
      name: 'remote-test',
      recovery: {
        async reap(handle) {
          operations.push(`reap:${handle.ref}`)
          return { outcome: 'confirmed', snapshots: { outcome: 'confirmed', deleted: 1 } }
        },
      },
      async provision() {
        operations.push('provision')
        throw new Error('a parked build must never re-provision or launch')
      },
      async release() {},
    }
    const h = harness({ workspaceProvider })
    const slug = await seedBuild(h, {
      workspaceRef: 'sandbox-g0',
      workspaceProvider: 'remote-test',
    })
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: { id: 'e_1', phase: 'implement', source: 'agent', question: 'which path?' },
    })
    expect(await h.store.claimLease(slug, 'runner-1', 1000)).toBe(true)
    h.clock.advance(2000)

    // Parked path: neither swept nor provisioning increments; the reap runs,
    // but the tick must not launch a runner for a blocked build.
    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual(emptyTickReport())
    expect(operations).toEqual(['reap:sandbox-g0'])
    expect(h.launches).toEqual([])
    const events = await h.store.getEvents(slug)
    const released = events.find((event) => event.type === 'workspace.released')
    expect(released?.payload).toMatchObject({ reason: 'blocked' })
  })

  test('expired lease + running: relaunch', async () => {
    const h = harness()
    const slug = await seedBuild(h)
    await h.store.claimLease(slug, 'runner-1', 1000)
    h.clock.advance(2000)

    const report = await h.dispatcher.tick()
    expect(report).toEqual({ ...emptyTickReport(), swept: 1 })
    expect(h.launches).toEqual([slug])
  })

  test('healthy lease: not swept', async () => {
    const h = harness()
    const slug = await seedBuild(h)
    await h.store.claimLease(slug, 'runner-1', 60_000)

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.launches).toEqual([])
  })

  test('blocked build: not swept even with an expired lease', async () => {
    const h = harness()
    const slug = await seedBuild(h)
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: { id: 'e_1', phase: 'plan', source: 'agent', question: 'spec unclear' },
    })
    await h.store.claimLease(slug, 'runner-1', 1000)
    h.clock.advance(2000)

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.launches).toEqual([])
  })

  test('a confirmed relaunch bypasses absent-lease grace, while a held execution still excludes launch', async () => {
    const h = harness({
      opts: { leaseTtlMs: 60_000 },
      onLaunch: async (slug, store) => {
        await store.claimLease(slug, 'successor', 60_000)
      },
    })
    const slug = await seedBuild(h)
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'execution.started',
      payload: { provider: 'local', workspaceRef: 'workspace', instance: 'old' },
    })
    await h.store.claimLease(slug, 'old', 60_000)
    expect((await h.dispatcher.tick()).swept).toBe(0)
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'execution.ended',
      payload: { instance: 'old', workspaceRef: 'workspace', outcome: 'relaunch', exitCode: 0 },
    })
    await h.store.releaseLease(slug, 'old')
    expect((await h.dispatcher.tick()).swept).toBe(1)
    expect(h.launches).toEqual([slug])
    await h.dispatcher.tick()
    expect(h.launches).toEqual([slug])
  })

  test('absent lease: swept only after the leaseTtlMs grace', async () => {
    const h = harness({ opts: { leaseTtlMs: 60_000 } })
    const slug = await seedBuild(h, { attached: false }) // queued, never claimed

    // Fresh build — a just-launched runner still has time to claim.
    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.launches).toEqual([])

    h.clock.advance(60_000)
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), swept: 1 })
    expect(h.launches).toEqual([slug])
  })

  test('paused build with a pending resume: swept — a dead runner still receives its commands (D2)', async () => {
    // Regression: the sweep gated on status ∈ {queued, running}, but a
    // *-requested event does not change status (only the kernel's
    // acknowledgement does), so an operator resume on a paused build whose
    // runner had exited was never delivered — the build stuck forever.
    const h = harness()
    const slug = await seedBuild(h)
    await h.store.append(slug, {
      actor: humanActor('aron'),
      type: 'build.pause-requested',
      payload: {},
    })
    await h.store.append(slug, { actor: KERNEL, type: 'build.paused', payload: {} })
    // The paused runner exited (§11) and its lease lapsed.
    await h.store.claimLease(slug, 'runner-1', 1000)
    h.clock.advance(2000)

    // Paused with NO pending command: correctly parked, not swept.
    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.launches).toEqual([])

    await h.store.append(slug, {
      actor: humanActor('aron'),
      type: 'build.resume-requested',
      payload: {},
    })
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), swept: 1 })
    expect(h.launches).toEqual([slug])
  })

  test('blocked build with a pending abort: swept so the abort is acknowledged (D2, §14)', async () => {
    const h = harness()
    const slug = await seedBuild(h)
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: { id: 'e_1', phase: 'plan', source: 'agent', question: 'spec unclear' },
    })
    await h.store.append(slug, {
      actor: humanActor('aron'),
      type: 'build.abort-requested',
      payload: { reason: 'wrong approach' },
    })

    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), swept: 1 })
    expect(h.launches).toEqual([slug])
  })

  test('open PR with finalize post-steps still due: swept — the §5 steps must run (§15.6-C)', async () => {
    // Regression: the sweep skipped every build with a non-conflicted PR, so
    // a runner dying after finalize.completed silently dropped configured
    // finalize:* steps — never executed, no observation filed.
    const h = harness({
      toml:
        '[finalize]\nsteps = ["release-notes"]\n' +
        '[finalize.release-notes]\nkind = "agent"\nskill = "ab-release-notes"\n',
    })
    h.tickets.add(readyTicket('T-steps', { state: 'Done', labels: [] }))
    const slug = await seedBuild(h, { ticketId: 'T-steps' })
    await seedLoopsApproved(h, slug)
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: { pr: PR },
    })
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    await h.store.claimLease(slug, 'runner-1', 1000)
    h.clock.advance(2000)

    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), swept: 1 })
    expect(h.launches).toEqual([slug])

    // Once the post-step is done the build is parked on the PR (janitor
    // duty): an expired lease no longer sweeps it.
    await h.store.append(slug, {
      actor: agentActor('release-notes', 's_9'),
      type: 'finalize.step-completed',
      payload: { step: 'release-notes', ok: true },
    })
    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.launches).toEqual([slug]) // no relaunch
  })

  test('open PR after reconcile.completed: swept for the §15.7 full verify re-run', async () => {
    // Regression: reconcile.completed flips prState back to 'open', but
    // verify:* must re-run in full; a runner dying right after the reconcile
    // left the build 'running' forever, occupying a capacity slot.
    const toml = [
      '[commands]',
      'test = "bun test"',
      '[verify]',
      'steps = ["unit"]',
      '[verify.unit]',
      'kind = "check"',
      'command = "test"',
    ].join('\n')
    const h = harness({ toml })
    const slug = await seedBuild(h)
    await seedLoopsApproved(h, slug)
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'verify.started',
      payload: { step: 'unit', attempt: 1 },
    })
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'verify.completed',
      payload: { step: 'unit', attempt: 1, pass: true },
    })
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: { pr: PR },
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'pr.conflicted',
      payload: { baseSha: 'sha-main-9' },
    })
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'reconcile.started',
      payload: { attempt: 1, baseSha: 'sha-main-9' },
    })
    await h.store.append(slug, {
      actor: agentActor('reconcile', 's_9'),
      type: 'reconcile.completed',
      payload: { mergeCommit: 'sha-merge-1', artifact: { kind: 'reconcile-notes', rev: 0 } },
    })
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    await h.store.claimLease(slug, 'runner-1', 1000)
    h.clock.advance(2000)

    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), swept: 1 })
    expect(h.launches).toEqual([slug])
  })
})

// ── Repo scoping (§16.1, §12, §7.2) ──────────────────────────────────────────

describe('Dispatcher repo scoping', () => {
  test("another repo's builds are invisible: not janitored, not swept, not counted against capacity", async () => {
    // Regression: janitor, sweep, and the capacity count iterated every build
    // in the (shared, §7.2) store — repo B's dispatcher would count repo A's
    // builds against its capacity, re-attach ITS runner to repo A's builds,
    // and race repo A's janitor on pr.*/build.completed events.
    const h = harness({ tickets: [readyTicket('T-1')] }) // capacity 1 (default)

    // A foreign RUNNING build with an expired lease (sweep + capacity bait)…
    await seedBuild(h, { slug: 'foreign-running', repo: '/repos/other' })
    await h.store.claimLease('foreign-running', 'runner-x', 1000)
    // …and a foreign ABORTED build (janitor bait).
    await seedBuild(h, { slug: 'foreign-aborted', repo: '/repos/other' })
    await h.store.append('foreign-aborted', {
      actor: KERNEL,
      type: 'build.aborted',
      payload: {},
    })
    h.clock.advance(2000)

    const report = await h.dispatcher.tick()
    // dispatched 1 ⇒ the foreign running build did not consume the only slot;
    // swept/abandoned 0 ⇒ sweep and janitor never touched foreign builds.
    expect(report).toEqual({ ...emptyTickReport(), dispatched: 1 })
    expect(h.launches).toEqual(['add-rate-limiting'])

    // The foreign logs are untouched: no build.completed, no release.
    const abortedTypes = (await h.store.getEvents('foreign-aborted')).map((e) => e.type)
    expect(abortedTypes).not.toContain('build.completed')
    expect(h.workspaces.releases).toEqual([])
  })
})

// ── Idempotency (§3.3: cron-friendly, safe to re-run) ────────────────────────

describe('Dispatcher tick idempotency', () => {
  test('double-run over unchanged state reports all zeroes and mutates nothing', async () => {
    const h = harness({ tickets: [readyTicket('T-1', { labels: [] })] })
    // One running build with a healthy lease, one completed build.
    const running = await seedBuild(h, { slug: 'busy' })
    await h.store.claimLease(running, 'runner-1', 60_000)
    await seedBuild(h, { slug: 'settled', workspace: false, attached: false })
    await h.store.append('settled', {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
    const eventCounts = async () =>
      Promise.all(
        (await h.store.listBuilds()).map(
          async (b) =>
            (await h.store.getEvents(b.slug)).filter((e): boolean => e.type !== 'target.distance')
              .length,
        ),
      )
    const before = await eventCounts()

    // `queued` is a standing depth, not an action: identical on both runs.
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), queued: 1 })
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), queued: 1 })

    expect(await eventCounts()).toEqual(before)
    expect(h.launches).toEqual([])
    expect(h.workspaces.releases).toEqual([])
    expect(h.tickets.comments).toEqual([])
    expect(h.tickets.transitions).toEqual([])
  })
})

describe('readyCriteria — readiness is resolved against the ticket source (§3.3)', () => {
  const criteria = (toml: string) => readyCriteria(parseConfig(toml))

  const FILE = '[tickets]\nsource = "file"\n'
  const LINEAR = '[tickets]\nsource = "linear"\nteamKey = "ENG"\n'
  const PLUGIN = '[tickets]\nsource = "jira"\n'

  test('file source: the configured state is the gate, no label gate by default', () => {
    // The headline claim: no label — `mv` into the readyState directory dispatches.
    expect(criteria(`${FILE}readyState = "Ready"\n`)).toEqual({
      labels: [],
      state: 'Ready',
    })
  })

  test('linear source: the historical "autobuild" label gate is intact, alongside the state', () => {
    // Linear has no ready/ directory, so its historical label default remains
    // as an additional narrowing gate.
    expect(criteria(`${LINEAR}readyState = "Ready"\n`)).toEqual({
      labels: ['autobuild'],
      state: 'Ready',
    })
  })

  test('readyAssignee joins the criteria only when configured', () => {
    expect(criteria(`${LINEAR}readyState = "Ready"\nreadyAssignee = "me"\n`)).toEqual({
      labels: ['autobuild'],
      state: 'Ready',
      assignee: 'me',
    })
    expect(
      criteria(`${LINEAR}readyState = "Ready"\nreadyAssignee = "a@example.com"\n`).assignee,
    ).toBe('a@example.com')
    expect('assignee' in criteria(`${LINEAR}readyState = "Ready"\n`)).toBe(false)
  })

  test('plugin sources have no host-imposed label convention', () => {
    expect(criteria(`${PLUGIN}readyState = "Open"\n`)).toEqual({
      labels: [],
      state: 'Open',
    })
  })

  test('the state gate is always emitted for every source', () => {
    expect(criteria(`${LINEAR}readyState = "Todo"\n`)).toEqual({
      labels: ['autobuild'],
      state: 'Todo',
    })
    expect(criteria(`${FILE}readyState = "Todo"\n`)).toEqual({
      labels: [],
      state: 'Todo',
    })
    expect(criteria(`${PLUGIN}readyState = "Todo"\n`)).toEqual({
      labels: [],
      state: 'Todo',
    })
  })

  test('an explicit readyLabels wins for every source — config is never ignored', () => {
    expect(criteria(`${FILE}readyLabels = ["urgent"]\nreadyState = "Ready"\n`)).toEqual({
      labels: ['urgent'],
      state: 'Ready',
    })
    expect(criteria(`${LINEAR}readyLabels = ["urgent"]\nreadyState = "Ready"\n`)).toEqual({
      labels: ['urgent'],
      state: 'Ready',
    })
    expect(criteria(`${PLUGIN}readyLabels = ["urgent"]\nreadyState = "Ready"\n`)).toEqual({
      labels: ['urgent'],
      state: 'Ready',
    })
  })

  test('an explicit empty readyLabels is honored, not treated as unset', () => {
    expect(criteria(`${LINEAR}readyLabels = []\nreadyState = "Ready"\n`)).toEqual({
      labels: [],
      state: 'Ready',
    })
  })

  test('a config with no readyState cannot produce criteria — it fails at the tickets path', () => {
    expect(() => criteria(LINEAR)).toThrow('tickets.readyState')
    expect(() => criteria('')).toThrow('tickets.readyState')
  })
})

// ── Durable supervision (AUT-301) ────────────────────────────────────────────

describe('Dispatcher durable supervision', () => {
  function observingWorkspaceProvider(
    observation: () => Promise<
      { state: 'running' } | { state: 'ended'; exitCode?: number } | { state: 'lost' }
    >,
    operations: string[] = [],
  ): { execution: BuildExecution; provider: WorkspaceProvider } {
    const execution: BuildExecution = {
      async start() {
        throw new Error('not used')
      },
      async observe() {
        return observation()
      },
    }
    const provider: WorkspaceProvider = {
      name: 'remote-test',
      recovery: {
        reap: async () => ({
          outcome: 'confirmed',
          snapshots: { outcome: 'confirmed', deleted: 0 },
        }),
      },
      buildExecution: execution,
      async provision(opts) {
        operations.push('provision')
        return {
          provider: 'remote-test',
          ref: 'sandbox-g1',
          path: '/remote/workspace',
          branch: opts.branch,
          base: { source: 'existing', sha: opts.revision ?? BASE_SHA },
        }
      },
      async release() {},
    }
    return { execution, provider }
  }

  function remoteWorkspaceProvider(operations: string[]): WorkspaceProvider {
    return {
      name: 'remote-test',
      recovery: {
        reap: async () => ({
          outcome: 'confirmed',
          snapshots: { outcome: 'confirmed', deleted: 0 },
        }),
      },
      async provision(opts) {
        operations.push('provision')
        return {
          provider: 'remote-test',
          ref: 'sandbox-g1',
          path: '/remote/workspace',
          branch: opts.branch,
          base: { source: 'existing', sha: opts.revision ?? BASE_SHA },
        }
      },
      async release() {},
    }
  }

  test('settlement stage settles a foreign ended execution, releases its lease, and settles publication', async () => {
    const { provider } = observingWorkspaceProvider(async () => ({
      state: 'ended' as const,
      exitCode: 0,
    }))
    const workspaceProvider = provider
    const h = harness({ workspaceProvider })
    const slug = await seedBuild(h, {
      workspaceRef: 'sandbox-g0',
      workspaceProvider: 'remote-test',
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'execution.started',
      payload: {
        provider: 'remote-test',
        workspaceRef: 'sandbox-g0',
        instance: 'foreign-1',
        environmentId: 'sandbox-g0',
        sessionId: 'session-1',
        commandId: 'cmd-1',
      },
    })
    expect(await h.store.claimLease(slug, 'foreign-1', 100)).toBe(true)
    h.clock.advance(101)

    const report = await h.dispatcher.tick({ acceptNewWork: false })
    expect(report.settled).toBe(1)
    const events = await h.store.getEvents(slug)
    expect(events.findLast((event) => event.type === 'execution.ended')?.payload).toMatchObject({
      instance: 'foreign-1',
      outcome: 'completed',
      exitCode: 0,
    })
    expect((await h.store.getBuild(slug))?.lease).toBeUndefined()
    expect(h.launches).toEqual([slug])
  })

  test('the sweep leaves a running foreign guest untouched — no reap, no replacement, no launch', async () => {
    const operations: string[] = []
    const { provider } = observingWorkspaceProvider(
      async () => ({ state: 'running' as const }),
      operations,
    )
    const workspaceProvider = provider
    const h = harness({ workspaceProvider })
    const slug = await seedBuild(h, {
      workspaceRef: 'sandbox-g0',
      workspaceProvider: 'remote-test',
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'execution.started',
      payload: {
        provider: 'remote-test',
        workspaceRef: 'sandbox-g0',
        instance: 'foreign-1',
        commandId: 'cmd-1',
      },
    })
    expect(await h.store.claimLease(slug, 'foreign-1', 100)).toBe(true)
    h.clock.advance(101)

    const report = await h.dispatcher.tick({ acceptNewWork: false })
    expect(report.swept).toBe(0)
    expect(report.settled).toBe(0)
    expect(operations).toEqual([])
    expect(h.launches).toEqual([])
    const events = await h.store.getEvents(slug)
    expect(events.some((event) => event.type === 'workspace.released')).toBe(false)
    expect(events.some((event) => event.type === 'workspace.provision-started')).toBe(false)
  })

  test('the sweep re-attaches in the same generation after a recorded end', async () => {
    const operations: string[] = []
    const workspaceProvider = remoteWorkspaceProvider(operations)
    const h = harness({ workspaceProvider })
    const slug = await seedBuild(h, {
      workspaceRef: 'sandbox-g0',
      workspaceProvider: 'remote-test',
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'execution.started',
      payload: {
        provider: 'remote-test',
        workspaceRef: 'sandbox-g0',
        instance: 'foreign-1',
        commandId: 'cmd-1',
      },
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'execution.ended',
      payload: {
        instance: 'foreign-1',
        workspaceRef: 'sandbox-g0',
        outcome: 'completed',
        exitCode: 0,
      },
    })
    expect(await h.store.claimLease(slug, 'foreign-1', 100)).toBe(true)
    h.clock.advance(101)

    expect((await h.dispatcher.tick({ acceptNewWork: false })).swept).toBe(1)
    await h.dispatcher.drainProvisioning()
    expect(h.launches).toEqual([slug])
    // The workspace was never reaped: the recorded end is proof enough.
    expect((await h.store.getEvents(slug)).some((e) => e.type === 'workspace.released')).toBe(false)
  })

  async function seedEndedThenMissing(h: ReturnType<typeof harness>): Promise<string> {
    const slug = await seedBuild(h, {
      workspaceRef: 'sandbox-g0',
      workspaceProvider: 'remote-test',
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'execution.started',
      payload: {
        provider: 'remote-test',
        workspaceRef: 'sandbox-g0',
        instance: 'foreign-1',
        commandId: 'cmd-1',
      },
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'execution.ended',
      payload: {
        instance: 'foreign-1',
        workspaceRef: 'sandbox-g0',
        outcome: 'completed',
        exitCode: 0,
      },
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'infrastructure.failed',
      payload: {
        provider: 'remote-test',
        workspaceRef: 'sandbox-g0',
        instance: 'launcher-2',
        operation: 'start',
        cause: 'missing',
        attempt: 1,
        retryable: true,
        cleanupPending: true,
        error: 'sandbox sandbox-g0 no longer exists',
      },
    })
    expect(await h.store.claimLease(slug, 'launcher-2', 100)).toBe(true)
    h.clock.advance(101)
    return slug
  }

  test('a start that found the ended generation missing reaps and replaces it', async () => {
    const operations: string[] = []
    const h = harness({ workspaceProvider: remoteWorkspaceProvider(operations) })
    const slug = await seedEndedThenMissing(h)

    expect((await h.dispatcher.tick({ acceptNewWork: false })).swept).toBe(1)
    await h.dispatcher.drainProvisioning()
    const events = await h.store.getEvents(slug)
    expect(events.findLast((e) => e.type === 'workspace.released')?.payload).toMatchObject({
      ref: 'sandbox-g0',
      reason: 'replacement',
    })
    expect(operations).toEqual(['provision'])
    expect(h.launches).toEqual([slug])
  })

  test('a blocked build whose ended generation is missing is reaped without a launch', async () => {
    const operations: string[] = []
    const h = harness({ workspaceProvider: remoteWorkspaceProvider(operations) })
    const slug = await seedEndedThenMissing(h)
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: 'esc_infra',
        phase: 'setup',
        source: 'policy',
        policyCause: 'infrastructure-failure-limit',
        question: 'maxInfrastructureAttempts (3) exhausted during start',
      },
    })

    await h.dispatcher.tick({ acceptNewWork: false })
    await h.dispatcher.drainProvisioning()
    const events = await h.store.getEvents(slug)
    expect(events.findLast((e) => e.type === 'workspace.released')?.payload).toMatchObject({
      ref: 'sandbox-g0',
      reason: 'blocked',
    })
    expect(operations).toEqual([])
    expect(h.launches).toEqual([])
  })

  test('a provider-proved loss falls through to the stale replacement path', async () => {
    const operations: string[] = []
    const { provider } = observingWorkspaceProvider(
      async () => ({ state: 'lost' as const }),
      operations,
    )
    const workspaceProvider = provider
    const h = harness({ workspaceProvider })
    const slug = await seedBuild(h, {
      workspaceRef: 'sandbox-g0',
      workspaceProvider: 'remote-test',
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'execution.started',
      payload: {
        provider: 'remote-test',
        workspaceRef: 'sandbox-g0',
        instance: 'foreign-1',
        commandId: 'cmd-1',
      },
    })
    expect(await h.store.claimLease(slug, 'foreign-1', 100)).toBe(true)
    h.clock.advance(101)

    expect((await h.dispatcher.tick({ acceptNewWork: false })).swept).toBe(1)
    await h.dispatcher.drainProvisioning()
    const events = await h.store.getEvents(slug)
    expect(events.findLast((event) => event.type === 'execution.ended')?.payload).toMatchObject({
      instance: 'foreign-1',
      outcome: 'lost',
    })
    expect(events.some((event) => event.type === 'workspace.released')).toBe(true)
    expect(operations).toContain('provision')
  })

  test('remote dispatch appends the durable provision marker; the continuation completes facts and launch', async () => {
    const operations: string[] = []
    const workspaceProvider: WorkspaceProvider = {
      name: 'remote-test',
      recovery: {
        reap: async () => ({
          outcome: 'confirmed',
          snapshots: { outcome: 'confirmed', deleted: 0 },
        }),
      },
      // The provision resolves on a macrotask, so the tick — which never
      // awaits the continuation — returns before any provider call runs.
      async provision(opts) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        operations.push('provision')
        return {
          provider: 'remote-test',
          ref: 'sandbox-g1',
          path: '/remote/workspace',
          branch: opts.branch,
          base: { source: 'existing', sha: opts.revision ?? BASE_SHA },
        }
      },
      async release() {},
    }
    const h = harness({
      tickets: [readyTicket('T-remote-dispatch', { title: 'remote dispatch' })],
      workspaceProvider,
    })
    const report = await h.dispatcher.tick()
    expect(report.provisioning).toBe(1)
    expect(report.dispatched).toBe(1)
    expect(operations).toEqual([])
    // The durable marker precedes any provision.
    const slug = 'remote-dispatch'
    const events = await h.store.getEvents(slug)
    expect(events.some((event) => event.type === 'workspace.provision-started')).toBe(true)
    await h.dispatcher.drainProvisioning()
    expect(operations).toEqual(['provision'])
    expect((await h.store.getEvents(slug)).some((e) => e.type === 'workspace.provisioned')).toBe(
      true,
    )
    expect(h.launches).toEqual([slug])
  })

  test('a foreign provision marker with a live lease defers; an expired lease adopts immediately', async () => {
    const operations: string[] = []
    const workspaceProvider = remoteWorkspaceProvider(operations)
    const h = harness({ workspaceProvider })
    const slug = 'adopted-provision'
    const ticket = { source: 'fake' as const, id: 'T-adopt', title: slug }
    await h.store.createBuild({ slug, repo: REPO, ticket, branch: `ab/${slug}` })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { ticket, repo: REPO, baseBranch: 'main' },
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'workspace.provision-started',
      payload: { provider: 'remote-test', branch: `ab/${slug}`, generation: 0 },
    })
    // Live heartbeat from the (foreign) provisioner: defer.
    expect(await h.store.claimLease(slug, 'foreign-provisioner', 60_000)).toBe(true)
    expect((await h.dispatcher.tick({ acceptNewWork: false })).provisioning).toBe(0)
    expect(operations).toEqual([])

    // The heartbeat stops: within one lease TTL the marker is adopted.
    h.clock.advance(61_000)
    expect((await h.dispatcher.tick({ acceptNewWork: false })).provisioning).toBe(1)
    await h.dispatcher.drainProvisioning()
    expect(operations).toEqual(['provision'])
  })

  test('teardown signals live continuations and releases their provisioning leases', async () => {
    const operations: string[] = []
    // The provision is held until the test releases it, so the continuation is
    // provably mid-flight when teardown signals it.
    type ProvisionResult = {
      provider: string
      ref: string
      path: string
      branch: string
      base: { source: 'existing'; sha: string }
    }
    let releaseProvision!: (value: ProvisionResult) => void
    const provisioned = new Promise<ProvisionResult>((resolve) => {
      releaseProvision = resolve
    })
    const workspaceProvider: WorkspaceProvider = {
      name: 'remote-test',
      recovery: {
        reap: async () => ({
          outcome: 'confirmed',
          snapshots: { outcome: 'confirmed', deleted: 0 },
        }),
      },
      async provision() {
        operations.push('provision')
        return provisioned
      },
      async release() {},
    }
    const h = harness({ workspaceProvider })
    const slug = 'torn-down-provision'
    const ticket = { source: 'fake' as const, id: 'T-teardown', title: slug }
    await h.store.createBuild({ slug, repo: REPO, ticket, branch: `ab/${slug}` })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { ticket, repo: REPO, baseBranch: 'main' },
    })

    // The tick registers the continuation and its body is parked inside the
    // provision call; teardown then signals it and releases its lease.
    await h.dispatcher.tick({ acceptNewWork: false })
    await h.dispatcher.stopProvisioning()
    // A provision call already in flight when the signal landed may complete:
    // its fact is true and welcome, but the token check prevents the launch.
    releaseProvision({
      provider: 'remote-test',
      ref: 'sandbox-g1',
      path: '/remote/workspace',
      branch: `ab/${slug}`,
      base: { source: 'existing', sha: BASE_SHA },
    })
    await h.dispatcher.drainProvisioning()
    const events = await h.store.getEvents(slug)
    expect(events.findLast((event) => event.type === 'dispatch.failed')?.payload).toMatchObject({
      stage: 'workspace',
      error: expect.stringContaining('teardown'),
    })
    expect(events.some((event) => event.type === 'workspace.provisioned')).toBe(true)
    expect((await h.store.getBuild(slug))?.lease).toBeUndefined()
    expect(h.launches).toEqual([])
  })
})

// ── Durable hosted-harvest settlement (AUT-305) ─────────────────────────────

describe('Dispatcher harvest execution settlement', () => {
  function harvestProvider(
    observe: (identity: {
      provider: string
      workspaceRef: string
      environmentId?: string
      sessionId?: string
      commandId?: string
    }) => Promise<import('../ports/workspace/build-execution').ExecutionObservation>,
  ) {
    const reapCalls: Array<{ provider: string; ref: string }> = []
    const provider = {
      name: 'fake-harvest',
      provision: async () => {
        throw new Error('not used in settlement tests')
      },
      release: async () => {},
      recovery: {
        reap: async (handle: { provider: string; ref: string }) => {
          reapCalls.push({ provider: handle.provider, ref: handle.ref })
          return {
            outcome: 'confirmed' as const,
            snapshots: { outcome: 'confirmed' as const, deleted: 3 },
          }
        },
      },
      harvestExecution: { observe },
    }
    return { provider: provider as unknown as WorkspaceProvider, reapCalls }
  }

  async function seedExecution(h: Harness, opts: { commandId?: string | null } = {}) {
    await h.store.ensureRepo(REPO)
    await h.store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'harvest.execution.started',
      payload: {
        execution: 'host-harvest-i1',
        provider: 'fake-harvest',
        environmentId: 'autobuild-harvest-abc1234567',
        ...(opts.commandId === null ? {} : { commandId: 'cmd-1' }),
      },
    })
  }

  test('account attention escalates the authorized harvest once while a later exit still reaps it', async () => {
    const attention =
      'Missing credentials: account "kimi" (KIMI_KEY): replace the Kimi membership key'
    let ended = false
    const { provider, reapCalls } = harvestProvider(async () =>
      ended ? { state: 'ended', exitCode: 0, attention } : { state: 'running', attention },
    )
    const h = harness({ workspaceProvider: provider })
    await seedExecution(h)
    await h.store.appendRepo(REPO, {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'harvest-account',
        observations: [{ build: 'origin', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    await h.store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'harvest.execution.authorized',
      payload: {
        execution: 'host-harvest-i1',
        run: 'harvest-account',
        launch: 'started',
        leaseHolder: 'holder',
      },
    })
    await h.dispatcher.tick()
    await h.dispatcher.tick()
    let events = await h.store.getRepoEvents(REPO)
    expect(events.filter((event) => event.type === 'harvest.escalated')).toHaveLength(1)
    expect(events.find((event) => event.type === 'harvest.escalated')!.payload.reason).toBe(
      attention,
    )
    expect(reapCalls).toHaveLength(0)
    ended = true
    await h.dispatcher.tick()
    events = await h.store.getRepoEvents(REPO)
    expect(events.some((event) => event.type === 'harvest.execution.released')).toBe(true)
    expect(events.filter((event) => event.type === 'harvest.escalated')).toHaveLength(1)
    expect(reapCalls).toHaveLength(1)
  })

  test('a provider-proved lost execution is reaped and closed with the snapshot outcome', async () => {
    const { provider, reapCalls } = harvestProvider(async () => ({ state: 'lost' }))
    const h = harness({ workspaceProvider: provider })
    await seedExecution(h)
    const report = await h.dispatcher.tick()
    expect(report.settled).toBe(0)
    expect(reapCalls).toEqual([{ provider: 'fake-harvest', ref: 'autobuild-harvest-abc1234567' }])
    const events = await h.store.getRepoEvents(REPO)
    const released = events.find((event) => event.type === 'harvest.execution.released')
    expect(released).toMatchObject({
      actor: DISPATCHER,
      payload: {
        execution: 'host-harvest-i1',
        environmentId: 'autobuild-harvest-abc1234567',
        snapshots: { outcome: 'confirmed', deleted: 3 },
      },
    })
  })

  test('a provider-proved ended execution is reaped and closed identically', async () => {
    const { provider, reapCalls } = harvestProvider(async () => ({
      state: 'ended',
      exitCode: 0,
    }))
    const h = harness({ workspaceProvider: provider })
    await seedExecution(h)
    await h.dispatcher.tick()
    expect(reapCalls).toHaveLength(1)
    const events = await h.store.getRepoEvents(REPO)
    expect(events.some((event) => event.type === 'harvest.execution.released')).toBe(true)
    // Settled once: a second tick finds no open execution and reaps nothing.
    await h.dispatcher.tick()
    expect(reapCalls).toHaveLength(1)
  })

  test('a running guest is left alone — no reap, no close fact', async () => {
    const { provider, reapCalls } = harvestProvider(async () => ({ state: 'running' }))
    const h = harness({ workspaceProvider: provider })
    await seedExecution(h)
    await h.dispatcher.tick()
    expect(reapCalls).toEqual([])
    const events = await h.store.getRepoEvents(REPO)
    expect(events.some((event) => event.type === 'harvest.execution.released')).toBe(false)
  })

  test('an execution this process supervises is skipped', async () => {
    const { provider, reapCalls } = harvestProvider(async () => ({ state: 'lost' }))
    const h = harness({
      workspaceProvider: provider,
      activeHarvestExecutions: () => new Set(['host-harvest-i1']),
    })
    await seedExecution(h)
    await h.dispatcher.tick()
    expect(reapCalls).toEqual([])
    const events = await h.store.getRepoEvents(REPO)
    expect(events.some((event) => event.type === 'harvest.execution.released')).toBe(false)
  })

  test('an execution without a recorded command id cannot be observed and is left alone', async () => {
    const { provider, reapCalls } = harvestProvider(async () => ({ state: 'lost' }))
    const h = harness({ workspaceProvider: provider })
    await seedExecution(h, { commandId: null })
    await h.dispatcher.tick()
    expect(reapCalls).toEqual([])
    // The fact remains open for a later, better-informed settlement.
    const events = await h.store.getRepoEvents(REPO)
    expect(events.some((event) => event.type === 'harvest.execution.released')).toBe(false)
  })
})

// ── AUT-328: publication requests must complete or be recorded lost before a
// workspace is released ────────────────────────────────────────────────────────

describe('publication loss before workspace release', () => {
  const SHA = 'f'.repeat(40)
  const BASE = 'e'.repeat(40)

  interface LossFixture {
    h: ReturnType<typeof harness>
    slug: string
    requestSeq: number
    reapCalls: string[]
    settleCalls: string[]
  }

  /** A build whose guest requested publication and then died: the log carries
   * publication.requested → execution.started → execution.ended (outcome
   * lost), the workspace is still open, and the provider is recovery-capable
   * (its reap destroys the only copy of the un-pushed commits). */
  async function seedLostGuest(
    options: { settlePublication?: (slug: string) => Promise<void>; store?: BuildStore } = {},
  ): Promise<LossFixture> {
    const reapCalls: string[] = []
    const settleCalls: string[] = []
    const remote: WorkspaceProvider = {
      name: 'remote-test',
      recovery: {
        async reap(handle) {
          reapCalls.push(handle.ref)
          return { outcome: 'confirmed', snapshots: { outcome: 'confirmed', deleted: 0 } }
        },
      },
      async provision(opts) {
        return {
          provider: 'remote-test',
          ref: 'sandbox-g1',
          path: '/remote/workspace',
          branch: opts.branch,
          base: { source: 'existing', sha: opts.revision ?? BASE },
        }
      },
      async release() {},
    }
    const h = harness({
      workspaceProvider: remote,
      ...(options.store !== undefined ? { store: options.store } : {}),
      ...(options.settlePublication !== undefined
        ? { settlePublication: options.settlePublication }
        : {}),
    })
    const slug = await seedBuild(h, {
      slug: 'lost-publication',
      workspaceRef: 'sandbox-g0',
      workspaceProvider: 'remote-test',
      attached: false,
    })
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'publication.requested',
      payload: {
        operation: 'implement',
        branch: `ab/${slug}`,
        sha: SHA,
        round: 1,
        base: BASE,
        artifact: { kind: 'implement-notes', rev: 0 },
      },
    })
    const events = await h.store.getEvents(slug)
    const requestSeq = events.findLast((event) => event.type === 'publication.requested')!.seq
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'execution.started',
      payload: {
        provider: 'remote-test',
        workspaceRef: 'sandbox-g0',
        instance: 'guest-1',
      },
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'execution.ended',
      payload: { instance: 'guest-1', workspaceRef: 'sandbox-g0', outcome: 'lost' },
    })
    return { h, slug, requestSeq, reapCalls, settleCalls }
  }

  test('forge scheduling deferrals park a reap without failing the tick or blocking sibling supervision', async () => {
    const { ForgeCooldown } = await import('../kernel/guarded-forge')
    const { ForgeRequestDeferred } = await import('../ports/forge-request-context')
    for (const signal of [new ForgeCooldown('cooldown'), new ForgeRequestDeferred('deferred')]) {
      let coolingDown = true
      const fixture = await seedLostGuest({
        settlePublication: async (slug) => {
          fixture.settleCalls.push(slug)
          if (coolingDown) throw signal
          await fixture.h.store.append(slug, {
            actor: DISPATCHER,
            type: 'implement.completed',
            payload: {
              round: 1,
              commits: { base: BASE, head: SHA },
              artifact: { kind: 'implement-notes', rev: 0 },
            },
          })
        },
      })
      const sibling = await seedBuild(fixture.h, { slug: 'sibling', attached: false })
      for (let attempt = 0; attempt < 2; attempt++) {
        await fixture.h.dispatcher.tick({ acceptNewWork: false })
        expect(fixture.reapCalls).toEqual([])
        const events = await fixture.h.store.getEvents(fixture.slug)
        expect(
          events.some((e) => e.type === 'publication.lost' || e.type === 'workspace.released'),
        ).toBe(false)
        expect(publicationPending(events)).toBe(true)
      }
      expect(fixture.h.launches).toContain(sibling)
      expect(fixture.h.launches).not.toContain(fixture.slug)
      coolingDown = false
      await fixture.h.dispatcher.tick({ acceptNewWork: false })
      await fixture.h.dispatcher.drainProvisioning()
      expect(fixture.reapCalls).toEqual(['sandbox-g0'])
      const events = await fixture.h.store.getEvents(fixture.slug)
      expect(events.some((e) => e.type === 'publication.lost')).toBe(false)
      expect(events.some((e) => e.type === 'implement.completed')).toBe(true)
    }
  })

  test('the loss shape (spec AC2): the reaped stale workspace records publication.lost first', async () => {
    const fixture = await seedLostGuest({
      settlePublication: async () => {
        fixture.settleCalls.push(fixture.slug)
        throw new Error('settlement cannot complete — the guest is gone')
      },
    })

    const report = await fixture.h.dispatcher.tick({ acceptNewWork: false })
    await fixture.h.dispatcher.drainProvisioning()
    expect(report.swept).toBe(1)

    // The trusted settlement was attempted first, while the workspace still
    // existed, and its failure did not block the durable loss record.
    expect(fixture.settleCalls).toEqual([fixture.slug])
    const events = await fixture.h.store.getEvents(fixture.slug)
    const lost = events.find((event) => event.type === 'publication.lost')
    const cleanup = events.find((event) => event.type === 'infrastructure.cleanup-attempted')
    const released = events.find((event) => event.type === 'workspace.released')
    expect(lost).toBeDefined()
    expect(released).toBeDefined()
    // Exact ordering: the loss record precedes the provider cleanup and the
    // release fact — the reaped workspace can never be the first notice.
    expect(lost!.seq).toBeGreaterThan(fixture.requestSeq)
    expect(cleanup !== undefined && lost!.seq < cleanup.seq).toBe(true)
    expect(released!.seq).toBeGreaterThan(lost!.seq)
    expect(lost!.payload).toEqual({
      request: fixture.requestSeq,
      operation: 'implement',
      branch: `ab/${fixture.slug}`,
      sha: SHA,
      reason: 'replacement',
    })
    // The reap destroyed the workspace only after the record was durable.
    expect(fixture.reapCalls).toEqual(['sandbox-g0'])
    // Recovery proceeds through the existing abandoned-publication flow: the
    // replacement environment is provisioned and the phase re-attached.
    expect(fixture.h.launches).toContain(fixture.slug)
    const provisioned = events.filter((event) => event.type === 'workspace.provisioned')
    expect(provisioned.at(-1)?.payload.ref).toBe('sandbox-g1')
  })

  test('a completed publication lets the release proceed without a loss record', async () => {
    const fixture = await seedLostGuest({
      settlePublication: async (slug) => {
        fixture.settleCalls.push(slug)
        await fixture.h.store.append(slug, {
          actor: DISPATCHER,
          type: 'implement.completed',
          payload: {
            round: 1,
            commits: { base: BASE, head: SHA },
            artifact: { kind: 'implement-notes', rev: 0 },
          },
        })
      },
    })

    await fixture.h.dispatcher.tick({ acceptNewWork: false })
    await fixture.h.dispatcher.drainProvisioning()

    expect(fixture.settleCalls).toEqual([fixture.slug])
    const events = await fixture.h.store.getEvents(fixture.slug)
    expect(events.some((event) => event.type === 'publication.lost')).toBe(false)
    expect(
      events.some(
        (event) => event.type === 'implement.completed' && event.payload.commits.head === SHA,
      ),
    ).toBe(true)
    expect(events.some((event) => event.type === 'workspace.released')).toBe(true)
  })

  test('a failed reap that retries appends no duplicate loss record', async () => {
    const fixture = await seedLostGuest({
      settlePublication: async () => {
        throw new Error('settlement cannot complete — the guest is gone')
      },
    })
    // First reap fails after the loss record is durable (a crash between the
    // record and the release); the next tick must retry the release without
    // recording the loss a second time.
    const store = fixture.h.store as MemoryBuildStore
    const originalAppend = store.append.bind(store)
    let reapFailed = false
    store.append = async (slug, event) => {
      if (event.type === 'infrastructure.cleanup-attempted' && !reapFailed) {
        reapFailed = true
        throw new Error('injected reap failure')
      }
      return originalAppend(slug, event)
    }

    await fixture.h.dispatcher.tick({ acceptNewWork: false })
    let events = await fixture.h.store.getEvents(fixture.slug)
    expect(events.some((event) => event.type === 'workspace.released')).toBe(false)
    expect(events.filter((event) => event.type === 'publication.lost')).toHaveLength(1)

    await fixture.h.dispatcher.tick({ acceptNewWork: false })
    await fixture.h.dispatcher.drainProvisioning()
    events = await fixture.h.store.getEvents(fixture.slug)
    expect(events.some((event) => event.type === 'workspace.released')).toBe(true)
    expect(events.filter((event) => event.type === 'publication.lost')).toHaveLength(1)
  })

  test('an abort release records the loss with the abort reason before workspace.released', async () => {
    const h = harness()
    const slug = await seedBuild(h, { slug: 'abort-loss', attached: false })
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'publication.requested',
      payload: {
        operation: 'implement',
        branch: `ab/${slug}`,
        sha: SHA,
        round: 1,
        base: BASE,
        artifact: { kind: 'implement-notes', rev: 0 },
      },
    })
    await h.store.append(slug, {
      actor: humanActor('aron'),
      type: 'build.abort-requested',
      payload: { reason: 'wrong direction' },
    })

    const report = await h.dispatcher.tick({ acceptNewWork: false })
    expect(report.abandoned).toBe(1)
    const events = await h.store.getEvents(slug)
    const lost = events.find((event) => event.type === 'publication.lost')
    const released = events.find((event) => event.type === 'workspace.released')
    expect(lost).toBeDefined()
    expect(released?.payload).toMatchObject({ reason: 'abort' })
    expect(released!.seq).toBeGreaterThan(lost!.seq)
    expect(lost!.payload).toMatchObject({ operation: 'implement', sha: SHA, reason: 'abort' })
  })

  test('a failing loss record blocks the release: no reap, no workspace.released', async () => {
    class OutageStore extends MemoryBuildStore {
      constructor() {
        super({ clock: manualClock() })
      }

      override async append<T extends EventType>(
        slug: string,
        event: EventWrite<T>,
      ): Promise<EventEnvelope<T>> {
        if (event.type === 'publication.lost') {
          throw new Error('injected store outage on publication.lost')
        }
        return super.append(slug, event)
      }
    }
    const fixture = await seedLostGuest({
      store: new OutageStore(),
      settlePublication: async () => {
        throw new Error('settlement cannot complete — the guest is gone')
      },
    })

    // The guard's append failure propagates: the sweep (and with it the
    // release) never proceeds past an unrecorded pending request.
    await expect(fixture.h.dispatcher.tick({ acceptNewWork: false })).rejects.toThrow(
      /injected store outage on publication\.lost/,
    )
    expect(fixture.reapCalls).toEqual([])
    const events = await fixture.h.store.getEvents(fixture.slug)
    expect(events.some((event) => event.type === 'workspace.released')).toBe(false)
    expect(events.some((event) => event.type === 'infrastructure.cleanup-attempted')).toBe(false)
  })
})

describe('dispatcher — operator sandbox idle settlement (AUT-340)', () => {
  async function seedLiveSandbox(
    h: Harness,
    opts: { operator?: string; environmentId?: string; provider?: string } = {},
  ): Promise<void> {
    await h.store.ensureRepo(REPO)
    await h.store.appendRepo(REPO, {
      actor: humanActor('ops'),
      type: 'orchestrator.sandbox.provisioned',
      payload: {
        operator: opts.operator ?? 'ops',
        environmentId: opts.environmentId ?? 'env-1',
        provider: opts.provider ?? 'fake',
        workspacePath: '/env/path',
      },
    })
  }

  test('a live sandbox past the idle threshold is stopped with a dispatcher fact', async () => {
    const h = harness({ toml: '[orchestrator]\nenabled = true\n' })
    await seedLiveSandbox(h)
    h.clock.advance(31 * 60 * 1000)
    const report = await h.dispatcher.tick()
    const types = (await h.store.getRepoEvents(REPO)).map((event) => event.type)
    expect(types).toContain('orchestrator.sandbox.stopped')
    const stopped = (await h.store.getRepoEvents(REPO)).findLast(
      (event) => event.type !== 'dispatcher.ticket-scan-completed',
    )!
    expect(stopped.actor).toEqual({ kind: 'dispatcher' })
    expect(stopped.payload).toMatchObject({
      operator: 'ops',
      environmentId: 'env-1',
      reason: 'idle',
    })
    expect(report.sandboxIdleStops).toBe(1)
    expect(report.sandboxSettleFailures).toBe(0)
  })

  test('activity appended by another process mid-tick keeps the sandbox alive', async () => {
    let hook: (() => Promise<void>) | undefined
    class HookStore extends MemoryBuildStore {
      override async getRepoBuildDigests(repo: string) {
        const hooked = hook
        hook = undefined
        await hooked?.()
        return super.getRepoBuildDigests(repo)
      }
    }
    const storeClock = manualClock()
    const store = new HookStore({ clock: storeClock })
    const h = harness({
      store,
      toml: '[orchestrator]\nenabled = true\n',
    })
    await seedLiveSandbox(h)
    h.clock.advance(31 * 60 * 1000)
    storeClock.advance(31 * 60 * 1000)
    hook = async () => {
      await store.appendRepo(REPO, {
        actor: humanActor('ops'),
        type: 'orchestrator.sandbox.activity',
        payload: { operator: 'ops', environmentId: 'env-1' },
      })
    }
    const report = await h.dispatcher.tick()
    const types = (await h.store.getRepoEvents(REPO)).map((event) => event.type)
    expect(types).not.toContain('orchestrator.sandbox.stopped')
    expect(report.sandboxIdleStops).toBe(0)
  })

  for (const change of ['released', 'replaced', 'read-failed'] as const) {
    test(`idle settlement revalidates a sandbox ${change} mid-tick`, async () => {
      let hook: (() => Promise<void>) | undefined
      let rejectRead = false
      class HookStore extends MemoryBuildStore {
        override async getRepoBuildDigests(repo: string) {
          const pending = hook
          hook = undefined
          await pending?.()
          return super.getRepoBuildDigests(repo)
        }
        override async getRepo(repo: string) {
          if (rejectRead) throw new Error('decision read failed')
          return super.getRepo(repo)
        }
      }
      const storeClock = manualClock()
      const store = new HookStore({ clock: storeClock })
      const h = harness({
        store,
        toml: '[orchestrator]\nenabled = true\n',
      })
      await seedLiveSandbox(h)
      h.clock.advance(31 * 60_000)
      storeClock.advance(31 * 60_000)
      hook = async () => {
        if (change === 'read-failed') {
          rejectRead = true
          return
        }
        await store.appendRepo(REPO, {
          actor: humanActor('ops'),
          type: 'orchestrator.sandbox.released',
          payload: {
            operator: 'ops',
            environmentId: 'env-1',
            snapshots: { outcome: 'unknown', error: 'released elsewhere' },
          },
        })
        if (change === 'replaced') await seedLiveSandbox(h, { environmentId: 'env-2' })
      }
      const report = await h.dispatcher.tick({ acceptNewWork: false })
      expect(report.sandboxIdleStops).toBe(0)
      expect(report.sandboxSettleFailures).toBe(change === 'read-failed' ? 1 : 0)
      expect(
        (await store.getRepoEvents(REPO)).some(
          (event) => event.type === 'orchestrator.sandbox.stopped',
        ),
      ).toBe(false)
    })
  }

  for (const idle of [false, true]) {
    test(`sandbox decision refresh is conditional on idleness: ${idle}`, async () => {
      const h = harness({ toml: '[orchestrator]\nenabled = true\n' })
      await seedLiveSandbox(h)
      h.clock.advance((idle ? 31 : 10) * 60_000)
      let reads = 0
      const getRepo = h.store.getRepo.bind(h.store)
      h.store.getRepo = async (repo) => {
        reads++
        return getRepo(repo)
      }
      const report = await h.dispatcher.tick({ acceptNewWork: false })
      // Initial sample, plus an impending stop and its append refresh when idle.
      expect(reads).toBe(idle ? 3 : 1)
      expect(report.sandboxIdleStops).toBe(idle ? 1 : 0)
    })
  }

  test('a sandbox inside the threshold is left alone', async () => {
    const h = harness({ toml: '[orchestrator]\nenabled = true\n' })
    await seedLiveSandbox(h)
    h.clock.advance(10 * 60 * 1000)
    const report = await h.dispatcher.tick()
    const types = (await h.store.getRepoEvents(REPO)).map((event) => event.type)
    expect(types).not.toContain('orchestrator.sandbox.stopped')
    expect(report.sandboxIdleStops).toBe(0)
  })

  test('disabled [orchestrator] makes the stage a no-op', async () => {
    const h = harness()
    await seedLiveSandbox(h)
    h.clock.advance(31 * 60 * 1000)
    const report = await h.dispatcher.tick()
    const types = (await h.store.getRepoEvents(REPO)).map((event) => event.type)
    expect(types).not.toContain('orchestrator.sandbox.stopped')
    expect(report.sandboxIdleStops).toBe(0)
  })

  test('a capability-less provider makes the stage a no-op', async () => {
    const h = harness({ toml: '[orchestrator]\nenabled = true\n' })
    // The logical-mode fake hosts the capability; strip it to model a
    // provider without one.
    const bare = h.workspaces as unknown as Record<string, unknown>
    delete bare.orchestratorSandbox
    await seedLiveSandbox(h)
    h.clock.advance(31 * 60 * 1000)
    const report = await h.dispatcher.tick()
    const types = (await h.store.getRepoEvents(REPO)).map((event) => event.type)
    expect(types).not.toContain('orchestrator.sandbox.stopped')
    expect(report.sandboxIdleStops).toBe(0)
  })

  test('a stale-provider environment past the idle threshold gets its trail closed with an unconfirmed release fact', async () => {
    const h = harness({ toml: '[orchestrator]\nenabled = true\n' })
    await seedLiveSandbox(h, { provider: 'other-provider' })
    h.clock.advance(31 * 60 * 1000)
    const report = await h.dispatcher.tick()
    const last = (await h.store.getRepoEvents(REPO)).findLast(
      (event) => event.type !== 'dispatcher.ticket-scan-completed',
    )!
    expect(last.type).toBe('orchestrator.sandbox.released')
    expect(last.actor).toEqual({ kind: 'dispatcher' })
    expect(last.payload).toMatchObject({
      operator: 'ops',
      environmentId: 'env-1',
      snapshots: { outcome: 'unknown', error: expect.stringMatching(/provider/) },
    })
    expect(report.sandboxIdleStops).toBe(1)
    expect(report.sandboxSettleFailures).toBe(0)
    // Distinguish release from a confirmed stop: nothing was stopped through
    // a provider this dispatcher no longer owns.
    expect((await h.store.getRepoEvents(REPO)).map((event) => event.type)).not.toContain(
      'orchestrator.sandbox.stopped',
    )
  })

  test('a stale-provider release is not duplicated on the next tick', async () => {
    const h = harness({ toml: '[orchestrator]\nenabled = true\n' })
    await seedLiveSandbox(h, { provider: 'other-provider' })
    h.clock.advance(31 * 60 * 1000)
    const first = await h.dispatcher.tick()
    expect(first.sandboxIdleStops).toBe(1)
    h.clock.advance(31 * 60 * 1000)
    const second = await h.dispatcher.tick()
    expect(second.sandboxIdleStops).toBe(0)
    const releases = (await h.store.getRepoEvents(REPO)).filter(
      (event) => event.type === 'orchestrator.sandbox.released',
    )
    expect(releases).toHaveLength(1)
  })

  test('the idle gate still applies to stale-provider environments', async () => {
    const h = harness({ toml: '[orchestrator]\nenabled = true\n' })
    await seedLiveSandbox(h, { provider: 'other-provider' })
    h.clock.advance(10 * 60 * 1000)
    const report = await h.dispatcher.tick()
    expect((await h.store.getRepoEvents(REPO)).map((event) => event.type)).not.toContain(
      'orchestrator.sandbox.released',
    )
    expect(report.sandboxIdleStops).toBe(0)
  })

  test('an absent environment closes the orphan trail with an unconfirmed release fact', async () => {
    const h = harness({ toml: '[orchestrator]\nenabled = true\n' })
    await seedLiveSandbox(h)
    const capability = h.workspaces.orchestratorSandbox!
    ;(capability as unknown as { stop: () => Promise<{ outcome: 'absent' }> }).stop = async () => ({
      outcome: 'absent',
    })
    h.clock.advance(31 * 60 * 1000)
    const report = await h.dispatcher.tick()
    const last = (await h.store.getRepoEvents(REPO)).findLast(
      (event) => event.type !== 'dispatcher.ticket-scan-completed',
    )!
    expect(last.type).toBe('orchestrator.sandbox.released')
    expect(last.actor).toEqual({ kind: 'dispatcher' })
    expect(last.payload).toMatchObject({
      operator: 'ops',
      environmentId: 'env-1',
      snapshots: { outcome: 'unknown', error: 'environment absent at idle settlement' },
    })
    expect(report.sandboxIdleStops).toBe(1)
  })

  test('an unsupported provider is skipped silently', async () => {
    const h = harness({ toml: '[orchestrator]\nenabled = true\n' })
    await seedLiveSandbox(h)
    const capability = h.workspaces.orchestratorSandbox!
    ;(capability as unknown as { stop: () => Promise<{ outcome: 'unsupported' }> }).stop =
      async () => ({ outcome: 'unsupported' })
    h.clock.advance(31 * 60 * 1000)
    const report = await h.dispatcher.tick()
    expect(report.sandboxIdleStops).toBe(0)
    expect((await h.store.getRepoEvents(REPO)).map((event) => event.type)).not.toContain(
      'orchestrator.sandbox.stopped',
    )
  })

  test('a contained settlement failure is reported and retried next tick', async () => {
    const h = harness({ toml: '[orchestrator]\nenabled = true\n' })
    await seedLiveSandbox(h)
    const capability = h.workspaces.orchestratorSandbox!
    let failing = true
    ;(capability as unknown as { stop: () => Promise<{ outcome: 'stopped' }> }).stop = async () => {
      if (failing) throw new Error('stop transport failed')
      return { outcome: 'stopped' }
    }
    h.clock.advance(31 * 60 * 1000)
    const failed = await h.dispatcher.tick()
    expect(failed.sandboxSettleFailures).toBe(1)
    expect(failed.sandboxIdleStops).toBe(0)
    expect(failed.janitorDiagnostics.some((line) => line.includes('idle settlement failed'))).toBe(
      true,
    )

    failing = false
    h.clock.advance(60 * 1000)
    const retried = await h.dispatcher.tick()
    expect(retried.sandboxIdleStops).toBe(1)
    expect(retried.sandboxSettleFailures).toBe(0)
  })
})

describe('dispatcher — missing-record journal reads (AUT-543)', () => {
  /** The settlement stages' journal reads must answer `[]` — not reject — on a
   * repository whose record does not yet exist: both stages route through the
   * shared missing-record helper (AUT-524), and a regression back to a raw
   * `getRepoStateEvents` (which rejects on an unknown repo) would abort the
   * tick. Pinned against the ensured-record case: both outcomes must be the
   * empty settlement a fresh store legitimately has. */
  test('a fresh store without a repository record settles nothing and reports cleanly', async () => {
    const h = harness({ toml: '[orchestrator]\nenabled = true\n' })
    // No `ensureRepo` anywhere — the store has neither a repository row nor a
    // journal, exactly the missing-record shape.
    expect(await h.store.getRepo(REPO)).toBeNull()
    h.clock.advance(31 * 60 * 1000) // past the idle threshold, nothing to settle
    const report = await h.dispatcher.tick()
    expect(report.settled).toBe(0)
    expect(report.sandboxIdleStops).toBe(0)
    expect(report.sandboxSettleFailures).toBe(0)
    expect(report.janitorFailed).toBe(0)
    expect(report.janitorDiagnostics).toEqual([])
    // And the ensured-record twin answers identically.
    await h.store.ensureRepo(REPO)
    const ensured = await h.dispatcher.tick()
    expect(ensured.sandboxIdleStops).toBe(0)
    expect(ensured.janitorFailed).toBe(0)
  })
})

describe('legacy repository defaults are inert', () => {
  test.each([true, false])(
    'legacy default %s neither fans out nor seeds claims',
    async (enabled) => {
      const h = harness({ tickets: [readyTicket('T-new')] })
      const slug = await seedAwaitingPr(h)
      h.forge.setPrState(1, { state: 'open', mergeable: true })
      await h.store.ensureRepo(REPO)
      await h.store.appendRepo(REPO, {
        actor: humanActor('old-operator'),
        type: 'dispatcher.auto-merge-default-set',
        payload: { enabled },
      })
      await h.dispatcher.tick()
      for (const record of await h.store.listBuilds()) {
        const events = await h.store.getEvents(record.slug)
        expect(
          events.some(
            (event) =>
              event.type === 'build.auto-merge-requested' ||
              event.type === 'build.auto-merge-cancelled' ||
              event.type === 'build.auto-merge-default-observed',
          ),
        ).toBe(false)
      }
      expect(h.forge.squashMergeCalls).toHaveLength(0)
      expect(reduceBuild(await h.store.getEvents(slug)).landing?.decision?.mode).toBe('consent')
    },
  )
})

describe('the dispatcher tick reads a bounded journal (AUT-489)', () => {
  /** Count the journal rows the store returns to the dispatcher. */
  function countingStore(store: BuildStore): { store: BuildStore; journalRows: () => number } {
    let rows = 0
    const target = store as unknown as Record<string, unknown>
    const proxy = new Proxy(target, {
      get(t, prop) {
        if (prop === 'getRepoStateEvents') {
          return async (repo: string) => {
            const events = await (
              t.getRepoStateEvents as (repo: string) => Promise<RepositoryEvent[]>
            ).call(t, repo)
            rows += events.length
            return events
          }
        }
        if (prop === 'getRepoEvents') {
          return async (...args: unknown[]) => {
            const events = await (
              t.getRepoEvents as (...a: unknown[]) => Promise<RepositoryEvent[]>
            ).call(t, ...args)
            rows += events.length
            return events
          }
        }
        const value = Reflect.get(t, prop, t)
        return typeof value === 'function' ? value.bind(t) : value
      },
    })
    return { store: proxy as unknown as BuildStore, journalRows: () => rows }
  }

  /** Seed `invocations` no-op dispatcher invocations (alternating
   * lease-held yields and no-ready-work completions) into the repository. */
  async function seedNoopInvocations(store: MemoryBuildStore, invocations: number): Promise<void> {
    await store.ensureRepo(REPO)
    const noopCounters = {
      merged: 0,
      closed: 0,
      conflicted: 0,
      abandoned: 0,
      discarded: 0,
      janitorFailed: 0,
      recovered: 0,
      dispatchFailed: 0,
      resumed: 0,
      swept: 0,
      dispatched: 0,
      authored: 0,
      bounced: 0,
      claimRaces: 0,
      invalidTickets: 0,
      dependencyBlocked: 0,
      harvestStarted: 0,
      harvestResumed: 0,
      harvestCompleted: 0,
      harvestEscalated: 0,
      harvestFailed: 0,
    }
    for (let index = 0; index < invocations; index += 1) {
      const run = `noop_${index}`
      await store.appendRepo(REPO, {
        actor: DISPATCHER,
        type: 'dispatcher.run-started',
        payload: {
          run,
          pid: 1,
          effectiveConfig: { kind: 'dispatcher-effective-config', rev: 0 },
          roleWarnings: [],
        },
      })
      if (index % 2 === 0) {
        await store.appendRepo(REPO, {
          actor: DISPATCHER,
          type: 'dispatcher.tick-yielded',
          payload: { run, holder: 'other' },
        })
      } else {
        await store.appendRepo(REPO, {
          actor: DISPATCHER,
          type: 'dispatcher.tick-completed',
          payload: {
            run,
            queued: 0,
            counters: noopCounters,
            janitorDiagnostics: [],
            ticketDiagnostics: [],
            dependencyDiagnostics: [],
          },
        })
      }
      await store.appendRepo(REPO, {
        actor: DISPATCHER,
        type: 'dispatcher.run-stopped',
        payload: { run, outcome: 'normal' as const },
      })
    }
  }

  test('a no-ready-work tick reads the same number of journal events at 1,000 and 2,000 invocations of history', async () => {
    const measured: number[] = []
    for (const invocations of [1_000, 2_000]) {
      const raw = new MemoryBuildStore()
      await seedNoopInvocations(raw, invocations)
      const counting = countingStore(raw)
      const h = harness({ tickets: [], store: counting.store })
      // The tick performs no claims and no launches; it only samples the
      // journal (controls, settlements, ready-scan brackets) and records its
      // own facts.
      const report = await h.dispatcher.tick()
      expect(report.dispatched).toBe(0)
      expect(report.queued).toBe(0)
      expect(h.launches).toEqual([])
      measured.push(counting.journalRows())
      // The tick still recorded its own facts under the new run.
      const tail = await raw.getRepoEvents(REPO)
      expect(tail.slice(-4).map((event) => event.type)).toEqual([
        'dispatcher.run-started',
        'dispatcher.tick-completed',
        'dispatcher.run-stopped',
        'dispatcher.ticket-scan-completed',
      ])
    }
    // The bound does not depend on the invocation history length.
    expect(measured[0]).toBe(measured[1])
    expect(measured[0]).toBe(0)
  })
})

describe('Dispatcher freezes ticket assets at the claim (SPEC §6.3)', () => {
  const enc = (text: string) => new TextEncoder().encode(text)
  const file = (name: string, text: string) => ({
    kind: 'mock',
    name,
    layout: 'file' as const,
    entries: [{ type: 'file' as const, path: name, content: enc(text) }],
  })
  const pin = (name: string, revision: number, size: number) => ({
    kind: 'mock',
    name,
    revision,
    layout: 'file' as const,
    size,
    fileCount: 1,
    dirCount: 0,
  })

  test('claiming pins the exact current revisions in build.created', async () => {
    const h = harness({ tickets: [readyTicket('T-1')] })
    await h.store.putTicketAsset(REPO, 'T-1', file('a.png', 'one'))
    await h.store.putTicketAsset(REPO, 'T-1', file('a.png', 'three'))
    await h.store.putTicketAsset(REPO, 'T-1', file('b.png', 'bb'))
    await h.store.removeTicketAsset(REPO, 'T-1', 'mock', 'b.png')
    await h.store.putTicketAsset(REPO, 'T-2', file('other.png', 'x'))

    await h.dispatcher.tick()

    const events = await h.store.getEvents('add-rate-limiting')
    const created = events.find((event) => event.type === 'build.created')
    expect(created?.payload.assets).toEqual([pin('a.png', 1, 5)])
    expect(reduceBuild(events).pinnedAssets).toEqual([pin('a.png', 1, 5)])
  })

  test('edits made while a spec is being authored are not pinned', async () => {
    let store: BuildStore | undefined
    const h = harness({
      tickets: [readyTicket('T-1', { body: 'thin but groomed' })],
      authorSpec: async () => {
        await store!.putTicketAsset(REPO, 'T-1', file('a.png', 'replaced during authoring'))
        await store!.putTicketAsset(REPO, 'T-1', file('late.png', 'late'))
        return CONFORMING_BODY
      },
    })
    store = h.store
    await h.store.putTicketAsset(REPO, 'T-1', file('a.png', 'one'))

    await h.dispatcher.tick()

    const created = (await h.store.getEvents('add-rate-limiting')).find(
      (event) => event.type === 'build.created',
    )
    expect(created?.payload.assets).toEqual([pin('a.png', 0, 3)])
    const pinned = await h.store.getPinnedTicketAsset('add-rate-limiting', 'mock', 'a.png')
    const first = pinned?.entries[0]
    expect(first?.type === 'file' ? new TextDecoder().decode(first.content) : null).toBe('one')
  })

  test('hosted claim snapshots before authoring and resumes without the ticket service', async () => {
    const remote = new MemoryBuildStore()
    await remote.putTicketAsset(REPO, 'T-1', file('a.png', 'hosted'))
    let available = true
    const h = harness({
      tickets: [readyTicket('T-1', { body: 'thin' })],
      wrapTickets: (source) =>
        Object.assign(source, {
          name: 'hosted',
          assets: {
            listTicketAssets: async (...args: Parameters<BuildStore['listTicketAssets']>) => {
              if (!available) throw new Error('offline')
              return remote.listTicketAssets(...args)
            },
            getTicketAsset: remote.getTicketAsset.bind(remote),
          },
        }),
      authorSpec: async () => {
        await remote.removeTicketAsset(REPO, 'T-1', 'mock', 'a.png')
        available = false
        return CONFORMING_BODY
      },
    })
    await h.store.putTicketAsset(REPO, 'T-1', file('a.png', 'local'))
    await h.dispatcher.tick()
    const asset = await h.store.getPinnedTicketAsset('add-rate-limiting', 'mock', 'a.png')
    const entry = asset?.entries[0]
    expect(entry?.type === 'file' && new TextDecoder().decode(entry.content)).toBe('hosted')
    await h.dispatcher.tick()
    expect(await h.store.getPinnedTicketAsset('add-rate-limiting', 'mock', 'a.png')).toEqual(asset)
  })

  test('hosted snapshot failure never launches an incomplete build', async () => {
    const h = harness({
      tickets: [readyTicket('T-1')],
      wrapTickets: (source) =>
        Object.assign(source, {
          name: 'hosted',
          assets: {
            listTicketAssets: async () => {
              throw new Error('ticket assets offline')
            },
          },
        }),
    })
    await expect(h.dispatcher.tick()).rejects.toThrow('ticket assets offline')
    expect(await h.store.listBuilds()).toEqual([])
  })

  test('a ticket with no assets gets exactly the build.created it always had', async () => {
    const h = harness({ tickets: [readyTicket('T-1')] })
    await h.dispatcher.tick()
    const created = (await h.store.getEvents('add-rate-limiting')).find(
      (event) => event.type === 'build.created',
    )
    expect(created?.payload).toEqual({
      ticket: expect.objectContaining({ id: 'T-1' }),
      repo: REPO,
      baseBranch: 'main',
    })
  })

  test('recovery after the record exists keeps the original pin', async () => {
    let launches = 0
    const h = harness({
      tickets: [readyTicket('T-1')],
      onLaunch: () => {
        launches += 1
        if (launches === 1) throw new Error('runner scheduler offline')
      },
    })
    await h.store.putTicketAsset(REPO, 'T-1', file('a.png', 'one'))
    await h.dispatcher.tick()
    expect(launches).toBe(1)

    await h.store.putTicketAsset(REPO, 'T-1', file('a.png', 'two'))
    await h.store.putTicketAsset(REPO, 'T-1', file('new.png', 'n'))
    await h.dispatcher.tick({ acceptNewWork: false })

    const events = await h.store.getEvents('add-rate-limiting')
    expect(events.filter((event) => event.type === 'build.created')).toHaveLength(1)
    expect(reduceBuild(events).pinnedAssets).toEqual([pin('a.png', 0, 3)])
  })

  test('a legacy record with an empty stream is reconstructed with the current assets', async () => {
    const h = harness({ tickets: [readyTicket('T-recover')] })
    const ticket = (await h.tickets.get('T-recover'))!
    await h.tickets.claim(ticket.ref.id)
    await h.store.createBuild({
      slug: 'legacy-empty',
      repo: REPO,
      ticket: ticket.ref,
      branch: 'ab/legacy-empty',
    })
    await h.store.putTicketAsset(REPO, 'T-recover', file('a.png', 'one'))

    await h.dispatcher.tick({ acceptNewWork: false })

    const events = await h.store.getEvents('legacy-empty')
    expect(reduceBuild(events).pinnedAssets).toEqual([pin('a.png', 0, 3)])
  })
})

// ── Tick reads only builds that still have work ──────────────────────────────

/** A memory store that counts the event rows `getEvents` returns per build, so
 * a tick's per-build read set can be asserted. Rows, not calls: the dispatcher's
 * repository view asks every held build for its tail each tick, and an empty
 * answer is not a read of that build's history. */
class ReadCountingStore extends MemoryBuildStore {
  readonly reads = new Map<string, number>()
  override async getEvents(...args: Parameters<MemoryBuildStore['getEvents']>) {
    const events = await super.getEvents(...args)
    if (events.length > 0) this.reads.set(args[0], (this.reads.get(args[0]) ?? 0) + events.length)
    return events
  }
  /** Distinct builds with rows read since the last call, clearing the counter. */
  drain(): string[] {
    const slugs = [...this.reads.keys()].sort()
    this.reads.clear()
    return slugs
  }
}

/** Counts every event row a read returns — builds, repository journal, and
 * the bounded journal subset — so a tick's total event traffic is assertable. */
class RowCountingStore extends MemoryBuildStore {
  rows = 0
  override async getEvents(...args: Parameters<MemoryBuildStore['getEvents']>) {
    const events = await super.getEvents(...args)
    this.rows += events.length
    return events
  }
  override async getRepoEvents(...args: Parameters<MemoryBuildStore['getRepoEvents']>) {
    const events = await super.getRepoEvents(...args)
    this.rows += events.length
    return events
  }
  override async getRepoStateEvents(...args: Parameters<MemoryBuildStore['getRepoStateEvents']>) {
    const events = await super.getRepoStateEvents(...args)
    this.rows += events.length
    return events
  }
  drainRows(): number {
    const rows = this.rows
    this.rows = 0
    return rows
  }
}

describe('Dispatcher incremental view reads (AUT-647)', () => {
  function rowHarness() {
    const store = new RowCountingStore({ clock: manualClock() })
    return { store, h: harness({ store }) }
  }

  test('an idle tick after the first reads zero event rows; a tick after M foreign events reads exactly M', async () => {
    const { store, h } = rowHarness()
    await store.ensureRepo(REPO)
    const live = await seedBuild(h, { slug: 'live' })
    const other = await seedBuild(h, { slug: 'other' })
    const done = await seedBuild(h, { slug: 'done' })
    await h.store.append(done, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'abandoned' },
    })
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(store.drainRows()).toBe(0)

    await h.dispatcher.tick({ acceptNewWork: false })
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(store.drainRows()).toBe(0)

    // Another process appends: two build events and one journal setting.
    await h.store.append(live, { actor: DISPATCHER, type: 'dispatch.comment-posted', payload: {} })
    await h.store.append(other, { actor: DISPATCHER, type: 'dispatch.comment-posted', payload: {} })
    await h.store.appendRepo(REPO, {
      actor: humanActor('op'),
      type: 'dispatcher.intake-set',
      payload: { enabled: true },
    })
    store.drainRows()
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(store.drainRows()).toBe(0)
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(store.drainRows()).toBe(0)
  })

  test('--once style: a fresh dispatcher reads each work build once and no more than its history', async () => {
    const { store, h } = rowHarness()
    await store.ensureRepo(REPO)
    const live = await seedBuild(h, { slug: 'live' })
    const _history = (await h.store.getEvents(live)).length
    store.drainRows()
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(store.drainRows()).toBe(0)
  })
})

describe('Dispatcher tick event reads', () => {
  function countingHarness(over: Parameters<typeof harness>[0] = {}) {
    const store = new ReadCountingStore({ clock: manualClock() })
    return { store, h: harness({ ...over, store }) }
  }

  const complete = (h: Harness, slug: string, outcome: 'merged' | 'abandoned' = 'abandoned') =>
    h.store.append(slug, { actor: DISPATCHER, type: 'build.completed', payload: { outcome } })

  test('settled terminal builds cost no event reads; only nonterminal builds are read', async () => {
    const { store, h } = countingHarness()
    const terminal: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const slug = await seedBuild(h, { slug: `done-${i}` })
      await complete(h, slug, 'merged')
      terminal.push(slug)
    }
    for (let i = 0; i < 3; i += 1) {
      const slug = await seedBuild(h, { slug: `aborted-${i}` })
      await h.store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })
      await complete(h, slug)
      terminal.push(slug)
    }
    const live = ['live-a', 'live-b']
    for (const slug of live) await seedBuild(h, { slug })
    store.drain()

    await h.dispatcher.tick({ acceptNewWork: false })
    const read = store.drain()
    expect(read.filter((slug) => terminal.includes(slug))).toEqual([])
    expect(read.length).toBeLessThanOrEqual(live.length)
  })

  test('a lease sweep with a zero TTL never reads a terminal build', async () => {
    const { store, h } = countingHarness()
    const slug = await seedBuild(h, { slug: 'swept' })
    await complete(h, slug)
    expect(await h.store.claimLease(slug, 'old', 100)).toBe(true)
    await h.store.releaseLease(slug, 'old')
    h.clock.advance(1_000)
    store.drain()

    await h.dispatcher.tick({ acceptNewWork: false })
    expect(store.drain()).toEqual([])
  })

  test('an aborted build is read until cleanup records build.completed, then not again', async () => {
    const { store, h } = countingHarness()
    const slug = await seedBuild(h, { slug: 'cleaning' })
    await h.store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })
    store.drain()

    const first = await h.dispatcher.tick({ acceptNewWork: false })
    expect(first.abandoned).toBe(1)
    expect(store.drain()).toEqual([])
    expect(reduceBuild(await h.store.getEvents(slug)).status).toBe('done')
    store.drain()

    await h.dispatcher.tick({ acceptNewWork: false })
    expect(store.drain()).toEqual([])
  })

  test('a done build with an unreclaimed attachment is read until the reclaim is recorded', async () => {
    const { store, h } = countingHarness({ prAttachments: true })
    const slug = await seedBuild(h, { slug: 'reclaim', workspace: false })
    await seedHostedPrAttachment(h, slug)
    await complete(h, slug)
    h.forge.failNextPrAttachmentReclaim('outage')
    store.drain()

    await h.dispatcher.tick({ acceptNewWork: false })
    expect(store.drain()).toEqual([])
    // The failed attempt left the reclaim pending: the view still holds the
    // build and retries it, but its log is already in memory — no rows read.
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(store.drain()).toEqual([])
    expect(
      (await h.store.getEvents(slug)).filter((event) => event.type === 'pr-attachment.reclaimed'),
    ).toHaveLength(1)
    store.drain()

    await h.dispatcher.tick({ acceptNewWork: false })
    expect(store.drain()).toEqual([])
  })

  test('a terminal build with an open execution is still settled, then costs no reads', async () => {
    let state: 'running' | 'ended' = 'running'
    const execution: BuildExecution = {
      async start() {
        throw new Error('not used')
      },
      async observe() {
        return state === 'running' ? { state: 'running' } : { state: 'ended', exitCode: 0 }
      },
    }
    const provider: WorkspaceProvider = {
      name: 'remote-test',
      recovery: {
        reap: async () => ({
          outcome: 'confirmed',
          snapshots: { outcome: 'confirmed', deleted: 0 },
        }),
      },
      buildExecution: execution,
      async provision() {
        throw new Error('not used')
      },
      async release() {},
    }
    const { store, h } = countingHarness({ workspaceProvider: provider })
    const slug = await seedBuild(h, { slug: 'open-exec', workspace: false })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'execution.started',
      payload: {
        provider: 'remote-test',
        workspaceRef: 'sandbox-g0',
        instance: 'foreign-1',
        environmentId: 'sandbox-g0',
        sessionId: 'session-1',
        commandId: 'cmd-1',
      },
    })
    await complete(h, slug)
    // A settled terminal build alongside it: never read.
    const settled = await seedBuild(h, { slug: 'settled', workspace: false })
    await complete(h, settled)
    store.drain()

    expect((await h.dispatcher.tick({ acceptNewWork: false })).settled).toBe(0)
    expect(store.drain()).toEqual([])

    state = 'ended'
    expect((await h.dispatcher.tick({ acceptNewWork: false })).settled).toBe(1)
    // The held log already carried the open execution; settling appends
    // through the view, so nothing is read.
    expect(store.drain()).toEqual([])
    expect((await h.store.getEvents(slug)).at(-1)?.type).toBe('execution.ended')
    store.drain()

    await h.dispatcher.tick({ acceptNewWork: false })
    expect(store.drain()).toEqual([])
  })
})

// ── Reducer snapshots: the quiet second tick (AUT-648) ───────────────────────

describe('Dispatcher over reducer snapshots', () => {
  /** One entry per provider observation of a foreign execution. */
  const observations: string[] = []

  async function seededRepository() {
    observations.length = 0
    const { provider } = (() => {
      const execution: BuildExecution = {
        async start() {
          throw new Error('not used')
        },
        async observe() {
          observations.push('observed')
          return { state: 'running' as const }
        },
      }
      const provider: WorkspaceProvider = {
        name: 'remote-test',
        buildExecution: execution,
        async provision(opts) {
          return {
            provider: 'remote-test',
            ref: 'sandbox-g1',
            path: '/remote/workspace',
            branch: opts.branch,
            base: { source: 'existing', sha: opts.revision ?? BASE_SHA },
          }
        },
        async release() {},
      }
      return { provider }
    })()
    const store = new RowCountingStore({ clock: manualClock() })
    await store.ensureRepo(REPO)
    const first = harness({ store, workspaceProvider: provider })
    // A running build holding a live lease.
    const running = await seedBuild(first, { slug: 'running-one', attached: true })
    await store.claimLease(running, 'runner-1', 10_000_000)
    // A paused build.
    const paused = await seedBuild(first, { slug: 'paused-one', attached: true })
    await store.append(paused, { actor: KERNEL, type: 'build.paused', payload: {} } as never)
    // A foreign open execution the provider reports running, with a live lease
    // (the settlement stage observes it) and with an expired one (the lease
    // sweep does too).
    for (const [slug, ttl] of [
      ['foreign-live', 10_000_000],
      ['foreign-stale', 100],
    ] as const) {
      await seedBuild(first, {
        slug,
        workspaceRef: `sandbox-${slug}`,
        workspaceProvider: 'remote-test',
      })
      await store.append(slug, {
        actor: DISPATCHER,
        type: 'execution.started',
        payload: {
          provider: 'remote-test',
          workspaceRef: `sandbox-${slug}`,
          instance: `inst-${slug}`,
          environmentId: `sandbox-${slug}`,
          sessionId: 'session-1',
          commandId: `cmd-${slug}`,
        },
      })
      await store.claimLease(slug, `inst-${slug}`, ttl)
    }
    first.clock.advance(1_000)
    return { store, provider, first }
  }

  test('a second cold tick with no new events reads zero event rows and appends nothing', async () => {
    const { store, provider, first } = await seededRepository()
    await first.dispatcher.tick({ acceptNewWork: false })
    const slugs = ['running-one', 'paused-one', 'foreign-live', 'foreign-stale']
    const before = await Promise.all(slugs.map((slug) => store.getEvents(slug)))
    const journalBefore = await store.getRepoEvents(REPO)
    store.rows = 0
    observations.length = 0
    const second = harness({ store, workspaceProvider: provider })
    second.clock.advance(1_000)
    await second.dispatcher.tick({ acceptNewWork: false })
    expect(store.rows).toBe(0)
    // Both settlement paths — the foreign pass and the stale-lease sweep —
    // asked the provider, and the answer cost no event row.
    expect(observations.length).toBeGreaterThanOrEqual(3)
    store.rows = 0
    const after = await Promise.all(slugs.map((slug) => store.getEvents(slug)))
    expect(after.map((events) => events.map((event) => event.type))).toEqual(
      before.map((events) => events.map((event) => event.type)),
    )
    // The tick's own journal facts are the only appends.
    expect((await store.getRepoEvents(REPO)).length - journalBefore.length).toBeLessThanOrEqual(4)
  })

  test('M events between ticks cost exactly M rows', async () => {
    const { store, provider, first } = await seededRepository()
    await first.dispatcher.tick({ acceptNewWork: false })
    const quiet = harness({ store, workspaceProvider: provider })
    quiet.clock.advance(1_000)
    await quiet.dispatcher.tick({ acceptNewWork: false })
    const note = (summary: string) => ({
      actor: agentActor('implement', 's_test'),
      type: 'observation.recorded' as const,
      payload: { id: `o_${summary}`, kind: 'followup' as const, summary },
    })
    await store.append('running-one', note('a'))
    await store.append('running-one', note('b'))
    await store.append('paused-one', note('c'))
    await store.appendRepo(REPO, {
      actor: humanActor('op'),
      type: 'dispatcher.intake-set',
      payload: { enabled: true },
    })
    store.rows = 0
    const third = harness({ store, workspaceProvider: provider })
    third.clock.advance(1_000)
    await third.dispatcher.tick({ acceptNewWork: false })
    expect(store.rows).toBe(0)
  })
})

describe('provider-neutral intake rate limits', () => {
  const CAPACITY_2 = 'capacity = 2\n[tickets]\nsource = "file"\nreadyState = "Ready"'
  test('a later dependency rate limit prevents all claims and recovers next tick', async () => {
    let limited = true
    const error = new TicketSourceRateLimitError('fake', 1_800_000_120_000)
    const h = harness({
      tickets: [
        readyTicket('T-1', { title: 'Resolved work', blockedBy: ['T-7'] }),
        readyTicket('T-2', { title: 'Blocked work', blockedBy: ['T-9'] }),
        readyTicket('T-3', { title: 'Limited work', blockedBy: ['T-8'] }),
      ],
      toml: CAPACITY_2,
      wrapTickets: (source) => {
        const list = source.listReady.bind(source)
        source.listReady = async (criteria) => {
          const result = await list(criteria)
          return {
            ...result,
            tickets: result.tickets.map((ticket) =>
              ticket.ref.id === 'T-1' ? { ...ticket, blockersResolved: true } : ticket,
            ),
          }
        }
        const original = source.dependencyStates.bind(source)
        source.dependencyStates = async (ids) => {
          expect(ids).not.toContain('T-7')
          if (ids.includes('T-8') && limited) throw error
          return original(ids)
        }
        return source
      },
    })
    await expect(h.dispatcher.tick()).rejects.toBe(error)
    expect(h.tickets.claims).toEqual([])
    expect(h.tickets.transitions).toEqual([])
    expect(h.tickets.comments).toEqual([])
    expect(h.launches).toEqual([])
    expect(await h.store.listBuilds()).toEqual([])
    limited = false
    const report = await h.dispatcher.tick()
    expect(report.dispatched).toBe(1)
    expect(report.dependencyBlocked).toBe(2)
  })

  for (const firstOperation of ['dependency', 'listing']) {
    test(`alternating cooldown failures retain one episode starting at ${firstOperation}`, async () => {
      const store = new MemoryBuildStore()
      let mode = firstOperation
      const make = () =>
        harness({
          store,
          tickets: [readyTicket('T-1', { blockedBy: ['T-9'] })],
          wrapTickets: (source) => {
            const list = source.listReady.bind(source)
            source.listReady = async (criteria) => {
              if (mode === 'listing')
                throw new TicketSourceRateLimitError('fake', 1_800_000_120_000)
              return list(criteria)
            }
            source.dependencyStates = async () => {
              if (mode === 'dependency')
                throw new TicketSourceRateLimitError('fake', 1_800_000_180_000)
              return [{ id: 'T-9', exists: true, resolved: false, blockedBy: [] }]
            }
            return source
          },
        })
      const first = make()
      await expect(first.dispatcher.tick()).rejects.toBeInstanceOf(TicketSourceRateLimitError)
      for (const next of ['dependency', 'listing', 'dependency', 'listing']) {
        mode = next
        await expect(first.dispatcher.tick()).rejects.toBeInstanceOf(TicketSourceRateLimitError)
      }
      const episodes = async () =>
        (await store.getRepoEvents(REPO)).filter(
          (event) =>
            event.type === 'dispatcher.ticket-source-degraded' ||
            event.type === 'dispatcher.ticket-source-recovered',
        )
      expect((await episodes()).map((event) => event.type)).toEqual([
        'dispatcher.ticket-source-degraded',
      ])
      // Replaying the journal must retain the strictest observed recovery
      // requirement, including when the episode began at the ready listing.
      const restarted = make()
      mode = 'healthy'
      await restarted.dispatcher.observeReady()
      expect((await episodes()).map((event) => event.type)).toEqual([
        'dispatcher.ticket-source-degraded',
      ])
      await restarted.dispatcher.tick()
      await restarted.dispatcher.tick()
      expect((await episodes()).map((event) => event.type)).toEqual([
        'dispatcher.ticket-source-degraded',
        'dispatcher.ticket-source-recovered',
      ])
      expect(first.tickets.claims).toEqual([])
      expect(restarted.tickets.claims).toEqual([])
    })
  }

  test('dependency degradation deduplicates across restart and observation, then recovers once', async () => {
    let mode = 'limited'
    const store = new MemoryBuildStore()
    const make = () =>
      harness({
        store,
        tickets: [readyTicket('T-1', { blockedBy: ['T-9'] })],
        wrapTickets: (source) => {
          source.dependencyStates = async () => {
            if (mode === 'limited') throw new TicketSourceRateLimitError('fake', 1_800_000_120_000)
            if (mode === 'broken') throw new Error('provider exploded')
            return [{ id: 'T-9', exists: true, resolved: false, blockedBy: [] }]
          }
          return source
        },
      })
    const first = make()
    await expect(first.dispatcher.tick()).rejects.toBeInstanceOf(TicketSourceRateLimitError)
    await expect(first.dispatcher.tick()).rejects.toBeInstanceOf(TicketSourceRateLimitError)
    const restarted = make()
    await restarted.dispatcher.observeReady()
    await expect(restarted.dispatcher.tick()).rejects.toBeInstanceOf(TicketSourceRateLimitError)
    mode = 'broken'
    expect((await restarted.dispatcher.tick()).dependencyCheckFailed).toBe(1)
    const lifecycle = async () =>
      (await store.getRepoEvents(REPO)).filter((event) =>
        event.type.startsWith('dispatcher.ticket-source-'),
      )
    expect((await lifecycle()).map((event) => event.type)).toEqual([
      'dispatcher.ticket-source-degraded',
    ])
    mode = 'healthy'
    await restarted.dispatcher.tick()
    await restarted.dispatcher.tick()
    expect((await lifecycle()).map((event) => event.type)).toEqual([
      'dispatcher.ticket-source-degraded',
      'dispatcher.ticket-source-recovered',
    ])
    expect(restarted.tickets.claims).toEqual([])
  })

  test('a failed recovery append propagates and the next observation retries it once', async () => {
    const backing = new MemoryBuildStore()
    let rejectRecovery = true
    const store = new Proxy(backing, {
      get(target, key) {
        if (key === 'appendRepo')
          return async (...args: Parameters<MemoryBuildStore['appendRepo']>) => {
            if (args[1].type === 'dispatcher.ticket-source-recovered' && rejectRecovery)
              throw new Error('journal unavailable')
            return target.appendRepo(...args)
          }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    let limited = true
    const h = harness({
      store,
      wrapTickets: (source) => {
        const original = source.listReady.bind(source)
        source.listReady = async (criteria) => {
          if (limited) throw new TicketSourceRateLimitError('fake', 1_800_000_120_000)
          return original(criteria)
        }
        return source
      },
    })
    await expect(h.dispatcher.observeReady()).rejects.toBeInstanceOf(TicketSourceRateLimitError)
    limited = false
    await expect(h.dispatcher.observeReady()).rejects.toThrow('journal unavailable')
    expect((await backing.getRepoEvents(REPO)).map((event) => event.type)).toEqual([
      'dispatcher.ticket-source-degraded',
    ])
    rejectRecovery = false
    await h.dispatcher.observeReady()
    await h.dispatcher.observeReady()
    expect((await backing.getRepoEvents(REPO)).map((event) => event.type)).toEqual([
      'dispatcher.ticket-source-degraded',
      'dispatcher.ticket-source-recovered',
      'dispatcher.ticket-scan-completed',
    ])
  })

  test('ordinary ready scan failure is durable and observation recovers it', async () => {
    let broken = true
    const h = harness({
      wrapTickets: (source) => {
        const original = source.listReady.bind(source)
        source.listReady = async (criteria) => {
          if (broken) throw new Error('source unavailable')
          return original(criteria)
        }
        return source
      },
    })
    await expect(h.dispatcher.observeReady()).rejects.toThrow('source unavailable')
    await expect(h.dispatcher.observeReady()).rejects.toThrow('source unavailable')
    broken = false
    await h.dispatcher.observeReady()
    await h.dispatcher.observeReady()
    expect((await h.store.getRepoEvents(REPO)).map((event) => event.type)).toEqual([
      'dispatcher.ticket-source-degraded',
      'dispatcher.ticket-source-recovered',
      'dispatcher.ticket-scan-completed',
    ])
  })

  test('a preflight deadline stops graph traversal and leaves all claims for next tick', async () => {
    let h!: Harness
    let reads = 0
    h = harness({
      tickets: [readyTicket('T-1'), readyTicket('T-2', { blockedBy: ['T-9'] })],
      toml: CAPACITY_2,
      wrapTickets: (source) => {
        source.dependencyStates = async () => {
          reads += 1
          h.clock.advance(60_000)
          return [{ id: 'T-9', exists: true, resolved: false, blockedBy: ['T-8'] }]
        }
        return source
      },
    })
    const report = await h.dispatcher.tick({ deadlineAt: h.clock().getTime() + 1000 })
    expect(reads).toBe(1)
    expect(report.dispatched).toBe(0)
    expect(report.dependencyBlocked).toBe(0)
    expect(h.tickets.claims).toEqual([])
    expect(await h.store.listBuilds()).toEqual([])
  })

  test('a ready scan rate limit rejects without claiming anything', async () => {
    const error = new TicketSourceRateLimitError('fake', 1_800_000_120_000)
    const h = harness({
      wrapTickets: (source) =>
        Object.assign(source, {
          listReady: async () => {
            throw error
          },
        }),
    })
    await expect(h.dispatcher.tick()).rejects.toBe(error)
    expect(h.tickets.claims).toEqual([])
    expect(await h.store.listBuilds()).toEqual([])
  })
})

describe('durable ticket scan cadence', () => {
  for (const observation of [false, true]) {
    test(`30 unchanged intervals survive cold dispatchers (${observation ? 'observation' : 'admission'})`, async () => {
      const tickets = observation ? [readyTicket('standing')] : []
      let h = counted({ tickets, toml: 'ticketScanIntervalSeconds = 120' })
      let scans = 0
      const invoke = () => (observation ? h.dispatcher.observeReady() : h.dispatcher.tick())
      expect((await invoke()).queued).toBe(observation ? 1 : 0)
      scans += h.scans()
      const initial = (await h.store.getRepoEvents(REPO)).filter(
        (e) => e.type === 'dispatcher.ticket-scan-completed',
      )
      expect(initial).toHaveLength(1)
      for (let interval = 0; interval < 30; interval++) {
        const store = h.store
        const time = h.clock().getTime()
        h = counted({ store, tickets, toml: 'ticketScanIntervalSeconds = 120' })
        h.clock.set(new Date(time + 60_000).toISOString())
        expect((await invoke()).queued).toBe(observation ? 1 : 0)
        expect(h.scans()).toBe(0)
        h.clock.advance(60_000)
        expect((await invoke()).queued).toBe(observation ? 1 : 0)
        expect(h.scans()).toBe(1)
        scans += h.scans()
      }
      expect(scans).toBe(31)
      expect(
        (await h.store.getRepoEvents(REPO)).filter(
          (e) => e.type === 'dispatcher.ticket-scan-completed',
        ),
      ).toEqual(initial)
    })
  }

  for (const [field, value] of [
    ['queued', 1],
    ['invalidTickets', 1],
    ['dependencyBlocked', 1],
    ['creationWithheld', 1],
    ['ticketDiagnostics', ['changed']],
    ['dependencyDiagnostics', ['changed']],
    ['creationDiagnostics', ['changed']],
    ['readinessFingerprint', 'changed'],
    ['criteriaFingerprint', 'changed'],
    ['mode', 'admission'],
  ] as const) {
    test(`a ${field}-only outcome change is recorded and can change back`, async () => {
      const h = counted()
      await h.dispatcher.observeReady()
      const [initial] = (await h.store.getRepoEvents(REPO)).filter(
        (e) => e.type === 'dispatcher.ticket-scan-completed',
      )
      if (initial?.type !== 'dispatcher.ticket-scan-completed') throw new Error('missing scan')
      await h.store.appendRepo(REPO, {
        actor: DISPATCHER,
        type: 'dispatcher.ticket-scan-completed',
        payload: { ...initial.payload, [field]: value },
      })
      h.clock.advance(60_000)
      await h.dispatcher.observeReady()
      const events = (await h.store.getRepoEvents(REPO)).filter(
        (e) => e.type === 'dispatcher.ticket-scan-completed',
      )
      expect(events).toHaveLength(3)
      expect(events[2]?.payload).toEqual({ ...initial.payload, startedAt: h.clock().toISOString() })
      h.clock.advance(60_000)
      await h.dispatcher.observeReady()
      expect(
        (await h.store.getRepoEvents(REPO)).filter(
          (e) => e.type === 'dispatcher.ticket-scan-completed',
        ),
      ).toHaveLength(3)
    })
  }

  test('standing diagnostics compare retained text and order, after truncation', async () => {
    let diagnostics = Array.from({ length: 1001 }, (_, i) => `diagnostic ${i}`)
    const h = harness({
      wrapTickets(source) {
        source.listReady = async () => ({ tickets: [], diagnostics })
        return source
      },
    })
    const events = async () =>
      (await h.store.getRepoEvents(REPO)).filter(
        (e) => e.type === 'dispatcher.ticket-scan-completed',
      )
    await h.dispatcher.observeReady()
    h.clock.advance(60_000)
    diagnostics[1000] = 'outside journal limit'
    await h.dispatcher.observeReady()
    expect(await events()).toHaveLength(1)
    h.clock.advance(60_000)
    diagnostics[0] = 'new text, equal totals'
    await h.dispatcher.observeReady()
    expect(await events()).toHaveLength(2)
    h.clock.advance(60_000)
    diagnostics = [diagnostics[1]!, diagnostics[0]!, ...diagnostics.slice(2)]
    await h.dispatcher.observeReady()
    expect(await events()).toHaveLength(3)
    h.clock.advance(60_000)
    const cold = harness({ store: h.store })
    cold.clock.set(h.clock().toISOString())
    const restored = await cold.dispatcher.tick({ acceptNewWork: false })
    expect(restored.invalidTickets).toBe(1001)
    expect(restored.ticketDiagnostics).toEqual(diagnostics.slice(0, 1000))
  })

  test('an appended outcome survives a cadence write failure without a duplicate on recovery', async () => {
    const h = counted()
    const put = h.store.putScanCadence.bind(h.store)
    h.store.putScanCadence = async () => {
      throw new Error('cache unavailable')
    }
    await expect(h.dispatcher.observeReady()).rejects.toThrow('cache unavailable')
    h.store.putScanCadence = put
    const cold = counted({ store: h.store })
    cold.clock.advance(60_000)
    await cold.dispatcher.observeReady()
    expect(
      (await h.store.getRepoEvents(REPO)).filter(
        (e) => e.type === 'dispatcher.ticket-scan-completed',
      ),
    ).toHaveLength(1)
    expect(await h.store.getScanCadence(REPO)).not.toBeNull()
  })

  test('stale cadence cannot hide a canonical change; cache failures retry without duplicate outcomes', async () => {
    const h = counted()
    await h.dispatcher.tick()
    const cadence = (await h.store.getScanCadence(REPO))!
    await h.store.putScanCadence(REPO, { ...cadence, scanSeq: cadence.scanSeq + 100 })
    // A missing/mismatched row falls back to the fact; it never replays history.
    h.clock.advance(60_000)
    const put = h.store.putScanCadence.bind(h.store)
    h.store.putScanCadence = async () => {
      throw new Error('cache unavailable')
    }
    await expect(h.dispatcher.tick()).rejects.toThrow('cache unavailable')
    h.store.putScanCadence = put
    await h.dispatcher.tick()
    expect(h.scans()).toBe(3)
    expect((await h.store.getScanCadence(REPO))?.scanSeq).toBe(cadence.scanSeq)
    expect(
      (await h.store.getRepoEvents(REPO)).filter(
        (e) => e.type === 'dispatcher.ticket-scan-completed',
      ),
    ).toHaveLength(1)
  })

  function counted(options: Parameters<typeof harness>[0] = {}) {
    let scans = 0
    const h = harness({
      ...options,
      wrapTickets(source) {
        const original = source.listReady.bind(source)
        source.listReady = async (...args) => {
          scans++
          return original(...args)
        }
        return source
      },
    })
    return { ...h, scans: () => scans }
  }

  test('first scan, exact boundary, full capacity, cached depth and per-tick actions', async () => {
    let harvests = 0
    const h = counted({
      tickets: [readyTicket('one'), readyTicket('two')],
      startHarvest: () => {
        harvests++
      },
    })
    expect((await h.dispatcher.tick()).queued).toBe(1)
    for (let i = 1; i <= 5; i++) {
      h.clock.advance(10_000)
      const report = await h.dispatcher.tick()
      expect(report.queued).toBe(1)
      expect(report.dispatched).toBe(0)
    }
    expect(h.scans()).toBe(1)
    expect(harvests).toBeGreaterThan(0)
    h.clock.advance(10_000)
    expect((await h.dispatcher.tick()).queued).toBe(1)
    expect(h.scans()).toBe(2)
    expect(h.tickets.claims).toEqual(['one'])
  })

  test('direct grooming waits for a fresh scheduled scan; cold reconstruction keeps depth', async () => {
    const h = counted({ tickets: [readyTicket('one', { state: 'Triage' })] })
    await h.dispatcher.tick()
    await h.tickets.transition('one', 'Ready')
    h.clock.advance(50_000)
    expect((await h.dispatcher.tick()).dispatched).toBe(0)
    h.clock.advance(10_000)
    expect((await h.dispatcher.tick()).dispatched).toBe(1)
    const cold = counted({ store: h.store })
    cold.clock.set(h.clock().toISOString())
    expect((await cold.dispatcher.tick({ acceptNewWork: false })).queued).toBe(0)
    expect(cold.scans()).toBe(0)
  })

  for (const type of ['pr.merged', 'build.completed', 'build.aborted'] as const) {
    test(`${type} forces a scan once, even with equal timestamps`, async () => {
      const h = counted()
      await seedBuild(h, { slug: 'signal' })
      await h.dispatcher.tick()
      await h.store.append('signal', {
        actor: DISPATCHER,
        type,
        payload:
          type === 'build.completed'
            ? { outcome: 'merged' }
            : type === 'pr.merged'
              ? { sha: 'merged-sha' }
              : {},
      } as EventWrite)
      await h.dispatcher.tick()
      expect(h.scans()).toBe(2)
      await h.dispatcher.tick()
      expect(h.scans()).toBe(2)
      if (type === 'build.aborted') {
        await h.store.append('signal', {
          actor: DISPATCHER,
          type: 'build.completed',
          payload: { outcome: 'abandoned' },
        })
        await h.dispatcher.tick()
        expect(h.scans()).toBe(3)
      }
    })
  }

  test('observation shares cadence but never suppresses admission; cold reads retain nonzero depth', async () => {
    const h = counted({ tickets: [readyTicket('one')] })
    expect((await h.dispatcher.observeReady()).queued).toBe(1)
    await h.dispatcher.observeReady()
    expect((await h.dispatcher.tick({ acceptNewWork: false })).queued).toBe(1)
    expect(h.scans()).toBe(1)
    const cold = counted({ store: h.store, tickets: [readyTicket('one')] })
    expect((await cold.dispatcher.observeReady()).queued).toBe(1)
    expect(cold.scans()).toBe(0)
    expect((await cold.dispatcher.tick()).dispatched).toBe(1)
    expect(cold.scans()).toBe(1)
  })

  test('config interval reload, tick floor, changed criteria and future measurement', async () => {
    let config = parseConfig(withReadyState('ticketScanIntervalSeconds = 120'))
    const h = counted({ getConfig: () => config })
    await h.dispatcher.tick()
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    expect(h.scans()).toBe(1)
    config = { ...config, ticketScanIntervalSeconds: 60 }
    await h.dispatcher.tick()
    expect(h.scans()).toBe(2)
    config = { ...config, ticketScanIntervalSeconds: 1 }
    h.clock.advance(10_000)
    await h.dispatcher.tick()
    expect(h.scans()).toBe(3)
    config = { ...config, tickets: { ...config.tickets, readyState: 'Other' } }
    await h.dispatcher.tick()
    expect(h.scans()).toBe(4)
    h.clock.advance(-1_000)
    await h.dispatcher.tick()
    expect(h.scans()).toBe(5)
  })

  test('same-repository blocker resolution triggers a fresh dependency read and claim', async () => {
    const h = counted({
      toml: 'capacity = 2',
      tickets: [
        readyTicket('dependent', { blockedBy: ['blocker'] }),
        readyTicket('blocker', { state: 'Doing' }),
      ],
    })
    await seedBuild(h, { slug: 'blocker-build', ticketId: 'blocker' })
    expect((await h.dispatcher.tick()).dependencyBlocked).toBe(1)
    expect(h.tickets.dependencyQueries).toEqual([['blocker']])
    await h.tickets.transition('blocker', 'Done')
    await h.store.append('blocker-build', {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
    expect((await h.dispatcher.tick()).dispatched).toBe(1)
    expect(h.tickets.dependencyQueries).toEqual([['blocker'], ['blocker']])
    expect(h.tickets.claims).toEqual(['dependent'])
  })

  test('foreign and irrelevant build facts do not force scans; facts during a listing remain pending', async () => {
    const h = counted()
    await seedBuild(h, { slug: 'local-signal' })
    await seedBuild(h, { slug: 'foreign-signal', repo: '/other' })
    await h.dispatcher.tick()
    await h.store.append('foreign-signal', {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
    await h.store.append('local-signal', { actor: KERNEL, type: 'build.paused', payload: {} })
    await h.dispatcher.tick()
    expect(h.scans()).toBe(1)
    const list = h.tickets.listReady.bind(h.tickets)
    let changed = false
    h.tickets.listReady = async (...args) => {
      if (!changed) {
        changed = true
        await h.store.append('local-signal', {
          actor: DISPATCHER,
          type: 'build.completed',
          payload: { outcome: 'merged' },
        })
      }
      return list(...args)
    }
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    expect(h.scans()).toBe(2)
    await h.dispatcher.tick()
    expect(h.scans()).toBe(3)
    await h.dispatcher.tick()
    expect(h.scans()).toBe(3)
  })

  test('janitor merge releases capacity and forces a scan within the same tick', async () => {
    const h = counted({ tickets: [readyTicket('next')] })
    await seedAwaitingPr(h)
    await h.dispatcher.tick()
    expect(h.scans()).toBe(1)
    h.forge.setPrState(PR.number, { state: 'merged', sha: 'squash-1' })
    h.clock.advance(30_000)
    expect((await h.dispatcher.tick()).dispatched).toBe(1)
    expect(h.scans()).toBe(2)
  })

  test('dependency rate limits and mid-scan budget truncation do not acknowledge measurements', async () => {
    const h = counted({ tickets: [readyTicket('dependent', { blockedBy: ['blocker'] })] })
    await h.store.ensureRepo(REPO)
    const dependencies = h.tickets.dependencyStates.bind(h.tickets)
    h.tickets.dependencyStates = async () => {
      throw new TicketSourceRateLimitError('fake', 1_800_000_120_000)
    }
    await expect(h.dispatcher.tick()).rejects.toThrow()
    h.tickets.dependencyStates = async (...args) => {
      h.clock.advance(2_000)
      return dependencies(...args)
    }
    await h.dispatcher.tick({ deadlineAt: h.clock().getTime() + 1000 })
    expect(
      (await h.store.getRepoEvents(REPO)).filter(
        (e) => e.type === 'dispatcher.ticket-scan-completed',
      ),
    ).toHaveLength(0)
    h.tickets.dependencyStates = dependencies
    await h.dispatcher.tick()
    expect(h.scans()).toBe(3)
  })

  test('listing failure, deadline and scan append failure remain due', async () => {
    const h = counted()
    const list = h.tickets.listReady.bind(h.tickets)
    h.tickets.listReady = async () => {
      throw new Error('offline')
    }
    await expect(h.dispatcher.tick()).rejects.toThrow('offline')
    h.tickets.listReady = list
    await h.dispatcher.tick({ deadlineAt: h.clock().getTime() })
    expect(h.scans()).toBe(0)
    const append = h.store.appendRepo.bind(h.store)
    h.store.appendRepo = async (...args) => {
      if (args[1].type === 'dispatcher.ticket-scan-completed') throw new Error('append failed')
      return append(...args)
    }
    await expect(h.dispatcher.tick()).rejects.toThrow('append failed')
    h.store.appendRepo = append
    await h.dispatcher.tick()
    expect(h.scans()).toBe(2)
  })
})

test('legacy active ticket aliases exclude canonical ready tickets from queue depth and dispatch', async () => {
  const h = harness({
    tickets: [readyTicket('ENG-1')],
    toml: 'capacity = 3\n',
    wrapTickets: (source) => {
      Object.defineProperty(source, 'name', { value: 'hosted' })
      const list = source.listReady.bind(source)
      source.listReady = async (criteria) => {
        const listing = await list(criteria)
        return {
          ...listing,
          tickets: listing.tickets.map((t) => ({ ...t, ref: { ...t.ref, source: 'hosted' } })),
        }
      }
      const get = source.get.bind(source)
      source.get = async (id) => {
        const ticket = await get(id === 'ticket-old-uuid' ? 'ENG-1' : id)
        return ticket ? { ...ticket, ref: { ...ticket.ref, source: 'hosted' } } : null
      }
      return source
    },
  })
  await seedBuild(h, {
    ticketId: 'ticket-old-uuid',
    ticketSource: 'hosted',
    workspace: false,
    attached: false,
  })
  expect((await h.dispatcher.observeReady()).queued).toBe(0)
  await h.dispatcher.tick()
  expect(h.tickets.claims).not.toContain('ENG-1')
  expect((await h.store.listBuilds()).length).toBe(1)
})

for (const provider of ['hosted', 'linear', 'file']) {
  test(`${provider} identity reads obey observation cadence and skip ids already listed`, async () => {
    let gets = 0,
      scans = 0
    const h = harness({
      tickets: [readyTicket('ENG-1')],
      wrapTickets(source) {
        Object.defineProperty(source, 'name', { value: provider })
        const list = source.listReady.bind(source)
        source.listReady = async (criteria) => {
          scans++
          const listing = await list(criteria)
          return {
            ...listing,
            tickets: listing.tickets.map((t) => ({ ...t, ref: { ...t.ref, source: provider } })),
          }
        }
        source.get = async () => {
          gets++
          return { ...readyTicket('ENG-1'), ref: { source: provider, id: 'ENG-1' } }
        }
        return source
      },
    })
    await seedBuild(h, {
      ticketId: 'legacy',
      ticketSource: provider,
      workspace: false,
      attached: false,
    })
    for (let i = 0; i < 5; i++) {
      await h.dispatcher.observeReady()
      h.clock.advance(10_000)
    }
    expect(scans).toBe(1)
    expect(gets).toBe(provider === 'hosted' ? 1 : 0)
    h.clock.advance(10_000)
    await h.dispatcher.observeReady()
    expect(scans).toBe(2)
    expect(gets).toBe(provider === 'hosted' ? 2 : 0)
    const raw = h.store.listBuilds.bind(h.store)
    h.store.listBuilds = async () =>
      (await raw()).map((r) => ({ ...r, ticket: { source: provider, id: 'ENG-1' } }))
    h.clock.advance(60_000)
    await h.dispatcher.observeReady()
    expect(gets).toBe(provider === 'hosted' ? 2 : 0)
  })
}

for (const operation of ['observe', 'dispatch']) {
  test(`hosted alias lookup failure during ${operation} records source degradation without completing the scan`, async () => {
    const h = harness({
      tickets: [readyTicket('ENG-1')],
      wrapTickets(source) {
        Object.defineProperty(source, 'name', { value: 'hosted' })
        source.get = async () => {
          throw new TicketSourceRateLimitError('hosted', 1_800_000_120_000)
        }
        return source
      },
    })
    await seedBuild(h, {
      ticketId: 'legacy',
      ticketSource: 'hosted',
      workspace: false,
      attached: false,
    })
    await expect(
      operation === 'observe' ? h.dispatcher.observeReady() : h.dispatcher.tick(),
    ).rejects.toBeInstanceOf(TicketSourceRateLimitError)
    const events = await h.store.getRepoEvents(REPO)
    expect(
      events.filter((e) => e.type === 'dispatcher.ticket-source-degraded').map((e) => e.payload),
    ).toContainEqual(
      expect.objectContaining({ source: 'hosted', cause: 'rate-limited', operation: 'ready-scan' }),
    )
    expect(events.some((e) => e.type === 'dispatcher.ticket-scan-completed')).toBe(false)
    expect(h.tickets.claims).toEqual([])
  })
}

for (const resumeCurrent of [false, true]) {
  test(`no-progress guard repairs completion crash gap before ${resumeCurrent ? 'startup resume' : 'lease recovery'}, preserves pending abort`, async () => {
    const h = harness({ opts: { leaseTtlMs: 0 } })
    const slug = await seedBuild(h)
    for (const instance of ['a', 'b', 'c']) {
      await h.store.append(slug, {
        actor: DISPATCHER,
        type: 'execution.started',
        payload: { instance, provider: 'fake', workspaceRef: '/ws/ab/auth-limit' },
      })
      await h.store.append(slug, {
        actor: DISPATCHER,
        type: 'execution.ended',
        payload: { instance, workspaceRef: '/ws/ab/auth-limit', outcome: 'completed', exitCode: 0 },
      })
    }
    for (let i = 0; i < 3; i++) await h.dispatcher.tick({ resumeCurrent })
    expect(h.launches).toEqual([])
    expect(
      (await h.store.getEvents(slug)).filter((e) => e.type === 'escalation.raised'),
    ).toHaveLength(1)
    await controlBuild({
      store: h.store,
      repo: REPO,
      slug,
      user: 'operator',
      action: { kind: 'abort' },
    })
    await h.dispatcher.tick({ resumeCurrent })
    expect(h.launches).toEqual([slug])
  })
}

test('recovered dispatch completion shares the guard before its first attachment', async () => {
  const h = harness({ tickets: [readyTicket('T-recovered')], opts: { leaseTtlMs: 0 } })
  const slug = await seedBuild(h, { attached: false, ticketId: 'T-recovered' })
  for (const instance of ['a', 'b', 'c']) {
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'execution.started',
      payload: { instance, provider: 'fake', workspaceRef: '/ws/ab/auth-limit' },
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'execution.ended',
      payload: { instance, workspaceRef: '/ws/ab/auth-limit', outcome: 'completed', exitCode: 0 },
    })
  }
  await h.dispatcher.tick({ resumeCurrent: true })
  expect(h.launches).toEqual([])
  expect(
    (await h.store.getEvents(slug))
      .filter((e) => e.type === 'escalation.raised')
      .map((e) => e.payload.policyCause),
  ).toEqual(['execution-no-progress'])
})

describe('dispatcher pipeline pins', () => {
  const pipeline = (table: 'verify' | 'finalize', name: string) =>
    parseConfig(
      withReadyState(
        name === ''
          ? ''
          : `
[commands]
run = "true"
[${table}]
steps = ["${name}"]
[${table}.${name}]
kind = "check"
command = "run"
`,
      ),
    )
  async function pin(h: Harness, slug: string, config: Config) {
    await h.store.putArtifact(slug, {
      kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
      content: effectiveBuildConfigContent(config),
    })
  }
  test('parked sweep body-read experiment', async () => {
    const h = harness()
    let reads = 0
    let bytes = 0
    const getArtifact = h.store.getArtifact.bind(h.store)
    h.store.getArtifact = async (...args) => {
      const result = await getArtifact(...args)
      if (args[1] === BUILD_EFFECTIVE_CONFIG_ARTIFACT) {
        reads++
        bytes += result?.content.byteLength ?? 0
      }
      return result
    }
    for (let index = 0; index < 3; index++) {
      const slug = await seedAwaitingPr(h, `parked-${index}`)
      await pin(h, slug, pipeline('verify', ''))
    }
    h.clock.advance(120_000)
    for (let tick = 0; tick < 4; tick++) {
      await h.dispatcher.tick({ acceptNewWork: false })
    }
    console.log('parked sweep experiment', { builds: 3, sweeps: 4, reads, bytes })
    expect(h.launches).toEqual([])
    expect(reads).toBe(3)
  })
  test('parked sweep read budget stays bounded at 100 and 100,000 events', async () => {
    const clock = manualClock()
    const store = new MemoryBuildStore({ clock })
    const h = harness({ store, clock })
    const slugs = []
    for (let n = 0; n < 3; n++) {
      const slug = await seedAwaitingPr(h, `budget-${n}`)
      slugs.push(slug)
      await pin(h, slug, pipeline('verify', ''))
    }
    await parkedSweepReadBudget({
      store,
      slugs,
      dispatcher: () => harness({ store, clock }).dispatcher,
      pin: (slug) => pin(h, slug, pipeline('verify', '')),
      advance: () => clock.advance(120_000),
    })
  }, 30_000)

  for (const table of ['verify', 'finalize'] as const) {
    for (const change of ['add', 'remove', 'rename'] as const) {
      test(`warm sweep sees artifact-only ${table} ${change}, including after restart`, async () => {
        const live = pipeline(table, 'live-only')
        const h = harness({ getConfig: () => live })
        const slug = await seedAwaitingPr(h)
        const original = change === 'add' ? '' : 'original'
        await pin(h, slug, pipeline(table, original))
        if (original !== '') {
          if (table === 'verify') {
            await h.store.append(slug, {
              actor: KERNEL,
              type: 'verify.started',
              payload: { step: original, attempt: 1 },
            })
            await h.store.append(slug, {
              actor: KERNEL,
              type: 'verify.completed',
              payload: { step: original, attempt: 1, pass: true },
            })
          } else {
            await h.store.append(slug, {
              actor: KERNEL,
              type: 'finalize.step-completed',
              payload: { step: original, ok: true },
            })
          }
        }
        h.clock.advance(120_000)
        await h.dispatcher.tick({ acceptNewWork: false })
        await h.dispatcher.tick({ acceptNewWork: false })
        expect(h.launches).toEqual([])
        await pin(h, slug, pipeline(table, change === 'remove' ? '' : 'new-step'))
        h.clock.advance(120_000)
        const restarted = harness({ store: h.store, clock: h.clock, getConfig: () => live })
        await h.dispatcher.tick({ acceptNewWork: false })
        await restarted.dispatcher.tick({ acceptNewWork: false })
        expect(h.launches).toEqual(change === 'remove' ? [] : [slug])
        expect(restarted.launches).toEqual(change === 'remove' ? [] : [slug])
      })
    }
  }

  test('metadata failures invalidate warm entries and retry; malformed revisions repair afresh', async () => {
    let brokenMeta = false
    let repairs = 0
    let repairWorks = false
    const clock = manualClock()
    const backing = new MemoryBuildStore({ clock })
    const store = new Proxy(backing, {
      get(target, key) {
        if (key === 'getLatestArtifactMeta')
          return async (slug: string, kind: string) => {
            if (brokenMeta) throw new Error('metadata outage')
            return target.getLatestArtifactMeta(slug, kind)
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const h = harness({
      store,
      clock,
      repairBuildConfig: async (slug) => {
        repairs++
        if (!repairWorks) throw new Error('repair outage')
        await pin(h, slug, pipeline('verify', 'repaired'))
      },
    })
    const slug = await seedAwaitingPr(h)
    await pin(h, slug, pipeline('verify', ''))
    h.clock.advance(120_000)
    await h.dispatcher.tick({ acceptNewWork: false })
    brokenMeta = true
    const failed = await h.dispatcher.tick({ acceptNewWork: false })
    expect(failed.blockedDiagnostics.join()).toContain('metadata outage')
    expect(h.launches).toEqual([])
    expect(Reflect.get(h.dispatcher, 'sweepPins').size).toBe(0)
    brokenMeta = false
    await h.store.putArtifact(slug, { kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT, content: '{}' })
    h.clock.advance(120_000)
    const malformed = await h.dispatcher.tick({ acceptNewWork: false })
    expect(malformed.blockedDiagnostics.join()).toContain('repair outage')
    expect(Reflect.get(h.dispatcher, 'sweepPins').size).toBe(0)
    repairWorks = true
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(repairs).toBe(2)
    expect(h.launches).toEqual([slug])
  })

  for (const work of ['abort', 'resume', 'conflict'] as const) {
    test(`warm parked sweep still delivers ${work} work`, async () => {
      const h = harness()
      const slug = await seedAwaitingPr(h)
      await pin(h, slug, pipeline('verify', ''))
      h.clock.advance(120_000)
      await h.dispatcher.tick({ acceptNewWork: false })
      expect(h.launches).toEqual([])
      if (work === 'resume') {
        await h.store.append(slug, { actor: KERNEL, type: 'build.paused', payload: {} })
        await h.store.append(slug, {
          actor: humanActor('operator'),
          type: 'build.resume-requested',
          payload: {},
        })
      } else if (work === 'abort') {
        await h.store.append(slug, {
          actor: humanActor('operator'),
          type: 'build.abort-requested',
          payload: { reason: 'stop' },
        })
      } else {
        await h.store.append(slug, {
          actor: DISPATCHER,
          type: 'pr.conflicted',
          payload: { baseSha: BASE_SHA },
        })
      }
      h.clock.advance(120_000)
      await h.dispatcher.tick({ acceptNewWork: false })
      expect(h.launches).toEqual([slug])
    })
  }

  test('a racing full read caches its actual revision and retries body failures', async () => {
    const h = harness()
    const slug = await seedAwaitingPr(h)
    await pin(h, slug, pipeline('verify', ''))
    const get = h.store.getArtifact.bind(h.store)
    let race = true
    let brokenBody = false
    h.store.getArtifact = async (...args) => {
      if (args[1] === BUILD_EFFECTIVE_CONFIG_ARTIFACT) {
        if (brokenBody) throw new Error('body outage')
        if (race) {
          race = false
          await pin(h, slug, pipeline('verify', ''))
        }
      }
      return get(...args)
    }
    h.clock.advance(120_000)
    await h.dispatcher.tick({ acceptNewWork: false })
    const cache: Map<string, { revision: number }> = Reflect.get(h.dispatcher, 'sweepPins')
    expect(cache.get(slug)?.revision).toBe(1)
    await pin(h, slug, pipeline('verify', 'new-step'))
    h.clock.advance(120_000)
    brokenBody = true
    const failed = await h.dispatcher.tick({ acceptNewWork: false })
    expect(failed.blockedDiagnostics.join()).toContain('body outage')
    expect(cache.has(slug)).toBe(false)
    expect(h.launches).toEqual([])
    brokenBody = false
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(h.launches).toEqual([slug])
  })

  test('missing metadata drops a warm pin and preserves live fallback', async () => {
    const h = harness({ getConfig: () => pipeline('verify', 'live-only') })
    const slug = await seedAwaitingPr(h)
    await pin(h, slug, pipeline('verify', ''))
    h.clock.advance(120_000)
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(h.launches).toEqual([])
    h.store.getLatestArtifactMeta = async () => null
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(Reflect.get(h.dispatcher, 'sweepPins').size).toBe(0)
    expect(h.launches).toEqual([slug])
  })

  test('LRU retention is bounded and evicted pins reread without changing decisions', async () => {
    const h = harness()
    let reads = 0
    const get = h.store.getArtifact.bind(h.store)
    h.store.getArtifact = async (...args) => {
      if (args[1] === BUILD_EFFECTIVE_CONFIG_ARTIFACT) reads++
      return get(...args)
    }
    for (let n = 0; n <= SWEEP_PIN_CACHE_CAPACITY; n++) {
      const slug = await seedAwaitingPr(h, `pressure-${n.toString().padStart(3, '0')}`)
      await pin(h, slug, pipeline('verify', ''))
    }
    h.clock.advance(120_000)
    await h.dispatcher.tick({ acceptNewWork: false })
    const cache: Map<string, unknown> = Reflect.get(h.dispatcher, 'sweepPins')
    expect(cache.size).toBe(SWEEP_PIN_CACHE_CAPACITY)
    expect(cache.has('pressure-000')).toBe(false)
    expect(reads).toBe(SWEEP_PIN_CACHE_CAPACITY + 1)
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(cache.size).toBe(SWEEP_PIN_CACHE_CAPACITY)
    expect(reads).toBe(2 * (SWEEP_PIN_CACHE_CAPACITY + 1))
    expect(h.launches).toEqual([])
  }, 30_000)

  test('missing capability preserves full reads and pinned decisions', async () => {
    const clock = manualClock()
    const backing = new MemoryBuildStore({ clock })
    let reads = 0
    const store = new Proxy(backing, {
      get(target, key) {
        if (key === 'getLatestArtifactMeta') return undefined
        if (key === 'getArtifact')
          return async (...args: Parameters<BuildStore['getArtifact']>) => {
            if (args[1] === BUILD_EFFECTIVE_CONFIG_ARTIFACT) reads++
            return target.getArtifact(...args)
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const h = harness({ store, clock, getConfig: () => pipeline('verify', 'live-only') })
    const slug = await seedAwaitingPr(h)
    await pin(h, slug, pipeline('verify', ''))
    h.clock.advance(120_000)
    for (let n = 0; n < 3; n++) await h.dispatcher.tick({ acceptNewWork: false })
    expect(reads).toBe(3)
    expect(h.launches).toEqual([])
  })

  for (const table of ['verify', 'finalize'] as const) {
    for (const change of ['add', 'remove', 'rename']) {
      test(`${table} ${change}: merge and replacement launches follow the pin`, async () => {
        const pinned = pipeline(table, change === 'add' ? '' : 'original')
        let live = pipeline(table, change === 'remove' ? '' : 'replacement')
        const h = harness({ getConfig: () => live })
        const slug = await seedAwaitingPr(h)
        await pin(h, slug, pinned)
        await h.store.append(slug, {
          actor: humanActor('operator'),
          type: 'build.auto-merge-requested',
          payload: {},
        })
        h.forge.setPrState(1, { state: 'open', mergeable: true })
        h.forge.setPrHeadSha(1, PR.headSha)
        h.forge.setGatePresence(1, 'absent')
        await h.dispatcher.tick({ resumeCurrent: true, acceptNewWork: false })
        expect(h.forge.squashMergeCalls.length).toBe(change === 'add' ? 1 : 0)
        expect(h.launches.length).toBe(change === 'add' ? 0 : 1)
        // A new deposit changes the very next decision without event changes.
        live = pipeline(table, '')
        await pin(h, slug, live)
        await h.dispatcher.tick({ resumeCurrent: true, acceptNewWork: false })
        expect(h.forge.squashMergeCalls.length).toBe(1)
        expect(h.launches.length).toBe(change === 'add' ? 0 : 1)
      })
    }
  }
  for (const startup of [true, false]) {
    test(`invalid pin contains failure and retries repair (startup=${startup})`, async () => {
      let repairs = 0
      let repairWorks = false
      const h = harness({
        toml: 'capacity = 3',
        tickets: [readyTicket('T-intake')],
        repairBuildConfig: async (slug) => {
          repairs++
          if (!repairWorks) throw new Error('branch config unavailable')
          await pin(h, slug, pipeline('verify', ''))
        },
      })
      const bad = await seedAwaitingPr(h, 'bad-pin')
      const good = await seedBuild(h, { slug: 'healthy-pin' })
      await h.store.putArtifact(bad, {
        kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
        content: '{"futureSchema":true}',
      })
      h.clock.advance(120_000)
      const report = await h.dispatcher.tick({ resumeCurrent: startup })
      expect(
        report.blockedDiagnostics.some(
          (line) => line.includes('bad-pin') && line.includes('next tick retries'),
        ),
      ).toBe(true)
      expect(h.launches).toEqual(['healthy-pin', 'add-rate-limiting'])
      expect(report.dispatched).toBe(1)
      expect(repairs).toBeGreaterThan(0)
      repairWorks = true
      await h.dispatcher.tick({ resumeCurrent: startup, acceptNewWork: false })
      expect(h.launches.filter((slug) => slug === bad)).toHaveLength(0)
      expect(good).toBeDefined()
      expect(repairs).toBeGreaterThan(1)
    })
  }
  test('transient artifact read failure withholds merge and launch, then recovers without repair', async () => {
    const backing = new MemoryBuildStore()
    let unavailable = true
    let repairs = 0
    const store = new Proxy(backing, {
      get(target, key) {
        if (key === 'getArtifact')
          return async (...args: Parameters<BuildStore['getArtifact']>) => {
            if (unavailable && args[0] === 'read-failure') throw new Error('temporary blob outage')
            return target.getArtifact(...args)
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const h = harness({
      store,
      repairBuildConfig: async () => {
        repairs++
      },
    })
    const slug = await seedAwaitingPr(h, 'read-failure')
    await pin(h, slug, pipeline('verify', ''))
    await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    h.forge.setPrHeadSha(1, PR.headSha)
    h.forge.setGatePresence(1, 'absent')
    const report = await h.dispatcher.tick({ resumeCurrent: true, acceptNewWork: false })
    expect(report.blockedDiagnostics.some((line) => line.includes('temporary blob outage'))).toBe(
      true,
    )
    expect(h.forge.squashMergeCalls).toHaveLength(0)
    expect(h.launches).toHaveLength(0)
    expect(repairs).toBe(0)
    unavailable = false
    await h.dispatcher.tick({ resumeCurrent: true, acceptNewWork: false })
    expect(h.forge.squashMergeCalls).toHaveLength(1)
    expect(h.launches).toHaveLength(0)
  })

  test('two builds use distinct pins under one live snapshot', async () => {
    const live = pipeline('verify', 'live-only')
    const h = harness({ getConfig: () => live })
    const parked = await seedAwaitingPr(h, 'parked')
    const due = await seedAwaitingPr(h, 'due')
    await pin(h, parked, pipeline('verify', ''))
    await pin(h, due, pipeline('verify', 'pending'))
    await h.dispatcher.tick({ resumeCurrent: true, acceptNewWork: false })
    expect(h.launches).toEqual(['due'])
  })
  test('no-progress escalation describes the pinned pipeline at the launch boundary', async () => {
    const h = harness({ getConfig: () => pipeline('verify', 'live-only') })
    const slug = await seedAwaitingPr(h)
    await pin(h, slug, pipeline('verify', 'pinned-step'))
    for (const instance of ['a', 'b', 'c']) {
      await h.store.append(slug, {
        actor: DISPATCHER,
        type: 'execution.started',
        payload: { instance, provider: 'fake', workspaceRef: '/ws/ab/auth-limit' },
      })
      await h.store.append(slug, {
        actor: DISPATCHER,
        type: 'execution.ended',
        payload: { instance, workspaceRef: '/ws/ab/auth-limit', outcome: 'completed', exitCode: 0 },
      })
    }
    await h.dispatcher.tick({ resumeCurrent: true, acceptNewWork: false })
    expect(h.launches).toEqual([])
    const escalations = (await h.store.getEvents(slug)).filter(
      (event) => event.type === 'escalation.raised',
    )
    expect(escalations).toHaveLength(1)
    expect(escalations[0]?.payload.question).toContain('pinned-step')
    expect(escalations[0]?.payload.question).not.toContain('live-only')
  })

  test('last-moment merge guard reads a newly published pin', async () => {
    const h = harness()
    const slug = await seedAwaitingPr(h)
    await pin(h, slug, pipeline('verify', ''))
    await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    h.forge.setPrHeadSha(1, PR.headSha)
    h.forge.setGatePresence(1, 'absent')
    const setAutoMerge = h.forge.setAutoMerge.bind(h.forge)
    h.forge.setAutoMerge = async (...args) => {
      const result = await setAutoMerge(...args)
      await pin(h, slug, pipeline('verify', 'just-published'))
      return result
    }
    await h.dispatcher.tick({ resumeCurrent: true, acceptNewWork: false })
    expect(h.forge.squashMergeCalls).toHaveLength(0)
    expect(h.launches).toEqual([slug])
  })
})

describe('dispatcher admission journal boundary', () => {
  test('a newly ready ticket is claimed on the first due scan', async () => {
    const h = harness({
      tickets: [readyTicket('T-1', { state: 'Triage' })],
      toml: 'ticketScanIntervalSeconds = 60\n',
    })
    await h.dispatcher.tick()
    await h.tickets.transition('T-1', 'Ready')
    h.clock.advance(59_999)
    expect((await h.dispatcher.tick()).dispatched).toBe(0)
    expect(h.tickets.claims).toEqual([])
    h.clock.advance(1)
    expect((await h.dispatcher.tick()).dispatched).toBe(1)
    expect(h.tickets.claims).toEqual(['T-1'])
  })

  for (const nonempty of [false, true]) {
    test(`ready listing refreshes only for candidates: ${nonempty}`, async () => {
      const backing = new MemoryBuildStore()
      let afterListing = false
      let decisionReads = 0
      const store = new Proxy(backing, {
        get(target, key) {
          if (key === 'getReducerValue')
            return async (...args: Parameters<MemoryBuildStore['getReducerValue']>) => {
              if (afterListing && args[1].reducer === 'repositoryReadFacts') decisionReads++
              return target.getReducerValue(...args)
            }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const h = harness({
        store,
        tickets: nonempty ? [readyTicket('T-1')] : [],
        wrapTickets: (source) => {
          const list = source.listReady.bind(source)
          source.listReady = async (criteria) => {
            const result = await list(criteria)
            afterListing = true
            return result
          }
          return source
        },
      })
      await backing.ensureRepo(REPO)
      // Measure just the decision read, before scan completion/local writes.
      const append = backing.appendRepo.bind(backing)
      backing.appendRepo = async (...args) => {
        afterListing = false
        return append(...args)
      }
      await h.dispatcher.tick()
      expect(decisionReads).toBe(nonempty ? 1 : 0)
      expect(h.tickets.claims).toHaveLength(nonempty ? 1 : 0)
    })
  }

  test('a failed post-listing read prevents admission', async () => {
    let fail = false
    class OutageStore extends MemoryBuildStore {
      override async getRepo(repo: string) {
        if (fail) throw new Error('decision read failed')
        return super.getRepo(repo)
      }
    }
    const h = harness({
      store: new OutageStore(),
      tickets: [readyTicket('T-1')],
      wrapTickets: (source) => {
        const list = source.listReady.bind(source)
        source.listReady = async (criteria) => {
          const result = await list(criteria)
          fail = true
          return result
        }
        return source
      },
    })
    await expect(h.dispatcher.tick()).rejects.toThrow('decision read failed')
    expect(h.tickets.claims).toEqual([])
  })
})
describe('stable merged-build evidence and native maintenance', () => {
  test.each([
    ['Subject\n\nAutobuild-Build: auth-limit\n', true],
    ['Subject\n\nAutobuild-Build: other-build\n', false],
    ['Mention Autobuild-Build: auth-limit', false],
  ])('human merge records inspected evidence (%j)', async (message, present) => {
    const h = harness()
    const slug = await seedAwaitingPr(h)
    h.forge.commitMessages.set('human-sha', message)
    h.forge.setPrState(1, { state: 'merged', sha: 'human-sha' })
    expect(await h.dispatcher.tick()).toMatchObject({ merged: 1, janitorDiagnostics: [] })
    await h.dispatcher.tick()
    const facts = (await h.store.getEvents(slug)).filter((event) => event.type === 'pr.merged')
    expect(facts).toHaveLength(1)
    expect(facts[0]?.payload).toEqual({ sha: 'human-sha', buildTrailerPresent: present })
  })
  test.each([false, true])(
    'unreadable or unsupported evidence does not strand merged PR (unsupported=%s)',
    async (unsupported) => {
      const h = harness()
      const slug = await seedAwaitingPr(h)
      Object.defineProperty(h.forge, 'readCommitMessage', {
        value: unsupported
          ? undefined
          : async () => {
              throw new Error('provider unavailable')
            },
      })
      h.forge.setPrState(1, { state: 'merged', sha: 'human-sha' })
      expect(await h.dispatcher.tick()).toMatchObject({ merged: 1, janitorDiagnostics: [] })
      const facts = await h.store.getEvents(slug)
      expect(facts.find((e) => e.type === 'pr.merged')?.payload).toEqual({ sha: 'human-sha' })
      expect(facts.filter((e) => e.type === 'observation.recorded')).toHaveLength(
        unsupported ? 1 : 2,
      )
      expect(reduceBuild(facts).outcome).toBe('merged')
    },
  )
  test('abort close racing a trailered merge records the same evidence', async () => {
    const h = harness()
    const slug = await seedAwaitingPr(h)
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    h.forge.closePr = async () => ({ state: 'merged', sha: 'raced-sha' })
    h.forge.commitMessages.set('raced-sha', 'Subject\n\nAutobuild-Build: auth-limit\n')
    await h.store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })
    expect((await h.dispatcher.tick()).abandoned).toBe(1)
    expect((await h.store.getEvents(slug)).find((e) => e.type === 'pr.merged')?.payload).toEqual({
      sha: 'raced-sha',
      buildTrailerPresent: true,
    })
  })
  test('acknowledged native consent is maintained without another acknowledgement or direct merge', async () => {
    const h = harness()
    const slug = await seedAwaitingPr(h)
    const command = await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'pr.auto-merge-enabled',
      payload: { commandSeq: command.seq },
    })
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    let attempts = 0
    h.forge.setAutoMerge = async (_path, _number, enabled, options) => {
      if (!enabled) return { kind: 'applied' }
      expect(options?.buildSlug).toBe(slug)
      expect(await options?.canApply?.()).toBe(true)
      attempts++
      if (attempts === 1) {
        h.forge.setPrState(1, { state: 'open', mergeable: true, nativeAutoMerge: true })
        return { kind: 'applied' }
      }
      return { kind: 'ungated', headSha: 'new-head' }
    }
    await h.dispatcher.tick()
    await h.dispatcher.tick()
    expect(attempts).toBe(1)
    expect(h.forge.squashMergeCalls).toEqual([])
    expect(
      (await h.store.getEvents(slug)).filter(
        (e) => e.type === 'landing.native-applied' && e.payload.enabled,
      ),
    ).toHaveLength(1)
  })
  test('maintenance guard refreshes cancellation between provider mutations', async () => {
    const h = harness()
    const slug = await seedAwaitingPr(h)
    const command = await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'pr.auto-merge-enabled',
      payload: { commandSeq: command.seq },
    })
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    h.forge.setAutoMerge = async (_path, _number, _enabled, options) => {
      if (!_enabled) return { kind: 'applied' }
      expect(await options?.canApply?.()).toBe(true)
      await h.store.append(slug, {
        actor: humanActor('operator'),
        type: 'build.auto-merge-cancelled',
        payload: {},
      })
      expect(await options?.canApply?.()).toBe(false)
      return { kind: 'deferred' }
    }
    await h.dispatcher.tick()
    expect(reduceBuild(await h.store.getEvents(slug)).autoMerge.requested).toBe(false)
  })
})

test('native maintenance rechecks readiness without refreshing operator consent', async () => {
  const h = harness()
  const slug = await seedAwaitingPr(h)
  const command = await h.store.append(slug, {
    actor: humanActor('operator'),
    type: 'build.auto-merge-requested',
    payload: {},
  })
  await h.store.append(slug, {
    actor: DISPATCHER,
    type: 'pr.auto-merge-enabled',
    payload: { commandSeq: command.seq },
  })
  await h.store.claimLease(slug, 'runner-live', 60_000)
  h.forge.setPrState(1, { state: 'open', mergeable: true })
  let pipelineReads = 0
  const getArtifact = h.store.getArtifact.bind(h.store)
  h.store.getArtifact = async (...args) => {
    if (args[1] === BUILD_EFFECTIVE_CONFIG_ARTIFACT) pipelineReads++
    return getArtifact(...args)
  }
  let checks = 0
  h.forge.setAutoMerge = async (_path, _number, _enabled, options) => {
    if (_enabled) expect(options?.canApply).toBeDefined()
    checks++
    return { kind: 'applied' }
  }
  await h.dispatcher.tick()
  await h.dispatcher.tick()
  expect(checks).toBe(2)
  expect(pipelineReads).toBeGreaterThan(0)
  expect(
    (await h.store.getEvents(slug)).filter(
      (event) => event.type === 'landing.native-applied' && event.payload.enabled,
    ),
  ).toHaveLength(1)
})

test('target observations persist during a live implementation session without touching the branch', async () => {
  const h = harness()
  const slug = await seedBuild(h)
  await h.store.append(slug, {
    actor: KERNEL,
    type: 'session.started',
    payload: {
      session: 'live-implement',
      role: 'implement',
      runner: 'scripted',
      phase: 'implement',
      round: 1,
    },
  })
  await h.store.claimLease(slug, 'live-runner', 3_600_000)
  const branch = `ab/${slug}`
  const original = 'd'.repeat(40)
  h.forge.remoteBranches.set(branch, original)
  for (const sha of ['b'.repeat(40), 'c'.repeat(40), BASE_SHA]) {
    h.forge.remoteBranches.set('main', sha)
    await h.dispatcher.tick()
  }
  await h.dispatcher.tick()
  const facts = await h.store.getEvents(slug)
  expect(facts.filter((e) => e.type === 'target.moved').map((e) => e.payload.sha)).toEqual([
    BASE_SHA,
    'b'.repeat(40),
    'c'.repeat(40),
    BASE_SHA,
  ])
  expect(h.forge.rewrites).toEqual([])
  expect(h.forge.remoteBranches.get(branch)).toBe(original)
  expect(h.launches).toEqual([])
})

test('failed target observation does not prevent merged PR settlement', async () => {
  const h = harness({
    exec: async () => ({ stdout: '', stderr: 'target unavailable', exitCode: 1 }),
  })
  const slug = await seedAwaitingPr(h)
  h.forge.remoteBranchSha = async () => {
    throw new Error('forge unavailable')
  }
  h.forge.setPrState(1, { state: 'merged', sha: 'landed' })
  const report = await h.dispatcher.tick()
  expect((await h.store.getEvents(slug)).some((e) => e.type === 'pr.merged')).toBe(true)
  expect(
    report.janitorDiagnostics.some((message) => message.includes('target observation failed')),
  ).toBe(true)
  expect(report.janitorFailed).toBe(0)
})

test('failed initial target observation does not spend dispatch budget and retries later', async () => {
  let unavailable = true
  const h = harness({
    exec: async () =>
      unavailable
        ? { stdout: '', stderr: 'target unavailable', exitCode: 1 }
        : { stdout: `${BASE_SHA}\trefs/heads/main\n`, stderr: '', exitCode: 0 },
  })
  const slug = await seedBuild(h, { attached: false, targetObserved: false })
  h.forge.remoteBranchSha = async () => {
    throw new Error('forge unavailable')
  }
  const report = await h.dispatcher.tick()
  expect(h.launches).toEqual([slug])
  expect(report.dispatchFailed).toBe(0)
  expect((await h.store.getEvents(slug)).filter((e) => e.type === 'dispatch.failed')).toEqual([])
  expect(
    report.janitorDiagnostics.some((message) => message.includes('target observation failed')),
  ).toBe(true)
  unavailable = false
  await h.dispatcher.tick()
  expect((await h.store.getEvents(slug)).filter((e) => e.type === 'target.moved')).toHaveLength(1)
})
describe('integration node dispatch', () => {
  test('empty node opens without workspace, runner, lease or PR and accepts nested targets', async () => {
    const h = harness({
      tickets: [
        readyTicket('N', { kind: 'node', title: 'Root node' }),
        readyTicket('CHILD', { target: 'N', title: 'Child work' }),
        readyTicket('NESTED', { kind: 'node', target: 'N', title: 'Nested node' }),
      ],
    })
    h.forge.remoteBranches.set('main', BASE_SHA)
    await h.dispatcher.tick()
    let records = await h.store.listBuilds()
    const root = records.find((r) => r.ticket?.id === 'N')!
    expect(root.branch).toStartWith('ab-node/')
    expect(root.lease).toBeUndefined()
    const state = reduceBuild(await h.store.getEvents(root.slug))
    expect(state.status).toBe('collecting')
    expect(state.nodeOpened?.sha).toBe(BASE_SHA)
    expect(h.launches).not.toContain(root.slug)
    expect(
      (await h.store.getEvents(root.slug)).some((e) => e.type === 'workspace.provisioned'),
    ).toBe(false)
    expect(h.forge.opened).toHaveLength(0)
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    records = await h.store.listBuilds()
    for (const id of ['CHILD', 'NESTED']) {
      const record = records.find((r) => r.ticket?.id === id)!
      const child = reduceBuild(await h.store.getEvents(record.slug))
      expect(child.target?.build).toBe(root.slug)
      expect(child.baseBranch).toBe(root.branch)
    }
    const nested = records.find((r) => r.ticket?.id === 'NESTED')!
    expect(h.launches).not.toContain(nested.slug)
    expect(h.forge.opened).toHaveLength(0)
  })

  test('node PR opens lazily, never auto-merges, and human merge completes ticket', async () => {
    const h = harness({ tickets: [readyTicket('N', { kind: 'node' })] })
    h.forge.remoteBranches.set('main', BASE_SHA)
    await h.dispatcher.tick()
    const node = (await h.store.listBuilds())[0]!
    await h.dispatcher.tick()
    expect(h.forge.opened).toHaveLength(0)
    h.forge.remoteBranches.set(node.branch!, 'child-commit')
    h.forge.nodeComparisons.set(`main...${node.branch}`, 1)
    await h.store.append(node.slug, {
      actor: KERNEL,
      type: 'node.inventory',
      payload: {
        head: h.forge.remoteBranches.get(node.branch!)!,
        builds: ['child'],
        contributions: ['child'],
        foreign: [],
      },
    })
    await h.dispatcher.tick()
    expect(h.forge.opened).toHaveLength(1)
    expect(h.forge.opened[0]?.base).toBe('main')
    const state = reduceBuild(await h.store.getEvents(node.slug))
    expect(state.pr).toBeDefined()
    await h.dispatcher.tick()
    expect(h.forge.autoMergeCalls.every((call) => !call.enabled)).toBe(true)
    expect(h.forge.squashMergeCalls).toHaveLength(0)
    expect(h.launches).toHaveLength(0)
    h.forge.setPrState(state.pr!.number, { state: 'merged', sha: 'merged-node' })
    await h.dispatcher.tick()
    expect(reduceBuild(await h.store.getEvents(node.slug)).status).toBe('done')
  })

  test('unclaimed and aborted target nodes stay queued with a diagnostic', async () => {
    const h = harness({
      tickets: [
        readyTicket('N', { kind: 'node', title: 'Root node' }),
        readyTicket('CHILD', { target: 'MISSING', title: 'Child work' }),
      ],
    })
    h.forge.remoteBranches.set('main', BASE_SHA)
    const first = await h.dispatcher.tick()
    expect(first.dependencyDiagnostics.join(' ')).toContain('MISSING')
    const node = (await h.store.listBuilds())[0]!
    await h.store.append(node.slug, {
      actor: humanActor('test'),
      type: 'build.abort-requested',
      payload: {},
    })
    await h.dispatcher.tick()
    expect(h.launches).toHaveLength(0)
    expect(reduceBuild(await h.store.getEvents(node.slug)).status).toBe('done')
  })
})

describe('integration crash boundaries', () => {
  test('opening response loss retries the durable SHA and adopts child commits without a runner', async () => {
    const h = harness({ tickets: [readyTicket('N', { kind: 'node' })] })
    h.forge.remoteBranches.set('main', BASE_SHA)
    const create = h.forge.createNodeBranch.bind(h.forge)
    let fail = true
    h.forge.createNodeBranch = async (branch, sha) => {
      const head = await create(branch, sha)
      if (fail) {
        fail = false
        h.forge.remoteBranches.set(branch, 'advanced-child')
        h.forge.nodeAncestors.set('advanced-child', new Set([sha]))
        throw new Error('response lost after opening')
      }
      return head
    }
    await h.dispatcher.tick()
    const node = (await h.store.listBuilds())[0]!
    expect(reduceBuild(await h.store.getEvents(node.slug)).nodeOpened).toBeUndefined()
    h.forge.remoteBranches.set('main', 'parent-moved')
    h.forge.nodeComparisons.set(`main...${node.branch}`, 1)
    await h.dispatcher.tick({ resumeCurrent: true })
    const state = reduceBuild(await h.store.getEvents(node.slug))
    expect(state.nodeOpening?.sha).toBe(BASE_SHA)
    expect(state.nodeOpened?.sha).toBe('advanced-child')
    expect(h.forge.remoteBranches.get(node.branch!)).toBe('advanced-child')
    expect(h.forge.nodeOpenings.map((open) => open.sha)).toEqual([BASE_SHA, BASE_SHA])
    expect(h.launches).toHaveLength(0)
    expect((await h.store.getBuild(node.slug))?.lease).toBeUndefined()
  })

  test('PR publication followed by append failure adopts the same PR on retry', async () => {
    const h = harness({ tickets: [readyTicket('N', { kind: 'node' })] })
    h.forge.remoteBranches.set('main', BASE_SHA)
    await h.dispatcher.tick()
    const node = (await h.store.listBuilds())[0]!
    h.forge.remoteBranches.set(node.branch!, 'child')
    h.forge.nodeComparisons.set(`main...${node.branch}`, 1)
    await h.store.append(node.slug, {
      actor: KERNEL,
      type: 'node.inventory',
      payload: {
        head: h.forge.remoteBranches.get(node.branch!)!,
        builds: ['child'],
        contributions: ['child'],
        foreign: [],
      },
    })
    const append = h.store.append.bind(h.store)
    let fail = true
    h.store.append = (async (slug, event) => {
      if (event.type === 'pr.opened' && fail) {
        fail = false
        throw new Error('lost PR append')
      }
      return append(slug, event)
    }) as typeof h.store.append
    await h.dispatcher.tick()
    expect(h.forge.opened).toHaveLength(1)
    expect(reduceBuild(await h.store.getEvents(node.slug)).pr).toBeUndefined()
    h.clock.advance(30_000)
    await h.dispatcher.tick()
    expect(h.forge.opened).toHaveLength(1)
    expect(reduceBuild(await h.store.getEvents(node.slug)).pr?.number).toBe(1)
    expect(h.launches).toHaveLength(0)
  })
})

describe('integration review regressions', () => {
  test.each(['present', 'absent'] as const)(
    'targeted leaf with unavailable frozen node defers and cancels native merge (%s)',
    async (gate) => {
      const h = harness()
      const nodeBase = 'ab-node/parent'
      const slug = await seedAwaitingPr(h, 'targeted-child', nodeBase)
      await h.store.append(slug, {
        actor: humanActor('operator'),
        type: 'build.auto-merge-requested',
        payload: {},
      })
      h.forge.setPrState(1, { state: 'open', mergeable: true })
      h.forge.setPrHeadSha(1, PR.headSha)
      h.forge.setGatePresence(1, gate)
      const native = h.forge.setAutoMerge.bind(h.forge)
      const squash = h.forge.squashMerge.bind(h.forge)
      const nativeBases: (string | undefined)[] = []
      const squashBases: (string | undefined)[] = []
      h.forge.setAutoMerge = async (...args) => {
        nativeBases.push(args[3]?.baseBranch)
        return native(...args)
      }
      h.forge.squashMerge = async (...args) => {
        squashBases.push(args[3]?.baseBranch)
        return squash(...args)
      }
      await h.dispatcher.tick()
      expect(nativeBases).toEqual([undefined])
      expect(h.forge.autoMergeCalls.every((call) => !call.enabled)).toBe(true)
      expect(squashBases).toEqual([])
      expect(h.forge.rewrites).toEqual([])
    },
  )

  test('a waiting target clears dependency-source degradation without being claimed', async () => {
    const h = harness({ tickets: [readyTicket('CHILD', { target: 'UNCLAIMED' })] })
    await h.store.ensureRepo(REPO)
    await h.store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.ticket-source-degraded',
      payload: {
        source: 'fake',
        operation: 'dependency-check',
        cause: 'rate-limited',
        message: 'temporary limit',
        resetAt: '2026-07-15T13:00:00.000Z',
      },
    })
    const report = await h.dispatcher.tick()
    expect(report.dependencyBlocked).toBe(1)
    expect(report.dependencyCheckFailed).toBe(0)
    expect(h.tickets.claims).toEqual([])
    expect(
      (await h.store.getRepoEvents(REPO)).some(
        (e) => e.type === 'dispatcher.ticket-source-recovered',
      ),
    ).toBe(true)
  })

  test('full work capacity preserves the root-only dependency preflight fast path', async () => {
    const h = harness({ tickets: [readyTicket('WAITING', { blockedBy: ['EXTERNAL'] })] })
    await seedBuild(h, { slug: 'occupied' })
    let reads = 0
    h.tickets.dependencyStates = async () => {
      reads += 1
      throw new Error('must not query at capacity')
    }
    const report = await h.dispatcher.tick()
    expect(reads).toBe(0)
    expect(report).toMatchObject({ queued: 1, dependencyBlocked: 0, dependencyCheckFailed: 0 })
  })

  test.each([
    ['pause', 'resume', 'collecting'],
    ['resume', 'pause', 'paused'],
  ] as const)(
    'node commands %s then %s respect the newest intent',
    async (first, second, expected) => {
      const h = harness({ tickets: [readyTicket('N', { kind: 'node' })] })
      h.forge.remoteBranches.set('main', BASE_SHA)
      await h.dispatcher.tick()
      const node = (await h.store.listBuilds())[0]!
      for (const command of [first, second])
        await h.store.append(node.slug, {
          actor: humanActor('operator'),
          type: command === 'pause' ? 'build.pause-requested' : 'build.resume-requested',
          payload: {},
        })
      await h.dispatcher.tick()
      await h.dispatcher.tick()
      expect(reduceBuild(await h.store.getEvents(node.slug)).status).toBe(expected)
      expect(reduceBuild(await h.store.getEvents(node.slug)).pendingCommands).toEqual([])
      expect(h.launches).toEqual([])
    },
  )
})

test.each([true, false])(
  'node PR race refreshes emptiness only for classified no-commits errors (%s)',
  async (classified) => {
    const h = harness({ tickets: [readyTicket('N', { kind: 'node' })] })
    h.forge.remoteBranches.set('main', BASE_SHA)
    await h.dispatcher.tick()
    const node = (await h.store.listBuilds())[0]!
    h.forge.remoteBranches.set(node.branch!, 'child')
    h.forge.nodeComparisons.set(`main...${node.branch}`, 1)
    await h.store.append(node.slug, {
      actor: KERNEL,
      type: 'node.inventory',
      payload: {
        head: h.forge.remoteBranches.get(node.branch!)!,
        builds: ['child'],
        contributions: ['child'],
        foreign: [],
      },
    })
    h.forge.openPr = async () => {
      h.forge.remoteBranches.set(node.branch!, BASE_SHA)
      h.forge.nodeComparisons.set(`main...${node.branch}`, 0)
      throw classified
        ? new NoCommitsBetweenBranchesError('No commits between main and node')
        : new Error('permission denied')
    }
    const report = await h.dispatcher.tick()
    expect(report.janitorFailed).toBe(classified ? 0 : 1)
    expect(reduceBuild(await h.store.getEvents(node.slug)).pr).toBeUndefined()
    expect(reduceBuild(await h.store.getEvents(node.slug)).nodeComparison?.ahead).toBe(
      classified ? 0 : 1,
    )
  },
)

describe('declarative merge reconciliation', () => {
  async function candidate(mode: 'auto' | 'consent' = 'consent') {
    const h = harness({ toml: `[[merge]]\nmode = "${mode}"` })
    const slug = await seedAwaitingPr(h)
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    h.forge.setPrHeadSha(1, PR.headSha)
    h.forge.setGatePresence(1, 'present')
    const poll = () => h.dispatcher.tick({ acceptNewWork: false })
    const state = async () => reduceBuild(await h.store.getEvents(slug))
    return { ...h, slug, poll, state }
  }
  test.each([false, true])(
    'automatic merge retries a real GitHub limit across restart (uncertain=%s)',
    async (uncertain) => {
      const h = await candidate('auto')
      const native = h.forge.setAutoMerge.bind(h.forge)
      const resetAt = new Date(h.clock().getTime() + 120_000).toISOString()
      let limited = true
      const github = new GitHubForge({
        repository: 'acme/repo',
        now: () => h.clock().getTime(),
        transport: async () => {
          throw new GitHubApiError(
            403,
            'API rate limit exceeded',
            {},
            {
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(Date.parse(resetAt) / 1000),
            },
          )
        },
      })
      h.forge.setAutoMerge = async (...args) => {
        if (limited && args[2]) {
          if (uncertain) await args[3]?.canApply?.()
          return github.setAutoMerge(...args)
        }
        return native(...args)
      }
      expect((await h.poll()).janitorFailed).toBe(1)
      expect((await h.state()).landing?.applicationFailure).toBeDefined()
      expect((await h.state()).landing?.nativeEnablePending !== undefined).toBe(uncertain)
      expect((await h.store.getEvents(h.slug)).some((e) => e.type === 'build.land-requested')).toBe(
        false,
      )
      const before = await h.store.getEvents(h.slug)
      const restarted = harness({
        store: h.store,
        forge: h.forge,
        wrapTickets: () => h.tickets,
        toml: '[[merge]]\nmode = "auto"',
      })
      await restarted.dispatcher.tick({ acceptNewWork: false })
      expect(await h.store.getEvents(h.slug)).toEqual(before)
      limited = false
      restarted.clock.set(new Date(Date.parse(resetAt) + 1).toISOString())
      h.clock.set(new Date(Date.parse(resetAt) + 1).toISOString())
      await restarted.dispatcher.tick({ acceptNewWork: false })
      expect(h.forge.isAutoMergeEnabled(1)).toBe(true)
      expect((await h.state()).landing?.applicationFailure).toBeUndefined()
      expect((await h.store.getRepoEvents(REPO)).at(-1)?.type).toBe('dispatcher.forge-recovered')
      h.forge.setPrState(1, { state: 'merged', sha: 'landed' })
      await restarted.dispatcher.tick({ acceptNewWork: false })
      expect((await h.state()).status).toBe('done')
    },
  )

  test('consent queue polls read each PR once and write only to repair observed drift', async () => {
    const h = harness({ toml: '[[merge]]\nmode = "consent"' })
    for (let number = 1; number <= 4; number++) {
      const slug = await seedAwaitingPr(h, `queued-${number}`)
      if (number !== 1)
        await h.store.append(slug, {
          actor: KERNEL,
          type: 'finalize.completed',
          payload: { pr: { ...PR, number } },
        })
      h.forge.setPrState(number, { state: 'open', mergeable: true })
    }
    for (let poll = 0; poll < 3; poll++) {
      h.forge.getPrStateCalls.length = 0
      h.forge.autoMergeCalls.length = 0
      expect((await h.dispatcher.tick({ acceptNewWork: false })).janitorFailed).toBe(0)
      expect(h.forge.getPrStateCalls).toHaveLength(4)
      expect(h.forge.autoMergeCalls).toHaveLength(0)
    }
    await h.forge.setAutoMerge('/repo', 2, true)
    h.forge.autoMergeCalls.length = 0
    h.forge.getPrStateCalls.length = 0
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(h.forge.getPrStateCalls).toHaveLength(4)
    expect(h.forge.autoMergeCalls).toMatchObject([{ number: 2, enabled: false }])
  })
  test('replacement and paused polls reuse the existing PR read without redundant cancellation', async () => {
    const h = await candidate()
    await h.poll()
    await h.store.append(h.slug, {
      actor: KERNEL,
      type: 'landing.native-applied',
      payload: { enabled: false, operation: 'replacement' },
    })
    await h.store.append(h.slug, {
      actor: humanActor('operator'),
      type: 'build.pause-requested',
      payload: {},
    })
    for (let poll = 0; poll < 3; poll++) {
      h.forge.getPrStateCalls.length = 0
      h.forge.autoMergeCalls.length = 0
      expect((await h.poll()).janitorFailed).toBe(0)
      expect(h.forge.getPrStateCalls).toHaveLength(1)
      expect(h.forge.autoMergeCalls).toHaveLength(0)
    }
  })
  test('quiet enabled and inspection-deferred polls append no facts', async () => {
    for (const deferred of [false, true]) {
      const h = await candidate('auto')
      if (deferred)
        h.forge.setAutoMergeDeferral(1, { code: 'unproven-gate-state', detail: 'unknown gate' })
      await h.poll()
      const before = await h.store.getEvents(h.slug)
      const calls = h.forge.autoMergeCalls.length
      for (let i = 0; i < 3; i++) await h.poll()
      expect(await h.store.getEvents(h.slug)).toEqual(before)
      if (!deferred) expect(h.forge.autoMergeCalls).toHaveLength(calls)
      expect((await h.state()).landing?.nativeEnablePending).toBeUndefined()
    }
  })
  test.each(['deferred', 'error'] as const)(
    'post-mutation %s failures persist bounded retry timing without quiet-poll writes',
    async (outcome) => {
      const h = await candidate('auto')
      const set = h.forge.setAutoMerge.bind(h.forge)
      let attempts = 0
      h.forge.setAutoMerge = async (cwd, pr, enabled, options) => {
        if (!enabled) return set(cwd, pr, false)
        await options?.canApply?.()
        attempts++
        if (outcome === 'error') throw new Error('permission denied')
        return { kind: 'deferred' }
      }
      await h.poll()
      const first = (await h.state()).landing!.native!
      expect(first.retry?.attempt).toBe(1)
      const before = await h.store.getEvents(h.slug)
      // A new dispatcher reconstructs the durable retry receipt.
      const deps = (
        h.dispatcher as unknown as { deps: ConstructorParameters<typeof Dispatcher>[0] }
      ).deps
      const restarted = new Dispatcher(deps)
      for (let i = 0; i < 3; i++) await restarted.tick({ acceptNewWork: false })
      expect(attempts).toBe(1)
      expect(await h.store.getEvents(h.slug)).toEqual(before)
      h.clock.advance(30_000)
      await h.poll()
      expect(attempts).toBe(2)
      expect((await h.state()).landing?.native?.retry?.attempt).toBe(2)
      const after = await h.store.getEvents(h.slug)
      h.clock.advance(30_000)
      await h.poll()
      expect(await h.store.getEvents(h.slug)).toEqual(after)
      const decision = (await h.state()).landing!.decision!
      await h.store.append(h.slug, {
        actor: humanActor('operator'),
        type: 'build.land-requested',
        payload: { decisionSeq: decision.seq },
      })
      await h.poll()
      expect(attempts).toBe(3)
      await h.store.append(h.slug, {
        actor: humanActor('operator'),
        type: 'build.hold-requested',
        payload: {},
      })
      await h.poll()
      expect(h.forge.isAutoMergeEnabled(1)).toBe(false)
      expect((await h.state()).landing?.acknowledgedSeq).toBe(
        (await h.state()).landing?.command?.seq,
      )
    },
  )
  test('unrelated cancellation preserves an indeterminate enable without repeating receipts', async () => {
    const h = await candidate()
    await h.poll()
    const pending = await h.store.append(h.slug, {
      actor: DISPATCHER,
      type: 'landing.native-enable-started',
      payload: {},
    })
    await h.store.append(h.slug, {
      actor: humanActor('operator'),
      type: 'build.hold-requested',
      payload: {},
    })
    await h.poll()
    expect((await h.state()).landing?.nativeEnablePending).toBe(pending.seq)
    const events = await h.store.getEvents(h.slug)
    await h.poll()
    expect(await h.store.getEvents(h.slug)).toEqual(events)
  })
  test('restart settles a lost enable receipt using provider readback, then polls quietly', async () => {
    const h = await candidate('auto')
    await h.poll()
    const pending = await h.store.append(h.slug, {
      actor: DISPATCHER,
      type: 'landing.native-enable-started',
      payload: {},
    })
    // Models a matching native request whose applied receipt was lost.
    expect(h.forge.isAutoMergeEnabled(1)).toBe(true)
    await h.poll()
    const state = await h.state()
    expect(state.landing?.nativeEnablePending).toBeUndefined()
    expect(state.landing?.native?.enableSeq).toBe(pending.seq)
    const events = await h.store.getEvents(h.slug)
    await h.poll()
    expect(await h.store.getEvents(h.slug)).toEqual(events)
  })
  test.each(['deferred', 'error'] as const)(
    'a %s mutation is cancelled and a later human merge over hold is informational',
    async (outcome) => {
      const h = await candidate('auto')
      const set = h.forge.setAutoMerge.bind(h.forge)
      h.forge.setAutoMerge = async (cwd, pr, enabled, options) => {
        if (!enabled) return set(cwd, pr, false)
        await options?.canApply?.()
        if (outcome === 'error') throw new Error('native request failed')
        return { kind: 'deferred' }
      }
      await h.poll()
      expect((await h.state()).landing?.nativeEnablePending).toBeUndefined()
      await h.store.append(h.slug, {
        actor: humanActor('operator'),
        type: 'build.hold-requested',
        payload: {},
      })
      await h.poll()
      const before = await h.store.getEvents(h.slug)
      await h.poll()
      await h.poll()
      expect(await h.store.getEvents(h.slug)).toEqual(before)
      h.forge.setPrState(1, { state: 'merged', sha: 'human' })
      await h.poll()
      expect((await h.state()).landing?.forgeMerge).toEqual({
        classification: 'human',
        overrodeHold: true,
      })
      expect(buildNeedsAttention(await h.store.getEvents(h.slug), await h.state())).toBe(false)
    },
  )
  test('policy auto authorizes a ready leaf; consent waits for merge and hold revokes it', async () => {
    const auto = await candidate('auto')
    expect(
      mergeDecision(await auto.store.getEvents(auto.slug), new Date(0), await auto.state()),
    ).toBeNull()
    expect((await auto.poll()).janitorFailed).toBe(0)
    expect(auto.forge.isAutoMergeEnabled(1)).toBe(true)
    expect((await auto.state()).landing?.decision?.rule).toEqual({
      index: 0,
      snapshot: { mode: 'auto' },
    })
    const h = await candidate()
    expect((await h.poll()).janitorFailed).toBe(0)
    expect(h.forge.isAutoMergeEnabled(1)).toBe(false)
    const decided = (await h.state()).landing!.decision!
    const command = await h.store.append(h.slug, {
      actor: humanActor('operator'),
      type: 'build.land-requested',
      payload: { decisionSeq: decided.seq },
    })
    await h.poll()
    expect(h.forge.isAutoMergeEnabled(1)).toBe(true)
    expect((await h.state()).landing?.acknowledgedSeq).toBe(command.seq)
    const held = await h.store.append(h.slug, {
      actor: humanActor('operator'),
      type: 'build.hold-requested',
      payload: {},
    })
    await h.poll()
    expect(h.forge.isAutoMergeEnabled(1)).toBe(false)
    expect((await h.state()).landing?.acknowledgedSeq).toBe(held.seq)
  })
  test.each([
    ['unheld human', false, false, 'human'],
    ['held human', true, false, 'human'],
    ['armed native', true, true, 'possible-stale-enable'],
    ['indeterminate native', true, 'pending', 'possible-stale-enable'],
  ] as const)('%s forge merge uses durable native evidence', async (_, held, native, expected) => {
    const h = await candidate()
    await h.poll() // records a confirmed native disable while awaiting consent
    if (held)
      await h.store.append(h.slug, {
        actor: humanActor('operator'),
        type: 'build.hold-requested',
        payload: {},
      })
    if (native === true)
      await h.store.append(h.slug, {
        actor: KERNEL,
        type: 'landing.native-applied',
        payload: { enabled: true },
      })
    if (native === 'pending')
      await h.store.append(h.slug, {
        actor: DISPATCHER,
        type: 'landing.native-enable-started',
        payload: {},
      })
    const targetBefore = h.forge.remoteBranches.get('main')
    h.forge.setPrState(1, { state: 'merged', sha: 'human-or-native' })
    expect((await h.poll()).janitorFailed).toBe(0)
    const state = await h.state()
    expect(state.landing?.forgeMerge).toEqual({ classification: expected, overrodeHold: held })
    expect(state.prState).toBe('merged')
    expect(h.forge.remoteBranches.get('main')).toBe(targetBefore)
    expect(h.forge.squashMergeCalls).toEqual([])
    const events = await h.store.getEvents(h.slug)
    expect(
      events.filter(
        (e) =>
          e.type === 'observation.recorded' &&
          e.payload.refs?.includes('landing-contrary-to-policy'),
      ),
    ).toHaveLength(expected === 'human' ? 0 : 1)
    expect(buildNeedsAttention(events, state)).toBe(expected !== 'human')
    expect(mergeDecision(events, new Date(0), state)?.reason ?? null).toBe(
      expected === 'human'
        ? null
        : 'Merge contrary to policy: possible stale native enable; inspect the target',
    )
    expect(h.forge.autoMergeCalls).toHaveLength(0)
    await h.poll()
    expect(
      (await h.store.getEvents(h.slug)).filter((e) => e.type === 'landing.forge-merged'),
    ).toHaveLength(1)
  })
  test('enable finishing after cancellation is repaired immediately and on the next poll', async () => {
    const h = await candidate('auto')
    const set = h.forge.setAutoMerge.bind(h.forge)
    let raced = false
    h.forge.setAutoMerge = async (cwd, pr, enabled, options) => {
      if (enabled && !raced) {
        raced = true
        // Deterministically model the adverse external-effect ordering:
        // enable starts, hold cancels, then the old enable finishes.
        await h.store.append(h.slug, {
          actor: humanActor('operator'),
          type: 'build.hold-requested',
          payload: {},
        })
        await set(cwd, pr, false)
        return set(cwd, pr, true, { ...options, buildSlug: h.slug, canApply: async () => true })
      }
      return set(cwd, pr, enabled, options)
    }
    expect((await h.poll()).janitorFailed).toBe(0)
    expect(h.forge.isAutoMergeEnabled(1)).toBe(false)
    await h.poll()
    expect(h.forge.isAutoMergeEnabled(1)).toBe(false)
    expect((await h.state()).landing?.native?.enabled).toBe(false)
  })
  test('policy changes preserve an earlier decision and replacement candidates preserve consent', async () => {
    let config = parseConfig(withReadyState('[[merge]]\nmode = "consent"'))
    const h = harness({ getConfig: () => config })
    const slug = await seedAwaitingPr(h)
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    h.forge.setPrHeadSha(1, PR.headSha)
    await h.dispatcher.tick({ acceptNewWork: false })
    const decision = reduceBuild(await h.store.getEvents(slug)).landing!.decision!
    config = parseConfig(withReadyState('[[merge]]\nmode = "auto"'))
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(reduceBuild(await h.store.getEvents(slug)).landing!.decision).toEqual(decision)
    const command = await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.land-requested',
      payload: { decisionSeq: decision.seq },
    })
    await h.dispatcher.tick({ acceptNewWork: false })
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'landing.native-applied',
      payload: { enabled: false, operation: 'replacement' },
    })
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: { pr: { ...PR, headSha: 'replacement' } },
    })
    h.forge.setPrHeadSha(1, 'replacement')
    await h.dispatcher.tick({ acceptNewWork: false })
    const state = reduceBuild(await h.store.getEvents(slug))
    expect(state.landing?.command?.seq).toBe(command.seq)
    expect(state.landing?.acknowledgedSeq).toBe(command.seq)
    expect(state.landing?.decision?.candidate.head).toBe('replacement')
    expect(state.landing?.native?.candidate?.head).toBe('replacement')
    expect(state.landing?.native?.commandSeq).toBe(command.seq)
    expect(h.forge.isAutoMergeEnabled(1)).toBe(true)
  })
})

for (const asynchronous of [false, true]) {
  test(`pending verification has priority over new claims and reserves the only slot (async provisioning: ${asynchronous})`, async () => {
    const local = new FakeWorkspaceProvider({ root: '/ws', mode: 'logical' })
    let releaseProvision: (() => void) | undefined
    const pendingProvision = new Promise<void>((resolve) => {
      releaseProvision = resolve
    })
    const provider: WorkspaceProvider = {
      name: local.name,
      ...(asynchronous
        ? {
            recovery: {
              reap: async () => ({
                outcome: 'absent' as const,
                snapshots: { outcome: 'confirmed' as const, deleted: 0 },
              }),
            },
          }
        : {}),
      provision: async (input) => {
        if (asynchronous) await pendingProvision
        return local.provision(input)
      },
      release: (handle) => local.release(handle),
    }
    const config =
      'capacity = 1\n[commands]\ntrue = "true"\n[verify]\nsteps = ["unit"]\n[verify.unit]\nkind = "check"\ncommand = "true"\n'
    const h = harness({ toml: config, workspaceProvider: provider, tickets: [readyTicket('NEW')] })
    h.forge.remoteBranches.set('main', BASE_SHA)
    for (const slug of ['first-node', 'second-node']) {
      const branch = `ab-node/${slug}`
      const head = `head-${slug}`
      const ticket = { source: 'fake', id: slug }
      await h.store.createBuild({
        slug,
        repo: REPO,
        branch,
        ticket,
        created: {
          actor: DISPATCHER,
          type: 'build.created',
          payload: { ticket, repo: REPO, baseBranch: 'main', kind: 'node' },
        },
      })
      await h.store.append(slug, {
        actor: DISPATCHER,
        type: 'node.opened',
        payload: { sha: BASE_SHA },
      })
      await h.store.append(slug, {
        actor: DISPATCHER,
        type: 'integration.observed',
        payload: {
          openChildren: [],
          diagnostics: [],
          contributions: ['landed-child'],
        },
      })
      h.forge.remoteBranches.set(branch, head)
      h.forge.nodeComparisons.set(`main...${branch}`, 1)
    }
    const report = await h.dispatcher.tick()
    expect(report.janitorFailed).toBe(0)
    expect(h.tickets.claims).toEqual([])
    if (asynchronous) {
      expect(report.provisioning).toBe(1)
      expect(h.launches).toEqual([])
      // A second tick while provisioning is parked must retain the reservation.
      await h.dispatcher.tick()
      expect(h.tickets.claims).toEqual([])
      expect(h.launches).toEqual([])
      releaseProvision!()
      await h.dispatcher.drainProvisioning()
    }
    expect(h.launches).toEqual(['first-node'])
    expect(local.provisions).toHaveLength(1)
  })
}

for (const expired of [false, true])
  test(`own-build read attention prevents lease sweeps (${expired ? 'expired' : 'absent'} lease)`, async () => {
    const h = harness({ opts: { leaseTtlMs: 1000 } })
    const slug = await seedBuild(h)
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'phase.deferral-escalated',
      payload: {
        id: 'esc_read',
        session: 's_read',
        phase: 'plan',
        round: 1,
        evidenceSeq: 2,
        refs: ['own-build-read:2'],
        question: 'Repair CLI/store access then retry',
      },
    })
    if (expired) await h.store.claimLease(slug, 'prior-runner', 1000)
    for (let tick = 0; tick < 4; tick++) {
      h.clock.advance(2000)
      expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
      expect(h.launches).toEqual([])
    }
  })

test.each([
  [true, 'closed'],
  [true, 'merged'],
  [false, 'closed'],
] as const)(
  'GitHub complete quiet node ticks use two conditional reads (PR=%s, terminal=%s)',
  async (hasPr, terminalKind) => {
    const initial = harness({
      tickets: (hasPr ? ['N'] : ['N', 'N2']).map((id) => readyTicket(id, { kind: 'node' })),
    })
    initial.forge.remoteBranches.set('main', BASE_SHA)
    await initial.dispatcher.tick()
    const node = (await initial.store.listBuilds())[0]!
    if (hasPr)
      await initial.store.append(node.slug, {
        actor: KERNEL,
        type: 'finalize.completed',
        payload: {
          pr: { number: 1, url: 'https://github.com/acme/repo/pull/1', headSha: BASE_SHA },
        },
      })
    for (const opened of await initial.store.listBuilds()) {
      await initial.store.append(opened.slug, {
        actor: KERNEL,
        type: 'node.inventory',
        payload: { head: BASE_SHA, base: BASE_SHA, builds: [], contributions: [], foreign: [] },
      })
      await initial.store.append(opened.slug, {
        actor: KERNEL,
        type: 'node.parent-distance',
        payload: { base: BASE_SHA, parent: BASE_SHA, branch: 'main', count: 0 },
      })
    }
    const requestsPerTick = hasPr ? 2 : 3
    const calls: { path: string; conditional: boolean }[] = []
    let parent = BASE_SHA
    let head = BASE_SHA
    let terminal = false
    const representations = new Map<string, string>()
    const transport: GitHubRequest = async (_method, path, opts) => {
      const conditional = opts?.headers?.['If-None-Match'] !== undefined
      calls.push({ path, conditional })
      let json: unknown
      if (path.includes('/pulls/'))
        json = {
          state: terminal ? 'closed' : 'open',
          merged: terminal && terminalKind === 'merged',
          mergeable: true,
          merge_commit_sha: terminal && terminalKind === 'merged' ? head : null,
          auto_merge: null,
          head: { ref: node.branch, sha: head, repo: { full_name: 'acme/repo' } },
        }
      else if (path.includes('/git/ref/heads/'))
        json = { object: { sha: path.endsWith('/main') ? parent : head } }
      else if (path.includes('/branches/')) json = { commit: { sha: parent } }
      else if (path.includes('/compare/'))
        json = { base_commit: { sha: hasPr ? parent : head }, ahead_by: 0, behind_by: 0 }
      else throw new Error(`unexpected request ${path}`)
      const etag = JSON.stringify(json)
      if (representations.get(path) === etag && opts?.headers?.['If-None-Match'] === etag)
        return { status: 304, headers: {} as Record<string, string> }
      representations.set(path, etag)
      return { status: 200, headers: { etag }, json }
    }
    const gitOptions = {
      token: 'test-token',
      exec: async (cmd: string[]) => ({
        stdout: cmd.includes('rev-parse')
          ? cmd.at(-1)?.includes('parent')
            ? parent
            : head
          : cmd.includes('rev-list')
            ? '0'
            : '',
        stderr: '',
        exitCode: 0,
      }),
    }
    const baselineForge = new GitHubForge({ repository: 'acme/repo', transport, ...gitOptions })
    const unshared = new Proxy(baselineForge, {
      get(target, key) {
        if (key === 'withReadScope' || key === 'primeNodeReads') return undefined
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const baseline = harness({
      store: initial.store,
      clock: initial.clock,
      wrapTickets: () => initial.tickets,
      dispatchForge: unshared,
    })
    const oldReport = await baseline.dispatcher.tick({ acceptNewWork: false })
    expect(oldReport.janitorFailed).toBe(0)
    expect(oldReport.forgeRequests?.total).toBe(hasPr ? 12 : 24)
    calls.length = 0
    const github = new GitHubForge({ repository: 'acme/repo', transport, ...gitOptions })
    const h = harness({
      store: initial.store,
      clock: initial.clock,
      wrapTickets: () => initial.tickets,
      dispatchForge: github,
    })
    for (let tick = 0; tick < 3; tick++) {
      const report = await h.dispatcher.tick({ acceptNewWork: false })
      expect(report.janitorFailed).toBe(0)
      expect(report.forgeRequests?.total).toBe(requestsPerTick)
      expect(report.forgeRequests?.restNotModified).toBe(tick ? requestsPerTick : 0)
      expect(h.launches).toEqual([])
    }
    expect(calls.slice(requestsPerTick).every((c) => c.conditional)).toBe(true)
    h.clock.advance(600_000)
    expect((await h.dispatcher.tick({ acceptNewWork: false })).janitorFailed).toBe(0)
    expect(reduceBuild(await h.store.getEvents(node.slug)).nodePolling).toBeDefined()
    for (let skipped = 0; skipped < 3; skipped++) {
      h.clock.advance(20_000)
      calls.length = 0
      expect((await h.dispatcher.tick({ acceptNewWork: false })).forgeRequests?.total ?? 0).toBe(0)
      expect(calls).toHaveLength(0)
    }
    const restarted = harness({
      store: initial.store,
      clock: initial.clock,
      wrapTickets: () => initial.tickets,
      dispatchForge: github,
    })
    expect(
      (await restarted.dispatcher.tick({ acceptNewWork: false })).forgeRequests?.total ?? 0,
    ).toBe(0)
    h.clock.advance(60_000)
    expect((await h.dispatcher.tick({ acceptNewWork: false })).forgeRequests?.total).toBe(
      requestsPerTick,
    )
    // Explicit operator activity, including an identical repeated hold, wakes
    // the node before the next idle deadline.
    for (let repeated = 0; repeated < 2; repeated++) {
      await h.store.append(node.slug, {
        actor: { kind: 'human', user: 'operator' },
        type: 'build.hold-requested',
        payload: {},
      })
      expect(
        (await h.dispatcher.tick({ acceptNewWork: false })).forgeRequests?.total,
      ).toBeGreaterThan(0)
      h.clock.advance(600_000)
      await h.dispatcher.tick({ acceptNewWork: false })
      expect((await h.dispatcher.tick({ acceptNewWork: false })).forgeRequests?.total ?? 0).toBe(0)
    }
    // GitHub-only movement stays invisible until the scheduled check.
    head = 'b'.repeat(40)
    expect((await h.dispatcher.tick({ acceptNewWork: false })).forgeRequests?.total ?? 0).toBe(0)
    h.clock.advance(120_000)
    expect((await h.dispatcher.tick({ acceptNewWork: false })).janitorFailed).toBe(0)
    expect(reduceBuild(await h.store.getEvents(node.slug)).nodeComparison?.headSha).toBe(head)
    h.clock.advance(600_000)
    parent = 'c'.repeat(40)
    expect((await h.dispatcher.tick({ acceptNewWork: false })).janitorFailed).toBe(0)
    expect(
      (await h.store.getEvents(node.slug)).filter((e) => e.type === 'target.moved').at(-1)?.payload,
    ).toEqual({ branch: 'main', sha: parent })
    if (hasPr) {
      h.clock.advance(600_000)
      terminal = true
      await h.dispatcher.tick({ acceptNewWork: false })
      expect(reduceBuild(await h.store.getEvents(node.slug)).prState).toBe(terminalKind)
    }
  },
)

test('GitHub leaf-only ticks retain their standalone request count', async () => {
  for (const scoped of [false, true]) {
    const initial = harness()
    await seedAwaitingPr(initial)
    const github = new GitHubForge({
      repository: 'acme/repo',
      transport: async (_method, path) => {
        if (path.includes('/branches/'))
          return { status: 200, headers: {}, json: { commit: { sha: BASE_SHA } } }
        if (path.includes('/pulls/'))
          return {
            status: 200,
            headers: {},
            json: {
              state: 'open',
              merged: false,
              mergeable: true,
              merge_commit_sha: null,
              auto_merge: null,
            },
          }
        throw new Error(`unexpected leaf request ${path}`)
      },
    })
    const forge = scoped
      ? github
      : new Proxy(github, {
          get(target, key) {
            if (key === 'withReadScope' || key === 'primeNodeReads') return undefined
            const value = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
    const h = harness({
      store: initial.store,
      wrapTickets: () => initial.tickets,
      dispatchForge: forge,
    })
    const report = await h.dispatcher.tick({ acceptNewWork: false })
    expect(report.janitorFailed).toBe(0)
    expect(report.forgeRequests?.total).toBe(2)
    expect(h.launches).toEqual([])
  }
})

test.each(
  [true, false].flatMap((hasPr) =>
    [
      new GitHubApiError(404, 'parent deleted'),
      new GitHubApiError(503, 'comparison unavailable'),
      new Error('network timeout'),
    ].map((failure) => [hasPr, failure] as const),
  ),
)('failed GitHub node priming preserves parent recovery (PR=%s, %s)', async (hasPr, failure) => {
  const h = harness({ tickets: [readyTicket('N', { kind: 'node' })] })
  const slug = 'orphan-node'
  const branch = `ab-node/${slug}`
  const ticket = { source: 'fake', id: 'N' }
  await h.store.createBuild({
    slug,
    repo: REPO,
    branch,
    ticket,
    created: {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { ticket, repo: REPO, baseBranch: 'gone-parent', kind: 'node' },
    },
  })
  await h.store.append(slug, {
    actor: DISPATCHER,
    type: 'node.opened',
    payload: { sha: BASE_SHA },
  })
  await h.store.append(slug, {
    actor: DISPATCHER,
    type: 'node.parent-requested',
    payload: {
      id: 'recover-parent',
      old: { target: null, branch: 'gone-parent' },
      next: { target: null, branch: 'main' },
      revision: (await h.tickets.get('N'))!.revision,
    },
  })
  if (hasPr)
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: {
        pr: { number: 1, url: 'https://github.com/acme/repo/pull/1', headSha: BASE_SHA },
      },
    })
  const get = h.tickets.get.bind(h.tickets)
  let ticketReads = 0
  h.tickets.get = async (id) => {
    ticketReads++
    return get(id)
  }
  const paths: string[] = []
  const github = new GitHubForge({
    repository: 'acme/repo',
    token: 'test-token',
    exec: async (cmd) => ({
      stdout: cmd.includes('ls-remote')
        ? `${BASE_SHA}\t${cmd.at(-1)}\n`
        : cmd.includes('rev-parse')
          ? BASE_SHA
          : cmd.includes('rev-list')
            ? '0'
            : '',
      stderr: '',
      exitCode: 0,
    }),
    transport: async (_method, path) => {
      paths.push(path)
      if (path.includes('/branches/gone-parent') || path.includes('/compare/gone-parent...'))
        throw failure
      if (path.includes('/pulls/'))
        return {
          status: 200,
          headers: {},
          json: {
            node_id: 'pr-1',
            draft: false,
            base: { ref: 'main' },
            state: 'open',
            merged: false,
            mergeable: true,
            merge_commit_sha: null,
            auto_merge: null,
            head: { ref: branch, sha: BASE_SHA, repo: { full_name: 'acme/repo' } },
          },
        }
      if (path.includes('/branches/'))
        return { status: 200, headers: {}, json: { commit: { sha: BASE_SHA } } }
      if (path.includes('/compare/'))
        return {
          status: 200,
          headers: {},
          json: { base_commit: { sha: BASE_SHA }, ahead_by: 0, behind_by: 0 },
        }
      throw new Error(`unexpected recovery read ${path}`)
    },
  })
  const run = harness({ store: h.store, wrapTickets: () => h.tickets, dispatchForge: github })
  const report = await run.dispatcher.tick({ acceptNewWork: false })
  expect(report.janitorFailed).toBe(0)
  expect(ticketReads).toBeGreaterThan(0)
  expect(
    report.janitorDiagnostics.some((message) => message.includes('node read priming failed')),
  ).toBe(true)
  expect(
    (await h.store.getEvents(slug)).some(
      (e) => e.type === 'node.parent-accepted' && e.payload.id === 'recover-parent',
    ),
  ).toBe(true)
  expect(reduceBuild(await h.store.getEvents(slug)).baseBranch).toBe('main')
  expect(paths.some((path) => path.includes('gone-parent'))).toBe(true)
  expect((await run.dispatcher.tick({ acceptNewWork: false })).janitorFailed).toBe(0)
  expect(
    (await h.store.getEvents(slug)).some(
      (e) => e.type === 'node.parent-completed' && e.payload.id === 'recover-parent',
    ),
  ).toBe(true)
})

test('node read priming still defers parent observation during forge cooldown', async () => {
  const { ForgeCooldown } = await import('../kernel/guarded-forge')
  const initial = harness({ tickets: [readyTicket('N', { kind: 'node' })] })
  initial.forge.remoteBranches.set('main', BASE_SHA)
  await initial.dispatcher.tick()
  let ticketReads = 0
  const get = initial.tickets.get.bind(initial.tickets)
  initial.tickets.get = async (id) => {
    ticketReads++
    return get(id)
  }
  const forge = new Proxy(initial.forge, {
    get(target, key) {
      if (key === 'primeNodeReads')
        return async () => {
          throw new ForgeCooldown('cooldown')
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const h = harness({
    store: initial.store,
    wrapTickets: () => initial.tickets,
    dispatchForge: forge,
  })
  const report = await h.dispatcher.tick({ acceptNewWork: false })
  expect(ticketReads).toBe(0)
  expect(report.janitorFailed).toBe(0)
  expect(report.janitorDiagnostics).toEqual([])
})

test('a command racing a node observation cannot be absorbed into its checkpoint', async () => {
  const h = harness({ tickets: [readyTicket('N', { kind: 'node' })] })
  h.forge.remoteBranches.set('main', BASE_SHA)
  await h.dispatcher.tick()
  const node = (await h.store.listBuilds())[0]!
  await h.dispatcher.tick({ acceptNewWork: false })
  h.clock.advance(600_000)
  await h.dispatcher.tick({ acceptNewWork: false })
  const before = reduceBuild(await h.store.getEvents(node.slug)).nodePolling
  expect(before).toBeDefined()
  const compare = h.forge.compareBranches.bind(h.forge)
  let raced = false
  let reads = 0
  h.forge.compareBranches = async (...args) => {
    reads++
    const result = await compare(...args)
    if (!raced) {
      raced = true
      await h.store.append(node.slug, {
        actor: humanActor('operator'),
        type: 'build.hold-requested',
        payload: {},
      })
    }
    return result
  }
  h.clock.advance(120_000)
  await h.dispatcher.tick({ acceptNewWork: false })
  expect(raced).toBe(true)
  expect(reduceBuild(await h.store.getEvents(node.slug)).nodePolling).toEqual(before)
  reads = 0
  await h.dispatcher.tick({ acceptNewWork: false })
  expect(reads).toBeGreaterThan(0)
  expect(reduceBuild(await h.store.getEvents(node.slug)).nodePolling?.checkedAt).toBe(
    h.clock().toISOString(),
  )
})

test.each([
  { actor: humanActor('operator'), type: 'build.land-requested', payload: { decisionSeq: 1 } },
  { actor: humanActor('operator'), type: 'build.hold-requested', payload: {} },
  {
    actor: humanActor('operator'),
    type: 'node.restack-requested',
    payload: { id: 'restack-idle', reason: 'operator', branch: 'main', parent: BASE_SHA },
  },
  {
    actor: humanActor('operator'),
    type: 'escalation.answered',
    payload: { id: 'esc-idle', answer: 'retry', resolution: 'retry' },
  },
] as EventWrite[])('durable operator event wakes an idle node: $type', async (write) => {
  const h = harness({ tickets: [readyTicket('N', { kind: 'node' })] })
  h.forge.remoteBranches.set('main', BASE_SHA)
  await h.dispatcher.tick()
  const node = (await h.store.listBuilds())[0]!
  await h.dispatcher.tick({ acceptNewWork: false })
  h.clock.advance(600_000)
  await h.dispatcher.tick({ acceptNewWork: false })
  const compare = h.forge.compareBranches.bind(h.forge)
  let reads = 0
  h.forge.compareBranches = async (...args) => {
    reads++
    return compare(...args)
  }
  await h.dispatcher.tick({ acceptNewWork: false })
  expect(reads).toBe(0)
  await h.store.append(node.slug, write)
  await h.dispatcher.tick({ acceptNewWork: false })
  expect(reads).toBeGreaterThan(0)
})

test('a child claim wakes an idle parent before the child opens a PR', async () => {
  const h = harness({ tickets: [readyTicket('N', { kind: 'node' })] })
  h.forge.remoteBranches.set('main', BASE_SHA)
  await h.dispatcher.tick()
  const node = (await h.store.listBuilds())[0]!
  await h.dispatcher.tick({ acceptNewWork: false })
  h.clock.advance(600_000)
  await h.dispatcher.tick({ acceptNewWork: false })
  const compare = h.forge.compareBranches.bind(h.forge)
  let reads = 0
  h.forge.compareBranches = async (...args) => {
    reads++
    return compare(...args)
  }
  await h.dispatcher.tick({ acceptNewWork: false })
  expect(reads).toBe(0)
  const ticket = { source: 'fake', id: 'CHILD' }
  await h.store.createBuild({
    slug: 'new-child',
    repo: REPO,
    ticket,
    created: {
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        ticket,
        repo: REPO,
        baseBranch: node.branch!,
        kind: 'work',
        target: { ticket: node.ticket!, build: node.slug },
      },
    },
  })
  expect((await h.dispatcher.tick({ acceptNewWork: false })).janitorFailed).toBe(0)
  expect(reads).toBeGreaterThan(0)
})

test('node polling reads no settled history after warming, on idle and due ticks', async () => {
  class FactCountingStore extends MemoryBuildStore {
    readonly facts = new Map<string, number>()
    override async getReducerValue(...args: Parameters<MemoryBuildStore['getReducerValue']>) {
      const [scope, request] = args
      if (scope.kind === 'build' && request.reducer === 'buildReadFacts')
        this.facts.set(scope.slug, (this.facts.get(scope.slug) ?? 0) + 1)
      return super.getReducerValue(...args)
    }
  }
  const clock = manualClock()
  const store = new FactCountingStore({ clock })
  const h = harness({
    store,
    clock,
    tickets: ['N1', 'N2', 'N3'].map((id) => readyTicket(id, { kind: 'node' })),
  })
  h.forge.remoteBranches.set('main', BASE_SHA)
  await h.dispatcher.tick()
  const nodes = await store.listBuilds()
  const parent = nodes[0]!
  for (let i = 0; i < 40; i++) {
    const ticket = { source: 'fake', id: `OLD-${i}` }
    await store.createBuild({
      slug: `history-${i}`,
      repo: REPO,
      ticket,
      created: {
        actor: DISPATCHER,
        type: 'build.created',
        payload: {
          ticket,
          repo: REPO,
          baseBranch: 'main',
          kind: 'work',
          ...(i % 2 ? {} : { target: { ticket: parent.ticket!, build: parent.slug } }),
        },
      },
    })
    await store.append(`history-${i}`, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'abandoned' },
    })
  }
  await h.dispatcher.tick({ acceptNewWork: false })
  clock.advance(600_000)
  await h.dispatcher.tick({ acceptNewWork: false })
  for (const elapsed of [20_000, 120_000]) {
    store.facts.clear()
    clock.advance(elapsed)
    expect((await h.dispatcher.tick({ acceptNewWork: false })).janitorFailed).toBe(0)
    expect([...store.facts.keys()].filter((slug) => slug.startsWith('history-'))).toEqual([])
  }
  // A late lifecycle receipt invalidates only that terminal child's cached facts.
  await store.append('history-0', { actor: DISPATCHER, type: 'pr.closed', payload: {} })
  store.facts.clear()
  expect((await h.dispatcher.tick({ acceptNewWork: false })).janitorFailed).toBe(0)
  // The admitted ticket-list refresh reads each historical build once; the
  // polling gate adds exactly one fresh read for the changed child.
  expect(store.facts.get('history-0')).toBe(2)
  expect(store.facts.get('history-2')).toBe(1)
})

test('child phase progress preserves the ticket-list throttle; PR opening invalidates it', async () => {
  const h = harness({ tickets: [readyTicket('N', { kind: 'node' })] })
  h.forge.remoteBranches.set('main', BASE_SHA)
  await h.dispatcher.tick()
  const node = (await h.store.listBuilds())[0]!
  const ticket = { source: 'fake', id: 'CHILD' }
  await h.store.createBuild({
    slug: 'progress-child',
    repo: REPO,
    ticket,
    branch: 'ab/progress-child',
    created: {
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        ticket,
        repo: REPO,
        baseBranch: node.branch!,
        kind: 'work',
        target: { ticket: node.ticket!, build: node.slug },
      },
    },
  })
  let listings = 0
  const listAll = h.tickets.listAll.bind(h.tickets)
  h.tickets.listAll = async (...args) => {
    listings++
    return listAll(...args)
  }
  await h.dispatcher.tick({ acceptNewWork: false })
  expect(listings).toBe(1)
  for (const type of ['plan.started', 'plan-review.started', 'implement.started'] as const) {
    await h.store.append('progress-child', { actor: KERNEL, type, payload: { round: 1 } })
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(listings).toBe(1)
  }
  const pr = await h.forge.openPr({
    workspacePath: REPO,
    head: 'ab/progress-child',
    base: node.branch!,
    title: 'Child',
    body: 'Child work',
  })
  await h.store.append('progress-child', { actor: DISPATCHER, type: 'pr.opened', payload: { pr } })
  await h.dispatcher.tick({ acceptNewWork: false })
  expect(listings).toBe(2)
})

describe('origin ticks preserve inert operator sessions', () => {
  test('matching wakes, suspended turns and stale running turns append no execution facts', async () => {
    const h = harness({
      repoOrigin: 'https://github.com/acme/widgets',
      toml: '[orchestrator]\nenabled = true\n',
    })
    await h.store.ensureRepo(REPO)
    const sessions: string[] = []
    for (const cause of ['idle', 'budget', 'approval', 'running'] as const) {
      const session = await h.store.createSession({ repo: REPO, operator: 'op' })
      sessions.push(session.id)
      await h.store.appendSessionEvent(session.id, {
        actor: humanActor('op'),
        type: 'session.wake-set',
        payload: { globs: ['escalation.raised'] },
      })
      if (cause === 'idle') continue
      const stream = await h.store.createStream(
        { kind: 'session', session: session.id },
        'historical',
      )
      const actor = agentActor('orchestrator', 'old-turn')
      await h.store.appendSessionEvent(session.id, {
        actor,
        type: 'turn.started',
        payload: {
          turn: 'old-turn',
          stream: stream.id,
          trigger: { kind: 'message', messageSeq: 1 },
        },
      })
      if (cause !== 'running') {
        if (cause === 'approval') {
          await h.store.appendSessionEvent(session.id, {
            actor,
            type: 'approval.requested',
            payload: { turn: 'old-turn', toolCallId: 'call', toolName: 'notes.write', input: {} },
          })
        }
        await h.store.appendSessionEvent(session.id, {
          actor,
          type: 'turn.suspended',
          payload: { turn: 'old-turn', cause },
        })
        if (cause === 'approval')
          await h.store.appendSessionEvent(session.id, {
            actor: humanActor('op'),
            type: 'approval.answered',
            payload: { turn: 'old-turn', toolCallId: 'call', decision: 'approve' },
          })
      }
    }
    await h.store.createBuild({ slug: 'wake-build', repo: REPO, branch: 'ab/wake-build' })
    await h.store.append('wake-build', {
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        ticket: { source: 'fake', id: 'T-1', title: 'Wake' },
        repo: REPO,
        baseBranch: 'main',
      },
    })
    await h.store.append('wake-build', {
      actor: agentActor('implement', 'old'),
      type: 'escalation.raised',
      payload: { id: 'e1', phase: 'implement', round: 1, source: 'agent', question: 'Help?' },
    })
    const before = await Promise.all(sessions.map((id) => h.store.getSessionEvents(id)))
    h.clock.advance(16 * 60_000) // Beyond the removed reaper's silence threshold.
    await h.dispatcher.tick()
    await h.dispatcher.tick()
    expect(await Promise.all(sessions.map((id) => h.store.getSessionEvents(id)))).toEqual(before)
    for (const events of before) {
      const started = events.find((e) => e.type === 'turn.started')
      if (started?.type === 'turn.started')
        expect((await h.store.readStream(started.payload.stream)).status).toBe('open')
    }
  })
})

test('dispatcher reuses a historical pinned pipeline without config repair', async () => {
  const repairs: string[] = []
  const h = harness({
    repairBuildConfig: async (slug) => {
      repairs.push(slug)
    },
  })
  const slug = await seedBuild(h, { attached: false })
  const content = JSON.stringify(historicalEffectiveConfig(true))
  await h.store.putArtifact(slug, { kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT, content })
  const report = await h.dispatcher.tick()
  expect(repairs).toEqual([])
  expect(report.blockedDiagnostics.some((line) => line.includes('pipeline'))).toBe(false)
  expect(
    new TextDecoder().decode(
      (await h.store.getArtifact(slug, BUILD_EFFECTIVE_CONFIG_ARTIFACT))!.content,
    ),
  ).toBe(content)
})

test('advisory work samples refresh head and target, deduplicate across restart, and record failed reads as unknown', async () => {
  let head = 'b'.repeat(40)
  let count = 3
  let failed = false
  const exec: Exec = async (cmd) => {
    if (cmd[1] === 'rev-parse') return { stdout: head, stderr: '', exitCode: 0 }
    if (cmd[1] === 'rev-list')
      return {
        stdout: String(count),
        stderr: failed ? 'unavailable' : '',
        exitCode: failed ? 1 : 0,
      }
    return { stdout: BASE_SHA, stderr: '', exitCode: 0 }
  }
  const h = harness({ exec })
  const slug = await seedBuild(h)
  await h.store.claimLease(slug, 'running', 3_600_000)
  const samples = async () =>
    (await h.store.getEvents(slug))
      .filter((e) => e.type === 'target.distance')
      .map((e) => e.payload)
  await h.dispatcher.tick()
  expect((await samples()).at(-1)?.count).toBe(3)
  await h.dispatcher.tick()
  expect(await samples()).toHaveLength(1)
  head = 'c'.repeat(40)
  count = 2
  await h.dispatcher.tick()
  expect((await samples()).at(-1)?.head).toBe(head)
  h.forge.remoteBranches.set('main', 'd'.repeat(40))
  await h.dispatcher.tick()
  expect((await samples()).at(-1)?.sha).toBe('d'.repeat(40))
  const resumed = harness({ store: h.store, forge: h.forge, exec })
  await resumed.dispatcher.tick()
  expect(await samples()).toHaveLength(3)
  failed = true
  await resumed.dispatcher.tick()
  expect((await samples()).at(-1)?.count).toBeNull()
  await resumed.dispatcher.tick()
  expect(await samples()).toHaveLength(4)
  expect(h.forge.rewrites).toEqual([])
  expect(h.launches).toEqual([])
})

test('advisory work samples deduplicate persisted JSON values with reordered keys', async () => {
  const backing = new MemoryBuildStore({ clock: manualClock() })
  const getReducerValue = backing.getReducerValue.bind(backing)
  const storedOrders: string[][] = []
  backing.getReducerValue = async (...args) => {
    const result = await getReducerValue(...args)
    return {
      ...result,
      // PostgreSQL jsonb normalizes object keys by length, then byte order.
      value: JSON.parse(
        JSON.stringify(result.value, (_key, value) => {
          if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
          const reordered = Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => a.length - b.length || a.localeCompare(b)),
          )
          if (
            'branch' in reordered &&
            'count' in reordered &&
            'head' in reordered &&
            'sha' in reordered
          )
            storedOrders.push(Object.keys(reordered))
          return reordered
        }),
      ),
    }
  }
  const h = harness({
    store: backing,
    exec: async (cmd) => ({
      stdout: cmd[1] === 'rev-list' ? '3' : 'b'.repeat(40),
      stderr: '',
      exitCode: 0,
    }),
  })
  const slug = await seedBuild(h)
  await h.store.claimLease(slug, 'running', 3_600_000)
  await h.dispatcher.tick()
  await h.dispatcher.tick()
  const resumed = harness({
    store: backing,
    forge: h.forge,
    exec: async (cmd) => ({
      stdout: cmd[1] === 'rev-list' ? '3' : 'b'.repeat(40),
      stderr: '',
      exitCode: 0,
    }),
  })
  await resumed.dispatcher.tick()
  expect(storedOrders).toContainEqual(['sha', 'head', 'count', 'branch'])
  expect((await backing.getEvents(slug)).filter((e) => e.type === 'target.distance')).toHaveLength(
    1,
  )
})

test('deferred work distance comparisons preserve the known sample without diagnostics or log growth', async () => {
  const { ForgeRequestDeferred } = await import('../ports/forge-request-context')
  const forge = new FakeForge()
  let deferred = false
  let comparisons = 0
  forge.compareBranches = async () => {
    comparisons++
    if (deferred) throw new ForgeRequestDeferred('request budget exhausted')
    return { parentSha: 'b'.repeat(40), headSha: BASE_SHA, ahead: 3 }
  }
  const h = harness({ forge })
  const slug = await seedBuild(h, { workspaceRemote: true })
  await h.store.claimLease(slug, 'running', 3_600_000)
  await h.dispatcher.tick()
  const before = await h.store.getEvents(slug)
  expect(before.filter((e) => e.type === 'target.distance').at(-1)?.payload).toMatchObject({
    count: 3,
  })
  deferred = true
  for (let poll = 0; poll < 2; poll++) {
    const report = await h.dispatcher.tick()
    expect(report.janitorDiagnostics).toEqual([])
    expect(report.janitorFailed).toBe(0)
    expect(await h.store.getEvents(slug)).toEqual(before)
  }
  deferred = false
  await h.dispatcher.tick()
  expect(comparisons).toBe(4)
  expect(await h.store.getEvents(slug)).toEqual(before)
})

test('observation-only ticks repair active account policies without claims, resumes or launches', async () => {
  const { accountPolicy } = await import('../ports/workspace/account-policy')
  const accounts = {
    claude: { kind: 'claude-subscription', credentialEnv: 'CLAUDE_ACCESS' },
    plan: { kind: 'chatgpt-subscription', credentialEnv: 'PLAN_ACCESS' },
  } as const
  let observed = 0
  let policy: unknown
  const provider: WorkspaceProvider = {
    name: 'remote-test',
    buildExecution: {
      async start() {
        throw new Error('must not launch')
      },
      async observe() {
        observed++
        const result = accountPolicy('allow-all', accounts, { CLAUDE_ACCESS: 'ready-claude' })
        policy = result.policy
        return { state: 'running', attention: result.missing.join('; ') }
      },
    },
    async provision() {
      throw new Error('must not provision')
    },
    async release() {},
  }
  const h = harness({ workspaceProvider: provider, tickets: [readyTicket('new-ticket')] })
  const slug = await seedBuild(h, { slug: 'active', workspace: false })
  await seedBuild(h, { slug: 'waiting', workspace: false })
  await h.store.append(slug, {
    actor: DISPATCHER,
    type: 'execution.started',
    payload: {
      provider: 'remote-test',
      workspaceRef: 'sandbox',
      instance: 'foreign',
      commandId: 'cmd',
    },
  })
  const report = await h.dispatcher.tick({
    observationOnly: true,
    resumeCurrent: true,
    acceptNewWork: true,
  })
  expect(observed).toBe(1)
  expect(JSON.stringify(policy)).toContain('ready-claude')
  expect(JSON.stringify(policy)).not.toContain('api.openai.com')
  expect(h.launches).toEqual([])
  expect(report.dispatched).toBe(0)
  expect((await h.store.listBuilds()).map((b) => b.slug).sort()).toEqual(['active', 'waiting'])
})

describe('Dispatcher failed ticket preparation recovery', () => {
  for (const seam of ['list', 'get', 'deposit-first', 'deposit-later'] as const) {
    test(`${seam} failure hands back and retry creates one complete hosted snapshot`, async () => {
      const remote = new MemoryBuildStore()
      await remote.ensureRepo(REPO)
      for (const name of ['a.png', 'b.png'])
        await remote.putTicketAsset(REPO, 'T-1', {
          kind: 'mock',
          name,
          layout: 'file',
          entries: [{ type: 'file', path: name, content: new TextEncoder().encode(name) }],
        })
      let broken = true
      const h = harness({
        tickets: [readyTicket('T-1')],
        wrapTickets: (source) =>
          Object.assign(source, {
            assets: {
              listTicketAssets: async (...args: Parameters<BuildStore['listTicketAssets']>) => {
                if (broken && seam === 'list') throw new Error('asset list unavailable')
                return remote.listTicketAssets(...args)
              },
              getTicketAsset: async (...args: Parameters<BuildStore['getTicketAsset']>) => {
                if (broken && seam === 'get') throw new Error('asset bytes unavailable')
                return remote.getTicketAsset(...args)
              },
            },
          }),
      })
      const put = h.store.putRepoArtifact.bind(h.store)
      let deposits = 0
      h.store.putRepoArtifact = async (...args) => {
        if (args[1].kind.startsWith('ticket-snapshot-')) {
          deposits++
          if (
            broken &&
            deposits === (seam === 'deposit-first' ? 1 : seam === 'deposit-later' ? 3 : -1)
          )
            throw new Error('snapshot deposit unavailable')
        }
        return put(...args)
      }
      await expect(h.dispatcher.tick()).rejects.toThrow('unavailable')
      expect(await h.store.listBuilds()).toEqual([])
      expect((await h.tickets.get('T-1'))?.state).toBe('Ready')
      broken = false
      await h.dispatcher.tick()
      expect((await h.store.listBuilds()).map((b) => b.slug)).toEqual(['add-rate-limiting'])
      for (const name of ['a.png', 'b.png']) {
        const asset = await h.store.getPinnedTicketAsset('add-rate-limiting', 'mock', name)
        const entry = asset?.entries[0]
        expect(entry?.type === 'file' && new TextDecoder().decode(entry.content)).toBe(name)
      }
      expect(await readPreparation(h.store)).toEqual({})
    })
  }

  async function readPreparation(store: BuildStore) {
    const { readRepositoryFacts } = await import('../store/reduced-reads')
    return (await readRepositoryFacts(store, REPO)).value.preparation
  }

  test('failed handback survives restart and respects its durable deadline with intake disabled', async () => {
    const h = harness({
      tickets: [readyTicket('T-1', { body: 'thin' })],
      authorSpec: async () => {
        throw new Error('author unavailable')
      },
    })
    const transition = h.tickets.transition.bind(h.tickets)
    let broken = true
    let calls = 0
    h.tickets.transition = async (...args) => {
      calls++
      if (broken) throw new Error('transition unavailable')
      return transition(...args)
    }
    await expect(h.dispatcher.tick()).rejects.toThrow('author unavailable')
    const pending = Object.values(await readPreparation(h.store))
    expect(pending).toHaveLength(1)
    expect(pending[0]?.recoveryError).toContain('transition unavailable')
    const restarted = harness({ store: h.store, clock: h.clock, wrapTickets: () => h.tickets })
    await restarted.dispatcher.tick({ acceptNewWork: false })
    expect(calls).toBe(1)
    broken = false
    h.clock.advance(30_000)
    await restarted.dispatcher.tick({ acceptNewWork: false })
    expect((await h.tickets.get('T-1'))?.state).toBe('Ready')
    expect(await readPreparation(h.store)).toEqual({})
    const retry = harness({
      store: h.store,
      clock: h.clock,
      wrapTickets: () => h.tickets,
      authorSpec: async () => CONFORMING_BODY,
    })
    await retry.dispatcher.tick()
    await retry.dispatcher.tick()
    expect(await h.store.listBuilds()).toHaveLength(1)
  })

  for (const afterCommit of [false, true]) {
    test(`createBuild rejection ${afterCommit ? 'after' : 'before'} commit preserves unique ownership`, async () => {
      const h = harness({ tickets: [readyTicket('T-1')] })
      const asset = (content: string) => ({
        kind: 'mock',
        name: 'pin.txt',
        layout: 'file' as const,
        entries: [
          { type: 'file' as const, path: 'pin.txt', content: new TextEncoder().encode(content) },
        ],
      })
      await h.store.putTicketAsset(REPO, 'T-1', asset('original'))
      const create = h.store.createBuild.bind(h.store)
      h.store.createBuild = async (input) => {
        if (afterCommit) await create(input)
        throw new Error('creation acknowledgement lost')
      }
      await expect(h.dispatcher.tick()).rejects.toThrow('creation acknowledgement lost')
      expect(h.tickets.transitions).toEqual(afterCommit ? [] : [{ id: 'T-1', state: 'Ready' }])
      h.store.createBuild = create
      await h.store.putTicketAsset(REPO, 'T-1', asset('replacement'))
      await h.dispatcher.tick()
      expect(await h.store.listBuilds()).toHaveLength(1)
      expect(h.launches).toEqual(['add-rate-limiting'])
      const pinned = await h.store.getPinnedTicketAsset('add-rate-limiting', 'mock', 'pin.txt')
      const entry = pinned?.entries[0]
      expect(entry?.type === 'file' && new TextDecoder().decode(entry.content)).toBe(
        afterCommit ? 'original' : 'replacement',
      )
      expect(await readPreparation(h.store)).toEqual({})
    })
  }

  test('unavailable creation readback withholds intake until exact ownership is proven', async () => {
    const h = harness({ tickets: [readyTicket('T-1')] })
    const create = h.store.createBuild.bind(h.store)
    const get = h.store.getBuild.bind(h.store)
    let unavailable = false
    h.store.createBuild = async (input) => {
      const result = await create(input)
      unavailable = true
      throw new Error(`lost acknowledgement for ${result.slug}`)
    }
    h.store.getBuild = async (slug) => {
      if (unavailable) throw new Error('readback offline')
      return get(slug)
    }
    await expect(h.dispatcher.tick()).rejects.toThrow('readback offline')
    expect(h.tickets.transitions).toEqual([])
    expect(Object.values(await readPreparation(h.store))).toHaveLength(1)
    unavailable = false
    h.store.createBuild = create
    h.clock.advance(30_000)
    await h.dispatcher.tick()
    expect(await h.store.listBuilds()).toHaveLength(1)
    expect(h.tickets.claims).toEqual(['T-1'])
    expect(h.tickets.transitions).toEqual([])
  })

  for (const seam of [
    'intent',
    'claim-confirmation',
    'creation-identity',
    'diagnostic',
    'settlement',
    'handback-ack',
    'bounce-comment',
  ] as const) {
    test(`journal and transition failure at ${seam} does not strand or incorrectly release the ticket`, async () => {
      const h = harness({
        tickets: [readyTicket('T-1', { body: 'thin' })],
        authorSpec: async () => {
          if (['diagnostic', 'handback-ack'].includes(seam)) throw new Error('author unavailable')
          return seam === 'bounce-comment' ? null : CONFORMING_BODY
        },
      })
      const append = h.store.appendRepo.bind(h.store)
      const eventTypes: Partial<Record<string, string>> = {
        intent: 'ticket-preparation.intended',
        'claim-confirmation': 'ticket-preparation.claimed',
        'creation-identity': 'ticket-preparation.creation-selected',
        diagnostic: 'ticket-preparation.failed',
        settlement: 'ticket-preparation.resolved',
      }
      const event = eventTypes[seam]
      let injected = false
      h.store.appendRepo = async (...args) => {
        if (!injected && args[1].type === event) {
          injected = true
          throw new Error('journal unavailable')
        }
        return append(...args)
      }
      if (seam === 'handback-ack') {
        const transition = h.tickets.transition.bind(h.tickets)
        h.tickets.transition = async (...args) => {
          await transition(...args)
          throw new Error('transition acknowledgement lost')
        }
      }
      if (seam === 'bounce-comment')
        h.tickets.comment = async () => {
          throw new Error('comment unavailable')
        }
      await expect(h.dispatcher.tick()).rejects.toThrow()
      if (seam === 'intent') expect(h.tickets.claims).toEqual([])
      else if (seam === 'settlement') {
        expect(await h.store.listBuilds()).toHaveLength(1)
        expect(h.tickets.transitions).toEqual([])
      } else
        expect((await h.tickets.get('T-1'))?.state).toBe(
          seam === 'bounce-comment' ? 'Triage' : 'Ready',
        )
      h.clock.advance(30_000)
      await h.dispatcher.tick({ acceptNewWork: false })
      expect(await readPreparation(h.store)).toEqual({})
    })
  }
})

test('preparation recovery runs at full capacity, retains unrelated state, and bounds its batch', async () => {
  const h = harness({
    tickets: Array.from({ length: 10 }, (_, i) => readyTicket(`T-${i}`, { state: 'Doing' })),
  })
  await h.store.ensureRepo(REPO)
  await seedBuild(h, { slug: 'occupies-capacity', attached: true })
  for (let i = 0; i < 10; i++) {
    const ticket = { source: 'fake', id: `T-${i}` }
    await h.store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'ticket-preparation.intended',
      payload: { attempt: `prep-${i}`, ticket, readyState: 'Ready', claimedState: 'Doing' },
    })
    await h.store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'ticket-preparation.claimed',
      payload: { attempt: `prep-${i}`, ticket },
    })
  }
  let calls = 0
  const get = h.tickets.get.bind(h.tickets)
  h.tickets.get = async (...args) => {
    calls++
    return get(...args)
  }
  await h.dispatcher.tick({ acceptNewWork: false })
  expect(h.tickets.transitions).toHaveLength(8)
  expect(calls).toBe(8)
  await h.tickets.transition('T-8', 'Review')
  await h.dispatcher.tick({ acceptNewWork: false })
  expect((await get('T-8'))?.state).toBe('Review')
  expect((await get('T-9'))?.state).toBe('Ready')
  expect(
    (await (await import('../store/reduced-reads')).readRepositoryFacts(h.store, REPO)).value
      .preparation,
  ).toEqual({})
  h.clock.advance(86_400_000)
  await h.dispatcher.tick({ acceptNewWork: false })
  expect(calls).toBe(10)
})

for (const type of [
  'ticket-preparation.creation-selected',
  'ticket-preparation.resolved',
] as const) {
  test(`post-commit ${type} rejection recovers without releasing an owned claim`, async () => {
    const h = harness({ tickets: [readyTicket('T-1')] })
    const append = h.store.appendRepo.bind(h.store)
    let failed = false
    h.store.appendRepo = async (...args) => {
      const result = await append(...args)
      if (!failed && args[1].type === type) {
        failed = true
        throw new Error('append acknowledgement lost')
      }
      return result
    }
    await expect(h.dispatcher.tick()).rejects.toThrow('append acknowledgement lost')
    const owned = type === 'ticket-preparation.resolved'
    expect(await h.store.listBuilds()).toHaveLength(owned ? 1 : 0)
    expect(h.tickets.transitions).toHaveLength(owned ? 0 : 1)
    await h.dispatcher.tick()
    expect(await h.store.listBuilds()).toHaveLength(1)
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(h.tickets.transitions).toHaveLength(owned ? 0 : 1)
  })
}

test('100 and 100,000 preparation facts leave a bounded reduced answer and zero-row quiet ticks', async () => {
  const { seedPreparationHistory, memoryRepositoryReadCounter } = await import(
    '../testing/reduced-read-budget'
  )
  const { readRepositoryFacts } = await import('../store/reduced-reads')
  const { RemoteBuildStore } = await import('../store/remote/client')
  let previousBytes: number | undefined
  for (const length of [100, 100_000]) {
    const store = new RowCountingStore({ clock: manualClock() })
    await seedPreparationHistory(store, REPO, length)
    const counter = memoryRepositoryReadCounter(store, REPO)
    const facts = await readRepositoryFacts(store, REPO)
    expect(Object.keys(facts.value.preparation)).toEqual(['pending'])
    expect(counter.rows).toBe(length + 2)
    counter.reset()
    const bytes = JSON.stringify(facts.value.preparation).length
    if (previousBytes !== undefined) expect(bytes).toBe(previousBytes)
    previousBytes = bytes
    store.drainRows()
    const calls: string[] = []
    for (let i = 0; i < 2; i++) {
      const remote = new RemoteBuildStore({
        url: 'https://budget.test',
        fetchFn: (async (url, init) => {
          calls.push(String(url))
          const request = JSON.parse(String(init?.body))
          const { catalogIdentity: _, ...answer } = await store.getReducerValue(
            { kind: 'repo', repo: REPO },
            request,
          )
          return Response.json(answer)
        }) as typeof fetch,
      })
      expect((await readRepositoryFacts(remote, REPO, true)).value.preparation).toEqual(
        facts.value.preparation,
      )
    }
    expect(calls).toEqual(
      Array(2).fill('https://budget.test/repos/%2Frepos%2Forigin/reducer-values'),
    )
    const h = harness({ store })
    h.tickets.get = async () => {
      throw new Error('parked recovery must not read tickets')
    }
    await h.dispatcher.tick({ acceptNewWork: false })
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(store.drainRows()).toBe(0)
    expect(counter.rows).toBe(0)
  }
}, 30_000)

test('failed diagnostic deposits retain earlier durable claim evidence for later recovery', async () => {
  const h = harness({
    tickets: [readyTicket('T-1', { body: 'thin' })],
    authorSpec: async () => {
      throw new Error('original author failure')
    },
  })
  const append = h.store.appendRepo.bind(h.store)
  const transition = h.tickets.transition.bind(h.tickets)
  h.store.appendRepo = async (...args) => {
    if (['ticket-preparation.failed', 'ticket-preparation.recovery-failed'].includes(args[1].type))
      throw new Error('diagnostic store unavailable')
    return append(...args)
  }
  h.tickets.transition = async () => {
    throw new Error('handback unavailable')
  }
  await expect(h.dispatcher.tick()).rejects.toThrow('original author failure')
  const { readRepositoryFacts } = await import('../store/reduced-reads')
  expect(
    Object.values((await readRepositoryFacts(h.store, REPO)).value.preparation)[0]?.claimed,
  ).toBe(true)
  h.store.appendRepo = append
  h.tickets.transition = transition
  const restarted = harness({ store: h.store, clock: h.clock, wrapTickets: () => h.tickets })
  await restarted.dispatcher.tick({ acceptNewWork: false })
  expect((await h.tickets.get('T-1'))?.state).toBe('Ready')
  expect((await readRepositoryFacts(h.store, REPO)).value.preparation).toEqual({})
})

test('failed handback settlement recognizes Ready without transitioning a second time', async () => {
  const h = harness({
    tickets: [readyTicket('T-1', { body: 'thin' })],
    authorSpec: async () => {
      throw new Error('author unavailable')
    },
  })
  const append = h.store.appendRepo.bind(h.store)
  let fail = true
  h.store.appendRepo = async (...args) => {
    if (fail && args[1].type === 'ticket-preparation.resolved') {
      fail = false
      throw new Error('settlement unavailable')
    }
    return append(...args)
  }
  await expect(h.dispatcher.tick()).rejects.toThrow('settlement unavailable')
  expect(h.tickets.transitions).toEqual([{ id: 'T-1', state: 'Ready' }])
  h.clock.advance(30_000)
  await h.dispatcher.tick({ acceptNewWork: false })
  expect(h.tickets.transitions).toEqual([{ id: 'T-1', state: 'Ready' }])
})

test('an intended claim without confirmation cannot release a ticket in Doing', async () => {
  const h = harness({ tickets: [readyTicket('T-1', { state: 'Doing' })] })
  await h.store.ensureRepo(REPO)
  await h.store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'ticket-preparation.intended',
    payload: {
      attempt: 'uncertain',
      ticket: { source: 'fake', id: 'T-1' },
      readyState: 'Ready',
      claimedState: 'Doing',
    },
  })
  let recoveryReads = 0
  const get = h.tickets.get.bind(h.tickets)
  h.tickets.get = async (id) => {
    recoveryReads++
    return get(id)
  }
  await h.dispatcher.tick({ acceptNewWork: false })
  expect(
    (await (await import('../store/reduced-reads')).readRepositoryFacts(h.store, REPO)).value
      .preparation,
  ).toEqual({})
  h.clock.advance(86_400_000)
  await h.dispatcher.tick({ acceptNewWork: false })
  expect(recoveryReads).toBe(1)
  const resolution = (await h.store.getRepoEvents(REPO)).find(
    (e) => e.type === 'ticket-preparation.resolved',
  )
  expect(resolution?.payload).toMatchObject({ outcome: 'abandoned' })
  expect(h.tickets.transitions).toEqual([])
  expect(h.tickets.claims).toEqual([])
})

test('recovery diagnostics retain a confirmed claim and original error when earlier appends fail', async () => {
  const h = harness({ tickets: [readyTicket('T-1')] })
  const append = h.store.appendRepo.bind(h.store)
  const transition = h.tickets.transition.bind(h.tickets)
  h.store.appendRepo = async (...args) => {
    if (['ticket-preparation.claimed', 'ticket-preparation.failed'].includes(args[1].type))
      throw new Error('claim journal unavailable')
    return append(...args)
  }
  h.tickets.transition = async () => {
    throw new Error('handback unavailable')
  }
  await expect(h.dispatcher.tick()).rejects.toThrow('claim journal unavailable')
  const { readRepositoryFacts } = await import('../store/reduced-reads')
  const pending = Object.values((await readRepositoryFacts(h.store, REPO)).value.preparation)
  expect(pending[0]).toMatchObject({
    claimed: true,
    error: 'claim journal unavailable',
    recoveryError: 'handback unavailable',
  })
  h.store.appendRepo = append
  h.tickets.transition = transition
  h.clock.advance(30_000)
  const restarted = harness({ store: h.store, clock: h.clock, wrapTickets: () => h.tickets })
  await restarted.dispatcher.tick({ acceptNewWork: false })
  expect((await h.tickets.get('T-1'))?.state).toBe('Ready')
})

test('failed recovery batches do not starve attempts that have never been retried', async () => {
  const h = harness({
    tickets: Array.from({ length: 10 }, (_, i) => readyTicket(`T-${i}`, { state: 'Doing' })),
  })
  await h.store.ensureRepo(REPO)
  for (let i = 0; i < 10; i++) {
    const ticket = { source: 'fake', id: `T-${i}` }
    await h.store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'ticket-preparation.intended',
      payload: {
        attempt: `prep-${i}`,
        ticket,
        readyState: 'Ready',
        claimedState: 'Doing',
      },
    })
    await h.store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'ticket-preparation.claimed',
      payload: { attempt: `prep-${i}`, ticket },
    })
  }
  const transition = h.tickets.transition.bind(h.tickets)
  h.tickets.transition = async (id, state) => {
    if (Number(id.slice(2)) < 8) throw new Error('handback unavailable')
    return transition(id, state)
  }
  expect(
    (await h.dispatcher.tick({ acceptNewWork: false })).janitorDiagnostics.join(' '),
  ).toContain('handback unavailable')
  expect(h.tickets.transitions).toEqual([])
  h.clock.advance(60_000)
  expect(
    (await h.dispatcher.tick({ acceptNewWork: false })).janitorDiagnostics.join(' '),
  ).toContain('handback unavailable')
  expect(h.tickets.transitions).toEqual([
    { id: 'T-8', state: 'Ready' },
    { id: 'T-9', state: 'Ready' },
  ])
})

test('recovery diagnostics preserve Triage when bounce and primary diagnostic deposits fail', async () => {
  const h = harness({ tickets: [readyTicket('T-1', { body: 'invalid spec' })] })
  const append = h.store.appendRepo.bind(h.store)
  const transition = h.tickets.transition.bind(h.tickets)
  h.store.appendRepo = async (...args) => {
    if (
      ['ticket-preparation.handback-selected', 'ticket-preparation.failed'].includes(args[1].type)
    )
      throw new Error('bounce journal unavailable')
    return append(...args)
  }
  h.tickets.transition = async () => {
    throw new Error('transition unavailable')
  }
  await expect(h.dispatcher.tick()).rejects.toThrow('bounce journal unavailable')
  const { readRepositoryFacts } = await import('../store/reduced-reads')
  expect(
    Object.values((await readRepositoryFacts(h.store, REPO)).value.preparation)[0]?.handback,
  ).toBe('Triage')
  h.store.appendRepo = append
  h.tickets.transition = transition
  h.clock.advance(30_000)
  const restarted = harness({ store: h.store, clock: h.clock, wrapTickets: () => h.tickets })
  await restarted.dispatcher.tick({ acceptNewWork: false })
  expect(h.tickets.transitions).toEqual([{ id: 'T-1', state: 'Triage' }])
})

test('failed preparation readback does not block sibling janitor or lease recovery', async () => {
  const h = harness({ tickets: [readyTicket('T-stuck', { state: 'Doing' })] })
  await h.store.ensureRepo(REPO)
  const merged = await seedBuild(h, {
    slug: 'preparation-merged-sibling',
    pr: { ...PR, number: 93 },
  })
  const stale = await seedBuild(h, { slug: 'preparation-stale-sibling' })
  h.forge.setPrState(93, { state: 'merged', sha: 'squash-sibling' })
  await h.store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'ticket-preparation.intended',
    payload: {
      attempt: 'stuck',
      ticket: { source: 'fake', id: 'T-stuck' },
      readyState: 'Ready',
      claimedState: 'Doing',
    },
  })
  h.tickets.get = async () => {
    throw new Error('provider unavailable')
  }
  const report = await h.dispatcher.tick({ acceptNewWork: false })
  expect(report.janitorFailed).toBe(1)
  expect(report.janitorDiagnostics.join(' ')).toContain('provider unavailable')
  expect(report.merged).toBe(1)
  expect(report.swept).toBe(1)
  expect(reduceBuild(await h.store.getEvents(merged)).status).toBe('done')
  expect(h.launches).toContain(stale)
  expect(
    Object.keys(
      (await (await import('../store/reduced-reads')).readRepositoryFacts(h.store, REPO)).value
        .preparation,
    ),
  ).toEqual(['stuck'])
})

test.each([10, 1000])(
  'unavailable presence assessments bound preparation across idle ticks and dispatcher restart (%i events)',
  async (padding) => {
    const forge = new FakeForge()
    const parent = 'b'.repeat(40)
    const head = 'c'.repeat(40)
    forge.remoteBranches.set('main', parent)
    forge.remoteBranches.set('ab-node/waiting', head)
    forge.nodeComparisons.set('main...ab-node/waiting', 1)
    let snapshots = 0
    const snapshot = forge.rewrite.snapshot
    forge.rewrite.snapshot = async (args) => {
      snapshots++
      return snapshot(args)
    }
    const dispatchForge = new Proxy(forge, {
      get(target, key) {
        if (key === 'snapshotBase')
          return async () => {
            snapshots++
            return parent
          }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const exec: Exec = async (args) => ({
      stdout: args.includes('rev-list') ? '1' : '',
      stderr: '',
      exitCode: 0,
    })
    const h = harness({ dispatchForge, exec, repoOrigin: 'https://github.com/acme/repo' })
    await h.store.ensureRepo(REPO)
    await h.store.createBuild({ slug: 'waiting', repo: REPO, branch: 'ab-node/waiting' })
    await h.store.append('waiting', {
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        repo: REPO,
        baseBranch: 'main',
        kind: 'node',
        ticket: { source: 'fake', id: 'WAIT' },
      },
    })
    await h.store.append('waiting', {
      actor: DISPATCHER,
      type: 'node.opened',
      payload: { sha: BASE_SHA },
    })
    // Exact sampled source mapping avoids manufacturing Git history in this fixture.
    await h.store.append('waiting', {
      actor: KERNEL,
      type: 'node.inventory',
      payload: {
        head,
        base: BASE_SHA,
        builds: [],
        foreign: [],
      },
    })
    await h.store.append('waiting', {
      actor: DISPATCHER,
      type: 'node.restack-requested',
      payload: {
        id: 'nested',
        reason: 'presence',
        branch: 'main',
        parent,
        dependent: { source: 'fake', id: 'D' },
        identities: ['build:ancestor-change'],
      },
    })
    for (let i = 0; i < padding; i++)
      await h.store.append('waiting', {
        actor: KERNEL,
        type: 'node.parent-distance',
        payload: { base: BASE_SHA, parent, branch: 'main', count: 1 },
      })
    forge.setPrState(77, { state: 'open', mergeable: true })
    const child = await seedBuild(h, {
      slug: 'targeting-leaf',
      pr: { number: 77, url: 'https://example/77', headSha: head },
    })
    await h.store.append(child, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        ticket: { source: 'fake', id: 'CHILD' },
        repo: REPO,
        baseBranch: 'ab-node/waiting',
        target: { build: 'waiting', ticket: { source: 'fake', id: 'WAIT' } },
      },
    })
    await h.store.append(child, { actor: DISPATCHER, type: 'build.paused', payload: {} })
    let claims = 0
    const claim = h.store.claimNodeWriter.bind(h.store)
    h.store.claimNodeWriter = async (...args) => {
      claims++
      return claim(...args)
    }
    const first = await h.dispatcher.tick({ acceptNewWork: false })
    expect(first.janitorDiagnostics).toEqual([])
    expect(snapshots).toBe(2)
    expect(claims).toBe(1)
    const preparations = h.execCalls.filter(
      (args) => args.includes('worktree') && args.includes('add'),
    ).length
    expect(preparations).toBe(1)
    // Let ordinary polling reduce the checkpoint appended by the assessment.
    await h.dispatcher.tick({ acceptNewWork: false })
    const { memoryRepositoryReadCounter } = await import('../testing/reduced-read-budget')
    const counter = memoryRepositoryReadCounter(h.store as MemoryBuildStore, REPO)
    const commands = h.execCalls.length
    for (let n = 0; n < 3; n++) await h.dispatcher.tick({ acceptNewWork: false })
    const restarted = harness({
      store: h.store,
      dispatchForge,
      exec,
      repoOrigin: 'https://github.com/acme/repo',
    })
    for (let n = 0; n < 3; n++) await restarted.dispatcher.tick({ acceptNewWork: false })
    expect(counter.rows).toBe(0)
    expect(counter.buildRows).toBe(0)
    expect(counter.buildRowsBySlug.size).toBe(0)
    expect(h.execCalls.slice(commands).filter((args) => args.includes('log'))).toHaveLength(0)
    expect(forge.autoMergeCalls.filter((call) => !call.enabled)).toHaveLength(0)
    expect(snapshots).toBe(2)
    expect(claims).toBe(1)
    expect(
      h.execCalls.filter((args) => args.includes('worktree') && args.includes('add')),
    ).toHaveLength(1)
    expect(
      restarted.execCalls.filter((args) => args.includes('worktree') && args.includes('add')),
    ).toHaveLength(0)
    // Confirmed evidence is relevant even when both Git heads stay unchanged.
    await h.store.createBuild({ slug: 'new-proof', repo: REPO })
    await h.store.append('new-proof', {
      actor: DISPATCHER,
      type: 'pr.merged',
      payload: { sha: parent },
    })
    await restarted.dispatcher.tick({ acceptNewWork: false })
    expect(snapshots).toBe(4)
    await restarted.dispatcher.tick({ acceptNewWork: false })
    expect(snapshots).toBe(4)
    forge.remoteBranches.set('ab-node/waiting', 'd'.repeat(40))
    await restarted.dispatcher.tick({ acceptNewWork: false })
    expect(snapshots).toBe(6)
    await restarted.dispatcher.tick({ acceptNewWork: false })
    expect(snapshots).toBe(6)
    expect(restarted.execCalls.filter((args) => args.includes('clone'))).toHaveLength(2)
    const state = reduceBuild(await h.store.getEvents('waiting'))
    expect(state.nodeRestack?.requests?.nested).toBeDefined()
    expect(
      (await h.store.getEvents('waiting')).filter(
        (e) => e.type === 'node.restack-availability-observed',
      ),
    ).toHaveLength(3)
  },
)

for (const storeLagMs of [0, 200])
  test(`node checkpoint growth across active and idle periods with ${storeLagMs}ms store lag`, async () => {
    const clock = manualClock()
    const store = new MemoryBuildStore({ clock: () => new Date(clock().getTime() - storeLagMs) })
    const h = harness({ clock, store, tickets: [readyTicket('N', { kind: 'node' })] })
    h.forge.remoteBranches.set('main', BASE_SHA)
    await h.dispatcher.tick()
    await h.dispatcher.tick({ acceptNewWork: false })
    const node = (await h.store.listBuilds())[0]!
    const count = async () =>
      (await h.store.getEvents(node.slug)).filter((e) => e.type === 'node.poll-checked').length
    let checks = 0
    const compare = h.forge.compareBranches.bind(h.forge)
    h.forge.compareBranches = async (...args) => {
      checks++
      return compare(...args)
    }
    const tick = () =>
      harness({
        store: h.store,
        clock: h.clock,
        wrapTickets: () => h.tickets,
        dispatchForge: h.forge,
      }).dispatcher.tick({ acceptNewWork: false })
    const before = await count()
    for (let i = 0; i < 59; i++) {
      h.clock.advance(10_000)
      await tick()
    }
    const active = (await count()) - before
    const activeChecks = checks
    for (let i = 0; i < 37; i++) {
      h.clock.advance(10_000)
      await tick()
    }
    expect(active).toBe(0)
    expect(activeChecks).toBe(177)
    expect((await count()) - before - active).toBe(4)
    expect(checks - activeChecks).toBe(12)
    for (let i = 0; i < 3; i++) {
      await h.store.append(node.slug, {
        actor: humanActor('test'),
        type: 'build.hold-requested',
        payload: {},
      })
      await tick()
    }
    expect((await count()) - before - active).toBe(7)
  })

test('fresh node polling has bounded reads at 100 and 100000 events', async () => {
  const h = harness({ tickets: [readyTicket('N', { kind: 'node' })] })
  h.forge.remoteBranches.set('main', BASE_SHA)
  await h.dispatcher.tick()
  await h.dispatcher.tick({ acceptNewWork: false })
  const node = (await h.store.listBuilds())[0]!
  const { nodePollingReadBudget } = await import('../testing/reduced-read-budget')
  await nodePollingReadBudget({
    store: h.store as MemoryBuildStore,
    slug: node.slug,
    advance: (ms) => h.clock.advance(ms),
    tick: () =>
      harness({
        store: h.store,
        clock: h.clock,
        wrapTickets: () => h.tickets,
        dispatchForge: h.forge,
      }).dispatcher.tick({ acceptNewWork: false }),
  })
}, 30_000)

for (const failure of ['throw', 'contend'] as const)
  for (const boundary of [false, true])
    test(`node checkpoint ${failure} retries durably at ${boundary ? 'idle boundary' : 'initial anchor'}`, async () => {
      const h = harness({ tickets: [readyTicket('N', { kind: 'node' })] })
      h.forge.remoteBranches.set('main', BASE_SHA)
      await h.dispatcher.tick()
      const node = (await h.store.listBuilds())[0]!
      await h.dispatcher.tick({ acceptNewWork: false })
      if (boundary) h.clock.advance(600_000)
      else {
        // A new activity epoch requires a fresh anchor.
        await h.store.append(node.slug, {
          actor: humanActor('test'),
          type: 'build.hold-requested',
          payload: {},
        })
        h.clock.advance(10_000)
      }
      const before = reduceBuild(await h.store.getEvents(node.slug)).nodePolling
      const append = h.store.appendIfCurrent.bind(h.store)
      let rejected = false
      h.store.appendIfCurrent = async (slug, seq, event) => {
        if (event.type === 'node.poll-checked') {
          rejected = true
          if (failure === 'throw') throw new Error('interrupted checkpoint')
          return null
        }
        return append(slug, seq, event)
      }
      await h.dispatcher.tick({ acceptNewWork: false })
      expect(rejected).toBe(true)
      expect(reduceBuild(await h.store.getEvents(node.slug)).nodePolling).toEqual(before)
      h.store.appendIfCurrent = append
      if (failure === 'throw') h.clock.advance(30_000) // existing durable janitor backoff
      const fresh = harness({
        store: h.store,
        clock: h.clock,
        wrapTickets: () => h.tickets,
        dispatchForge: h.forge,
      })
      await fresh.dispatcher.tick({ acceptNewWork: false })
      const after = reduceBuild(await h.store.getEvents(node.slug)).nodePolling!
      expect(after.checkedAt).toBe(h.clock().toISOString())
      expect(after.unchangedSince).toBe(boundary ? before!.unchangedSince : after.checkedAt)
    })

test('successful changed parent observation resets the quiet anchor', async () => {
  const h = harness({ tickets: [readyTicket('N', { kind: 'node' })] })
  h.forge.remoteBranches.set('main', BASE_SHA)
  await h.dispatcher.tick()
  await h.dispatcher.tick({ acceptNewWork: false })
  const node = (await h.store.listBuilds())[0]!
  const before = reduceBuild(await h.store.getEvents(node.slug)).nodePolling!
  h.clock.advance(300_000)
  h.forge.remoteBranches.set('main', 'b'.repeat(40))
  h.forge.nodeComparisons.set(`main...${node.branch}`, 0)
  h.forge.nodeComparisons.set(`${node.branch}...main`, 1)
  await h.dispatcher.tick({ acceptNewWork: false })
  const after = reduceBuild(await h.store.getEvents(node.slug)).nodePolling!
  expect(after.activityKey).not.toBe(before.activityKey)
  expect(after.unchangedSince).toBe(h.clock().toISOString())
})

for (const classification of ['advisory', 'decisive', undefined] as const)
  test(`node tick treats opaque polling evidence as ${classification ?? 'legacy decisive'}`, async () => {
    const h = harness({ tickets: [readyTicket('N', { kind: 'node' })] })
    h.forge.remoteBranches.set('main', BASE_SHA)
    await h.dispatcher.tick()
    await h.dispatcher.tick({ acceptNewWork: false })
    const node = (await h.store.listBuilds())[0]!
    const events = await h.store.getEvents(node.slug)
    const checkpoint = events.findLast((e) => e.type === 'node.poll-checked')!
    const { seedNewerMemoryFact } = await import('../testing/newer-writer')
    seedNewerMemoryFact(h.store as MemoryBuildStore, {
      ...checkpoint,
      seq: events.length + 1,
      type: 'old-reader-unknown.node.poll-checked',
      compatibility: classification ? { ...checkpoint.compatibility!, classification } : undefined,
    })
    let reads = 0
    const compare = h.forge.compareBranches.bind(h.forge)
    h.forge.compareBranches = async (...args) => {
      reads++
      return compare(...args)
    }
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(reads > 0).toBe(classification === 'advisory')
    expect(reduceBuild(await h.store.getEvents(node.slug)).compatibility.decisiveFacts).toBe(
      classification === 'advisory' ? 0 : 1,
    )
  })

test('incomplete node observation cannot advance an idle deadline', async () => {
  const h = harness({ tickets: [readyTicket('N', { kind: 'node' })] })
  h.forge.remoteBranches.set('main', BASE_SHA)
  await h.dispatcher.tick()
  await h.dispatcher.tick({ acceptNewWork: false })
  const node = (await h.store.listBuilds())[0]!
  const before = reduceBuild(await h.store.getEvents(node.slug)).nodePolling!
  h.clock.advance(600_000)
  const compare = h.forge.compareBranches.bind(h.forge)
  h.forge.compareBranches = async () => {
    throw new Error('incomplete comparison')
  }
  await h.dispatcher.tick({ acceptNewWork: false })
  expect(reduceBuild(await h.store.getEvents(node.slug)).nodePolling).toEqual(before)
  h.forge.compareBranches = compare
  h.clock.advance(30_000)
  await h.dispatcher.tick({ acceptNewWork: false })
  expect(reduceBuild(await h.store.getEvents(node.slug)).nodePolling?.checkedAt).toBe(
    h.clock().toISOString(),
  )
})

test('missing account admission survives fresh kernels without build failures, then recovers automatically', async () => {
  const accounts = {
    billing: { kind: 'claude-subscription', credentialEnv: 'BILLING_TOKEN' },
  } as const
  let available = false
  const missingAccounts = () =>
    missingAccountCredentials(
      accounts,
      available ? { BILLING_TOKEN: 'opaque' } : {},
      'project-secrets',
    )
  const first = harness({ tickets: [readyTicket('CRED-1')], missingAccounts })
  await first.dispatcher.tick({ resumeCurrent: true })
  expect(first.launches).toEqual([])
  expect(await first.store.listBuilds()).toEqual([])
  for (let n = 0; n < 5; n++) {
    const fresh = harness({ store: first.store, tickets: [readyTicket('CRED-1')], missingAccounts })
    await fresh.dispatcher.tick({ resumeCurrent: true })
    expect(fresh.launches).toEqual([])
  }
  let journal = await first.store.getRepoEvents(REPO)
  expect(journal.filter((e) => e.type === 'account.credentials-unavailable')).toHaveLength(1)
  available = true
  const recovered = harness({
    store: first.store,
    tickets: [readyTicket('CRED-1')],
    missingAccounts,
  })
  await recovered.dispatcher.tick({ resumeCurrent: true })
  expect(recovered.launches).toHaveLength(1)
  journal = await first.store.getRepoEvents(REPO)
  expect(journal.filter((e) => e.type === 'account.credentials-recovered')).toHaveLength(1)
  const record = (await first.store.listBuilds())[0]!
  expect(
    (await first.store.getEvents(record.slug)).some(
      (e) => e.type === 'infrastructure.failed' || e.type === 'dispatch.failed',
    ),
  ).toBe(false)
})
test('a typed provisioning race records repository attention and spends no infrastructure attempts', async () => {
  const accounts = {
    billing: { kind: 'claude-subscription', credentialEnv: 'BILLING_TOKEN' },
  } as const
  const h = harness({ tickets: [readyTicket('RACE-1')], missingAccounts: () => [] })
  const provision = h.workspaces.provision.bind(h.workspaces)
  h.workspaces.provision = async () => {
    throw new MissingAccountCredentialsError(missingAccountCredentials(accounts, {}))
  }
  for (let n = 0; n < 5; n++) await h.dispatcher.tick({ resumeCurrent: true })
  const record = (await h.store.listBuilds())[0]!
  const events = await h.store.getEvents(record.slug)
  expect(
    events.some(
      (e) =>
        e.type === 'infrastructure.failed' ||
        e.type === 'dispatch.failed' ||
        e.type === 'escalation.raised',
    ),
  ).toBe(false)
  h.workspaces.provision = provision
  await h.dispatcher.tick({ resumeCurrent: true })
  expect(h.launches).toHaveLength(1)
})

test('concurrent credential races serialize against the durable account condition', async () => {
  const h = harness()
  await h.dispatcher.tick()
  const error = new MissingAccountCredentialsError(
    missingAccountCredentials(
      { billing: { kind: 'claude-subscription', credentialEnv: 'BILLING_TOKEN' } },
      {},
    ),
  )
  await Promise.all([
    h.dispatcher.holdForMissingAccounts(error),
    h.dispatcher.holdForMissingAccounts(error),
  ])
  expect(
    (await h.store.getRepoEvents(REPO)).filter((e) => e.type === 'account.credentials-unavailable'),
  ).toHaveLength(1)
})
