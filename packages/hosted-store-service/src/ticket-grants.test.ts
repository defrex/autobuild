import { expect, test } from 'bun:test'
import { FakeTicketSource } from '@defrex/autobuild/plugin-sdk'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '@defrex/autobuild/remote-store'
import type { TicketGrant, TicketGrantStore } from '@defrex/autobuild-postgres-store/ticket-grants'
import { createTicketServer } from './ticket-server'

const repo = 'https://github.com/acme/one'
test('ticket transport enforces runner/phase authority and service-only grants', async () => {
  const now = new Date('2026-10-16T00:00:00Z')
  const runner: TicketGrant = {
    id: 'runner',
    repo,
    execution: 'execution',
    kind: 'runner',
    parent: null,
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  }
  const phase: TicketGrant = { ...runner, id: 'phase', kind: 'phase', parent: runner.id }
  let revoked = false
  let policyWrites = 0
  const grants: TicketGrantStore = {
    authenticate: async (token) =>
      revoked ? null : token === 'abt_runner' ? runner : token === 'abt_phase' ? phase : null,
    issue: async (_repo, _execution, _kind, parent) => {
      expect(parent).toEqual(runner)
      return { token: 'abt_phase', grant: phase }
    },
    revoke: async () => {
      revoked = true
    },
    renew: async () => {},
  }
  const source = new FakeTicketSource()
  let sourceOpens = 0
  const server = createTicketServer({
    secret: 'secret',
    clock: () => now,
    grants,
    auth: {
      authenticate: async () => {
        throw new Error('ticket grants must not use BuildStore authority')
      },
    },
    sourceFor: () => {
      sourceOpens++
      return source
    },
    policy: {
      get: async () => null,
      put: async () => {
        policyWrites++
      },
    },
  })
  const call = (
    token: string,
    operation: string,
    input: unknown,
    context = { teamKey: 'ENG', repo },
  ) =>
    server.fetch(
      new Request(`https://tickets.test/tickets/${operation}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
        },
        body: JSON.stringify({ context, input }),
      }),
    )
  for (const requestedId of ['ENG-706', 'ENG-9223372036854775807', 'foreign']) {
    const denied = await call('abt_runner', 'create', {
      draft: { title: 'Forbidden requested id', body: '' },
      options: { requestedId, idempotencyKey: 'must-not-adopt' },
    })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({
      kind: 'auth',
      error: 'only project or owner authority may request a ticket id',
    })
  }
  expect(sourceOpens).toBe(0)
  expect((await source.listReady({})).tickets).toEqual([])
  const created = await call('abt_runner', 'create', {
    draft: { title: 'Proposal', body: 'Spec' },
    options: { idempotencyKey: 'once' },
  })
  expect(created.status).toBe(201)
  const ticket = (await created.json()) as { ref: { id: string } }
  expect((await call('abt_phase', 'get', { id: ticket.ref.id })).status).toBe(200)
  expect(
    (await call('abt_phase', 'create', { draft: { title: 'Forbidden', body: 'Spec' } })).status,
  ).toBe(403)
  for (const operation of [
    'claim',
    'transition',
    'comment',
    'update',
    'mutate-if-revision',
    'add-blocker',
    'remove-blocker',
  ])
    expect((await call('abt_runner', operation, {})).status).toBe(403)
  const policy = {
    version: 1,
    tickets: {
      source: 'hosted',
      teamKey: 'ENG',
      readyState: 'ready',
      triageState: 'triage',
      claimedState: 'doing',
      doneState: 'done',
      createState: 'triage',
      proposalState: 'triage',
    },
  }
  expect((await call('abt_runner', 'policy', policy)).status).toBe(403)
  expect(policyWrites).toBe(0)
  expect(
    (
      await call(
        'abt_runner',
        'get',
        { id: ticket.ref.id },
        { teamKey: 'ENG', repo: 'https://github.com/acme/two' },
      )
    ).status,
  ).toBe(403)
  revoked = true
  expect((await call('abt_phase', 'get', { id: ticket.ref.id })).status).toBe(401)
})
