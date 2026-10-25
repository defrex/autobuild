import { autoMergeDeferralObservation } from '../kernel/auto-merge'
/**
 * `ab watch` tests. The pure layer (globs, cursor codec, durations, cadence,
 * record projection, human lines) is tested without IO; the shell is tested
 * over MemoryBuildStore with an injected opener, clock, and delay seam — no
 * live service, no real sleeps. Every end condition (timeout, count,
 * terminal, signal) is driven deterministically through those seams.
 */
import { describe, expect, test } from 'bun:test'
import { DISPATCHER, KERNEL, agentActor, humanActor } from '../events/envelope'
import { validateRepositoryEventWrite } from '../events/repository'
import { EVENT_TYPES } from '../events/payloads'
import { manualClock, steppingClock } from '../testing/fixed'
import type { Exec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import { InvalidAmbientContextError } from './env'
import { runCli } from './main'
import { PhaseSessionError, scopeLocalStoreToPhaseSession } from '../store/phase-session'
import type { BuildStore } from '../store/types'
import {
  abWatch,
  compileEventGlobs,
  decodeCursor,
  encodeCursor,
  parseDurationMs,
  renderWatchLine,
  WATCH_USAGE,
  watchSelection,
  type AbWatchOpts,
} from './watch'

const REPO = '/main/repo'
const ESCALATION = {
  id: 'esc_1',
  phase: 'implement',
  round: 1,
  source: 'agent',
  question: 'Which auth store?',
} as const

const fakeExec: Exec = async (cmd) =>
  cmd[1] === 'remote'
    ? // No origin remote: identity falls back to the resolved checkout path.
      { stdout: '', stderr: "error: No such remote 'origin'\n", exitCode: 2 }
    : {
        stdout: `${REPO}/.git\n${REPO}/.git\n${REPO}\n`,
        stderr: '',
        exitCode: 0,
      }

function makeStore(): MemoryBuildStore {
  return new MemoryBuildStore({ clock: steppingClock() })
}

async function seedRunningBuild(store: MemoryBuildStore, slug: string): Promise<void> {
  await store.createBuild({ slug, repo: REPO })
  await store.append(slug, {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'i1', host: 'h1', resumedFromSeq: 0 },
  })
}

async function appendEscalation(store: MemoryBuildStore, slug: string): Promise<void> {
  await store.append(slug, {
    actor: agentActor('implement', 's_1'),
    type: 'escalation.raised',
    payload: { ...ESCALATION },
  })
}

async function appendGateDeferral(store: MemoryBuildStore, slug: string, pr: number) {
  const command = await store.append(slug, {
    actor: humanActor('operator'),
    type: 'build.auto-merge-requested',
    payload: {},
  })
  await store.append(
    slug,
    autoMergeDeferralObservation(
      { code: 'repository-auto-merge-disabled', detail: 'disabled' },
      pr,
      command.seq,
      `gate-${command.seq}`,
    ),
  )
}

interface Harness {
  out: string[]
  err: string[]
  clock: ReturnType<typeof manualClock>
  base: AbWatchOpts
  openCount: () => number
}

function harness(
  store: MemoryBuildStore,
  overrides: Partial<AbWatchOpts> & {
    openStore?: (ref: string) => BuildStore
    onTick?: () => Promise<void> | void
  } = {},
): Harness {
  const out: string[] = []
  const err: string[] = []
  const clock = manualClock()
  let opened = 0
  const opener =
    overrides.openStore ??
    (() => {
      opened += 1
      return store
    })
  const onTick = overrides.onTick
  const base: AbWatchOpts = {
    targetRepo: REPO,
    env: {},
    exec: fakeExec,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    openStore: (ref, token) => opener(ref, token),
    now: clock,
    // One tick per delay call; each advances the clock 1s so a --timeout of
    // `n` seconds ends the watch after exactly n ticks. `onTick` runs side
    // effects (mid-watch appends) at the same deterministic boundary.
    delay: async () => {
      if (onTick !== undefined) await onTick()
      clock.advance(1000)
    },
    json: true,
    ...overrides,
  }
  return { out, err, clock, base, openCount: () => opened }
}

const alreadyAborted = (): AbortSignal => AbortSignal.abort()

describe('watch glob compilation', () => {
  const usage = WATCH_USAGE

  test('anchored glob semantics: * any run, ? exactly one, dots verbatim', () => {
    const escalation = compileEventGlobs(['escalation.*'], { repository: false, usage })[0]!
    expect(escalation.test('escalation.raised')).toBe(true)
    expect(escalation.test('escalation.answered')).toBe(true)
    expect(escalation.test('build.completed')).toBe(false)

    const question = compileEventGlobs(['pr.merge?'], { repository: false, usage })[0]!
    expect(question.test('pr.merged')).toBe(true)
    expect(question.test('pr.closed')).toBe(false)
    expect(question.test('pr.mergedX')).toBe(false)

    const star = compileEventGlobs(['*'], { repository: false, usage })[0]!
    expect(EVENT_TYPES.every((type) => star.test(type))).toBe(true)

    // A dot in the pattern must not become a wildcard.
    const literal = compileEventGlobs(['pr.merged'], { repository: false, usage })[0]!
    expect(literal.test('prXmerged')).toBe(false)
  })

  test('each glob must match the applicable catalog, and the error names the glob', () => {
    expect(() => compileEventGlobs(['bogus.*'], { repository: false, usage })).toThrow(
      '--event "bogus.*"',
    )
    expect(() => compileEventGlobs(['bogus.*'], { repository: false, usage })).toThrow(usage)

    // Repository-only globs need --repository; with it they validate.
    expect(() => compileEventGlobs(['harvest.*'], { repository: false, usage })).toThrow(
      '--event "harvest.*"',
    )
    expect(() => compileEventGlobs(['harvest.*'], { repository: true, usage })).not.toThrow()
    expect(() => compileEventGlobs(['pr.*'], { repository: true, usage })).not.toThrow()
  })

  test('an invalid glob fails before the store is opened and nothing reaches stdout', async () => {
    const store = makeStore()
    const h = harness(store)
    await expect(abWatch({ ...h.base, events: ['bogus.*'] })).rejects.toThrow('bogus.*')
    expect(h.openCount()).toBe(0)
    expect(h.out).toEqual([])
  })

  test('any --event replaces the attention set rather than adding to it', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    let calls = 0
    const h = harness(store, {
      onTick: async () => {
        calls += 1
        if (calls === 1) {
          await store.append('b1', {
            actor: agentActor('plan', 's_1'),
            type: 'plan.completed',
            payload: { round: 1, artifact: { kind: 'plan', rev: 0 } },
          })
        }
        if (calls === 2) await appendEscalation(store, 'b1')
      },
    })
    await abWatch({
      ...h.base,
      slugs: ['b1'],
      events: ['plan.*'],
      timeout: '1',
    })
    const types = h.out
      .slice(0, -1)
      .map((line) => (JSON.parse(line) as { event: { type: string } }).event.type)
    expect(types).toEqual(['plan.completed'])
  })
})

describe('watch attention-set defaults', () => {
  test('dispatcher no-progress escalation enters default attention with its diagnostic', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    const question =
      '3 consecutive executions ended normally without build progress. Dispatcher expected run-check unit (attempt 1).'
    let appended = false
    const h = harness(store, {
      onTick: async () => {
        if (appended) return
        appended = true
        await store.append('b1', {
          actor: DISPATCHER,
          type: 'escalation.raised',
          payload: {
            id: 'empty',
            phase: 'setup',
            source: 'policy',
            policyCause: 'execution-no-progress',
            question,
          },
        })
      },
    })
    await abWatch({ ...h.base, slugs: ['b1'], timeout: '2' })
    const records = h.out.slice(0, -1).map((line) => JSON.parse(line))
    expect(records).toHaveLength(1)
    expect(records[0].event.payload.policyCause).toBe('execution-no-progress')
    expect(records[0].state).toMatchObject({
      status: 'blocked',
      openEscalations: [{ id: 'empty', question }],
    })
  })

  test('only attention events are emitted, in order, with the reduction after each', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    let calls = 0
    const h = harness(store, {
      onTick: async () => {
        calls += 1
        if (calls === 1) await appendEscalation(store, 'b1')
        if (calls === 2) {
          await store.append('b1', {
            actor: agentActor('plan', 's_1'),
            type: 'plan.completed',
            payload: { round: 1, artifact: { kind: 'plan', rev: 0 } },
          })
        }
        if (calls === 3) {
          await store.append('b1', {
            actor: DISPATCHER,
            type: 'build.completed',
            payload: { outcome: 'merged' },
          })
        }
      },
    })
    await abWatch({ ...h.base, slugs: ['b1'], timeout: '3' })

    const records = h.out.slice(0, -1).map(
      (line) =>
        JSON.parse(line) as {
          build: string
          event: { type: string; seq: number; payload: Record<string, unknown> }
          state: Record<string, unknown>
          cursor: string
        },
    )
    expect(records.map((record) => record.event.type)).toEqual(['escalation.raised'])
    expect(records[0]).toMatchObject({
      build: 'b1',
      state: {
        status: 'blocked',
        phase: null,
        round: 0,
        openEscalations: [{ id: 'esc_1', question: 'Which auth store?' }],
        pr: null,
        prState: null,
        outcome: null,
      },
    })
    expect(
      decodeCursor(JSON.parse(h.out.at(-1)!).cursor, { store: `${REPO}/.autobuild`, repo: REPO })
        .streams.b1,
    ).toBe(4)
    // The envelope is complete and passed through unchanged.
    expect(records[0]!.event).toMatchObject({ seq: 2, payload: { ...ESCALATION } })
  })

  test('default and explicit repository watches emit repository attention', async () => {
    const seeded = makeStore()
    await seeded.createBuild({ slug: 'b1', repo: REPO })
    await seeded.ensureRepo(REPO)
    await seeded.appendRepo(REPO, {
      actor: KERNEL,
      type: 'harvest.escalated',
      payload: {
        run: 'h1',
        source: 'agent',
        reason: 'stalled',
        observations: [{ build: 'b1', seq: 1 }],
      },
    })

    // Without --repository: nothing from the journal is ever emitted.
    const quiet = harness(seeded, {
      onTick: async () => {
        await seeded.appendRepo(REPO, {
          actor: DISPATCHER,
          type: 'dispatcher.config-rejected',
          payload: { run: 'r1', error: 'boom' },
        })
      },
    })
    await abWatch({ ...quiet.base, timeout: '1' })
    expect(quiet.out.slice(0, -1).map((line) => JSON.parse(line).event.type)).toEqual([
      'dispatcher.config-rejected',
    ])

    // With --repository: attention events from after the baseline are emitted.
    const loud = harness(seeded, {
      onTick: async () => {
        await seeded.appendRepo(REPO, {
          actor: DISPATCHER,
          type: 'dispatcher.config-rejected',
          payload: { run: 'r2', error: 'boom again' },
        })
      },
    })
    await abWatch({ ...loud.base, repository: true, timeout: '1' })
    const records = loud.out.slice(0, -1).map(
      (line) =>
        JSON.parse(line) as {
          build: string | null
          repo?: string
          event: { type: string }
          state: unknown
        },
    )
    // The pre-existing harvest.escalated stays history; the mid-watch tick
    // failure is the one attention event.
    expect(records.map((record) => record.event.type)).toEqual(['dispatcher.config-rejected'])
    expect(records[0]).toMatchObject({ build: null, repo: REPO, state: null })
  })
})

