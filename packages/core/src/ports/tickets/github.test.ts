import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitHubRequest } from '../forge/github-transport'
import { type TicketDraft, TicketSourceRateLimitError } from '../types'
import { describeTicketSourceContract } from './contract'
import { updateTicket } from './operations'
import { TicketRevisionUnsupported } from './revision'
import { FakeGitHubIssues } from './github-fake'
import { GitHubTicketSource, TicketCreationKeyReservationRequired } from './github'
import {
  FileGitHubValidatorStore,
  type GitHubValidatorStore,
  MemoryGitHubValidatorStore,
} from './github-validators'
import { parseIssueLinkList } from './issue-links'
import type { TicketLifecycle } from './lifecycle'

const LIFECYCLE: TicketLifecycle = {
  triage: 'triage',
  ready: 'ready',
  doing: 'doing',
  done: 'done',
  create: 'triage',
  proposal: 'triage',
}

function setup(
  opts: { lifecycle?: Partial<TicketLifecycle>; readyLabels?: string[]; now?: () => number } = {},
) {
  const github = new FakeGitHubIssues(opts.now ? { now: opts.now } : {})
  const source = new GitHubTicketSource({
    transport: github.transport,
    repository: github.repository,
    lifecycle: { ...LIFECYCLE, ...opts.lifecycle },
    readyLabels: opts.readyLabels ?? [],
    ...(opts.now ? { now: opts.now } : {}),
  })
  return { github, source }
}

describeTicketSourceContract('github', async () => {
  const { source } = setup()
  return {
    source,
    states: { ready: 'ready', claimed: 'doing', completed: 'done' },
    editableLabel: 'contract-editable',
    intrinsicIssueLinks: (ticket) => [{ issue: Number(ticket.ref.id), intent: 'closes' }],
  }
})

const CLOCK_START = Date.parse('2026-11-06T12:00:00Z')

