import { prepareAssetSnapshots } from '../store/ticket-asset-snapshots'
import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import type { EventEnvelope, EventWrite } from '../events/catalog'
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
  terminalSignal,
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

async function readyLanding(store: MemoryBuildStore) {
  await store.append(SLUG, {
    actor: KERNEL,
    type: 'finalize.completed',
    payload: {
      pr: { number: 1, url: 'https://forge/1', headSha: 'head' },
    },
  })
  await store.append(SLUG, {
    actor: DISPATCHER,
    type: 'landing.decided',
    payload: {
      candidate: { head: 'head', parent: 'base', cycle: '1' },
      from: 'leaf',
      into: { kind: 'root' },
      labels: [],
      mode: 'consent',
      rule: { default: true },
    },
  })
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
      ...(source === 'policy' ? { policyCause: 'phase-attempt-limit' as const } : {}),
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
      [{ kind: 'land' }, 'build.land-requested'],
      [{ kind: 'hold' }, 'build.hold-requested'],
    ]

    for (const [action, eventType] of cases) {
      const store = await makeStore()
      if (action.kind === 'land') await readyLanding(store)
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
      expect(added[0]?.payload).toEqual(action.kind === 'land' ? { decisionSeq: before } : {})
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

    await expect(
      controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: {},
        action: { kind: 'toggle-auto-merge' },
      }),
    ).rejects.toThrow('retired')
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

  test('sets an absolute ceiling only on the matching review-limit answer while answering other blockers', async () => {
    const store = await makeStore()
    await raise(store, 'esc-agent')
    await store.append(SLUG, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: 'esc-rounds',
        phase: 'plan-review',
        round: 6,
        source: 'policy',
        policyCause: 'review-round-limit',
        question: 'round limit',
      },
    })
    const result = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: { USER: 'operator' },
      action: { kind: 'answer', text: 'continue', reviewRoundCeiling: 12 },
    })
    expect(result).toMatchObject({
      kind: 'answered',
      count: 2,
      resolution: 'guidance',
      reviewRoundCeiling: { loop: 'plan', value: 12 },
    })
    const answers = (await store.getEvents(SLUG)).filter(
      (event) => event.type === 'escalation.answered',
    )
    expect(answers[0]?.payload).not.toHaveProperty('reviewRoundCeiling')
    expect(answers[1]?.payload).toMatchObject({ id: 'esc-rounds', reviewRoundCeiling: 12 })
    expect(reduceBuild(await store.getEvents(SLUG)).reviewRoundCeilings).toEqual({ plan: 12 })
    await store.close()
  })

  test('refuses a ceiling without an exact open review-limit escalation before appending', async () => {
    const store = await makeStore()
    await raise(store, 'esc-wrong', 'policy')
    const before = await store.getEvents(SLUG)
    await expect(
      controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: {},
        action: { kind: 'answer', reviewRoundCeiling: 12 },
      }),
    ).rejects.toMatchObject({ code: 'review-round-ceiling-unavailable' })
    expect(await store.getEvents(SLUG)).toEqual(before)
    await store.close()
  })

  test('refuses a ceiling with spec revision before reading or recording the replacement', async () => {
    const store = await makeStore()
    await store.append(SLUG, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: 'esc-rounds',
        phase: 'code-review',
        round: 6,
        source: 'policy',
        policyCause: 'review-round-limit',
        question: 'round limit',
      },
    })
    const before = await store.getEvents(SLUG)
    let read = false
    await expect(
      controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: {},
        action: {
          kind: 'answer',
          reviewRoundCeiling: 12,
          resolve: {
            kind: 'revise-spec',
            body: {
              kind: 'supplied',
              origin: 'replacement.md',
              read: async () => {
                read = true
                return CONFORMING_SPEC
              },
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'incompatible-answer-options' })
    expect(read).toBe(false)
    expect(await store.getEvents(SLUG)).toEqual(before)
    await store.close()
  })

  test('a retry after a partial multi-answer failure skips the answer already recorded', async () => {
    const store = await makeStore()
    await raise(store, 'esc-first')
    await raise(store, 'esc-second')
    const originalAppend = store.appendIfCurrent.bind(store)
    let answerAttempts = 0
    store.appendIfCurrent = (async (
      target: string,
      seq: number,
      event: Parameters<BuildStore['append']>[1],
    ) => {
      if (event.type === 'escalation.answered') {
        answerAttempts += 1
        if (answerAttempts === 2) throw new Error('transient append failure')
      }
      return originalAppend(target, seq, event)
    }) as BuildStore['appendIfCurrent']

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
    ).rejects.toMatchObject({
      code: 'spec-nonconforming',
      message: expect.stringContaining('bad.md'),
    })
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
    await store.append(SLUG, { actor: KERNEL, type: 'build.paused', payload: {} })

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
    expect(state.pendingCommands.some((command) => command.command === 'resume')).toBe(false)
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

  test('paused revision appends answers, revision, then resume in that order', async () => {
    const store = await makeStore()
    await seedSpec(store)
    await raise(store, 'esc-paused')
    await store.append(SLUG, { actor: KERNEL, type: 'build.paused', payload: {} })
    const before = (await store.getEvents(SLUG)).length

    const result = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action: {
        kind: 'answer',
        resolve: {
          kind: 'revise-spec',
          body: { kind: 'supplied', origin: 'paused.md', read: async () => CONFORMING_SPEC },
        },
      },
    })

    expect(result).toMatchObject({ resolution: 'revise-spec', resumed: true })
    expect((await store.getEvents(SLUG)).slice(before).map((event) => event.type)).toEqual([
      'escalation.answered',
      'spec.revised',
      'build.resume-requested',
    ])
    await store.close()
  })

  test('refuses when PR completion lands during body preparation before revalidation', async () => {
    const store = await makeStore()
    await seedSpec(store)
    await store.append(SLUG, {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: { pr: { number: 9, url: 'https://example.test/pr/9', headSha: 'head-9' } },
    })
    await raise(store, 'esc-terminal')
    const originalPut = store.putArtifact.bind(store)
    store.putArtifact = async (target, artifact) => {
      const meta = await originalPut(target, artifact)
      await store.append(target, {
        actor: DISPATCHER,
        type: 'pr.merged',
        payload: { sha: 'merged-during-put' },
      })
      await store.append(target, {
        actor: DISPATCHER,
        type: 'build.completed',
        payload: { outcome: 'merged' },
      })
      return meta
    }

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
            body: { kind: 'supplied', origin: 'race.md', read: async () => CONFORMING_SPEC },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'no-longer-active' })
    const state = reduceBuild(await store.getEvents(SLUG))
    expect(state.status).toBe('done')
    expect(state.specRev).toBe(0)
    expect(state.openEscalations.map((item) => item.id)).toEqual(['esc-terminal'])
    expect(state.answeredEscalations).toEqual([])
    expect(await store.listArtifacts(SLUG, 'spec')).toHaveLength(2)
    await store.close()
  })

  test('terminalSignal covers status, abort, ended PR, priority, and absent outcomes', async () => {
    const store = await makeStore()
    const base = reduceBuild(await store.getEvents(SLUG))
    const abortCommand = {
      command: 'abort' as const,
      seq: 2,
      actor: { kind: 'human' as const, user: 'operator' },
    }
    expect(terminalSignal({ ...base, status: 'aborted' })).toEqual({
      kind: 'terminal-status',
      status: 'aborted',
    })
    expect(terminalSignal({ ...base, status: 'done', outcome: 'merged' })).toEqual({
      kind: 'terminal-status',
      status: 'done',
      outcome: 'merged',
    })
    expect(terminalSignal({ ...base, pendingCommands: [abortCommand] })).toEqual({
      kind: 'abort-requested',
    })
    expect(terminalSignal({ ...base, prState: 'merged' })).toEqual({
      kind: 'pr-ended',
      state: 'merged',
    })
    expect(terminalSignal({ ...base, prState: 'closed' })).toEqual({
      kind: 'pr-ended',
      state: 'closed',
    })
    expect(
      terminalSignal({
        ...base,
        status: 'aborted',
        pendingCommands: [abortCommand],
        prState: 'merged',
      }),
    ).toEqual({ kind: 'terminal-status', status: 'aborted' })
    expect(terminalSignal(base)).toBeUndefined()
    await store.close()
  })

  test('completes an authorization after every escalation was already answered', async () => {
    const store = await makeStore()
    await seedSpec(store)
    const authorized = await store.putArtifact(SLUG, { kind: 'spec', content: CONFORMING_SPEC })
    await raise(store, 'esc-only')
    await store.append(SLUG, {
      actor: { kind: 'human', user: 'operator' },
      type: 'escalation.answered',
      payload: {
        id: 'esc-only',
        answer: 'revise',
        resolution: 'revise-spec',
        artifact: { kind: 'spec', rev: authorized.revision },
      },
    })
    const before = (await store.getEvents(SLUG)).length
    const result = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action: {
        kind: 'answer',
        resolve: {
          kind: 'revise-spec',
          body: { kind: 'supplied', origin: 'unused.md', read: async () => 'unused' },
        },
      },
    })
    expect(result).toMatchObject({ authorizedEarlier: true, count: 0, specRev: 1 })
    expect((await store.getEvents(SLUG)).slice(before).map((event) => event.type)).toEqual([
      'spec.revised',
    ])
    await store.close()
  })

  test('retry after spec.revised refuses and points a still-paused build at resume', async () => {
    const store = await makeStore()
    await seedSpec(store)
    const authorized = await store.putArtifact(SLUG, { kind: 'spec', content: CONFORMING_SPEC })
    await raise(store, 'esc-finished')
    await store.append(SLUG, { actor: KERNEL, type: 'build.paused', payload: {} })
    const raised = (await store.getEvents(SLUG)).find(
      (event) => event.type === 'escalation.raised' && event.payload.id === 'esc-finished',
    )!
    await store.append(SLUG, {
      actor: { kind: 'human', user: 'operator' },
      type: 'escalation.answered',
      payload: {
        id: 'esc-finished',
        answer: 'revise',
        resolution: 'revise-spec',
        artifact: { kind: 'spec', rev: authorized.revision },
      },
    })
    await store.append(SLUG, {
      actor: KERNEL,
      type: 'spec.revised',
      payload: { artifact: { kind: 'spec', rev: authorized.revision }, escalation: raised.seq },
    })
    const before = await store.getEvents(SLUG)
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
            body: { kind: 'supplied', origin: 'unused.md', read: async () => 'unused' },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'no-open-escalations',
      message: expect.stringContaining('ab resume'),
    })
    expect(await store.getEvents(SLUG)).toEqual(before)
    await store.close()
  })

  test('an orphan deposit is inert and a completed revision can be revised again', async () => {
    const store = await makeStore()
    await seedSpec(store)
    await store.putArtifact(SLUG, { kind: 'spec', content: 'orphan' })
    await raise(store, 'esc-after-orphan')
    const second = CONFORMING_SPEC.replace('used.', 'used twice.')
    await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action: {
        kind: 'answer',
        resolve: {
          kind: 'revise-spec',
          body: { kind: 'supplied', origin: 'second.md', read: async () => second },
        },
      },
    })
    expect(reduceBuild(await store.getEvents(SLUG)).specRev).toBe(2)
    expect(new TextDecoder().decode((await store.getArtifact(SLUG, 'spec', 2))!.content)).toBe(
      second,
    )

    await raise(store, 'esc-next-revision')
    const third = CONFORMING_SPEC.replace('used.', 'used three times.')
    const result = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action: {
        kind: 'answer',
        resolve: {
          kind: 'revise-spec',
          body: { kind: 'supplied', origin: 'third.md', read: async () => third },
        },
      },
    })
    expect(result).toMatchObject({ specRev: 3 })
    expect(result).not.toHaveProperty('authorizedEarlier')
    expect(new TextDecoder().decode((await store.getArtifact(SLUG, 'spec', 3))!.content)).toBe(
      third,
    )
    await store.close()
  })

  test('dismiss refuses citations that are not findings and ticket revision names unavailable seams', async () => {
    const store = await makeStore()
    await raise(store, 'esc-path', 'stall', ['src/file.ts', 'AUT-1'])
    await expect(
      controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: {},
        action: { kind: 'answer', resolve: { kind: 'dismiss-finding' } },
      }),
    ).rejects.toMatchObject({ code: 'no-cited-findings' })
    await expect(
      controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: {},
        action: {
          kind: 'answer',
          resolve: { kind: 'revise-spec', body: { kind: 'ticket' } },
        },
      }),
    ).rejects.toMatchObject({ code: 'ticket-unavailable' })
    await store.close()

    const ticketed = await makeStore({ ticket: { source: 'fake', id: 'T-1' } })
    await raise(ticketed, 'esc-ticket-reader')
    await expect(
      controlBuild({
        store: ticketed,
        repo: REPO,
        slug: SLUG,
        env: {},
        action: {
          kind: 'answer',
          resolve: { kind: 'revise-spec', body: { kind: 'ticket' } },
        },
      }),
    ).rejects.toMatchObject({ code: 'ticket-unavailable' })
    await ticketed.close()
  })

  test('dismiss reports a terminal writer that lands after its first answer', async () => {
    const store = await makeStore()
    await store.append(SLUG, {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: { pr: { number: 10, url: 'https://example.test/pr/10', headSha: 'head-10' } },
    })
    await store.append(SLUG, {
      actor: agentActor('code-review', 'review-race'),
      type: 'code-review.verdict',
      payload: {
        round: 1,
        verdict: 'revise',
        findings: [{ id: 'f_race', severity: 'blocking', summary: 'race', persists: [] }],
        artifact: { kind: 'code-review', rev: 0 },
      },
    })
    await raise(store, 'esc-dismiss-race', 'stall', ['f_race'])
    const originalAppend = store.append.bind(store)
    let injected = false
    store.append = (async (target: string, event: Parameters<BuildStore['append']>[1]) => {
      const appended = await originalAppend(target, event)
      if (!injected && event.type === 'escalation.answered') {
        injected = true
        await originalAppend(target, {
          actor: DISPATCHER,
          type: 'pr.merged',
          payload: { sha: 'dismiss-merge' },
        })
        await originalAppend(target, {
          actor: DISPATCHER,
          type: 'build.completed',
          payload: { outcome: 'merged' },
        })
      }
      return appended
    }) as BuildStore['append']
    const result = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action: { kind: 'answer', resolve: { kind: 'dismiss-finding' } },
    })
    expect(result).toMatchObject({
      count: 1,
      terminalSignal: { kind: 'terminal-status', status: 'done', outcome: 'merged' },
    })
    expect(
      (await store.getEvents(SLUG)).some((event) => event.type === 'escalation.answered'),
    ).toBe(true)
    await store.close()
  })

  test('dismissed plan and code finding chains advance their producer loops', async () => {
    for (const loop of ['plan', 'code'] as const) {
      const store = await makeStore()
      await seedSpec(store)
      await store.append(SLUG, { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
      await store.append(SLUG, {
        actor: agentActor('plan', `${loop}-plan`),
        type: 'plan.completed',
        payload: { round: 1, artifact: { kind: 'plan', rev: 0 } },
      })
      await store.append(SLUG, {
        actor: KERNEL,
        type: 'plan-review.started',
        payload: { round: 1 },
      })
      const findingId = `f_${loop}`
      await store.append(SLUG, {
        actor: agentActor('plan-review', `${loop}-plan-review`),
        type: 'plan-review.verdict',
        payload: {
          round: 1,
          verdict: loop === 'plan' ? 'revise' : 'approve',
          findings:
            loop === 'plan'
              ? [
                  {
                    id: findingId,
                    severity: 'blocking',
                    file: 'src/shared.ts',
                    summary: 'plan issue',
                    persists: [],
                  },
                ]
              : [],
          artifact: { kind: 'plan-review', rev: 0 },
        },
      })
      if (loop === 'code') {
        await store.append(SLUG, {
          actor: KERNEL,
          type: 'implement.started',
          payload: { round: 1 },
        })
        await store.append(SLUG, {
          actor: agentActor('implement', 'code-implement'),
          type: 'implement.completed',
          payload: {
            round: 1,
            commits: { base: 'base', head: 'head' },
            artifact: { kind: 'implement-notes', rev: 0 },
          },
        })
        await store.append(SLUG, {
          actor: KERNEL,
          type: 'code-review.started',
          payload: { round: 1 },
        })
        await store.append(SLUG, {
          actor: agentActor('code-review', 'code-review'),
          type: 'code-review.verdict',
          payload: {
            round: 1,
            verdict: 'revise',
            findings: [
              {
                id: findingId,
                severity: 'blocking',
                file: 'src/shared.ts',
                summary: 'code issue',
                persists: [],
              },
            ],
            artifact: { kind: 'code-review', rev: 0 },
          },
        })
      }
      await store.append(SLUG, {
        actor: KERNEL,
        type: 'escalation.raised',
        payload: {
          id: `esc-${loop}`,
          phase: loop === 'plan' ? 'plan-review' : 'code-review',
          round: 1,
          source: 'stall',
          question: 'chain stalled',
          refs: [findingId],
        },
      })
      await controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: {},
        action: { kind: 'answer', resolve: { kind: 'dismiss-finding' } },
      })
      expect(decideNext(await store.getEvents(SLUG), ENGINE_CONFIG)).toMatchObject({
        kind: 'run-phase',
        phase: loop === 'plan' ? 'plan' : 'implement',
        round: 2,
      })

      if (loop === 'plan') {
        await store.append(SLUG, { actor: KERNEL, type: 'plan.started', payload: { round: 2 } })
        await store.append(SLUG, {
          actor: agentActor('plan', 'new-plan'),
          type: 'plan.completed',
          payload: { round: 2, artifact: { kind: 'plan', rev: 1 } },
        })
        await store.append(SLUG, {
          actor: KERNEL,
          type: 'plan-review.started',
          payload: { round: 2 },
        })
        await store.append(SLUG, {
          actor: agentActor('plan-review', 'new-plan-review'),
          type: 'plan-review.verdict',
          payload: {
            round: 2,
            verdict: 'revise',
            findings: [
              {
                id: 'f_plan_new',
                severity: 'blocking',
                file: 'src/shared.ts',
                summary: 'different plan issue',
                persists: [],
              },
            ],
            artifact: { kind: 'plan-review', rev: 1 },
          },
        })
      } else {
        await store.append(SLUG, {
          actor: KERNEL,
          type: 'implement.started',
          payload: { round: 2 },
        })
        await store.append(SLUG, {
          actor: agentActor('implement', 'new-implement'),
          type: 'implement.completed',
          payload: {
            round: 2,
            commits: { base: 'base', head: 'head-2' },
            artifact: { kind: 'implement-notes', rev: 1 },
          },
        })
        await store.append(SLUG, {
          actor: KERNEL,
          type: 'code-review.started',
          payload: { round: 2 },
        })
        await store.append(SLUG, {
          actor: agentActor('code-review', 'new-code-review'),
          type: 'code-review.verdict',
          payload: {
            round: 2,
            verdict: 'revise',
            findings: [
              {
                id: 'f_code_new',
                severity: 'blocking',
                file: 'src/shared.ts',
                summary: 'different code issue',
                persists: [],
              },
            ],
            artifact: { kind: 'code-review', rev: 1 },
          },
        })
      }
      expect(decideNext(await store.getEvents(SLUG), ENGINE_CONFIG)).toMatchObject({
        kind: 'run-phase',
        phase: loop === 'plan' ? 'plan' : 'implement',
        round: 3,
      })
      await store.close()
    }
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

  test('an active build with an in-flight discard refuses consent recording but allows withdrawal', async () => {
    // The raced-runner-attachment shape: the discard landed in the queued
    // window before the runner attached, leaving a running build that
    // carries the unsettled request. A queued build cannot reach this guard
    // (`activeState` fires first — a case below pins that). The consent here
    // predates the discard, the fan-out/claim-time-seed shape: only the
    // per-build OFF can withdraw it, so withdrawal must stay available while
    // recording stays blocked.
    const store = await makeStore()
    await store.append(SLUG, {
      actor: { kind: 'human', user: 'operator' },
      type: 'build.auto-merge-requested',
      payload: {},
    })
    await store.append(SLUG, {
      actor: { kind: 'human', user: 'discard-op' },
      type: 'build.discard-requested',
      payload: {},
    })
    const before = await store.getEvents(SLUG)

    await expect(
      controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: { USER: 'operator' },
        action: { kind: 'land' },
      }),
    ).rejects.toMatchObject({ code: 'discard-pending' })
    expect(await store.getEvents(SLUG)).toEqual(before)

    const withdrawn = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: { USER: 'operator' },
      action: { kind: 'hold' },
    })
    expect(withdrawn).toMatchObject({ kind: 'command', command: 'hold' })
    const afterOff = reduceBuild(await store.getEvents(SLUG))
    expect(afterOff.landing?.command?.kind).toBe('hold')
    expect(afterOff.discardRequest).toBeDefined()

    // Recording again after the withdrawal is still refused.
    await expect(
      controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: { USER: 'operator' },
        action: { kind: 'land' },
      }),
    ).rejects.toMatchObject({ code: 'discard-pending' })
    await store.close()
  })

  test('a discard racing the consent append is caught by the compare-and-append retry', async () => {
    // The guard reads state, then writes. A discard appended between the two
    // must not slip past: `appendIfCurrent` misses on the advanced tail, the
    // loop re-reads, and the guard fires on the fresh state — the same CAS
    // idiom the fan-out's dispatcher loop and bulk-control use. Without it,
    // the journal would hold the consent+discard pair `checkPr` merges on.
    for (const action of [{ kind: 'land' }] as const) {
      const store = await makeStore()
      await readyLanding(store)
      let injected = false
      const proxy = Object.create(store) as MemoryBuildStore
      proxy.appendIfCurrent = async <T extends EventType>(
        target: string,
        expectedSeq: number,
        event: EventWrite<T>,
      ): Promise<EventEnvelope<T> | null> => {
        if (!injected) {
          injected = true
          await store.append(SLUG, {
            actor: { kind: 'human', user: 'discard-op' },
            type: 'build.discard-requested',
            payload: {},
          })
        }
        return store.appendIfCurrent(target, expectedSeq, event)
      }
      await expect(
        controlBuild({
          store: proxy,
          repo: REPO,
          slug: SLUG,
          env: { USER: 'operator' },
          action: { ...action },
        }),
      ).rejects.toMatchObject({ code: 'discard-pending' })
      const types = (await store.getEvents(SLUG)).map((entry) => entry.type)
      expect(types).not.toContain('build.land-requested')
      expect(types).toContain('build.discard-requested')
      await store.close()
    }
  })

  test('an OFF withdrawal still lands when a discard races its append', async () => {
    // Withdrawal has no discard guard, so the CAS retry simply re-reads and
    // appends after the racing discard — consent withdrawn, discard in flight.
    const store = await makeStore()
    await store.append(SLUG, {
      actor: { kind: 'human', user: 'operator' },
      type: 'build.auto-merge-requested',
      payload: {},
    })
    let injected = false
    const proxy = Object.create(store) as MemoryBuildStore
    proxy.appendIfCurrent = async <T extends EventType>(
      target: string,
      expectedSeq: number,
      event: EventWrite<T>,
    ): Promise<EventEnvelope<T> | null> => {
      if (!injected) {
        injected = true
        await store.append(SLUG, {
          actor: { kind: 'human', user: 'discard-op' },
          type: 'build.discard-requested',
          payload: {},
        })
      }
      return store.appendIfCurrent(target, expectedSeq, event)
    }
    const withdrawn = await controlBuild({
      store: proxy,
      repo: REPO,
      slug: SLUG,
      env: { USER: 'operator' },
      action: { kind: 'hold' },
    })
    expect(withdrawn).toMatchObject({ kind: 'command', command: 'hold' })
    const after = reduceBuild(await store.getEvents(SLUG))
    expect(after.landing?.command?.kind).toBe('hold')
    expect(after.discardRequest).toBeDefined()
    await store.close()
  })

  test('a queued build with an in-flight discard still rejects consent as inactive', async () => {
    // Precedence: `activeState` fires before the discard guard, so the queued
    // window keeps its existing error.
    const store = await makeStore({ active: false })
    await store.append(SLUG, {
      actor: { kind: 'human', user: 'discard-op' },
      type: 'build.discard-requested',
      payload: {},
    })
    const before = await store.getEvents(SLUG)

    await expect(
      controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: { USER: 'operator' },
        action: { kind: 'land' },
      }),
    ).rejects.toMatchObject({ code: 'inactive' })
    expect(await store.getEvents(SLUG)).toEqual(before)
    await store.close()
  })

  test('pause and resume stay available while a discard is in flight', async () => {
    // The guard is consent-specific: other controls keep their existing shape.
    const store = await makeStore()
    await store.append(SLUG, {
      actor: { kind: 'human', user: 'discard-op' },
      type: 'build.discard-requested',
      payload: {},
    })

    const paused = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: { USER: 'operator' },
      action: { kind: 'pause' },
    })
    expect(paused).toMatchObject({ kind: 'command', command: 'pause' })
    await store.close()
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

