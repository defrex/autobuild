/**
 * The bulk of these tests exercise the PURE layer — (record, events, now) in,
 * plain data out — with no store, no clock, and no filesystem. That is the
 * whole point of the split in status.ts: the projection is testable without
 * IO, and the renderers are testable without a terminal.
 *
 * `seedStore()` from testkit is one build with `repo: 'acme/app'` (a repo
 * SLUG), while production `record.repo` is an ABSOLUTE PATH (the dispatcher's
 * targetRepo). These fixtures are hand-built with absolute paths instead — a
 * repo-filter test on a slug would pass while exercising a comparison that
 * never occurs in production.
 */
import { describe, expect, test } from 'bun:test'
import { DISPATCHER, KERNEL, agentActor, humanActor } from '../events/envelope'
import { BUILD_STATUSES } from '../ontology'
import type { Exec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import type { BuildRecord, BuildStore } from '../store/types'
import { steppingClock } from '../testing/fixed'
import {
  abBuildStatus,
  abBuilds,
  currentRepo,
  detail,
  leaseHealth,
  renderDetail,
  renderSummaries,
  statusFilter,
  summarize,
} from './status'

const NOW = new Date('2026-07-15T12:00:00.000Z')
const REPO = '/Users/dev/code/acme-app'
const OTHER_REPO = '/Users/dev/code/other-app'

function record(overrides: Partial<BuildRecord> = {}): BuildRecord {
  return {
    slug: 'auth-rate-limit',
    repo: REPO,
    createdAt: '2026-07-15T11:00:00.000Z',
    updatedAt: '2026-07-15T11:59:00.000Z',
    ...overrides,
  }
}

const fakeExec: Exec = async () => ({ stdout: `${REPO}/.git\n`, stderr: '', exitCode: 0 })

/** A store seeded with one build per spec; each gets its own event log. */
async function seedBuild(
  store: MemoryBuildStore,
  opts: { slug: string; repo?: string; status?: 'queued' | 'running' | 'blocked' | 'paused' | 'done' },
): Promise<void> {
  await store.createBuild({
    slug: opts.slug,
    repo: opts.repo ?? REPO,
    ticket: { source: 'linear', id: 'ENG-1', title: 'A ticket' },
  })
  const status = opts.status ?? 'running'
  if (status === 'queued') return
  await store.append(opts.slug, {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'i1', host: 'h1', resumedFromSeq: 0 },
  })
  if (status === 'blocked') {
    await store.append(opts.slug, {
      actor: agentActor('implement', 's_1'),
      type: 'escalation.raised',
      payload: {
        id: 'esc_1',
        phase: 'implement',
        round: 1,
        source: 'agent',
        question: 'Which auth store?',
      },
    })
  }
  if (status === 'paused') {
    // The human emits build.pause-requested; build.paused is the kernel's
    // acknowledging fact event (D2), and that fact is what reduces to 'paused'.
    await store.append(opts.slug, {
      actor: humanActor('dev'),
      type: 'build.pause-requested',
      payload: {},
    })
    await store.append(opts.slug, {
      actor: KERNEL,
      type: 'build.paused',
      payload: {},
    })
  }
  if (status === 'done') {
    // build.completed is dispatcher-authored (see allowedActorKinds).
    await store.append(opts.slug, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
  }
}

describe('leaseHealth', () => {
  test('held when the lease has not expired', () => {
    const r = record({ lease: { holder: 'runner-1', expiresAt: '2026-07-15T12:01:00.000Z' } })
    expect(leaseHealth(r, NOW)).toBe('held')
  })

  test('expired once it has run out', () => {
    const r = record({ lease: { holder: 'runner-1', expiresAt: '2026-07-15T11:59:00.000Z' } })
    expect(leaseHealth(r, NOW)).toBe('expired')
  })

  test('none when there is no lease at all', () => {
    expect(leaseHealth(record(), NOW)).toBe('none')
  })

  // The boundary the dispatcher's sweep uses: `expiresAt > now` is healthy, so
  // expiresAt === now is expired in both places. If these ever disagree, the
  // sweep re-attaches a build this command still calls healthy.
  test('expiresAt exactly === now is expired, matching leaseSweep', () => {
    const r = record({ lease: { holder: 'runner-1', expiresAt: NOW.toISOString() } })
    expect(leaseHealth(r, NOW)).toBe('expired')
  })
})

describe('summarize', () => {
  test('queued build with no events', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1', status: 'queued' })
    const r = (await store.getBuild('b1'))!
    const summary = summarize(r, await store.getEvents('b1'), NOW)
    expect(summary.status).toBe('queued')
    expect(summary.slug).toBe('b1')
  })

  test('each status maps through from the seeded log', async () => {
    for (const status of ['running', 'blocked', 'paused', 'done'] as const) {
      const store = new MemoryBuildStore({ clock: steppingClock() })
      await seedBuild(store, { slug: 'b1', status })
      const r = (await store.getBuild('b1'))!
      expect(summarize(r, await store.getEvents('b1'), NOW).status).toBe(status)
    }
  })

  test('surfaces the in-flight loop round and the verify attempt', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1' })
    await store.append('b1', {
      actor: KERNEL,
      type: 'implement.started',
      payload: { round: 2 },
    })
    const r = (await store.getBuild('b1'))!
    const loop = summarize(r, await store.getEvents('b1'), NOW)
    expect(loop.phase).toBe('implement')
    expect(loop.round).toBe(2)
    expect(loop.attempt).toBeUndefined()

    await store.append('b1', {
      actor: KERNEL,
      type: 'verify.started',
      payload: { step: 'e2e', attempt: 3 },
    })
    const verify = summarize(r, await store.getEvents('b1'), NOW)
    expect(verify.phase).toBe('verify:e2e')
    expect(verify.attempt).toBe(3)
  })

  test('ticket fields present when the record carries them, absent when not', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.createBuild({ slug: 'b1', repo: REPO })
    const r = (await store.getBuild('b1'))!
    expect(summarize(r, [], NOW).ticket).toBeUndefined()

    const withTicket = record({
      ticket: { source: 'linear', id: 'ENG-42', title: 'Auth', url: 'https://x/ENG-42' },
    })
    expect(summarize(withTicket, [], NOW).ticket?.id).toBe('ENG-42')
  })

  test('PR surfaces with its lifecycle state once finalize records it', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1' })
    expect(summarize((await store.getBuild('b1'))!, await store.getEvents('b1'), NOW).pr).toBeUndefined()

    await store.append('b1', {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: {
        pr: { number: 7, url: 'https://github.com/acme/app/pull/7', headSha: 'abc123' },
      },
    })
    const summary = summarize((await store.getBuild('b1'))!, await store.getEvents('b1'), NOW)
    expect(summary.pr).toEqual({
      number: 7,
      url: 'https://github.com/acme/app/pull/7',
      state: 'open',
    })
  })

  test('lease info rides along with the summary', async () => {
    const r = record({
      lease: { holder: 'runner-1', expiresAt: '2026-07-15T12:05:00.000Z' },
      heartbeatAt: '2026-07-15T11:59:30.000Z',
    })
    const summary = summarize(r, [], NOW)
    expect(summary.lease).toEqual({
      health: 'held',
      holder: 'runner-1',
      expiresAt: '2026-07-15T12:05:00.000Z',
      heartbeatAt: '2026-07-15T11:59:30.000Z',
    })
  })
})

