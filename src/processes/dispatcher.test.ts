/**
 * Dispatcher tests (SPEC §3.3, §6.3, §12, §15.7 D1, §15.6-C): memory store +
 * all fakes, sequentialIds + manualClock — deterministic and offline.
 */
import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import { DISPATCHER, KERNEL, agentActor, humanActor } from '../events/envelope'
import { sequentialIds } from '../ids'
import { reduceBuild } from '../kernel/reducer'
import type { WorkspaceBase } from '../ontology'
import { FakeForge } from '../ports/forge/fake'
import { FakeTicketSource } from '../ports/tickets/fake'
import type { Ticket } from '../ports/types'
import { FakeWorkspaceProvider } from '../ports/workspace/fake'
import type { Exec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import { textContent } from '../store/types'
import { manualClock } from '../testing/fixed'
import {
  Dispatcher,
  analyzeDependencies,
  emptyTickReport,
  fallbackSlug,
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
const BASE_SHA = 'base-sha-42'

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
    ref: { source: 'fake', id, title },
    title,
    body: over.body ?? CONFORMING_BODY,
    state: over.state ?? 'Ready',
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
  if (/(^|\n)\s*readyState\s*=/.test(toml)) return toml
  if (/(^|\n)\[tickets\]/.test(toml)) {
    return toml.replace(/(^|\n)(\[tickets\][^\n]*\n)/, `$1$2readyState = "Ready"\n`)
  }
  return `[tickets]\nsource = "file"\nreadyState = "Ready"\n${toml}`
}

function harness(
  opts: {
    tickets?: Ticket[]
    toml?: string
    authorSpec?: (ticket: Ticket) => Promise<string | null>
    nameSlug?: (spec: string, signal: AbortSignal) => Promise<string | null>
    opts?: DispatcherOpts
    /** Wrap the fake ticket source — e.g. to make dependencyStates throw. */
    wrapTickets?: (source: FakeTicketSource) => FakeTicketSource
    startHarvest?: () => void
    launchResult?: LaunchRunnerResult
    onLaunch?: (
      slug: string,
      store: MemoryBuildStore,
    ) => Promise<void> | void
    workspaceBase?: WorkspaceBase
  } = {},
) {
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  const fakeTickets = new FakeTicketSource(opts.tickets ?? [])
  const tickets = opts.wrapTickets ? opts.wrapTickets(fakeTickets) : fakeTickets
  const workspaces = new FakeWorkspaceProvider({
    root: '/ws',
    mode: 'logical',
    ...(opts.workspaceBase ? { base: opts.workspaceBase } : {}),
  })
  const forge = new FakeForge()
  const launches: string[] = []
  const execCalls: string[][] = []
  const exec: Exec = async (cmd) => {
    execCalls.push(cmd)
    return { stdout: `${BASE_SHA}\trefs/heads/main\n`, stderr: '', exitCode: 0 }
  }
  const dispatcher = new Dispatcher({
    store,
    tickets,
    workspaces,
    forge,
    config: parseConfig(withReadyState(opts.toml ?? '')),
    repo: REPO,
    exec,
    launchRunner: async (slug) => {
      await opts.onLaunch?.(slug, store)
      launches.push(slug)
      return opts.launchResult ?? 'scheduled'
    },
    ...(opts.authorSpec ? { authorSpec: opts.authorSpec } : {}),
    ...(opts.nameSlug ? { nameSlug: opts.nameSlug } : {}),
    ...(opts.startHarvest ? { startHarvest: opts.startHarvest } : {}),
    ids: sequentialIds(),
    clock,
    ...(opts.opts ? { opts: opts.opts } : {}),
  })
  return { clock, store, tickets, workspaces, forge, launches, execCalls, dispatcher }
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
    ticketId?: string
    repo?: string
    workspace?: boolean
    attached?: boolean
    pr?: { number: number; url: string; headSha: string }
  } = {},
): Promise<string> {
  const slug = opts.slug ?? 'auth-limit'
  const repo = opts.repo ?? REPO
  const ticket = { source: 'fake', id: opts.ticketId ?? `T-${slug}`, title: slug }
  await h.store.createBuild({
    slug,
    repo,
    ...(opts.ticketId ? { ticket } : {}),
    branch: `ab/${slug}`,
  })
  await h.store.append(slug, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: { ticket, repo, baseBranch: 'main' },
  })
  if (opts.workspace !== false) {
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'workspace.provisioned',
      payload: {
        provider: 'fake',
        ref: `/ws/ab/${slug}`,
        branch: `ab/${slug}`,
        base: { source: 'remote', sha: 'fake-base-sha' },
      },
    })
  }
  await h.store.append(slug, {
    actor: DISPATCHER,
    type: 'spec.imported',
    payload: { artifact: { kind: 'spec', rev: 0 }, ticket },
  })
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
    payload: { round: 1, verdict: 'approve', findings: [], artifact: { kind: 'plan-review', rev: 0 } },
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
    payload: { round: 1, verdict: 'approve', findings: [], artifact: { kind: 'code-review', rev: 0 } },
  })
}

