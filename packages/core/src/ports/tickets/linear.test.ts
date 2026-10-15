import { describe, expect, test } from 'bun:test'
import { TicketSourceRateLimitError } from '../types'
import { LINEAR_API_URL, LinearTicketSource, type LinearFetch } from './linear'

interface RecordedCall {
  url: string
  headers: Record<string, string>
  query: string
  variables: Record<string, unknown>
}

/** Canned-exchange fetch: dequeues one response per request, records each. */
function fakeLinear(
  responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>,
) {
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
    return {
      ok: status < 400,
      status,
      headers: new Headers(next.headers),
      json: async () => next.body,
    }
  }
  return { fetchFn, calls }
}

function connection<T>(nodes: T[], hasNextPage = false, endCursor: string | null = null) {
  return { nodes, pageInfo: { hasNextPage, endCursor } }
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
    inverseRelations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
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
  test('exposes exact workflow state names in provider order and caches team metadata', async () => {
    const { fetchFn, calls } = fakeLinear([TEAM_INFO_RESPONSE])
    const source = makeSource(fetchFn)
    expect(await source.workflowStateNames()).toEqual(['Ready', 'In Progress', 'Done'])
    expect(await source.workflowStateNames()).toEqual(['Ready', 'In Progress', 'Done'])
    expect(calls).toHaveLength(1)
  })

  test('listReady adds an isMe assignee predicate for "me", conjunctive with state and labels', async () => {
    const { fetchFn, calls } = fakeLinear([
      {
        body: {
          data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        },
      },
    ])
    await makeSource(fetchFn).listReady({
      labels: ['autobuild', 'bug'],
      state: 'Ready',
      assignee: 'me',
    })
    expect(calls[0]?.variables).toEqual({
      first: 10,
      after: null,
      filter: {
        team: { key: { eq: 'ENG' } },
        state: { name: { eq: 'Ready' } },
        assignee: { isMe: { eq: true } },
        and: [
          { labels: { some: { name: { eq: 'autobuild' } } } },
          { labels: { some: { name: { eq: 'bug' } } } },
        ],
      },
    })
  })

  test('listReady filters by assignee email and omits the predicate when absent', async () => {
    const { fetchFn, calls } = fakeLinear([
      {
        body: {
          data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        },
      },
      {
        body: {
          data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        },
      },
    ])
    const source = makeSource(fetchFn)
    await source.listReady({ state: 'Ready', assignee: 'p@example.com' })
    await source.listReady({ state: 'Ready' })
    expect(calls[0]?.variables).toEqual({
      first: 10,
      after: null,
      filter: {
        team: { key: { eq: 'ENG' } },
        state: { name: { eq: 'Ready' } },
        assignee: { email: { eq: 'p@example.com' } },
      },
    })
    expect(calls[1]?.variables).toEqual({
      first: 10,
      after: null,
      filter: { team: { key: { eq: 'ENG' } }, state: { name: { eq: 'Ready' } } },
    })
  })

  test('resolveAssignee resolves me through the viewer and an email through users', async () => {
    const user = { id: 'u1', name: 'Pat', email: 'p@example.com' }
    const { fetchFn, calls } = fakeLinear([
      { body: { data: { viewer: user } } },
      { body: { data: { users: { nodes: [user] } } } },
      { body: { data: { users: { nodes: [] } } } },
    ])
    const source = makeSource(fetchFn)
    expect(await source.resolveAssignee('me')).toEqual(user)
    expect(await source.resolveAssignee('p@example.com')).toEqual(user)
    expect(calls[1]?.variables).toEqual({ email: 'p@example.com' })
    expect(await source.resolveAssignee('nobody@example.com')).toBeNull()
  })

  test('listReady sends team + state + and-of-label filters and maps issues to Tickets', async () => {
    const { fetchFn, calls } = fakeLinear([
      {
        body: {
          data: {
            issues: { nodes: [gqlIssue()], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
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
      first: 10,
      after: null,
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
          creationKey: 'uuid-42',
          title: 'Rate-limit auth',
          body: '# Spec\n\nToken bucket on /auth/*.',
          state: 'Ready',
          resolved: false,
          blockersResolved: true,
          labels: ['autobuild'],
        },
      ],
      diagnostics: [],
    })
  })

  test('listReady with no criteria sends only the team filter', async () => {
    const { fetchFn, calls } = fakeLinear([
      {
        body: {
          data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        },
      },
    ])

    expect(await makeSource(fetchFn).listReady({})).toEqual({
      tickets: [],
      diagnostics: [],
    })
    expect(calls[0]?.variables).toEqual({
      first: 10,
      after: null,
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
          data: {
            issue: { id: 'uuid-42', state: { name: 'In Progress', type: 'started' } },
          },
        },
      },
    ])

    expect(await makeSource(fetchFn).claim('ENG-42')).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.variables).toEqual({ id: 'ENG-42' })
    expect(calls[0]?.query).toContain('state { name type }')
  })

  test('claim refuses completed and canceled issues without issuing a mutation', async () => {
    const { fetchFn, calls } = fakeLinear([
      {
        body: {
          data: { issue: { id: 'uuid-done', state: { name: 'Done', type: 'completed' } } },
        },
      },
      {
        body: {
          data: {
            issue: { id: 'uuid-canceled', state: { name: 'Canceled', type: 'canceled' } },
          },
        },
      },
    ])
    const source = makeSource(fetchFn)

    expect(await source.claim('ENG-42')).toBe(false)
    expect(await source.claim('ENG-43')).toBe(false)
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => call.query.includes('state { name type }'))).toBe(true)
    expect(calls.some((call) => call.query.includes('mutation'))).toBe(false)
  })

  test('claim moves an unclaimed issue to the claimed state', async () => {
    const { fetchFn, calls } = fakeLinear([
      {
        body: {
          data: { issue: { id: 'uuid-42', state: { name: 'Ready', type: 'unstarted' } } },
        },
      },
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
      {
        body: {
          data: { issue: { id: 'uuid-42', state: { name: 'Ready', type: 'unstarted' } } },
        },
      },
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
      {
        body: {
          data: { issue: { id: 'uuid-42', state: { name: 'Ready', type: 'unstarted' } } },
        },
      },
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

    await expect(makeSource(fetchFn).transition('ENG-1', 'Shipped')).rejects.toThrow(
      /Shipped.*Ready, In Progress, Done/,
    )
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
    await source.create({ title: 'X', body: 'y' }, { state: 'Done', idempotencyKey: reservedId })
    const input = (calls[1]!.variables as { input: Record<string, unknown> }).input
    expect(input.stateId).toBe('st-done')
    expect(input.id).toBe(reservedId)
  })

  test('a duplicate idempotent create adopts the exact reserved issue id', async () => {
    const reservedId = crypto.randomUUID()
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
      { body: { data: { issue: gqlIssue({ id: reservedId, identifier: 'ENG-88' }) } } },
    ])
    const adopted = await makeSource(fetchFn).create(
      { title: 'X', body: 'y' },
      { idempotencyKey: reservedId },
    )
    expect(adopted.ref.id).toBe('ENG-88')
    expect(adopted.creationKey).toBe(reservedId)
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
      (await makeSource(fetchFn).create({ title: 'X', body: 'y' }, { idempotencyKey: reservedId }))
        .ref.id,
    ).toBe('ENG-89')
    expect(calls[2]?.variables).toEqual({ id: reservedId })
  })

  test('idempotent adoption reconciles one missing blocker from duplicate draft ids', async () => {
    const { fetchFn, calls } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          errors: [{ message: 'Issue id already exists', extensions: { code: 'INPUT_ERROR' } }],
        },
      },
      {
        body: {
          data: { issue: gqlIssue({ id: 'uuid-new', identifier: 'ENG-88' }) },
        },
      },
      { body: { data: { issue: { id: 'uuid-blocker' } } } },
      { body: { data: { issueRelationCreate: { success: true } } } },
    ])
    const reservedId = crypto.randomUUID()

    const adopted = await makeSource(fetchFn).create(
      { title: 'X', body: 'y', blockedBy: ['ENG-8', 'ENG-8'] },
      { idempotencyKey: reservedId },
    )

    expect(adopted.blockedBy).toEqual(['ENG-8'])
    const relations = calls.filter((call) => call.query.includes('issueRelationCreate'))
    expect(relations).toHaveLength(1)
    expect(relations[0]?.variables).toEqual({
      issueId: 'uuid-blocker',
      relatedIssueId: 'uuid-new',
    })
  })

  test('idempotent adoption skips a recorded blocker and creates only the missing relation', async () => {
    const { fetchFn, calls } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          errors: [{ message: 'Issue id already exists', extensions: { code: 'INPUT_ERROR' } }],
        },
      },
      {
        body: {
          data: {
            issue: gqlIssue({
              id: 'uuid-new',
              identifier: 'ENG-88',
              inverseRelations: {
                nodes: [blocksRelation('ENG-8', 'relation-8', 'uuid-8')],
              },
            }),
          },
        },
      },
      { body: { data: { issue: { id: 'uuid-9' } } } },
      { body: { data: { issueRelationCreate: { success: true } } } },
    ])
    const reservedId = crypto.randomUUID()

    const adopted = await makeSource(fetchFn).create(
      { title: 'X', body: 'y', blockedBy: ['ENG-8', 'ENG-9'] },
      { idempotencyKey: reservedId },
    )

    expect(adopted.blockedBy).toEqual(['ENG-8', 'ENG-9'])
    expect(calls.filter((call) => call.query.includes('query ResolveIssue'))).toHaveLength(1)
    expect(calls.filter((call) => call.query.includes('issueRelationCreate'))).toHaveLength(1)
    expect(calls.at(-1)?.variables).toEqual({ issueId: 'uuid-9', relatedIssueId: 'uuid-new' })
  })

  test('failed adoption-time blocker reconciliation remains retry-safe and actionable', async () => {
    const { fetchFn } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          errors: [{ message: 'Issue id already exists', extensions: { code: 'INPUT_ERROR' } }],
        },
      },
      {
        body: {
          data: {
            issue: gqlIssue({
              id: 'uuid-new',
              identifier: 'ENG-88',
              inverseRelations: {
                nodes: [blocksRelation('ENG-8', 'relation-8', 'uuid-8')],
              },
            }),
          },
        },
      },
      { body: { data: { issue: { id: 'uuid-9' } } } },
      { body: { data: { issueRelationCreate: { success: false } } } },
    ])
    const reservedId = crypto.randomUUID()

    const error = await rejectionOf(
      makeSource(fetchFn).create(
        { title: 'X', body: 'y', blockedBy: ['ENG-8', 'ENG-9'] },
        { idempotencyKey: reservedId },
      ),
    )

    expect(error.message).toContain('ticket "ENG-88" already exists')
    expect(error.message).toContain('Blockers recorded: "ENG-8"')
    expect(error.message).toContain('Blockers not recorded: "ENG-9"')
    expect(error.message).toContain('Retry with the same idempotency key')
    expect(error.message).not.toContain('Do not rerun ticket creation')
  })

  test('invalid and non-v4 idempotency keys fail before issuing a Linear request', async () => {
    const { fetchFn, calls } = fakeLinear([])

    for (const idempotencyKey of ['not-a-uuid', Bun.randomUUIDv5('cluster-retry', 'dns')]) {
      await expect(
        makeSource(fetchFn).create({ title: 'X', body: 'y' }, { idempotencyKey }),
      ).rejects.toThrow('linear create: idempotency key must be a UUID v4')
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

    const input = (calls[1]!.variables as { input: Record<string, unknown> }).input
    expect(input.stateId).toBeUndefined()
    expect(input.id).toBeUndefined()
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

  test('create creates an unknown label and uses its returned id', async () => {
    const { fetchFn, calls } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          data: {
            issueLabelCreate: {
              success: true,
              issueLabel: { id: 'lb-urgent', name: 'urgent' },
            },
          },
        },
      },
      {
        body: {
          data: {
            issueCreate: {
              success: true,
              issue: gqlIssue({ labels: { nodes: [{ name: 'urgent' }] } }),
            },
          },
        },
      },
    ])

    const created = await makeSource(fetchFn).create({
      title: 'X',
      body: 'y',
      labels: ['urgent'],
    })

    expect(calls).toHaveLength(3)
    expect(calls[1]?.query).toContain('$input: IssueLabelCreateInput!')
    expect(calls[1]?.variables).toEqual({
      input: { name: 'urgent', teamId: 'team-uuid' },
    })
    expect(calls[2]?.variables).toEqual({
      input: {
        teamId: 'team-uuid',
        title: 'X',
        description: 'y',
        labelIds: ['lb-urgent'],
      },
    })
    expect(created.labels).toEqual(['urgent'])
  })

  test('a failed label create adopts an exact-name winner from a concurrent writer', async () => {
    const { fetchFn, calls } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          errors: [{ message: 'Label name must be unique', extensions: { code: 'INPUT_ERROR' } }],
        },
      },
      {
        body: {
          data: {
            team: {
              labels: {
                nodes: [
                  { id: 'lb-near', name: 'Urgent' },
                  { id: 'lb-winner', name: 'urgent' },
                ],
              },
            },
          },
        },
      },
      {
        body: {
          data: { issueCreate: { success: true, issue: gqlIssue() } },
        },
      },
    ])

    await makeSource(fetchFn).create({ title: 'X', body: 'y', labels: ['urgent'] })

    expect(calls[2]?.query).toContain('labels(filter: { name: { eq: $name } })')
    expect(calls[2]?.variables).toEqual({ teamId: 'team-uuid', name: 'urgent' })
    expect(calls[3]?.variables).toMatchObject({ input: { labelIds: ['lb-winner'] } })
  })

  test('an unsuccessful label payload also adopts an exact-name winner', async () => {
    const { fetchFn, calls } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          data: { issueLabelCreate: { success: false, issueLabel: null } },
        },
      },
      {
        body: {
          data: {
            team: { labels: { nodes: [{ id: 'lb-winner', name: 'urgent' }] } },
          },
        },
      },
      {
        body: {
          data: { issueCreate: { success: true, issue: gqlIssue() } },
        },
      },
    ])

    await makeSource(fetchFn).create({ title: 'X', body: 'y', labels: ['urgent'] })

    expect(calls[3]?.variables).toMatchObject({ input: { labelIds: ['lb-winner'] } })
  })

  test('a failed label create preserves the provider error when exact lookup finds no winner', async () => {
    const { fetchFn, calls } = fakeLinear([
      TEAM_INFO_RESPONSE,
      {
        body: {
          errors: [{ message: 'label registry unavailable', extensions: { code: 'INTERNAL' } }],
        },
      },
      {
        body: {
          data: { team: { labels: { nodes: [] } } },
        },
      },
    ])

    await expect(
      makeSource(fetchFn).create({ title: 'X', body: 'y', labels: ['urgent'] }),
    ).rejects.toThrow('label registry unavailable')
    expect(calls.some((call) => call.query.includes('$input: IssueCreateInput!'))).toBe(false)
  })

  test('an HTTP error throws with status and operation context', async () => {
    const { fetchFn } = fakeLinear([{ status: 500, body: {} }])

    await expect(makeSource(fetchFn).get('ENG-42')).rejects.toThrow('linear get: HTTP 500')
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
  test("create with blockedBy sends Linear's bare blocks enum with the BLOCKER as issueId", async () => {
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

    const relationCalls = calls.filter((call) => call.query.includes('issueRelationCreate'))
    expect(relationCalls.map((call) => call.variables)).toEqual([
      { issueId: 'uuid-8', relatedIssueId: 'uuid-new' },
      { issueId: 'uuid-9', relatedIssueId: 'uuid-new' },
    ])
    expect(
      relationCalls.every(
        (call) => call.query.includes('type: blocks') && !call.query.includes('type: "blocks"'),
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

    const states = await makeSource(fetchFn).dependencyStates(types.map(([type]) => type))

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

    await expect(makeSource(fetchFn).get('AUT-99999')).rejects.toThrow('rate limited')
  })

  test('dependencyStates maps a live "Entity not found" error to exists: false', async () => {
    const { fetchFn } = fakeLinear([ENTITY_NOT_FOUND])

    expect(await makeSource(fetchFn).dependencyStates(['legacy-lookup'])).toEqual([
      { id: 'legacy-lookup', exists: false, resolved: false, blockedBy: [] },
    ])
  })

  test('a not-found for one blocker does not stop the rest from resolving', async () => {
    const { fetchFn } = fakeLinear([
      {
        body: {
          data: { issues: connection([gqlIssue({ state: { name: 'Done', type: 'completed' } })]) },
        },
      },
      ENTITY_NOT_FOUND,
    ])

    const states = await makeSource(fetchFn).dependencyStates(['legacy-lookup', 'ENG-42'])

    expect(states.map((s) => [s.id, s.exists, s.resolved])).toEqual([
      ['legacy-lookup', false, false],
      ['ENG-42', true, true],
    ])
  })

  /** The discrimination that matters: a real outage must NOT read as "the
   * ticket does not exist" — that would dispatch on a false diagnostic. */
  test('dependencyStates rethrows a non-not-found GraphQL error rather than reporting absence', async () => {
    const { fetchFn } = fakeLinear([
      {
        body: {
          errors: [{ message: 'rate limited', extensions: { code: 'RATELIMITED' } }],
        },
      },
    ])

    await expect(makeSource(fetchFn).dependencyStates(['ENG-42'])).rejects.toThrow('rate limited')
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

    await expect(makeSource(fetchFn).dependencyStates(['ENG-42'])).rejects.toThrow('rate limited')
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

  test('dependencyStates reports a missing issue in request order', async () => {
    const { fetchFn } = fakeLinear([
      {
        body: {
          data: {
            issues: connection([
              gqlIssue({
                state: { type: 'completed' },
                inverseRelations: connection([blocksRelation('ENG-1')]),
              }),
            ]),
          },
        },
      },
    ])
    expect(await makeSource(fetchFn).dependencyStates(['ENG-404', 'ENG-42'])).toEqual([
      { id: 'ENG-404', exists: false, resolved: false, blockedBy: [] },
      { id: 'ENG-42', exists: true, resolved: true, blockedBy: ['ENG-1'] },
    ])
  })

  test('dependencyStates re-reads workflow state every call', async () => {
    const { fetchFn } = fakeLinear(
      ['unstarted', 'completed'].map((type) => ({
        body: { data: { issues: connection([gqlIssue({ state: { type } })]) } },
      })),
    )
    const source = makeSource(fetchFn)
    expect((await source.dependencyStates(['ENG-42']))[0]?.resolved).toBe(false)
    expect((await source.dependencyStates(['ENG-42']))[0]?.resolved).toBe(true)
  })

  // ── Post-create grooming writes ───────────────────────────────────────────

  test('every full issue selection explicitly requests 250 inverse relations and relation ids', async () => {
    const { fetchFn, calls } = fakeLinear([{ body: { data: { issue: gqlIssue() } } }])

    await makeSource(fetchFn).get('ENG-42')

    expect(calls[0]?.query).toContain('inverseRelations(first: 250)')
    expect(calls[0]?.query).toContain('nodes { id type issue { id identifier } }')
  })

  test('update maps a missing target to an id-specific error before mutation', async () => {
    const { fetchFn, calls } = fakeLinear([ENTITY_NOT_FOUND])

    await expect(makeSource(fetchFn).update('ENG-404', { title: 'Renamed' })).rejects.toThrow(
      'unknown ticket "ENG-404"',
    )
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

  test('update creates an unknown label and uses its returned id', async () => {
    const { fetchFn, calls } = fakeLinear([
      { body: { data: { issue: { id: 'uuid-42' } } } },
      TEAM_INFO_RESPONSE,
      {
        body: {
          data: {
            issueLabelCreate: {
              success: true,
              issueLabel: { id: 'lb-urgent', name: 'urgent' },
            },
          },
        },
      },
      { body: { data: { issueUpdate: { success: true } } } },
    ])

    await makeSource(fetchFn).update('ENG-42', { labels: ['urgent'] })

    expect(calls).toHaveLength(4)
    expect(calls[2]?.variables).toEqual({
      input: { name: 'urgent', teamId: 'team-uuid' },
    })
    expect(calls[3]?.variables).toEqual({
      id: 'uuid-42',
      input: { labelIds: ['lb-urgent'] },
    })
  })

  test('concurrent unknown-label updates share one same-instance label create', async () => {
    const calls: RecordedCall[] = []
    let labelCreates = 0
    const fetchFn: LinearFetch = async (url, init) => {
      const parsed = JSON.parse(init.body) as {
        query: string
        variables: Record<string, unknown>
      }
      calls.push({ url, headers: init.headers, ...parsed })
      let data: unknown
      if (parsed.query.includes('query ResolveIssue')) {
        const id = String(parsed.variables.id)
        data = { issue: { id: `uuid-${id}` } }
      } else if (parsed.query.includes('query TeamInfo')) {
        data = TEAM_INFO_RESPONSE.body.data
      } else if (parsed.query.includes('mutation CreateIssueLabel')) {
        labelCreates += 1
        await Promise.resolve()
        data = {
          issueLabelCreate: {
            success: true,
            issueLabel: { id: 'lb-shared', name: 'shared-fresh' },
          },
        }
      } else if (parsed.query.includes('mutation UpdateIssue')) {
        data = { issueUpdate: { success: true } }
      } else {
        throw new Error(`unexpected Linear operation: ${parsed.query}`)
      }
      return { ok: true, status: 200, json: async () => ({ data }) }
    }
    const source = makeSource(fetchFn)

    await Promise.all([
      source.update('ENG-41', { labels: ['shared-fresh'] }),
      source.update('ENG-42', { labels: ['shared-fresh'] }),
    ])

    expect(labelCreates).toBe(1)
    const updates = calls.filter((call) => call.query.includes('mutation UpdateIssue'))
    expect(updates).toHaveLength(2)
    expect(updates.map((call) => call.variables)).toEqual([
      { id: 'uuid-ENG-41', input: { labelIds: ['lb-shared'] } },
      { id: 'uuid-ENG-42', input: { labelIds: ['lb-shared'] } },
    ])
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
    expect(calls.some((call) => call.query.includes('issueRelationCreate'))).toBe(false)
  })

  test('addBlocker maps a missing blocker to an id-specific error before mutation', async () => {
    const { fetchFn, calls } = fakeLinear([
      { body: { data: { issue: gqlIssue({ id: 'uuid-target' }) } } },
      ENTITY_NOT_FOUND,
    ])

    await expect(makeSource(fetchFn).addBlocker('ENG-42', 'ENG-404')).rejects.toThrow(
      'unknown ticket "ENG-404"',
    )
    expect(calls).toHaveLength(2)
    expect(calls.some((call) => call.query.includes('issueRelationCreate'))).toBe(false)
  })

  test('addBlocker rejects direct and UUID-alias self-blocks', async () => {
    const direct = fakeLinear([{ body: { data: { issue: gqlIssue({ id: 'uuid-target' }) } } }])
    await expect(makeSource(direct.fetchFn).addBlocker('ENG-42', 'ENG-42')).rejects.toThrow(
      'ENG-42',
    )
    expect(direct.calls).toHaveLength(1)

    const alias = fakeLinear([
      { body: { data: { issue: gqlIssue({ id: 'uuid-target' }) } } },
      { body: { data: { issue: { id: 'uuid-target' } } } },
    ])
    await expect(makeSource(alias.fetchFn).addBlocker('ENG-42', 'alias-for-42')).rejects.toThrow(
      'ENG-42',
    )
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
    expect(calls.slice(1).every((call) => call.query.includes('issueRelationDelete'))).toBe(true)
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

describe('Linear rate limiting', () => {
  const start = 1_800_000_000_000
  const limited = { errors: [{ message: 'Budget exhausted', extensions: { code: 'RATELIMITED' } }] }

  test('cooldown suppresses reads and mutations and resumes exactly at reset', async () => {
    let now = start
    const resetAt = start + 120_000
    const fake = fakeLinear([
      { status: 400, body: limited, headers: { 'X-RateLimit-Requests-Reset': String(resetAt) } },
      { body: { data: { issue: gqlIssue() } } },
      { body: limited, headers: { 'x-ratelimit-requests-reset': String(resetAt + 120_000) } },
    ])
    const source = new LinearTicketSource({
      apiKey: 'test',
      teamKey: 'ENG',
      fetchFn: fake.fetchFn,
      now: () => now,
    })
    const error = await rejectionOf(source.get('ENG-42'))
    expect(error).toBeInstanceOf(TicketSourceRateLimitError)
    expect(error).toMatchObject({ source: 'linear', resetAt })
    expect(error.message).toContain(new Date(resetAt).toISOString())
    expect(await rejectionOf(source.dependencyStates(['ENG-42']))).toBe(error)
    expect(await rejectionOf(source.comment('ENG-42', 'test'))).toBe(error)
    now = resetAt - 1
    expect(await rejectionOf(source.get('ENG-42'))).toBe(error)
    expect(fake.calls).toHaveLength(1)
    now = resetAt
    expect(await source.get('ENG-42')).not.toBeNull()
    expect(await rejectionOf(source.get('ENG-42'))).toMatchObject({ resetAt: resetAt + 120_000 })
    expect(fake.calls).toHaveLength(3)
  })

  for (const header of [
    undefined,
    'invalid',
    'Infinity',
    '0',
    String(start - 1),
    '8640000000000001',
  ]) {
    test(`unusable reset ${header} uses a 60-second fallback`, async () => {
      const fake = fakeLinear([
        {
          status: 400,
          body: limited,
          headers: header ? { 'x-ratelimit-requests-reset': header } : {},
        },
      ])
      const source = new LinearTicketSource({
        apiKey: 'test',
        teamKey: 'ENG',
        fetchFn: fake.fetchFn,
        now: () => start,
      })
      expect(await rejectionOf(source.get('ENG-42'))).toMatchObject({ resetAt: start + 60_000 })
      expect(await rejectionOf(source.get('ENG-42'))).toBeInstanceOf(TicketSourceRateLimitError)
      expect(fake.calls).toHaveLength(1)
    })
  }

  test('HTTP-200 mixed errors prioritize rate limiting over missing issues', async () => {
    const fake = fakeLinear([
      {
        body: {
          errors: [
            { message: 'Entity not found: Issue', extensions: { code: 'INPUT_ERROR' } },
            ...limited.errors,
          ],
        },
      },
    ])
    expect(await rejectionOf(makeSource(fake.fetchFn).get('ENG-42'))).toBeInstanceOf(
      TicketSourceRateLimitError,
    )
  })

  test('ordinary non-2xx GraphQL errors include code, message and status', async () => {
    const fake = fakeLinear([
      {
        status: 400,
        body: { errors: [{ message: 'Bad query', extensions: { code: 'INPUT_ERROR' } }] },
      },
    ])
    expect((await rejectionOf(makeSource(fake.fetchFn).get('ENG-42'))).message).toContain(
      'HTTP 400: GraphQL errors — INPUT_ERROR: Bad query',
    )
  })

  test('non-JSON and data-only HTTP failures retain HTTP status', async () => {
    const source = makeSource(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('not JSON')
      },
    }))
    expect((await rejectionOf(source.get('ENG-42'))).message).toBe('linear get: HTTP 502')
    const fake = fakeLinear([{ status: 400, body: { data: { issue: gqlIssue() } } }])
    expect((await rejectionOf(makeSource(fake.fetchFn).get('ENG-42'))).message).toBe(
      'linear get: HTTP 400',
    )
  })

  test('successful zero-quota responses and independent instances remain callable', async () => {
    const fake = fakeLinear([
      { body: limited },
      { body: { data: { issue: gqlIssue() } }, headers: { 'x-ratelimit-requests-remaining': '0' } },
      { body: { data: { issue: gqlIssue() } } },
    ])
    await rejectionOf(makeSource(fake.fetchFn).get('ENG-42'))
    const other = makeSource(fake.fetchFn)
    await other.get('ENG-42')
    await other.get('ENG-42')
    expect(fake.calls).toHaveLength(3)
  })

  test('an older in-flight success does not clear a newer active limit', async () => {
    let complete!: (value: { ok: boolean; status: number; json(): Promise<unknown> }) => void
    let calls = 0
    const source = makeSource(async () => {
      calls += 1
      if (calls === 1)
        return new Promise((resolve) => {
          complete = resolve
        })
      return { ok: false, status: 400, json: async () => limited }
    })
    const older = source.get('ENG-42')
    const error = await rejectionOf(source.get('ENG-42'))
    complete({ ok: true, status: 200, json: async () => ({ data: { issue: gqlIssue() } }) })
    await older
    expect(await rejectionOf(source.get('ENG-42'))).toBe(error)
    expect(calls).toBe(2)
  })
})

test('listing carries native completion without additional requests', async () => {
  const states = [
    { name: 'Shipped', type: 'completed' },
    { name: 'Dropped', type: 'canceled' },
    { name: 'Working', type: 'started' },
    null,
    { name: 'Unfamiliar', type: 'future-type' },
  ]
  const { fetchFn, calls } = fakeLinear([
    {
      body: {
        data: {
          issues: {
            nodes: states.map((state) => gqlIssue({ state })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ])
  const listing = await makeSource(fetchFn).listReady({ state: 'Anything' })
  expect(listing.tickets.map((ticket) => ticket.resolved)).toEqual([
    true,
    true,
    false,
    false,
    false,
  ])
  expect(calls).toHaveLength(1)
  expect(calls[0]?.query).toMatch(/state\s*\{\s*name\s+type\s*\}/)
})

function response(
  issues: ReturnType<typeof gqlIssue>[],
  more = false,
  cursor: string | null = null,
) {
  return { body: { data: { issues: connection(issues, more, cursor) } } }
}

describe('Linear collection pagination', () => {
  test('25 identifiers are batched, reordered, deduplicated and missing siblings survive', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `ENG-${i + 1}`)
    const { fetchFn, calls } = fakeLinear([
      response(
        ids
          .slice(1)
          .reverse()
          .map((identifier) => gqlIssue({ identifier })),
      ),
    ])
    const states = await makeSource(fetchFn).dependencyStates([...ids, ids[1]!])
    expect(states.map((s) => s.id)).toEqual([...ids, ids[1]!])
    expect(states[0]?.exists).toBe(false)
    expect(states.slice(1).every((s) => s.exists)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.variables).toEqual({
      filter: {
        team: { key: { eq: 'ENG' } },
        number: { in: Array.from({ length: 25 }, (_, i) => i + 1) },
      },
      first: 25,
      after: null,
    })
    expect(calls[0]?.query).toContain('includeArchived: true')
    expect(calls[0]?.query).toContain('inverseRelations(first: 100)')
    expect(calls[0]?.query).not.toMatch(/description|labels|title|url/)
  })

  test('team filters keep overlapping numbers separate and page cursors local', async () => {
    const { fetchFn, calls } = fakeLinear([
      response([gqlIssue({ identifier: 'TEAM-X-1' })], true, 'a'),
      response([gqlIssue({ identifier: 'TEAM-X-2' })]),
      response([gqlIssue({ identifier: 'ENG-1' })]),
    ])
    // Request group order follows first occurrence, independent of result order.
    const source = makeSource(fetchFn)
    const result = await source.dependencyStates(['TEAM-X-2', 'TEAM-X-1', 'ENG-1'])
    expect(result.every((s) => s.exists)).toBe(true)
    expect(calls).toHaveLength(3)
    expect(calls[0]?.variables.filter).toEqual({
      team: { key: { eq: 'TEAM-X' } },
      number: { in: [2, 1] },
    })
    expect(calls[1]?.variables).toEqual({ ...calls[0]!.variables, after: 'a' })
    expect(calls[2]?.variables.filter).toEqual({
      team: { key: { eq: 'ENG' } },
      number: { in: [1] },
    })
  })

  test('UUID group and fallback preserve aliases, with no request for empty inputs', async () => {
    const uuid = '12345678-1234-4123-8123-123456789abc'
    const { fetchFn, calls } = fakeLinear([
      response([gqlIssue()]),
      response([gqlIssue({ id: uuid })]),
      { body: { data: { issue: gqlIssue() } } },
    ])
    const source = makeSource(fetchFn)
    expect(await source.dependencyStates([])).toEqual([])
    expect(calls).toHaveLength(0)
    const ids = ['ENG-42', uuid.toUpperCase(), 'legacy']
    expect((await source.dependencyStates(ids)).map((s) => [s.id, s.exists])).toEqual(
      ids.map((id) => [id, true]),
    )
    expect(calls[1]?.variables.filter).toEqual({ id: { in: [uuid] } })
    expect(calls[2]?.query).not.toMatch(/description|labels|title|url/)
  })

  test.each([null, 'same'])('outer pagination rejects invalid cursor %s', async (cursor) => {
    const { fetchFn } = fakeLinear([response([], true, 'same'), response([], true, cursor)])
    await expect(makeSource(fetchFn).dependencyStates(['ENG-1'])).rejects.toThrow('cursor')
  })

  test('dependency relation continuations batch distinct cursors and retain 250 relations', async () => {
    const relations = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) => blocksRelation(`ENG-${start + i}`))
    const { fetchFn, calls } = fakeLinear([
      response([
        gqlIssue({
          identifier: 'ENG-1',
          id: 'uuid-1',
          inverseRelations: connection(relations(100, 100), true, 'a'),
        }),
        gqlIssue({
          identifier: 'ENG-2',
          id: 'uuid-2',
          inverseRelations: connection([], true, 'b'),
        }),
      ]),
      {
        body: {
          data: {
            r0: { inverseRelations: connection(relations(200, 100), true, 'aa') },
            r1: { inverseRelations: connection([blocksRelation('ENG-9')]) },
          },
        },
      },
      { body: { data: { r0: { inverseRelations: connection(relations(300, 50), true, 'aaa') } } } },
    ])
    const result = await makeSource(fetchFn).dependencyStates(['ENG-1', 'ENG-2'])
    expect(result[0]?.blockedBy).toHaveLength(250)
    expect(result[1]?.blockedBy).toEqual(['ENG-9'])
    expect(calls[1]?.variables).toEqual({
      id0: 'uuid-1',
      first0: 100,
      after0: 'a',
      id1: 'uuid-2',
      first1: 100,
      after1: 'b',
    })
    expect(calls[2]?.variables.first0).toBe(50)
    expect(calls[1]?.query).not.toMatch(/description|labels/)
  })

  test('ready listing returns over 50 issues with unchanged criteria and complete hints', async () => {
    const pages = Array.from({ length: 6 }, (_, page) =>
      response(
        Array.from({ length: 10 }, (_, i) => gqlIssue({ identifier: `ENG-${page * 10 + i + 1}` })),
        page < 5,
        `${page}`,
      ),
    )
    const { fetchFn, calls } = fakeLinear(pages)
    const listing = await makeSource(fetchFn).listReady({ state: 'Ready', labels: ['go'] })
    expect(listing.tickets).toHaveLength(60)
    expect(listing.tickets[59]?.ref.id).toBe('ENG-60')
    expect(listing.tickets[59]?.blockersResolved).toBe(true)
    for (const call of calls) {
      expect(call.variables.filter).toEqual(calls[0]!.variables.filter)
      expect(call.variables.first).toBe(10)
      expect(call.query).toContain('labels(first: 50)')
      expect(call.query).toContain('inverseRelations(first: 100)')
    }
  })

  test.each(['completed', 'canceled', 'started', 'future', null])(
    'ready hint interprets blocker state %s',
    async (type) => {
      const relation = {
        ...blocksRelation('ENG-1'),
        issue: { identifier: 'ENG-1', state: type ? { type } : null },
      }
      const { fetchFn } = fakeLinear([
        response([
          gqlIssue({ inverseRelations: connection([relation, { type: 'related', issue: null }]) }),
        ]),
      ])
      expect((await makeSource(fetchFn).listReady({})).tickets[0]?.blockersResolved).toBe(
        type === 'completed' || type === 'canceled',
      )
    },
  )

  test.each([null, { identifier: '', state: { type: 'completed' } }])(
    'unidentifiable blockers cannot produce a true hint',
    async (issue) => {
      const { fetchFn } = fakeLinear([
        response([gqlIssue({ inverseRelations: connection([{ type: 'blocks', issue }]) })]),
      ])
      expect((await makeSource(fetchFn).listReady({})).tickets[0]?.blockersResolved).toBe(false)
    },
  )

  test.each(['completed', 'started'])(
    'listing exhausts relations beyond 250: final blocker %s',
    async (type) => {
      const relations = (offset: number) =>
        Array.from({ length: 100 }, (_, i) => ({
          type: 'blocks',
          issue: { identifier: `ENG-${offset + i}`, state: { type: 'completed' } },
        }))
      const { fetchFn, calls } = fakeLinear([
        response([gqlIssue({ inverseRelations: connection(relations(100), true, 'a') })]),
        { body: { data: { r0: { inverseRelations: connection(relations(200), true, 'b') } } } },
        { body: { data: { r0: { inverseRelations: connection(relations(300), true, 'c') } } } },
        {
          body: {
            data: {
              r0: {
                inverseRelations: connection([
                  { type: 'blocks', issue: { identifier: 'ENG-999', state: { type } } },
                ]),
              },
            },
          },
        },
      ])
      const ticket = (await makeSource(fetchFn).listReady({})).tickets[0]!
      expect(ticket.blockedBy).toHaveLength(301)
      expect(ticket.blockersResolved).toBe(type === 'completed')
      expect(calls).toHaveLength(4)
    },
  )

  test('missing relation data and failed or repeated continuation reject listing', async () => {
    for (const continuation of [
      { body: { data: { r0: { inverseRelations: connection([], true, 'a') } } } },
      { body: { errors: [{ message: 'outage' }] } },
      { body: { data: { r0: null } } },
    ]) {
      const { fetchFn } = fakeLinear([
        response([gqlIssue({ inverseRelations: connection([], true, 'a') })]),
        continuation,
      ])
      await expect(makeSource(fetchFn).listReady({})).rejects.toThrow()
    }
    const { fetchFn } = fakeLinear([response([gqlIssue({ inverseRelations: undefined })])])
    await expect(makeSource(fetchFn).listReady({})).rejects.toThrow('pageInfo')
  })
})

/** Conservative requested-shape cost, following Linear's scalar/object and
 * connection multipliers. Parse the actual queries so added fields or omitted
 * first bounds cannot quietly invalidate the documented budget. */
function requestedComplexity(call: RecordedCall): number {
  const tokens = call.query.slice(call.query.indexOf('{')).match(/\$?\w+|[{}():!]/g)!
  let index = 0
  function selection(bound?: number): number {
    expect(tokens[index++]).toBe('{')
    let cost = 0
    while (tokens[index] !== '}') {
      let field = tokens[index++]!
      if (tokens[index] === ':') {
        index++
        field = tokens[index++]!
      }
      let first: number | undefined
      if (tokens[index] === '(') {
        index++
        while (tokens[index] !== ')') {
          const key = tokens[index++]!
          expect(tokens[index++]).toBe(':')
          const value = tokens[index++]!
          if (key === 'first')
            first = Number(value.startsWith('$') ? call.variables[value.slice(1)] : value)
        }
        index++
      }
      if (['issues', 'labels', 'inverseRelations'].includes(field)) {
        expect(first).toBeGreaterThan(0)
      }
      const child = tokens[index] === '{' ? 1 + selection(first) : 0.1
      if (field === 'nodes') expect(bound).toBeGreaterThan(0)
      cost += child * (field === 'nodes' ? bound! : 1)
    }
    index++
    return cost
  }
  return selection()
}

test.each([false, true])(
  'maximum relation alias batches stay within provider complexity budget (ready=%s)',
  async (ready) => {
    const size = ready ? 10 : 25
    const issues = Array.from({ length: size }, (_, i) =>
      gqlIssue({
        identifier: `ENG-${i + 1}`,
        id: `uuid-${i}`,
        inverseRelations: connection([], true, `cursor-${i}`),
      }),
    )
    const aliases = Object.fromEntries(
      issues.map((_, i) => [`r${i}`, { inverseRelations: connection([]) }]),
    )
    const { fetchFn, calls } = fakeLinear([response(issues), { body: { data: aliases } }])
    const source = makeSource(fetchFn)
    if (ready) await source.listReady({})
    else await source.dependencyStates(issues.map((issue) => issue.identifier))
    expect(calls).toHaveLength(2)
    expect(calls[1]!.query.match(/r\d+: issue/g)).toHaveLength(size)
    expect(calls[1]!.variables[`after${size - 1}`]).toBe(`cursor-${size - 1}`)
    for (const call of calls) expect(requestedComplexity(call)).toBeLessThan(8000)

    const fallback = fakeLinear([{ body: { data: { issue: gqlIssue() } } }])
    await makeSource(fallback.fetchFn).dependencyStates(['legacy'])
    expect(requestedComplexity(fallback.calls[0]!)).toBeLessThan(8000)
  },
)

test('two teams with overlapping issue numbers cost exactly two dependency requests', async () => {
  const { fetchFn, calls } = fakeLinear([
    response([gqlIssue({ identifier: 'ENG-1', state: null })]),
    response([gqlIssue({ identifier: 'OPS-1', state: { type: 'canceled' } })]),
  ])
  expect(await makeSource(fetchFn).dependencyStates(['ENG-1', 'OPS-1'])).toEqual([
    { id: 'ENG-1', exists: true, resolved: false, blockedBy: [] },
    { id: 'OPS-1', exists: true, resolved: true, blockedBy: [] },
  ])
  expect(calls).toHaveLength(2)
  expect(calls.map((call) => call.variables.filter)).toEqual([
    { team: { key: { eq: 'ENG' } }, number: { in: [1] } },
    { team: { key: { eq: 'OPS' } }, number: { in: [1] } },
  ])
})

test('fallback relation continuation errors cannot turn an existing issue into a missing dependency', async () => {
  const { fetchFn } = fakeLinear([
    { body: { data: { issue: gqlIssue({ inverseRelations: connection([], true, 'a') }) } } },
    {
      body: {
        errors: [{ message: 'Entity not found: Issue', extensions: { code: 'INPUT_ERROR' } }],
      },
    },
  ])
  await expect(makeSource(fetchFn).dependencyStates(['legacy'])).rejects.toThrow('Entity not found')
})