describe('watch dynamic membership', () => {
  test('a build created mid-watch joins without a restart and replays no history', async () => {
    const store = makeStore()
    let calls = 0
    const h = harness(store, {
      onTick: async () => {
        calls += 1
        if (calls === 1) {
          await seedRunningBuild(store, 'late')
          await appendEscalation(store, 'late')
        }
        if (calls === 2) {
          await store.append('late', {
            actor: DISPATCHER,
            type: 'build.completed',
            payload: { outcome: 'merged' },
          })
        }
      },
    })
    await abWatch({ ...h.base, events: ['*'], timeout: '3' })

    const records = h.out.slice(0, -1).map(
      (line) =>
        JSON.parse(line) as {
          build: string
          event: { type: string; seq: number }
          cursor: string
        },
    )
    // The escalation appended before discovery is history; the watch joins at
    // the build's current position and emits only what lands after.
    expect(records.map((record) => record.event.type)).toEqual(['build.completed'])
    expect(records[0]).toMatchObject({ build: 'late', event: { seq: 3 } })
    expect(
      decodeCursor(records[0]!.cursor, { store: `${REPO}/.autobuild`, repo: REPO }).streams,
    ).toEqual({ late: 3, '#repo': 0 })
  })

  test('a legacy checkout-path-keyed record joins via its normalized repoOrigin', async () => {
    const store = makeStore()
    // Legacy record keyed by an old checkout path: only the fallback arm of
    // the identity rule — the record's normalized `repoOrigin` — can match.
    await store.createBuild({ slug: 'legacy', repo: '/old/checkouts/app', repoOrigin: REPO })
    await store.append('legacy', {
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: 'i1', host: 'h1', resumedFromSeq: 0 },
    })
    let calls = 0
    const h = harness(store, {
      onTick: async () => {
        calls += 1
        if (calls === 1) await appendEscalation(store, 'legacy')
      },
    })
    await abWatch({ ...h.base, timeout: '2' })
    const records = h.out.slice(0, -1).map((line) => JSON.parse(line) as { build: string })
    expect(records.map((record) => record.build)).toEqual(['legacy'])
  })

  test('a record whose repoOrigin is an ssh-spelled variant of the origin still joins', async () => {
    // The watch's identity is the https origin; the legacy record's stored
    // origin is scp-like ssh from an older writer vintage. Re-normalizing the
    // recorded side keeps writer vintage from deciding membership.
    const exec: Exec = async (cmd) =>
      cmd[1] === 'remote'
        ? { stdout: 'https://github.com/acme/app.git\n', stderr: '', exitCode: 0 }
        : { stdout: `${REPO}/.git\n${REPO}/.git\n${REPO}\n`, stderr: '', exitCode: 0 }
    const store = makeStore()
    await store.createBuild({
      slug: 'legacy',
      repo: '/old/checkouts/app',
      repoOrigin: 'git@github.com:acme/app.git',
    })
    await store.append('legacy', {
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: 'i1', host: 'h1', resumedFromSeq: 0 },
    })
    let calls = 0
    const h = harness(store, {
      exec,
      onTick: async () => {
        calls += 1
        if (calls === 1) await appendEscalation(store, 'legacy')
      },
    })
    await abWatch({ ...h.base, timeout: '2' })
    const records = h.out.slice(0, -1).map((line) => JSON.parse(line) as { build: string })
    expect(records.map((record) => record.build)).toEqual(['legacy'])
  })

  test('a record with a foreign repoOrigin does not join the watch', async () => {
    const store = makeStore()
    await store.createBuild({ slug: 'legacy', repo: '/old/checkouts/app', repoOrigin: REPO })
    await store.createBuild({
      slug: 'foreign',
      repo: '/old/checkouts/app',
      repoOrigin: '/other/repo',
    })
    for (const slug of ['legacy', 'foreign']) {
      await store.append(slug, {
        actor: KERNEL,
        type: 'runner.attached',
        payload: { instance: 'i1', host: 'h1', resumedFromSeq: 0 },
      })
    }
    let calls = 0
    const h = harness(store, {
      onTick: async () => {
        calls += 1
        if (calls === 1) {
          await appendEscalation(store, 'legacy')
          await appendEscalation(store, 'foreign')
        }
      },
    })
    await abWatch({ ...h.base, timeout: '2' })
    const records = h.out.slice(0, -1).map((line) => JSON.parse(line) as { build: string })
    // Only the matching record's event is delivered; the foreign-origin
    // record is invisible to membership discovery.
    expect(records.map((record) => record.build)).toEqual(['legacy'])
  })

  test('a path-mismatched record with no repoOrigin does not join the watch', async () => {
    const store = makeStore()
    // The plain first-arm mismatch: neither identity arm applies — the first
    // arm sees a different checkout path and the fallback arm has no
    // `repoOrigin` to forgive it — so the record is invisible to discovery.
    await seedRunningBuild(store, 'own')
    await store.createBuild({ slug: 'elsewhere', repo: '/other/path' })
    await store.append('elsewhere', {
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: 'i1', host: 'h1', resumedFromSeq: 0 },
    })
    let calls = 0
    const h = harness(store, {
      onTick: async () => {
        calls += 1
        if (calls === 1) {
          await appendEscalation(store, 'own')
          await appendEscalation(store, 'elsewhere')
        }
      },
    })
    await abWatch({ ...h.base, timeout: '2' })
    const records = h.out.slice(0, -1).map((line) => JSON.parse(line) as { build: string })
    expect(records.map((record) => record.build)).toEqual(['own'])
  })

  test('with no slugs, an empty active set does not end the watch', async () => {
    const store = makeStore()
    const h = harness(store)
    await abWatch({ ...h.base, timeout: '2' })
    // The watch survived two full discovery ticks before the timeout ended it.
    expect(h.out).toEqual([expect.stringMatching(/^\{"cursor":/)])
    expect(h.err).toEqual([])
  })
})

describe('watch cursor resume', () => {
  test('a cursor delivers each matching event exactly once, including the backlog', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')

    // Run 1: one matching event, then the count ends the watch.
    let calls = 0
    const first = harness(store, {
      onTick: async () => {
        calls += 1
        if (calls === 1) await appendEscalation(store, 'b1')
      },
    })
    await abWatch({
      ...first.base,
      events: ['escalation.raised', 'phase.failed', 'build.completed'],
      slugs: ['b1'],
      count: 1,
    })
    const records1 = first.out
      .slice(0, -1)
      .map((line) => JSON.parse(line) as { event: { seq: number } })
    expect(records1.map((record) => record.event.seq)).toEqual([2])
    const cursor1 = (JSON.parse(first.out.at(-1)!) as { cursor: string }).cursor

    // Events land while no watch is running — a matching one and a
    // non-matching one.
    await store.append('b1', {
      actor: KERNEL,
      type: 'phase.failed',
      payload: { phase: 'implement', round: 1, attempt: 1, error: 'boom', willRetry: false },
    })
    await store.append('b1', {
      actor: agentActor('plan', 's_1'),
      type: 'plan.completed',
      payload: { round: 1, artifact: { kind: 'plan', rev: 0 } },
    })

    // Run 2: the backlog is delivered exactly once, in seq order.
    const second = harness(store, { signal: alreadyAborted() })
    await abWatch({
      ...second.base,
      events: ['escalation.raised', 'phase.failed', 'build.completed'],
      slugs: ['b1'],
      since: cursor1,
    })
    const records2 = second.out
      .slice(0, -1)
      .map((line) => JSON.parse(line) as { event: { type: string; seq: number } })
    expect(records2.map((record) => record.event.type)).toEqual(['phase.failed'])
    expect(records2.map((record) => record.event.seq)).toEqual([3])

    // Run 3: the cursor from run 2's final position now delivers nothing new.
    const cursor2 = (JSON.parse(second.out.at(-1)!) as { cursor: string }).cursor
    const third = harness(store, { signal: alreadyAborted() })
    await abWatch({
      ...third.base,
      events: ['escalation.raised', 'phase.failed', 'build.completed'],
      slugs: ['b1'],
      since: cursor2,
    })
    expect(third.out.slice(0, -1)).toEqual([])
  })

  test('a resumed backlog record carries the reduction after ITS event, not the final state', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')

    // A gap holding several matching backlog events: the first record's state
    // must not be the reduction of the events that landed after it.
    await appendEscalation(store, 'b1') // seq 2 — attention
    await store.append('b1', {
      actor: humanActor('op'),
      type: 'escalation.answered',
      payload: { id: 'esc_1', answer: 'use sqlite', resolution: 'guidance' },
    }) // seq 3 — outside the attention set
    await store.append('b1', {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    }) // seq 4 — attention

    const cursor = encodeCursor({
      v: 1,
      store: `${REPO}/.autobuild`,
      repo: REPO,
      streams: { b1: 1 },
    })
    const h = harness(store, { signal: alreadyAborted() })
    await abWatch({
      ...h.base,
      events: ['escalation.raised', 'phase.failed', 'build.completed'],
      slugs: ['b1'],
      since: cursor,
    })
    const records = h.out.slice(0, -1).map(
      (line) =>
        JSON.parse(line) as {
          event: { type: string; seq: number }
          state: {
            status: string
            openEscalations: { id: string; question: string }[]
            outcome: string | null
          }
        },
    )

    expect(records.map((record) => record.event.seq)).toEqual([2, 4])
    // The escalation.raised record is the state as of seq 2 — blocked, with
    // the escalation still open and no outcome — not the state leaked from
    // the answered escalation and the completion that followed it.
    expect(records[0]!.state).toEqual(
      expect.objectContaining({
        status: 'blocked',
        openEscalations: [{ id: 'esc_1', question: ESCALATION.question }],
        outcome: null,
      }),
    )
    // The build.completed record is the reduction after it.
    expect(records[1]!.state).toEqual(
      expect.objectContaining({ status: 'done', openEscalations: [], outcome: 'merged' }),
    )
  })

  test('a count-tripped cursor never skips events read in the same tick', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    let calls = 0
    const h = harness(store, {
      onTick: async () => {
        calls += 1
        if (calls === 1) {
          await appendEscalation(store, 'b1')
          await store.append('b1', {
            actor: KERNEL,
            type: 'phase.failed',
            payload: { phase: 'implement', attempt: 1, error: 'boom', willRetry: false },
          })
        }
      },
    })
    await abWatch({ ...h.base, events: ['*'], slugs: ['b1'], count: 1 })
    const cursor = (JSON.parse(h.out.at(-1)!) as { cursor: string }).cursor
    expect(decodeCursor(cursor, { store: `${REPO}/.autobuild`, repo: REPO }).streams).toEqual({
      b1: 2,
    })

    // The phase.failed read in the same tick is redelivered, not skipped.
    const resume = harness(store, { signal: alreadyAborted() })
    await abWatch({ ...resume.base, events: ['*'], slugs: ['b1'], since: cursor })
    const records = resume.out
      .slice(0, -1)
      .map((line) => JSON.parse(line) as { event: { type: string; seq: number } })
    expect(records.map((record) => record.event)).toEqual([
      expect.objectContaining({ type: 'phase.failed', seq: 3 }),
    ])
  })

  test('a cursor from a different store or repository is rejected before any read', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')

    const foreignStore = encodeCursor({
      v: 1,
      store: 'https://other.example.com/store',
      repo: REPO,
      streams: { b1: 1 },
    })
    const foreignRepo = encodeCursor({
      v: 1,
      store: `${REPO}/.autobuild`,
      repo: '/other/repo',
      streams: { b1: 1 },
    })
    for (const [cursor, detail] of [
      [foreignStore, 'store "https://other.example.com/store"'],
      [foreignRepo, 'repository "/other/repo"'],
    ] as const) {
      const h = harness(store)
      await expect(abWatch({ ...h.base, slugs: ['b1'], since: cursor })).rejects.toThrow(detail)
      // Rejected before any event read: nothing reached stdout.
      expect(h.out).toEqual([])
    }
  })

  test('a --repository baseline cursor records the journal position, so a resume replays no history', async () => {
    const store = makeStore()
    await store.ensureRepo(REPO)
    // Pre-existing journal history the watch must never replay.
    await store.appendRepo(REPO, {
      actor: KERNEL,
      type: 'harvest.escalated',
      payload: {
        run: 'h0',
        source: 'agent',
        reason: 'stalled',
        observations: [{ build: 'b1', seq: 1 }],
      },
    })

    // Run 1: a fresh --repository watch emits nothing, and its final cursor
    // carries the journal baseline (seq 1), not 0.
    const first = harness(store)
    await abWatch({ ...first.base, events: ['*'], repository: true, timeout: '1' })
    expect(first.out.slice(0, -1)).toEqual([])
    const cursor = (JSON.parse(first.out.at(-1)!) as { cursor: string }).cursor
    expect(decodeCursor(cursor, { store: `${REPO}/.autobuild`, repo: REPO }).streams).toEqual({
      '#repo': 1,
    })

    // Run 2: resuming from that cursor delivers no pre-watch history.
    const second = harness(store)
    await abWatch({ ...second.base, events: ['*'], repository: true, since: cursor, timeout: '1' })
    expect(second.out.slice(0, -1)).toEqual([])

    // Run 3: a journal event appended after the baseline is delivered exactly once.
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.tick-failed',
      payload: { run: 'r1', error: 'boom' },
    })
    const third = harness(store)
    await abWatch({ ...third.base, events: ['*'], repository: true, since: cursor, timeout: '1' })
    const records = third.out
      .slice(0, -1)
      .map((line) => JSON.parse(line) as { event: { type: string; seq: number } })
    expect(records.map((record) => record.event)).toEqual([
      expect.objectContaining({ type: 'dispatcher.tick-failed', seq: 2 }),
    ])
  })
})

describe('watch exit conditions', () => {
  test('the timeout ends the watch with a resumable cursor', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    const h = harness(store)
    await abWatch({ ...h.base, slugs: ['b1'], timeout: '2' })
    const last = JSON.parse(h.out.at(-1)!) as Record<string, unknown>
    expect(Object.keys(last)).toEqual(['cursor'])
    expect(
      decodeCursor(last.cursor as string, { store: `${REPO}/.autobuild`, repo: REPO }).streams,
    ).toEqual({ b1: 1 })
  })

  test('a named build reaching terminal status ends the watch', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    let calls = 0
    const h = harness(store, {
      onTick: async () => {
        calls += 1
        if (calls === 1) {
          await store.append('b1', {
            actor: DISPATCHER,
            type: 'build.completed',
            payload: { outcome: 'merged' },
          })
        }
      },
    })
    await abWatch({ ...h.base, slugs: ['b1'], timeout: '0' })
    const types = h.out
      .slice(0, -1)
      .map((line) => (JSON.parse(line) as { event: { type: string } }).event.type)
    expect(types).toEqual([])
    // Only one tick was needed: the terminal rule ended the watch before any
    // further sleep.
    expect(calls).toBe(1)
  })

  test('an already-terminal named set exits after emitting the --since backlog', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    await store.append('b1', {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
    const cursor = encodeCursor({
      v: 1,
      store: `${REPO}/.autobuild`,
      repo: REPO,
      streams: { b1: 1 },
    })
    let delayCalls = 0
    const h = harness(store, {
      onTick: async () => {
        delayCalls += 1
      },
    })
    await abWatch({ ...h.base, events: ['*'], slugs: ['b1'], since: cursor })
    const types = h.out
      .slice(0, -1)
      .map((line) => (JSON.parse(line) as { event: { type: string } }).event.type)
    expect(types).toEqual(['build.completed'])
    expect(delayCalls).toBe(0)
  })
})