/** Seed a fully green build parked in the post-PR epilogue. */
async function seedAwaitingPr(h: Harness, slug = 'auth-limit'): Promise<string> {
  await seedBuild(h, { slug })
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
    const body =
      'Why.\n\n# Acceptance criteria\n- one\n\n## Details\n\nprose\n\n# Out of scope\n'
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
    expect(fallbackSlug('Please add support for login throttling')).toBe(
      'please-add-support',
    )
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

    // Exact event sequence (§12): created → provisioned → spec imported.
    const events = await h.store.getEvents('add-rate-limiting')
    expect(events.map((e) => e.type)).toEqual([
      'build.created',
      'workspace.provisioned',
      'spec.imported',
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
      branch: 'ab/add-rate-limiting',
      base: { source: 'remote', sha: 'fake-base-sha' },
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
    expect(h.tickets.comments).toEqual([
      { id: 'T-1', body: 'build add-rate-limiting dispatched' },
    ])
    expect(h.launches).toEqual(['add-rate-limiting'])
  })

  test('claim-time auto-merge records the existing human fact before runner launch', async () => {
    let launchSnapshot: string[] = []
    const h = harness({
      tickets: [readyTicket('T-auto')],
      onLaunch: async (slug, store) => {
        launchSnapshot = (await store.getEvents(slug)).map(
          (event) => event.type,
        )
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
      'build.auto-merge-requested',
      'workspace.provisioned',
      'spec.imported',
    ])
    expect(launchSnapshot).toEqual(events.map((event) => event.type))
    expect(events[1]?.actor).toEqual({ kind: 'human', user: 'dispatch-op' })
    expect(events[1]?.payload).toEqual({})
    expect(reduceBuild(events).autoMerge.requested).toBe(true)
  })

  test('an explicit off default preserves the original event sequence', async () => {
    const h = harness({ tickets: [readyTicket('T-off')] })

    await h.dispatcher.tick({
      defaultAutoMerge: false,
      autoMergeUser: 'unused-operator',
    })

    expect(
      (await h.store.getEvents('add-rate-limiting')).map(
        (event) => event.type,
      ),
    ).toEqual([
      'build.created',
      'workspace.provisioned',
      'spec.imported',
    ])
  })

  test('the default never touches resumed or directly created builds', async () => {
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

    expect(await h.store.getEvents(resumed)).toEqual(beforeResumed)
    expect(await h.store.getEvents('direct-build')).toEqual(beforeDirect)
    expect(h.launches).toEqual([resumed])
  })

  test('an on default requires valid human attribution before claiming', async () => {
    const h = harness({ tickets: [readyTicket('T-no-user')] })

    await expect(
      h.dispatcher.tick({ defaultAutoMerge: true, autoMergeUser: '   ' }),
    ).rejects.toThrow('requires nonempty human attribution')
    expect(h.tickets.claims).toEqual([])
    expect(await h.store.listBuilds()).toEqual([])
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
    expect(provisioned?.payload.base).toEqual(base)
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
    expect((await h.store.listBuilds()).map((build) => build.slug)).toEqual([
      'login-rate-limit',
    ])
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
      expect((await h.store.listBuilds())[0]?.slug, scenario.name).toBe(
        'please-add-support',
      )
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
      toml: [
        '[tickets]',
        'source = "file"',
        'readyState = "Ready"',
        '[dispatcher]',
        'capacity = 2',
      ].join('\n'),
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
        '[tickets]',
        'source = "file"',
        'readyLabels = ["autobuild"]',
        'readyState = "Ready"',
        '[dispatcher]',
        'capacity = 2', // room for BOTH — so a skip is a real gate, not a cap
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
    await h.tickets.claim('T-1') // another dispatcher won the claim

    const report = await h.dispatcher.tick()
    expect(report).toEqual({ ...emptyTickReport(), claimRaces: 1 })
    expect(await h.store.listBuilds()).toEqual([])
    expect(h.launches).toEqual([])
  })

  test('capacity 1, two ready tickets: second lands next tick after the first completes', async () => {
    const h = harness({
      tickets: [
        readyTicket('T-1', { title: 'First feature' }),
        readyTicket('T-2', { title: 'Second feature' }),
      ],
    })

    const first = await h.dispatcher.tick()
    expect(first).toEqual({ ...emptyTickReport(), dispatched: 1 })
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
    // claimRaces: 1 — the fake still lists the already-claimed T-1 as Ready;
    // the claim-before-launch gate is exactly what makes that harmless (§12).
    expect(second).toEqual({ ...emptyTickReport(), dispatched: 1, claimRaces: 1 })
    expect((await h2.store.listBuilds()).map((b) => b.slug)).toEqual([
      'first-feature',
      'second-feature',
    ])
    expect(h2.launches).toEqual(['first-feature', 'second-feature'])
  })

  test('capacity counts blocked and paused builds as occupying slots', async () => {
    // Blocked: an open escalation (§15.5) holds the slot.
    const blocked = harness({ tickets: [readyTicket('T-1')] })
    await seedBuild(blocked, { slug: 'stuck' })
    await blocked.store.append('stuck', {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: { id: 'e_1', phase: 'implement', source: 'stall', question: 'same finding 3 rounds' },
    })
    expect(await blocked.dispatcher.tick()).toEqual(emptyTickReport())
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
    expect(await paused.dispatcher.tick()).toEqual(emptyTickReport())
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
    expect(comment?.body).toContain('docs/spec-standard.md')
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
      authorSpec: async (ticket) =>
        ticket.ref.id === 'T-1' ? 'still not a spec' : null,
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
      toml: '[dispatcher]\ncapacity = 2\n',
      nameSlug: async () => 'login-rate-limit',
    })

    const report = await h.dispatcher.tick()
    expect(report).toEqual({ ...emptyTickReport(), dispatched: 2 })
    const builds = await h.store.listBuilds()
    expect(builds.map((b) => b.slug)).toEqual([
      'login-rate-limit',
      'login-rate-limit-2',
    ])
    expect(builds.map((b) => b.branch)).toEqual([
      'ab/login-rate-limit',
      'ab/login-rate-limit-2',
    ])
    expect(h.launches).toEqual(['login-rate-limit', 'login-rate-limit-2'])
  })

  test('uniqueness skips later occupied suffixes and never changes an existing long slug', async () => {
    const oldSlug = 'existing-build-with-a-long-historical-slug'
    const h = harness({
      tickets: [readyTicket('T-new')],
      toml: '[dispatcher]\ncapacity = 4\n',
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
      new Promise<'timed-out'>((resolve) =>
        setTimeout(() => resolve('timed-out'), 20),
      ),
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

    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual(
      emptyTickReport(),
    )
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
    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual(
      emptyTickReport(),
    )
    expect(calls).toBe(2)

    await h.store.appendRepo(REPO, {
      actor: humanActor('operator'),
      type: 'harvest.resume-requested',
      payload: {},
    })
    expect(await h.dispatcher.tick({ acceptNewWork: false })).toEqual(
      emptyTickReport(),
    )
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
    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
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

describe('Dispatcher dependency gate', () => {
  /** readyState pins the candidate set to Ready tickets, so a blocker parked
   * in another state is a dependency and not itself dispatchable work — the
   * arrangement these tests are actually about. */
  const CAPACITY_2 = [
    '[tickets]',
    'source = "file"',
    'readyState = "Ready"',
    '[dispatcher]',
    'capacity = 2',
  ].join('\n')

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
    expect(report.dependencyDiagnostics).toEqual([
      'ticket T-1 blocked by T-9 (not complete)',
    ])
    // Never claimed (§12: the gate precedes claim-before-launch)…
    expect(h.tickets.claims).not.toContain('T-1')
    // …no build, no workspace, no projection outward.
    expect((await h.store.listBuilds()).map((b) => b.slug)).not.toContain(
      'blocked-work',
    )
    expect(h.workspaces.provisions.map((p) => p.branch)).not.toContain(
      'ab/blocked-work',
    )
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
      toml: [
        '[tickets]',
        'source = "file"',
        'readyState = "Ready"',
        '[dispatcher]',
        'capacity = 1',
      ].join('\n'),
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

    // Native lifecycle only: the blocker reaches the source's done state.
    await h.tickets.transition('T-9', 'Done')

    const second = await h.dispatcher.tick()
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
    const second = await h.dispatcher.tick()
    expect(second.dependencyBlocked).toBe(1)
    expect(second.dispatched).toBe(0)
    expect(second.dependencyDiagnostics).toEqual([
      'ticket T-1 blocked by T-9 (not complete)',
    ])

    await h.tickets.transition('T-9', 'Done')
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

    expect(report.dependencyBlocked).toBe(1)
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
    expect((await h.store.listBuilds()).map((b) => b.slug)).toContain(
      'unblocked-work',
    )
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
      toml: [
        '[tickets]',
        'source = "file"',
        'readyState = "Done"',
        '[dispatcher]',
        'capacity = 5',
      ].join('\n'),
    })

    const report = await h.dispatcher.tick()

    // T-2 is Done, so T-3 is eligible. Every real state must be fetched.
    expect(report.dependencyDiagnostics).toEqual([])
    expect(report.dependencyBlocked).toBe(0)
    expect((await h.store.listBuilds()).map((b) => b.ticket?.id)).toContain('T-3')
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
    expect(report.dependencyDiagnostics).toContain(
      'ticket T-1 blocked by T-2 (not complete)',
    )
    expect(h.tickets.dependencyQueries).toEqual([['T-2'], ['T-3']])
  })
})

