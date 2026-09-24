/**
 * `ab watch` tests. The pure layer (globs, cursor codec, durations, cadence,
 * record projection, human lines) is tested without IO; the shell is tested
 * over MemoryBuildStore with an injected opener, clock, and delay seam — no
 * live service, no real sleeps. Every end condition (timeout, count,
 * terminal, signal) is driven deterministically through those seams.
 */
import { describe, expect, test } from 'bun:test'
import { DISPATCHER, KERNEL, agentActor, humanActor } from '../events/envelope'
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
    expect(records.map((record) => record.event.type)).toEqual([
      'escalation.raised',
      'build.completed',
    ])
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
    expect(records[1]).toMatchObject({ state: { status: 'done', outcome: 'merged' } })
    // The envelope is complete and passed through unchanged.
    expect(records[0]!.event).toMatchObject({ seq: 2, payload: { ...ESCALATION } })
  })

  test('repository events are never emitted without --repository, attention ones only with it', async () => {
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
          type: 'dispatcher.tick-failed',
          payload: { run: 'r1', error: 'boom' },
        })
      },
    })
    await abWatch({ ...quiet.base, timeout: '1' })
    expect(quiet.out.slice(0, -1)).toEqual([])

    // With --repository: attention events from after the baseline are emitted.
    const loud = harness(seeded, {
      onTick: async () => {
        await seeded.appendRepo(REPO, {
          actor: DISPATCHER,
          type: 'dispatcher.tick-failed',
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
    expect(records.map((record) => record.event.type)).toEqual(['dispatcher.tick-failed'])
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
    await abWatch({ ...h.base, timeout: '3' })

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
    ).toEqual({ late: 3 })
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
    await abWatch({ ...first.base, slugs: ['b1'], count: 1 })
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
    await abWatch({ ...second.base, slugs: ['b1'], since: cursor1 })
    const records2 = second.out
      .slice(0, -1)
      .map((line) => JSON.parse(line) as { event: { type: string; seq: number } })
    expect(records2.map((record) => record.event.type)).toEqual(['phase.failed'])
    expect(records2.map((record) => record.event.seq)).toEqual([3])

    // Run 3: the cursor from run 2's final position now delivers nothing new.
    const cursor2 = (JSON.parse(second.out.at(-1)!) as { cursor: string }).cursor
    const third = harness(store, { signal: alreadyAborted() })
    await abWatch({ ...third.base, slugs: ['b1'], since: cursor2 })
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
    await abWatch({ ...h.base, slugs: ['b1'], since: cursor })
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
    await abWatch({ ...h.base, slugs: ['b1'], count: 1 })
    const cursor = (JSON.parse(h.out.at(-1)!) as { cursor: string }).cursor
    expect(decodeCursor(cursor, { store: `${REPO}/.autobuild`, repo: REPO }).streams).toEqual({
      b1: 2,
    })

    // The phase.failed read in the same tick is redelivered, not skipped.
    const resume = harness(store, { signal: alreadyAborted() })
    await abWatch({ ...resume.base, slugs: ['b1'], since: cursor })
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
    await abWatch({ ...first.base, repository: true, timeout: '1' })
    expect(first.out.slice(0, -1)).toEqual([])
    const cursor = (JSON.parse(first.out.at(-1)!) as { cursor: string }).cursor
    expect(decodeCursor(cursor, { store: `${REPO}/.autobuild`, repo: REPO }).streams).toEqual({
      '#repo': 1,
    })

    // Run 2: resuming from that cursor delivers no pre-watch history.
    const second = harness(store)
    await abWatch({ ...second.base, repository: true, since: cursor, timeout: '1' })
    expect(second.out.slice(0, -1)).toEqual([])

    // Run 3: a journal event appended after the baseline is delivered exactly once.
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.tick-failed',
      payload: { run: 'r1', error: 'boom' },
    })
    const third = harness(store)
    await abWatch({ ...third.base, repository: true, since: cursor, timeout: '1' })
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
    expect(types).toEqual(['build.completed'])
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
    await abWatch({ ...h.base, slugs: ['b1'], since: cursor })
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
    await abWatch({ ...h.base, slugs: ['b1'], timeout: '2' })
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
    await abWatch({ ...h.base, storeRef: REMOTE_REF, slugs: ['b1'], since, timeout: '30' })
    const types = h.out
      .slice(0, -1)
      .map((line) => (JSON.parse(line) as { event: { type: string } }).event.type)
    // b1's terminal record, then b2's batch cut off after its first event:
    // the second escalation stays undelivered (the final cursor records the
    // position for the next run instead).
    expect(types).toEqual(['build.completed', 'escalation.raised'])
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
    await abWatch({ ...h.base, storeRef: REMOTE_REF, timeout: '5' })
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

test('an anchored journal baselines with one bounded read and no full journal read (AUT-534)', async () => {
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
  expect(probe.calls[0]).toEqual({ method: 'getRepoStateEvents' })
  expect(probe.calls.filter((call) => call.method === 'getRepoStateEvents')).toHaveLength(1)
  const journalReads = probe.calls.filter((call) => call.method === 'getRepoEvents')
  expect(journalReads.length).toBeGreaterThan(0)
  expect(journalReads.every((call) => (call.sinceSeq ?? 0) >= journalEnd)).toBe(true)

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
  await abWatch({ ...h.base, repository: true, timeout: '2' })
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
  await abWatch({ ...h.base, repository: true, timeout: '1' })
  expect(h.out.slice(0, -1)).toEqual([])

  // The recovery read fired: bounded read first, then the delta read from the
  // subset's (empty) end — the true journal end here — and every later read
  // polls from the recovered cursor.
  expect(probe.calls[0]).toEqual({ method: 'getRepoStateEvents' })
  expect(probe.calls[1]).toEqual({ method: 'getRepoEvents', sinceSeq: 0 })
  expect(
    probe.calls.slice(2).every((call) => call.method !== 'getRepoEvents' || call.sinceSeq === 1),
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
  expect(filtered.calls[0]).toEqual({ method: 'getRepoStateEvents' })
  expect(filtered.calls[1]).toEqual({ method: 'getRepoEvents', sinceSeq: 0 })
})