describe('revise-spec re-pins ticket assets (SPEC §6.3)', () => {
  const ticket = { source: 'fake', id: 'T-42' }
  const enc = (text: string) => new TextEncoder().encode(text)
  const file = (name: string, text: string) => ({
    kind: 'mock',
    name,
    layout: 'file' as const,
    entries: [{ type: 'file' as const, path: name, content: enc(text) }],
  })
  const pin = (name: string, revision: number, size: number) => ({
    kind: 'mock',
    name,
    revision,
    layout: 'file' as const,
    size,
    fileCount: 1,
    dirCount: 0,
  })

  /** A build that froze `a.png` rev 0 at its claim. */
  async function pinnedStore(): Promise<MemoryBuildStore> {
    const store = await makeStore({ ticket })
    await store.putTicketAsset(REPO, ticket.id, file('a.png', 'one'))
    await store.append(SLUG, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { ticket, repo: REPO, baseBranch: 'main', assets: [pin('a.png', 0, 3)] },
    })
    await seedSpec(store)
    return store
  }

  const fromTicket: BuildControlAction = {
    kind: 'answer',
    resolve: { kind: 'revise-spec', body: { kind: 'ticket' } },
  }
  const supplied: BuildControlAction = {
    kind: 'answer',
    resolve: {
      kind: 'revise-spec',
      body: { kind: 'supplied', origin: 'spec.md', read: async () => CONFORMING_SPEC },
    },
  }
  const run = (store: MemoryBuildStore, action: BuildControlAction) =>
    controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action,
      readTicketBody: async () => CONFORMING_SPEC,
    })

  test('from the ticket re-pins the current assets on the answer and on spec.revised', async () => {
    const store = await pinnedStore()
    await store.putTicketAsset(REPO, ticket.id, file('a.png', 'two!'))
    await store.putTicketAsset(REPO, ticket.id, file('b.png', 'b'))
    await raise(store, 'esc-1')

    await run(store, fromTicket)

    const events = await store.getEvents(SLUG)
    const expected = [pin('a.png', 1, 4), pin('b.png', 0, 1)]
    expect(events.find((e) => e.type === 'escalation.answered')?.payload).toMatchObject({
      assets: expected,
    })
    expect(events.find((e) => e.type === 'spec.revised')?.payload).toMatchObject({
      assets: expected,
    })
    expect(reduceBuild(events).pinnedAssets).toEqual(expected)
    await store.close()
  })

  test('hosted re-pin snapshots separate bytes and records authorization; preparation failure writes no answer', async () => {
    const remote = new MemoryBuildStore()
    const store = await pinnedStore()
    await remote.putTicketAsset(REPO, ticket.id, file('a.png', 'hosted bytes'))
    await raise(store, 'esc-1')
    const base = {
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action: fromTicket,
      readTicketBody: async () => CONFORMING_SPEC,
    }
    await expect(
      controlBuild({
        ...base,
        prepareTicketAssets: async () => {
          throw new Error('offline')
        },
      }),
    ).rejects.toThrow('offline')
    expect((await store.getEvents(SLUG)).some((e) => e.type === 'escalation.answered')).toBe(false)
    await controlBuild({
      ...base,
      prepareTicketAssets: (ref, destination, repo) =>
        prepareAssetSnapshots(remote, destination, repo, ref.id),
    })
    await remote.removeTicketAsset(REPO, ticket.id, 'mock', 'a.png')
    const events = await store.getEvents(SLUG)
    const answer = events.find((e) => e.type === 'escalation.answered')
    const revised = events.find((e) => e.type === 'spec.revised')
    expect(
      answer?.type === 'escalation.answered' && answer.payload.assets?.[0]?.snapshot,
    ).toBeDefined()
    expect(revised?.type === 'spec.revised' && revised.payload.assets).toEqual(
      answer?.type === 'escalation.answered' ? answer.payload.assets : undefined,
    )
    const asset = await store.getPinnedTicketAsset(SLUG, 'mock', 'a.png')
    const entry = asset?.entries[0]
    expect(entry?.type === 'file' && new TextDecoder().decode(entry.content)).toBe('hosted bytes')
  })

  test('file native re-pin uses the supplied preparation callback and freezes bytes', async () => {
    const { FileTicketSource } = await import('../ports/tickets/file')
    const { preparePinnedAssets } = await import('../store/ticket-assets')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'native-repin-'))
    try {
      const source = new FileTicketSource({ dir })
      await source.create({ title: 'Source', body: CONFORMING_SPEC }, { requestedId: ticket.id })
      await source.assets.putTicketAsset(REPO, ticket.id, file('a.png', 'native bytes'))
      const store = await pinnedStore()
      await raise(store, 'esc-1')
      await controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: {},
        action: fromTicket,
        readTicketBody: async () => CONFORMING_SPEC,
        prepareTicketAssets: (ref, destination, repo) =>
          preparePinnedAssets(source, destination, repo, ref.id),
      })
      await source.assets.removeTicketAsset(REPO, ticket.id, 'mock', 'a.png')
      const asset = await store.getPinnedTicketAsset(SLUG, 'mock', 'a.png')
      expect(
        asset?.entries[0]?.type === 'file' && new TextDecoder().decode(asset.entries[0].content),
      ).toBe('native bytes')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('from the ticket re-pins to an empty set when every asset was removed', async () => {
    const store = await pinnedStore()
    await store.removeTicketAsset(REPO, ticket.id, 'mock', 'a.png')
    await raise(store, 'esc-1')

    await run(store, fromTicket)

    const events = await store.getEvents(SLUG)
    expect(events.find((e) => e.type === 'spec.revised')?.payload).toMatchObject({ assets: [] })
    expect(reduceBuild(events).pinnedAssets).toEqual([])
    await store.close()
  })

  test('a supplied body leaves the pinned assets unchanged', async () => {
    const store = await pinnedStore()
    await store.putTicketAsset(REPO, ticket.id, file('a.png', 'two!'))
    await raise(store, 'esc-1')

    await run(store, supplied)

    const events = await store.getEvents(SLUG)
    expect(events.find((e) => e.type === 'spec.revised')?.payload).not.toHaveProperty('assets')
    expect(events.find((e) => e.type === 'escalation.answered')?.payload).not.toHaveProperty(
      'assets',
    )
    expect(reduceBuild(events).pinnedAssets).toEqual([pin('a.png', 0, 3)])
    await store.close()
  })

  test('a retry after a crash publishes the originally authorized set, not the edited ticket', async () => {
    const store = await pinnedStore()
    await store.putTicketAsset(REPO, ticket.id, file('a.png', 'two!'))
    await raise(store, 'esc-1')
    const append = store.append.bind(store) as (slug: string, event: EventWrite) => Promise<unknown>
    let crash = true
    ;(store as unknown as { append: typeof append }).append = async (slug, event) => {
      if (crash && event.type === 'spec.revised') throw new Error('crash before spec.revised')
      return append(slug, event)
    }
    await expect(run(store, fromTicket)).rejects.toThrow('crash before spec.revised')
    expect((await store.getEvents(SLUG)).some((e) => e.type === 'spec.revised')).toBe(false)

    // The ticket changes again before the operator retries.
    crash = false
    await store.putTicketAsset(REPO, ticket.id, file('a.png', 'three'))
    await store.putTicketAsset(REPO, ticket.id, file('c.png', 'c'))
    await run(store, fromTicket)

    const events = await store.getEvents(SLUG)
    expect(events.find((e) => e.type === 'spec.revised')?.payload).toMatchObject({
      assets: [pin('a.png', 1, 4)],
    })
    expect(reduceBuild(events).pinnedAssets).toEqual([pin('a.png', 1, 4)])
    await store.close()
  })

  test('snapshot authorization retries reuse prepared bytes without reopening the source', async () => {
    const store = await pinnedStore()
    const remote = new MemoryBuildStore()
    await remote.putTicketAsset(REPO, ticket.id, file('a.png', 'frozen'))
    await raise(store, 'esc-1')
    const append = store.append.bind(store)
    let crash = true
    store.append = async (slug, event) => {
      if (crash && event.type === 'spec.revised') throw new Error('crash')
      return append(slug, event)
    }
    await expect(
      controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        action: fromTicket,
        readTicketBody: async () => CONFORMING_SPEC,
        prepareTicketAssets: (ref, destination, repo) =>
          prepareAssetSnapshots(remote, destination, repo, ref.id),
      }),
    ).rejects.toThrow('crash')
    await remote.removeTicketAsset(REPO, ticket.id, 'mock', 'a.png')
    crash = false
    await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      action: fromTicket,
      readTicketBody: async () => {
        throw new Error('source must stay closed')
      },
      prepareTicketAssets: async () => {
        throw new Error('source must stay closed')
      },
    })
    const asset = await store.getPinnedTicketAsset(SLUG, 'mock', 'a.png')
    const entry = asset?.entries[0]
    expect(entry?.type === 'file' && new TextDecoder().decode(entry.content)).toBe('frozen')
  })

  test('a legacy authorization without assets leaves the pins unchanged on retry', async () => {
    const store = await pinnedStore()
    await raise(store, 'esc-1')
    const meta = await store.putArtifact(SLUG, { kind: 'spec', content: CONFORMING_SPEC })
    await store.append(SLUG, {
      actor: { kind: 'human', user: 'aron' },
      type: 'escalation.answered',
      payload: {
        id: 'esc-1',
        answer: 'revise',
        resolution: 'revise-spec',
        artifact: { kind: 'spec', rev: meta.revision },
      },
    })
    await store.putTicketAsset(REPO, ticket.id, file('a.png', 'two!'))

    await run(store, fromTicket)

    const events = await store.getEvents(SLUG)
    expect(events.find((e) => e.type === 'spec.revised')?.payload).not.toHaveProperty('assets')
    expect(reduceBuild(events).pinnedAssets).toEqual([pin('a.png', 0, 3)])
    await store.close()
  })
})

