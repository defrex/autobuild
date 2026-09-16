/**
 * `ab wait` tests. The pure layer (condition parsing, match order, immediate
 * return) and the shell are tested over MemoryBuildStore with an injected
 * opener, clock, and delay seam — no live service, no real sleeps. Every exit
 * path (satisfied, terminal, timeout, interrupt) is driven deterministically
 * through those seams, and the store is asserted unchanged after every wait.
 */
import { describe, expect, test } from 'bun:test'
import { DISPATCHER, KERNEL, agentActor } from '../events/envelope'
import { manualClock, steppingClock } from '../testing/fixed'
import type { Exec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import { InvalidAmbientContextError } from './env'
import { runCli } from './main'
import { PhaseSessionError, scopeLocalStoreToPhaseSession } from '../store/phase-session'
import type { BuildStore } from '../store/types'
import { encodeCursor } from './watch'
import { WAIT_USAGE, abWait, matchEvent, matchState, parseConditions } from './wait'

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

/** `createBuild` + `runner.attached`: the canonical running build. */
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

async function appendCompletion(
  store: MemoryBuildStore,
  slug: string,
  outcome: 'merged' | 'aborted' = 'merged',
): Promise<void> {
  if (outcome === 'aborted') {
    await store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })
  } else {
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome },
    })
  }
}

interface Harness {
  out: string[]
  err: string[]
  clock: ReturnType<typeof manualClock>
  base: import('./wait').AbWaitOpts
  openCount: () => number
}

