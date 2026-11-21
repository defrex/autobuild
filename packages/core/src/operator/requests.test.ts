import { describe, expect, test } from 'bun:test'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { MemoryBuildStore } from '../store/memory'
import {
  answerAction,
  controlPrechecks,
  parseArtifactRevision,
  reopenAction,
  RouteRefusalError,
} from './requests'

const repo = 'acme/widgets'
const now = new Date('2026-09-02T00:00:00.000Z')
const clock = () => now

async function runningStore(): Promise<MemoryBuildStore> {
  const store = new MemoryBuildStore({ clock })
  await store.createBuild({ slug: 'demo', repo })
  await store.append('demo', {
    actor: DISPATCHER,
    type: 'build.created',
    payload: { ticket: { source: 'linear', id: 'AUT-1' }, repo, baseBranch: 'main' },
  })
  await store.append('demo', {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'runner-1', host: 'host-1' },
  })
  return store
}

describe('operator route glue re-derived for the registry', () => {
  test('reopenAction maps feedback and either revision origin to the control action', async () => {
    expect(reopenAction({ feedback: 'rename it' })).toEqual({
      action: { kind: 'reopen', feedback: 'rename it' },
    })
    const body = reopenAction({ revision: { origin: 'body', body: 'replacement' } })
    expect(body.action).toMatchObject({
      kind: 'reopen',
      reviseSpec: { kind: 'supplied', origin: 'operator API body' },
    })
    expect(
      body.action.reviseSpec?.kind === 'supplied' ? await body.action.reviseSpec.read() : '',
    ).toBe('replacement')
    expect(body.readTicketBody).toBeUndefined()
    const ticket = reopenAction({
      feedback: 'and this',
      revision: { origin: 'ticket', body: 'ticket body' },
    })
    expect(ticket.action).toEqual({
      kind: 'reopen',
      feedback: 'and this',
      reviseSpec: { kind: 'ticket' },
    })
    expect(await ticket.readTicketBody?.()).toBe('ticket body')
  })

  test('answerAction maps every resolution to the route’s exact action shape', () => {
    expect(answerAction({ resolution: 'retry' })).toEqual({ action: { kind: 'answer' } })
    expect(answerAction({ resolution: 'guidance', text: ' go left ' })).toEqual({
      action: { kind: 'answer', text: ' go left ' },
    })
    expect(answerAction({ resolution: 'dismiss', text: undefined })).toEqual({
      action: { kind: 'answer', text: undefined, resolve: { kind: 'dismiss-finding' } },
    })
    expect(
      answerAction({ resolution: 'review-round-ceiling', ceiling: 4, text: undefined }),
    ).toEqual({ action: { kind: 'answer', text: undefined, reviewRoundCeiling: 4 } })
    const body = answerAction({
      resolution: 'revise-spec',
      origin: 'body',
      body: 'replacement spec',
    })
    expect(body.action).toMatchObject({
      kind: 'answer',
      resolve: { kind: 'revise-spec', body: { kind: 'supplied', origin: 'operator API body' } },
    })
    expect(body.readTicketBody).toBeUndefined()
    const ticket = answerAction({
      resolution: 'revise-spec',
      origin: 'ticket',
      body: 'ignored for ticket origin',
    })
    expect(ticket.action).toMatchObject({
      kind: 'answer',
      resolve: { kind: 'revise-spec', body: { kind: 'ticket' } },
    })
    expect(ticket.readTicketBody).toBeInstanceOf(Function)
  })

  test('controlPrechecks refuses unknown builds with the route’s exact text', async () => {
    const store = await runningStore()
    const error = await controlPrechecks(store, repo, 'missing', 'pause').catch((e) => e)
    expect(error).toBeInstanceOf(RouteRefusalError)
    expect(error.refusal).toEqual({ kind: 'not-found', error: 'unknown build "missing"' })
  })

  test('controlPrechecks mirrors the pause/cancel-pause pending-state refusals', async () => {
    const store = await runningStore()
    // A pending pause makes a second pause the route's already-pending refusal…
    await store.append('demo', {
      actor: { kind: 'human', user: 'Ada' },
      type: 'build.pause-requested',
      payload: {},
    })
    const pausing = await controlPrechecks(store, repo, 'demo', 'pause').catch((e) => e)
    expect(pausing.message).toBe(
      'build "demo" cannot pause (status: pausing); pause is already pending',
    )
    // …and a cancel-pause without a pending pause is the other exact refusal.
    const fresh = await runningStore()
    const cancel = await controlPrechecks(fresh, repo, 'demo', 'cancel-pause').catch((e) => e)
    expect(cancel.message).toBe(
      'build "demo" cannot cancel pause (status: running); cancel pause requires a pending pause',
    )
    // No pending state involved: the plain checks pass silently.
    await expect(controlPrechecks(fresh, repo, 'demo', 'resume')).resolves.toBeUndefined()
    await expect(controlPrechecks(store, repo, 'demo', 'discard')).resolves.toBeUndefined()
  })

  test('parseArtifactRevision keeps the route’s rev query rule', () => {
    expect(parseArtifactRevision('0')).toBe(0)
    expect(parseArtifactRevision('17')).toBe(17)
    for (const bad of ['-1', '1.5', 'abc', '', ' 1', '01x']) {
      expect(() => parseArtifactRevision(bad)).toThrow('rev must be a nonnegative integer')
    }
  })
})