describe('watch record emission', () => {
  test('each record is flushed as its own stdout call; the last line is the bare cursor', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    let calls = 0
    const h = harness(store, {
      onTick: async () => {
        calls += 1
        if (calls === 1) await appendEscalation(store, 'b1')
        if (calls === 2) {
          await store.append('b1', {
            actor: KERNEL,
            type: 'phase.failed',
            payload: { phase: 'implement', attempt: 1, error: 'boom', willRetry: false },
          })
        }
      },
    })
    await abWatch({ ...h.base, events: ['*'], slugs: ['b1'], timeout: '2' })
    expect(h.out).toHaveLength(3)
    for (const line of h.out.slice(0, -1)) {
      const record = JSON.parse(line) as Record<string, unknown>
      expect(Object.keys(record)).toEqual(['build', 'event', 'state', 'cursor'])
    }
    expect(Object.keys(JSON.parse(h.out.at(-1)!))).toEqual(['cursor'])
  })

  test('the human form is one ANSI-free line per record and no cursor line', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    let calls = 0
    const h = harness(store, {
      json: false,
      onTick: async () => {
        calls += 1
        if (calls === 1) await appendEscalation(store, 'b1')
      },
    })
    await abWatch({ ...h.base, slugs: ['b1'], timeout: '1' })
    expect(h.out).toHaveLength(1)
    const [line] = h.out
    expect(line).not.toMatch(/\x1b[\d;]*/)
    expect(line).toContain('b1')
    expect(line).toContain('escalation.raised')
    expect(line).toContain('esc_1: Which auth store?')
  })

  test('renderWatchLine keeps multiline payload text on one line, control bytes inert', () => {
    const line = renderWatchLine(
      {
        build: 'b1',
        seq: 2,
        ts: '2026-07-15T12:00:00.000Z',
        actor: agentActor('implement', 's_1'),
        type: 'escalation.raised',
        payload: { ...ESCALATION, question: 'line one\nline two' },
      },
      null,
    )
    expect(line).toBe(
      '2026-07-15T12:00:00.000Z  b1  escalation.raised  esc_1: line one\\u{a}line two',
    )
  })
})

describe('watch ambient scope', () => {
  const ambientEnv = {
    AB_STORE: '/tmp/some-store',
    AB_BUILD: 'b1',
    AB_PHASE: 'implement@1',
    AB_SESSION: 's_1',
  }

  async function realScopeError(action: (scoped: BuildStore) => Promise<unknown>): Promise<string> {
    const scoped = scopeLocalStoreToPhaseSession(new MemoryBuildStore(), {
      kind: 'build',
      id: 'b1',
      session: 's_1',
    })
    try {
      await action(scoped)
    } catch (error) {
      return (error as Error).message
    }
    return ''
  }

  test('the no-slug form is denied exactly as the store handle denies listBuilds', async () => {
    const store = makeStore()
    const h = harness(store)
    const error = await abWatch({ ...h.base, env: ambientEnv }).catch(
      (caught: unknown) => caught as Error,
    )
    expect(error).toBeInstanceOf(PhaseSessionError)
    expect(error!.message).toBe(await realScopeError((scoped) => scoped.listBuilds()))
    expect(h.openCount()).toBe(0)
  })

  test('a foreign slug is denied exactly as the handle denies getEvents on it', async () => {
    const store = makeStore()
    const h = harness(store)
    const error = await abWatch({ ...h.base, env: ambientEnv, slugs: ['other'] }).catch(
      (caught: unknown) => caught as Error,
    )
    expect(error).toBeInstanceOf(PhaseSessionError)
    expect(error!.message).toBe(await realScopeError((scoped) => scoped.getEvents('other')))
    expect(h.openCount()).toBe(0)
  })

  test('--repository is denied exactly as the no-slug form', async () => {
    const store = makeStore()
    const h = harness(store)
    const error = await abWatch({
      ...h.base,
      env: ambientEnv,
      slugs: ['b1'],
      repository: true,
    }).catch((caught: unknown) => caught as Error)
    expect(error).toBeInstanceOf(PhaseSessionError)
    expect(error!.message).toBe(await realScopeError((scoped) => scoped.listBuilds()))
    expect(h.openCount()).toBe(0)
  })

  test('the ambient build itself may be watched through the scoped handle', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    let calls = 0
    const h = harness(store, {
      env: ambientEnv,
      onTick: async () => {
        calls += 1
        if (calls === 1) await appendEscalation(store, 'b1')
      },
    })
    await abWatch({ ...h.base, slugs: ['b1'], count: 1 })
    const types = h.out
      .slice(0, -1)
      .map((line) => (JSON.parse(line) as { event: { type: string } }).event.type)
    expect(types).toEqual(['escalation.raised'])
  })

  test('malformed or partial ambient identity fails closed before the store is opened', async () => {
    const store = makeStore()
    for (const env of [
      { AB_BUILD: 'b1' },
      { AB_PHASE: 'implement@1' },
      { AB_BUILD: 'b1', AB_PHASE: 'implement@1' },
    ]) {
      const h = harness(store)
      await expect(abWatch({ ...h.base, env, slugs: ['b1'] })).rejects.toBeInstanceOf(
        InvalidAmbientContextError,
      )
      expect(h.openCount()).toBe(0)
    }
  })
})

// ── Discovery's digest-bounded terminal filter (AUT-545) ────────────────────

describe('watch discovery bounds terminal-build reads with the AUT-487 digest (AUT-545)', () => {
  /** A counting proxy over getEvents (immediate reads) and the digest batch
   * read — the watch mirror of the wait's, per the established parity. */
  function countingStore(store: MemoryBuildStore): {
    store: BuildStore
    eventsBySlug: () => Map<string, number>
    digestReads: () => number
  } {
    const eventsBySlug = new Map<string, number>()
    let digests = 0
    const fake: BuildStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'getReducerValue') {
          return async (...args: Parameters<BuildStore['getReducerValue']>) => {
            if (args[0].kind === 'build' && args[1].reducer === 'buildStreamSeed') {
              const slug = args[0].slug
              eventsBySlug.set(slug, (eventsBySlug.get(slug) ?? 0) + 1)
            }
            return target.getReducerValue(...args)
          }
        }
        if (prop === 'getEvents') {
          return async (slug: string, sinceSeq?: number) => {
            expect(sinceSeq).toBeDefined()
            return target.getEvents(slug, sinceSeq)
          }
        }
        if (prop === 'getRepoBuildDigests') {
          return async (repo: string) => {
            digests += 1
            return (target as MemoryBuildStore).getRepoBuildDigests(repo)
          }
        }
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value
      },
    })
    return { store: fake, eventsBySlug: () => eventsBySlug, digestReads: () => digests }
  }

  /** Seed one terminal build over a digest-contract lifecycle shape. */
  async function seedTerminalBuild(
    store: MemoryBuildStore,
    slug: string,
    shape: ('merged' | 'aborted')[],
  ): Promise<void> {
    await store.createBuild({ slug, repo: REPO })
    await store.append(slug, {
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: 'i1', host: 'h1', resumedFromSeq: 0 },
    })
    for (const outcome of shape) {
      await store.append(slug, {
        actor: outcome === 'aborted' ? KERNEL : DISPATCHER,
        type: outcome === 'aborted' ? 'build.aborted' : 'build.completed',
        payload: outcome === 'aborted' ? {} : { outcome },
      })
    }
  }

  test('terminal builds are filtered by the digest and never re-read across ticks', async () => {
    const store = makeStore()
    // Twenty terminal builds over the digest contract's lifecycle shapes,
    // plus one live build whose escalation the watch delivers.
    const terminalShapes: ('merged' | 'aborted')[][] = [
      ['merged'],
      ['aborted'],
      ['merged', 'aborted'],
      ['aborted', 'merged'],
    ]
    let n = 0
    for (const shape of terminalShapes) {
      for (let copy = 0; copy < 5; copy += 1) {
        await seedTerminalBuild(store, `t${n}`, shape)
        n += 1
      }
    }
    await seedRunningBuild(store, 'live')
    const counted = countingStore(store)
    let ticks = 0
    const h = harness(store, {
      openStore: () => counted.store,
      onTick: async () => {
        ticks += 1
        if (ticks === 1) await appendEscalation(store, 'live')
      },
    })
    await abWatch({ ...h.base, timeout: '4' })
    // One digest batch read per discovery pass — the initial scan plus every
    // tick — never one full-log read per candidate build.
    expect(counted.digestReads()).toBeGreaterThanOrEqual(1)
    const reads = counted.eventsBySlug()
    for (let i = 0; i < 20; i += 1) expect(reads.get(`t${i}`) ?? 0).toBe(0)
    // The live build was read once (registration in the initial scan), and
    // its escalation was delivered through the ordinary delta polls.
    expect(reads.get('live')).toBe(1)
    const records = h.out
      .slice(0, -1)
      .map((line) => JSON.parse(line) as { build: string; event: { type: string } })
    expect(records.map((record) => record.build)).toEqual(['live'])
    expect(records[0]!.event.type).toBe('escalation.raised')
    expect(h.err).toEqual([])
  })

  test('a legacy repoOrigin record absent from the digest map still joins', async () => {
    const store = makeStore()
    // The digest map keys on `record.repo`; this record is in `mine` only via
    // the normalized `repoOrigin` fallback arm, so discovery falls back to
    // the reduceBuild re-check — and must still register the nonterminal
    // record. A terminal variant must still be skipped.
    await store.createBuild({ slug: 'legacy', repo: '/old/checkouts/app', repoOrigin: REPO })
    await store.append('legacy', {
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: 'i1', host: 'h1', resumedFromSeq: 0 },
    })
    const counted = countingStore(store)
    let ticks = 0
    const h = harness(store, {
      openStore: () => counted.store,
      onTick: async () => {
        ticks += 1
        if (ticks === 1) await appendEscalation(store, 'legacy')
      },
    })
    await abWatch({ ...h.base, timeout: '2' })
    expect(counted.eventsBySlug().get('legacy')).toBe(1)
    const records = h.out
      .slice(0, -1)
      .map((line) => JSON.parse(line) as { build: string; event: { type: string } })
    expect(records.map((record) => record.build)).toEqual(['legacy'])

    const store2 = makeStore()
    await store2.createBuild({ slug: 'legacy-done', repo: '/old/checkouts/app', repoOrigin: REPO })
    await store2.append('legacy-done', {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
    const counted2 = countingStore(store2)
    const h2 = harness(store2, { openStore: () => counted2.store })
    await abWatch({ ...h2.base, timeout: '2' })
    // The fallback reads a record the digest map cannot answer (the digest
    // keys on `record.repo`) once, sees the terminal reduction, and retires
    // it — never registered, never delivered, and not re-read on any later
    // discovery pass, so an idle pass reads no event rows.
    expect(counted2.eventsBySlug().get('legacy-done')).toBe(1)
    expect(h2.out.slice(0, -1)).toEqual([])
  })

  test('a named slug still tracks through trackBuild (persisted seed)', async () => {
    // Named slugs bypass the discovery filter by design; the digest does not
    // retire a NAMED build's full log (registration + --since replay need it).
    const store = makeStore()
    await seedRunningBuild(store, 'named')
    const counted = countingStore(store)
    let ticks = 0
    const h = harness(store, {
      openStore: () => counted.store,
      onTick: async () => {
        ticks += 1
        if (ticks === 1) await appendEscalation(store, 'named')
      },
    })
    await abWatch({ ...h.base, slugs: ['named'], timeout: '2' })
    expect(counted.eventsBySlug().get('named')).toBe(1)
    // Named watches never enter discovery: no digest read at all.
    expect(counted.digestReads()).toBe(0)
    const records = h.out
      .slice(0, -1)
      .map((line) => JSON.parse(line) as { event: { type: string } })
    expect(records.map((record) => record.event.type)).toEqual(['escalation.raised'])
  })
})

describe('watch read-failure resilience', () => {
  test('a mid-watch discovery failure is reported once, retried, and loses no event', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    // Call 1 is the initial scan; fail the first tick's discovery.
    let listCalls = 0
    const flaky: BuildStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'listBuilds') {
          return async () => {
            listCalls += 1
            if (listCalls === 2) throw new Error('list failed')
            return (target as MemoryBuildStore).listBuilds()
          }
        }
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value
      },
    })
    let ticks = 0
    const h = harness(store, {
      openStore: () => flaky,
      onTick: async () => {
        ticks += 1
        if (ticks === 2) await appendEscalation(store, 'b1')
      },
    })
    await abWatch({ ...h.base, timeout: '2' })

    // Reported exactly once — the swallowing regression reported nothing.
    expect(h.err).toEqual([expect.stringContaining('ab watch: a store read failed (list failed)')])
    // The next tick's discovery succeeded, and the matching event arrived.
    const records = h.out
      .slice(0, -1)
      .map((line) => JSON.parse(line) as { event: { type: string; seq: number } })
    expect(records.map((record) => record.event)).toEqual([
      expect.objectContaining({ type: 'escalation.raised', seq: 2 }),
    ])
  })

  test('a failed read is reported once, retried, and loses no event', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    let failNext = true
    const flaky: BuildStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'getEvents') {
          return async (slug: string, sinceSeq?: number) => {
            if (failNext && (sinceSeq ?? 0) > 0) {
              failNext = false
              throw new Error('store read failed')
            }
            return (target as MemoryBuildStore).getEvents(slug, sinceSeq)
          }
        }
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value
      },
    })
    let calls = 0
    const h = harness(store, {
      openStore: () => flaky,
      onTick: async () => {
        calls += 1
        if (calls === 1) await appendEscalation(store, 'b1')
      },
    })
    await abWatch({ ...h.base, slugs: ['b1'], timeout: '2' })

    expect(h.err).toEqual([
      expect.stringContaining('ab watch: a store read failed (store read failed)'),
    ])
    const records = h.out
      .slice(0, -1)
      .map((line) => JSON.parse(line) as { event: { type: string; seq: number } })
    // Delivered exactly once, on the retry — neither skipped nor duplicated.
    expect(records.map((record) => record.event)).toEqual([
      expect.objectContaining({ type: 'escalation.raised', seq: 2 }),
    ])
  })
})

