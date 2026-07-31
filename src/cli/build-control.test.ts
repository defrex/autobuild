import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import { agentActor, DISPATCHER, KERNEL } from '../events/envelope'
import type { EscalationSource } from '../ontology'
import type { EventType } from '../events/payloads'
import { decideNext } from '../kernel/engine'
import { reduceBuild } from '../kernel/reducer'
import type { Exec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import type { BuildStore } from '../store/types'
import { steppingClock } from '../testing/fixed'
import {
  BARE_RETRY_ANSWER,
  BuildControlError,
  abBuildControl,
  controlBuild,
  type BuildControlAction,
} from './build-control'

const REPO = '/repo'
const SLUG = 'active-build'

async function makeStore(
  opts: {
    slug?: string
    repo?: string
    active?: boolean
    ticket?: { source: string; id: string }
  } = {},
): Promise<MemoryBuildStore> {
  const slug = opts.slug ?? SLUG
  const store = new MemoryBuildStore({ clock: steppingClock() })
  await store.createBuild({
    slug,
    repo: opts.repo ?? REPO,
    ...(opts.ticket !== undefined ? { ticket: opts.ticket } : {}),
  })
  if (opts.active !== false) {
    await store.append(slug, {
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: 'runner-1', host: 'host-1', resumedFromSeq: 0 },
    })
  }
  return store
}

async function raise(
  store: MemoryBuildStore,
  id: string,
  source: EscalationSource = 'agent',
  refs?: string[],
): Promise<void> {
  await store.append(SLUG, {
    actor: agentActor('implement', `session-${id}`),
    type: 'escalation.raised',
    payload: {
      id,
      phase: 'implement',
      round: 1,
      source,
      question: `Question ${id}?`,
      ...(refs !== undefined ? { refs } : {}),
    },
  })
}

function eventTypes(store: MemoryBuildStore): Promise<string[]> {
  return store.getEvents(SLUG).then((events) => events.map((event) => event.type))
}

const ENGINE_CONFIG = parseConfig(`
[tickets]
source = "file"
readyState = "ready"

[verify]
steps = []

[finalize]
steps = []
`)

const CONFORMING_SPEC = [
  '# Replacement',
  '',
  '## Acceptance criteria',
  '- The replacement is used.',
  '',
  '## Out of scope',
  '- Nothing else.',
  '',
].join('\n')

async function seedSpec(store: MemoryBuildStore, body = 'old spec'): Promise<void> {
  const meta = await store.putArtifact(SLUG, { kind: 'spec', content: body })
  await store.append(SLUG, {
    actor: agentActor('spec', 'session-spec'),
    type: 'spec.authored',
    payload: { artifact: { kind: 'spec', rev: meta.revision }, session: 'session-spec' },
  })
}

