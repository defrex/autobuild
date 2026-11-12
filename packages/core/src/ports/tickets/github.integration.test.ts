import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { observeIntegration } from '../../kernel/integration-completeness'
import { MemoryBuildStore } from '../../store/memory'
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
    // A fixed clock advanced before each UI change: a re-add within the same
    // millisecond would otherwise leave `updated_at`, and so the ETag, unchanged.
    const { clock, github, source } = clocked()
    const id = await created(source, 'ready')
    clock.advance(1000)
    github.uiClose(Number(id))
    github.uiReopen(Number(id))
    github.uiRemoveLabel(Number(id), 'autobuild:ready')
    github.uiAddLabel(Number(id), 'autobuild:ready')
    github.addLabelEvents(Number(id), 99)
    github.resetRequests()
    expect((await source.get(id))?.state).toBe('ready')
    expect(github.count('timeline-reopen')).toBe(1)
    expect(github.graphqlRequests()[0]?.query).toContain('last: 100')

    clock.advance(1000)
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

    clock.advance(1000)
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
      expect(github.count('comments-list')).toBe(0)
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

  /** A node with five children (two blocked), unrelated open and closed
   * issues, and fifty sub-issues grouped under a non-node parent. */
  async function nodeWorld(source: GitHubTicketSource, github: FakeGitHubIssues, others: number) {
    const parent = (await source.create({ title: 'Node', body: 'B', kind: 'node' })).ref.id
    const blocker = await created(source, 'done')
    const children: string[] = []
    for (let i = 0; i < 5; i++)
      children.push(
        await created(source, 'ready', {
          target: parent,
          ...(i < 2 ? { blockedBy: [blocker] } : {}),
        }),
      )
    github.seedIssues(others, { labels: ['autobuild'] })
    github.seedIssues(others, { state: 'closed' })
    const group = github.fileIssue({ title: 'Grouping' })
    for (const id of github.seedIssues(50)) github.uiAddSubIssue(group, id)
    const store = new MemoryBuildStore()
    const ticket = { source: 'github', id: parent }
    await store.createBuild({
      slug: 'node',
      repo: 'repo',
      ticket,
      created: {
        actor: { kind: 'dispatcher' },
        type: 'build.created',
        payload: { repo: 'repo', ticket, kind: 'node', baseBranch: 'main' },
      },
    })
    return { children: children.sort(), store }
  }

  test('(d) integration observation costs the same with 10 or 1,000 unrelated issues', async () => {
    const requests: number[] = []
    for (const others of [10, 1000]) {
      const { github, make } = world()
      const source = make()
      const { children, store } = await nodeWorld(source, github, others)
      github.resetRequests()
      const observed = await observeIntegration(store, source, 'node')
      expect(observed.diagnostics).toEqual([])
      expect(observed.openChildren).toEqual(children)
      expect(github.count('list-issues')).toBe(0)
      expect(github.graphqlRequests()).toEqual([])
      requests.push(github.requests.length)
    }
    expect(requests[0]).toBe(requests[1])
  })

  test('(d2) an unchanged observation is all 304s, in this and a fresh adapter; (d3) a change is seen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ab-github-observe-'))
    try {
      const { github, make } = world()
      const source = make(new FileGitHubValidatorStore(root))
      const { children, store } = await nodeWorld(source, github, 10)
      github.resetRequests()
      await observeIntegration(store, source, 'node')
      const cold = github.requests.length
      github.resetRequests()
      await observeIntegration(store, source, 'node')
      expect(github.primary).toBe(0)
      expect(github.requests.length).toBe(cold)
      github.resetRequests()
      await observeIntegration(store, make(new FileGitHubValidatorStore(root)), 'node')
      expect(github.primary).toBe(0)

      github.uiClose(Number(children[0]), 'completed')
      const changed = await observeIntegration(store, source, 'node')
      expect(changed.openChildren).toEqual(children.slice(1))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('(e) ready node children cost one parent read per node, then 304s, at any repository size', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ab-github-parents-'))
    try {
      const requests: number[] = []
      for (const others of [10, 1000]) {
        const { github, make } = world()
        const seeding = make()
        const parents = [
          (await seeding.create({ title: 'N1', body: 'B', kind: 'node' })).ref.id,
          (await seeding.create({ title: 'N2', body: 'B', kind: 'node' })).ref.id,
        ]
        for (let i = 0; i < 4; i++)
          await created(seeding, 'ready', { labels: ['autobuild'], target: parents[i % 2]! })
        github.seedIssues(others, { labels: ['autobuild'] })
        const dir = join(root, String(others))
        const source = make(new FileGitHubValidatorStore(dir))
        github.resetRequests()
        await tick(source)
        expect(github.count('get-issue')).toBe(2)
        requests.push(github.requests.length)
        github.resetRequests()
        await tick(source)
        expect(github.primary).toBe(0)
        github.resetRequests()
        await tick(make(new FileGitHubValidatorStore(dir)))
        expect(github.primary).toBe(0)
        const listing = await source.listReady({ state: 'ready', labels: ['autobuild'] })
        expect(listing.tickets.map((t) => t.target)).toEqual([...parents, ...parents])
      }
      expect(requests[0]).toBe(requests[1])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

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

describe('github export and import support', () => {
  test('readComments pages the full history oldest first and maps authors', async () => {
    const { github, source } = setup()
    const id = await created(source, 'ready')
    for (let i = 0; i < 105; i++) github.uiComment(Number(id), `c${i}`, 1, i === 0 ? null : 'mona')
    github.resetRequests()
    const comments = await source.readComments(id)
    expect(comments).toHaveLength(105)
    expect(comments?.[0]).toEqual({ body: 'c0', createdAt: expect.any(String) })
    expect(comments?.[104]).toMatchObject({ body: 'c104', author: 'mona' })
    expect(github.count('comments-list')).toBe(2)
    expect(await source.readComments('9999')).toBeNull()
    expect(await source.readComments('not-an-issue')).toBeNull()
  })

  test('importProblems reports unrepresentable states, managed labels and bad keys together', async () => {
    const { github, source } = setup()
    expect(
      await source.importProblems({
        states: ['ready', 'review', 'not-planned', 'proposal', 'Bad State'],
        labels: ['bug', 'autobuild:foo', 'autobuild-link:refs #1'],
        creationKeys: ['migration:ok:1', 'has space'],
      }),
    ).toEqual([
      'creation key "has space" must be 1-200 letters, digits, dots, colons, underscores or hyphens',
      'label "autobuild-link:refs #1" would collide with an autobuild-link: issue link label',
      'label "autobuild:foo" would collide with an autobuild: state label',
      'state "Bad State" cannot be a GitHub state: "autobuild:Bad State" must be a lowercase state name of at most 40 characters that Autobuild does not apply itself',
      'state "not-planned": closed-as-not-planned holds no movable state on GitHub; configure [tickets].rejectedState',
      'state "proposal" cannot be a GitHub state: "autobuild:proposal" must be a lowercase state name of at most 40 characters that Autobuild does not apply itself',
    ])
    expect(github.requests).toEqual([])
  })

  test('readExportSnapshot fails on an issue it cannot read as a ticket', async () => {
    const { github, source } = setup()
    const id = await created(source, 'ready')
    github.uiAddLabel(Number(id), 'autobuild:doing')
    await expect(source.readExportSnapshot()).rejects.toThrow('incomplete ticket scan')
  })

  test('keyed creates index markers once, then read one list page each', async () => {
    const { github, source } = clocked()
    github.seedIssues(250)
    const key = (n: number) => ({
      idempotencyKey: `k-${n}`,
      idempotencyKeyReservedAt: new Date(CLOCK_START).toISOString(),
    })
    const ids: string[] = []
    for (let n = 0; n < 5; n++) {
      github.resetRequests()
      ids.push((await source.create({ title: `T${n}`, body: 'b' }, key(n))).ref.id)
      if (n > 0) expect(github.count('list-issues')).toBe(1)
    }
    const fresh = new GitHubTicketSource({
      transport: github.transport,
      repository: github.repository,
      lifecycle: LIFECYCLE,
      readyLabels: [],
    })
    github.resetRequests()
    for (let n = 0; n < 5; n++)
      expect((await fresh.create({ title: `T${n}`, body: 'b' }, key(n))).ref.id).toBe(ids[n]!)
    expect(github.count('create-issue')).toBe(0)
    expect(github.issueCount()).toBe(255)
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

describe('github assignees', () => {
  function assigneeSetup(identity: string | null = 'alice') {
    const github = new FakeGitHubIssues()
    const bodies: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
    const inner = github.transportAs(identity)
    const transport: GitHubRequest = (method, path, opts = {}) => {
      if (method !== 'GET' && opts.body !== undefined)
        bodies.push({ method, path, body: opts.body as Record<string, unknown> })
      return inner(method, path, opts)
    }
    const source = new GitHubTicketSource({
      transport,
      repository: github.repository,
      lifecycle: LIFECYCLE,
      readyLabels: [],
    })
    const issueWrites = () =>
      bodies.filter((write) => /\/issues(\/\d+)?$/.test(write.path)).map((write) => write.body)
    return { github, source, issueWrites }
  }

  test('declares the capability and reads assignees set on GitHub, outside the revision', async () => {
    const { github, source } = assigneeSetup()
    expect(source.assignees).toBe(true)
    const id = await created(source, 'ready')
    const before = (await source.get(id))!
    expect(before.assignees).toEqual([])
    github.uiAssign(Number(id), 'carol', 'dave')
    const after = (await source.get(id))!
    expect(after.assignees).toEqual(['carol', 'dave'])
    expect(after.revision).toBe(before.revision)
    expect((await source.listAll()).tickets[0]!.assignees).toEqual(['carol', 'dave'])
  })

  test('a create naming "me" assigns the credential owner', async () => {
    const { github, source, issueWrites } = assigneeSetup('alice')
    github.assignable.add('alice')
    const ticket = await source.create({ title: 't', body: 'b', assignees: ['me'] })
    expect(ticket.assignees).toEqual(['alice'])
    expect(issueWrites()[0]!.assignees).toEqual(['alice'])
    expect(github.count('user')).toBe(1)
  })

  test('a create without assignees sends none', async () => {
    const { github, source, issueWrites } = assigneeSetup()
    const ticket = await source.create({ title: 't', body: 'b' })
    expect(ticket.assignees).toEqual([])
    expect(issueWrites()[0]).not.toHaveProperty('assignees')
    expect(github.count('user')).toBe(0)
    expect(github.count('assignee-check')).toBe(0)
  })

  test('a user who cannot be assigned fails the create before any write', async () => {
    const { github, source } = assigneeSetup()
    await expect(source.create({ title: 't', body: 'b', assignees: ['ghost'] })).rejects.toThrow(
      '"ghost" cannot be assigned issues in acme/widgets — nothing was written',
    )
    expect(github.count('create-issue')).toBe(0)
    expect(github.issueCount()).toBe(0)
  })

  test('"me" with a credential that has no user fails the create before any write', async () => {
    const { github, source } = assigneeSetup(null)
    await expect(source.create({ title: 't', body: 'b', assignees: ['me'] })).rejects.toThrow(
      'the GitHub credential has no user',
    )
    expect(github.count('create-issue')).toBe(0)
  })

  test('malformed or too many entries are refused before any request', async () => {
    const { github, source } = assigneeSetup()
    await expect(source.create({ title: 't', body: 'b', assignees: ['a@b.co'] })).rejects.toThrow(
      'assignee "a@b.co" must be "me" or a GitHub username',
    )
    const eleven = Array.from({ length: 11 }, (_, i) => `user${i}`)
    await expect(source.create({ title: 't', body: 'b', assignees: eleven })).rejects.toThrow(
      'at most 10 assignees',
    )
    expect(github.requests).toHaveLength(0)
  })

  test('a create whose assignee GitHub dropped fails naming the unassigned issue', async () => {
    const { github, source } = assigneeSetup()
    github.assignable.add('bob')
    github.dropAssignees = true
    await expect(source.create({ title: 't', body: 'b', assignees: ['bob'] })).rejects.toThrow(
      /#\d+ \(.*\) was created but is unassigned — GitHub dropped assignee\(s\) bob/,
    )
  })

  test('a keyed retry after a dropped assignee adopts the issue and assigns it', async () => {
    const { github, source } = assigneeSetup()
    github.assignable.add('bob')
    github.dropAssignees = true
    const key = { idempotencyKey: 'k-assign', idempotencyKeyReservedAt: new Date().toISOString() }
    const draft = { title: 't', body: 'b', assignees: ['bob'] }
    const failure = await source.create(draft, key).catch((error: Error) => error.message)
    expect(failure).toContain('unassigned')
    expect(github.issueCount()).toBe(1)
    github.dropAssignees = false
    const retry = await source.create(draft, key)
    expect(failure).toContain(`#${retry.ref.id} `)
    expect(retry.assignees).toEqual(['bob'])
    expect(github.issueCount()).toBe(1)
  })

  test('a keyed retry of a completed create adds a missing assignee and keeps the rest', async () => {
    const { github, source } = assigneeSetup()
    github.assignable.add('bob')
    github.assignable.add('carol')
    const key = { idempotencyKey: 'k-done', idempotencyKeyReservedAt: new Date().toISOString() }
    const first = await source.create({ title: 't', body: 'b' }, key)
    github.uiAssign(Number(first.ref.id), 'carol')
    const retry = await source.create({ title: 't', body: 'b', assignees: ['bob'] }, key)
    expect(retry.ref.id).toBe(first.ref.id)
    expect(retry.assignees).toEqual(['carol', 'bob'])
    expect(github.issueCount()).toBe(1)
  })

  test('update replaces the set, [] clears it, and omission leaves it alone', async () => {
    const { github, source, issueWrites } = assigneeSetup('alice')
    github.assignable.add('alice')
    github.assignable.add('bob')
    const id = await created(source, 'ready')
    await source.update(id, { assignees: ['bob', 'me'] })
    expect((await source.get(id))!.assignees).toEqual(['bob', 'alice'])
    await source.update(id, { title: 'Renamed' })
    expect(issueWrites().at(-1)).not.toHaveProperty('assignees')
    expect((await source.get(id))!.assignees).toEqual(['bob', 'alice'])
    await source.update(id, { assignees: [] })
    expect((await source.get(id))!.assignees).toEqual([])
  })

  test('an update naming an unassignable user writes nothing', async () => {
    const { github, source } = assigneeSetup()
    const id = await created(source, 'ready')
    github.resetRequests()
    await expect(source.update(id, { title: 'New', assignees: ['ghost'] })).rejects.toThrow(
      '"ghost" cannot be assigned issues in acme/widgets — nothing was written',
    )
    expect(github.count('patch-issue')).toBe(0)
    expect((await source.get(id))!.title).toBe('In ready')
  })

  test('a kind or labels update naming an unassignable user creates no label', async () => {
    const { github, source } = assigneeSetup()
    const id = await created(source, 'ready')
    expect(github.labelNames()).not.toContain('node')
    github.resetRequests()
    for (const patch of [{ kind: 'node' as const }, { labels: ['fresh'] }])
      await expect(source.update(id, { ...patch, assignees: ['ghost'] })).rejects.toThrow(
        '"ghost" cannot be assigned issues in acme/widgets — nothing was written',
      )
    expect(github.writes()).toEqual([])
    expect(github.labelNames()).not.toContain('node')
    expect(github.labelNames()).not.toContain('fresh')
  })

  test('an update whose assignees GitHub dropped fails', async () => {
    const { github, source } = assigneeSetup()
    github.assignable.add('bob')
    const id = await created(source, 'ready')
    github.dropAssignees = true
    await expect(source.update(id, { assignees: ['bob'] })).rejects.toThrow(
      'its assignees were not applied',
    )
  })

  test('the assignable check is memoized per login', async () => {
    const { github, source } = assigneeSetup()
    github.assignable.add('bob')
    await source.create({ title: 'a', body: 'b', assignees: ['bob'] })
    await source.create({ title: 'c', body: 'd', assignees: ['Bob'] })
    expect(github.count('assignee-check')).toBe(1)
  })

  test('reading assignees adds no request to get or the ready listing', async () => {
    const plain = setup()
    const assigned = assigneeSetup()
    assigned.github.assignable.add('bob')
    const a = await created(plain.source, 'ready')
    const b = (
      await assigned.source.create(
        { title: 'In ready', body: 'Body.', assignees: ['bob'] },
        {
          state: 'ready',
        },
      )
    ).ref.id
    plain.github.resetRequests()
    assigned.github.resetRequests()
    await plain.source.get(a)
    await assigned.source.get(b)
    await plain.source.listReady({ state: 'ready', labels: [] })
    await assigned.source.listReady({ state: 'ready', labels: [] })
    expect(assigned.github.requests.map((r) => r.kind)).toEqual(
      plain.github.requests.map((r) => r.kind),
    )
  })

  test('createAssignee refusals and descriptions name the key', async () => {
    const { github, source } = assigneeSetup('alice')
    expect(source.createAssigneeRefusal('me')).toContain(
      '[tickets].createAssignee = "me" but the GitHub credential owner could not be resolved',
    )
    expect(source.createAssigneeRefusal('a@b.co')).toContain('[tickets].createAssignee must be')
    github.assignable.add('alice')
    expect(await source.describeCreateAssignee('me')).toBe('me → @alice')
    expect(source.createAssigneeRefusal('me')).toBeUndefined()
    await expect(source.describeCreateAssignee('ghost')).rejects.toThrow(
      '[tickets].createAssignee "ghost" cannot be assigned issues in acme/widgets',
    )
    const noUser = assigneeSetup(null)
    await expect(noUser.source.describeCreateAssignee('me')).rejects.toThrow(
      '[tickets].createAssignee = "me" but the GitHub credential has no user',
    )
  })
})

describe('github integration tree', () => {
  function tree(opts: { subIssuePageCap?: number } = {}) {
    const github = new FakeGitHubIssues(opts)
    const source = new GitHubTicketSource({
      transport: github.transport,
      repository: github.repository,
      lifecycle: LIFECYCLE,
      readyLabels: [],
    })
    return { github, source }
  }

  async function node(source: GitHubTicketSource, draft: Partial<TicketDraft> = {}) {
    return (await source.create({ title: 'Node', body: 'Body.', kind: 'node', ...draft })).ref.id
  }

  test('create --kind node adds the exact node label, creating it; conflicts write nothing', async () => {
    const { github, source } = tree()
    const created = await source.create({ title: 'Node', body: 'Body.', kind: 'node' })
    expect(created.kind).toBe('node')
    expect(created.labels).toEqual(['node'])
    expect(github.label('node')).toMatchObject({
      name: 'node',
      description: 'Autobuild integration node',
    })
    expect((await source.get(created.ref.id))?.kind).toBe('node')
    github.resetRequests()
    for (const draft of [
      { kind: 'work' as const, labels: ['node'] },
      { kind: 'node' as const, labels: ['other'] },
    ])
      await expect(source.create({ title: 'Conflict', body: 'Body.', ...draft })).rejects.toThrow(
        'github create: ticket "Conflict": conflicting kind and node label instructions — nothing was written',
      )
    expect(github.writes()).toEqual([])
  })

  test('a repository label cased otherwise refuses node writes with nothing written', async () => {
    const { github, source } = tree()
    github.fileIssue({ title: 'Other', labels: ['Node'] })
    const plain = await created(source, 'ready')
    github.resetRequests()
    await expect(source.create({ title: 'N', body: 'Body.', kind: 'node' })).rejects.toThrow(
      'repository label "Node" stands in for the node label; rename it to "node" on GitHub — nothing was written',
    )
    await expect(source.update(plain, { kind: 'node' })).rejects.toThrow('stands in for')
    expect(github.writes()).toEqual([])
  })

  test('create --target makes the new issue a sub-issue of the node', async () => {
    const { github, source } = tree()
    const parent = await node(source)
    const child = await source.create({ title: 'Child', body: 'Body.', target: `#${parent}` })
    expect(child.target).toBe(parent)
    expect(github.subIssues(Number(parent))).toEqual([Number(child.ref.id)])
    expect((await source.get(child.ref.id))?.target).toBe(parent)
  })

  test('a keyed create whose sub-issue write fails is finished by a retry with the key', async () => {
    const { github, source } = tree()
    const parent = await node(source)
    const key = { idempotencyKey: 'k-target', idempotencyKeyReservedAt: new Date().toISOString() }
    github.failNext(
      500,
      {},
      { message: 'lost' },
      (method, path) => path.endsWith('/sub_issues') && method === 'POST',
    )
    await expect(
      source.create({ title: 'Child', body: 'Body.', target: parent }, key),
    ).rejects.toThrow(
      /already exists at .*, but its target #\d+ was not recorded\. Retry with the same creation key/,
    )
    const id = String(Number(parent) + 1)
    expect(github.subIssues(Number(parent))).toEqual([])
    const retry = await source.create({ title: 'Retry', body: 'Other.' }, key)
    expect(retry).toMatchObject({ ref: { id }, title: 'Child', target: parent })
    expect(github.subIssues(Number(parent))).toEqual([Number(id)])
    expect(github.issueCount()).toBe(2)
    expect(github.issue(Number(id))?.body).toBe('Body.\n<!-- autobuild:creation-key k-target -->')
  })

  test('a keyed retry revalidates its recorded target and refuses one demoted since', async () => {
    const { github, source } = tree()
    const parent = await node(source)
    const key = { idempotencyKey: 'k-demoted', idempotencyKeyReservedAt: new Date().toISOString() }
    github.failNext(
      500,
      {},
      { message: 'lost' },
      (method, path) => path.endsWith('/sub_issues') && method === 'POST',
    )
    await expect(
      source.create({ title: 'Child', body: 'Body.', target: parent }, key),
    ).rejects.toThrow(/but its target #\d+ was not recorded/)
    const id = String(Number(parent) + 1)
    await source.update(parent, { kind: 'work' })
    github.resetRequests()
    await expect(source.create({ title: 'Retry', body: 'Other.' }, key)).rejects.toThrow(
      `github create: ticket "${id}" already exists at https://github.com/acme/widgets/issues/${id}, but its recorded target #${parent} is no longer valid, so it was not recorded: target ${parent} is not a node.`,
    )
    expect(github.writes()).toEqual([])
    expect(github.subIssues(Number(parent))).toEqual([])
    expect(github.issueCount()).toBe(2)
    await source.update(parent, { kind: 'node' })
    const retry = await source.create({ title: 'Retry', body: 'Other.' }, key)
    expect(retry).toMatchObject({ ref: { id }, title: 'Child', target: parent })
    expect(github.subIssues(Number(parent))).toEqual([Number(id)])
  })

  test('an unkeyed create whose sub-issue write fails names the issue and the repair', async () => {
    const { github, source } = tree()
    const parent = await node(source)
    github.failNext(
      500,
      {},
      { message: 'lost' },
      (method, path) => path.endsWith('/sub_issues') && method === 'POST',
    )
    const id = String(Number(parent) + 1)
    await expect(source.create({ title: 'Child', body: 'Body.', target: parent })).rejects.toThrow(
      `Do not rerun ticket creation; set it with \`ab ticket update ${id} --target ${parent}\``,
    )
  })

  test('invalid targets are refused, naming the ticket, with nothing written', async () => {
    const { github, source } = tree()
    const work = await created(source, 'ready')
    const outer = await node(source)
    const inner = await node(source, { target: outer })
    github.resetRequests()
    await expect(source.create({ title: 'C', body: 'B', target: work })).rejects.toThrow(
      `github create: ticket "C": target ${work} is not a node — nothing was written`,
    )
    await expect(source.create({ title: 'C', body: 'B', target: '99999' })).rejects.toThrow(
      'github create: ticket "C": target 99999 does not exist in the configured github source — nothing was written',
    )
    await expect(source.update(outer, { target: outer })).rejects.toThrow(
      `github update: ticket "${outer}": target ${outer} would create a cycle`,
    )
    await expect(source.update(outer, { target: inner })).rejects.toThrow(
      new RegExp(`^github update: ticket "${outer}": target \\d+ would create a cycle`),
    )
    await expect(source.update(work, { target: work })).rejects.toThrow(
      `github update: ticket "${work}": target ${work} is not a node`,
    )
    expect(github.writes()).toEqual([])
  })

  test('a node with a sub-issue cannot become work, by kind or by labels', async () => {
    const { github, source } = tree()
    const parent = await node(source)
    const child = (await source.create({ title: 'C', body: 'B', target: parent })).ref.id
    github.resetRequests()
    for (const patch of [{ kind: 'work' as const }, { labels: ['other'] }])
      await expect(source.update(parent, patch)).rejects.toThrow(
        `github update: cannot change node ${parent} to work: ticket ${child} targets it — nothing was written`,
      )
    expect(github.writes()).toEqual([])
    await source.update(child, { target: null })
    await source.update(parent, { kind: 'work' })
    expect(github.issue(Number(parent))?.labels).toEqual([])
    expect((await source.get(parent))?.kind).toBe('work')
  })

  test('update --target moves, keeps, and clears the sub-issue relation', async () => {
    const { github, source } = tree()
    const first = await node(source)
    const second = await node(source)
    const child = (await source.create({ title: 'C', body: 'B', target: first })).ref.id
    github.resetRequests()
    await source.update(child, { target: second })
    expect(github.subIssues(Number(first))).toEqual([])
    expect(github.subIssues(Number(second))).toEqual([Number(child)])
    expect(github.writes().map((write) => write.kind)).toEqual(['sub-issue-add'])
    github.resetRequests()
    await source.update(child, { target: second })
    expect(github.writes()).toEqual([])
    await source.update(child, { target: null })
    expect(github.writes().map((write) => write.kind)).toEqual(['sub-issue-remove'])
    expect((await source.get(child))?.target).toBeUndefined()
    github.resetRequests()
    await source.update(child, { title: 'Renamed', target: first })
    expect(github.writes().map((write) => write.kind)).toEqual(['patch-issue', 'sub-issue-add'])
    expect(await source.get(child)).toMatchObject({ title: 'Renamed', target: first })
  })

  test('a grouping parent gives no target, never blocks dispatch and is left untouched', async () => {
    const { github, source } = tree()
    const target = await node(source)
    const group = github.fileIssue({ title: 'Grouping' })
    const child = await created(source, 'ready')
    github.uiAddSubIssue(group, Number(child))
    expect((await source.get(child))?.target).toBeUndefined()
    expect((await source.listReady({ state: 'ready' })).tickets.map((t) => t.ref.id)).toEqual([
      child,
    ])
    await expect(source.update(child, { target })).rejects.toThrow(
      `github update: ticket "${child}" is a sub-issue of #${group}, which is not a node; remove it from #${group} or label #${group} node on GitHub — nothing was written`,
    )
    github.resetRequests()
    await source.update(child, { target: null })
    expect(github.writes()).toEqual([])
    await source.update(child, { title: 'Renamed', labels: ['x'] })
    expect(github.issue(Number(child))?.parent).toBe(`acme/widgets#${group}`)
  })

  test('foreign, deleted and transferred parents give no target', async () => {
    const { github, source } = tree()
    const target = await node(source)
    const foreign = await created(source, 'ready')
    github.setForeignParent(Number(foreign), 'acme/other', 7)
    expect((await source.get(foreign))?.target).toBeUndefined()
    await expect(source.update(foreign, { target })).rejects.toThrow(
      'is a sub-issue of acme/other#7, which is not a node',
    )
    for (const gone of ['deleted', 'transferred'] as const) {
      const parent = await node(source)
      const child = (await source.create({ title: 'C', body: 'B', target: parent })).ref.id
      expect((await source.get(child))?.target).toBe(parent)
      if (gone === 'deleted') github.deleteIssue(Number(parent))
      else github.transferIssue(Number(parent))
      expect((await source.get(child))?.target).toBeUndefined()
      expect(
        (await source.listAll()).tickets.find((t) => t.ref.id === child)?.target,
      ).toBeUndefined()
    }
  })

  test('sub-issue and node label changes made in the UI read back like ab ticket writes', async () => {
    const { github, source } = tree()
    const parent = await node(source)
    const child = await created(source, 'ready')
    const ids = async (id: string) => (await source.listTargeting(id)).tickets.map((t) => t.ref.id)
    github.uiAddSubIssue(Number(parent), Number(child))
    expect((await source.get(child))?.target).toBe(parent)
    expect(await ids(parent)).toEqual([child])
    github.uiRemoveSubIssue(Number(child))
    expect((await source.get(child))?.target).toBeUndefined()
    expect(await ids(parent)).toEqual([])

    const group = github.fileIssue({ title: 'Grouping' })
    github.uiAddSubIssue(group, Number(child))
    expect((await source.get(child))?.target).toBeUndefined()
    github.uiAddLabel(group, 'node')
    github.resetRequests()
    expect((await source.get(child))?.target).toBe(String(group))
    // The parent's own conditional read saw the relabel the child's could not.
    expect(github.count('get-issue', (r) => r.path.endsWith(`/issues/${group}`))).toBe(1)
    expect((await source.get(String(group)))?.kind).toBe('node')
    expect(await ids(String(group))).toEqual([child])
    github.uiRemoveLabel(group, 'node')
    expect((await source.get(child))?.target).toBeUndefined()
    expect((await source.get(String(group)))?.kind).toBe('work')
    expect(await ids(String(group))).toEqual([])
  })

  test('sub-issue lists are fully paginated for demotion and listTargeting', async () => {
    const { github, source } = tree({ subIssuePageCap: 2 })
    const parent = await node(source)
    const children: string[] = []
    for (let i = 0; i < 5; i++) {
      const child = await created(source, 'ready')
      github.uiAddSubIssue(Number(parent), Number(child))
      children.push(child)
    }
    github.resetRequests()
    await expect(source.update(parent, { kind: 'work' })).rejects.toThrow('cannot change node')
    expect(github.count('sub-issues-list')).toBe(3)
    github.resetRequests()
    const listing = await source.listTargeting(parent)
    expect(listing.tickets.map((t) => t.ref.id)).toEqual(children)
    expect(github.count('sub-issues-list')).toBe(3)
  })

  test('listTargeting: foreign, unlabelled, childless, resolved and malformed edges', async () => {
    const { github, source } = tree()
    const parent = await node(source)
    const ids = async (id: string) => (await source.listTargeting(id)).tickets.map((t) => t.ref.id)
    github.resetRequests()
    expect(await ids(parent)).toEqual([])
    expect(github.count('get-issue')).toBe(1)
    expect(github.count('sub-issues-list')).toBe(0)

    github.addForeignSubIssue(Number(parent), 'acme/other', 3)
    expect(await ids(parent)).toEqual([])
    const done = (
      await source.create({ title: 'Done', body: 'B', target: parent }, { state: 'done' })
    ).ref.id
    const malformed = await created(source, 'ready', { target: parent })
    github.uiAddLabel(Number(malformed), 'autobuild:doing')
    const listing = await source.listTargeting(parent)
    expect(listing.tickets).toMatchObject([{ ref: { id: done }, resolved: true, target: parent }])
    expect(listing.diagnostics).toEqual([
      `github #${malformed}: has 2 state labels (autobuild:ready, autobuild:doing); a ticket holds one state — remove all but one`,
    ])
    expect((await source.listAll()).diagnostics).toEqual(listing.diagnostics)

    github.uiRemoveLabel(Number(parent), 'node')
    expect(await source.listTargeting(parent)).toEqual({ tickets: [], diagnostics: [] })
    expect(await source.listTargeting('not-an-issue')).toEqual({ tickets: [], diagnostics: [] })
  })

  test('the revision covers kind and target and returns after a revert', async () => {
    const { github, source } = tree()
    const parent = await node(source)
    const child = await created(source, 'ready')
    const revision = async () => (await source.get(child))!.revision
    const before = await revision()
    github.uiAddSubIssue(Number(parent), Number(child))
    const targeted = await revision()
    expect(targeted).not.toBe(before)
    github.uiRemoveSubIssue(Number(child))
    expect(await revision()).toBe(before)
    await source.update(child, { kind: 'node' })
    expect(await revision()).not.toBe(before)
    await source.update(child, { kind: 'work' })
    expect(await revision()).toBe(before)
  })

  test('the import replay preserves kind and target', async () => {
    const { source } = tree()
    // migration.ts creates every ticket plainly, then replays the tree.
    const parent = await created(source, 'ready')
    const child = await created(source, 'ready')
    const root = await created(source, 'ready')
    await source.update(parent, { kind: 'node' })
    await source.update(child, { kind: 'work', target: parent })
    await source.update(root, { kind: 'work', target: null })
    expect(await source.get(parent)).toMatchObject({ kind: 'node' })
    expect(await source.get(child)).toMatchObject({ kind: 'work', target: parent })
    const imported = await source.get(root)
    expect(imported?.kind).toBe('work')
    expect(imported?.target).toBeUndefined()
  })

  test('an exhaustive listing reads parents from its own batch', async () => {
    const { github, source } = tree()
    const parent = await node(source)
    await source.create({ title: 'C', body: 'B', target: parent })
    await source.create({ title: 'D', body: 'B', target: parent })
    github.resetRequests()
    const listing = await source.listAll()
    expect(listing.tickets.filter((t) => t.target === parent)).toHaveLength(2)
    expect(github.count('get-issue')).toBe(0)
  })
})