function clocked(opts: Parameters<typeof setup>[0] = {}) {
  let now = CLOCK_START
  const clock = {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
  return { clock, ...setup({ ...opts, now: clock.now }) }
}

async function created(
  source: GitHubTicketSource,
  state: string,
  draft: Partial<TicketDraft> = {},
): Promise<string> {
  return (await source.create({ title: `In ${state}`, body: 'Body.', ...draft }, { state })).ref.id
}

describe('github states', () => {
  test('pull requests are never tickets', async () => {
    const { github, source } = setup()
    const pr = github.openPullRequest()
    const ready = await created(source, 'ready')
    expect(await source.get(String(pr))).toBeNull()
    expect((await source.listAll()).tickets.map((t) => t.ref.id)).toEqual([ready])
    expect(await source.dependencyStates([String(pr)])).toEqual([
      { id: String(pr), exists: false, resolved: false, blockedBy: [] },
    ])
  })

  test('an issue filed with no label is in triage', async () => {
    const { github, source } = setup()
    const filed = github.fileIssue({ title: 'From the UI', labels: ['bug'] })
    expect(await source.get(String(filed))).toMatchObject({ state: 'triage', labels: ['bug'] })
    expect((await source.listReady({ state: 'triage' })).tickets.map((t) => t.ref.id)).toEqual([
      String(filed),
    ])
  })

  test('two state labels exclude only that issue, with a diagnostic', async () => {
    const { github, source } = setup()
    const bad = github.fileIssue({ labels: ['autobuild:ready', 'autobuild:doing'] })
    const good = await created(source, 'ready')
    const listing = await source.listReady({ state: 'ready' })
    expect(listing.tickets.map((t) => t.ref.id)).toEqual([good])
    expect(listing.diagnostics).toEqual([
      `github #${bad}: has 2 state labels (autobuild:ready, autobuild:doing); a ticket holds one state — remove all but one`,
    ])
    const read = await source.get(String(bad))
    expect(read?.state).toBeUndefined()
    expect(await source.claim(String(bad))).toBe(false)
  })

  for (const lifecycle of [{}, { rejected: 'rejected' }] as const) {
    const rejected = 'rejected' in lifecycle ? 'rejected' : 'not-planned'
    test(`closing reasons map to done and ${rejected}`, async () => {
      const { github, source } = setup({ lifecycle })
      const completed = github.fileIssue({ state: 'closed', state_reason: 'completed' })
      const notPlanned = github.fileIssue({ state: 'closed', state_reason: 'not_planned' })
      const duplicate = github.fileIssue({ state: 'closed', state_reason: 'duplicate' })
      const states = await source.dependencyStates([completed, notPlanned, duplicate].map(String))
      expect(states.map(({ state, resolved }) => ({ state, resolved }))).toEqual([
        { state: 'done', resolved: true },
        { state: rejected, resolved: false },
        { state: rejected, resolved: false },
      ])
      expect(
        (await source.listReady({ state: rejected })).tickets.map((t) => Number(t.ref.id)),
      ).toEqual([duplicate, notPlanned])
    })
  }

  test('not-planned cannot be moved into; a configured rejected role closes as not planned', async () => {
    const plain = setup()
    const id = await created(plain.source, 'ready')
    await expect(plain.source.transition(id, 'not-planned')).rejects.toThrow('cannot be moved into')
    expect(plain.github.issue(Number(id))?.state).toBe('open')
    const roles = setup({ lifecycle: { rejected: 'rejected', backlog: 'backlog' } })
    const other = await created(roles.source, 'ready')
    await roles.source.transition(other, 'rejected')
    expect(roles.github.issue(Number(other))).toMatchObject({
      state: 'closed',
      state_reason: 'not_planned',
      labels: [],
    })
    await roles.source.transition(other, 'backlog')
    expect(roles.github.issue(Number(other))).toMatchObject({
      state: 'open',
      labels: ['autobuild:backlog'],
    })
    expect((await roles.source.get(other))?.state).toBe('backlog')
  })

  test('a closed issue changes its completion reason in both directions', async () => {
    const { github, source } = setup({ lifecycle: { rejected: 'rejected' } })
    const duplicate = github.fileIssue({ state: 'closed', state_reason: 'duplicate' })
    const sameReason = github.fileIssue({ state: 'closed', state_reason: 'not_planned' })
    await source.transition(String(duplicate), 'done')
    expect(github.issue(duplicate)).toMatchObject({ state: 'closed', state_reason: 'completed' })
    expect(await source.get(String(duplicate))).toMatchObject({ state: 'done', resolved: true })
    await source.transition(String(duplicate), 'rejected')
    expect(github.issue(duplicate)).toMatchObject({ state: 'closed', state_reason: 'not_planned' })
    expect(await source.get(String(duplicate))).toMatchObject({
      state: 'rejected',
      resolved: false,
    })
    github.resetRequests()
    await source.transition(String(sameReason), 'rejected')
    expect(github.issue(sameReason)).toMatchObject({ state: 'closed', state_reason: 'not_planned' })
    expect(github.issue(sameReason)?.history.map((entry) => entry.state)).toEqual([
      'open',
      'closed',
    ])
    expect(github.writes()).toHaveLength(1)
  })

  test('closing strips state labels, so a UI reopen comes back in triage', async () => {
    const { github, source } = setup()
    const id = await created(source, 'ready', { labels: ['bug'] })
    await source.transition(id, 'done')
    expect(github.issue(Number(id))?.labels).toEqual(['bug'])
    github.uiReopen(Number(id))
    expect((await source.get(id))?.state).toBe('triage')
  })

  test('a UI close keeping its label, then reopen, reads as triage and is healed once', async () => {
    const { github, source } = setup()
    const id = await created(source, 'ready')
    github.uiClose(Number(id))
    github.uiReopen(Number(id))
    expect(github.issue(Number(id))?.labels).toEqual(['autobuild:ready'])
    github.resetRequests()
    expect((await source.get(id))?.state).toBe('triage')
    expect(github.issue(Number(id))?.labels).toEqual([])
    expect(github.count('patch-issue')).toBe(1)
    await source.get(id)
    expect(github.count('patch-issue')).toBe(1)
  })

  test('a failed heal still reads as triage', async () => {
    const { github, source } = setup()
    const id = await created(source, 'ready')
    github.uiClose(Number(id))
    github.uiReopen(Number(id))
    github.failNext(403, {}, { message: 'Resource not accessible' }, (method) => method === 'PATCH')
    expect((await source.get(id))?.state).toBe('triage')
    expect(github.issue(Number(id))?.labels).toEqual(['autobuild:ready'])
  })

  test('a label re-added after the reopen is fresh and keeps its state', async () => {
    const { github, source } = setup()
    const id = await created(source, 'ready')
    github.uiClose(Number(id))
    github.uiReopen(Number(id))
    github.uiRemoveLabel(Number(id), 'autobuild:ready')
    github.uiAddLabel(Number(id), 'autobuild:ready')
    github.resetRequests()
    expect((await source.get(id))?.state).toBe('ready')
    expect(github.count('timeline-reopen')).toBe(1)
    expect(github.count('patch-issue')).toBe(0)
  })
})

describe('github state listing', () => {
  test('lists lifecycle states first, then repository-defined labels with their purpose', async () => {
    const { github, source } = setup({ lifecycle: { backlog: 'backlog', rejected: 'rejected' } })
    await source.addState('icebox', { about: 'Parked ideas' })
    await created(source, 'ready')
    await created(source, 'icebox')
    github.fileIssue()
    const states = await source.listStates()
    expect(states.map((s) => s.name)).toEqual([
      'triage',
      'ready',
      'doing',
      'done',
      'backlog',
      'rejected',
      'icebox',
    ])
    expect(states.find((s) => s.name === 'icebox')).toEqual({
      name: 'icebox',
      tickets: 1,
      about: 'Parked ideas',
    })
    expect(states.find((s) => s.name === 'triage')?.tickets).toBe(1)
    expect(github.label('autobuild:icebox')?.description).toBe('Parked ideas')
  })

  test('addState refuses an existing name in any case, bad names and an over-long purpose', async () => {
    const { source } = setup()
    await source.addState('icebox')
    await expect(source.addState('ICEBOX')).rejects.toThrow('invalid state name')
    await expect(source.addState('icebox')).rejects.toThrow('already exists')
    await expect(source.addState('ready')).rejects.toThrow('already exists')
    await expect(source.addState('bad name')).rejects.toThrow('invalid state name')
    await expect(source.addState('long', { about: 'x'.repeat(101) })).rejects.toThrow(
      'at most 100 characters',
    )
  })

  test('a link label is never a state', async () => {
    const { github, source } = setup()
    await created(source, 'ready', { issueLinks: [{ issue: 9, intent: 'refs' }] })
    expect(github.label('autobuild-link:refs #9')).toBeDefined()
    expect((await source.listStates()).map((s) => s.name)).not.toContain('refs #9')
    await expect(source.transition('1001', 'refs #9')).rejects.toThrow('unknown state')
    await expect(source.addState('link')).resolves.toMatchObject({ created: true })
  })
})

describe('github tickets', () => {
  test('#N and N name the same ticket; other ids are no such ticket', async () => {
    const { source } = setup()
    const id = await created(source, 'ready')
    expect(await source.get(`#${id}`)).toEqual(await source.get(id))
    expect((await source.get(`#${id}`))?.ref.id).toBe(id)
    expect(await source.get('AUT-1')).toBeNull()
    await expect(source.update('AUT-1', { title: 'x' })).rejects.toThrow('AUT-1')
  })

  test('state and link labels are refused in create and update with nothing written', async () => {
    const { github, source } = setup()
    const id = await created(source, 'ready')
    github.resetRequests()
    for (const label of ['autobuild:doing', 'Autobuild-Link:refs #3']) {
      await expect(
        source.create({ title: 't', body: 'b', labels: [label] }, { state: 'ready' }),
      ).rejects.toThrow('managed label')
      await expect(source.update(id, { labels: [label] })).rejects.toThrow('managed label')
    }
    expect(github.writes()).toEqual([])
  })

  test('labels that do not exist are created on demand', async () => {
    const { github, source } = setup()
    await created(source, 'ready', { labels: ['brand-new'] })
    expect(github.label('brand-new')).toBeDefined()
    expect(github.label('autobuild:ready')?.description).toBe('Autobuild ticket state')
  })

  test('labels dropped for lack of push access are a clear error', async () => {
    const { github, source } = setup()
    github.dropLabels = true
    await expect(created(source, 'ready', { labels: ['bug'] })).rejects.toThrow(
      'token lacks push access; labels were dropped on #1001',
    )
  })

  test('label changes dropped for lack of push access fail claim, transition and update', async () => {
    const { github, source } = setup()
    const id = await created(source, 'ready', { labels: ['autobuild'] })
    github.dropLabels = true
    const dropped = `token lacks push access; label changes were dropped on #${id}`
    await expect(source.claim(id)).rejects.toThrow(`github claim: ${dropped}`)
    await expect(source.transition(id, 'triage')).rejects.toThrow(`github transition: ${dropped}`)
    await expect(source.update(id, { labels: ['bug'] })).rejects.toThrow(
      `github update: ${dropped}`,
    )
    github.dropLabels = false
    expect(github.issue(Number(id))?.labels.sort()).toEqual(['autobuild', 'autobuild:ready'])
    await source.update(id, { title: 'renamed' })
    expect(await source.claim(id)).toBe(true)
    expect((await source.get(id))?.state).toBe('doing')
  })

  test('update keeps the creation marker and the state label', async () => {
    const { github, source } = setup()
    const ticket = await source.create(
      { title: 't', body: 'first' },
      { state: 'ready', idempotencyKey: 'k-1', idempotencyKeyReservedAt: new Date().toISOString() },
    )
    await source.update(ticket.ref.id, { body: 'second', labels: ['bug'] })
    const read = await source.get(ticket.ref.id)
    expect(read).toMatchObject({
      body: 'second',
      creationKey: 'k-1',
      state: 'ready',
      labels: ['bug'],
    })
    expect(github.issue(Number(ticket.ref.id))?.body).toBe(
      'second\n<!-- autobuild:creation-key k-1 -->',
    )
  })

  test('guarded writes are refused before anything is written', async () => {
    const { github, source } = setup()
    const ticket = await source.create({ title: 't', body: 'b' }, { state: 'ready' })
    github.resetRequests()
    const refused = await updateTicket(
      source,
      ticket.ref.id,
      { title: 'x' },
      false,
      ticket.revision,
    )
      .then(() => undefined)
      .catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(TicketRevisionUnsupported)
    expect(github.writes()).toEqual([])
  })

  test('tickets carry no comment history; comment() posts one issue comment', async () => {
    const { github, source } = setup()
    const id = await created(source, 'ready')
    const quiet = await created(source, 'ready')
    github.uiComment(Number(id), 'chatter', 5000)
    await source.comment(id, 'claimed by build x')
    expect(github.comments.get(Number(id))?.at(-1)).toBe('claimed by build x')
    github.resetRequests()
    const read = await source.get(id)
    expect(read && 'comments' in read).toBe(false)
    const busy = github.requests.length
    github.resetRequests()
    await source.get(quiet)
    expect(github.requests.length).toBe(busy)
  })
})

describe('github creation keys', () => {
  const reservedAt = (ms: number) => new Date(ms).toISOString()

  test('a keyed create without a usable reservation time is refused with nothing written', async () => {
    const { github, source } = setup()
    for (const opts of [
      { idempotencyKey: 'k-1' },
      { idempotencyKey: 'k-1', idempotencyKeyReservedAt: 'yesterday' },
    ]) {
      const refused = await source
        .create({ title: 't', body: 'b' }, opts)
        .catch((error: unknown) => error)
      expect(refused).toBeInstanceOf(TicketCreationKeyReservationRequired)
      expect((refused as Error).message).toContain('idempotencyKeyReservedAt')
    }
    expect(github.writes()).toEqual([])
    expect(github.requests).toEqual([])
    await expect(source.create({ title: 't', body: 'b' })).resolves.toMatchObject({
      state: 'triage',
    })
  })

  test('a late retry adopts the original by the authoritative list, never search', async () => {
    const { clock, github, source } = clocked()
    const first = await source.create(
      { title: 'Original', body: 'b' },
      {
        state: 'ready',
        idempotencyKey: 'k-late',
        idempotencyKeyReservedAt: reservedAt(CLOCK_START),
      },
    )
    clock.advance(60_000)
    github.seedIssues(500)
    clock.advance(24 * 60 * 60 * 1000)
    const retry = await source.create(
      { title: 'Retry', body: 'other' },
      {
        state: 'done',
        idempotencyKey: 'k-late',
        idempotencyKeyReservedAt: reservedAt(CLOCK_START),
      },
    )
    expect(retry.ref.id).toBe(first.ref.id)
    expect(retry.title).toBe('Original')
    expect(github.issueCount()).toBe(501)
    expect(github.count('count')).toBe(0)
  })

  test('the scan stops at the reservation time less ten minutes', async () => {
    const { clock, github, source } = clocked()
    github.seedIssues(2000)
    clock.advance(60 * 60 * 1000)
    const key = {
      idempotencyKey: 'k-scan',
      idempotencyKeyReservedAt: reservedAt(CLOCK_START + 60 * 60 * 1000),
    }
    github.seedIssues(150)
    github.resetRequests()
    await source.create({ title: 'New', body: 'b' }, key)
    // 150 issues since the reservation: two list pages, then a stop.
    expect(github.count('list-issues')).toBe(2)
  })

  test('the pending marker is stripped from a byte-exact body', async () => {
    const { github, source } = setup()
    github.failNext(
      500,
      {},
      { message: 'boom' },
      (method, path) => method === 'POST' && path.endsWith('/blocked_by'),
    )
    const blocker = await created(source, 'ready')
    const body = 'exact\r\nbody  '
    await source
      .create(
        { title: 't', body, blockedBy: [blocker] },
        {
          state: 'ready',
          idempotencyKey: 'k-body',
          idempotencyKeyReservedAt: new Date().toISOString(),
        },
      )
      .catch(() => undefined)
    expect(github.issue(1002)?.body).toContain(' pending ')
    expect((await source.get('1002'))?.body).toBe(body)
  })

  test('each failed follow-up is finished by a retry from the first intent', async () => {
    for (const step of ['close', 'blocker', 'marker'] as const) {
      const { github, source } = setup()
      const blocker = await created(source, 'ready')
      const key = {
        idempotencyKey: `k-${step}`,
        idempotencyKeyReservedAt: new Date().toISOString(),
      }
      const match =
        step === 'close'
          ? (method: string, path: string) => method === 'PATCH' && /issues\/\d+$/.test(path)
          : step === 'blocker'
            ? (method: string, path: string) => method === 'POST' && path.endsWith('/blocked_by')
            : (method: string, path: string) => method === 'PATCH' && /issues\/\d+$/.test(path)
      if (step === 'marker') {
        // The close PATCH succeeds; the final marker PATCH fails.
        let patches = 0
        github.failNext(500, {}, { message: 'lost' }, (method, path) => {
          if (!match(method, path)) return false
          return ++patches === 2
        })
      } else github.failNext(500, {}, { message: 'lost' }, match)
      await expect(
        source.create(
          {
            title: 'Original',
            body: 'original body',
            issueLinks: [
              { issue: 824, intent: 'closes' },
              { issue: 820, intent: 'refs' },
            ],
            blockedBy: [blocker],
          },
          { state: 'done', ...key },
        ),
      ).rejects.toThrow()
      const retry = await source.create(
        { title: 'Retry must not win', body: 'retry body', blockedBy: [] },
        { state: 'ready', ...key },
      )
      expect(retry.ref.id).toBe('1002')
      expect(github.issueCount()).toBe(2)
      const issue = github.issue(1002)!
      expect(issue).toMatchObject({ state: 'closed', state_reason: 'completed', title: 'Original' })
      expect([...issue.labels].sort()).toEqual([
        'autobuild-link:closes #824',
        'autobuild-link:refs #820',
      ])
      expect(issue.blockedBy).toEqual([`acme/widgets#${blocker}`])
      expect(issue.body).toBe(`original body\n<!-- autobuild:creation-key k-${step} -->`)
      expect(retry).toMatchObject({ state: 'done', body: 'original body', blockedBy: [blocker] })
    }
  })

  test('link labels dropped on create are added once by the retry', async () => {
    const { github, source } = setup()
    const key = { idempotencyKey: 'k-links', idempotencyKeyReservedAt: new Date().toISOString() }
    const draft = {
      title: 't',
      body: 'b',
      issueLinks: [
        { issue: 824, intent: 'closes' as const },
        { issue: 820, intent: 'refs' as const },
      ],
    }
    github.dropLabels = true
    await expect(source.create(draft, { state: 'triage', ...key })).rejects.toThrow('push access')
    github.dropLabels = false
    await source.create(draft, { state: 'triage', ...key })
    await source.create(draft, { state: 'triage', ...key })
    expect([...github.issue(1001)!.labels].sort()).toEqual([
      'autobuild-link:closes #824',
      'autobuild-link:refs #820',
    ])
    expect(github.issueCount()).toBe(1)
  })

  test('a recovery never undoes a person’s reopen', async () => {
    const { github, source } = setup()
    const blocker = await created(source, 'ready')
    const key = { idempotencyKey: 'k-reopen', idempotencyKeyReservedAt: new Date().toISOString() }
    github.failNext(
      500,
      {},
      { message: 'lost' },
      (method, path) => method === 'POST' && path.endsWith('/blocked_by'),
    )
    await expect(
      source.create(
        { title: 't', body: 'b', blockedBy: [blocker], issueLinks: [{ issue: 9, intent: 'refs' }] },
        { state: 'done', ...key },
      ),
    ).rejects.toThrow('already exists')
    github.uiReopen(1002)
    github.resetRequests()
    await source.create({ title: 't', body: 'b' }, { state: 'done', ...key })
    expect(github.issue(1002)).toMatchObject({ state: 'open', labels: ['autobuild-link:refs #9'] })
    expect(github.issue(1002)?.blockedBy).toEqual([`acme/widgets#${blocker}`])
    expect(github.count('timeline-closed')).toBe(1)
    expect(github.count('unknown')).toBe(0)
  })

  test('a completed create is returned as it is, reconciling only missing blockers', async () => {
    const { github, source } = setup()
    const blocker = await created(source, 'ready')
    const key = { idempotencyKey: 'k-done', idempotencyKeyReservedAt: new Date().toISOString() }
    const first = await source.create({ title: 'Original', body: 'b' }, { state: 'ready', ...key })
    const retry = await source.create(
      { title: 'Retry', body: 'r', blockedBy: [blocker] },
      { state: 'done', ...key },
    )
    expect(retry).toMatchObject({ ref: { id: first.ref.id }, state: 'ready', blockedBy: [blocker] })
    expect(github.issue(Number(first.ref.id))?.title).toBe('Original')
  })
})

describe('github claim', () => {
  test('claims a ready issue and refuses everything else', async () => {
    const { github, source } = setup({ readyLabels: ['autobuild'] })
    const ready = await created(source, 'ready', { labels: ['autobuild'] })
    expect(await source.claim(ready)).toBe(true)
    expect(github.issue(Number(ready))?.labels).toEqual(['autobuild', 'autobuild:doing'])
    expect(await source.claim(ready)).toBe(false)

    const closed = await created(source, 'ready', { labels: ['autobuild'] })
    github.uiClose(Number(closed))
    const triaged = await created(source, 'ready', { labels: ['autobuild'] })
    await source.transition(triaged, 'triage')
    const unlabelled = await created(source, 'ready')
    for (const id of [closed, triaged, unlabelled, '999999', 'AUT-1'])
      expect(await source.claim(id)).toBe(false)
  })

  test('a stale reopen is healed and refused; an undecidable one is refused untouched', async () => {
    const { github, source } = setup()
    const stale = await created(source, 'ready')
    github.uiClose(Number(stale))
    github.uiReopen(Number(stale))
    expect(await source.claim(stale)).toBe(false)
    expect(github.issue(Number(stale))?.labels).toEqual([])

    const old = await created(source, 'ready')
    github.uiClose(Number(old))
    github.uiReopen(Number(old))
    github.addLabelEvents(Number(old), 150)
    github.resetRequests()
    expect(await source.claim(old)).toBe(false)
    expect(github.count('patch-issue')).toBe(0)
    expect(github.issue(Number(old))?.labels).toEqual(['autobuild:ready'])
  })
})

describe('github reopen check is bounded', () => {
  test('history beyond the window fails closed with a diagnostic, and a re-added label decides', async () => {
    // A ticking clock: re-adding the label within the same millisecond would
    // otherwise restore the issue's exact ETag and its saved verdict.
    let now = Date.parse('2026-01-01T00:00:00Z')
    const { github, source } = setup({ now: () => (now += 1) })
    const id = await created(source, 'ready')
    github.uiClose(Number(id))
    github.uiReopen(Number(id))
    github.uiRemoveLabel(Number(id), 'autobuild:ready')
    github.uiAddLabel(Number(id), 'autobuild:ready')
    github.addLabelEvents(Number(id), 99)
    github.resetRequests()
    expect((await source.get(id))?.state).toBe('ready')
    expect(github.count('timeline-reopen')).toBe(1)
    expect(github.graphqlRequests()[0]?.query).toContain('last: 100')

    github.uiComment(Number(id), 'noise', 5000)
    github.addLabelEvents(Number(id), 2000)
    github.resetRequests()
    const listing = await source.listReady({ state: 'ready' })
    expect(listing.tickets).toEqual([])
    expect(listing.diagnostics).toEqual([
      `github #${id}: reopened with autobuild:ready, but neither the reopen nor that label's event is among its last 100 label or reopen events; remove and re-add the label`,
    ])
    expect((await source.get(id))?.state).toBeUndefined()
    expect(await source.claim(id)).toBe(false)
    expect(github.count('patch-issue')).toBe(0)
    expect(github.count('get-issue')).toBeLessThanOrEqual(3)
    expect(github.count('timeline-reopen')).toBeLessThanOrEqual(3)

    github.uiRemoveLabel(Number(id), 'autobuild:ready')
    github.uiAddLabel(Number(id), 'autobuild:ready')
    expect((await source.get(id))?.state).toBe('ready')
  })

  test('a verdict is saved by ETag across adapters, and an issue change asks again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ab-github-verdicts-'))
    try {
      const github = new FakeGitHubIssues()
      const make = () =>
        new GitHubTicketSource({
          transport: github.transport,
          repository: github.repository,
          lifecycle: LIFECYCLE,
          readyLabels: [],
          validators: new FileGitHubValidatorStore(root),
        })
      const source = make()
      const id = await created(source, 'ready')
      github.uiClose(Number(id))
      github.uiReopen(Number(id))
      github.uiRemoveLabel(Number(id), 'autobuild:ready')
      github.uiAddLabel(Number(id), 'autobuild:ready')
      await source.get(id)
      github.resetRequests()
      await source.get(id)
      expect(github.count('timeline-reopen')).toBe(0)
      expect(github.count('get-issue', (r) => r.status === 304)).toBeGreaterThan(0)
      await make().get(id)
      expect(github.count('timeline-reopen')).toBe(0)
      github.uiAddLabel(Number(id), 'bug')
      await source.get(id)
      expect(github.count('timeline-reopen')).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reopening a UI-closed issue into its old state emits a fresh label event', async () => {
    const { github, source } = setup()
    const id = await created(source, 'doing')
    github.uiClose(Number(id))
    expect(github.issue(Number(id))?.labels).toEqual(['autobuild:doing'])
    await source.transition(id, 'doing')
    expect((await source.get(id))?.state).toBe('doing')
    expect(github.issue(Number(id))?.labels).toEqual(['autobuild:doing'])
  })
})