describe('watch wiring and parsing', () => {
  test('interval selection follows the store-reference kind', () => {
    expect(watchSelection('https://stores.example.com/ab').intervalMs).toBe(5000)
    expect(watchSelection('http://localhost:8080').intervalMs).toBe(5000)
    expect(watchSelection('/repo/.autobuild/store.db').intervalMs).toBe(1000)
  })

  test('duration parsing: bare numbers are seconds, suffixes scale, 0 only for --timeout', () => {
    const timeout = { flag: '--timeout', usage: WATCH_USAGE, allowZero: true }
    const interval = { flag: '--interval', usage: WATCH_USAGE }
    expect(parseDurationMs('30', timeout)).toBe(30_000)
    expect(parseDurationMs('45s', timeout)).toBe(45_000)
    expect(parseDurationMs('5m', timeout)).toBe(300_000)
    expect(parseDurationMs('1h', timeout)).toBe(3_600_000)
    expect(parseDurationMs('0', timeout)).toBe(0)
    expect(parseDurationMs('5s', interval)).toBe(5_000)
    for (const text of ['0', '-5', '1.5m', '5x', 'abc', '']) {
      expect(() => parseDurationMs(text, interval)).toThrow('--interval requires a duration')
    }
  })

  test('usage errors name the usage line and emit nothing on stdout', async () => {
    const out: string[] = []
    const err: string[] = []
    const deps = {
      workspacePath: '/no/watch/dependencies',
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    }
    expect(await runCli(['watch', '--count', '0'], deps)).toBe(1)
    expect(err[0]).toContain('--count requires a positive integer')
    expect(err[0]).toContain(WATCH_USAGE)
    expect(await runCli(['watch', '--bogus'], deps)).toBe(1)
    expect(err[1]).toContain('unknown flag --bogus')
    expect(err[1]).toContain(WATCH_USAGE)
    expect(out).toEqual([])
  })

  test('a store that cannot be opened at start exits nonzero before any record', async () => {
    const store = makeStore()
    const h = harness(store, {
      openStore: () => {
        throw new Error('no such store')
      },
    })
    await expect(abWatch({ ...h.base, slugs: ['b1'] })).rejects.toThrow('no such store')
    expect(h.out).toEqual([])
  })
})

describe('watch remote bounded-wait cadence (AUT-334)', () => {
  const REMOTE_REF = 'https://stores.example.com/ab'

  /** A held-read proxy: opts-bearing getEvents calls are the long-poll
   * requests; the behavior per call is scripted by `held`, which receives the
   * read's opts (including the cancellation signal). */
  function longPollStore(
    store: MemoryBuildStore,
    held: (
      slug: string,
      call: number,
      opts?: { waitSeconds?: number; signal?: AbortSignal },
    ) => Promise<void> | void,
  ): { store: BuildStore; heldCalls: () => number } {
    const perSlug = new Map<string, number>()
    let total = 0
    const fake: BuildStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'getEvents') {
          return async (
            slug: string,
            sinceSeq?: number,
            opts?: { waitSeconds?: number; signal?: AbortSignal },
          ) => {
            if (opts?.waitSeconds === undefined) {
              return (target as MemoryBuildStore).getEvents(slug, sinceSeq)
            }
            const call = (perSlug.get(slug) ?? 0) + 1
            perSlug.set(slug, call)
            total += 1
            await held(slug, call, opts)
            return (target as MemoryBuildStore).getEvents(slug, sinceSeq)
          }
        }
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value
      },
    })
    return { store: fake, heldCalls: () => total }
  }

  test('remote held reads deliver failed-node attention through the default filter', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'node')
    const payload = {
      id: 'cycle',
      head: 'a'.repeat(40),
      parent: 'b'.repeat(40),
      steps: ['agent'],
      guidance: 'file a repair child targeting this node: node',
    }
    const { store: fake, heldCalls } = longPollStore(store, async (_slug, call) => {
      if (call === 1)
        await store.append('node', {
          actor: KERNEL,
          type: 'integration.verification-failed',
          payload,
        })
    })
    const h = harness(store, { openStore: () => fake })
    await abWatch({ ...h.base, storeRef: REMOTE_REF, slugs: ['node'], count: 1, timeout: '2' })
    expect(heldCalls()).toBeGreaterThan(0)
    expect(
      h.out.map((line) => JSON.parse(line)).find((record) => record.event)?.event.payload,
    ).toEqual(payload)
  })

  test('an appended event is delivered without waiting the interval, via a held read', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    const { store: fake } = longPollStore(store, (_slug, call) => {
      if (call === 1) return appendEscalation(store, 'b1')
    })
    const h = harness(store, { openStore: () => fake })
    await abWatch({ ...h.base, storeRef: REMOTE_REF, slugs: ['b1'], timeout: '1' })
    const records = h.out
      .slice(0, -1)
      .map((line) => JSON.parse(line) as { event: { type: string; seq: number } })
    // The event landed during the first held request and was delivered at
    // once — no interval tick had to pass first.
    expect(records.map((record) => record.event)).toEqual([
      expect.objectContaining({ type: 'escalation.raised', seq: 2 }),
    ])
  })

  test('request starts stay spaced at least --interval apart on a quiet stream', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    const starts: number[] = []
    const { store: fake } = longPollStore(store, () => {
      starts.push(h.clock().getTime())
    })
    const h = harness(store, { openStore: () => fake })
    await abWatch({
      ...h.base,
      storeRef: REMOTE_REF,
      slugs: ['b1'],
      timeout: '3',
    })
    // One held request per wait window: three cycles inside the 3 s budget,
    // each start at least one interval after the previous.
    expect(starts.length).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(1000)
    }
    expect(h.err).toEqual([])
  })

  test('one held request per stream is in flight concurrently', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    await seedRunningBuild(store, 'b2')
    let entered = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const seen = new Set<string>()
    const { store: fake } = longPollStore(store, (slug) => {
      if (!seen.has(slug)) {
        seen.add(slug)
        entered += 1
        if (entered === 2) release()
        return barrier
      }
    })
    const h = harness(store, { openStore: () => fake })
    // Concurrent tasks: both streams' first held requests are issued before
    // either resolves — a serialized per-stream tick would deadlock here.
    await abWatch({ ...h.base, storeRef: REMOTE_REF, slugs: ['b1', 'b2'], timeout: '1' })
    expect(seen).toEqual(new Set(['b1', 'b2']))
    expect(h.err).toEqual([])
  })

  test('a mid-watch read failure is reported once and retried without losing events', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    const { store: fake } = longPollStore(store, (_slug, call) => {
      if (call === 1) throw new Error('held read failed')
      if (call === 2) return appendEscalation(store, 'b1')
    })
    const h = harness(store, { openStore: () => fake })
    await abWatch({ ...h.base, storeRef: REMOTE_REF, slugs: ['b1'], timeout: '2' })
    expect(h.err).toEqual([
      expect.stringContaining('ab watch: a store read failed (held read failed)'),
    ])
    const records = h.out
      .slice(0, -1)
      .map((line) => JSON.parse(line) as { event: { type: string; seq: number } })
    expect(records.map((record) => record.event)).toEqual([
      expect.objectContaining({ type: 'escalation.raised', seq: 2 }),
    ])
  })

  test('a persistent failure on one stream is reported once even as other streams succeed', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    await seedRunningBuild(store, 'b2')
    // Stream b1 fails on every held read; b2 succeeds each cycle. The
    // failure report is tracked per stream: b2's successes must not re-arm
    // b1's streak, or b1's failure would be re-reported every cycle.
    const { store: fake } = longPollStore(store, (slug) => {
      if (slug === 'b1') throw new Error('b1 held read failed')
      return appendEscalation(store, 'b2')
    })
    const h = harness(store, { openStore: () => fake })
    await abWatch({ ...h.base, storeRef: REMOTE_REF, slugs: ['b1', 'b2'], timeout: '2' })
    expect(h.err).toEqual([
      expect.stringContaining('ab watch: a store read failed (b1 held read failed)'),
    ])
  })

  test('an already-terminal named set ends before any held request', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    await store.append('b1', {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
    const { store: fake, heldCalls } = longPollStore(store, () => {})
    const h = harness(store, { openStore: () => fake })
    await abWatch({ ...h.base, storeRef: REMOTE_REF, slugs: ['b1'], timeout: '5' })
    expect(heldCalls()).toBe(0)
  })

  /** A held read that never resolves on its own — it ends only when the
   * watch cancels it via its signal. A watch that fails to cancel would hang
   * until the test times out. */
  const heldUntilCancelled = async (
    _slug: string,
    _call: number,
    opts?: { waitSeconds?: number; signal?: AbortSignal },
  ): Promise<void> => {
    const signal = opts?.signal
    await new Promise<never>((_, reject) => {
      const abort = (): void => reject(new Error('held read cancelled'))
      if (signal?.aborted === true) {
        abort()
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  test('an abort during a held read ends the watch promptly', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    const external = new AbortController()
    const { store: fake } = longPollStore(store, async (slug, call, opts) => {
      if (slug === 'b1' && call === 1) {
        // Abort from inside the hold: the watch must cancel the read (via
        // its signal) and exit instead of waiting out the hold.
        external.abort()
        await heldUntilCancelled(slug, call, opts)
      }
    })
    const h = harness(store, { openStore: () => fake })
    // A 30 s fake budget: without cancellation the never-resolving hold
    // would hang the watch past the test timeout.
    await abWatch({
      ...h.base,
      storeRef: REMOTE_REF,
      slugs: ['b1'],
      timeout: '30',
      signal: external.signal,
    })
    // The cancelled read is the watch stopping, not a store failure.
    expect(h.err).toEqual([])
  })

  test("a tripped --count cancels the other streams' held reads", async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    await seedRunningBuild(store, 'b2')
    const { store: fake } = longPollStore(store, async (slug, call, opts) => {
      if (slug === 'b1') {
        // b1's first read never resolves on its own; only the watch's
        // cancellation (the count trip on b2) can end it.
        if (call === 1) await heldUntilCancelled(slug, call, opts)
        return
      }
      if (call === 1) return appendEscalation(store, 'b2')
    })
    const h = harness(store, { openStore: () => fake })
    await abWatch({
      ...h.base,
      storeRef: REMOTE_REF,
      slugs: ['b1', 'b2'],
      timeout: '30',
      count: 1,
    })
    const records = h.out
      .slice(0, -1)
      .map((line) => JSON.parse(line) as { event: { type: string; seq: number } })
    expect(records).toHaveLength(1)
    expect(records[0]!.event).toEqual(expect.objectContaining({ type: 'escalation.raised' }))
    expect(h.err).toEqual([])
  })

  test('a terminal endCheck stops a sibling stream mid-batch, not after it', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    await seedRunningBuild(store, 'b2')
    // b2 joins as a cursor stream positioned at its current end: tracked and
    // held-read but not named, so namedAllTerminal() ignores it. A batch
    // landing on it in the same tick as b1's terminal event is the case the
    // shared runner must not change: the endCheck's stop must trip the
    // command's `stop` flag, so the sibling's already-settled batch is
    // suppressed after its first event instead of drained (f_42263f38).
    const since = encodeCursor({ v: 1, store: REMOTE_REF, repo: REPO, streams: { b2: 1 } })
    const { store: fake } = longPollStore(store, async (slug, call) => {
      if (slug === 'b1' && call === 1) {
        // b1 turns terminal inside its own held read; its endCheck then
        // stops the runner.
        await store.append('b1', {
          actor: DISPATCHER,
          type: 'build.completed',
          payload: { outcome: 'merged' },
        })
        return
      }
      if (slug === 'b2' && call === 1) {
        // b2's read resolves only after every microtask of b1's chain has
        // run — one macrotask turn — so the terminal endCheck's stop is in
        // place before this batch is processed, modelling a response that
        // was already settled when the stop fired.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0)
        })
        await appendEscalation(store, 'b2')
        await appendEscalation(store, 'b2')
      }
    })
    const h = harness(store, { openStore: () => fake })
    await abWatch({
      ...h.base,
      events: ['*'],
      storeRef: REMOTE_REF,
      slugs: ['b1'],
      since,
      timeout: '30',
    })
    const types = h.out
      .slice(0, -1)
      .map((line) => (JSON.parse(line) as { event: { type: string } }).event.type)
    // b1's terminal record, then b2's batch cut off after its first event:
    // the second escalation stays undelivered (the final cursor records the
    // position for the next run instead).
    expect(types).toEqual(['build.completed'])
    expect(h.err).toEqual([])
  })

  test("an elapsed --timeout caps the held read's wait instead of waiting out the hold", async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    const waits: number[] = []
    const { store: fake } = longPollStore(store, (_slug, _call, opts) => {
      waits.push(opts?.waitSeconds ?? -1)
      // Honor the bound only when it is at or under 1 s: with the cap, the
      // 1 s --timeout makes the very first read resolve; without it the
      // first read would carry the full 25 s window and hang the watch.
      if ((opts?.waitSeconds ?? 0) <= 1) return
      return new Promise<void>(() => {})
    })
    const h = harness(store, { openStore: () => fake })
    await abWatch({ ...h.base, storeRef: REMOTE_REF, slugs: ['b1'], timeout: '1' })
    expect(waits[0]).toBe(1)
    expect(h.err).toEqual([])
  })

  test('a --timeout above the remote window leaves the window at the remote default', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    const waits: number[] = []
    const { store: fake } = longPollStore(store, (_slug, _call, opts) => {
      waits.push(opts?.waitSeconds ?? -1)
    })
    const h = harness(store, { openStore: () => fake })
    await abWatch({ ...h.base, storeRef: REMOTE_REF, slugs: ['b1'], timeout: '27' })
    expect(waits[0]).toBe(25)
    for (const wait of waits) expect(wait).toBeLessThanOrEqual(25)
  })

  test('a mid-discovery failure still launches the stream registered before the throw', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    // An immediate (non-held) read of b3 always fails: once a discovery pass
    // reaches it, the step throws — after b2 was registered in the same pass.
    const breaking = new Proxy(store, {
      get(target, prop) {
        if (prop === 'getEvents') {
          return async (
            slug: string,
            sinceSeq?: number,
            opts?: { waitSeconds?: number; signal?: AbortSignal },
          ) => {
            if (slug === 'b3' && opts?.waitSeconds === undefined) {
              throw new Error('b3 read failed')
            }
            return (target as MemoryBuildStore).getEvents(slug, sinceSeq)
          }
        }
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value
      },
    })
    const { store: fake } = longPollStore(breaking, (slug, call) => {
      if (slug === 'b2' && call === 1) return appendEscalation(store, 'b2')
    })
    let ticks = 0
    const h = harness(store, {
      openStore: () => fake,
      onTick: async () => {
        ticks += 1
        if (ticks === 1) {
          await seedRunningBuild(store, 'b2')
          await seedRunningBuild(store, 'b3')
        }
      },
    })
    await abWatch({ ...h.base, storeRef: REMOTE_REF, timeout: '15' })
    // b2 was registered before the throw and its held read still ran: its
    // escalation is delivered even though discovery itself failed.
    const records = h.out
      .slice(0, -1)
      .map((line) => JSON.parse(line) as { build: string; event: { type: string } })
    expect(records.map((record) => [record.build, record.event.type])).toContainEqual([
      'b2',
      'escalation.raised',
    ])
    // The discovery failure is reported once, on the discovery task's own streak.
    expect(h.err).toEqual([
      expect.stringContaining('ab watch: a store read failed (b3 read failed)'),
    ])
  })
})

