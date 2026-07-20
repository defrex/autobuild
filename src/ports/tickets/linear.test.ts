import { describe, expect, test } from 'bun:test'
import {
  LINEAR_API_URL,
  LinearTicketSource,
  type LinearFetch,
} from './linear'

interface RecordedCall {
  url: string
  headers: Record<string, string>
  query: string
  variables: Record<string, unknown>
}

/** Canned-exchange fetch: dequeues one response per request, records each. */
function fakeLinear(responses: Array<{ status?: number; body: unknown }>) {
  const calls: RecordedCall[] = []
  const fetchFn: LinearFetch = async (url, init) => {
    const parsed = JSON.parse(init.body) as {
      query: string
      variables: Record<string, unknown>
    }
    calls.push({ url, headers: init.headers, ...parsed })
    const next = responses.shift()
    if (!next) throw new Error('fakeLinear: no canned response left')
    const status = next.status ?? 200
    return { ok: status < 400, status, json: async () => next.body }
  }
  return { fetchFn, calls }
}

function makeSource(fetchFn: LinearFetch, claimedState?: string) {
  return new LinearTicketSource({
    apiKey: 'lin_api_test',
    teamKey: 'ENG',
    fetchFn,
    ...(claimedState ? { claimedState } : {}),
  })
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error(`expected an Error rejection, received ${String(error)}`)
  }
  throw new Error('expected promise to reject')
}

/** Mirrors what ISSUE_FIELDS actually selects — `state.type` and
 * `inverseRelations` included, so every canned issue looks like a real one. */
function gqlIssue(over: Record<string, unknown> = {}) {
  return {
    id: 'uuid-42',
    identifier: 'ENG-42',
    title: 'Rate-limit auth',
    description: '# Spec\n\nToken bucket on /auth/*.',
    url: 'https://linear.app/acme/issue/ENG-42',
    state: { name: 'Ready', type: 'unstarted' },
    labels: { nodes: [{ name: 'autobuild' }] },
    inverseRelations: { nodes: [] },
    ...over,
  }
}

/** A `blocks` relation as it appears on the BLOCKED issue: the relation's
 * `issue` side is the blocker. */
function blocksRelation(
  blockerIdentifier: string,
  relationId = `relation-${blockerIdentifier}`,
  blockerId = `uuid-${blockerIdentifier}`,
) {
  return {
    id: relationId,
    type: 'blocks',
    issue: { id: blockerId, identifier: blockerIdentifier },
  }
}

const TEAM_INFO_RESPONSE = {
  body: {
    data: {
      teams: {
        nodes: [
          {
            id: 'team-uuid',
            states: {
              nodes: [
                { id: 'st-ready', name: 'Ready' },
                { id: 'st-progress', name: 'In Progress' },
                { id: 'st-done', name: 'Done' },
              ],
            },
            labels: {
              nodes: [
                { id: 'lb-auto', name: 'autobuild' },
                { id: 'lb-bug', name: 'bug' },
              ],
            },
          },
        ],
      },
    },
  },
}