function harness(
  store: MemoryBuildStore,
  overrides: Partial<import('./wait').AbWaitOpts> & {
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
  const base: import('./wait').AbWaitOpts = {
    targetRepo: REPO,
    env: {},
    exec: fakeExec,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    openStore: (ref, token) => opener(ref, token),
    now: clock,
    // One tick per delay call; each advances the clock 1s so a --timeout of
    // `n` seconds ends the wait after exactly n ticks. `onTick` runs side
    // effects (mid-wait appends, build creation) at the same boundary.
    delay: async () => {
      if (onTick !== undefined) await onTick()
      clock.advance(1000)
    },
    json: true,
    forValues: ['blocked'],
    ...overrides,
  }
  return { out, err, clock, base, openCount: () => opened }
}

interface ParsedRecord {
  build: string
  event: { type: string; seq: number }
  state: { status: string; phase: string | null; prState: string | null }
  cursor: string
  condition: string | null
}

const records = (out: string[]): ParsedRecord[] =>
  out.map((line) => JSON.parse(line) as ParsedRecord)

// ── Condition parsing and validation ─────────────────────────────────────────

describe('wait condition parsing', () => {
  test('the whole closed vocabulary parses; phase= accepts verify:<step> and core phases', () => {
    const { conditions, globs } = parseConditions(
      [
        'blocked',
        'paused',
        'running',
        'done',
        'aborted',
        'terminal',
        'pr=open',
        'pr=merged',
        'pr=closed',
        'pr=conflicted',
        'phase=finalize',
        'phase=verify:e2e',
        'attention',
      ],
      ['pr.*', 'escalation.*'],
    )
    expect(conditions.map((condition) => condition.text)).toEqual([
      'blocked',
      'paused',
      'running',
      'done',
      'aborted',
      'terminal',
      'pr=open',
      'pr=merged',
      'pr=closed',
      'pr=conflicted',
      'phase=finalize',
      'phase=verify:e2e',
      'attention',
    ])
    expect(globs.map((glob) => glob.text)).toEqual(['pr.*', 'escalation.*'])
  })

  test('unknown --for values and an empty phase= are rejected, naming vocabulary and usage', () => {
    for (const value of ['bogus', 'pr=opened', 'phase=', 'phase=bogus', 'TERMINAL', '']) {
      expect(() => parseConditions([value], [])).toThrow(`unknown --for condition "${value}"`)
      expect(() => parseConditions([value], [])).toThrow('pr=conflicted')
      expect(() => parseConditions([value], [])).toThrow(WAIT_USAGE)
    }
  })

  test('an unknown --event glob is rejected with the wait usage line', () => {
    expect(() => parseConditions([], ['bogus.*'])).toThrow('--event "bogus.*"')
    expect(() => parseConditions([], ['bogus.*'])).toThrow(WAIT_USAGE)
  })

  test('every validation failure happens before the store is opened, with nothing on stdout', async () => {
    const store = makeStore()
    const h = harness(store)
    await expect(abWait({ ...h.base, forValues: ['bogus'] })).rejects.toThrow('bogus')
    await expect(abWait({ ...h.base, events: ['bogus.*'] })).rejects.toThrow('bogus.*')
    await expect(abWait({ ...h.base, forValues: [], events: [] })).rejects.toThrow(WAIT_USAGE)
    expect(h.openCount()).toBe(0)
    expect(h.out).toEqual([])
  })

  test('matchState walks --for values in supply order; attention is event-only', () => {
    const state = {
      status: 'blocked',
      phase: 'verify:e2e',
      prState: 'conflicted',
    } as unknown as Parameters<typeof matchState>[1]
    expect(
      matchState(
        parseConditions(['pr=conflicted', 'phase=verify:e2e', 'blocked'], []).conditions,
        state,
      ),
    ).toBe('pr=conflicted')
    expect(
      matchState(parseConditions(['phase=verify:e2e', 'pr=conflicted'], []).conditions, state),
    ).toBe('phase=verify:e2e')
    expect(matchState(parseConditions(['terminal', 'blocked'], []).conditions, state)).toBe(
      'blocked',
    )
    expect(matchState(parseConditions(['running', 'pr=open'], []).conditions, state)).toBeNull()
    expect(matchState(parseConditions(['attention'], []).conditions, state)).toBeNull()
  })

  test('matchEvent checks attention per supply order, then globs in supply order', () => {
    const attention = { type: 'escalation.raised' } as Parameters<typeof matchEvent>[0]
    const conditions = parseConditions(['attention'], []).conditions
    expect(matchEvent(attention, conditions, [])).toBe('attention')
    expect(
      matchEvent(attention, parseConditions(['done'], []).conditions, [
        { regex: /^escalation\..*$/, text: 'escalation.*' },
        { regex: /^build\..*$/, text: 'build.*' },
      ]),
    ).toBe('escalation.*')
    expect(
      matchEvent({ type: 'plan.started' } as Parameters<typeof matchEvent>[0], conditions, [
        { regex: /^escalation\..*$/, text: 'escalation.*' },
        { regex: /^build\..*$/, text: 'build.*' },
      ]),
    ).toBeNull()
  })
})

// ── Immediate return on an already-satisfied condition ───────────────────────

describe('wait immediate return', () => {
  test('an already-blocked build ends the wait at once with its latest event', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    await appendEscalation(store, 'b1')
    let delayCalls = 0
    const h = harness(store, {
      delay: async () => {
        delayCalls += 1
      },
    })
    expect(await abWait({ ...h.base, slugs: ['b1'] })).toBe(0)
    expect(delayCalls).toBe(0)
    const [record] = records(h.out)
    expect(record).toMatchObject({
      build: 'b1',
      event: { type: 'escalation.raised', seq: 2 },
      state: { status: 'blocked' },
      condition: 'blocked',
    })
    expect(Object.keys(record!)).toEqual(['build', 'event', 'state', 'cursor', 'condition'])
  })

  test('already-satisfied pr, phase, and terminal conditions return immediately', async () => {
    // pr=open via finalize.completed.
    const prStore = makeStore()
    await seedRunningBuild(prStore, 'b1')
    await prStore.append('b1', {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: { pr: { number: 7, url: 'https://forge/pr/7', headSha: 'abc' } },
    })
    const prh = harness(prStore)
    expect(await abWait({ ...prh.base, slugs: ['b1'], forValues: ['pr=open'] })).toBe(0)
    expect(records(prh.out)[0]).toMatchObject({
      state: { prState: 'open' },
      condition: 'pr=open',
    })

    // phase=finalize via finalize.started.
    const phaseStore = makeStore()
    await seedRunningBuild(phaseStore, 'b1')
    await phaseStore.append('b1', { actor: KERNEL, type: 'finalize.started', payload: {} })
    const phaseh = harness(phaseStore)
    expect(await abWait({ ...phaseh.base, slugs: ['b1'], forValues: ['phase=finalize'] })).toBe(0)
    expect(records(phaseh.out)[0]).toMatchObject({
      state: { phase: 'finalize' },
      condition: 'phase=finalize',
    })

    // terminal on a done build.
    const doneStore = makeStore()
    await seedRunningBuild(doneStore, 'b1')
    await appendCompletion(doneStore, 'b1')
    const doneh = harness(doneStore)
    expect(await abWait({ ...doneh.base, slugs: ['b1'], forValues: ['terminal'] })).toBe(0)
    expect(records(doneh.out)[0]).toMatchObject({
      state: { status: 'done' },
      condition: 'terminal',
    })
  })

  test('--since does not suppress the immediate-return state check', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    await appendEscalation(store, 'b1')
    const cursor = encodeCursor({
      v: 1,
      store: `${REPO}/.autobuild`,
      repo: REPO,
      streams: { b1: 1 },
    })
    const h = harness(store)
    expect(await abWait({ ...h.base, slugs: ['b1'], since: cursor })).toBe(0)
    expect(records(h.out)[0]).toMatchObject({ condition: 'blocked', event: { seq: 2 } })
  })

  test('the human form is one plain line with the condition in parentheses, no ANSI', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    await appendEscalation(store, 'b1')
    const h = harness(store, { json: false })
    expect(await abWait({ ...h.base, slugs: ['b1'] })).toBe(0)
    expect(h.out).toHaveLength(1)
    const [line] = h.out
    expect(line).not.toMatch(/\x1b[\d;]*/)
    expect(line).toContain('escalation.raised')
    expect(line).toContain('(blocked)')
  })
})