// --- AUT-534: the watch's repository baseline becomes a bounded read ---

function noopTickCounters() {
  return {
    merged: 0,
    closed: 0,
    conflicted: 0,
    abandoned: 0,
    discarded: 0,
    janitorFailed: 0,
    recovered: 0,
    dispatchFailed: 0,
    resumed: 0,
    swept: 0,
    dispatched: 0,
    authored: 0,
    bounced: 0,
    claimRaces: 0,
    invalidTickets: 0,
    dependencyBlocked: 0,
    harvestStarted: 0,
    harvestResumed: 0,
    harvestCompleted: 0,
    harvestEscalated: 0,
    harvestFailed: 0,
  }
}

/** A long no-op journal: `count` completed dispatcher invocations, three
 * run-scoped facts each — the shape the bounded read exists for. */
async function seedNoopInvocations(store: MemoryBuildStore, count: number): Promise<number> {
  await store.ensureRepo(REPO)
  for (let index = 0; index < count; index += 1) {
    const run = `r_${index}`
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run,
        pid: index + 1,
        effectiveConfig: { kind: 'effective-config', rev: 0 },
        roleWarnings: [],
      },
    })
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.tick-completed',
      payload: {
        run,
        queued: 0,
        counters: noopTickCounters(),
        janitorDiagnostics: [],
        ticketDiagnostics: [],
        creationDiagnostics: [],
        dependencyDiagnostics: [],
      },
    })
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.run-stopped',
      payload: { run, outcome: 'normal' },
    })
  }
  return count * 3
}

/** Counting proxy over a real `MemoryBuildStore`: records every repository
 * journal read in issue order. */
function repoReadProbe(backing: MemoryBuildStore) {
  const calls: Array<{ method: 'getRepoEvents' | 'getRepoStateEvents'; sinceSeq?: number }> = []
  const store = new Proxy(backing, {
    get(target, property) {
      if (property === 'getRepoStateEvents') {
        return async (repo: string) => {
          calls.push({ method: 'getRepoStateEvents' })
          return target.getRepoStateEvents(repo)
        }
      }
      if (property === 'getRepoEvents') {
        return async (repo: string, sinceSeq = 0) => {
          calls.push({ method: 'getRepoEvents', sinceSeq })
          return target.getRepoEvents(repo, sinceSeq)
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as BuildStore
  return { store, calls }
}

test('attention bootstrap uses persisted state, then incremental journal reads', async () => {
  const backing = makeStore()
  const journalEnd = await seedNoopInvocations(backing, 20)
  expect(journalEnd).toBe(60)
  const probe = repoReadProbe(backing)
  const h = harness(backing, { openStore: () => probe.store })
  await abWatch({ ...h.base, repository: true, timeout: '1' })

  // Nothing is emitted: the whole journal is pre-watch history.
  expect(h.out.slice(0, -1)).toEqual([])

  // Exactly one bounded baseline read; the end-recovery read is skipped
  // because the subset contains a `dispatcher.run-started`, and every
  // subsequent journal read is a delta poll at or past the journal end.
  expect(probe.calls[0]).toEqual({ method: 'getRepoEvents', sinceSeq: journalEnd })
  expect(probe.calls.filter((call) => call.method === 'getRepoStateEvents')).toHaveLength(0)
  const journalReads = probe.calls.filter((call) => call.method === 'getRepoEvents')
  expect(journalReads.length).toBeGreaterThan(0)
  expect(journalReads.slice(1).every((call) => (call.sinceSeq ?? 0) >= journalEnd)).toBe(true)

  // The recorded cursor equals the journal end — the full read's answer.
  const cursor = (JSON.parse(h.out.at(-1)!) as { cursor: string }).cursor
  expect(decodeCursor(cursor, { store: `${REPO}/.autobuild`, repo: REPO }).streams).toEqual({
    '#repo': journalEnd,
  })
})

test('events appended after a bounded baseline are delivered exactly once (AUT-534)', async () => {
  const store = makeStore()
  await seedNoopInvocations(store, 20)
  let appended = false
  const h = harness(store, {
    onTick: async () => {
      if (appended) return
      appended = true
      await store.appendRepo(REPO, {
        actor: DISPATCHER,
        type: 'dispatcher.tick-failed',
        payload: { run: 'r_live', error: 'boom' },
      })
    },
  })
  await abWatch({ ...h.base, events: ['*'], repository: true, timeout: '2' })
  const records = h.out
    .slice(0, -1)
    .map((line) => JSON.parse(line) as { event: { type: string; seq: number } })
  expect(records.map((record) => record.event)).toEqual([
    expect.objectContaining({ type: 'dispatcher.tick-failed', seq: 61 }),
  ])
  const cursor = (JSON.parse(h.out.at(-1)!) as { cursor: string }).cursor
  expect(decodeCursor(cursor, { store: `${REPO}/.autobuild`, repo: REPO }).streams).toEqual({
    '#repo': 61,
  })
})

test('an anchor-less journal recovers the true end and baselines silently (AUT-534)', async () => {
  const backing = makeStore()
  await backing.ensureRepo(REPO)
  // Run-scoped fact with no `dispatcher.run-started` anywhere: the bounded
  // subset answers empty, so the baseline must recover the end with one
  // delta read — and must not emit the recovered fact.
  await backing.appendRepo(REPO, {
    actor: humanActor('operator'),
    type: 'dispatcher.operator-reported',
    payload: { run: 'r0', level: 'info', message: 'notice before any run' },
  })
  const probe = repoReadProbe(backing)
  const h = harness(backing, { openStore: () => probe.store })
  await abWatch({ ...h.base, events: ['*'], repository: true, timeout: '1' })
  expect(h.out.slice(0, -1)).toEqual([])

  // The recovery read fired: bounded read first, then the delta read from the
  // subset's (empty) end — the true journal end here — and every later read
  // polls from the recovered cursor.
  expect(probe.calls[0]).toEqual({ method: 'getRepoEvents', sinceSeq: 1 })
  expect(probe.calls.some((call) => call.method === 'getRepoStateEvents')).toBe(false)
  expect(
    probe.calls.slice(3).every((call) => call.method !== 'getRepoEvents' || call.sinceSeq === 1),
  ).toBe(true)
  const cursor = (JSON.parse(h.out.at(-1)!) as { cursor: string }).cursor
  expect(decodeCursor(cursor, { store: `${REPO}/.autobuild`, repo: REPO }).streams).toEqual({
    '#repo': 1,
  })

  // Same equivalence with an explicit event filter: the pre-baseline fact is
  // still never delivered.
  const filteredBacking = makeStore()
  const filtered = repoReadProbe(filteredBacking)
  await filteredBacking.ensureRepo(REPO)
  await filteredBacking.appendRepo(REPO, {
    actor: humanActor('operator'),
    type: 'dispatcher.operator-reported',
    payload: { run: 'r0', level: 'info', message: 'notice before any run' },
  })
  const h2 = harness(filteredBacking, { openStore: () => filtered.store })
  await abWatch({ ...h2.base, repository: true, events: ['dispatcher.*'], timeout: '1' })
  expect(h2.out.slice(0, -1)).toEqual([])
  expect(filtered.calls[0]).toEqual({ method: 'getRepoEvents', sinceSeq: 1 })
  expect(filtered.calls.some((call) => call.method === 'getRepoStateEvents')).toBe(false)
})

for (const json of [true, false]) {
  test(`explicit watch delivers source lifecycle without active builds (json=${json})`, async () => {
    const store = makeStore()
    let tick = 0
    const h = harness(store, {
      onTick: async () => {
        tick += 1
        await store.ensureRepo(REPO)
        if (tick === 1)
          await store.appendRepo(REPO, {
            actor: DISPATCHER,
            type: 'dispatcher.ticket-source-degraded',
            payload: {
              source: 'fake',
              cause: 'rate-limited',
              operation: 'ready-scan',
              message: 'quota exhausted',
              resetAt: '2026-10-14T12:00:00.000Z',
            },
          })
        if (tick === 2)
          await store.appendRepo(REPO, {
            actor: DISPATCHER,
            type: 'dispatcher.ticket-source-recovered',
            payload: { source: 'fake', cause: 'rate-limited', operation: 'ready-scan' },
          })
      },
    })
    await abWatch({
      ...h.base,
      events: ['dispatcher.ticket-source-*'],
      json,
      count: 2,
      timeout: '5',
    })
    if (json) {
      const records = h.out.slice(0, -1).map((line) => JSON.parse(line))
      expect(records.map((record) => record.event.type)).toEqual([
        'dispatcher.ticket-source-degraded',
        'dispatcher.ticket-source-recovered',
      ])
      expect(records.every((record) => record.build === null && record.state === null)).toBe(true)
      const final = JSON.parse(h.out.at(-1)!).cursor
      expect(
        decodeCursor(final, { store: `${REPO}/.autobuild`, repo: REPO }).streams['#repo'],
      ).toBe(2)
    } else {
      expect(h.out).toHaveLength(2)
      expect(h.out.every((line) => line.includes('fake') && line.includes('rate-limited'))).toBe(
        true,
      )
      expect(h.out[0]).toContain('2026-10-14T12:00:00.000Z')
    }
  })
}

for (const json of [true, false]) {
  test(`expired dispatcher is a read-only observation and cursor suppresses replay (json=${json})`, async () => {
    const clock = manualClock()
    const store = new MemoryBuildStore({ clock })
    await store.ensureRepo(REPO)
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run: 'lost-run',
        pid: 42,
        host: 'host',
        effectiveConfig: { kind: 'config', rev: 0 },
        roleWarnings: [],
      },
    })
    await store.claimRepoLease(REPO, 'lost-run', 1000)
    const before = await store.getRepoEvents(REPO)
    const h = harness(store, {
      json,
      now: clock,
      delay: async () => {
        clock.advance(1000)
      },
    })
    await abWatch({ ...h.base, repository: true, count: 1, timeout: '3' })
    expect(h.err).toEqual([])
    if (json) {
      const record = JSON.parse(h.out[0]!)
      expect(record.observation.type).toBe('dispatcher.lost')
      expect(record.observation.run).toBe('lost-run')
      expect(record.event).toBeUndefined()
      const resumed = harness(store, {
        now: clock,
        delay: async () => {
          clock.advance(1000)
        },
      })
      await abWatch({ ...resumed.base, repository: true, since: record.cursor, timeout: '1' })
      expect(resumed.out).toHaveLength(1)
    } else expect(h.out[0]).toContain('dispatcher.lost lost-run')
    expect(await store.getRepoEvents(REPO)).toEqual(before)
  })
}

// Use the negotiated journal, including an unfinished drain: completion and
// predecessor process exit are deliberately absent.
for (const mode of [
  'takeover',
  'requested',
  'released',
  'wrong-successor',
  'wrong-correlation',
  'legacy',
] as const) {
  for (const remote of [false, true]) {
    for (const named of [false, true]) {
      test(`handoff loss classification ${mode} remote=${remote} named=${named}`, async () => {
        const clock = manualClock()
        const store = new MemoryBuildStore({ clock })
        await store.ensureRepo(REPO)
        if (named) await seedRunningBuild(store, 'live')
        await store.claimRepoLease(REPO, 'old', 1000)
        const runtime = {
          version: '1.0.0',
          commit: 'unknown',
          source: { kind: 'package', location: '/old' },
        }
        const handoff = {
          correlation: 'upgrade',
          run: 'old',
          lineage: 'launcher',
          from: runtime,
          to: { ...runtime, version: '2.0.0' },
          root: '/cache/new',
          cacheId: 'new',
          target: { mode: 'installed', key: 'new', source: '/install' },
        }
        const append = async (type: string, payload: unknown) => {
          await store.appendRepo(
            REPO,
            validateRepositoryEventWrite({ actor: DISPATCHER, type, payload }),
          )
        }
        let upgradeReads = 0
        const getReducerValue = store.getReducerValue.bind(store)
        store.getReducerValue = async (scope, request) => {
          if (request.reducer === 'dispatchUpgrade' && ++upgradeReads === 1) {
            throw new Error('upgrade projection temporarily unavailable')
          }
          return getReducerValue(scope, request)
        }
        let switched = false
        const h = harness(store, {
          now: clock,
          delay: async () => {
            clock.advance(1000)
            if (switched) return
            switched = true
            if (mode === 'legacy') {
              await append('dispatcher.handoff-started', handoff)
              await append('dispatcher.handoff-completed', { ...handoff, successor: 'new' })
            } else {
              await append('dispatcher.target-prepared', handoff)
              await append('dispatcher.yield-requested', {
                ...handoff,
                successor: 'new',
                mode: 'drain',
                evidence: 'same schema',
              })
              if (mode !== 'requested') {
                await append('dispatcher.handoff-started', {
                  ...handoff,
                  successor: 'new',
                  mode: 'drain',
                  startedAt: clock().toISOString(),
                  deadline: new Date(clock().getTime() + 900000).toISOString(),
                  builds: [{ slug: 'live', instance: 'execution' }],
                })
                await append('dispatcher.terminal-released', handoff)
                if (mode !== 'released')
                  await append('dispatcher.takeover', {
                    ...handoff,
                    successor: mode === 'wrong-successor' ? 'stranger' : 'new',
                    correlation: mode === 'wrong-correlation' ? 'foreign' : handoff.correlation,
                  })
              }
            }
            await store.claimRepoLease(REPO, 'new', mode === 'takeover' && !named ? 100000 : 1000)
          },
        })
        await abWatch({
          ...h.base,
          storeRef: remote ? 'https://store.example.test' : undefined,
          repository: named,
          slugs: named ? ['live'] : [],
          events: ['dispatcher.lost'],
          timeout: '4',
        })
        expect(h.err.join(' ')).toContain('upgrade projection temporarily unavailable')
        expect(upgradeReads).toBeGreaterThan(1)
        const records = h.out.map((line) => JSON.parse(line))
        expect(records.filter((r) => r.observation).map((r) => r.observation.run)).toEqual(
          mode === 'takeover' ? (named ? ['new'] : []) : ['old', 'new'],
        )
        await append('dispatcher.ticket-source-degraded', {
          source: 'fake',
          cause: 'rate-limited',
          operation: 'ready-scan',
          message: 'limited',
          resetAt: clock().toISOString(),
        })
        const before = await store.getRepoEvents(REPO)
        const resumed = harness(store, {
          now: clock,
          delay: async () => {
            clock.advance(1000)
          },
        })
        await abWatch({
          ...resumed.base,
          storeRef: remote ? 'https://store.example.test' : undefined,
          repository: named,
          slugs: named ? ['live'] : [],
          events: ['*'],
          since: records.filter((r) => r.observation).at(-1)?.cursor ?? records.at(-1).cursor,
          timeout: '1',
        })
        expect(resumed.out.map((line) => JSON.parse(line)).filter((r) => r.observation)).toEqual([])
        expect(
          resumed.out
            .map((line) => JSON.parse(line))
            .filter((r) => r.event)
            .map((r) => r.event.type),
        ).toEqual(['dispatcher.ticket-source-degraded'])
        expect(await store.getRepoEvents(REPO)).toEqual(before)
      }, 15000)
    }
  }
}

test('clean stop suppresses loss, and no lease is not death', async () => {
  const store = makeStore()
  await store.ensureRepo(REPO)
  const h = harness(store)
  await abWatch({ ...h.base, repository: true, events: ['dispatcher.lost'], timeout: '2' })
  expect(h.out).toHaveLength(1)
  expect(() =>
    decodeCursor(
      encodeCursor({
        v: 1,
        store: 's',
        repo: 'r',
        streams: {},
        lostRuns: [42] as unknown as string[],
      }),
      { store: 's', repo: 'r' },
    ),
  ).toThrow('malformed')
})

for (const named of [false, true]) {
  test(`remote periodic discovery observes quiet expiry (named=${named})`, async () => {
    const clock = manualClock()
    const store = new MemoryBuildStore({ clock })
    await store.ensureRepo(REPO)
    if (named) await seedRunningBuild(store, 'live')
    await store.claimRepoLease(REPO, 'quiet-owner', 1000)
    const h = harness(store, {
      now: clock,
      delay: async () => {
        clock.advance(1000)
        await Promise.resolve()
      },
    })
    await abWatch({
      ...h.base,
      storeRef: 'https://store.example.test',
      repository: true,
      slugs: named ? ['live'] : [],
      events: ['dispatcher.lost'],
      count: 1,
      timeout: '10',
    })
    const records = h.out.map((line) => JSON.parse(line))
    expect(records.filter((r) => r.observation)).toHaveLength(1)
    expect(records[0].observation.run).toBe('quiet-owner')
    expect(h.err).toEqual([])
  })
}

test('a clean stop suppresses expired ownership while replacement loss names the new run', async () => {
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  await store.ensureRepo(REPO)
  await store.claimRepoLease(REPO, 'clean', 1000)
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'dispatcher.run-stopped',
    payload: { run: 'clean', outcome: 'normal', signal: 'SIGHUP' },
  })
  let replaced = false
  const h = harness(store, {
    now: clock,
    delay: async () => {
      clock.advance(1000)
      if (!replaced) {
        replaced = true
        await store.claimRepoLease(REPO, 'replacement', 1000)
      }
    },
  })
  await abWatch({ ...h.base, repository: true, timeout: '3' })
  const observations = h.out.map((line) => JSON.parse(line)).filter((r) => r.observation)
  expect(observations.map((r) => r.observation.run)).toEqual(['replacement'])
})