describe('detail', () => {
  // §15.6-A: a re-run after a failed verify restarts from the first step at
  // attempt+1, so attempt 1's pass must NOT read as current progress.
  test('verify progress covers the current attempt only', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1' })
    await store.append('b1', {
      actor: KERNEL,
      type: 'verify.completed',
      payload: { step: 'unit', attempt: 1, pass: true },
    })
    await store.append('b1', {
      actor: KERNEL,
      type: 'verify.completed',
      payload: { step: 'e2e', attempt: 1, pass: false },
    })
    await store.append('b1', {
      actor: KERNEL,
      type: 'verify.started',
      payload: { step: 'unit', attempt: 2 },
    })
    const inFlight = detail((await store.getBuild('b1'))!, await store.getEvents('b1'), NOW)
    expect(inFlight.verify.attempt).toBe(2)
    // Attempt 1's pass must NOT read as current progress — the cycle restarted.
    expect(inFlight.verify.steps).toEqual([])
    expect(inFlight.verify.currentStep).toBe('unit')

    // The positive half: once attempt 2 completes a step, THAT one surfaces —
    // without this, an implementation returning a constant [] would pass.
    await store.append('b1', {
      actor: KERNEL,
      type: 'verify.completed',
      payload: { step: 'unit', attempt: 2, pass: true },
    })
    const d = detail((await store.getBuild('b1'))!, await store.getEvents('b1'), NOW)
    expect(d.verify.steps).toEqual([{ step: 'unit', pass: true }])
    expect(d.verify.currentStep).toBeUndefined()
  })

  test('a failed step in the current attempt surfaces as a failure', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1' })
    await store.append('b1', {
      actor: KERNEL,
      type: 'verify.completed',
      payload: { step: 'e2e', attempt: 1, pass: false },
    })
    const d = detail((await store.getBuild('b1'))!, await store.getEvents('b1'), NOW)
    expect(d.verify.steps).toEqual([{ step: 'e2e', pass: false }])
    // Rendered in words, since color is not available to lean on.
    expect(renderDetail(d, NOW).join('\n')).toContain('FAIL  e2e')
  })

  test('open escalations, open sessions, and lastEvent', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1', status: 'blocked' })
    await store.append('b1', {
      actor: KERNEL,
      type: 'session.started',
      payload: { session: 's_1', role: 'implement', runner: 'claude', phase: 'implement', round: 1 },
    })
    const d = detail((await store.getBuild('b1'))!, await store.getEvents('b1'), NOW)
    expect(d.openEscalations).toHaveLength(1)
    expect(d.openEscalations[0]!.question).toBe('Which auth store?')
    expect(d.openSessions).toHaveLength(1)
    expect(d.openSessions[0]!.session).toBe('s_1')
    expect(d.lastEvent?.type).toBe('session.started')
    expect(d.lastEvent?.actor.kind).toBe('kernel')
  })

  test('outcome present once the build is done', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1', status: 'done' })
    const d = detail((await store.getBuild('b1'))!, await store.getEvents('b1'), NOW)
    expect(d.outcome).toBe('merged')
  })

  test('no events key unless eventCount is asked for', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1' })
    const d = detail((await store.getBuild('b1'))!, await store.getEvents('b1'), NOW)
    expect(d.events).toBeUndefined()
  })

  test('eventCount takes the newest n, in chronological order', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1' })
    for (const round of [1, 2, 3]) {
      await store.append('b1', { actor: KERNEL, type: 'plan.started', payload: { round } })
    }
    const events = await store.getEvents('b1')
    const d = detail((await store.getBuild('b1'))!, events, NOW, 2)
    expect(d.events).toHaveLength(2)
    const seqs = d.events!.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(seqs).toEqual(events.slice(-2).map((e) => e.seq))
  })

  test('eventCount larger than the log returns the whole log', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1' })
    const events = await store.getEvents('b1')
    const d = detail((await store.getBuild('b1'))!, events, NOW, 999)
    expect(d.events).toHaveLength(events.length)
  })
})