describe('LinearTicketSource', () => {
  test('listReady sends team + state + and-of-label filters and maps issues to Tickets', async () => {
    const { fetchFn, calls } = fakeLinear([
      { body: { data: { issues: { nodes: [gqlIssue()] } } } },
    ])
    const source = makeSource(fetchFn)

    const tickets = await source.listReady({
      labels: ['autobuild', 'bug'],
      state: 'Ready',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(LINEAR_API_URL)
    expect(calls[0]?.headers).toEqual({
      Authorization: 'lin_api_test',
      'Content-Type': 'application/json',
    })
    expect(calls[0]?.variables).toEqual({
      filter: {
        team: { key: { eq: 'ENG' } },
        state: { name: { eq: 'Ready' } },
        and: [
          { labels: { some: { name: { eq: 'autobuild' } } } },
          { labels: { some: { name: { eq: 'bug' } } } },
        ],
      },
    })
    expect(tickets).toEqual({
      tickets: [
        {
          ref: {
            source: 'linear',
            id: 'ENG-42',
            url: 'https://linear.app/acme/issue/ENG-42',
            title: 'Rate-limit auth',
          },
          title: 'Rate-limit auth',
          body: '# Spec\n\nToken bucket on /auth/*.',
          state: 'Ready',
          labels: ['autobuild'],
        },
      ],
      diagnostics: [],
    })
  })

  test('listReady with no criteria sends only the team filter', async () => {
    const { fetchFn, calls } = fakeLinear([
      { body: { data: { issues: { nodes: [] } } } },
    ])

    expect(await makeSource(fetchFn).listReady({})).toEqual({
      tickets: [],
      diagnostics: [],
    })
    expect(calls[0]?.variables).toEqual({
      filter: { team: { key: { eq: 'ENG' } } },
    })
  })

  test('get sends the identifier, maps the issue, and turns a null issue into null', async () => {
    const { fetchFn, calls } = fakeLinear([
      { body: { data: { issue: gqlIssue({ description: null, state: null }) } } },
      { body: { data: { issue: null } } },
    ])
    const source = makeSource(fetchFn)

    const found = await source.get('ENG-42')
    expect(calls[0]?.variables).toEqual({ id: 'ENG-42' })
    expect(found?.body).toBe('')
    expect(found?.state).toBeUndefined()
    expect(found?.ref.id).toBe('ENG-42')

    expect(await source.get('ENG-404')).toBeNull()
  })

  test('claim refuses when the issue already sits in the claimed state (§12)', async () => {
    const { fetchFn, calls } = fakeLinear([
      {
        body: {
          data: { issue: { id: 'uuid-42', state: { name: 'In Progress' } } },
        },
      },
    ])

    expect(await makeSource(fetchFn).claim('ENG-42')).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.variables).toEqual({ id: 'ENG-42' })
  })

  test('claim moves an unclaimed issue to the claimed state', async () => {
    const { fetchFn, calls } = fakeLinear([
      { body: { data: { issue: { id: 'uuid-42', state: { name: 'Ready' } } } } },
      TEAM_INFO_RESPONSE,
      { body: { data: { issueUpdate: { success: true } } } },
    ])

    expect(await makeSource(fetchFn).claim('ENG-42')).toBe(true)
    expect(calls).toHaveLength(3)
    expect(calls[1]?.variables).toEqual({ teamKey: 'ENG' })
    expect(calls[2]?.variables).toEqual({ id: 'uuid-42', stateId: 'st-progress' })
  })

  test('claim honors a configured claimed state name', async () => {
    const { fetchFn, calls } = fakeLinear([
      { body: { data: { issue: { id: 'uuid-42', state: { name: 'Ready' } } } } },
      TEAM_INFO_RESPONSE,
      { body: { data: { issueUpdate: { success: true } } } },
    ])

    expect(await makeSource(fetchFn, 'Done').claim('ENG-42')).toBe(true)
    expect(calls[2]?.variables).toEqual({ id: 'uuid-42', stateId: 'st-done' })
  })

  test('claim returns false for unknown issues without mutating', async () => {
    const { fetchFn, calls } = fakeLinear([{ body: { data: { issue: null } } }])

    expect(await makeSource(fetchFn).claim('ENG-404')).toBe(false)
    expect(calls).toHaveLength(1)
  })

  test('comment resolves the issue UUID then sends commentCreate', async () => {
    const { fetchFn, calls } = fakeLinear([
      { body: { data: { issue: { id: 'uuid-42' } } } },
      { body: { data: { commentCreate: { success: true } } } },
    ])

    await makeSource(fetchFn).comment('ENG-42', 'Build finished: PR #7')

    expect(calls).toHaveLength(2)
    expect(calls[0]?.variables).toEqual({ id: 'ENG-42' })
    expect(calls[1]?.variables).toEqual({
      issueId: 'uuid-42',
      body: 'Build finished: PR #7',
    })
  })

  test('the state-id cache means one team states query across two transitions', async () => {
    const { fetchFn, calls } = fakeLinear([
      { body: { data: { issue: { id: 'uuid-1' } } } },
      TEAM_INFO_RESPONSE,
      { body: { data: { issueUpdate: { success: true } } } },
      { body: { data: { issue: { id: 'uuid-2' } } } },
      { body: { data: { issueUpdate: { success: true } } } },
    ])
    const source = makeSource(fetchFn)

    await source.transition('ENG-1', 'In Progress')
    await source.transition('ENG-2', 'Done')

    expect(calls).toHaveLength(5)
    const teamQueries = calls.filter((c) => c.query.includes('states { nodes'))
    expect(teamQueries).toHaveLength(1)
    expect(calls[2]?.variables).toEqual({ id: 'uuid-1', stateId: 'st-progress' })
    expect(calls[4]?.variables).toEqual({ id: 'uuid-2', stateId: 'st-done' })
  })

  test('the issue-UUID cache means claim then comment resolves the issue once', async () => {
    const { fetchFn, calls } = fakeLinear([
      { body: { data: { issue: { id: 'uuid-42', state: { name: 'Ready' } } } } },
      TEAM_INFO_RESPONSE,
      { body: { data: { issueUpdate: { success: true } } } },
      { body: { data: { commentCreate: { success: true } } } },
    ])
    const source = makeSource(fetchFn)

    await source.claim('ENG-42')
    await source.comment('ENG-42', 'claimed')

    expect(calls).toHaveLength(4)
    expect(calls[3]?.variables).toEqual({ issueId: 'uuid-42', body: 'claimed' })
  })

  test('transition to a state name the team lacks throws with the known states', async () => {
    const { fetchFn } = fakeLinear([
      { body: { data: { issue: { id: 'uuid-1' } } } },
      TEAM_INFO_RESPONSE,
    ])

    await expect(
      makeSource(fetchFn).transition('ENG-1', 'Shipped'),
    ).rejects.toThrow(/Shipped.*Ready, In Progress, Done/)
  })

  test('create resolves team and label ids by name and maps the created issue', async () => {
    const { fetchFn, calls } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          data: { issueCreate: { success: true, issue: gqlIssue() } },
        },
      },
    ])

    const created = await makeSource(fetchFn).create({
      title: 'Rate-limit auth',
      body: '# Spec\n\nToken bucket on /auth/*.',
      labels: ['autobuild'],
    })

    expect(calls).toHaveLength(2)
    expect(calls[0]?.variables).toEqual({ teamKey: 'ENG' })
    expect(calls[1]?.variables).toEqual({
      input: {
        teamId: 'team-uuid',
        title: 'Rate-limit auth',
        description: '# Spec\n\nToken bucket on /auth/*.',
        labelIds: ['lb-auto'],
      },
    })
    expect(created.ref.id).toBe('ENG-42')
    expect(created.labels).toEqual(['autobuild'])
  })

  test('create with createState resolves the state id and files the issue there', async () => {
    const { fetchFn, calls } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          data: { issueCreate: { success: true, issue: gqlIssue() } },
        },
      },
    ])
    const source = new LinearTicketSource({
      apiKey: 'lin_api_test',
      teamKey: 'ENG',
      fetchFn,
      createState: 'Ready',
    })

    await source.create({ title: 'X', body: 'y' })

    expect(calls[1]?.variables).toEqual({
      input: {
        teamId: 'team-uuid',
        title: 'X',
        description: 'y',
        labelIds: [],
        stateId: 'st-ready',
      },
    })
  })

  test('per-create state and idempotency key override adapter defaults', async () => {
    const { fetchFn, calls } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          data: { issueCreate: { success: true, issue: gqlIssue() } },
        },
      },
    ])
    const source = new LinearTicketSource({
      apiKey: 'lin_api_test',
      teamKey: 'ENG',
      fetchFn,
      createState: 'Ready',
    })
    const reservedId = crypto.randomUUID()
    await source.create(
      { title: 'X', body: 'y' },
      { state: 'Done', idempotencyKey: reservedId },
    )
    const input = (calls[1]?.variables as { input: Record<string, unknown> }).input
    expect(input['stateId']).toBe('st-done')
    expect(input['id']).toBe(reservedId)
  })

  test('a duplicate idempotent create adopts the exact reserved issue id', async () => {
    const { fetchFn, calls } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          errors: [
            {
              message: 'Issue id already exists',
              extensions: { code: 'INPUT_ERROR' },
            },
          ],
        },
      },
      { body: { data: { issue: gqlIssue({ identifier: 'ENG-88' }) } } },
    ])
    const reservedId = crypto.randomUUID()
    const adopted = await makeSource(fetchFn).create(
      { title: 'X', body: 'y' },
      { idempotencyKey: reservedId },
    )
    expect(adopted.ref.id).toBe('ENG-88')
    expect(calls[1]?.variables).toMatchObject({
      input: { id: reservedId },
    })
    expect(calls[2]?.variables).toEqual({ id: reservedId })
  })

  test('an unsuccessful idempotent mutation also adopts the exact reserved id', async () => {
    const { fetchFn, calls } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          data: { issueCreate: { success: false, issue: null } },
        },
      },
      { body: { data: { issue: gqlIssue({ identifier: 'ENG-89' }) } } },
    ])
    const reservedId = crypto.randomUUID()

    expect(
      (
        await makeSource(fetchFn).create(
          { title: 'X', body: 'y' },
          { idempotencyKey: reservedId },
        )
      ).ref.id,
    ).toBe('ENG-89')
    expect(calls[2]?.variables).toEqual({ id: reservedId })
  })

  test('invalid and non-v4 idempotency keys fail before issuing a Linear request', async () => {
    const { fetchFn, calls } = fakeLinear([])

    for (const idempotencyKey of [
      'not-a-uuid',
      Bun.randomUUIDv5('cluster-retry', 'dns'),
    ]) {
      await expect(
        makeSource(fetchFn).create(
          { title: 'X', body: 'y' },
          { idempotencyKey },
        ),
      ).rejects.toThrow(
        'linear create: idempotency key must be a UUID v4',
      )
    }
    expect(calls).toHaveLength(0)
  })

  test('create without createState sends no stateId — the team default applies', async () => {
    const { fetchFn, calls } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          data: { issueCreate: { success: true, issue: gqlIssue() } },
        },
      },
    ])

    await makeSource(fetchFn).create({ title: 'X', body: 'y' })

    const input = (calls[1]?.variables as { input: Record<string, unknown> }).input
    expect(input['stateId']).toBeUndefined()
    expect(input['id']).toBeUndefined()
  })

  test('create with a createState the team lacks throws with the known states', async () => {
    const { fetchFn, calls } = fakeLinear([TEAM_INFO_RESPONSE])
    const source = new LinearTicketSource({
      apiKey: 'lin_api_test',
      teamKey: 'ENG',
      fetchFn,
      createState: 'Icebox',
    })

    await expect(source.create({ title: 'X', body: 'y' })).rejects.toThrow(
      /no workflow state "Icebox".*Ready, In Progress, Done/,
    )
    expect(calls).toHaveLength(1) // resolved team info, mutated nothing
  })

  test('create with an unknown label name throws before mutating', async () => {
    const { fetchFn, calls } = fakeLinear([TEAM_INFO_RESPONSE])

    await expect(
      makeSource(fetchFn).create({ title: 'X', body: 'y', labels: ['urgent'] }),
    ).rejects.toThrow('no label "urgent"')
    expect(calls).toHaveLength(1)
  })

  test('an HTTP error throws with status and operation context', async () => {
    const { fetchFn } = fakeLinear([{ status: 500, body: {} }])

    await expect(makeSource(fetchFn).get('ENG-42')).rejects.toThrow(
      'linear get: HTTP 500',
    )
  })

  test('a GraphQL errors array throws with the messages and operation context', async () => {
    const { fetchFn } = fakeLinear([
      { body: { errors: [{ message: 'rate limited' }, { message: 'try later' }] } },
    ])

    await expect(makeSource(fetchFn).listReady({})).rejects.toThrow(
      'linear listReady: GraphQL errors — rate limited; try later',
    )
  })

  test('comment on an unknown issue throws naming the ticket', async () => {
    const { fetchFn } = fakeLinear([{ body: { data: { issue: null } } }])

    await expect(makeSource(fetchFn).comment('ENG-404', 'hi')).rejects.toThrow(
      'unknown ticket "ENG-404"',
    )
  })

  // ── Dependencies (§13) ─────────────────────────────────────────────────────

  test('toTicket maps inverse blocks-relations to blockedBy, ignoring other types', async () => {
    const { fetchFn } = fakeLinear([
      {
        body: {
          data: {
            issue: gqlIssue({
              inverseRelations: {
                nodes: [
                  blocksRelation('ENG-8'),
                  { type: 'related', issue: { identifier: 'ENG-77' } },
                  { type: 'duplicate', issue: { identifier: 'ENG-78' } },
                  blocksRelation('ENG-9'),
                ],
              },
            }),
          },
        },
      },
    ])

    const ticket = await makeSource(fetchFn).get('ENG-42')

    expect(ticket?.blockedBy).toEqual(['ENG-8', 'ENG-9'])
  })

  test('an issue with no relations reports no blockedBy at all', async () => {
    const { fetchFn } = fakeLinear([{ body: { data: { issue: gqlIssue() } } }])

    const ticket = await makeSource(fetchFn).get('ENG-42')

    expect(ticket?.blockedBy).toBeUndefined()
  })

  /**
   * The direction guard. Linear's `blocks` relation reads "issueId blocks
   * relatedIssueId", so recording "the new issue is blocked by ENG-8" means
   * issueId = ENG-8's uuid and relatedIssueId = the NEW issue's uuid.
   * Transposing these records the exact inverse relationship — and no other
   * test in this file would notice.
   */
  test('create with blockedBy sends Linear\'s bare blocks enum with the BLOCKER as issueId', async () => {
    const { fetchFn, calls } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          data: {
            issueCreate: { success: true, issue: gqlIssue({ id: 'uuid-new' }) },
          },
        },
      },
      { body: { data: { issue: { id: 'uuid-blocker-8' } } } }, // resolve ENG-8
      { body: { data: { issueRelationCreate: { success: true } } } },
    ])

    const created = await makeSource(fetchFn).create({
      title: 'X',
      body: 'y',
      blockedBy: ['ENG-8'],
    })

    expect(calls).toHaveLength(4)
    expect(calls[2]?.variables).toEqual({ id: 'ENG-8' })
    expect(calls[3]?.query).toContain('issueRelationCreate')
    expect(calls[3]?.query).toContain('type: blocks')
    expect(calls[3]?.query).not.toContain('type: "blocks"')
    expect(calls[3]?.variables).toEqual({
      issueId: 'uuid-blocker-8', // the blocker blocks…
      relatedIssueId: 'uuid-new', // …the newly created issue
    })
    expect(created.blockedBy).toEqual(['ENG-8'])
  })

  test('create with several blockers records correctly shaped relations in order', async () => {
    const { fetchFn, calls } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          data: {
            issueCreate: { success: true, issue: gqlIssue({ id: 'uuid-new' }) },
          },
        },
      },
      { body: { data: { issue: { id: 'uuid-8' } } } },
      { body: { data: { issueRelationCreate: { success: true } } } },
      { body: { data: { issue: { id: 'uuid-9' } } } },
      { body: { data: { issueRelationCreate: { success: true } } } },
    ])

    const created = await makeSource(fetchFn).create({
      title: 'X',
      body: 'y',
      blockedBy: ['ENG-8', 'ENG-9'],
    })

    const relationCalls = calls.filter((call) =>
      call.query.includes('issueRelationCreate'),
    )
    expect(relationCalls.map((call) => call.variables)).toEqual([
      { issueId: 'uuid-8', relatedIssueId: 'uuid-new' },
      { issueId: 'uuid-9', relatedIssueId: 'uuid-new' },
    ])
    expect(
      relationCalls.every(
        (call) =>
          call.query.includes('type: blocks') &&
          !call.query.includes('type: "blocks"'),
      ),
    ).toBe(true)
    expect(created.blockedBy).toEqual(['ENG-8', 'ENG-9'])
  })

  test('a success: false relation reports the ticket that already exists', async () => {
    const { fetchFn } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          data: {
            issueCreate: { success: true, issue: gqlIssue({ id: 'uuid-new' }) },
          },
        },
      },
      { body: { data: { issue: { id: 'uuid-8' } } } },
      { body: { data: { issueRelationCreate: { success: false } } } },
    ])

    const error = await rejectionOf(
      makeSource(fetchFn).create({ title: 'X', body: 'y', blockedBy: ['ENG-8'] }),
    )

    expect(error.message).toContain('ticket "ENG-42" was created')
    expect(error.message).toContain('https://linear.app/acme/issue/ENG-42')
    expect(error.message).toContain('its blockers were not all recorded')
    expect(error.message).toContain('Blockers recorded: none')
    expect(error.message).toContain('Blockers not recorded: "ENG-8"')
    expect(error.message).toContain('Do not rerun ticket creation')
    expect(error.message).toContain('repair the blockers on the existing ticket')
    expect(error.message).toContain('issueRelationCreate failed')
    expect((error.cause as Error).message).toContain('issueRelationCreate failed')
  })

  test('a relation HTTP failure retains its cause inside partial-create guidance', async () => {
    const { fetchFn } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          data: {
            issueCreate: { success: true, issue: gqlIssue({ id: 'uuid-new' }) },
          },
        },
      },
      { body: { data: { issue: { id: 'uuid-8' } } } },
      { status: 400, body: {} },
    ])

    const error = await rejectionOf(
      makeSource(fetchFn).create({ title: 'X', body: 'y', blockedBy: ['ENG-8'] }),
    )

    expect(error.message).toContain('ticket "ENG-42" was created')
    expect(error.message).toContain('https://linear.app/acme/issue/ENG-42')
    expect(error.message).toContain('Blockers not recorded: "ENG-8"')
    expect(error.message).toContain('Underlying failure: linear create: HTTP 400')
    expect((error.cause as Error).message).toBe('linear create: HTTP 400')
  })

  test('a later relation failure distinguishes recorded from unrecorded blockers', async () => {
    const { fetchFn, calls } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          data: {
            issueCreate: { success: true, issue: gqlIssue({ id: 'uuid-new' }) },
          },
        },
      },
      { body: { data: { issue: { id: 'uuid-8' } } } },
      { body: { data: { issueRelationCreate: { success: true } } } },
      { body: { data: { issue: { id: 'uuid-9' } } } },
      { body: { errors: [{ message: 'relation denied' }] } },
    ])

    const error = await rejectionOf(
      makeSource(fetchFn).create({
        title: 'X',
        body: 'y',
        blockedBy: ['ENG-8', 'ENG-9', 'ENG-10'],
      }),
    )

    expect(calls).toHaveLength(6) // stop on ENG-9; ENG-10 was never attempted
    expect(error.message).toContain('Blockers recorded: "ENG-8"')
    expect(error.message).toContain('Blockers not recorded: "ENG-9", "ENG-10"')
    expect(error.message).toContain('relation denied')
  })

  test('a missing created UUID still reports the created ticket and every blocker', async () => {
    const { fetchFn, calls } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          data: {
            issueCreate: { success: true, issue: gqlIssue({ id: undefined }) },
          },
        },
      },
    ])

    const error = await rejectionOf(
      makeSource(fetchFn).create({
        title: 'X',
        body: 'y',
        blockedBy: ['ENG-8', 'ENG-9'],
      }),
    )

    expect(calls).toHaveLength(2)
    expect(error.message).toContain('ticket "ENG-42" was created')
    expect(error.message).toContain('Blockers recorded: none')
    expect(error.message).toContain('Blockers not recorded: "ENG-8", "ENG-9"')
    expect(error.message).toContain('issueCreate returned no id')
  })

  test('a blocker resolution failure reports the ticket created before it failed', async () => {
    const { fetchFn } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          data: {
            issueCreate: { success: true, issue: gqlIssue({ id: 'uuid-new' }) },
          },
        },
      },
      { body: { data: { issue: null } } },
    ])

    const error = await rejectionOf(
      makeSource(fetchFn).create({
        title: 'X',
        body: 'y',
        blockedBy: ['ENG-404'],
      }),
    )

    expect(error.message).toContain('ticket "ENG-42" was created')
    expect(error.message).toContain('Blockers not recorded: "ENG-404"')
    expect(error.message).toContain('unknown ticket "ENG-404"')
  })

  test('dependencyStates maps Linear state types to resolution, failing closed', async () => {
    const types: Array<[string, boolean]> = [
      ['completed', true],
      ['canceled', true],
      ['started', false],
      ['unstarted', false],
      ['backlog', false],
      ['someFutureType', false], // unrecognized fails CLOSED
    ]
    const { fetchFn } = fakeLinear(
      types.map(([type]) => ({
        body: { data: { issue: gqlIssue({ state: { name: type, type } }) } },
      })),
    )

    const states = await makeSource(fetchFn).dependencyStates(
      types.map(([type]) => type),
    )

    expect(states.map((s) => [s.id, s.resolved])).toEqual(
      types.map(([type, resolved]) => [type, resolved]),
    )
    expect(states.every((s) => s.exists)).toBe(true)
  })

  /**
   * The shape below is copied from a LIVE Linear response, not guessed: an
   * unknown identifier comes back HTTP 200 with a GraphQL `errors` array
   * (`Entity not found: Issue`, extensions.code INPUT_ERROR) and `data: null`
   * — NOT the `{issue: null}` the query's shape implies. Before checking
   * against the real API, this adapter turned a typo'd blocker into a thrown
   * dependency check instead of an actionable "does not exist" diagnostic.
   */
  const ENTITY_NOT_FOUND = {
    body: {
      data: null,
      errors: [
        {
          message: 'Entity not found: Issue',
          path: ['issue'],
          extensions: {
            type: 'invalid input',
            code: 'INPUT_ERROR',
            userPresentableMessage: 'Could not find referenced Issue.',
          },
        },
      ],
    },
  }

  test('get maps the live "Entity not found" response to null', async () => {
    const { fetchFn } = fakeLinear([ENTITY_NOT_FOUND])

    expect(await makeSource(fetchFn).get('AUT-99999')).toBeNull()
  })

  test('get does not hide a mixed not-found and provider failure', async () => {
    const { fetchFn } = fakeLinear([
      {
        body: {
          data: null,
          errors: [
            ...ENTITY_NOT_FOUND.body.errors,
            { message: 'rate limited', extensions: { code: 'RATELIMITED' } },
          ],
        },
      },
    ])

    await expect(makeSource(fetchFn).get('AUT-99999')).rejects.toThrow(
      'rate limited',
    )
  })

  test('dependencyStates maps a live "Entity not found" error to exists: false', async () => {
    const { fetchFn } = fakeLinear([ENTITY_NOT_FOUND])

    expect(await makeSource(fetchFn).dependencyStates(['AUT-99999'])).toEqual([
      { id: 'AUT-99999', exists: false, resolved: false, blockedBy: [] },
    ])
  })

  test('a not-found for one blocker does not stop the rest from resolving', async () => {
    const { fetchFn } = fakeLinear([
      ENTITY_NOT_FOUND,
      {
        body: {
          data: { issue: gqlIssue({ state: { name: 'Done', type: 'completed' } }) },
        },
      },
    ])

    const states = await makeSource(fetchFn).dependencyStates(['AUT-99999', 'ENG-42'])

    expect(states.map((s) => [s.id, s.exists, s.resolved])).toEqual([
      ['AUT-99999', false, false],
      ['ENG-42', true, true],
    ])
  })

  /** The discrimination that matters: a real outage must NOT read as "the
   * ticket does not exist" — that would dispatch on a false diagnostic. */
  test('dependencyStates rethrows a non-not-found GraphQL error rather than reporting absence', async () => {
    const { fetchFn } = fakeLinear([
      {
        body: {
          errors: [
            { message: 'rate limited', extensions: { code: 'RATELIMITED' } },
          ],
        },
      },
    ])

    await expect(makeSource(fetchFn).dependencyStates(['ENG-42'])).rejects.toThrow(
      'rate limited',
    )
  })

  test('a mixed error set (not-found + rate limit) is a failure, not an absence', async () => {
    const { fetchFn } = fakeLinear([
      {
        body: {
          errors: [
            {
              message: 'Entity not found: Issue',
              extensions: { code: 'INPUT_ERROR' },
            },
            { message: 'rate limited', extensions: { code: 'RATELIMITED' } },
          ],
        },
      },
    ])

    await expect(makeSource(fetchFn).dependencyStates(['ENG-42'])).rejects.toThrow(
      'rate limited',
    )
  })

  test('an unknown blocker on create keeps adapter prose inside created-ticket context', async () => {
    const { fetchFn } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          data: {
            issueCreate: { success: true, issue: gqlIssue({ id: 'uuid-new' }) },
          },
        },
      },
      ENTITY_NOT_FOUND,
    ])

    const error = await rejectionOf(
      makeSource(fetchFn).create({
        title: 'X',
        body: 'y',
        blockedBy: ['ENG-404'],
      }),
    )

    expect(error.message).toContain('ticket "ENG-42" was created')
    expect(error.message).toContain('linear create: unknown ticket "ENG-404"')
    expect(error.message).not.toContain('Entity not found: Issue')
  })

  test('dependencyStates reports a missing issue as exists: false, in request order', async () => {
    const { fetchFn } = fakeLinear([
      { body: { data: { issue: null } } },
      {
        body: {
          data: {
            issue: gqlIssue({
              state: { name: 'Done', type: 'completed' },
              inverseRelations: { nodes: [blocksRelation('ENG-1')] },
            }),
          },
        },
      },
    ])

    const states = await makeSource(fetchFn).dependencyStates(['ENG-404', 'ENG-42'])

    expect(states).toEqual([
      { id: 'ENG-404', exists: false, resolved: false, blockedBy: [] },
      { id: 'ENG-42', exists: true, resolved: true, blockedBy: ['ENG-1'] },
    ])
  })

  test('dependencyStates re-reads every call — a completion between ticks is seen', async () => {
    const { fetchFn } = fakeLinear([
      {
        body: {
          data: { issue: gqlIssue({ state: { name: 'Ready', type: 'unstarted' } }) },
        },
      },
      {
        body: {
          data: { issue: gqlIssue({ state: { name: 'Done', type: 'completed' } }) },
        },
      },
    ])
    const source = makeSource(fetchFn)

    expect((await source.dependencyStates(['ENG-42']))[0]?.resolved).toBe(false)
    expect((await source.dependencyStates(['ENG-42']))[0]?.resolved).toBe(true)
  })

  // ── Post-create grooming writes ───────────────────────────────────────────

  test('every full issue selection explicitly requests 250 inverse relations and relation ids', async () => {
    const { fetchFn, calls } = fakeLinear([
      { body: { data: { issue: gqlIssue() } } },
    ])

    await makeSource(fetchFn).get('ENG-42')

    expect(calls[0]?.query).toContain('inverseRelations(first: 250)')
    expect(calls[0]?.query).toContain('nodes { id type issue { id identifier } }')
  })

  test('update maps a missing target to an id-specific error before mutation', async () => {
    const { fetchFn, calls } = fakeLinear([ENTITY_NOT_FOUND])

    await expect(
      makeSource(fetchFn).update('ENG-404', { title: 'Renamed' }),
    ).rejects.toThrow('unknown ticket "ENG-404"')
    expect(calls).toHaveLength(1)
  })

  test('update sends one exact partial IssueUpdateInput and never state or assignee', async () => {
    const { fetchFn, calls } = fakeLinear([
      { body: { data: { issue: { id: 'uuid-42' } } } },
      TEAM_INFO_RESPONSE,
      { body: { data: { issueUpdate: { success: true } } } },
    ])

    await makeSource(fetchFn).update('ENG-42', {
      title: 'Renamed',
      body: '# Replacement spec',
      labels: ['bug'],
    })

    expect(calls).toHaveLength(3)
    expect(calls[2]?.query).toContain('$input: IssueUpdateInput!')
    expect(calls[2]?.variables).toEqual({
      id: 'uuid-42',
      input: {
        title: 'Renamed',
        description: '# Replacement spec',
        labelIds: ['lb-bug'],
      },
    })
    expect(JSON.stringify(calls[2]?.variables)).not.toContain('stateId')
    expect(JSON.stringify(calls[2]?.variables)).not.toContain('assignee')
  })

  test('a body-only update does not query team metadata or send unnamed fields', async () => {
    const { fetchFn, calls } = fakeLinear([
      { body: { data: { issue: { id: 'uuid-42' } } } },
      { body: { data: { issueUpdate: { success: true } } } },
    ])

    await makeSource(fetchFn).update('ENG-42', { body: 'New body' })

    expect(calls).toHaveLength(2)
    expect(calls[1]?.variables).toEqual({
      id: 'uuid-42',
      input: { description: 'New body' },
    })
  })

  test('an explicit empty label replacement clears without a team lookup', async () => {
    const { fetchFn, calls } = fakeLinear([
      { body: { data: { issue: { id: 'uuid-42' } } } },
      { body: { data: { issueUpdate: { success: true } } } },
    ])

    await makeSource(fetchFn).update('ENG-42', { labels: [] })

    expect(calls).toHaveLength(2)
    expect(calls[1]?.variables).toEqual({
      id: 'uuid-42',
      input: { labelIds: [] },
    })
  })

  test('update validates label names before the mutation', async () => {
    const { fetchFn, calls } = fakeLinear([
      { body: { data: { issue: { id: 'uuid-42' } } } },
      TEAM_INFO_RESPONSE,
    ])

    await expect(
      makeSource(fetchFn).update('ENG-42', { labels: ['urgent'] }),
    ).rejects.toThrow('no label "urgent"')
    expect(calls).toHaveLength(2)
    expect(calls.some((call) => call.query.includes('mutation UpdateIssue'))).toBe(
      false,
    )
  })

  test('addBlocker creates a native blocks relation in the correct direction', async () => {
    const { fetchFn, calls } = fakeLinear([
      {
        body: {
          data: { issue: gqlIssue({ id: 'uuid-target', identifier: 'ENG-42' }) },
        },
      },
      { body: { data: { issue: { id: 'uuid-blocker' } } } },
      { body: { data: { issueRelationCreate: { success: true } } } },
    ])

    await makeSource(fetchFn).addBlocker('ENG-42', 'ENG-8')

    expect(calls).toHaveLength(3)
    expect(calls[0]?.query).toContain('inverseRelations(first: 250)')
    expect(calls[2]?.query).toContain('type: blocks')
    expect(calls[2]?.variables).toEqual({
      issueId: 'uuid-blocker',
      relatedIssueId: 'uuid-target',
    })
  })

  test('addBlocker retries return without resolving or recreating an existing relation', async () => {
    const { fetchFn, calls } = fakeLinear([
      {
        body: {
          data: {
            issue: gqlIssue({
              id: 'uuid-target',
              inverseRelations: {
                nodes: [blocksRelation('ENG-8', 'relation-8', 'uuid-blocker')],
              },
            }),
          },
        },
      },
    ])

    await makeSource(fetchFn).addBlocker('ENG-42', 'ENG-8')

    expect(calls).toHaveLength(1)
    expect(calls.some((call) => call.query.includes('issueRelationCreate'))).toBe(
      false,
    )
  })

  test('addBlocker maps a missing blocker to an id-specific error before mutation', async () => {
    const { fetchFn, calls } = fakeLinear([
      { body: { data: { issue: gqlIssue({ id: 'uuid-target' }) } } },
      ENTITY_NOT_FOUND,
    ])

    await expect(
      makeSource(fetchFn).addBlocker('ENG-42', 'ENG-404'),
    ).rejects.toThrow('unknown ticket "ENG-404"')
    expect(calls).toHaveLength(2)
    expect(calls.some((call) => call.query.includes('issueRelationCreate'))).toBe(
      false,
    )
  })

  test('addBlocker rejects direct and UUID-alias self-blocks', async () => {
    const direct = fakeLinear([
      { body: { data: { issue: gqlIssue({ id: 'uuid-target' }) } } },
    ])
    await expect(
      makeSource(direct.fetchFn).addBlocker('ENG-42', 'ENG-42'),
    ).rejects.toThrow('ENG-42')
    expect(direct.calls).toHaveLength(1)

    const alias = fakeLinear([
      { body: { data: { issue: gqlIssue({ id: 'uuid-target' }) } } },
      { body: { data: { issue: { id: 'uuid-target' } } } },
    ])
    await expect(
      makeSource(alias.fetchFn).addBlocker('ENG-42', 'alias-for-42'),
    ).rejects.toThrow('ENG-42')
    expect(alias.calls).toHaveLength(2)
  })

  test('removeBlocker deletes every matching native relation id', async () => {
    const { fetchFn, calls } = fakeLinear([
      {
        body: {
          data: {
            issue: gqlIssue({
              id: 'uuid-target',
              inverseRelations: {
                nodes: [
                  blocksRelation('ENG-8', 'relation-a', 'uuid-blocker'),
                  blocksRelation('ENG-8', 'relation-b', 'uuid-blocker'),
                  blocksRelation('ENG-9', 'relation-c', 'uuid-other'),
                ],
              },
            }),
          },
        },
      },
      { body: { data: { issueRelationDelete: { success: true } } } },
      { body: { data: { issueRelationDelete: { success: true } } } },
    ])

    await makeSource(fetchFn).removeBlocker('ENG-42', 'ENG-8')

    expect(calls.slice(1).map((call) => call.variables)).toEqual([
      { id: 'relation-a' },
      { id: 'relation-b' },
    ])
    expect(
      calls.slice(1).every((call) => call.query.includes('issueRelationDelete')),
    ).toBe(true)
  })

  test('removeBlocker is a no-op when the relation or blocker issue is absent', async () => {
    const { fetchFn, calls } = fakeLinear([
      { body: { data: { issue: gqlIssue({ id: 'uuid-target' }) } } },
    ])

    await makeSource(fetchFn).removeBlocker('ENG-42', 'ENG-404')

    expect(calls).toHaveLength(1)
  })

  test('new writes map an unknown target to operation-specific errors', async () => {
    for (const operation of ['add', 'remove'] as const) {
      const { fetchFn, calls } = fakeLinear([ENTITY_NOT_FOUND])
      const source = makeSource(fetchFn)
      const promise =
        operation === 'add'
          ? source.addBlocker('ENG-404', 'ENG-8')
          : source.removeBlocker('ENG-404', 'ENG-8')
      await expect(promise).rejects.toThrow('unknown ticket "ENG-404"')
      expect(calls).toHaveLength(1)
    }
  })
})