describe('Dispatcher janitor', () => {
  test('merged PR: pr.merged once, release, Done transition, completed{merged}; second tick no-ops', async () => {
    const h = harness({ tickets: [readyTicket('T-1', { labels: [] })] })
    const slug = await seedBuild(h, { ticketId: 'T-1', pr: PR })
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
    expect(prMerged?.payload).toEqual({ sha: 'squash-1' })
    expect(events.at(-1)?.payload).toEqual({ outcome: 'merged' })
    expect(h.workspaces.releases.map((r) => r.ref)).toEqual([`/ws/ab/${slug}`])
    expect(h.tickets.transitions).toEqual([{ id: 'T-1', state: 'Done' }])
    expect(h.tickets.comments).toEqual([
      { id: 'T-1', body: expect.stringContaining(PR.url) },
    ])

    // Second tick: the build is done — the whole pass is a no-op.
    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(await h.store.getEvents(slug)).toHaveLength(events.length)
    expect(h.workspaces.releases).toHaveLength(1)
    expect(h.tickets.transitions).toHaveLength(1)
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

  test('open PR: applies and acknowledges a post-PR auto-merge request exactly once', async () => {
    const h = harness()
    const slug = await seedBuild(h, { pr: PR })
    const command = await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    await h.store.claimLease(slug, 'runner-live', 60_000)

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.forge.autoMergeCalls).toEqual([
      {
        workspacePath: `/ws/ab/${slug}`,
        number: 1,
        enabled: true,
        changed: true,
      },
    ])
    const applied = (await h.store.getEvents(slug)).at(-1)
    expect(applied?.type).toBe('pr.auto-merge-enabled')
    expect(applied?.actor).toEqual(DISPATCHER)
    expect(applied?.payload).toEqual({ commandSeq: command.seq })

    // Matching command seq + value is settled; another poll does not call the
    // forge at all (not merely another idempotent mutation).
    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.forge.autoMergeCalls).toHaveLength(1)
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
    const cancel = await h.store.append(slug, {
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
    const applied = (await h.store.getEvents(slug)).at(-1)
    expect(applied?.type).toBe('pr.auto-merge-disabled')
    expect(applied?.payload).toEqual({ commandSeq: cancel.seq })
  })

  test('call-before-event and failure windows retry through the idempotent setter', async () => {
    const h = harness()
    const slug = await seedBuild(h, { pr: PR })
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

    await expect(h.dispatcher.tick()).rejects.toThrow('forge temporarily unavailable')
    expect((await h.store.getEvents(slug)).some((e) => e.type === 'pr.auto-merge-enabled')).toBe(false)

    await h.dispatcher.tick()
    // Native state was already true, so this is an idempotent no-op call whose
    // correlated fact repairs the event log.
    expect(h.forge.autoMergeCalls).toEqual([
      {
        workspacePath: `/ws/ab/${slug}`,
        number: 1,
        enabled: true,
        changed: false,
      },
    ])
    const applied = (await h.store.getEvents(slug)).at(-1)
    expect(applied?.type).toBe('pr.auto-merge-enabled')
    expect(applied?.payload).toEqual({ commandSeq: command.seq })
  })

  test('native auto-merge completion is observed by the ordinary next poll', async () => {
    const h = harness()
    const slug = await seedBuild(h, { pr: PR })
    await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    await h.store.claimLease(slug, 'runner-live', 60_000)
    await h.dispatcher.tick()

    h.forge.setPrState(1, { state: 'merged', sha: 'native-squash' })
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), merged: 1 })
    expect((await h.store.getEvents(slug)).map((e) => e.type).slice(-3)).toEqual([
      'pr.merged',
      'workspace.released',
      'build.completed',
    ])
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
      },
    ])
    const afterMergeCall = await h.store.getEvents(slug)
    expect(afterMergeCall.some((e) => e.type === 'pr.auto-merge-enabled')).toBe(false)
    expect(afterMergeCall.some((e) => e.type === 'pr.merged')).toBe(false)

    // The forge call is not a speculative event. The ordinary next poll sees
    // the landed PR and emits the existing completion facts.
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
    expect(noIntent.forge.autoMergeCalls).toEqual([])
    expect(noIntent.forge.squashMergeCalls).toEqual([])

    const cancelled = harness()
    const cancelledSlug = await seedAwaitingPr(cancelled)
    await cancelled.store.append(cancelledSlug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    const cancel = await cancelled.store.append(cancelledSlug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-cancelled',
      payload: {},
    })
    cancelled.forge.setPrState(1, { state: 'open', mergeable: true })
    cancelled.forge.setGatePresence(1, 'absent')
    await cancelled.store.claimLease(cancelledSlug, 'runner-live', 60_000)
    await cancelled.dispatcher.tick()
    expect(cancelled.forge.squashMergeCalls).toEqual([])
    const applied = (await cancelled.store.getEvents(cancelledSlug)).at(-1)
    expect(applied?.type).toBe('pr.auto-merge-disabled')
    expect(applied?.payload).toEqual({ commandSeq: cancel.seq })
  })

  test('a cancellation landing after classification is caught by the last-moment event reload', async () => {
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

    await expect(h.dispatcher.tick()).rejects.toThrow('head changed')
    expect(h.forge.squashMergeCalls).toEqual([])
    expect((await h.store.getEvents(slug)).some((e) => e.type === 'pr.merged')).toBe(
      false,
    )
  })

  test('BLOCKED/probe failures surface; HAS_HOOKS delegates to native and never falls back', async () => {
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
    await expect(blocked.dispatcher.tick()).rejects.toThrow('BLOCKED')
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
    await expect(probe.dispatcher.tick()).rejects.toThrow('ruleset probe forbidden')
    expect(probe.forge.squashMergeCalls).toEqual([])

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

  test('fallback waits for finalize post-steps before landing', async () => {
    const h = harness({ toml: '[finalize]\nsteps = ["release-notes"]\n' })
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

  test('fallback waits for the full post-reconcile verify cycle', async () => {
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
    expect(h.forge.squashMergeCalls).toHaveLength(1)
  })

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
    const cancel = await h.store.append(slug, {
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
    expect(events.map((event) => event.type).slice(-2)).toEqual([
      'pr.auto-merge-disabled',
      'pr.conflicted',
    ])
    expect(events.at(-2)?.payload).toEqual({ commandSeq: cancel.seq })
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
    const cancel = await h.store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-cancelled',
      payload: {},
    })
    await h.store.claimLease(slug, 'runner-live', 60_000)

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.forge.isAutoMergeEnabled(1)).toBe(false)
    const events = await h.store.getEvents(slug)
    expect(events.at(-1)?.type).toBe('pr.auto-merge-disabled')
    expect(events.at(-1)?.payload).toEqual({ commandSeq: cancel.seq })
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
    expect(h.forge.autoMergeCalls).toEqual([])
    expect(h.forge.squashMergeCalls).toEqual([])
  })

  test('conflicted PR: pr.conflicted{baseSha} + runner re-attach, deduped while pending', async () => {
    const h = harness({ tickets: [readyTicket('T-1', { labels: [] })] })
    const slug = await seedBuild(h, { ticketId: 'T-1', pr: PR })
    h.forge.setPrState(1, { state: 'open', mergeable: false })

    const report = await h.dispatcher.tick()
    expect(report).toEqual({ ...emptyTickReport(), conflicted: 1 })

    // baseSha comes from `git ls-remote <repo> refs/heads/<base>` (§15.7).
    expect(h.execCalls).toEqual([['git', 'ls-remote', REPO, 'refs/heads/main']])
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
    expect(await h.store.getEvents(slug)).toHaveLength(before)
    expect(h.launches).toEqual([])
  })

  test('aborted build: release + completed{abandoned} + back to Triage; second tick no-ops', async () => {
    const h = harness({ tickets: [readyTicket('T-1', { labels: [] })] })
    const slug = await seedBuild(h, { ticketId: 'T-1' })
    await h.store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })

    const report = await h.dispatcher.tick()
    expect(report).toEqual({ ...emptyTickReport(), abandoned: 1 })

    const events = await h.store.getEvents(slug)
    expect(events.map((e) => e.type).slice(-2)).toEqual([
      'workspace.released',
      'build.completed',
    ])
    expect(events.at(-1)?.payload).toEqual({ outcome: 'abandoned' })
    expect(h.workspaces.releases.map((r) => r.ref)).toEqual([`/ws/ab/${slug}`])
    // Aborted work goes back to a human (D1 discipline), never to Done.
    expect(h.tickets.transitions).toEqual([{ id: 'T-1', state: 'Triage' }])
    expect(h.tickets.comments).toEqual([
      { id: 'T-1', body: expect.stringContaining('aborted') },
    ])

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(await h.store.getEvents(slug)).toHaveLength(events.length)
  })

  test('aborted build: a ticket-source outage leaves the Triage handback retryable (§3.3)', async () => {
    // Regression: build.completed used to land BEFORE the ticket transition,
    // so a crash/outage between the two reduced to status 'done' and the
    // janitor skipped the build forever — the aborted ticket silently never
    // returned to Triage (D1). Ticket ops must precede the terminal event,
    // exactly as the merged/closed paths order them.
    const h = harness({ tickets: [readyTicket('T-1', { labels: [] })] })
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

    await expect(h.dispatcher.tick()).rejects.toThrow('ticket source outage')
    // The terminal event did NOT land: the build still reduces to 'aborted',
    // so the next tick re-runs the whole cleanup (workspace release is
    // log-deduped) instead of stranding the ticket.
    const types = (await h.store.getEvents(slug)).map((e) => e.type)
    expect(types).not.toContain('build.completed')
    expect(h.tickets.transitions).toEqual([])

    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), abandoned: 1 })
    expect(h.tickets.transitions).toEqual([{ id: 'T-1', state: 'Triage' }])
    expect(h.tickets.comments).toEqual([
      { id: 'T-1', body: expect.stringContaining('aborted') },
    ])
    const events = await h.store.getEvents(slug)
    expect(events.at(-1)?.type).toBe('build.completed')
    expect(events.at(-1)?.payload).toEqual({ outcome: 'abandoned' })
    expect(h.workspaces.releases).toHaveLength(1) // released once, tick 1
  })
})