describe('renderers', () => {
  // The AC asks for distinguishability without color, so it is asserted on the
  // TEXT: a running build with a dead runner must say so in words.
  test('a running build with an expired lease renders the lease word, not a color', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1' })
    const r = record({
      slug: 'b1',
      lease: { holder: 'runner-1', expiresAt: '2026-07-15T11:00:00.000Z' },
    })
    const summary = summarize(r, await store.getEvents('b1'), NOW)
    expect(summary.status).toBe('running')

    const text = renderSummaries([summary], NOW, 'none').join('\n')
    expect(text).toContain('running')
    expect(text).toContain('expired')
    expect(text).not.toContain('\x1b')

    const detailText = renderDetail(
      detail(r, await store.getEvents('b1'), NOW),
      NOW,
    ).join('\n')
    expect(detailText).toContain('expired')
    expect(detailText).not.toContain('\x1b')
  })

  test('a healthy running build reads differently from an expired one', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1' })
    const events = await store.getEvents('b1')
    const held = summarize(
      record({ slug: 'b1', lease: { holder: 'r', expiresAt: '2026-07-15T12:30:00.000Z' } }),
      events,
      NOW,
    )
    expect(renderSummaries([held], NOW, 'none').join('\n')).toContain('held')
  })

  // The AC enumerates what a summary identifies: ticket id AND title, PR state
  // AND link. The JSON carries them either way; these pin the HUMAN render,
  // which is what an operator running `ab builds` actually sees.
  test('a summary row carries the ticket id and title, and the PR state and link', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1' })
    await store.append('b1', {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: {
        pr: { number: 7, url: 'https://github.com/acme/app/pull/7', headSha: 'abc' },
      },
    })
    const r = record({
      slug: 'b1',
      ticket: { source: 'linear', id: 'ENG-42', title: 'Auth rate limiting' },
    })
    const text = renderSummaries(
      [summarize(r, await store.getEvents('b1'), NOW)],
      NOW,
      'none',
    ).join('\n')
    expect(text).toContain('ENG-42')
    expect(text).toContain('Auth rate limiting')
    expect(text).toContain('#7 open')
    expect(text).toContain('https://github.com/acme/app/pull/7')
  })

  test('a long ticket title is truncated rather than blowing out the row', () => {
    const r = record({
      ticket: { source: 'linear', id: 'ENG-1', title: 'x'.repeat(120) },
    })
    const text = renderSummaries([summarize(r, [], NOW)], NOW, 'none').join('\n')
    expect(text).toContain('…')
    expect(text).not.toContain('x'.repeat(60))
  })

  test('a build with no ticket and no PR renders placeholders, not undefined', () => {
    const text = renderSummaries([summarize(record(), [], NOW)], NOW, 'none').join('\n')
    expect(text).not.toContain('undefined')
    expect(text).toContain('—')
  })

  test('a missing lease renders as no-lease, a distinct word from expired', () => {
    const summary = summarize(record(), [], NOW)
    const text = renderSummaries([summary], NOW, 'none').join('\n')
    expect(text).toContain('no-lease')
    expect(text).not.toContain('expired')
  })

  test('an empty list names the filter in effect rather than printing nothing', () => {
    expect(renderSummaries([], NOW, 'no active builds for /x — try --queued or --all')).toEqual([
      'no active builds for /x — try --queued or --all',
    ])
  })

  test('detail omits sections that have no data', () => {
    const text = renderDetail(detail(record(), [], NOW), NOW).join('\n')
    expect(text).not.toContain('escalations')
    expect(text).not.toContain('open sessions')
    expect(text).not.toContain('pr:')
    expect(text).not.toContain('verify:')
  })
})

