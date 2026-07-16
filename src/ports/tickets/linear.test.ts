import { describe, expect, test } from 'bun:test'
import { LINEAR_API_URL, LinearTicketSource, type LinearFetch } from './linear'

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

function gqlIssue(over: Record<string, unknown> = {}) {
  return {
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
    expect(tickets).toEqual([
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
        blockedBy: [],
        complete: false,
      },
    ])
  })

  test('listReady with no criteria sends only the team filter', async () => {
    const { fetchFn, calls } = fakeLinear([
      { body: { data: { issues: { nodes: [] } } } },
    ])

    expect(await makeSource(fetchFn).listReady({})).toEqual([])
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

  test('create with blockedBy resolves blockers then writes native blocks relations', async () => {
    const { fetchFn, calls } = fakeLinear([
      TEAM_INFO_RESPONSE,
      { body: { data: { issue: { id: 'uuid-blocker' } } } }, // resolve ENG-8
      {
        body: {
          data: {
            issueCreate: { success: true, issue: { id: 'uuid-new', ...gqlIssue() } },
          },
        },
      },
      { body: { data: { issueRelationCreate: { success: true } } } },
    ])

    const created = await makeSource(fetchFn).create({
      title: 'Rate-limit auth',
      body: 'spec',
      blockedBy: ['ENG-8'],
    })

    // Direction, verified against the live API (AUT-9 reads back `blocks`
    // from AUT-8 through inverseRelations): issueId BLOCKS relatedIssueId, so
    // the blocker is issueId and the new issue is relatedIssueId.
    expect(calls[3]?.variables).toEqual({
      input: {
        issueId: 'uuid-blocker',
        relatedIssueId: 'uuid-new',
        type: 'blocks',
      },
    })
    // create() reports what it wrote — the issue was fetched before the
    // relation existed, so the stale read must not be believed.
    expect(created.blockedBy).toEqual(['ENG-8'])
  })

  test('create resolves EVERY blocker before creating the issue', async () => {
    // An unknown blocker must fail with nothing written, rather than leave a
    // dangling issue whose requested dependency never landed.
    const { fetchFn, calls } = fakeLinear([
      TEAM_INFO_RESPONSE,
      { body: { data: { issue: null } } }, // ENG-99 does not exist
    ])

    await expect(
      makeSource(fetchFn).create({ title: 'X', body: 'y', blockedBy: ['ENG-99'] }),
    ).rejects.toThrow(/unknown ticket "ENG-99"/)
    expect(calls.map((call) => call.query).join('\n')).not.toContain('issueCreate')
  })

  test('a relation that does not land throws naming the created issue and blocker', async () => {
    const { fetchFn } = fakeLinear([
      TEAM_INFO_RESPONSE,
      { body: { data: { issue: { id: 'uuid-blocker' } } } },
      {
        body: {
          data: {
            issueCreate: { success: true, issue: { id: 'uuid-new', ...gqlIssue() } },
          },
        },
      },
      { body: { data: { issueRelationCreate: { success: false } } } },
    ])

    // Linear has no atomic multi-create: a partial failure must be loud, or
    // the ticket silently dispatches without its dependency.
    await expect(
      makeSource(fetchFn).create({ title: 'X', body: 'y', blockedBy: ['ENG-8'] }),
    ).rejects.toThrow(/ENG-42 was created but the "blocked by ENG-8" relation did not land/)
  })

  test('toTicket maps inverse blocks relations to blockedBy, ignoring other types', async () => {
    const { fetchFn } = fakeLinear([
      {
        body: {
          data: {
            issue: gqlIssue({
              inverseRelations: {
                nodes: [
                  { type: 'related', issue: { identifier: 'ENG-10' } },
                  { type: 'blocks', issue: { identifier: 'ENG-8' } },
                  { type: 'duplicate', issue: { identifier: 'ENG-11' } },
                ],
              },
            }),
          },
        },
      },
    ])

    // `related` is symmetric and `duplicate` is not a blocker — only `blocks`
    // means "this issue is blocked by that one". Shape taken from a live read.
    expect((await makeSource(fetchFn).get('ENG-42'))?.blockedBy).toEqual(['ENG-8'])
  })

  test('complete follows Linear own state types, not a state name allowlist', async () => {
    const cases: Array<[string, boolean]> = [
      ['completed', true],
      ['canceled', true],
      ['started', false],
      ['unstarted', false],
      ['backlog', false],
      ['triage', false],
    ]
    for (const [type, expected] of cases) {
      const { fetchFn } = fakeLinear([
        { body: { data: { issue: gqlIssue({ state: { name: 'Whatever', type } }) } } },
      ])
      expect((await makeSource(fetchFn).get('ENG-42'))?.complete).toBe(expected)
    }
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
})