describe('controlBuild — shared durable controls', () => {
  test('explicit actions map to the five existing human command events', async () => {
    const cases: [BuildControlAction, EventType][] = [
      [{ kind: 'pause' }, 'build.pause-requested'],
      [{ kind: 'resume' }, 'build.resume-requested'],
      [{ kind: 'abort' }, 'build.abort-requested'],
      [{ kind: 'auto-merge-on' }, 'build.auto-merge-requested'],
      [{ kind: 'auto-merge-off' }, 'build.auto-merge-cancelled'],
    ]

    for (const [action, eventType] of cases) {
      const store = await makeStore()
      const before = (await store.getEvents(SLUG)).length
      const result = await controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: { USER: 'operator' },
        action,
      })
      expect(result.kind).toBe('command')
      const added = (await store.getEvents(SLUG)).slice(before)
      expect(added).toHaveLength(1)
      expect(added[0]?.type).toBe(eventType)
      expect(added[0]?.payload).toEqual({})
      expect(added[0]?.actor).toEqual({ kind: 'human', user: 'operator' })
      await store.close()
    }
  })

  test('dashboard pause and resume derive from freshly reduced state', async () => {
    const store = await makeStore()

    const pause = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action: { kind: 'dashboard-pause' },
    })
    expect(pause).toMatchObject({ kind: 'command', command: 'pause' })

    const cancelPause = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action: { kind: 'dashboard-pause' },
    })
    expect(cancelPause).toMatchObject({ kind: 'command', command: 'resume' })
    expect((await eventTypes(store)).slice(-2)).toEqual([
      'build.pause-requested',
      'build.resume-requested',
    ])

    await store.append(SLUG, {
      actor: KERNEL,
      type: 'build.resumed',
      payload: {},
    })
    await store.append(SLUG, {
      actor: KERNEL,
      type: 'build.paused',
      payload: {},
    })
    const resume = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action: { kind: 'dashboard-resume' },
    })
    expect(resume).toMatchObject({ kind: 'command', command: 'resume' })

    const beforeDuplicate = await store.getEvents(SLUG)
    await expect(
      controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: {},
        action: { kind: 'dashboard-resume' },
      }),
    ).rejects.toMatchObject({ code: 'inactive' })
    expect(await store.getEvents(SLUG)).toEqual(beforeDuplicate)

    const on = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action: { kind: 'toggle-auto-merge' },
    })
    const off = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action: { kind: 'toggle-auto-merge' },
    })
    expect(on).toMatchObject({ kind: 'command', command: 'auto-merge-on' })
    expect(off).toMatchObject({ kind: 'command', command: 'auto-merge-off' })
    expect((await eventTypes(store)).slice(-2)).toEqual([
      'build.auto-merge-requested',
      'build.auto-merge-cancelled',
    ])
    await store.close()
  })

  test('a blocked dashboard resume requests input and writes nothing', async () => {
    const store = await makeStore()
    await raise(store, 'esc-1')
    await raise(store, 'esc-2', 'policy')
    const before = await store.getEvents(SLUG)

    await expect(
      controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: {},
        action: { kind: 'dashboard-pause' },
      }),
    ).rejects.toMatchObject({ code: 'inactive' })
    expect(await store.getEvents(SLUG)).toEqual(before)

    const result = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action: { kind: 'dashboard-resume' },
    })

    expect(result).toEqual({
      kind: 'answer-required',
      slug: SLUG,
      escalationIds: ['esc-1', 'esc-2'],
    })
    expect(await store.getEvents(SLUG)).toEqual(before)
    await store.close()
  })

  test('guidance answers every source in raise order, then resumes a paused build', async () => {
    const store = await makeStore()
    await raise(store, 'esc-agent', 'agent')
    await raise(store, 'esc-stall', 'stall')
    await raise(store, 'esc-policy', 'policy')
    await store.append(SLUG, {
      actor: KERNEL,
      type: 'build.paused',
      payload: {},
    })
    const before = (await store.getEvents(SLUG)).length

    const result = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: { USER: '  ', USERNAME: 'windows-op' },
      action: { kind: 'answer', text: '  Use the manual path.  ' },
    })

    expect(result).toEqual({
      kind: 'answered',
      slug: SLUG,
      count: 3,
      resolution: 'guidance',
      resumed: true,
    })
    const added = (await store.getEvents(SLUG)).slice(before)
    expect(added.map((event) => event.type)).toEqual([
      'escalation.answered',
      'escalation.answered',
      'escalation.answered',
      'build.resume-requested',
    ])
    const answers = added.filter((event) => event.type === 'escalation.answered')
    expect(answers.map((event) => event.payload.id)).toEqual([
      'esc-agent',
      'esc-stall',
      'esc-policy',
    ])
    expect(
      answers.every(
        (event) =>
          event.payload.answer === 'Use the manual path.' &&
          event.payload.resolution === 'guidance' &&
          event.actor.kind === 'human' &&
          event.actor.user === 'windows-op',
      ),
    ).toBe(true)
    expect(added.at(-1)?.actor).toEqual({ kind: 'human', user: 'windows-op' })
    await store.close()
  })

  test('blank text is a retry and captured-id revalidation answers only captured blockers', async () => {
    const store = await makeStore()
    await raise(store, 'old')
    await raise(store, 'captured')

    const result = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action: {
        kind: 'answer',
        text: ' \t ',
        escalationIds: ['captured', 'already-gone'],
      },
    })
    expect(result).toMatchObject({
      kind: 'answered',
      count: 1,
      resolution: 'retry',
      resumed: false,
    })
    const answer = (await store.getEvents(SLUG)).at(-1)
    expect(answer?.type).toBe('escalation.answered')
    if (answer?.type === 'escalation.answered') {
      expect(answer.payload).toEqual({
        id: 'captured',
        answer: BARE_RETRY_ANSWER,
        resolution: 'retry',
      })
      expect(answer.actor).toEqual({ kind: 'human', user: 'dashboard' })
    }

    await expect(
      controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: {},
        action: { kind: 'answer', escalationIds: ['captured'] },
      }),
    ).rejects.toThrow(/no longer blocked by the captured escalation/)
    await store.close()
  })

  test('a retry after a partial multi-answer failure skips the answer already recorded', async () => {
    const store = await makeStore()
    await raise(store, 'esc-first')
    await raise(store, 'esc-second')
    const originalAppend = store.append.bind(store)
    let answerAttempts = 0
    store.append = (async (target: string, event: Parameters<BuildStore['append']>[1]) => {
      if (event.type === 'escalation.answered') {
        answerAttempts += 1
        if (answerAttempts === 2) throw new Error('transient append failure')
      }
      return originalAppend(target, event)
    }) as BuildStore['append']

    const action = {
      kind: 'answer' as const,
      text: 'Proceed',
      escalationIds: ['esc-first', 'esc-second'],
    }
    await expect(
      controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: {},
        action,
      }),
    ).rejects.toThrow('transient append failure')

    const result = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action,
    })
    expect(result).toMatchObject({ kind: 'answered', count: 1 })
    const answers = (await store.getEvents(SLUG)).filter(
      (event) => event.type === 'escalation.answered',
    )
    expect(answers.map((event) => event.payload.id)).toEqual(['esc-first', 'esc-second'])
    await store.close()
  })

  test('revises a blocked build on a new spec revision and retains an open PR', async () => {
    const store = await makeStore()
    await seedSpec(store)
    await store.append(SLUG, {
      actor: KERNEL,
      type: 'plan.started',
      payload: { round: 2 },
    })
    await store.append(SLUG, {
      actor: agentActor('plan', 'plan-2'),
      type: 'plan.completed',
      payload: { round: 2, artifact: { kind: 'plan', rev: 0 } },
    })
    await store.append(SLUG, {
      actor: KERNEL,
      type: 'plan-review.started',
      payload: { round: 2 },
    })
    await store.append(SLUG, {
      actor: agentActor('plan-review', 'review-2'),
      type: 'plan-review.verdict',
      payload: {
        round: 2,
        verdict: 'approve',
        findings: [],
        artifact: { kind: 'plan-review', rev: 0 },
      },
    })
    await store.append(SLUG, {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: { pr: { number: 7, url: 'https://example.test/pr/7', headSha: 'head-1' } },
    })
    await raise(store, 'esc-spec')
    const before = (await store.getEvents(SLUG)).length

    const result = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: { USER: 'contract-owner' },
      action: {
        kind: 'answer',
        resolve: {
          kind: 'revise-spec',
          body: { kind: 'supplied', origin: 'replacement.md', read: async () => CONFORMING_SPEC },
        },
      },
    })

    expect(result).toMatchObject({
      kind: 'answered',
      resolution: 'revise-spec',
      count: 1,
      specRev: 1,
    })
    const added = (await store.getEvents(SLUG)).slice(before)
    expect(added.map((event) => event.type)).toEqual(['escalation.answered', 'spec.revised'])
    const answer = added[0]
    expect(answer?.actor).toEqual({ kind: 'human', user: 'contract-owner' })
    expect(answer?.payload).toMatchObject({
      id: 'esc-spec',
      resolution: 'revise-spec',
      artifact: { kind: 'spec', rev: 1 },
    })
    expect(added[1]?.actor).toEqual(KERNEL)
    const state = reduceBuild(await store.getEvents(SLUG))
    expect(state.specRev).toBe(1)
    expect(state.restartSince).toBe(added[1]!.seq)
    expect(state.openEscalations).toEqual([])
    expect(state.pr).toEqual({ number: 7, url: 'https://example.test/pr/7', headSha: 'head-1' })
    expect(state.finalizeCompletedSeq).toBeLessThan(state.restartSince)
    expect(decideNext(await store.getEvents(SLUG), ENGINE_CONFIG)).toMatchObject({
      kind: 'run-phase',
      phase: 'plan',
      round: 3,
    })
    const replacement = await store.getArtifact(SLUG, 'spec', 1)
    expect(replacement).not.toBeNull()
    expect(new TextDecoder().decode(replacement!.content)).toBe(CONFORMING_SPEC)
    await store.close()
  })

  test('reports an ended-PR precursor that lands after revision revalidation', async () => {
    const store = await makeStore()
    await seedSpec(store)
    await store.append(SLUG, {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: { pr: { number: 8, url: 'https://example.test/pr/8', headSha: 'head-2' } },
    })
    await raise(store, 'esc-race')
    const originalAppend = store.append.bind(store)
    let injected = false
    store.append = (async (target: string, event: Parameters<BuildStore['append']>[1]) => {
      const appended = await originalAppend(target, event)
      if (!injected && event.type === 'escalation.answered') {
        injected = true
        await originalAppend(target, {
          actor: DISPATCHER,
          type: 'pr.merged',
          payload: { sha: 'merge-sha' },
        })
      }
      return appended
    }) as BuildStore['append']

    const result = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action: {
        kind: 'answer',
        resolve: {
          kind: 'revise-spec',
          body: { kind: 'supplied', origin: 'replacement.md', read: async () => CONFORMING_SPEC },
        },
      },
    })
    expect(result).toMatchObject({
      resolution: 'revise-spec',
      terminalSignal: { kind: 'pr-ended', state: 'merged' },
    })
    expect(reduceBuild(await store.getEvents(SLUG)).status).toBe('running')
    await store.close()
  })

  test('re-imports a replacement from the build ticket through the lazy adapter seam', async () => {
    const ticket = { source: 'fake', id: 'T-42' }
    const store = await makeStore({ ticket })
    await seedSpec(store)
    await raise(store, 'esc-ticket')
    const reads: (typeof ticket)[] = []

    const result = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action: {
        kind: 'answer',
        resolve: { kind: 'revise-spec', body: { kind: 'ticket' } },
      },
      readTicketBody: async (ref) => {
        reads.push(ref)
        return CONFORMING_SPEC
      },
    })

    expect(reads).toEqual([ticket])
    expect(result).toMatchObject({ resolution: 'revise-spec', specRev: 1 })
    expect((await store.getArtifact(SLUG, 'spec', 1))?.meta.metadata).toEqual({
      ticket: 'T-42',
      source: 'fake',
    })
    await store.close()
  })

  test('refuses non-conforming and unblocked spec replacements without recording', async () => {
    const store = await makeStore()
    await seedSpec(store)
    await raise(store, 'esc-spec')
    const beforeEvents = await store.getEvents(SLUG)
    const beforeArtifacts = await store.listArtifacts(SLUG, 'spec')
    await expect(
      controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: {},
        action: {
          kind: 'answer',
          resolve: {
            kind: 'revise-spec',
            body: { kind: 'supplied', origin: 'bad.md', read: async () => '# Incomplete' },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'spec-nonconforming' })
    expect(await store.getEvents(SLUG)).toEqual(beforeEvents)
    expect(await store.listArtifacts(SLUG, 'spec')).toEqual(beforeArtifacts)

    await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action: { kind: 'answer' },
    })
    const answered = await store.getEvents(SLUG)
    await expect(
      controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: {},
        action: {
          kind: 'answer',
          resolve: {
            kind: 'revise-spec',
            body: { kind: 'supplied', origin: 'good.md', read: async () => CONFORMING_SPEC },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'no-open-escalations' })
    expect(await store.getEvents(SLUG)).toEqual(answered)
    await store.close()
  })

  test('completes an earlier revision authorization without opening the new body source', async () => {
    const store = await makeStore()
    await seedSpec(store)
    const authorized = await store.putArtifact(SLUG, { kind: 'spec', content: CONFORMING_SPEC })
    await raise(store, 'esc-first')
    await raise(store, 'esc-second')
    await store.append(SLUG, {
      actor: { kind: 'human', user: 'first-op' },
      type: 'escalation.answered',
      payload: {
        id: 'esc-first',
        answer: 'replace it',
        resolution: 'revise-spec',
        artifact: { kind: 'spec', rev: authorized.revision },
      },
    })
    let read = false
    const result = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action: {
        kind: 'answer',
        resolve: {
          kind: 'revise-spec',
          body: {
            kind: 'supplied',
            origin: 'deleted.md',
            read: async () => {
              read = true
              throw new Error('file disappeared')
            },
          },
        },
      },
    })
    expect(read).toBe(false)
    expect(result).toMatchObject({
      kind: 'answered',
      resolution: 'revise-spec',
      authorizedEarlier: true,
      specRev: authorized.revision,
    })
    const state = reduceBuild(await store.getEvents(SLUG))
    expect(state.specRev).toBe(authorized.revision)
    expect(state.openEscalations).toEqual([])
    await store.close()
  })

  test('fails closed when an earlier revise-spec answer names no authorized body', async () => {
    const store = await makeStore()
    await seedSpec(store)
    await raise(store, 'esc-legacy')
    await store.append(SLUG, {
      actor: { kind: 'human', user: 'legacy-op' },
      type: 'escalation.answered',
      payload: {
        id: 'esc-legacy',
        answer: 'revise it',
        resolution: 'revise-spec',
      },
    })
    let read = false
    await expect(
      controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: {},
        action: {
          kind: 'answer',
          resolve: {
            kind: 'revise-spec',
            body: {
              kind: 'supplied',
              origin: 'new.md',
              read: async () => {
                read = true
                return CONFORMING_SPEC
              },
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'missing-authorization' })
    expect(read).toBe(false)
    expect(reduceBuild(await store.getEvents(SLUG)).specRev).toBe(0)
    await store.close()
  })

  test('dismisses only escalations that cite real review findings', async () => {
    const store = await makeStore()
    await store.append(SLUG, {
      actor: agentActor('code-review', 'review-1'),
      type: 'code-review.verdict',
      payload: {
        round: 1,
        verdict: 'revise',
        findings: [{ id: 'f_real', severity: 'blocking', summary: 'real issue', persists: [] }],
        artifact: { kind: 'code-review', rev: 0 },
      },
    })
    await raise(store, 'esc-finding', 'stall', ['f_real', 'src/file.ts'])
    await raise(store, 'esc-policy', 'policy')

    const result = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: { USER: 'review-owner' },
      action: { kind: 'answer', resolve: { kind: 'dismiss-finding' } },
    })
    expect(result).toMatchObject({
      kind: 'answered',
      resolution: 'dismiss-finding',
      count: 1,
      remainingOpen: 1,
      resumed: false,
    })
    const state = reduceBuild(await store.getEvents(SLUG))
    expect(state.openEscalations.map((item) => item.id)).toEqual(['esc-policy'])
    expect(state.answeredEscalations.at(-1)).toMatchObject({
      id: 'esc-finding',
      resolution: 'dismiss-finding',
    })
    await store.close()
  })

  test('pending abort refuses revision before reading or depositing a body', async () => {
    const store = await makeStore()
    await seedSpec(store)
    await raise(store, 'esc-spec')
    await store.append(SLUG, {
      actor: { kind: 'human', user: 'operator' },
      type: 'build.abort-requested',
      payload: {},
    })
    expect(reduceBuild(await store.getEvents(SLUG)).status).toBe('blocked')
    let read = false
    const before = await store.listArtifacts(SLUG, 'spec')
    await expect(
      controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: {},
        action: {
          kind: 'answer',
          resolve: {
            kind: 'revise-spec',
            body: {
              kind: 'supplied',
              origin: 'spec.md',
              read: async () => {
                read = true
                return CONFORMING_SPEC
              },
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'abort-pending' })
    expect(read).toBe(false)
    expect(await store.listArtifacts(SLUG, 'spec')).toEqual(before)
    await store.close()
  })

  test('discard is queued-only and duplicate requests reuse one durable fact', async () => {
    const queued = await makeStore({ active: false })
    const first = await controlBuild({
      store: queued,
      repo: REPO,
      slug: SLUG,
      env: { USER: 'discard-op' },
      action: { kind: 'discard' },
    })
    const second = await controlBuild({
      store: queued,
      repo: REPO,
      slug: SLUG,
      env: { USER: 'discard-op' },
      action: { kind: 'discard' },
    })
    expect(first).toMatchObject({ kind: 'command', command: 'discard' })
    expect(second).toMatchObject({ kind: 'command', command: 'discard' })
    const requests = (await queued.getEvents(SLUG)).filter(
      (event) => event.type === 'build.discard-requested',
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]?.actor).toEqual({ kind: 'human', user: 'discard-op' })
    await queued.close()

    const running = await makeStore()
    await expect(
      controlBuild({
        store: running,
        repo: REPO,
        slug: SLUG,
        env: {},
        action: { kind: 'discard' },
      }),
    ).rejects.toThrow(/discard requires queued/)
    await running.close()
  })

  test('rejects missing, cross-repository, and unblocked targets while abort accepts queued', async () => {
    const store = await makeStore()
    await expect(
      controlBuild({
        store,
        repo: REPO,
        slug: 'missing',
        env: {},
        action: { kind: 'pause' },
      }),
    ).rejects.toMatchObject({ code: 'not-found' })
    await expect(
      controlBuild({
        store,
        repo: '/other-repo',
        slug: SLUG,
        env: {},
        action: { kind: 'pause' },
      }),
    ).rejects.toMatchObject({ code: 'wrong-repository' })
    await expect(
      controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: {},
        action: { kind: 'answer' },
      }),
    ).rejects.toMatchObject({ code: 'no-open-escalations' })

    const queued = await makeStore({ active: false })
    expect(
      await controlBuild({
        store: queued,
        repo: REPO,
        slug: SLUG,
        env: {},
        action: { kind: 'abort' },
      }),
    ).toMatchObject({ kind: 'command', command: 'abort' })
    await store.close()
    await queued.close()
  })
})