// ── Dispatch-command startup resume (§2.2, §15.6-C) ─────────────────────────

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
    expect(await h.dispatcher.tick({ resumeCurrent: true })).toEqual(
      emptyTickReport(),
    )
    // A later stale-lease poll asks again, but the launcher still knows the
    // process-local run is live. Neither no-op is observable as resumed/swept.
    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.launches).toEqual([slug, slug])
  })

  test('re-arms a policy-exhausted phase and records an auditable retry answer', async () => {
    const h = harness()
    const slug = await seedBuild(h)
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'phase.failed',
      payload: { phase: 'plan', round: 1, attempt: 2, error: 'no-terminal', willRetry: false },
    })
    await h.store.append(slug, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: 'esc_policy',
        phase: 'plan',
        round: 1,
        source: 'policy',
        question: 'plan failed twice',
      },
    })

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(h.launches).toEqual([])

    expect(await h.dispatcher.tick({ resumeCurrent: true })).toEqual({
      ...emptyTickReport(),
      resumed: 1,
    })
    expect(h.launches).toEqual([slug])
    const answer = (await h.store.getEvents(slug)).at(-1)
    expect(answer?.type).toBe('escalation.answered')
    expect(answer?.actor).toEqual({ kind: 'dispatcher' })
    expect(answer?.payload).toEqual({
      id: 'esc_policy',
      answer: 'ab dispatch restarted this build from durable state',
      resolution: 'retry',
    })
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
    expect(await blocked.dispatcher.tick({ resumeCurrent: true })).toEqual(emptyTickReport())
    expect(blocked.launches).toEqual([])
    expect((await blocked.store.getEvents('blocked')).at(-1)?.type).toBe(
      'escalation.raised',
    )
  })
})