async function revisionNode() {
  const store = await makeStore({ active: false, ticket: { source: 'fake', id: 'NODE' } })
  await store.append(SLUG, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      repo: REPO,
      ticket: { source: 'fake', id: 'NODE' },
      baseBranch: 'main',
      kind: 'node',
    },
  })
  await seedSpec(store)
  await store.append(SLUG, {
    actor: DISPATCHER,
    type: 'node.opened',
    payload: { sha: 'b'.repeat(40) },
  })
  await store.append(SLUG, {
    actor: DISPATCHER,
    type: 'node.compared',
    payload: { headSha: 'a'.repeat(40), parentSha: 'b'.repeat(40), ahead: 1 },
  })
  return store
}

function reviseNode(store: MemoryBuildStore, read = async () => CONFORMING_SPEC) {
  return controlBuild({
    store,
    repo: REPO,
    slug: SLUG,
    user: 'operator',
    via: { kind: 'mcp', client: 'test' },
    action: {
      kind: 'answer',
      resolve: {
        kind: 'revise-spec',
        body: { kind: 'supplied', origin: 'replacement.md', read },
      },
    },
  })
}

test('node revisions preserve history, collection and contribution state without answering escalations', async () => {
  const store = await revisionNode()
  const before = reduceBuild(await store.getEvents(SLUG))
  for (const rev of [1, 2]) {
    expect(await reviseNode(store)).toMatchObject({
      kind: 'answered',
      count: 0,
      nodeRevision: true,
      specRev: rev,
      resumed: false,
    })
    const state = reduceBuild(await store.getEvents(SLUG))
    expect(state.status).toBe('collecting')
    expect(state.specRev).toBe(rev)
    expect(state.nodeRestack).toEqual(before.nodeRestack)
    expect(state.target).toEqual(before.target)
    expect(await store.getArtifact(SLUG, 'spec', 0)).not.toBeNull()
  }
  const events = await store.getEvents(SLUG)
  expect(events.filter((e) => e.type === 'escalation.answered')).toHaveLength(0)
  expect(events.filter((e) => e.type === 'spec.revised').at(-1)).toMatchObject({
    actor: KERNEL,
    payload: {
      artifact: { kind: 'spec', rev: 2 },
      operator: { user: 'operator', via: { kind: 'mcp', client: 'test' } },
    },
  })
})