describe('abBuildControl — sessionless repository/store shell', () => {
  const noGit: Exec = async () => ({
    stdout: '',
    stderr: 'not a git repo',
    exitCode: 128,
  })

  test('uses explicit store precedence, forwards the opaque remote token, and closes on success', async () => {
    const store = await makeStore()
    let closeCount = 0
    store.close = async () => {
      closeCount += 1
    }
    const opened: { ref: string; token?: string }[] = []

    await abBuildControl({
      targetRepo: REPO,
      env: {
        AB_STORE: 'from-env',
        AB_TOKEN: ' remote-token ',
        USER: 'shell-op',
      },
      exec: noGit,
      slug: SLUG,
      action: { kind: 'pause' },
      storeRef: 'https://store.example/control',
      openStore: (ref, token) => {
        opened.push({ ref, ...(token !== undefined ? { token } : {}) })
        return store
      },
    })

    expect(opened).toEqual([{ ref: 'https://store.example/control', token: ' remote-token ' }])
    expect(closeCount).toBe(1)
    expect((await store.getEvents(SLUG)).at(-1)?.actor).toEqual({
      kind: 'human',
      user: 'shell-op',
    })
  })

  test('falls back from AB_STORE to the repository-local store root', async () => {
    const store = await makeStore()
    store.close = async () => {}
    const opened: string[] = []
    const openStore = (ref: string): MemoryBuildStore => {
      opened.push(ref)
      return store
    }

    await abBuildControl({
      targetRepo: REPO,
      env: { AB_STORE: 'env-store' },
      exec: noGit,
      slug: SLUG,
      action: { kind: 'pause' },
      openStore,
    })
    await abBuildControl({
      targetRepo: REPO,
      env: {},
      exec: noGit,
      slug: SLUG,
      action: { kind: 'resume' },
      openStore,
    })

    expect(opened).toEqual(['/repo/env-store', '/repo/.autobuild'])
  })

  test('closes the selected store when a control precondition fails', async () => {
    const store = await makeStore()
    let closeCount = 0
    store.close = async () => {
      closeCount += 1
    }

    await expect(
      abBuildControl({
        targetRepo: REPO,
        env: { AB_STORE: 'env-store' },
        exec: noGit,
        slug: 'missing',
        action: { kind: 'pause' },
        openStore: () => store,
      }),
    ).rejects.toBeInstanceOf(BuildControlError)
    expect(closeCount).toBe(1)
  })

  test('refuses own-phase controls before opening a store but permits another build', async () => {
    const store = await makeStore()
    let opens = 0
    const openStore = (): MemoryBuildStore => {
      opens += 1
      return store
    }

    await expect(
      abBuildControl({
        targetRepo: REPO,
        env: {
          AB_SESSION: 'session-1',
          AB_BUILD: SLUG,
          AB_STORE: 'store',
        },
        exec: noGit,
        slug: SLUG,
        action: { kind: 'abort' },
        openStore,
      }),
    ).rejects.toThrow(/own phase session.*AB_SESSION\/AB_BUILD conflict/)
    expect(opens).toBe(0)

    await abBuildControl({
      targetRepo: REPO,
      env: {
        AB_SESSION: 'session-1',
        AB_BUILD: 'different-build',
        AB_STORE: 'store',
      },
      exec: noGit,
      slug: SLUG,
      action: { kind: 'abort' },
      openStore,
    })
    expect(opens).toBe(1)
    expect((await eventTypes(store)).at(-1)).toBe('build.abort-requested')
  })
})
