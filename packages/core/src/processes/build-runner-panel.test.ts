// Load the reducer registry first: build-runner's import cycle otherwise reaches
// a reducer before it is initialized when this file runs alone.
import '../kernel/reducer-registry'
import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import type { AbEvent } from '../events/catalog'
import { DISPATCHER, humanActor } from '../events/envelope'
import { sequentialIds } from '../ids'
import { FakeForge } from '../ports/forge/fake'
import { ScriptedAgentRunner, defaultTurnResult, type ScriptContext } from '../ports/runner/fake'
import type { AgentTurnResult } from '../ports/types'
import type { Exec, ExecResult } from '../ports/workspace/git-worktree'
import { panelObjective } from '../kernel/generators/optimization-log'
import { reduceBuild } from '../kernel/reducer'
import type { Objective } from '../objective'
import { MemoryBuildStore } from '../store/memory'
import { scopeLocalStoreToJudgeSession } from '../store/phase-session'
import type { BuildStore } from '../store/types'
import { steppingClock } from '../testing/fixed'
import { BuildRunner, type PanelRequest } from './build-runner'
import { TMPDIR_PROBE } from './panel-runner'

const SLUG = 'attempt-a1'
const WORKSPACE = '/ws/attempt-a1'
const CANDIDATE = 'c'.repeat(40)
const BASELINE = 'b'.repeat(40)
const PIN = 'a'.repeat(40)

const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

/** Git and shell plumbing for the materializer, answering every probe. */
const exec: Exec = async (cmd) => {
  if (cmd[0] === 'sh' && cmd[2] === TMPDIR_PROBE) return ok('/tmp/t\n')
  if (cmd[0] === 'sh' && cmd[2] === 'cd "$1" && pwd -P') return ok(`${cmd[4]}\n`)
  if (cmd.includes('--git-common-dir')) return ok('/ws/.git\n')
  if (cmd.includes('--git-dir')) return { stdout: '', stderr: 'not a repo', exitCode: 128 }
  if (cmd.includes('ls-tree')) return ok('')
  if (cmd.includes('cat-file') && cmd[2] === 'blob') return ok('pinned skill\n')
  return ok()
}

const REQUEST: PanelRequest = {
  id: 'panel-1',
  candidate: CANDIDATE,
  baseline: BASELINE,
  harnessPin: PIN,
  purpose: 'clearer onboarding prose',
  rubric: 'evals/rubric.md',
  harness: ['evals/**'],
  judges: 3,
}

type JudgeScript = (
  ctx: ScriptContext,
  prefer: (choice: 'A' | 'B' | 'tie') => Promise<void>,
) => Promise<AgentTurnResult> | AgentTurnResult

/** The scripted judge records its preference through the same write-only
 * handle `ab judge prefer` uses. */
function judgeRunner(store: BuildStore, script: JudgeScript): ScriptedAgentRunner {
  return new ScriptedAgentRunner({
    script: (ctx) => {
      const [build, panel, judge] = ctx.opts.env.AB_JUDGE!.split(':')
      const session = ctx.opts.env.AB_SESSION!
      const scoped = scopeLocalStoreToJudgeSession(store, {
        build: build!,
        panel: panel!,
        judge: Number(judge),
        session,
      })
      return script(ctx, async (preference) => {
        await scoped.append(build!, {
          actor: { kind: 'agent', role: 'judge', session },
          type: 'panel.preferred',
          payload: {
            panel: panel!,
            judge: Number(judge),
            session,
            preference,
            reason: `prefers ${preference}`,
          },
        })
      })
    },
  })
}

async function seeded(): Promise<MemoryBuildStore> {
  const store = new MemoryBuildStore()
  await store.createBuild({ slug: SLUG, repo: 'repo', branch: `ab/${SLUG}` })
  await store.append(SLUG, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: { ticket: { source: 'file', id: 'T-a1' }, repo: 'repo', baseBranch: 'ab/node' },
  })
  return store
}