describe('statusFilter', () => {
  test('defaults to the actionable statuses', () => {
    expect(statusFilter()).toEqual(['running', 'paused', 'blocked'])
  })

  test('--queued adds queued', () => {
    expect(statusFilter(false, true)).toEqual(['running', 'paused', 'blocked', 'queued'])
  })

  test('--all is every status and subsumes --queued', () => {
    // Pinned against the ontology's own list, so a new BuildStatus that --all
    // forgets to include fails here rather than silently going unreportable.
    expect([...statusFilter(true, false)].sort()).toEqual([...BUILD_STATUSES].sort())
    expect(statusFilter(true, true)).toEqual(statusFilter(true, false))
  })
})

describe('currentRepo', () => {
  // Agents run inside linked worktrees; --git-common-dir is what resolves back
  // to the main repo there, and its dirname is the repo root.
  test('resolves the main repo root from --git-common-dir', async () => {
    const exec: Exec = async (cmd) => {
      expect(cmd).toContain('--git-common-dir')
      return { stdout: '/Users/dev/code/acme-app/.git\n', stderr: '', exitCode: 0 }
    }
    expect(await currentRepo('/anywhere', exec)).toBe('/Users/dev/code/acme-app')
  })

  test('falls back to the cwd when git fails (not a repo)', async () => {
    const exec: Exec = async () => ({ stdout: '', stderr: 'fatal', exitCode: 128 })
    expect(await currentRepo('/tmp/plain-dir', exec)).toBe('/tmp/plain-dir')
  })

  test('falls back to the cwd when exec throws', async () => {
    const exec: Exec = async () => {
      throw new Error('no git binary')
    }
    expect(await currentRepo('/tmp/plain-dir', exec)).toBe('/tmp/plain-dir')
  })
})