// ── Conditions becoming true through post-start events ───────────────────────

describe('wait conditions satisfied by later events', () => {
  test('status conditions: running, blocked, paused, done, aborted', async () => {
    // running via runner attach on a queued build.
    const running = makeStore()
    await running.createBuild({ slug: 'b1', repo: REPO })
    const runningh = harness(running, {
      forValues: ['running'],
      onTick: async () => {
        await running.append('b1', {
          actor: KERNEL,
          type: 'runner.attached',
          payload: { instance: 'i1', host: 'h1', resumedFromSeq: 0 },
        })
      },
    })
    expect(await abWait({ ...runningh.base, slugs: ['b1'], timeout: '1' })).toBe(0)
    expect(records(runningh.out)[0]).toMatchObject({ state: { status: 'running' } })

    for (const [outcome, condition] of [
      ['merged', 'done'],
      ['aborted', 'aborted'],
    ] as const) {
      const terminal = makeStore()
      await seedRunningBuild(terminal, 'b1')
      const terminalh = harness(terminal, {
        forValues: [condition],
        onTick: async () => {
          await appendCompletion(terminal, 'b1', outcome)
        },
      })
      expect(await abWait({ ...terminalh.base, slugs: ['b1'], timeout: '1' })).toBe(0)
      expect(records(terminalh.out)[0]).toMatchObject({
        state: { status: condition },
        condition,
      })
    }
  })

  test('blocked and paused through escalation and pause', async () => {
    const blocked = makeStore()
    await seedRunningBuild(blocked, 'b1')
    const blockedh = harness(blocked, {
      onTick: async () => {
        await appendEscalation(blocked, 'b1')
      },
    })
    expect(await abWait({ ...blockedh.base, slugs: ['b1'], timeout: '1' })).toBe(0)
    expect(records(blockedh.out)[0]).toMatchObject({ state: { status: 'blocked' } })

    const paused = makeStore()
    await seedRunningBuild(paused, 'b1')
    const pausedh = harness(paused, {
      forValues: ['paused'],
      onTick: async () => {
        await paused.append('b1', { actor: KERNEL, type: 'build.paused', payload: {} })
      },
    })
    expect(await abWait({ ...pausedh.base, slugs: ['b1'], timeout: '1' })).toBe(0)
    expect(records(pausedh.out)[0]).toMatchObject({ state: { status: 'paused' } })
  })

  test('pr lifecycle conditions, including reconcile returning to open', async () => {
    // pr=merged.
    const merged = makeStore()
    await seedRunningBuild(merged, 'b1')
    let mergedTicks = 0
    const mergedh = harness(merged, {
      forValues: ['pr=merged'],
      onTick: async () => {
        mergedTicks += 1
        if (mergedTicks === 1) {
          await merged.append('b1', {
            actor: KERNEL,
            type: 'finalize.completed',
            payload: { pr: { number: 7, url: 'https://forge/pr/7', headSha: 'abc' } },
          })
          await merged.append('b1', {
            actor: DISPATCHER,
            type: 'pr.merged',
            payload: { sha: 'def' },
          })
        }
      },
    })
    expect(await abWait({ ...mergedh.base, slugs: ['b1'], timeout: '1' })).toBe(0)
    expect(records(mergedh.out)[0]).toMatchObject({ state: { prState: 'merged' } })

    // pr=closed and pr=conflicted.
    const closed = makeStore()
    await seedRunningBuild(closed, 'b1')
    let closedTicks = 0
    const closedh = harness(closed, {
      forValues: ['pr=closed'],
      onTick: async () => {
        closedTicks += 1
        if (closedTicks === 1) {
          await closed.append('b1', {
            actor: KERNEL,
            type: 'finalize.completed',
            payload: { pr: { number: 7, url: 'https://forge/pr/7', headSha: 'abc' } },
          })
          await closed.append('b1', { actor: DISPATCHER, type: 'pr.closed', payload: {} })
        }
      },
    })
    expect(await abWait({ ...closedh.base, slugs: ['b1'], timeout: '1' })).toBe(0)
    expect(records(closedh.out)[0]).toMatchObject({ state: { prState: 'closed' } })

    const conflicted = makeStore()
    await seedRunningBuild(conflicted, 'b1')
    let conflictedTicks = 0
    const conflictedh = harness(conflicted, {
      forValues: ['pr=conflicted'],
      onTick: async () => {
        conflictedTicks += 1
        if (conflictedTicks === 1) {
          await conflicted.append('b1', {
            actor: KERNEL,
            type: 'finalize.completed',
            payload: { pr: { number: 7, url: 'https://forge/pr/7', headSha: 'abc' } },
          })
          await conflicted.append('b1', {
            actor: DISPATCHER,
            type: 'pr.conflicted',
            payload: { baseSha: 'base' },
          })
        }
      },
    })
    expect(await abWait({ ...conflictedh.base, slugs: ['b1'], timeout: '1' })).toBe(0)
    expect(records(conflictedh.out)[0]).toMatchObject({ state: { prState: 'conflicted' } })

    // reconcile.completed returns a conflicted PR to open.
    const reopened = makeStore()
    await seedRunningBuild(reopened, 'b1')
    await reopened.append('b1', {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: { pr: { number: 7, url: 'https://forge/pr/7', headSha: 'abc' } },
    })
    await reopened.append('b1', {
      actor: DISPATCHER,
      type: 'pr.conflicted',
      payload: { baseSha: 'base' },
    })
    let reopenTicks = 0
    const reopenh = harness(reopened, {
      forValues: ['pr=open'],
      onTick: async () => {
        reopenTicks += 1
        if (reopenTicks === 1) {
          await reopened.append('b1', {
            actor: DISPATCHER,
            type: 'reconcile.completed',
            payload: { mergeCommit: 'ghi', artifact: { kind: 'reconcile', rev: 0 } },
          })
        }
      },
    })
    expect(await abWait({ ...reopenh.base, slugs: ['b1'], timeout: '1' })).toBe(0)
    expect(records(reopenh.out)[0]).toMatchObject({ state: { prState: 'open' } })
  })

  test('phase conditions: plan, verify:<step>, finalize', async () => {
    const plan = makeStore()
    await plan.createBuild({ slug: 'b1', repo: REPO })
    const planh = harness(plan, {
      forValues: ['phase=plan'],
      onTick: async () => {
        await plan.append('b1', {
          actor: KERNEL,
          type: 'plan.started',
          payload: { round: 1 },
        })
      },
    })
    expect(await abWait({ ...planh.base, slugs: ['b1'], timeout: '1' })).toBe(0)
    expect(records(planh.out)[0]).toMatchObject({ state: { phase: 'plan' } })

    const verify = makeStore()
    await seedRunningBuild(verify, 'b1')
    const verifyh = harness(verify, {
      forValues: ['phase=verify:e2e'],
      onTick: async () => {
        await verify.append('b1', {
          actor: KERNEL,
          type: 'verify.started',
          payload: { step: 'e2e', attempt: 1 },
        })
      },
    })
    expect(await abWait({ ...verifyh.base, slugs: ['b1'], timeout: '1' })).toBe(0)
    expect(records(verifyh.out)[0]).toMatchObject({ state: { phase: 'verify:e2e' } })

    const finalize = makeStore()
    await seedRunningBuild(finalize, 'b1')
    const finalizeh = harness(finalize, {
      forValues: ['phase=finalize'],
      onTick: async () => {
        await finalize.append('b1', { actor: KERNEL, type: 'finalize.started', payload: {} })
      },
    })
    expect(await abWait({ ...finalizeh.base, slugs: ['b1'], timeout: '1' })).toBe(0)
    expect(records(finalizeh.out)[0]).toMatchObject({ state: { phase: 'finalize' } })
  })

  test('attention fires only on post-start attention events, not pre-existing ones', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    await appendEscalation(store, 'b1') // pre-existing: must NOT fire
    let ticks = 0
    const h = harness(store, {
      forValues: ['attention'],
      onTick: async () => {
        ticks += 1
        if (ticks === 2) {
          await store.append('b1', {
            actor: KERNEL,
            type: 'phase.failed',
            payload: { phase: 'implement', attempt: 1, error: 'boom', willRetry: false },
          })
        }
      },
    })
    expect(await abWait({ ...h.base, slugs: ['b1'], timeout: '2' })).toBe(0)
    // The pre-existing escalation.raised is history; the mid-wait
    // phase.failed is the one attention event that fires.
    expect(records(h.out)[0]).toMatchObject({
      event: { type: 'phase.failed' },
      condition: 'attention',
    })
  })

  test('--event globs fire on post-start matches and name the glob text', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    const h = harness(store, {
      forValues: [],
      events: ['pr.*'],
      onTick: async () => {
        await store.append('b1', {
          actor: KERNEL,
          type: 'finalize.completed',
          payload: { pr: { number: 7, url: 'https://forge/pr/7', headSha: 'abc' } },
        })
        await store.append('b1', { actor: DISPATCHER, type: 'pr.merged', payload: { sha: 'def' } })
      },
    })
    expect(await abWait({ ...h.base, slugs: ['b1'], timeout: '1' })).toBe(0)
    // finalize.completed does not match pr.*; pr.merged does, and the
    // record's condition is the glob text.
    expect(records(h.out)[0]).toMatchObject({ event: { type: 'pr.merged' }, condition: 'pr.*' })
  })

  test('alternatives: the first satisfied condition wins, for-values before globs', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    let ticks = 0
    const h = harness(store, {
      forValues: ['done', 'attention'],
      events: ['pr.*'],
      onTick: async () => {
        ticks += 1
        if (ticks === 1) await appendEscalation(store, 'b1')
        if (ticks === 2) {
          await store.append('b1', {
            actor: DISPATCHER,
            type: 'build.completed',
            payload: { outcome: 'merged' },
          })
        }
      },
    })
    expect(await abWait({ ...h.base, slugs: ['b1'], timeout: '3' })).toBe(0)
    // attention (escalation.raised) fires before done (build.completed).
    expect(records(h.out)[0]).toMatchObject({
      event: { type: 'escalation.raised' },
      condition: 'attention',
    })

    // For-value attention also beats a matching glob on the same event.
    const both = makeStore()
    await seedRunningBuild(both, 'b1')
    const bothh = harness(both, {
      forValues: ['attention'],
      events: ['escalation.*'],
      onTick: async () => {
        await appendEscalation(both, 'b1')
      },
    })
    expect(await abWait({ ...bothh.base, slugs: ['b1'], timeout: '1' })).toBe(0)
    expect(records(bothh.out)[0]).toMatchObject({ condition: 'attention' })

    // With no matching --for, the glob names the condition.
    const globOnly = makeStore()
    await seedRunningBuild(globOnly, 'b1')
    const globh = harness(globOnly, {
      forValues: ['done'],
      events: ['escalation.*'],
      onTick: async () => {
        await appendEscalation(globOnly, 'b1')
      },
    })
    expect(await abWait({ ...globh.base, slugs: ['b1'], timeout: '1' })).toBe(0)
    expect(records(globh.out)[0]).toMatchObject({ condition: 'escalation.*' })
  })
})