for (const remote of [false, true]) {
  test(`persistent source matures on a quiet stream and cursor resumes once (remote=${remote})`, async () => {
    const clock = manualClock()
    const store = new MemoryBuildStore({ clock })
    await store.ensureRepo(REPO)
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.ticket-source-degraded',
      payload: {
        source: 'linear',
        operation: 'ready-scan',
        cause: 'ready-scan-failed',
        message: 'offline',
      },
    })
    // A later run anchor must not hide the episode's true start.
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run: 'new',
        pid: 1,
        effectiveConfig: { kind: 'effective-config', rev: 0 },
        roleWarnings: [],
      },
    })
    const storeRef = remote ? 'https://stores.example.com/ab' : `${REPO}/.autobuild`
    let heldReads = 0
    const quietRemote = new Proxy(store, {
      get(target, property) {
        if (property === 'getRepoEvents')
          return async (
            repo: string,
            since?: number,
            opts?: { waitSeconds?: number; signal?: AbortSignal },
          ) => {
            if (opts?.waitSeconds) {
              heldReads += 1
              // A genuinely quiet long-poll never returns until cancelled.
              return await new Promise<import('../events/repository').RepositoryEvent[]>(
                (resolve) => {
                  if (opts.signal?.aborted) resolve([])
                  else opts.signal?.addEventListener('abort', () => resolve([]), { once: true })
                },
              )
            }
            return target.getRepoEvents(repo, since)
          }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const h = harness(store, {
      now: clock,
      openStore: () => (remote ? quietRemote : store),
      delay: async () => {
        clock.advance(900_000)
      },
    })
    await abWatch({ ...h.base, storeRef, count: 1, timeout: '1000' })
    if (remote) expect(heldReads).toBeGreaterThan(0)
    const record = JSON.parse(h.out[0]!)
    expect(record).toMatchObject({
      build: null,
      state: null,
      repo: REPO,
      observation: { type: 'dispatcher.ticket-source-persistent', episodeSeq: 1, source: 'linear' },
    })
    expect(record.event).toBeUndefined()
    const decoded = decodeCursor(record.cursor, { store: storeRef, repo: REPO })
    expect(decoded.deliveredAttention).toContain('source:1')
    const resume = harness(store, {
      now: clock,
      delay: async () => {
        clock.advance(900_000)
      },
    })
    await abWatch({ ...resume.base, storeRef, since: record.cursor, timeout: '2' })
    expect(resume.out).toHaveLength(1)
    expect(
      decodeCursor(JSON.parse(resume.out[0]!).cursor, { store: storeRef, repo: REPO }).streams,
    ).toEqual(decoded.streams)
  })
}

test('old cursor reconstructs overdue episodes, but recovery in backlog suppresses a stale timer', async () => {
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  await store.ensureRepo(REPO)
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'dispatcher.tick-failed',
    payload: { run: 'r', error: 'broken' },
  })
  const since = encodeCursor({
    v: 1,
    store: `${REPO}/.autobuild`,
    repo: REPO,
    streams: { '#repo': 1 },
  })
  clock.advance(300_000)
  const h = harness(store, {
    now: clock,
    delay: async () => {
      clock.advance(1000)
    },
  })
  await abWatch({ ...h.base, since, count: 1, timeout: '1' })
  expect(JSON.parse(h.out[0]!).observation.type).toBe('dispatcher.tick-failure-persistent')
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'dispatcher.run-stopped',
    payload: { run: 'r', outcome: 'normal' },
  })
  const recovered = harness(store, {
    now: clock,
    delay: async () => {
      clock.advance(1000)
    },
  })
  await abWatch({ ...recovered.base, since, timeout: '1' })
  expect(recovered.out).toHaveLength(1)
})

test('merge decisions dedupe per PR across consent changes and new cursor resumes', async () => {
  const store = makeStore()
  await seedRunningBuild(store, 'b1')
  const finalize = async () => {
    await store.append('b1', {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: { pr: { number: 7, url: 'https://example.com/pr/7', headSha: 'abc' } },
    })
    await store.append('b1', {
      actor: KERNEL,
      type: 'landing.decided',
      payload: {
        candidate: { head: 'abc', parent: 'base', cycle: '1' },
        from: 'leaf',
        into: { kind: 'root' },
        labels: [],
        mode: 'consent',
        rule: { default: true },
      },
    })
    await appendGateDeferral(store, 'b1', 7)
  }
  let ticks = 0
  const h = harness(store, {
    onTick: async () => {
      if (++ticks === 1) await finalize()
    },
  })
  await abWatch({ ...h.base, slugs: ['b1'], count: 1, timeout: '2' })
  const first = JSON.parse(h.out[0]!)
  expect(first).toMatchObject({
    build: 'b1',
    state: { prState: 'open' },
    observation: { type: 'build.merge-decision', pr: { number: 7 } },
  })
  await store.append('b1', {
    actor: humanActor('op'),
    type: 'build.auto-merge-requested',
    payload: {},
  })
  await store.append('b1', {
    actor: humanActor('op'),
    type: 'build.auto-merge-cancelled',
    payload: {},
  })
  await finalize()
  const resume = harness(store)
  await abWatch({ ...resume.base, slugs: ['b1'], since: first.cursor, timeout: '1' })
  expect(resume.out).toHaveLength(1)
  // An old cursor after the gate receipt infers the already consumed gate attention.
  const old = encodeCursor({
    v: 1,
    store: `${REPO}/.autobuild`,
    repo: REPO,
    streams: decodeCursor(first.cursor, { store: `${REPO}/.autobuild`, repo: REPO }).streams,
  })
  const upgrade = harness(store)
  await abWatch({ ...upgrade.base, slugs: ['b1'], since: old, timeout: '1' })
  expect(upgrade.out).toHaveLength(1)
})

test('malformed attention cursor metadata is rejected', () => {
  for (const deliveredAttention of [null, ['bad'], ['source:0'], [['b1', 7]], [12]]) {
    const cursor =
      'v1.' +
      Buffer.from(
        JSON.stringify({ v: 1, store: 's', repo: 'r', streams: {}, deliveredAttention }),
      ).toString('base64url')
    expect(() => decodeCursor(cursor, { store: 's', repo: 'r' })).toThrow('malformed')
  }
})

test('count stops between simultaneous timer observations without advancing the stream', async () => {
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  await store.ensureRepo(REPO)
  for (const source of ['a', 'b'])
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.ticket-source-degraded',
      payload: { source, operation: 'ready-scan', cause: 'ready-scan-failed', message: 'offline' },
    })
  clock.advance(900_000)
  const run = async (since?: string) => {
    const h = harness(store, {
      now: clock,
      delay: async () => {
        clock.advance(1000)
      },
    })
    await abWatch({ ...h.base, count: 1, timeout: '1', ...(since ? { since } : {}) })
    return h.out.map((line) => JSON.parse(line))
  }
  const first = await run()
  const second = await run(first[0].cursor)
  expect(first[0].observation.source).toBe('a')
  expect(second[0].observation.source).toBe('b')
  const expected = { store: `${REPO}/.autobuild`, repo: REPO }
  expect(decodeCursor(first[0].cursor, expected).streams).toEqual(
    decodeCursor(second[0].cursor, expected).streams,
  )
  expect(await run(second[0].cursor)).toHaveLength(1)
})