describe('github issue links are labels', () => {
  test('create writes link labels in the POST, and they survive UI edits', async () => {
    const { github, source } = setup()
    const ticket = await source.create(
      {
        title: 't',
        body: 'b',
        labels: ['bug'],
        issueLinks: parseIssueLinkList('824,820:refs'),
      },
      { state: 'ready' },
    )
    const post = github.requests.find((r) => r.kind === 'create-issue')
    expect(post).toBeDefined()
    expect([...github.issue(1001)!.labels].sort()).toEqual([
      'autobuild-link:closes #824',
      'autobuild-link:refs #820',
      'autobuild:ready',
      'bug',
    ])
    expect(github.label('autobuild-link:refs #820')?.description).toBe('Autobuild issue link')
    github.uiEditTitle(1001, 'Renamed on GitHub')
    github.uiEditBody(1001, 'Edited on GitHub')
    expect((await source.get(ticket.ref.id))?.issueLinks).toEqual([
      { issue: 820, intent: 'refs' },
      { issue: 824, intent: 'closes' },
      { issue: 1001, intent: 'closes' },
    ])
    expect((await source.get(ticket.ref.id))?.labels).toEqual(['bug'])
  })

  test('update replaces the set in one PATCH and keeps other labels and the state', async () => {
    const { github, source } = setup()
    const id = await created(source, 'ready', {
      labels: ['bug'],
      issueLinks: [{ issue: 824, intent: 'closes' }],
    })
    github.resetRequests()
    await source.update(id, { issueLinks: [{ issue: 9, intent: 'refs' }] })
    expect(github.count('patch-issue')).toBe(1)
    expect([...github.issue(Number(id))!.labels].sort()).toEqual([
      'autobuild-link:refs #9',
      'autobuild:ready',
      'bug',
    ])
    await source.update(id, { issueLinks: [] })
    expect([...github.issue(Number(id))!.labels].sort()).toEqual(['autobuild:ready', 'bug'])
    // The unused repository labels stay.
    expect(github.label('autobuild-link:closes #824')).toBeDefined()
  })

  test('listings read links with no request beyond the listing pages', async () => {
    const { github, source } = setup()
    await created(source, 'ready', { issueLinks: [{ issue: 9, intent: 'refs' }] })
    github.resetRequests()
    const listing = await source.listReady({ state: 'ready' })
    expect(listing.tickets[0]?.issueLinks).toEqual([
      { issue: 9, intent: 'refs' },
      { issue: 1001, intent: 'closes' },
    ])
    expect(github.requests.map((r) => r.kind)).toEqual(['list-issues'])
    github.resetRequests()
    await source.listAll()
    expect(github.requests.map((r) => r.kind)).toEqual(['list-issues'])
  })

  test('a malformed link label is ignored, kept out of labels and reported', async () => {
    const { github, source } = setup()
    const id = await created(source, 'ready')
    github.uiAddLabel(Number(id), 'autobuild-link:oops')
    github.uiAddLabel(Number(id), 'autobuild-link:refs #77')
    const listing = await source.listReady({ state: 'ready' })
    expect(listing.tickets[0]).toMatchObject({
      labels: [],
      issueLinks: [
        { issue: 77, intent: 'refs' },
        { issue: Number(id), intent: 'closes' },
      ],
    })
    expect(listing.diagnostics).toEqual([
      `github #${id}: ignoring malformed issue link label "autobuild-link:oops" — expected autobuild-link:closes #<n> or autobuild-link:refs #<n>`,
    ])
  })

  test('the own link is irremovable and naming it as refs is refused', async () => {
    const { github, source } = setup()
    const id = await created(source, 'ready')
    await source.update(id, { issueLinks: [{ issue: Number(id), intent: 'closes' }] })
    expect((await source.get(id))?.issueLinks).toEqual([{ issue: Number(id), intent: 'closes' }])
    github.resetRequests()
    await expect(
      source.update(id, { issueLinks: [{ issue: Number(id), intent: 'refs' }] }),
    ).rejects.toThrow('always closes')
    expect(github.writes()).toEqual([])
  })
})