test('failed-node revision clears the reducer blocker immediately and keeps historical receipts', async () => {
  const store = await revisionNode()
  await store.append(SLUG, {
    actor: DISPATCHER,
    type: 'integration.prepared',
    payload: { id: 'old', head: 'a'.repeat(40), parent: 'b'.repeat(40), config: '{}' },
  })
  await store.append(SLUG, {
    actor: KERNEL,
    type: 'verify.completed',
    payload: {
      step: 'unit',
      attempt: 1,
      outcome: 'fail',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      restackId: 'old',
    },
  })
  expect(reduceBuild(await store.getEvents(SLUG)).status).toBe('blocked')
  await reviseNode(store)
  const facts = (await (await import('../store/reduced-reads')).readBuildFacts(store, SLUG)).value
  expect(facts.state.status).toBe('collecting')
  expect(facts.state).toEqual(reduceBuild(await store.getEvents(SLUG)))
  expect(facts.state.verify.results).toHaveLength(1)
  expect(facts.state.integration?.cycles).toHaveLength(1)
})

test('node ticket revision reads explicitly and re-pins assets while file revision preserves them', async () => {
  const store = await revisionNode()
  const assets = [
    {
      kind: 'design',
      name: 'ref',
      revision: 1,
      layout: 'file' as const,
      size: 1,
      fileCount: 1,
      dirCount: 0,
    },
  ]
  await controlBuild({
    store,
    repo: REPO,
    slug: SLUG,
    action: {
      kind: 'answer',
      resolve: { kind: 'revise-spec', body: { kind: 'ticket' } },
    },
    readTicketBody: async (ref) => {
      expect(ref.id).toBe('NODE')
      return CONFORMING_SPEC
    },
    prepareTicketAssets: async () => assets,
  })
  expect(reduceBuild(await store.getEvents(SLUG)).pinnedAssets).toEqual(assets)
  await reviseNode(store)
  expect(reduceBuild(await store.getEvents(SLUG)).pinnedAssets).toEqual(assets)
})