// ── --since: the two satisfaction classes ────────────────────────────────────

describe('wait --since semantics', () => {
  test('attention and --event conditions are satisfied by backlog events after the cursor', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    await appendEscalation(store, 'b1')
    const cursor = encodeCursor({
      v: 1,
      store: `${REPO}/.autobuild`,
      repo: REPO,
      streams: { b1: 1 },
    })
    const h = harness(store, { forValues: ['attention'] })
    expect(await abWait({ ...h.base, slugs: ['b1'], since: cursor })).toBe(0)
    expect(records(h.out)[0]).toMatchObject({
      event: { type: 'escalation.raised', seq: 2 },
      condition: 'attention',
    })
    // The returned cursor resumes exactly after the delivered event.
    expect(records(h.out)[0]!.cursor).not.toBe(cursor)
  })

  test('backlog state events do not satisfy state conditions', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    await appendEscalation(store, 'b1')
    // Cursor before the escalation: the backlog contains a state event that
    // produces blocked, but state conditions need a post-start event.
    const cursor = encodeCursor({
      v: 1,
      store: `${REPO}/.autobuild`,
      repo: REPO,
      streams: { b1: 1 },
    })
    let ticks = 0
    const h = harness(store, {
      onTick: async () => {
        ticks += 1
        if (ticks === 1) await appendEscalation(store, 'b1')
      },
    })
    expect(await abWait({ ...h.base, slugs: ['b1'], since: cursor, timeout: '2' })).toBe(0)
    // The pre-existing escalation's reduction is backlog; the wait ends on
    // the POST-START escalation (the appended one), never on the backlog one.
    expect(records(h.out)).toHaveLength(1)
  })

  test('a state condition already true at start fires despite --since; backlog does not double-fire', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    await appendEscalation(store, 'b1')
    const cursor = encodeCursor({
      v: 1,
      store: `${REPO}/.autobuild`,
      repo: REPO,
      streams: { b1: 2 },
    })
    let delayCalls = 0
    const h = harness(store, {
      delay: async () => {
        delayCalls += 1
      },
    })
    expect(await abWait({ ...h.base, slugs: ['b1'], since: cursor })).toBe(0)
    expect(delayCalls).toBe(0)
    expect(records(h.out)).toHaveLength(1)
    expect(records(h.out)[0]).toMatchObject({ condition: 'blocked', event: { seq: 2 } })
  })
})

