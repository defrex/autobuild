import { describe, expect, test } from 'bun:test'
import { agentActor, KERNEL } from '../events/envelope'
import type { EscalationSource } from '../ontology'
import type { EventType } from '../events/payloads'
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

async function makeStore(opts: {
  slug?: string
  repo?: string
  active?: boolean
} = {}): Promise<MemoryBuildStore> {
  const slug = opts.slug ?? SLUG
  const store = new MemoryBuildStore({ clock: steppingClock() })
  await store.createBuild({ slug, repo: opts.repo ?? REPO })
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
    },
  })
}

function eventTypes(store: MemoryBuildStore): Promise<string[]> {
  return store.getEvents(SLUG).then((events) => events.map((event) => event.type))
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

  test('dashboard toggles derive from freshly reduced pause and auto-merge state', async () => {
    const store = await makeStore()

    const pause = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action: { kind: 'toggle-pause' },
    })
    expect(pause).toMatchObject({ kind: 'command', command: 'pause' })

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
      action: { kind: 'toggle-pause' },
    })
    expect(resume).toMatchObject({ kind: 'command', command: 'resume' })

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

  test('a blocked pause toggle requests input and writes nothing', async () => {
    const store = await makeStore()
    await raise(store, 'esc-1')
    await raise(store, 'esc-2', 'policy')
    const before = await store.getEvents(SLUG)

    const result = await controlBuild({
      store,
      repo: REPO,
      slug: SLUG,
      env: {},
      action: { kind: 'toggle-pause' },
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
    store.append = (async (
      target: string,
      event: Parameters<BuildStore['append']>[1],
    ) => {
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
    expect(answers.map((event) => event.payload.id)).toEqual([
      'esc-first',
      'esc-second',
    ])
    await store.close()
  })

  test('rejects missing, cross-repository, inactive, and unblocked targets', async () => {
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
    await expect(
      controlBuild({
        store: queued,
        repo: REPO,
        slug: SLUG,
        env: {},
        action: { kind: 'abort' },
      }),
    ).rejects.toThrow(/not active \(status: queued\)/)
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

    expect(opened).toEqual([
      { ref: 'https://store.example/control', token: ' remote-token ' },
    ])
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