describe('github blockers', () => {
  test('block and unblock are idempotent and a UI-added dependency is read', async () => {
    const { github, source } = setup()
    const a = await created(source, 'ready')
    const b = await created(source, 'ready')
    const c = await created(source, 'done')
    await source.addBlocker(a, `#${b}`)
    await source.addBlocker(a, b)
    github.uiAddDependency(Number(a), Number(c))
    expect((await source.get(a))?.blockedBy).toEqual([b, c])
    await source.removeBlocker(a, b)
    await source.removeBlocker(a, b)
    expect(await source.dependencyStates([a])).toEqual([
      { id: a, exists: true, resolved: false, state: 'ready', blockedBy: [c] },
    ])
    const listing = await source.listReady({ state: 'ready' })
    expect(listing.tickets.find((t) => t.ref.id === a)?.blockersResolved).toBe(true)
  })

  test('a refused dependency 422 fails; only a read-back edge counts as already held', async () => {
    const { github, source } = setup()
    const a = await created(source, 'ready')
    const b = await created(source, 'ready')
    const refused = { message: 'Validation Failed', errors: [{ message: 'Dependency refused' }] }
    const post = (method: string, path: string) => method === 'POST' && path.endsWith('/blocked_by')
    github.failNext(422, {}, refused, post)
    await expect(source.addBlocker(a, b)).rejects.toThrow('Validation Failed')
    expect((await source.get(a))?.blockedBy).toBeUndefined()
    // A person adds the same edge between the read and the POST.
    github.failNext(422, {}, refused, (method, path) => {
      if (!post(method, path)) return false
      github.uiAddDependency(Number(a), Number(b))
      return true
    })
    await source.addBlocker(a, b)
    expect((await source.get(a))?.blockedBy).toEqual([b])
  })

  test('a refused dependency 422 during keyed creation keeps the retry intent', async () => {
    const { github, source } = setup()
    const blocker = await created(source, 'ready')
    const key = { idempotencyKey: 'k-422', idempotencyKeyReservedAt: new Date().toISOString() }
    github.failNext(
      422,
      {},
      { message: 'Validation Failed', errors: [{ message: 'Dependency refused' }] },
      (method, path) => method === 'POST' && path.endsWith('/blocked_by'),
    )
    await expect(
      source.create({ title: 't', body: 'b', blockedBy: [blocker] }, { state: 'ready', ...key }),
    ).rejects.toThrow(`Blockers not recorded: "${blocker}"`)
    expect(github.issue(1002)?.body).toContain(' pending ')
    const retry = await source.create({ title: 't', body: 'b' }, { state: 'ready', ...key })
    expect(retry).toMatchObject({ ref: { id: '1002' }, blockedBy: [blocker] })
    expect(github.issue(1002)?.body).not.toContain(' pending ')
  })

  test('a cross-repository blocker exists, never resolves and never crashes a listing', async () => {
    const { github, source } = setup()
    const a = await created(source, 'ready')
    const foreign = github.addForeignDependency(Number(a), 'other/repo', 5, 'closed')
    const listing = await source.listReady({ state: 'ready' })
    expect(listing.tickets[0]).toMatchObject({ blockedBy: [foreign], blockersResolved: false })
    expect(await source.dependencyStates([foreign])).toEqual([
      { id: foreign, exists: true, resolved: false, blockedBy: [] },
    ])
    await expect(source.addBlocker(a, foreign)).rejects.toThrow('cross-repository')
    await source.removeBlocker(a, foreign)
    expect((await source.get(a))?.blockedBy).toBeUndefined()
  })

  test('a transferred issue is no ticket or blocker here, and nothing is written', async () => {
    const { github, source } = setup()
    const moved = await created(source, 'done')
    const ready = await created(source, 'ready')
    const victim = await created(source, 'ready')
    // GitHub's 301 is followed, so the old number reads as the moved issue,
    // closed as completed, under a number this repository also uses.
    github.transferIssue(Number(moved), `other/repo#${victim}`)
    github.resetRequests()
    expect(await source.dependencyStates([moved])).toEqual([
      { id: moved, exists: false, resolved: false, blockedBy: [] },
    ])
    expect(await source.get(moved)).toBeNull()
    expect(await source.claim(moved)).toBe(false)
    await expect(source.transition(moved, 'ready')).rejects.toThrow('unknown ticket')
    await expect(source.update(moved, { title: 'x' })).rejects.toThrow('unknown ticket')
    await expect(source.addBlocker(moved, ready)).rejects.toThrow('unknown ticket')
    await expect(source.addBlocker(ready, moved)).rejects.toThrow('unknown blocker')
    expect(github.writes()).toEqual([])
    expect((await source.get(victim))?.state).toBe('ready')
  })
})