// ── Exit 2: named builds all terminal, unsatisfied ───────────────────────────

describe('wait exit 2 — named builds terminal without satisfaction', () => {
  test('a named build going terminal unsatisfied ends with the terminal record and condition null', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    const h = harness(store, {
      forValues: ['blocked'],
      onTick: async () => {
        await appendCompletion(store, 'b1')
      },
    })
    expect(await abWait({ ...h.base, slugs: ['b1'], timeout: '1' })).toBe(2)
    const [record] = records(h.out)
    expect(record).toMatchObject({
      event: { type: 'build.completed' },
      state: { status: 'done' },
      condition: null,
    })
  })

  test('all named builds already terminal at start exit 2 immediately with the latest terminal event', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    await appendCompletion(store, 'b1')
    await seedRunningBuild(store, 'b2')
    await appendCompletion(store, 'b2')
    let delayCalls = 0
    const h = harness(store, {
      forValues: ['blocked'],
      delay: async () => {
        delayCalls += 1
      },
    })
    expect(await abWait({ ...h.base, slugs: ['b1', 'b2'] })).toBe(2)
    expect(delayCalls).toBe(0)
    const [record] = records(h.out)
    expect(record).toMatchObject({
      build: 'b2',
      event: { type: 'build.completed' },
      state: { status: 'done' },
      condition: null,
    })
  })

  test('--for terminal on already-terminal named builds exits 0, not 2', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    await appendCompletion(store, 'b1')
    const h = harness(store)
    expect(await abWait({ ...h.base, slugs: ['b1'], forValues: ['terminal'] })).toBe(0)
    expect(records(h.out)[0]).toMatchObject({ state: { status: 'done' }, condition: 'terminal' })
  })

  test('a partially terminal named set keeps waiting until the last build ends', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    await seedRunningBuild(store, 'b2')
    await appendCompletion(store, 'b1')
    let ticks = 0
    const h = harness(store, {
      forValues: ['blocked'],
      onTick: async () => {
        ticks += 1
        if (ticks === 2) await appendCompletion(store, 'b2')
      },
    })
    expect(await abWait({ ...h.base, slugs: ['b1', 'b2'], timeout: '3' })).toBe(2)
    // The record is the event that made the FINAL named build terminal.
    expect(records(h.out)[0]).toMatchObject({ build: 'b2', condition: null })
  })
})