function runnerFor(
  store: BuildStore,
  agent: ScriptedAgentRunner,
  opts: {
    random?: () => number
    shutdownSignal?: AbortSignal
    ids?: () => string
    slug?: string
  } = {},
) {
  const slug = opts.slug ?? SLUG
  const config = parseConfig(
    '[tickets]\nsource = "file"\nreadyState = "ready"\n\n[roles.default]\nruntime = "scripted"\n',
  )
  const ids = sequentialIds()
  return new BuildRunner({
    store: (store as MemoryBuildStore).scopeBuild(slug),
    config,
    runtimes: { scripted: { runner: agent, servesModels: [''] } },
    workspacePath: WORKSPACE,
    branch: `ab/${slug}`,
    slug,
    exec,
    timeoutSignal: () => new AbortController().signal,
    random: opts.random ?? (() => 0.25),
    judgeSkill: async () => 'distribution skill\n',
    ...(opts.shutdownSignal !== undefined ? { shutdownSignal: opts.shutdownSignal } : {}),
    forge: new FakeForge(),
    ids: (prefix) => (prefix === 's' && opts.ids ? opts.ids() : ids(prefix)),
    clock: steppingClock(),
    instance: 'runner-1',
    host: 'test',
    sessionEnv: { AB_STORE: '/store/local', AB_TOKEN: 'runner-token', AB_BUILD: slug },
    runtimeIdentity: {
      version: '0.0.0-test',
      commit: 'unknown',
      source: { kind: 'package', location: '/autobuild' },
    },
  })
}

const panelEvents = (events: AbEvent[]) => events.filter((event) => event.type.startsWith('panel.'))