describe('github state counts', () => {
  const seedStates = async (lifecycle: Partial<TicketLifecycle>) => {
    const { github, source } = setup({ lifecycle })
    await source.addState('icebox')
    for (const state of [
      'ready',
      'ready',
      'doing',
      'icebox',
      ...(lifecycle.backlog ? ['backlog'] : []),
    ])
      await created(source, state)
    github.fileIssue()
    github.fileIssue({ labels: ['autobuild:triage'] })
    github.fileIssue({ state: 'closed', state_reason: 'completed' })
    github.fileIssue({ state: 'closed', state_reason: 'not_planned' })
    github.fileIssue({ state: 'closed', state_reason: 'duplicate' })
    return { github, source }
  }

  for (const lifecycle of [{}, { backlog: 'backlog', rejected: 'rejected' }] as const) {
    test(`well-formed counts equal the listed tickets (${'rejected' in lifecycle ? 'rejected role' : 'not-planned'})`, async () => {
      const { github, source } = await seedStates(lifecycle)
      const listed = await source.listAll()
      github.resetRequests()
      const states = await source.listStates()
      for (const state of states)
        expect(state.tickets).toBe(listed.tickets.filter((t) => t.state === state.name).length)
      expect(github.requests.map((r) => r.kind)).toEqual(['count'])
      expect(github.requests[0]?.fields).toEqual(['open', 'closed', 'labels', 'search'])
      const query = github.requests[0]?.query ?? ''
      expect(query).not.toContain('reason:duplicate')
      expect(query).not.toContain('not planned')
    })
  }

  test('every count is one fresh request and stores nothing', async () => {
    const { github, source } = await seedStates({})
    const validators = new MemoryGitHubValidatorStore()
    const counted = new GitHubTicketSource({
      transport: github.transport,
      repository: github.repository,
      lifecycle: LIFECYCLE,
      readyLabels: [],
      validators,
    })
    github.resetRequests()
    for (let i = 0; i < 3; i++)
      expect(await counted.countStates(['triage'])).toEqual([{ name: 'triage', tickets: 2 }])
    expect(github.requests.map((r) => r.kind)).toEqual(['count', 'count', 'count'])
    expect(github.requests.every((r) => !r.fields?.includes('search'))).toBe(true)
    expect(validators.size).toBe(0)
    void source
  })

  test('repository-wide changes show on the very next call', async () => {
    const { github, source } = await seedStates({})
    const triage = async () => (await source.countStates(['triage']))[0]?.tickets
    const older = github.fileIssue()
    github.fileIssue()
    expect(await triage()).toBe(4)
    github.deleteIssue(older)
    expect(await triage()).toBe(3)
    github.transferIssue(github.fileIssue())
    expect(await triage()).toBe(3)
    github.labelsBumpUpdatedAt = false
    const relabel = github.fileIssue()
    github.uiAddLabel(relabel, 'autobuild:doing')
    expect(await triage()).toBe(3)
    expect((await source.countStates(['doing']))[0]?.tickets).toBe(2)
    github.deleteLabel('autobuild:doing')
    expect((await source.countStates(['doing']))[0]?.tickets).toBe(0)
    expect(await triage()).toBe(5)
    const done = async () => (await source.countStates(['done']))[0]?.tickets
    expect(await done()).toBe(1)
    github.deleteIssue(github.fileIssue({ state: 'closed', state_reason: 'completed' }))
    expect(await done()).toBe(1)
  })

  test('listStates and ab ticket states send one count request and no REST read', async () => {
    const { github, source } = await seedStates({})
    github.resetRequests()
    await source.listStates()
    await source.listStates()
    expect(github.requests.map((r) => r.kind)).toEqual(['count', 'count'])
  })

  test('search lag affects only done and rejected, and converges with no update', async () => {
    const { clock, github, source } = clocked()
    github.searchLagMs = 30 * 60 * 1000
    const id = await created(source, 'ready')
    clock.advance(60 * 60 * 1000)
    await source.transition(id, 'done')
    clock.advance(60_000)
    expect(await source.countStates(['done', 'not-planned'])).toEqual([
      { name: 'done', tickets: 0 },
      { name: 'not-planned', tickets: 1 },
    ])
    expect(await source.countStates(['triage'])).toEqual([{ name: 'triage', tickets: 0 }])
    clock.advance(30 * 60 * 1000)
    expect(await source.countStates(['done', 'not-planned'])).toEqual([
      { name: 'done', tickets: 1 },
      { name: 'not-planned', tickets: 0 },
    ])
  })

  test('documented approximations: legacy null reasons, stale reopen labels and two labels', async () => {
    const { github, source } = setup()
    const legacy = github.fileIssue({ state: 'closed', state_reason: null })
    expect(await source.get(String(legacy))).toMatchObject({ state: 'done', resolved: true })
    expect(await source.countStates(['done', 'not-planned'])).toEqual([
      { name: 'done', tickets: 0 },
      { name: 'not-planned', tickets: 1 },
    ])
    expect(
      github.writes().filter((r) => r.kind === 'patch-issue' && r.path.endsWith(`/${legacy}`)),
    ).toEqual([])

    const stale = await created(source, 'ready')
    github.uiClose(Number(stale))
    github.uiReopen(Number(stale))
    expect(await source.countStates(['ready', 'triage'])).toEqual([
      { name: 'ready', tickets: 1 },
      { name: 'triage', tickets: 0 },
    ])
    await source.get(stale)
    expect(await source.countStates(['ready', 'triage'])).toEqual([
      { name: 'ready', tickets: 0 },
      { name: 'triage', tickets: 1 },
    ])

    github.fileIssue({ labels: ['autobuild:ready', 'autobuild:doing'] })
    expect(await source.countStates(['ready', 'doing', 'triage'])).toEqual([
      { name: 'ready', tickets: 1 },
      { name: 'doing', tickets: 1 },
      { name: 'triage', tickets: 0 },
    ])
    expect((await source.listReady({ state: 'ready' })).diagnostics).toHaveLength(1)
  })

  test('the count request size does not depend on issue count', async () => {
    const small = setup()
    small.github.seedIssues(10)
    small.github.resetRequests()
    await small.source.countStates(['triage', 'done'])
    const large = setup()
    large.github.seedIssues(2000)
    large.github.seedIssues(2000, { state: 'closed' })
    large.github.resetRequests()
    expect(await large.source.countStates(['triage', 'done'])).toEqual([
      { name: 'triage', tickets: 2000 },
      { name: 'done', tickets: 2000 },
    ])
    expect(large.github.requests.map((r) => r.kind)).toEqual(
      small.github.requests.map((r) => r.kind),
    )
    expect(large.github.requests.map((r) => r.kind)).toEqual(['count'])
  })
})