// ── Exit 3 / exit 4: timeout and interrupt ───────────────────────────────────

describe('wait timeout and interrupt', () => {
  test('timeout exits 3 with a stderr line and no stdout; --json adds a bare cursor', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    const plain = harness(store, { json: false })
    expect(await abWait({ ...plain.base, slugs: ['b1'], timeout: '2' })).toBe(3)
    expect(plain.out).toEqual([])
    expect(plain.err).toEqual([expect.stringContaining('ab wait: timed out')])

    const json = harness(store)
    expect(await abWait({ ...json.base, slugs: ['b1'], timeout: '2' })).toBe(3)
    const [cursorRecord] = records(json.out)
    expect(Object.keys(cursorRecord!)).toEqual(['cursor'])
  })

  test('--timeout 0 never expires', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    let ticks = 0
    const h = harness(store, {
      onTick: async () => {
        ticks += 1
        if (ticks === 50) await appendEscalation(store, 'b1')
      },
    })
    expect(await abWait({ ...h.base, slugs: ['b1'], timeout: '0' })).toBe(0)
    expect(ticks).toBe(50)
  })

  test('an aborted signal exits 4 with no record; --json adds a bare cursor', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    const plain = harness(store, { json: false, signal: AbortSignal.abort() })
    expect(await abWait({ ...plain.base, slugs: ['b1'] })).toBe(4)
    expect(plain.out).toEqual([])
    expect(plain.err).toEqual([expect.stringContaining('ab wait: interrupted')])

    const json = harness(store, { signal: AbortSignal.abort() })
    expect(await abWait({ ...json.base, slugs: ['b1'] })).toBe(4)
    const [cursorRecord] = records(json.out)
    expect(Object.keys(cursorRecord!)).toEqual(['cursor'])
  })

  test('exit invariants: 0 only with a record, 3/4 never with one, 2 only with condition null', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    await appendEscalation(store, 'b1')
    const satisfied = harness(store)
    expect(await abWait({ ...satisfied.base, slugs: ['b1'] })).toBe(0)
    expect(records(satisfied.out)).toHaveLength(1)
    expect(records(satisfied.out)[0]!.condition).toBe('blocked')

    // A build that never satisfies: timeout and interrupt leave no record.
    const quiet = makeStore()
    await seedRunningBuild(quiet, 'b1')
    const timedOut = harness(quiet)
    expect(await abWait({ ...timedOut.base, slugs: ['b1'], timeout: '1' })).toBe(3)
    for (const line of timedOut.out) expect(Object.keys(JSON.parse(line))).toEqual(['cursor'])

    const interrupted = harness(quiet, { signal: AbortSignal.abort() })
    expect(await abWait({ ...interrupted.base, slugs: ['b1'] })).toBe(4)
    for (const line of interrupted.out) expect(Object.keys(JSON.parse(line))).toEqual(['cursor'])
  })
})