test('a failed repository catch-up cannot report an obsolete persistence condition', async () => {
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  await store.ensureRepo(REPO)
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'dispatcher.tick-failed',
    payload: { run: 'r', error: 'offline' },
  })
  let fail = false
  const proxy = new Proxy(store, {
    get(target, property) {
      if (property === 'getRepoEvents')
        return async (repo: string, since?: number) => {
          if (fail) throw new Error('unavailable')
          return target.getRepoEvents(repo, since)
        }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  let ticks = 0
  const h = harness(store, {
    openStore: () => proxy,
    now: clock,
    delay: async () => {
      clock.advance(300_000)
      if (++ticks === 1) {
        await store.appendRepo(REPO, {
          actor: DISPATCHER,
          type: 'dispatcher.run-stopped',
          payload: { run: 'r', outcome: 'normal' },
        })
        fail = true
      } else fail = false
    },
  })
  await abWatch({ ...h.base, timeout: '601' })
  expect(h.out).toHaveLength(1)
  expect(h.err[0]).toContain('unavailable')
})

for (const recovers of [true, false]) {
  test(`rate-limit attention waits for the first post-reset retry outcome (recovers=${recovers})`, async () => {
    const clock = manualClock()
    const store = new MemoryBuildStore({ clock })
    await store.ensureRepo(REPO)
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.tick-started',
      payload: { run: 'r' },
    })
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.ticket-source-degraded',
      payload: {
        source: 'linear',
        cause: 'rate-limited',
        operation: 'ready-scan',
        message: 'quota',
        resetAt: new Date(clock().getTime() + 2000).toISOString(),
      },
    })
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.tick-failed',
      payload: { run: 'r', error: 'quota' },
    })
    let seconds = 0
    const h = harness(store, {
      now: clock,
      delay: async () => {
        clock.advance(1000)
        seconds += 1
        if (seconds === 10)
          await store.appendRepo(REPO, {
            actor: DISPATCHER,
            type: 'dispatcher.tick-started',
            payload: { run: 'r' },
          })
        if (seconds !== 11) return
        if (recovers) {
          await store.appendRepo(REPO, {
            actor: DISPATCHER,
            type: 'dispatcher.ticket-source-recovered',
            payload: { source: 'linear', cause: 'rate-limited', operation: 'ready-scan' },
          })
          await store.appendRepo(REPO, {
            actor: DISPATCHER,
            type: 'dispatcher.tick-completed',
            payload: {
              run: 'r',
              queued: 0,
              counters: noopTickCounters(),
              janitorDiagnostics: [],
              ticketDiagnostics: [],
              dependencyDiagnostics: [],
            },
          })
        } else
          await store.appendRepo(REPO, {
            actor: DISPATCHER,
            type: 'dispatcher.tick-failed',
            payload: { run: 'r', error: 'still offline' },
          })
      },
    })
    await abWatch({ ...h.base, repository: true, timeout: '13' })
    const records = h.out.slice(0, -1).map((line) => JSON.parse(line))
    if (recovers) expect(records).toEqual([])
    else {
      expect(records).toHaveLength(1)
      expect(records[0].observation.type).toBe('dispatcher.ticket-source-persistent')
      expect(records[0].observation.observedAt).toBe(
        new Date(clock().getTime() - 2000).toISOString(),
      )
    }
  })
}

test('fresh watch baselines every historically eligible PR even when armed before registration', async () => {
  for (const named of [true, false]) {
    const store = makeStore()
    await seedRunningBuild(store, 'baseline')
    for (const pr of [9, 7]) {
      await store.append('baseline', {
        actor: KERNEL,
        type: 'finalize.completed',
        payload: { pr: { number: pr, url: `https://example.test/${pr}`, headSha: 'abc' } },
      })
      await store.append('baseline', {
        actor: KERNEL,
        type: 'landing.decided',
        payload: {
          candidate: { head: 'abc', parent: 'base', cycle: '1' },
          from: 'leaf',
          into: { kind: 'root' },
          labels: [],
          mode: 'consent',
          rule: { default: true },
        },
      })
      await appendGateDeferral(store, 'baseline', pr)
    }
    await store.append('baseline', {
      actor: humanActor('human'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    let tick = 0
    const h = harness(store, {
      onTick: async () => {
        if (++tick === 1)
          await store.append('baseline', {
            actor: humanActor('human'),
            type: 'build.auto-merge-cancelled',
            payload: {},
          })
        if (tick === 2) {
          await store.append('baseline', {
            actor: KERNEL,
            type: 'finalize.completed',
            payload: { pr: { number: 11, url: 'https://example.test/11', headSha: 'abc' } },
          })
          await appendGateDeferral(store, 'baseline', 11)
        }
      },
    })
    await abWatch({ ...h.base, ...(named ? { slugs: ['baseline'] } : {}), timeout: '3' })
    const observations = h.out.slice(0, -1).map((line) => JSON.parse(line))
    expect(observations).toHaveLength(1)
    expect(observations[0].observation.pr.number).toBe(11)
    const cursor = decodeCursor(JSON.parse(h.out.at(-1)!).cursor, {
      store: `${REPO}/.autobuild`,
      repo: REPO,
    })
    expect(cursor.deliveredAttention).toEqual(
      [9, 7, 11].map((pr) => JSON.stringify(['baseline', pr])),
    )
  }
})

test('repository discovery retains collecting integrations through later lifecycle events', async () => {
  const store = makeStore()
  await store.createBuild({
    slug: 'node',
    repo: REPO,
    created: {
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        ticket: { source: 'fake', id: 'N' },
        repo: REPO,
        baseBranch: 'main',
        kind: 'node',
      },
    },
  })
  await store.append('node', {
    actor: DISPATCHER,
    type: 'node.opened',
    payload: { sha: 'opening' },
  })
  let tick = 0
  const h = harness(store, {
    onTick: async () => {
      tick += 1
      if (tick === 1)
        await store.append('node', {
          actor: DISPATCHER,
          type: 'pr.opened',
          payload: { pr: { number: 1, url: 'https://example/pr/1', headSha: 'child' } },
        })
      if (tick === 2)
        await store.append('node', {
          actor: DISPATCHER,
          type: 'build.completed',
          payload: { outcome: 'merged' },
        })
    },
  })
  await abWatch({ ...h.base, count: 2, timeout: '5s', events: ['pr.opened', 'build.completed'] })
  expect(h.out.join('\n')).toContain('build.completed')
  expect(h.out.join('\n')).toContain('pr.opened')
})

test('forge failures reach default and repository watch with full remediation', async () => {
  for (const repository of [false, true]) {
    const store = makeStore()
    await store.ensureRepo(REPO)
    const fixture_ = harness(store, {
      onTick: async () => {
        await store.appendRepo(REPO, {
          actor: DISPATCHER,
          type: 'dispatcher.forge-readiness-failed',
          payload: {
            run: 'r1',
            forge: 'github',
            rootBranch: 'main',
            check: 'squash',
            detail: 'Squash disabled',
            remediation: 'Enable squash merging',
          },
        })
      },
    })
    await abWatch({ ...fixture_.base, repository, timeout: '1' })
    const records = fixture_.out.slice(0, -1).map((line) => JSON.parse(line))
    expect(records).toHaveLength(1)
    expect(records[0].event.payload.remediation).toBe('Enable squash merging')
    expect(renderWatchLine(records[0].event, null)).toContain('Enable squash merging')
  }
})

test.each([true, false])(
  'consent readiness is observed on discovery and cursor reentry (named=%s)',
  async (named) => {
    const store = makeStore()
    await store.createBuild({ slug: 'ready', repo: REPO, branch: 'preview/ready' })
    await store.append('ready', {
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: 'runner', host: 'host' },
    })
    await store.append('ready', {
      actor: KERNEL,
      type: 'workspace.provisioned',
      payload: {
        provider: 'local',
        ref: 'local',
        branch: 'preview/ready',
        base: { source: 'local', sha: 'base', remoteError: 'offline' },
      },
    })
    await store.append('ready', {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: { pr: { number: 1, url: 'https://forge/1', headSha: 'head' } },
    })
    await store.append('ready', {
      actor: DISPATCHER,
      type: 'landing.decided',
      payload: {
        from: 'leaf',
        into: { kind: 'root' },
        labels: [],
        mode: 'consent',
        rule: { default: true },
        candidate: { head: 'head', parent: 'base', cycle: '3' },
      },
    })
    const first = harness(store, { ...(named ? { slugs: ['ready'] } : {}), timeout: '1s' })
    await abWatch(first.base)
    expect(first.out.slice(0, -1)).toHaveLength(1)
    const record = JSON.parse(first.out[0]!)
    expect(record.observation).toMatchObject({
      type: 'build.consent-ready',
      branch: 'preview/ready',
      position: 4,
    })
    const resumed = harness(store, { slugs: ['ready'], since: record.cursor, timeout: '1s' })
    await abWatch(resumed.base)
    expect(
      resumed.out.map((line) => JSON.parse(line)).filter((record) => record.observation),
    ).toEqual([])
    await store.append('ready', {
      actor: humanActor('operator'),
      type: 'build.land-requested',
      payload: { decisionSeq: 4 },
    })
    await store.append('ready', {
      actor: humanActor('operator'),
      type: 'build.hold-requested',
      payload: {},
    })
    const held = harness(store, { slugs: ['ready'], since: record.cursor, count: 1 })
    await abWatch(held.base)
    expect(JSON.parse(held.out[0]!).observation).toMatchObject({
      type: 'build.consent-ready',
      reason: 'held',
      position: 6,
    })
    const eventsOnly = harness(store, { slugs: ['ready'], events: ['landing.*'], timeout: '1s' })
    await abWatch(eventsOnly.base)
    expect(
      eventsOnly.out.map((line) => JSON.parse(line)).filter((record) => record.observation),
    ).toEqual([])
  },
)

test.each(['consent', 'held', 'stale', 'auto'] as const)(
  'default watch uses one readiness signal for later %s landings',
  async (mode) => {
    const store = makeStore()
    await seedRunningBuild(store, 'later')
    await store.append('later', {
      actor: KERNEL,
      type: 'workspace.provisioned',
      payload: {
        provider: 'local',
        ref: 'workspace',
        branch: 'preview/later',
        base: { source: 'local', sha: 'base', remoteError: 'offline' },
      },
    })
    let tick = 0
    let finalized = 0
    const h = harness(store, {
      timeout: '3s',
      onTick: async () => {
        tick++
        if (tick === 1) {
          finalized = (
            await store.append('later', {
              actor: KERNEL,
              type: 'finalize.completed',
              payload: { pr: { number: 1, url: 'https://forge/1', headSha: 'head' } },
            })
          ).seq
          if (mode === 'held')
            await store.append('later', {
              actor: humanActor('operator'),
              type: 'build.hold-requested',
              payload: {},
            })
        }
        if (tick === 2)
          await store.append('later', {
            actor: DISPATCHER,
            type: 'landing.decided',
            payload: {
              candidate: {
                head: mode === 'stale' ? 'old-head' : 'head',
                parent: 'base',
                cycle: String(finalized),
              },
              from: 'leaf',
              into: { kind: 'root' },
              mode: mode === 'auto' ? 'auto' : 'consent',
              rule: { default: true },
              labels: [],
            },
          })
        if (tick === 3)
          await store.append('later', {
            actor: KERNEL,
            type: 'observation.recorded',
            payload: { id: 'unrelated', kind: 'followup', summary: 'unrelated' },
          })
      },
    })
    await abWatch(h.base)
    const observations = h.out.slice(0, -1).map((line) => JSON.parse(line).observation)
    if (mode === 'stale' || mode === 'auto') expect(observations).toEqual([])
    else {
      expect(observations).toHaveLength(1)
      expect(observations[0]).toMatchObject({
        type: 'build.consent-ready',
        reason: mode === 'held' ? 'held' : 'consent required',
      })
    }
  },
)

test('read deferral attention wakes the default watch once, keeps its real event, and resumes by cursor', async () => {
  const store = makeStore()
  await seedRunningBuild(store, 'b1')
  let appended = false
  const h = harness(store, {
    onTick: async () => {
      if (appended) return
      appended = true
      await store.append('b1', {
        actor: KERNEL,
        type: 'phase.deferral-escalated',
        payload: {
          id: 'esc_read',
          session: 's_read',
          phase: 'plan',
          round: 1,
          evidenceSeq: 2,
          refs: ['own-build-read:2'],
          question: 'Repair CLI/store access\nthen retry',
        },
      })
    },
  })
  await abWatch({ ...h.base, slugs: ['b1'], timeout: '2' })
  const records = h.out.map((line) => JSON.parse(line)).filter((record) => record.event)
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    event: { type: 'phase.deferral-escalated', seq: 2, payload: { id: 'esc_read' } },
    state: { status: 'blocked' },
  })
  const text = harness(store, {
    json: false,
    onTick: async () => {
      await store.append('b1', {
        actor: KERNEL,
        type: 'phase.deferral-escalated',
        payload: {
          id: 'esc_read',
          session: 's_text',
          phase: 'plan',
          round: 1,
          evidenceSeq: 3,
          refs: ['own-build-read:3'],
          question: 'Repair CLI/store access then retry',
        },
      })
    },
  })
  await abWatch({ ...text.base, slugs: ['b1'], timeout: '2' })
  expect(text.out.join('\n')).toContain('esc_read: Repair CLI/store access')
  const tail = harness(store)
  await abWatch({ ...tail.base, slugs: ['b1'], timeout: '1' })
  const cursor = JSON.parse(tail.out.at(-1)!).cursor
  const resumed = harness(store)
  await abWatch({ ...resumed.base, slugs: ['b1'], since: cursor, timeout: '1' })
  expect(resumed.out.map((line) => JSON.parse(line)).filter((record) => record.event)).toHaveLength(
    0,
  )
  const explicit = harness(store)
  await abWatch({ ...explicit.base, slugs: ['b1'], events: ['escalation.raised'], timeout: '1' })
  expect(
    explicit.out.map((line) => JSON.parse(line)).filter((record) => record.event),
  ).toHaveLength(0)
})