test('node refusal checks precede lazy reads, and races leave deposited bodies inert', async () => {
  for (const type of ['build.pause-requested', 'build.abort-requested'] as const) {
    const store = await revisionNode()
    await store.append(SLUG, { actor: { kind: 'human', user: 'test' }, type, payload: {} })
    let read = false
    await expect(
      reviseNode(store, async () => {
        read = true
        return CONFORMING_SPEC
      }),
    ).rejects.toThrow()
    expect(read).toBe(false)
  }
  for (const race of ['abort', 'verify', 'changed', 'landed'] as const) {
    const store = await revisionNode()
    await expect(
      reviseNode(store, async () => {
        if (race === 'abort')
          await store.append(SLUG, { actor: KERNEL, type: 'build.abort-requested', payload: {} })
        if (race === 'verify')
          await store.append(SLUG, {
            actor: KERNEL,
            type: 'verify.started',
            payload: { step: 'unit', attempt: 1 },
          })
        if (race === 'changed')
          await store.append(SLUG, {
            actor: DISPATCHER,
            type: 'node.compared',
            payload: { headSha: 'new', parentSha: 'b'.repeat(40), ahead: 2 },
          })
        if (race === 'landed')
          await store.append(SLUG, {
            actor: KERNEL,
            type: 'build.completed',
            payload: { outcome: 'merged' },
          })
        return CONFORMING_SPEC
      }),
    ).rejects.toThrow()
    expect(reduceBuild(await store.getEvents(SLUG)).specRev).toBe(0)
    expect((await store.getEvents(SLUG)).some((e) => e.type === 'spec.revised')).toBe(false)
  }
  const store = await revisionNode()
  await expect(reviseNode(store, async () => 'bad spec')).rejects.toMatchObject({
    code: 'spec-nonconforming',
  })
  expect((await store.getEvents(SLUG)).some((e) => e.type === 'spec.revised')).toBe(false)
})