// ── The no-slug waiting rule ─────────────────────────────────────────────────

describe('wait no-slug membership', () => {
  test('an empty store keeps waiting until a build appears and satisfies', async () => {
    const store = makeStore()
    let ticks = 0
    const h = harness(store, {
      onTick: async () => {
        ticks += 1
        if (ticks === 1) {
          await seedRunningBuild(store, 'late')
        }
        if (ticks === 2) await appendEscalation(store, 'late')
      },
    })
    expect(await abWait({ ...h.base, timeout: '3' })).toBe(0)
    expect(records(h.out)[0]).toMatchObject({
      build: 'late',
      event: { type: 'escalation.raised' },
      condition: 'blocked',
    })
  })

  test('an entirely terminal set keeps waiting for a build to appear', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'done-build')
    await appendCompletion(store, 'done-build')
    let ticks = 0
    const h = harness(store, {
      onTick: async () => {
        ticks += 1
        if (ticks === 1) {
          await seedRunningBuild(store, 'fresh')
          await appendEscalation(store, 'fresh')
        }
      },
    })
    expect(await abWait({ ...h.base, timeout: '2' })).toBe(0)
    expect(records(h.out)[0]).toMatchObject({ build: 'fresh', condition: 'blocked' })
  })

  test('a newly discovered build that already satisfies ends the wait', async () => {
    const store = makeStore()
    let ticks = 0
    const h = harness(store, {
      onTick: async () => {
        ticks += 1
        if (ticks === 1) {
          await seedRunningBuild(store, 'late')
          await appendEscalation(store, 'late')
        }
      },
    })
    expect(await abWait({ ...h.base, timeout: '2' })).toBe(0)
    expect(records(h.out)[0]).toMatchObject({
      build: 'late',
      condition: 'blocked',
      event: { type: 'escalation.raised' },
    })
  })
})

// ── Ambient scope ────────────────────────────────────────────────────────────

describe('wait ambient scope', () => {
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
    const error = (await abWait({ ...h.base, env: ambientEnv }).catch(
      (caught: unknown) => caught as Error,
    )) as Error
    expect(error).toBeInstanceOf(PhaseSessionError)
    expect(error.message).toBe(await realScopeError((scoped) => scoped.listBuilds()))
    expect(h.openCount()).toBe(0)
  })

  test('a foreign slug is denied exactly as the handle denies getEvents on it', async () => {
    const store = makeStore()
    const h = harness(store)
    const error = (await abWait({ ...h.base, env: ambientEnv, slugs: ['other'] }).catch(
      (caught: unknown) => caught as Error,
    )) as Error
    expect(error).toBeInstanceOf(PhaseSessionError)
    expect(error.message).toBe(await realScopeError((scoped) => scoped.getEvents('other')))
    expect(h.openCount()).toBe(0)
  })

  test('the ambient build itself may be waited on through the scoped handle', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    await appendEscalation(store, 'b1')
    const h = harness(store, { env: ambientEnv })
    expect(await abWait({ ...h.base, slugs: ['b1'] })).toBe(0)
    expect(records(h.out)[0]).toMatchObject({ build: 'b1', condition: 'blocked' })
  })

  test('malformed or partial ambient identity fails closed before the store is opened', async () => {
    const store = makeStore()
    for (const env of [
      { AB_BUILD: 'b1' },
      { AB_PHASE: 'implement@1' },
      { AB_BUILD: 'b1', AB_PHASE: 'implement@1' },
    ]) {
      const h = harness(store)
      await expect(abWait({ ...h.base, env, slugs: ['b1'] })).rejects.toBeInstanceOf(
        InvalidAmbientContextError,
      )
      expect(h.openCount()).toBe(0)
    }
  })
})

// ── Read-failure policy and read-only discipline ─────────────────────────────

describe('wait resilience and read-only discipline', () => {
  test('a failed read is reported once, retried, and the condition still fires exactly once', async () => {
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
    let ticks = 0
    const h = harness(store, {
      openStore: () => flaky,
      onTick: async () => {
        ticks += 1
        if (ticks === 2) await appendEscalation(store, 'b1')
      },
    })
    expect(await abWait({ ...h.base, slugs: ['b1'], timeout: '3' })).toBe(0)
    expect(h.err).toEqual([
      expect.stringContaining('ab wait: a store read failed (store read failed)'),
    ])
    // Delivered exactly once, on the retry — neither skipped nor duplicated.
    expect(records(h.out)).toHaveLength(1)
    expect(records(h.out)[0]).toMatchObject({ event: { type: 'escalation.raised', seq: 2 } })
  })

  test('a satisfied wait appends nothing and creates no record', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    await appendEscalation(store, 'b1')
    const eventsBefore = (await store.getEvents('b1')).length
    const buildsBefore = (await store.listBuilds()).length
    const h = harness(store)
    expect(await abWait({ ...h.base, slugs: ['b1'] })).toBe(0)
    expect(await store.getEvents('b1')).toHaveLength(eventsBefore)
    expect(await store.listBuilds()).toHaveLength(buildsBefore)
  })
})