// ── Lease sweep (§15.6-C) ────────────────────────────────────────────────────

describe('Dispatcher lease sweep', () => {
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
    const h = harness({ toml: '[finalize]\nsteps = ["release-notes"]\n' })
    const slug = await seedBuild(h)
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
  test('another repo\'s builds are invisible: not janitored, not swept, not counted against capacity', async () => {
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
          async (b) => (await h.store.getEvents(b.slug)).length,
        ),
      )
    const before = await eventCounts()

    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())
    expect(await h.dispatcher.tick()).toEqual(emptyTickReport())

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

  test('the state gate is always emitted for both sources', () => {
    expect(criteria(`${LINEAR}readyState = "Todo"\n`)).toEqual({
      labels: ['autobuild'],
      state: 'Todo',
    })
    expect(criteria(`${FILE}readyState = "Todo"\n`)).toEqual({
      labels: [],
      state: 'Todo',
    })
  })

  test('an explicit readyLabels wins for either source — config is never ignored', () => {
    expect(
      criteria(`${FILE}readyLabels = ["urgent"]\nreadyState = "Ready"\n`),
    ).toEqual({ labels: ['urgent'], state: 'Ready' })
    expect(
      criteria(`${LINEAR}readyLabels = ["urgent"]\nreadyState = "Ready"\n`),
    ).toEqual({ labels: ['urgent'], state: 'Ready' })
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