test('interrupted deposit is inert and a retry publishes only the newly supplied node body', async () => {
  const store = await revisionNode()
  const put = store.putArtifact.bind(store)
  let interrupted = false
  store.putArtifact = async (...args) => {
    const artifact = await put(...args)
    if (!interrupted) {
      interrupted = true
      throw new Error('interrupted after deposit')
    }
    return artifact
  }
  await expect(reviseNode(store)).rejects.toThrow('interrupted')
  expect(reduceBuild(await store.getEvents(SLUG)).specRev).toBe(0)
  const replacement = CONFORMING_SPEC.replace('Replacement', 'New contract')
  expect(await reviseNode(store, async () => replacement)).toMatchObject({ specRev: 2 })
  const artifact = await store.getArtifact(SLUG, 'spec', 2)
  expect(new TextDecoder().decode(artifact!.content)).toBe(replacement)
})

test('node revision CAS refuses a state change at publication without retrying', async () => {
  const store = await revisionNode()
  const append = store.appendIfCurrent.bind(store)
  store.appendIfCurrent = async (...args) => {
    await store.append(SLUG, {
      actor: { kind: 'human', user: 'other' },
      type: 'build.abort-requested',
      payload: {},
    })
    return append(...args)
  }
  await expect(reviseNode(store)).rejects.toThrow('retry')
  expect(reduceBuild(await store.getEvents(SLUG)).specRev).toBe(0)
})