describe('BuildRunner.runPanel', () => {
  test('runs every judge concurrently and records each judgment with its order', async () => {
    const store = await seeded()
    let started = 0
    let release!: () => void
    const allStarted = new Promise<void>((resolve) => {
      release = resolve
    })
    const preferences: Array<'A' | 'B' | 'tie'> = ['A', 'B', 'tie']
    const seen: Array<{ env: Record<string, string>; workspace: string; order?: string }> = []
    const agent = judgeRunner(store, async (ctx, prefer) => {
      const judge = Number(ctx.opts.env.AB_JUDGE!.split(':')[2])
      // The order is durable before the session starts.
      const recorded = (await store.getEvents(SLUG)).find(
        (event) =>
          event.type === 'panel.judge-started' && event.payload.session === ctx.opts.env.AB_SESSION,
      ) as (AbEvent & { type: 'panel.judge-started' }) | undefined
      seen.push({
        env: ctx.opts.env,
        workspace: ctx.opts.workspacePath,
        ...(recorded !== undefined ? { order: recorded.payload.order } : {}),
      })
      started += 1
      if (started === 3) release()
      await allStarted
      await prefer(preferences[judge - 1]!)
      return defaultTurnResult()
    })
    const random = [0.1, 0.9, 0.1]
    const runner = runnerFor(store, agent, { random: () => random.shift()! })
    const result = await runner.runPanel(REQUEST)

    expect(result.kind).toBe('judged')
    expect(seen).toHaveLength(3)
    expect(seen.every((judge) => judge.order !== undefined)).toBe(true)
    // candidate-first A → 1, baseline-first B → 1, tie → 0.5
    expect((result as { winRate: number }).winRate).toBeCloseTo(2.5 / 3)

    const events = panelEvents(await store.getEvents(SLUG))
    const started_ = events.find((event) => event.type === 'panel.started')!
    expect(JSON.stringify(started_.payload)).not.toContain('first')
    const judged = events.filter((event) => event.type === 'panel.judged')
    expect(
      judged.map((event) => {
        const p = event.payload as { judge: number; order: string; preference: string }
        return [p.judge, p.order, p.preference]
      }),
    ).toEqual([
      [1, 'candidate-first', 'A'],
      [2, 'baseline-first', 'B'],
      [3, 'candidate-first', 'tie'],
    ])
    const ended = events.filter((event) => event.type === 'panel.judge-ended')
    expect(ended.map((event) => (event.payload as { outcome: string }).outcome)).toEqual([
      'completed',
      'completed',
      'completed',
    ])
    expect(ended.every((event) => (event.payload as { transcript?: unknown }).transcript)).toBe(
      true,
    )
  })

  test('a judge session carries only its judge identity and nothing that names a side', async () => {
    const store = await seeded()
    const agent = judgeRunner(store, async (_ctx, prefer) => {
      await prefer('A')
      return defaultTurnResult()
    })
    await runnerFor(store, agent).runPanel({ ...REQUEST, judges: 1 })
    const journal = [...agent.sessions.values()][0]!
    const raw = journal.opts.env
    expect(raw.AB_JUDGE).toBe(`${SLUG}:panel-1:1`)
    expect(raw.AB_CONTEXT_DIR).toBe('.ab/judge')
    expect(raw.AB_STORE).toBe('/store/local')
    expect(raw.AB_SESSION).toBeDefined()
    for (const key of ['AB_BUILD', 'AB_PHASE', 'AB_TOKEN']) expect(key in raw).toBe(false)
    expect(journal.opts.invocation).toBe('panel-1')
    expect(journal.opts.skill).toBe('ab-judge')
    expect(journal.opts.workspacePath).toMatch(/^\/tmp\/t\/autobuild-judge-[0-9a-f]{16}$/)
    const launched = JSON.stringify(journal.opts)
    for (const forbidden of [WORKSPACE, CANDIDATE, BASELINE, PIN, 'candidate', 'baseline'])
      expect(launched).not.toContain(forbidden)
  })

  test('a judge without a preference is retried once, then the run fails', async () => {
    const store = await seeded()
    const agent = judgeRunner(store, async (ctx, prefer) => {
      if (ctx.opts.env.AB_JUDGE!.endsWith(':2')) return defaultTurnResult()
      await prefer('A')
      return defaultTurnResult()
    })
    const result = await runnerFor(store, agent).runPanel({ ...REQUEST, judges: 2 })
    expect(result).toEqual({
      kind: 'failed',
      reason: 'judge 2 failed 2 times; last outcome no-terminal',
    })
    expect(agent.sessions.size).toBe(3)
  })

  test('a resumed run completes a saved preference without a session and reruns the rest', async () => {
    const store = await seeded()
    // The first run crashes right after judge 3's preference is durable: every
    // later write by that runner fails, as a dead process writes nothing.
    let crashed = false
    let judgedCount = 0
    let twoJudged!: () => void
    const firstTwo = new Promise<void>((resolve) => {
      twoJudged = resolve
    })
    const crashing = new Proxy(store, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (property === 'scopeBuild')
          return (slug: string) =>
            new Proxy(value.call(target, slug), {
              get(scoped, member, r) {
                const method = Reflect.get(scoped, member, r)
                if (typeof method !== 'function') return method
                return async (...args: unknown[]) => {
                  if (crashed && String(member).startsWith('append'))
                    throw new Error('process crashed')
                  const out = await method.apply(scoped, args)
                  if ((args[1] as { type?: string } | undefined)?.type === 'panel.judged') {
                    judgedCount += 1
                    if (judgedCount === 2) twoJudged()
                  }
                  return out
                }
              },
            })
        return value
      },
    })
    let judge4Started!: () => void
    const judge4 = new Promise<void>((resolve) => {
      judge4Started = resolve
    })
    const first = judgeRunner(store, async (ctx, prefer) => {
      const judge = Number(ctx.opts.env.AB_JUDGE!.split(':')[2])
      if (judge === 4) {
        judge4Started()
        await new Promise(() => undefined)
      }
      if (judge === 3) {
        await judge4
        await firstTwo
        await prefer('B')
        crashed = true
        return defaultTurnResult()
      }
      await prefer('A')
      return defaultTurnResult()
    })
    const crashedRun = runnerFor(crashing as unknown as BuildStore, first).runPanel({
      ...REQUEST,
      judges: 4,
    })
    await expect(crashedRun).rejects.toThrow('process crashed')

    const before = panelEvents(await store.getEvents(SLUG))
    const judgedBefore = before.filter((event) => event.type === 'panel.judged')
    expect(judgedBefore.map((event) => (event.payload as { judge: number }).judge)).toEqual([1, 2])
    const judge3Start = before.find(
      (event) =>
        event.type === 'panel.judge-started' && (event.payload as { judge: number }).judge === 3,
    )!.payload as { session: string; order: string }

    let next = 0
    const second = judgeRunner(store, async (ctx, prefer) => {
      expect(ctx.opts.env.AB_JUDGE).toBe(`${SLUG}:panel-1:4`)
      await prefer('tie')
      return defaultTurnResult()
    })
    const result = await runnerFor(store, second, {
      ids: () => {
        next += 1
        return `s_resumed_${next}`
      },
    }).runPanel({ ...REQUEST, judges: 4 })
    expect(second.sessions.size).toBe(1)
    expect(result.kind).toBe('judged')
    const after = panelEvents(await store.getEvents(SLUG)).slice(before.length)
    const judged3 = after.find(
      (event) => event.type === 'panel.judged' && (event.payload as { judge: number }).judge === 3,
    )!.payload as { session: string; order: string; preference: string }
    expect(judged3).toMatchObject({
      session: judge3Start.session,
      order: judge3Start.order,
      preference: 'B',
    })
    const reclaimed = after
      .filter((event) => event.type === 'panel.judge-ended')
      .map((event) => event.payload as { judge: number; outcome: string })
      .filter((payload) => payload.outcome === 'reclaimed')
      .map((payload) => payload.judge)
      .sort()
    expect(reclaimed).toEqual([3, 4])
    // Earlier judgments are kept, not rerun.
    expect(after.filter((event) => event.type === 'panel.judged')).toHaveLength(2)
    const judgments = (result as { judgments: Array<{ judge: number }> }).judgments
    expect(judgments.map((j) => j.judge)).toEqual([1, 2, 3, 4])
  })

  test('different inputs for a recorded panel are refused', async () => {
    const store = await seeded()
    const agent = judgeRunner(store, async (_ctx, prefer) => {
      await prefer('A')
      return defaultTurnResult()
    })
    await runnerFor(store, agent).runPanel({ ...REQUEST, judges: 1 })
    await expect(
      runnerFor(store, agent).runPanel({ ...REQUEST, judges: 1, purpose: 'other' }),
    ).rejects.toThrow('different inputs')
  })

  test('shutdown during a turn records interrupted and returns interrupted', async () => {
    const store = await seeded()
    const controller = new AbortController()
    const agent = judgeRunner(store, async () => {
      controller.abort()
      return defaultTurnResult()
    })
    const result = await runnerFor(store, agent, { shutdownSignal: controller.signal }).runPanel({
      ...REQUEST,
      judges: 1,
    })
    expect(result).toEqual({ kind: 'interrupted' })
    const ended = panelEvents(await store.getEvents(SLUG)).find(
      (event) => event.type === 'panel.judge-ended',
    )!
    expect((ended.payload as { outcome: string }).outcome).toBe('interrupted')
  })
})