describe('abBuilds', () => {
  async function run(
    store: MemoryBuildStore,
    opts: { queued?: boolean; all?: boolean; json?: boolean } = {},
  ): Promise<string[]> {
    const out: string[] = []
    await abBuilds({
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: (line) => out.push(line),
      openStore: () => store,
      now: () => NOW,
      ...opts,
    })
    return out
  }

  test('lists only the current repo\'s builds', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'mine', repo: REPO })
    await seedBuild(store, { slug: 'theirs', repo: OTHER_REPO })
    const text = (await run(store)).join('\n')
    expect(text).toContain('mine')
    expect(text).not.toContain('theirs')
  })

  test('default selection is running/paused/blocked', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'is-running', status: 'running' })
    await seedBuild(store, { slug: 'is-blocked', status: 'blocked' })
    await seedBuild(store, { slug: 'is-paused', status: 'paused' })
    await seedBuild(store, { slug: 'is-queued', status: 'queued' })
    await seedBuild(store, { slug: 'is-done', status: 'done' })
    const text = (await run(store)).join('\n')
    expect(text).toContain('is-running')
    expect(text).toContain('is-blocked')
    expect(text).toContain('is-paused')
    expect(text).not.toContain('is-queued')
    expect(text).not.toContain('is-done')
  })

  test('--queued adds queued builds but not terminal ones', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'is-running', status: 'running' })
    await seedBuild(store, { slug: 'is-queued', status: 'queued' })
    await seedBuild(store, { slug: 'is-done', status: 'done' })
    const text = (await run(store, { queued: true })).join('\n')
    expect(text).toContain('is-queued')
    expect(text).toContain('is-running')
    expect(text).not.toContain('is-done')
  })

  test('--all includes every status', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'is-running', status: 'running' })
    await seedBuild(store, { slug: 'is-queued', status: 'queued' })
    await seedBuild(store, { slug: 'is-done', status: 'done' })
    const text = (await run(store, { all: true })).join('\n')
    expect(text).toContain('is-running')
    expect(text).toContain('is-queued')
    expect(text).toContain('is-done')
  })

  test('an empty result names the filter, and --all says so honestly', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'is-done', status: 'done' })
    const text = (await run(store)).join('\n')
    expect(text).toContain('no active builds')
    expect(text).toContain('--queued or --all')
  })

  // The hint must suggest only flags that would actually widen what was asked
  // for — "try --queued" to someone who passed --queued reads as a bug.
  test('the empty hint under --queued suggests --all, not --queued again', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'is-done', status: 'done' })
    const text = (await run(store, { queued: true })).join('\n')
    expect(text).toContain('no active or queued builds')
    expect(text).toContain('--all')
    expect(text).not.toContain('--queued')
  })

  test('the empty hint under --all suggests nothing — there is nothing wider', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const text = (await run(store, { all: true })).join('\n')
    expect(text).toContain('no builds for')
    expect(text).not.toContain('try')
  })

  test('--json parses, matches the projection, and carries no ANSI', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1' })
    const raw = (await run(store, { json: true })).join('\n')
    expect(raw).not.toContain('\x1b')
    const parsed = JSON.parse(raw)
    const expected = summarize((await store.getBuild('b1'))!, await store.getEvents('b1'), NOW)
    expect(parsed).toEqual([JSON.parse(JSON.stringify(expected))])
  })
})