test('node publication refuses live runner or writer leases, then succeeds after release', async () => {
  for (const kind of ['runner', 'writer'] as const) {
    const store = await revisionNode()
    if (kind === 'runner') await store.claimLease(SLUG, 'busy', 60_000)
    else await store.claimNodeWriter(SLUG, 'busy', 60_000)
    await expect(reviseNode(store)).rejects.toThrow('busy')
    expect(reduceBuild(await store.getEvents(SLUG)).specRev).toBe(0)
    if (kind === 'runner') await store.releaseLease(SLUG, 'busy')
    else await store.releaseNodeWriter(SLUG, 'busy')
    expect(await reviseNode(store)).toMatchObject({ nodeRevision: true, specRev: 2 })
  }
})

test('shared CLI/operator answer validation rejects a captured cancelled verifier escalation', async () => {
  const store = await makeStore()
  await store.append(SLUG, {
    actor: KERNEL,
    type: 'verify.started',
    payload: { step: 'agent', attempt: 1 },
  })
  await store.append(SLUG, {
    actor: KERNEL,
    type: 'session.started',
    payload: {
      session: 'cancelled-agent',
      role: 'agent',
      runner: 'test',
      phase: 'verify:agent',
      round: 1,
    },
  })
  await store.append(SLUG, {
    actor: agentActor('agent', 'cancelled-agent'),
    type: 'escalation.raised',
    payload: {
      id: 'cancelled-question',
      phase: 'verify:agent',
      source: 'agent',
      question: 'question',
    },
  })
  await store.append(SLUG, {
    actor: KERNEL,
    type: 'verify.cancelled',
    payload: { step: 'agent', attempt: 1, cause: { step: 'types' } },
  })
  const before = (await store.getEvents(SLUG)).length
  for (const escalationIds of [undefined, ['cancelled-question']])
    await expect(
      controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: { USER: 'operator' },
        action: { kind: 'answer', text: 'late answer', escalationIds },
      }),
    ).rejects.toThrow('cancelled')
  expect((await store.getEvents(SLUG)).length).toBe(before)
})