describe('an optimization node', () => {
  const NODE = 'opt-node'
  const HEAD_A = 'c'.repeat(40)
  const HEAD_B = 'd'.repeat(40)
  const objective = (): Objective => ({
    ...panelObjective(),
    metric: { kind: 'panel', judges: 3, rubric: 'evals/rubric.md', harness: ['evals/**'] },
  })

  async function node(baseline?: { winRate: number }): Promise<MemoryBuildStore> {
    const store = new MemoryBuildStore()
    await store.createBuild({ slug: NODE, repo: 'repo', branch: `ab/${NODE}` })
    await store.append(NODE, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        ticket: { source: 'file', id: 'node' },
        repo: 'repo',
        baseBranch: 'main',
        kind: 'node',
      },
    })
    await store.append(NODE, {
      actor: DISPATCHER,
      type: 'optimization.objective-accepted',
      payload: { objective: objective(), revision: 1, harnessPin: PIN, specRev: 0 },
    })
    await store.append(NODE, { actor: DISPATCHER, type: 'node.opened', payload: { sha: PIN } })
    if (baseline !== undefined) {
      await store.append(NODE, {
        actor: DISPATCHER,
        type: 'optimization.baseline-measured',
        payload: {
          revision: 1,
          head: PIN,
          harnessPin: PIN,
          samples: 3,
          median: baseline.winRate,
          spread: Math.abs(baseline.winRate - 0.5),
        },
      })
      await store.append(NODE, {
        actor: DISPATCHER,
        type: 'optimization.proposal-requested',
        payload: { id: 'r1', head: PIN, room: 2, budgetUsed: { attempts: 0, hours: 0 } },
      })
      await store.append(NODE, {
        actor: DISPATCHER,
        type: 'optimization.attempts-proposed',
        payload: {
          request: 'r1',
          proposals: ['p1', 'p2'].map((id) => ({
            id,
            ticket: { source: 'file' as const, id: `T-${id}` },
            title: id,
            strategy: id,
          })),
        },
      })
    }
    return store
  }

  // Every runner draws session ids from one sequence, as distinct processes do.
  let sessions = 0
  const nodeRunner = (
    store: MemoryBuildStore,
    agent: ScriptedAgentRunner,
    opts: { shutdownSignal?: AbortSignal } = {},
  ) => runnerFor(store, agent, { ...opts, slug: NODE, ids: () => `s_node_${++sessions}` })

  const accept = (store: MemoryBuildStore, proposal: string, head: string) =>
    store.append(NODE, {
      actor: DISPATCHER,
      type: 'attempt.settled',
      payload: {
        attempt: { proposal, ticket: { source: 'file', id: `T-${proposal}` } },
        outcome: 'accepted',
        measurement: { revision: 1, baseline: 0.5, candidate: 0.7, delta: 0.2 },
        head,
      },
    })

  /** Judges preferring `choices[judge - 1]`; every order is candidate-first. */
  const judging = (store: MemoryBuildStore, choices: Array<'A' | 'B' | 'tie' | 'none'>) =>
    judgeRunner(store, async (ctx, prefer) => {
      const choice = choices[Number(ctx.opts.env.AB_JUDGE!.split(':')[2]) - 1]!
      if (choice !== 'none') await prefer(choice)
      return defaultTurnResult()
    })

  const of = async <T extends AbEvent['type']>(store: MemoryBuildStore, type: T) =>
    (await store.getEvents(NODE)).filter((event) => event.type === type) as Array<
      Extract<AbEvent, { type: T }>
    >

  test('a tied self-comparison starts at 0.5 with no noise attention', async () => {
    const store = await node()
    const runner = nodeRunner(store, judging(store, ['tie', 'A', 'B']))
    expect(await runner.step()).toEqual({ kind: 'measure-baseline', revision: 1, harnessPin: PIN })
    const [started] = await of(store, 'panel.started')
    expect(started!.payload).toMatchObject({
      panel: `baseline-1-${PIN}-r0`,
      candidate: PIN,
      baseline: PIN,
      harnessPin: PIN,
      judges: 3,
    })
    expect(await of(store, 'optimization.noise-exceeded')).toEqual([])
    const [measured] = await of(store, 'optimization.baseline-measured')
    expect(measured!.payload).toEqual({
      revision: 1,
      head: PIN,
      harnessPin: PIN,
      samples: 3,
      median: 0.5,
      spread: 0,
    })
    expect(reduceBuild(await store.getEvents(NODE)).optimization?.starting).toEqual({
      value: 0.5,
      spread: 0,
      head: PIN,
    })
  })

  test('a lopsided self-comparison raises noise attention before the starting value', async () => {
    const store = await node()
    await nodeRunner(store, judging(store, ['A', 'A', 'B'])).step()
    const events = await store.getEvents(NODE)
    const noise = events.findIndex((event) => event.type === 'optimization.noise-exceeded')
    const measured = events.findIndex((event) => event.type === 'optimization.baseline-measured')
    expect(noise).toBeGreaterThan(-1)
    expect(noise).toBeLessThan(measured)
    expect(events[noise]!.payload).toMatchObject({
      median: 2 / 3,
      epsilon: { absolute: 0.1 },
      effectiveEpsilon: 0.1,
    })
    expect((events[noise]!.payload as { spread: number }).spread).toBeCloseTo(1 / 6)
    const state = reduceBuild(events)
    expect(state.optimization?.starting?.value).toBe(0.5)
    expect(state.status).not.toBe('blocked')
  })

  test('exhausted judges escalate; a crash keeps the run, an answer starts a fresh one', async () => {
    const store = await node()
    await nodeRunner(store, judging(store, ['A', 'none', 'A'])).step()
    const id = `node-panel-failed-baseline-1-${PIN}-r0`
    const [raised] = await of(store, 'escalation.raised')
    expect(raised!.payload).toMatchObject({
      id,
      phase: 'measurement',
      source: 'policy',
      policyCause: 'measurement-failed',
    })
    expect(raised!.payload.question).toContain('The starting panel of harness pin')
    expect(await of(store, 'optimization.baseline-measured')).toEqual([])
    // A fresh runner with the escalation open waits and never restarts the run.
    const blocked = nodeRunner(store, judging(store, ['A', 'A', 'A']))
    expect(await blocked.step()).toEqual({ kind: 'wait', reason: 'blocked' })
    expect(await of(store, 'panel.started')).toHaveLength(1)
    await store.append(NODE, {
      actor: humanActor('ada'),
      type: 'escalation.answered',
      payload: { id, answer: 'judges fixed', resolution: 'guidance' },
    })
    const fixed = judging(store, ['A', 'tie', 'B'])
    expect((await nodeRunner(store, fixed).step()).kind).toBe('measure-baseline')
    const started = await of(store, 'panel.started')
    expect(started.map((event) => event.payload.panel)).toEqual([
      `baseline-1-${PIN}-r0`,
      `baseline-1-${PIN}-r1`,
    ])
    expect(fixed.sessions.size).toBe(3)
    expect(await of(store, 'optimization.baseline-measured')).toHaveLength(1)
  })

  test('an accepted head is judged against the starting head and recorded as progress', async () => {
    const store = await node({ winRate: 0.5 })
    await accept(store, 'p1', HEAD_A)
    const runner = nodeRunner(store, judging(store, ['A', 'A', 'tie']))
    expect(await runner.step()).toEqual({
      kind: 'measure-progress',
      revision: 1,
      head: HEAD_A,
      start: PIN,
      harnessPin: PIN,
    })
    const [started] = await of(store, 'panel.started')
    expect(started!.payload).toMatchObject({
      panel: `progress-1-${HEAD_A}-r0`,
      candidate: HEAD_A,
      baseline: PIN,
      harnessPin: PIN,
    })
    const [progress] = await of(store, 'optimization.progress-measured')
    expect(progress!.payload).toEqual({
      revision: 1,
      head: HEAD_A,
      start: PIN,
      winRate: 2.5 / 3,
      judges: 3,
    })
    const state = reduceBuild(await store.getEvents(NODE))
    expect(state.optimization?.current).toBe(2.5 / 3)
    expect(state.optimization?.progressQueue).toBeUndefined()
  })

  test('two acceptances before the runner each get a panel, in landing order', async () => {
    const store = await node({ winRate: 0.5 })
    await accept(store, 'p1', HEAD_A)
    await accept(store, 'p2', HEAD_B)
    const runner = nodeRunner(store, judging(store, ['A', 'A', 'A']))
    expect(await runner.step()).toMatchObject({ kind: 'measure-progress', head: HEAD_A })
    expect(await runner.step()).toMatchObject({ kind: 'measure-progress', head: HEAD_B })
    const progress = await of(store, 'optimization.progress-measured')
    expect(progress.map((event) => event.payload.head)).toEqual([HEAD_A, HEAD_B])
  })

  test('an acceptance during a running panel is measured next', async () => {
    const store = await node({ winRate: 0.5 })
    await accept(store, 'p1', HEAD_A)
    let accepted = false
    const agent = judgeRunner(store, async (_ctx, prefer) => {
      if (!accepted) {
        accepted = true
        await accept(store, 'p2', HEAD_B)
      }
      await prefer('A')
      return defaultTurnResult()
    })
    const runner = nodeRunner(store, agent)
    expect(await runner.step()).toMatchObject({ kind: 'measure-progress', head: HEAD_A })
    expect((await of(store, 'optimization.progress-measured')).map((e) => e.payload.head)).toEqual([
      HEAD_A,
    ])
    expect(await runner.step()).toMatchObject({ kind: 'measure-progress', head: HEAD_B })
    expect((await of(store, 'optimization.progress-measured')).map((e) => e.payload.head)).toEqual([
      HEAD_A,
      HEAD_B,
    ])
  })

  test('a failed progress panel escalates, and an answer reruns it with fresh judges', async () => {
    const store = await node({ winRate: 0.5 })
    await accept(store, 'p1', HEAD_A)
    await nodeRunner(store, judging(store, ['none', 'A', 'A'])).step()
    const id = `node-panel-failed-progress-1-${HEAD_A}-r0`
    const [raised] = await of(store, 'escalation.raised')
    expect(raised!.payload).toMatchObject({ id, policyCause: 'measurement-failed' })
    expect(raised!.payload.question).toContain(`progress panel of head ${HEAD_A}`)
    await store.append(NODE, {
      actor: humanActor('ada'),
      type: 'escalation.answered',
      payload: { id, answer: 'retry', resolution: 'guidance' },
    })
    await nodeRunner(store, judging(store, ['A', 'A', 'A'])).step()
    expect((await of(store, 'panel.started')).map((event) => event.payload.panel)).toEqual([
      `progress-1-${HEAD_A}-r0`,
      `progress-1-${HEAD_A}-r1`,
    ])
    expect(await of(store, 'optimization.progress-measured')).toHaveLength(1)
  })

  test('an interrupted progress panel resumes under the same id across a quick revision', async () => {
    const store = await node({ winRate: 0.5 })
    await accept(store, 'p1', HEAD_A)
    const controller = new AbortController()
    const interrupting = judgeRunner(store, async (ctx, prefer) => {
      if (ctx.opts.env.AB_JUDGE!.endsWith(':3')) {
        controller.abort()
        return defaultTurnResult()
      }
      await prefer('A')
      return defaultTurnResult()
    })
    await nodeRunner(store, interrupting, { shutdownSignal: controller.signal }).step()
    expect(await of(store, 'optimization.progress-measured')).toEqual([])
    await store.append(NODE, {
      actor: humanActor('ada'),
      type: 'optimization.objective-revised',
      payload: { changes: { epsilon: { absolute: 0.05 } }, revision: 2 },
    })
    const resumed = judging(store, ['B', 'B', 'tie'])
    await nodeRunner(store, resumed).step()
    expect((await of(store, 'panel.started')).map((event) => event.payload.panel)).toEqual([
      `progress-1-${HEAD_A}-r0`,
    ])
    const [progress] = await of(store, 'optimization.progress-measured')
    expect(progress!.payload).toMatchObject({ revision: 2, head: HEAD_A, winRate: 2.5 / 3 })
  })
})