describe('abBuildStatus', () => {
  test('reports one build in detail', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1' })
    const out: string[] = []
    await abBuildStatus({
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: (line) => out.push(line),
      openStore: () => store,
      now: () => NOW,
      slug: 'b1',
    })
    expect(out.join('\n')).toContain('build b1')
  })

  test('an unknown slug is an actionable error', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const promise = abBuildStatus({
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: () => {},
      openStore: () => store,
      now: () => NOW,
      slug: 'nope',
    })
    await expect(promise).rejects.toThrow(/no build "nope"/)
    await expect(promise).rejects.toThrow(/ab builds --all/)
  })

  test('--json parses and matches the projection', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1' })
    const out: string[] = []
    await abBuildStatus({
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: (line) => out.push(line),
      openStore: () => store,
      now: () => NOW,
      slug: 'b1',
      json: true,
      events: 1,
    })
    const raw = out.join('\n')
    expect(raw).not.toContain('\x1b')
    const parsed = JSON.parse(raw)
    expect(parsed.slug).toBe('b1')
    expect(parsed.events).toHaveLength(1)
  })
})

describe('store selection', () => {
  test('--store wins over AB_STORE, which wins over the default', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const seen: string[] = []
    const opts = {
      targetRepo: '/anywhere',
      exec: fakeExec,
      stdout: () => {},
      openStore: (ref: string) => {
        seen.push(ref)
        return store
      },
      now: () => NOW,
    }
    await abBuilds({ ...opts, env: {}, storeRef: '/explicit' })
    await abBuilds({ ...opts, env: { AB_STORE: '/from-env' } })
    await abBuilds({ ...opts, env: { AB_STORE: '/from-env' }, storeRef: '/explicit' })
    await abBuilds({ ...opts, env: {} })
    expect(seen[0]).toBe('/explicit')
    expect(seen[1]).toBe('/from-env')
    expect(seen[2]).toBe('/explicit')
    expect(seen[3]).toContain('autobuild') // DEFAULT_LOCAL_ROOT
  })

  test('AB_TOKEN is passed through for remote refs', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    let token: string | undefined
    await abBuilds({
      targetRepo: '/anywhere',
      env: { AB_STORE: 'https://store.example', AB_TOKEN: 'tok_1' },
      exec: fakeExec,
      stdout: () => {},
      openStore: (_ref, tok) => {
        token = tok
        return store
      },
      now: () => NOW,
    })
    expect(token).toBe('tok_1')
  })
})

describe('read-only guarantee', () => {
  /** Every mutating method throws — the AC is its own test, not an inspection. */
  function readOnlyProxy(store: MemoryBuildStore): BuildStore {
    const forbidden = [
      'append',
      'appendWithArtifacts',
      'putArtifact',
      'claimLease',
      'heartbeat',
      'releaseLease',
      'createBuild',
    ]
    return new Proxy(store, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && forbidden.includes(prop)) {
          return () => {
            throw new Error(`read-only violation: store.${prop} was called`)
          }
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    }) as unknown as BuildStore
  }

  test('neither command mutates the store', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1' })
    const before = (await store.getEvents('b1')).length
    const guarded = readOnlyProxy(store)

    await abBuilds({
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: () => {},
      openStore: () => guarded,
      now: () => NOW,
      all: true,
    })
    await abBuildStatus({
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: () => {},
      openStore: () => guarded,
      now: () => NOW,
      slug: 'b1',
      events: 5,
    })

    expect((await store.getEvents('b1')).length).toBe(before)
    const after = await store.getBuild('b1')
    expect(after?.lease).toBeUndefined()
  })
})

describe('store lifecycle', () => {
  test('the store is closed even when the build is unknown', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    let closed = false
    const tracked = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'close') {
          return async () => {
            closed = true
          }
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    }) as unknown as BuildStore

    await expect(
      abBuildStatus({
        targetRepo: '/anywhere',
        env: {},
        exec: fakeExec,
        stdout: () => {},
        openStore: () => tracked,
        now: () => NOW,
        slug: 'missing',
      }),
    ).rejects.toThrow()
    expect(closed).toBe(true)
  })
})