describe('github writes never count', () => {
  test('transition and addState send no GraphQL, and a second transition revalidates labels', async () => {
    const { github, source } = setup()
    const id = await created(source, 'ready')
    github.resetRequests()
    await source.transition(id, 'doing')
    await source.transition(id, 'DONE')
    // Lifecycle moves look labels up by name; only explicit discovery lists.
    expect(github.count('labels-list')).toBe(0)
    await source.addState('icebox')
    expect(github.graphqlRequests()).toEqual([])
    github.uiAddLabel(Number(id), 'autobuild:shelved')
    await source.transition(id, 'shelved')
    expect((await source.get(id))?.state).toBe('shelved')
    await expect(source.transition(id, 'nowhere')).rejects.toThrow(
      'unknown state "nowhere" — this tracker\'s states are triage, ready, doing, done, not-planned',
    )
  })
})

describe('github tick budget', () => {
  /** What a dispatcher tick reads: the ready listing, then the blocker graph
   * of every candidate. Ticks never count. */
  async function tick(source: GitHubTicketSource): Promise<void> {
    const listing = await source.listReady({ state: 'ready', labels: ['autobuild'] })
    const blockers = [...new Set(listing.tickets.flatMap((t) => t.blockedBy ?? []))]
    if (blockers.length > 0) await source.dependencyStates(blockers)
  }

  function world(opts: { validators?: GitHubValidatorStore } = {}) {
    const github = new FakeGitHubIssues()
    const make = (validators = opts.validators ?? new MemoryGitHubValidatorStore()) =>
      new GitHubTicketSource({
        transport: github.transport,
        repository: github.repository,
        lifecycle: LIFECYCLE,
        readyLabels: ['autobuild'],
        validators,
      })
    return { github, make }
  }

  async function seedCandidates(source: GitHubTicketSource, count: number): Promise<string[]> {
    const blocker = await created(source, 'done')
    const ids: string[] = []
    for (let i = 0; i < count; i++)
      ids.push(
        await created(source, 'ready', {
          labels: ['autobuild'],
          blockedBy: [blocker],
          issueLinks: [{ issue: 9, intent: 'refs' }],
        }),
      )
    return ids
  }

  test('(a) a tick costs the same with 10 or 1,000 non-ready open and 1,000 closed issues', async () => {
    const requests: number[] = []
    for (const others of [10, 1000]) {
      const { github, make } = world()
      const source = make()
      await seedCandidates(source, 5)
      github.seedIssues(others, { labels: ['autobuild'] })
      github.seedIssues(others === 10 ? 10 : 1000, { state: 'closed' })
      github.resetRequests()
      await tick(source)
      requests.push(github.requests.length)
      expect(github.graphqlRequests()).toEqual([])
    }
    expect(requests[0]).toBe(requests[1])
  })

  test('(a2) claim and lifecycle moves cost the same with 0 or 1,000 unrelated link labels', async () => {
    const requests: number[] = []
    for (const others of [0, 1000]) {
      const { github, make } = world()
      const id = github.fileIssue({ title: 'candidate', labels: ['autobuild', 'autobuild:ready'] })
      for (let i = 1; i <= others; i++)
        github.fileIssue({
          title: 'unrelated',
          labels: [`autobuild-link:refs #${i}`, 'autobuild:done'],
          state: 'closed',
        })
      github.resetRequests()
      const source = make()
      expect(await source.claim(String(id))).toBe(true)
      await source.transition(String(id), 'done')
      requests.push(github.requests.length)
      expect(github.count('labels-list')).toBe(0)
      expect(github.graphqlRequests()).toEqual([])
    }
    expect(requests[0]).toBe(requests[1])
  })

  test('(a3) a label create answered 422 succeeds only when the label reads back', async () => {
    const { github, make } = world()
    const raced = github.fileIssue({ title: 'raced', labels: ['autobuild', 'autobuild:ready'] })
    const other = github.fileIssue({ title: 'other' })
    const createsLabel = (method: string, path: string) =>
      method === 'POST' && path.endsWith('/labels')
    github.failNext(422, {}, { message: 'Validation Failed' }, (method, path) => {
      if (!createsLabel(method, path)) return false
      github.uiAddLabel(other, 'autobuild:doing')
      return true
    })
    expect(await make().claim(String(raced))).toBe(true)
    expect(github.issue(raced)?.labels).toContain('autobuild:doing')

    const refused = github.fileIssue({ title: 'refused', labels: ['autobuild', 'autobuild:ready'] })
    github.failNext(422, {}, { message: 'Validation Failed' }, createsLabel)
    await expect(
      make().update(String(refused), { labels: ['autobuild', 'fresh'] }),
    ).rejects.toThrow('Validation Failed')
    expect(github.issue(refused)?.labels).not.toContain('fresh')
  })

  test('(b) an unchanged second tick is all 304s, and (b2) so is a fresh process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ab-github-tick-'))
    try {
      const { github, make } = world()
      const source = make(new FileGitHubValidatorStore(root))
      await seedCandidates(source, 5)
      // (b4) A cold store pays one unconditional read per tick request.
      github.resetRequests()
      await tick(source)
      const cold = github.requests.length
      expect(github.primary).toBe(cold)
      github.resetRequests()
      await tick(source)
      expect(github.primary).toBe(0)
      expect(github.requests.length).toBe(cold)
      github.resetRequests()
      await tick(make(new FileGitHubValidatorStore(root)))
      expect(github.primary).toBe(0)
      expect(github.graphqlRequests()).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('(b5) 2,500 candidates, 100 reopened, stay warm across ticks and a fresh adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ab-github-pressure-'))
    try {
      const { github, make } = world()
      const seeding = make()
      const ids = await seedCandidates(seeding, 2500)
      for (const id of ids.slice(0, 100)) {
        github.uiClose(Number(id), 'completed')
        github.uiReopen(Number(id))
        github.uiRemoveLabel(Number(id), 'autobuild:ready')
        github.uiAddLabel(Number(id), 'autobuild:ready')
        github.uiComment(Number(id), 'chatter', 50)
      }
      const store = new FileGitHubValidatorStore(root)
      const source = make(store)
      github.resetRequests()
      await tick(source)
      expect(github.count('timeline-reopen')).toBe(100)
      expect(github.graphqlRequests()).toHaveLength(100)
      const entries = async () => (await readdir(root)).filter((n) => n.endsWith('.json')).length
      const stored = await entries()
      for (let i = 0; i < 2; i++) {
        github.resetRequests()
        await tick(source)
        expect(github.primary).toBe(0)
        expect(github.graphqlRequests()).toEqual([])
        await source.listAll()
        await source.listReady({ state: 'done' })
        expect(await entries()).toBe(stored)
      }
      github.resetRequests()
      await tick(make(new FileGitHubValidatorStore(root)))
      expect(github.primary).toBe(0)
      expect(github.graphqlRequests()).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  test('(c) primary and secondary limits become the rate-limit error and a cooldown', async () => {
    let now = CLOCK_START
    const github = new FakeGitHubIssues()
    const source = new GitHubTicketSource({
      transport: github.transport,
      repository: github.repository,
      lifecycle: LIFECYCLE,
      readyLabels: [],
      now: () => now,
    })
    github.failNext(
      403,
      { 'retry-after': '120' },
      { message: 'You have exceeded a secondary rate limit' },
    )
    const secondary = await source.listReady({ state: 'ready' }).catch((error: unknown) => error)
    expect(secondary).toBeInstanceOf(TicketSourceRateLimitError)
    expect((secondary as TicketSourceRateLimitError).resetAt).toBe(now + 120_000)
    github.resetRequests()
    await expect(source.get('1001')).rejects.toBeInstanceOf(TicketSourceRateLimitError)
    expect(github.requests).toEqual([])
    now += 121_000
    github.failNext(429, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.floor((now + 600_000) / 1000)),
    })
    const primary = await source.listReady({ state: 'ready' }).catch((error: unknown) => error)
    expect(primary).toBeInstanceOf(TicketSourceRateLimitError)
    expect((primary as TicketSourceRateLimitError).resetAt).toBe(
      Math.floor((now + 600_000) / 1000) * 1000,
    )
    expect(github.count('list-issues')).toBe(1)
  })

  test('a GraphQL RATE_LIMITED answer is the same error', async () => {
    const github = new FakeGitHubIssues()
    const transport: GitHubRequest = async (method, path, opts) =>
      path === 'graphql'
        ? {
            status: 200,
            headers: {},
            json: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] },
          }
        : github.transport(method, path, opts)
    const source = new GitHubTicketSource({
      transport,
      repository: github.repository,
      lifecycle: LIFECYCLE,
      readyLabels: [],
    })
    await expect(source.countStates(['triage'])).rejects.toBeInstanceOf(TicketSourceRateLimitError)
  })
})