// ── Exit-code plumbing through runCli ────────────────────────────────────────

describe('wait wiring and exit codes', () => {
  test('usage errors name the usage line and emit nothing on stdout', async () => {
    const out: string[] = []
    const err: string[] = []
    const deps = {
      workspacePath: '/no/wait/dependencies',
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      exec: fakeExec,
    }
    expect(await runCli(['wait', 'b1'], deps)).toBe(1)
    expect(err[0]).toContain(WAIT_USAGE)
    expect(await runCli(['wait', 'b1', '--for', 'bogus'], deps)).toBe(1)
    expect(err[1]).toContain('unknown --for condition "bogus"')
    expect(await runCli(['wait', 'b1', '--bogus'], deps)).toBe(1)
    expect(err[2]).toContain('unknown flag --bogus')
    expect(out).toEqual([])
  })

  test('sessionless registration: ab wait reaches the command outside any phase', async () => {
    const { SESSIONLESS_COMMANDS } = await import('./main')
    expect(SESSIONLESS_COMMANDS.has('wait')).toBe(true)
    // With no AB_* ambient environment, `ab wait` must reach its own usage
    // error — not phase-required routing's "runs inside a build session".
    const out: string[] = []
    const err: string[] = []
    const code = await runCli(['wait'], {
      workspacePath: '/no/wait/dependencies',
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    })
    expect(code).toBe(1)
    expect(err.join('\n')).toContain(WAIT_USAGE)
    expect(err.join('\n')).not.toContain('runs inside a build session')
  })

  test('the full exit-code contract is visible at the CLI boundary', async () => {
    const store = makeStore()
    await seedRunningBuild(store, 'b1')
    await appendEscalation(store, 'b1')
    const openStore = () => store
    const out: string[] = []
    const err: string[] = []
    const baseDeps = {
      workspacePath: REPO,
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      exec: fakeExec,
      openStore,
    }
    // Satisfied → 0, with exactly one record.
    out.length = 0
    expect(await runCli(['wait', 'b1', '--for', 'blocked', '--json'], baseDeps)).toBe(0)
    expect(records(out)).toHaveLength(1)
    // Terminal unsatisfied → 2.
    const terminalStore = makeStore()
    await seedRunningBuild(terminalStore, 'b1')
    await appendCompletion(terminalStore, 'b1')
    out.length = 0
    err.length = 0
    expect(
      await runCli(['wait', 'b1', '--for', 'blocked', '--json'], {
        ...baseDeps,
        openStore: () => terminalStore,
      }),
    ).toBe(2)
    expect(records(out)[0]).toMatchObject({ condition: null })
    // Timeout → 3.
    out.length = 0
    err.length = 0
    const emptyStore = makeStore()
    await seedRunningBuild(emptyStore, 'b1')
    expect(
      await runCli(['wait', 'b1', '--for', 'blocked', '--json', '--timeout', '1'], {
        ...baseDeps,
        openStore: () => emptyStore,
      }),
    ).toBe(3)
    expect(Object.keys(JSON.parse(out[0]!))).toEqual(['cursor'])
    expect(err.join('\n')).toContain('ab wait: timed out')
    // Interrupted → 4: a build that never satisfies, so the wait reaches
    // the loop and observes the already-aborted signal.
    out.length = 0
    err.length = 0
    expect(
      await runCli(['wait', 'b1', '--for', 'blocked', '--json'], {
        ...baseDeps,
        openStore: () => emptyStore,
        signal: AbortSignal.abort(),
      }),
    ).toBe(4)
    expect(Object.keys(JSON.parse(out[0]!))).toEqual(['cursor'])
    expect(err.join('\n')).toContain('ab wait: interrupted')
  })

  test('ab help wait renders', async () => {
    const out: string[] = []
    const err: string[] = []
    const code = await runCli(['help', 'wait'], {
      workspacePath: '/no/help/dependencies',
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    })
    expect(code).toBe(0)
    expect(err).toEqual([])
    expect(out.join('\n')).toContain('--for <condition>')
    expect(out.join('\n')).toContain('exit 2')
    expect(out.join('\n')).toContain('exit 4')
  })
})