test('an uncaptured answer racing fail-fast cancellation is refused at compare-and-append', async () => {
  const store = await makeStore()
  await store.append(SLUG, {
    actor: KERNEL,
    type: 'verify.started',
    payload: { step: 'agent', attempt: 1 },
  })
  await store.append(SLUG, {
    actor: KERNEL,
    type: 'session.started',
    payload: {
      session: 'raced-agent',
      role: 'agent',
      runner: 'test',
      phase: 'verify:agent',
      round: 1,
    },
  })
  await store.append(SLUG, {
    actor: agentActor('agent', 'raced-agent'),
    type: 'escalation.raised',
    payload: { id: 'raced-question', phase: 'verify:agent', source: 'agent', question: 'question' },
  })
  const append = store.appendIfCurrent.bind(store)
  let injected = false
  store.appendIfCurrent = async (slug, seq, event) => {
    if (!injected && event.type === 'escalation.answered') {
      injected = true
      await store.append(SLUG, {
        actor: KERNEL,
        type: 'verify.cancelled',
        payload: { step: 'agent', attempt: 1, cause: { step: 'types' } },
      })
    }
    return append(slug, seq, event)
  }
  await expect(
    controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action: { kind: 'answer', text: 'Proceed' },
    }),
  ).rejects.toThrow('stale')
  expect(injected).toBe(true)
  expect((await store.getEvents(SLUG)).some((event) => event.type === 'escalation.answered')).toBe(
    false,
  )
  await store.close()
})