describe('github access checks', () => {
  const access = (
    github: FakeGitHubIssues,
    credentialMiss?: string,
    repository = github.repository,
  ) =>
    new GitHubTicketSource({
      transport: github.transport,
      repository,
      lifecycle: LIFECYCLE,
      readyLabels: [],
      credentialMiss: async () => credentialMiss,
    }).validateAccess()

  test('each problem has its own message', async () => {
    const github = new FakeGitHubIssues()
    await expect(access(github)).resolves.toBeUndefined()
    await expect(access(github, 'GITHUB_TOKEN and GH_TOKEN are unset')).rejects.toThrow(
      'no GitHub token — GITHUB_TOKEN and GH_TOKEN are unset',
    )
    await expect(access(github, undefined, { owner: 'acme', name: 'missing' })).rejects.toThrow(
      'token cannot read acme/missing',
    )
    github.hasIssues = false
    await expect(access(github)).rejects.toThrow('issues are disabled on acme/widgets')
    github.hasIssues = true
    github.failNext(403, {}, { message: 'Resource not accessible' }, (_m, path) =>
      path.endsWith('/issues'),
    )
    await expect(access(github)).rejects.toThrow('token cannot read the issues of acme/widgets')
    github.permissions = { pull: true, push: false }
    await expect(access(github)).rejects.toThrow(
      'token cannot set labels on acme/widgets — GitHub silently drops label changes',
    )
    github.permissions = { pull: true, push: false, triage: true }
    await expect(access(github)).resolves.toBeUndefined()
    expect(github.issueCount()).toBe(0)
  })

  test('push access is not issue-write access, with or without labels', async () => {
    const github = new FakeGitHubIssues()
    github.issueWrites = false
    await expect(access(github)).rejects.toThrow(
      'token cannot write the issues of acme/widgets — grant Issues: read and write',
    )
    github.fileIssue({ labels: ['bug'] })
    await expect(access(github)).rejects.toThrow('token cannot write the issues of acme/widgets')
    github.permissions = { pull: true }
    await expect(access(github)).rejects.toThrow('token cannot write the issues of acme/widgets')
    github.issueWrites = true
    await expect(access(github)).rejects.toThrow('token cannot set labels on acme/widgets')
    github.permissions = {}
    await expect(access(github)).rejects.toThrow('token cannot set labels on acme/widgets')
    github.permissions = undefined as unknown as Record<string, boolean>
    await expect(access(github)).resolves.toBeUndefined()
    expect(github.issueCount()).toBe(1)
  })

  test('an unexplained write-probe refusal is reported, never passed', async () => {
    const github = new FakeGitHubIssues()
    github.failNext(
      422,
      {},
      { message: 'endpoint has been spammed' },
      (method) => method === 'POST',
    )
    await expect(access(github)).rejects.toThrow(
      'could not confirm the token can write the issues of acme/widgets',
    )
  })
})

