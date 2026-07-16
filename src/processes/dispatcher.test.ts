/**
 * Dispatcher tests (SPEC §3.3, §6.3, §12, §15.7 D1, §15.6-C): memory store +
 * all fakes, sequentialIds + manualClock — deterministic and offline.
 */
import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import { DISPATCHER, KERNEL, agentActor, humanActor } from '../events/envelope'
import { sequentialIds } from '../ids'
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
  emptyTickReport,
  kebab,
  readyCriteria,
  specConformance,
  type DispatcherOpts,
} from './dispatcher'

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
  }
}

function harness(
  opts: {
    tickets?: Ticket[]
    toml?: string
    authorSpec?: (ticket: Ticket) => Promise<string | null>
    opts?: DispatcherOpts
  } = {},
) {
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  const tickets = new FakeTicketSource(opts.tickets ?? [])
  const workspaces = new FakeWorkspaceProvider({ root: '/ws' })
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
    config: parseConfig(opts.toml ?? ''),
    repo: REPO,
    exec,
    launchRunner: async (slug) => {
      launches.push(slug)
    },
    ...(opts.authorSpec ? { authorSpec: opts.authorSpec } : {}),
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
      payload: { provider: 'fake', ref: `/ws/ab/${slug}`, branch: `ab/${slug}` },
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
})

describe('kebab', () => {
  test('lowercases, strips punctuation, collapses separators', () => {
    expect(kebab('Add rate limiting!')).toBe('add-rate-limiting')
    expect(kebab('  Fix: OAuth2 / SSO  ')).toBe('fix-oauth2-sso')
    expect(kebab('!!!')).toBe('build')
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

  test('readyState narrows the scan: only tickets in that state dispatch', async () => {
    const ready = readyTicket('T-1', { state: 'Ready' })
    const backlog = readyTicket('T-2', { title: 'Backlog idea', state: 'Backlog' })
    const h = harness({
      tickets: [ready, backlog],
      toml: ['[dispatcher]', 'capacity = 2', 'readyState = "Ready"'].join('\n'),
    })

    const report = await h.dispatcher.tick()

    expect(report.dispatched).toBe(1)
    const builds = await h.store.listBuilds()
    expect(builds.map((b) => b.slug)).toEqual(['add-rate-limiting'])
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

  test('authorSpec success: spec.authored with agent actor and session id', async () => {
    const h = harness({
      tickets: [readyTicket('T-1', { body: 'thin but groomed' })],
      authorSpec: async () => CONFORMING_BODY,
    })

    const report = await h.dispatcher.tick()
    expect(report).toEqual({ ...emptyTickReport(), dispatched: 1, authored: 1 })

    const events = await h.store.getEvents('add-rate-limiting')
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
    // The authored body, not the thin ticket body, is the spec (§6.3).
    const spec = await h.store.getArtifact('add-rate-limiting', 'spec')
    expect(spec ? textContent(spec) : null).toBe(CONFORMING_BODY)
    expect(h.launches).toEqual(['add-rate-limiting'])
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

  test('slug collision dedupes with -2 suffix', async () => {
    const h = harness({
      tickets: [readyTicket('T-1'), readyTicket('T-2')],
      toml: '[dispatcher]\ncapacity = 2\n',
    })

    const report = await h.dispatcher.tick()
    expect(report).toEqual({ ...emptyTickReport(), dispatched: 2 })
    const builds = await h.store.listBuilds()
    expect(builds.map((b) => b.slug)).toEqual([
      'add-rate-limiting',
      'add-rate-limiting-2',
    ])
    expect(builds.map((b) => b.branch)).toEqual([
      'ab/add-rate-limiting',
      'ab/add-rate-limiting-2',
    ])
    expect(h.launches).toEqual(['add-rate-limiting', 'add-rate-limiting-2'])
  })
})

// ── Janitor (§15.7, D1) ──────────────────────────────────────────────────────

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

  const LINEAR = '[tickets]\nsource = "linear"\nteamKey = "ENG"\n'

  test('file source + empty [dispatcher]: the ready/ directory is the whole gate', () => {
    // The headline claim: no config, no label — `mv` into ready/ dispatches.
    expect(criteria('')).toEqual({ labels: [], state: 'Ready' })
  })

  test('linear + empty [dispatcher]: the historical "autobuild" label gate is intact', () => {
    // Linear has no ready/ directory, so a label is the only possible gate —
    // dropping this default would silently dispatch a whole Linear backlog.
    expect(criteria(LINEAR)).toEqual({ labels: ['autobuild'] })
  })

  test('linear leaves state absent unless readyState is set — labels alone decide', () => {
    expect(criteria(LINEAR).state).toBeUndefined()
    expect(criteria(`${LINEAR}[dispatcher]\nreadyState = "Ready"\n`)).toEqual({
      labels: ['autobuild'],
      state: 'Ready',
    })
  })

  test('an explicit readyLabels wins for either source — config is never ignored', () => {
    expect(criteria('[dispatcher]\nreadyLabels = ["urgent"]\n')).toEqual({
      labels: ['urgent'],
      state: 'Ready',
    })
    expect(criteria(`${LINEAR}[dispatcher]\nreadyLabels = ["urgent"]\n`)).toEqual({
      labels: ['urgent'],
    })
  })

  test('an explicit empty readyLabels is honored, not treated as unset', () => {
    expect(criteria(`${LINEAR}[dispatcher]\nreadyLabels = []\n`)).toEqual({ labels: [] })
  })

  test('an explicit readyState overrides the file source default of Ready', () => {
    expect(criteria('[dispatcher]\nreadyState = "Triage"\n')).toEqual({
      labels: [],
      state: 'Triage',
    })
  })
})