test('failed node cycles use default attention, baseline history and resume without duplicates', async () => {
  const store = makeStore()
  await seedRunningBuild(store, 'node')
  const payload = {
    id: 'cycle-1',
    head: 'a'.repeat(40),
    parent: 'b'.repeat(40),
    steps: ['unit', 'docs'],
    guidance: 'file a repair child targeting this node: node',
  }
  let sent = false
  const h = harness(store, {
    onTick: async () => {
      if (sent) return
      sent = true
      await store.append('node', {
        actor: KERNEL,
        type: 'integration.verification-failed',
        payload,
      })
    },
  })
  await abWatch({ ...h.base, slugs: ['node'], count: 1, timeout: '3' })
  const records = h.out.map((line) => JSON.parse(line)).filter((record) => record.event)
  expect(records).toHaveLength(1)
  expect(records[0].event.payload).toEqual(payload)
  const cursor = records[0].cursor
  const resumed = harness(store)
  await abWatch({ ...resumed.base, slugs: ['node'], since: cursor, timeout: '1' })
  expect(resumed.out.map((line) => JSON.parse(line)).filter((record) => record.event)).toEqual([])
  const baseline = harness(store)
  await abWatch({ ...baseline.base, slugs: ['node'], timeout: '1' })
  expect(baseline.out.map((line) => JSON.parse(line)).filter((record) => record.event)).toEqual([])
  await store.append('node', {
    actor: KERNEL,
    type: 'integration.verification-failed',
    payload: { ...payload, id: 'cycle-2', head: 'c'.repeat(40) },
  })
  const next = harness(store)
  await abWatch({ ...next.base, slugs: ['node'], since: cursor, count: 1, timeout: '1' })
  expect(
    next.out.map((line) => JSON.parse(line)).find((record) => record.event)?.event.payload.id,
  ).toBe('cycle-2')
})

test('runtime rollback is default repository attention and cursor replay delivers it once', async () => {
  const store = makeStore()
  await store.ensureRepo(REPO)
  const first = harness(store)
  await abWatch({ ...first.base, timeout: '1' })
  const cursor = JSON.parse(first.out.at(-1)!).cursor
  const runtime = {
    version: '1.0.0',
    commit: 'unknown',
    source: { kind: 'package' as const, location: '/cache/old' },
  }
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'dispatcher.runtime-rolled-back',
    payload: {
      correlation: 'rollback',
      run: 'restored',
      lineage: 'launcher',
      predecessor: 'old',
      successor: 'new',
      handoff: 'handoff',
      takeoverAt: '2026-01-01T00:00:00.000Z',
      failures: 3,
      failed: { ...runtime, version: '2.0.0' },
      restored: runtime,
      failedRoot: '/cache/new',
      restoredRoot: '/cache/old',
      target: { mode: 'installed', key: 'two', source: '/install', version: '2.0.0' },
      reason: 'three failed exits',
    },
  })
  const second = harness(store)
  await abWatch({ ...second.base, since: cursor, timeout: '1' })
  const records = second.out.slice(0, -1).map((line) => JSON.parse(line))
  expect(records).toHaveLength(1)
  expect(records[0].event.type).toBe('dispatcher.runtime-rolled-back')
  expect(renderWatchLine(records[0].event, null)).toContain('2.0.0 → 1.0.0')
  const third = harness(store)
  await abWatch({ ...third.base, since: JSON.parse(second.out.at(-1)!).cursor, timeout: '1' })
  expect(third.out.slice(0, -1)).toEqual([])
})

describe('advisory operator watches', () => {
  test('rejects named and ambient operator watches before opening the store', async () => {
    for (const overrides of [
      { slugs: ['build'] },
      { slugs: ['build'], repository: true },
      ...['AB_BUILD', 'AB_SESSION', 'AB_PHASE', 'AB_HARVEST', 'AB_REPO'].map((key) => ({
        env: { [key]: 'scope' },
      })),
    ]) {
      const h = harness(makeStore(), { operator: true, ...overrides })
      await expect(abWatch(h.base)).rejects.toThrow()
      expect(h.openCount()).toBe(0)
    }
  })

  test('exit heartbeat anchors the full re-arm grace and preserves identity through expiry', async () => {
    const clock = manualClock()
    const store = new MemoryBuildStore({ clock })
    const h = harness(store, {
      operator: true,
      timeout: '29s',
      now: clock,
      operatorIdentity: { host: 'host-a', pid: 10, newId: () => 'one' },
      delay: async () => {
        clock.advance(29_000)
      },
    })
    await abWatch(h.base)
    const first = (await store.listOperatorPresence(REPO))[0]!
    expect(first.heartbeatAt).toBe(clock().toISOString())
    const cursor = JSON.parse(h.out.at(-1)!).cursor as string
    expect(decodeCursor(cursor, { store: decodeCursorStore(cursor), repo: REPO }).operator).toEqual(
      { id: 'one', startedAt: first.startedAt },
    )
    clock.advance(299_999)
    expect(await store.listOperatorPresence(REPO)).toHaveLength(1)
    clock.advance(1)
    expect(await store.listOperatorPresence(REPO)).toEqual([])
    const resumed = harness(store, {
      operator: true,
      since: cursor,
      now: clock,
      signal: alreadyAborted(),
      operatorIdentity: {
        host: 'host-b',
        pid: 20,
        newId: () => {
          throw new Error('must reuse ID')
        },
      },
    })
    await abWatch(resumed.base)
    expect(await store.listOperatorPresence(REPO)).toEqual([
      { ...first, host: 'host-b', pid: 20, heartbeatAt: clock().toISOString() },
    ])
    clock.advance(300_000)
    expect(await store.listOperatorPresence(REPO)).toEqual([])
  })

  test('legacy cursors create identities only when flagged; unflagged resumes write nothing', async () => {
    const clock = manualClock()
    const store = new MemoryBuildStore({ clock })
    const h = harness(store, { operator: true, signal: alreadyAborted(), now: clock })
    await abWatch(h.base)
    const cursor = JSON.parse(h.out.at(-1)!).cursor as string
    const original = await store.listOperatorPresence(REPO)
    clock.advance(1_000)
    const unflagged = harness(store, { since: cursor, signal: alreadyAborted(), now: clock })
    store.upsertOperatorPresence = async () => {
      throw new Error('unflagged write')
    }
    await abWatch(unflagged.base)
    expect(await store.listOperatorPresence(REPO)).toEqual(original)
    expect(await store.getRepo(REPO)).toBeNull()
  })

  test('foreign and malformed cursor rejection precedes registration', async () => {
    const store = makeStore()
    let writes = 0
    store.upsertOperatorPresence = async () => {
      writes++
      throw new Error('unexpected write')
    }
    for (const since of [
      'bad',
      encodeCursor({ v: 1, store: 'foreign', repo: REPO, streams: {} }),
    ]) {
      await expect(abWatch(harness(store, { operator: true, since }).base)).rejects.toThrow(
        '--since',
      )
    }
    expect(writes).toBe(0)
  })

  test('heartbeats continue during held initialization, retry failures once per streak, and join on exit', async () => {
    const clock = manualClock()
    const store = new MemoryBuildStore({ clock })
    let releaseRead!: () => void
    const held = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    store.listBuildsForRepo = async () => {
      await held
      return []
    }
    let releaseBeat!: () => void
    let delayEntered!: () => void
    let entered = new Promise<void>((resolve) => {
      delayEntered = resolve
    })
    const heartbeatDelay: NonNullable<AbWatchOpts['heartbeatDelay']> = async (_ms, signal) => {
      delayEntered()
      await new Promise<void>((resolve) => {
        releaseBeat = resolve
        if (signal?.aborted) resolve()
        else signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    let writes = 0
    const upsert = store.upsertOperatorPresence.bind(store)
    store.upsertOperatorPresence = async (...args) => {
      writes++
      if (writes === 2 || writes === 3) throw new Error('offline')
      return upsert(...args)
    }
    const h = harness(store, {
      operator: true,
      now: clock,
      interval: '1h',
      timeout: '1s',
      heartbeatDelay,
      delay: async () => {
        clock.advance(1_000)
      },
    })
    const running = abWatch(h.base)
    await entered
    for (let i = 0; i < 3; i++) {
      entered = new Promise<void>((resolve) => {
        delayEntered = resolve
      })
      clock.advance(30_000)
      releaseBeat()
      await entered
    }
    expect(writes).toBe(4)
    expect(h.err.filter((line) => line.includes('operator heartbeat failed'))).toHaveLength(1)
    expect((await store.listOperatorPresence(REPO))[0]!.heartbeatAt).toBe(clock().toISOString())
    releaseRead()
    await running
    expect(writes).toBe(5)
  })

  test('failed initial registration never attempts a final renewal', async () => {
    const store = makeStore()
    let writes = 0
    store.upsertOperatorPresence = async () => {
      writes++
      throw new Error('initial presence unavailable')
    }
    await expect(abWatch(harness(store, { operator: true }).base)).rejects.toThrow(
      'initial presence unavailable',
    )
    expect(writes).toBe(1)
  })

  test.each(['count', 'abort', 'error'] as const)(
    'final renewal on %s preserves the primary outcome when cleanup fails',
    async (mode) => {
      const store = makeStore()
      await seedRunningBuild(store, 'presence')
      const h = harness(store, {
        operator: true,
        ...(mode === 'abort' ? { signal: alreadyAborted() } : {}),
        ...(mode === 'count' ? { count: 1 } : {}),
        onTick: async () => {
          if (mode === 'error') throw new Error('primary error')
          await appendEscalation(store, 'presence')
        },
      })
      let writes = 0
      const upsert = store.upsertOperatorPresence.bind(store)
      store.upsertOperatorPresence = async (...args) => {
        if (++writes > 1) throw new Error('cleanup failure')
        return upsert(...args)
      }
      if (mode === 'error') await expect(abWatch(h.base)).rejects.toThrow('primary error')
      else await abWatch(h.base)
      expect(writes).toBe(2)
      expect(h.err.some((line) => line.includes('final operator heartbeat failed'))).toBe(true)
      if (mode === 'count') {
        for (const line of h.out) {
          const record = JSON.parse(line)
          expect(
            decodeCursor(record.cursor, { store: decodeCursorStore(record.cursor), repo: REPO })
              .operator?.id,
          ).toBeTruthy()
        }
      }
    },
  )
})

function decodeCursorStore(cursor: string): string {
  return JSON.parse(Buffer.from(cursor.slice(3), 'base64url').toString()).store as string
}

test('operator flag routes through the CLI and scope failures use stderr exit 1', async () => {
  const store = makeStore()
  const out: string[] = []
  const err: string[] = []
  let opens = 0
  const deps = {
    workspacePath: REPO,
    processEnv: {},
    exec: fakeExec,
    signal: alreadyAborted(),
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
    openStore: () => {
      opens++
      return store
    },
  }
  expect(await runCli(['watch', '--operator', '--json'], deps)).toBe(0)
  expect(await store.listOperatorPresence(REPO)).toHaveLength(1)
  for (const args of [
    ['watch', 'named', '--operator'],
    ['watch', 'named', '--repository', '--operator'],
  ]) {
    expect(await runCli(args, deps)).toBe(1)
  }
  expect(opens).toBe(1)
  expect(err).toHaveLength(2)
  expect(err.every((line) => line.includes('--operator requires a repository-wide watch'))).toBe(
    true,
  )
})

test('operator heartbeat runs while remote event reads are held with a large interval', async () => {
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  await seedRunningBuild(store, 'held')
  let heldRead!: () => void
  const readStarted = new Promise<void>((resolve) => {
    heldRead = resolve
  })
  const getEvents = store.getEvents.bind(store)
  store.getEvents = async (slug, since, opts) => {
    if (!opts?.waitSeconds) return getEvents(slug, since, opts)
    heldRead()
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted) resolve()
      else opts.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    return []
  }
  let tick!: () => void
  let ready!: () => void
  let armed = new Promise<void>((resolve) => {
    ready = resolve
  })
  const signal = new AbortController()
  const h = harness(store, {
    operator: true,
    storeRef: 'https://remote.test',
    now: clock,
    interval: '1h',
    timeout: '1h',
    signal: signal.signal,
    heartbeatDelay: async (_ms, abort) => {
      ready()
      await new Promise<void>((resolve) => {
        tick = resolve
        if (abort?.aborted) resolve()
        else abort?.addEventListener('abort', () => resolve(), { once: true })
      })
    },
    delay: async (_ms, abort) => {
      await new Promise<void>((resolve) => {
        if (abort?.aborted) resolve()
        else abort?.addEventListener('abort', () => resolve(), { once: true })
      })
    },
  })
  const running = abWatch(h.base)
  await readStarted
  await armed
  armed = new Promise<void>((resolve) => {
    ready = resolve
  })
  clock.advance(30_000)
  tick()
  await armed
  expect((await store.listOperatorPresence(REPO))[0]!.heartbeatAt).toBe(clock().toISOString())
  signal.abort()
  await running
  expect(h.err).toEqual([])
})