describe('github kernel marker labels', () => {
  test('autobuild:proposal and autobuild:aborted are ordinary labels, never states', async () => {
    const { github, source } = setup()
    const proposal = await source.create(
      { title: 'Harvested', body: 'b', labels: ['autobuild:proposal'] },
      { state: 'triage' },
    )
    expect(proposal).toMatchObject({ state: 'triage', labels: ['autobuild:proposal'] })
    const id = await created(source, 'doing')
    await source.update(id, { labels: ['autobuild:aborted'] })
    expect(await source.get(id)).toMatchObject({ state: 'doing', labels: ['autobuild:aborted'] })
    await source.transition(id, 'triage')
    expect(github.issue(Number(id))?.labels).toEqual(['autobuild:aborted'])
    expect(await source.get(id)).toMatchObject({ state: 'triage', labels: ['autobuild:aborted'] })
    expect((await source.countStates(['triage']))[0]?.tickets).toBe(2)
    expect((await source.listStates()).map((s) => s.name)).not.toContain('aborted')
    await expect(source.addState('aborted')).rejects.toThrow('cannot be a state')
  })
})

describe('github ready assignee', () => {
  const READY = { state: 'ready', labels: [] as string[] }

  function assigneeSetup(identity: string | null = 'alice') {
    const github = new FakeGitHubIssues()
    const source = new GitHubTicketSource({
      transport: github.transportAs(identity),
      repository: github.repository,
      lifecycle: LIFECYCLE,
      readyLabels: [],
    })
    const file = (...assignees: string[]) =>
      String(github.fileIssue({ labels: ['autobuild:ready'], assignees }))
    return { github, source, file }
  }

  const ids = async (source: GitHubTicketSource, assignee?: string) =>
    (
      await source.listReady({ ...READY, ...(assignee !== undefined ? { assignee } : {}) })
    ).tickets.map((ticket) => ticket.ref.id)

  test('declares the capability', () => {
    expect(assigneeSetup().source.readyAssignee).toBe(true)
  })

  test('unassigned issues are never ready; any one of several assignees matches', async () => {
    const { github, source, file } = assigneeSetup()
    const alice = file('alice')
    const shared = file('carol', 'Alice')
    file()
    const bob = file('bob')
    expect(await ids(source, 'alice')).toEqual([alice, shared])
    expect(await ids(source, 'ALICE')).toEqual([alice, shared])
    expect(await ids(source, 'carol')).toEqual([shared])
    expect(await ids(source, 'bob')).toEqual([bob])
    const lists = github.requests.filter((r) => r.kind === 'list-issues')
    expect(lists.map((r) => r.params?.assignee)).toEqual(['alice', 'ALICE', 'carol', 'bob'])
    expect(github.count('user')).toBe(0)
  })

  test('the membership check holds even if the server ignored the filter', async () => {
    const { github, file } = assigneeSetup()
    const alice = file('alice')
    file('bob')
    file()
    const unfiltered: GitHubRequest = (method, path, opts = {}) => {
      const { assignee: _assignee, ...query } = opts.query ?? {}
      return github.transport(method, path, { ...opts, query })
    }
    const source = new GitHubTicketSource({
      transport: unfiltered,
      repository: github.repository,
      lifecycle: LIFECYCLE,
      readyLabels: [],
    })
    expect(await ids(source, 'alice')).toEqual([alice])
  })

  test('"me" is the credential owner, resolved once', async () => {
    const { github, source, file } = assigneeSetup('alice')
    const alice = file('alice')
    file('bob')
    expect(await ids(source, 'me')).toEqual([alice])
    expect(await ids(source, 'me')).toEqual([alice])
    expect(github.count('user')).toBe(1)
    expect(github.requests.find((r) => r.kind === 'list-issues')?.params?.assignee).toBe('alice')
  })

  test('"me" with a credential that has no user is refused, and stays memoized', async () => {
    const { github, source, file } = assigneeSetup(null)
    file('alice')
    await expect(ids(source, 'me')).rejects.toThrow('the GitHub credential has no user')
    await expect(ids(source, 'me')).rejects.toThrow('the GitHub credential has no user')
    expect(github.count('user')).toBe(1)
    expect(github.count('list-issues')).toBe(0)
  })

  test('prepareReadyAssignee resolves once and decides refusals without requests', async () => {
    const { github, source } = assigneeSetup('alice')
    expect(source.readyAssigneeRefusal('me')).toContain(
      'could not be resolved at dispatcher startup',
    )
    await source.prepareReadyAssignee()
    await source.prepareReadyAssignee()
    expect(github.count('user')).toBe(1)
    github.resetRequests()
    expect(source.readyAssigneeRefusal('me')).toBeUndefined()
    expect(source.readyAssigneeRefusal('octocat')).toBeUndefined()
    expect(source.readyAssigneeRefusal('mona_acme')).toBeUndefined()
    expect(source.readyAssigneeRefusal('a@b.co')).toContain('or a GitHub username')
    expect(github.requests).toHaveLength(0)

    const noUser = assigneeSetup(null)
    await noUser.source.prepareReadyAssignee()
    expect(noUser.source.readyAssigneeRefusal('me')).toContain('the GitHub credential has no user')
    expect(noUser.source.readyAssigneeRefusal('octocat')).toBeUndefined()

    const failing = assigneeSetup('alice')
    failing.github.failNext(500, {}, { message: 'boom' }, (_method, path) => path === 'user')
    await expect(failing.source.prepareReadyAssignee()).rejects.toThrow('boom')
    expect(failing.source.readyAssigneeRefusal('me')).toContain(
      'could not be resolved at dispatcher startup',
    )
    expect(failing.source.readyAssigneeRefusal('me')).toContain('restart dispatch')
    failing.github.resetRequests()
    expect(failing.source.readyAssigneeRefusal('octocat')).toBeUndefined()
    expect(failing.github.requests).toHaveLength(0)
  })

  test('describeReadyAssignee names the user and checks they can be assigned', async () => {
    const { github, source } = assigneeSetup('alice')
    github.assignable.add('alice')
    expect(await source.describeReadyAssignee('me')).toBe('me → @alice')
    await expect(source.describeReadyAssignee('ghost')).rejects.toThrow(
      '"ghost" cannot be assigned issues in acme/widgets',
    )
    const noUser = assigneeSetup(null)
    await expect(noUser.source.describeReadyAssignee('me')).rejects.toThrow(
      'the GitHub credential has no user',
    )
    expect(noUser.github.count('assignee-check')).toBe(0)
  })

  test('a managed user login is used as given', async () => {
    const { github, source, file } = assigneeSetup('alice')
    github.assignable.add('mona_acme')
    const mona = file('mona_acme')
    file('octocat')
    file()
    expect(await source.describeReadyAssignee('mona_acme')).toBe('mona_acme → @mona_acme')
    expect(github.count('assignee-check')).toBe(1)
    expect(github.count('user')).toBe(0)
    expect(await ids(source, 'mona_acme')).toEqual([mona])
    expect(github.requests.find((r) => r.kind === 'list-issues')?.params?.assignee).toBe(
      'mona_acme',
    )
    expect(source.readyAssigneeRefusal('mona_acme')).toBeUndefined()
  })

  test('an assignee gate costs no more requests than none, from the first call', async () => {
    const without = assigneeSetup('alice')
    const withMe = assigneeSetup('alice')
    for (const fixture of [without, withMe]) {
      fixture.file('alice')
      fixture.file('alice', 'bob')
      fixture.file()
    }
    await withMe.source.prepareReadyAssignee()
    withMe.github.resetRequests()
    for (let call = 1; call <= 3; call++) {
      const before = { a: without.github.requests.length, b: withMe.github.requests.length }
      await ids(without.source)
      await ids(withMe.source, 'me')
      expect(withMe.github.requests.length - before.b).toBe(
        without.github.requests.length - before.a,
      )
    }
    expect(withMe.github.count('user')).toBe(0)
  })
})
